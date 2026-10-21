import { createHash } from "node:crypto";
import { always, sometimes } from "../assert.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Cursor, EntryId, EntryRecord, Storage } from "@earendil-works/pi-durable";
import type { TranscriptRecord } from "../transcript.ts";
import { durableEntryMessages } from "./agent.ts";
import { HOST_BOOTSTRAP_KIND, LEGACY_CONVERSATION_ID as conversationId } from "./migration.ts";

/**
 * Dual read for removing the host transcript (plans/host-transcript-removal.md): the history Pi's journal holds on its
 * own, compared with the history the host's records give, from the host generation's start on. Phase 0 reads only.
 *
 * - `host_only_message`: a message the host wrote that has no native entry (a repair, an input's answer, an import).
 * - `retraction`: a native response the host took back (a retried or refused failure).
 * - `suppressed`: a native message the host skipped on purpose (a `pi` record past it): the results Pi writes for calls
 *   it aborted when an interrupted run is discarded, which the host answers with repairs of its own.
 * - `index_drift`: the native messages the host recorded differ from the journal's, in order or content.
 * - `awaiting`: the calls waiting on a person differ from the input-required placeholders without a later result.
 *
 * The first three are expected until the host writes those natively; anything else is a bug in the projection.
 */
export type DualReadCategory = "host_only_message" | "retraction" | "suppressed" | "index_drift" | "awaiting";
export const EXPECTED: readonly DualReadCategory[] = ["host_only_message", "retraction", "suppressed"];
export interface DualReadMismatch { category: DualReadCategory; detail: string }
export interface DualReadReport { hostMessages: number; nativeMessages: number; mismatches: DualReadMismatch[] }

type At = { entryId: number; index: number };
const key = (at: At) => `${at.entryId}:${at.index}`;
const hash = (message: AgentMessage) => createHash("sha256").update(JSON.stringify(message)).digest("base64").slice(0, 16);
const RECORD = "camel.host.record";

async function* entries(storage: Pick<Storage, "scanEntries">, minEntryId?: number) {
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, order: "ascending", ...(minEntryId === undefined ? {} : { minEntryId: minEntryId as EntryId }) }, 256, cursor, context);
    yield* page.items;
    cursor = page.next;
  } while (cursor !== undefined);
}

async function bootstrap(storage: Pick<Storage, "scanEntries">): Promise<EntryRecord | undefined> {
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, order: "descending" }, 128, cursor, context);
    const found = page.items.find(entry => entry.kind === HOST_BOOTSTRAP_KIND);
    if (found) return found;
    cursor = page.next;
  } while (cursor !== undefined);
}

/** Compare the host's records with the journal; undefined for a session with no host generation. */
export async function dualReadHistory(storage: Pick<Storage, "scanEntries">, awaiting: readonly string[]): Promise<DualReadReport | undefined> {
  const start = await bootstrap(storage);
  if (!start) return undefined;
  /** The host's history from its generation's start, as its records replay: each message with its native cursor, if any. */
  const host: { message: AgentMessage; pi?: At }[] = [];
  const retracted: { message: AgentMessage; pi?: At }[] = [];
  /** The journal's native messages, in order, and the input-required placeholders. */
  const native: { message: AgentMessage; pi: At }[] = [];
  const placeholders = new Map<string, number>(), answered = new Set<string>();
  /** Where the host skipped ahead in the journal (`pi` records). */
  const skips: At[] = [];
  for await (const entry of entries(storage, start.id)) {
    if (entry.kind === RECORD) {
      const data = entry.data as { pi?: At; record?: TranscriptRecord };
      if (data.pi) host.push({ message: undefined as never, pi: data.pi });
      else if (data.record?.t === "pi") skips.push(data.record.cursor);
      else if (data.record?.t === "message") host.push({ message: data.record.message });
      else if (data.record?.t === "retract") { const popped = host.pop(); if (popped) retracted.push(popped); }
      else if (data.record?.t === "reset") host.splice(0, host.length, ...data.record.messages.map(message => ({ message })));
      continue;
    }
    for (const item of durableEntryMessages(entry)) {
      native.push({ message: item.message, pi: item.cursor });
      if (item.message.role === "toolResult") answered.add(item.message.toolCallId);
    }
    for (const message of entry.model ?? []) if (message.role === "toolResult" && (message.details as { inputRequired?: boolean } | undefined)?.inputRequired) {
      placeholders.set(message.toolCallId, entry.id);
      answered.delete(message.toolCallId);
    }
  }
  const byCursor = new Map(native.map(item => [key(item.pi), item]));
  for (const item of host) if (item.pi) item.message = byCursor.get(key(item.pi))?.message as AgentMessage;
  const mismatches: DualReadMismatch[] = [];
  for (const item of host) if (!item.pi) mismatches.push({ category: "host_only_message", detail: `${item.message.role} ${hash(item.message)}` });
  const recorded = host.filter(item => item.pi);
  for (const item of recorded) if (!item.message) mismatches.push({ category: "index_drift", detail: `host record of ${key(item.pi!)} has no native message` });
  const taken = new Set(retracted.flatMap(item => item.pi ? [key(item.pi)] : []));
  const kept = new Set(recorded.map(item => key(item.pi!)));
  // Native messages the host left out: the ones it took back, and (a drift) any it never recorded.
  const expected = native.filter(item => {
    if (kept.has(key(item.pi))) return true;
    const skipped = skips.some(at => item.pi.entryId < at.entryId || item.pi.entryId === at.entryId && item.pi.index <= at.index);
    mismatches.push(taken.has(key(item.pi)) ? { category: "retraction", detail: `${item.message.role} ${key(item.pi)}` }
      : skipped ? { category: "suppressed", detail: `${item.message.role} ${key(item.pi)}` }
      : { category: "index_drift", detail: `native ${item.message.role} ${key(item.pi)} is not in the host's history` });
    return false;
  });
  // Recorded in the journal's order, message for message.
  for (let index = 0; index < Math.min(expected.length, recorded.length); index++) {
    if (key(expected[index].pi) !== key(recorded[index].pi!)) {
      mismatches.push({ category: "index_drift", detail: `position ${index}: journal ${key(expected[index].pi)}, host ${key(recorded[index].pi!)}` });
      break;
    }
  }
  // A call the host answered itself (an approval's result, a repair) is answered, though the journal has no native result.
  for (const item of host) if (!item.pi && item.message.role === "toolResult") answered.add(item.message.toolCallId);
  const waiting = [...placeholders.keys()].filter(id => !answered.has(id)).sort();
  // A call the host holds open whose assistant message is its own (an import's) has no native placeholder.
  const nativeCalls = new Set(native.flatMap(item => item.message.role === "assistant" ? item.message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []) : []));
  for (const id of awaiting) if (!nativeCalls.has(id)) mismatches.push({ category: "host_only_message", detail: `call ${id} waits in a message only the host holds` });
  const held = awaiting.filter(id => nativeCalls.has(id)).sort();
  if (waiting.join() !== held.join()) mismatches.push({ category: "awaiting", detail: `journal [${waiting}], host [${held}]` });
  return { hostMessages: host.length, nativeMessages: native.length, mismatches };
}

/** Run the dual read and say what it found: `log` writes unexpected mismatches (and a count of expected ones); `throw` also fails on them. */
export async function checkDualRead(mode: "log" | "throw", agent: string, storage: Pick<Storage, "scanEntries">, awaiting: readonly string[]) {
  const report = await dualReadHistory(storage, awaiting);
  if (!report) return;
  const unexpected = report.mismatches.filter(item => !EXPECTED.includes(item.category));
  // The simulation records these: an unexpected mismatch is a violation of the run, whatever the mode.
  always(!unexpected.length, "the host transcript and Pi's journal hold the same history, but for host-only, retracted and suppressed messages");
  sometimes(report.mismatches.some(item => item.category === "host_only_message"), "a dual read found a message only the host holds");
  sometimes(report.mismatches.some(item => item.category === "retraction"), "a dual read found a response the host took back");
  const expected: Partial<Record<DualReadCategory, number>> = {};
  for (const item of report.mismatches) if (EXPECTED.includes(item.category)) expected[item.category] = (expected[item.category] ?? 0) + 1;
  if (unexpected.length) {
    console.error(JSON.stringify({ type: "host_transcript_dual_read_mismatch", agent, mismatches: unexpected.slice(0, 20), expected }));
    if (mode === "throw") throw new Error(`Dual read: ${unexpected.map(item => `${item.category}: ${item.detail}`).join("; ")}`);
  } else if (Object.keys(expected).length) console.log(JSON.stringify({ type: "host_transcript_dual_read", agent, expected }));
}

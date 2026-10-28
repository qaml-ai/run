import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { DocumentId, EntryId, JsonObject, Storage, StorageWrite } from "@earendil-works/pi-durable";
import { convertToLlm, createCompactionSummaryMessage } from "../pi-harness/messages.ts";
import { BASE_ADDRESS, baseWrites, JournalHistory } from "./history.ts";
import { currentSystemMessage, keptTail, RESET_KEEP_MAX } from "./reset.ts";
import { HostJournal } from "./host-journal.ts";
import { legacyHistory, recordsHistory, retiredRecords, type RetiredRecord } from "./retired-host.ts";
import { contextWrites, SESSION_CONVERSATION_ID as conversationId } from "./seed.ts";
import { commitTo } from "./storage.ts";

/**
 * Converting an agent's history from a legacy format to the current one (Pi's journal history from a base, the messages
 * before it in the history index), once, with the readers of those formats (retired-host.ts), so they can then be
 * deleted. `POST /v1/operations/legacy-migrate` runs it for each agent legacy coverage finds (src/legacy-migrate.ts).
 *
 * - `host_transcript`: a host transcript no release retired. Retired as its first load would (`HostJournal.retire`):
 *   the settled history before the base indexed from the host's records, then the base and the host document retired.
 *   Pi's context is kept: it was Pi's own.
 * - `not_on_pi`: Pi storage without a journal history (an import before #322 never adopted, or a session an earlier
 *   release rolled back to the legacy engine). Its history is what the legacy reads gave (`legacyHistory`: the legacy
 *   log's records, then Pi's messages past the newest they name), indexed whole; then, in one commit, a base after it, a
 *   new context checkpoint (the context's system message, a summary, its last messages: Pi's context may lack what the
 *   legacy engine wrote after a rollback) and, if a rollback disabled the host document, the host document retired.
 * - `legacy_log`: no Pi journal, but a legacy log (a session from before Pi). Its history is the log's, indexed whole;
 *   its journal is seeded after it (`seed`) with a checkpoint of a summary and its last messages.
 * - `history_before_base`: a retired session whose history index is short of its base: the missing messages are
 *   indexed from the retired host's records, which history reads read meanwhile.
 * - `base_document`: a journal with a base marker but no base document (a release before the document): the document
 *   naming the newest marker is written, so every session has one.
 *
 * Undefined when the agent's history is in the current format already (or it has none). Refused as `review`
 * (`LegacyReview`), nothing written, when the converter cannot read the history whole or cannot tell what it is: a host
 * document a rollback disabled after the journal had a base; a journal with no history and an empty legacy log; an index
 * short of a base whose host records reclaim removed; an index holding more than the records give.
 */
export type LegacyKind = "host_transcript" | "not_on_pi" | "legacy_log" | "history_before_base" | "base_document";
export type LegacyConversion = {
  kind: LegacyKind;
  /** The history's length, and where the history index ended before and after. */
  messages: number;
  indexedFrom: number;
  indexedTo: number;
  /** A new context checkpoint was written (or would be), with these of the history's last messages. */
  keptMessages?: number;
};
export class LegacyReview extends Error { readonly code = "review"; }

export interface LegacyConvertOptions {
  /** The session's Pi storage, under its owner's claim; undefined when it has none. */
  storage?: Storage;
  /** The session's legacy log: its records, and whether it is empty. */
  legacy: { read(): Promise<RetiredRecord[]>; empty(): Promise<boolean> };
  /** Where the history index ends, and a write of messages (from `from`, where `turns` begin) to it: where it ends then. */
  indexed: number;
  index(from: number, messages: AgentMessage[], turns: number[]): Promise<number>;
  /** Start the journal of a session with none, its first `before` messages in the index (`AgentSupervisor.seed`). */
  seed(start: { before: number; requests: string[]; model: Message[] }): Promise<void>;
  /** Read and check everything, and write nothing. */
  dryRun?: boolean;
  /** The most bytes a new context checkpoint may be (CONTEXT_RANGE_MAX_BYTES). */
  limit: number;
  now?: number;
}

const json = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const requestsOf = (messages: AgentMessage[]) => [...new Set(messages.flatMap(message => message.role === "user" && (message as { requestId?: string }).requestId ? [(message as { requestId?: string }).requestId!] : []))];
export const migratedSummary = (now: number) => `This agent's earlier conversation was moved from a legacy history format on ${new Date(now).toISOString().slice(0, 10)}; the full history remains in the agent's history and files.`;

/**
 * The context a converted session starts from: a summary of what came before (`system`, the context's system message,
 * first), then the history's last RESET_KEEP_MAX messages, or none when that is past `limit`, as `resetContext` keeps them.
 */
function checkpoint(messages: AgentMessage[], system: SystemMessage | undefined, limit: number, now: number): { model: Message[]; kept: number } {
  const summary = createCompactionSummaryMessage(migratedSummary(now), Math.ceil(messages.reduce((sum, message) => sum + json(message), 0) / 4), now) as AgentMessage;
  for (const keep of [RESET_KEEP_MAX, 0]) {
    const kept = keptTail(messages, keep);
    const model = convertToLlm([...system ? [system as AgentMessage] : [], summary, ...kept]);
    if (json(model) <= limit) return { model, kept: kept.length };
  }
  throw new Error(`A converted context of only a summary is past the ${limit} bytes a run can load`);
}

/** Index `messages` [from, messages.length) where the index ends (`indexed`), in chunks: refused if the index holds more than the history. */
async function indexRest(options: LegacyConvertOptions, history: { messages: AgentMessage[]; turns: number[] }, end = history.messages.length): Promise<number> {
  if (options.indexed > end) throw new LegacyReview(`The history index holds ${options.indexed} messages, more than the ${end} this converter reads`);
  if (options.indexed === end || options.dryRun) return end;
  const indexed = await options.index(options.indexed, history.messages.slice(options.indexed, end), history.turns);
  if (indexed < end) throw new Error(`The history index ends at ${indexed}, not ${end}`);
  return indexed;
}

/** Convert one agent's legacy history (see `LegacyKind`); undefined when it is current. */
export async function convertLegacy(options: LegacyConvertOptions): Promise<LegacyConversion | undefined> {
  const { storage, now = Date.now() } = options;
  const journal = storage && await storage.conversation(conversationId, context) ? storage : undefined;
  if (!journal) {
    // No journal (none, or storage a refused start opened and left empty): a legacy log is the whole history.
    if (await options.legacy.empty()) return undefined;
    const history = recordsHistory(await options.legacy.read());
    const indexedTo = await indexRest(options, history);
    const { model, kept } = checkpoint(history.messages, undefined, options.limit, now);
    if (!options.dryRun) await options.seed({ before: history.messages.length, requests: requestsOf(history.messages), model });
    return { kind: "legacy_log", messages: history.messages.length, indexedFrom: options.indexed, indexedTo, keptMessages: kept };
  }
  const host = await JournalHistory.snapshotBase(journal);
  if (host?.enabled) {
    const retired = await HostJournal.retire(journal, { indexed: options.indexed, index: options.index, legacy: () => options.legacy.read(), dryRun: options.dryRun });
    if (!retired) throw new Error("The host transcript was not retired");
    return { kind: "host_transcript", messages: retired.total, indexedFrom: options.indexed, indexedTo: retired.indexed ?? options.indexed };
  }
  const rolledBack = host && host.value.retired !== "journal" ? host : undefined;
  const history = await JournalHistory.open(journal);
  if (history) {
    if (rolledBack) throw new LegacyReview("A rollback disabled this session's host document after its journal had a base; its history is in neither format alone");
    if (history.heldFrom > options.indexed) {
      // Read as history reads read them: the retired host's records, its legacy log first for an archive left there.
      const records = await retiredRecords(journal, () => options.legacy.read(), true);
      if (!records) throw new LegacyReview(`The history index ends at ${options.indexed}, before the journal's base ${history.heldFrom}, and no host records hold the rest (reclaimed)`);
      const old = recordsHistory(records);
      if (old.messages.length < history.heldFrom) throw new LegacyReview(`The host's records hold ${old.messages.length} messages, before the journal's base ${history.heldFrom}`);
      const indexedTo = await indexRest(options, old, history.heldFrom);
      return { kind: "history_before_base", messages: history.total, indexedFrom: options.indexed, indexedTo };
    }
    if (await JournalHistory.baseDocument(journal)) return undefined;
    // A base marker from before the base document: the document names it, as `findBase` finds it without one.
    if (!options.dryRun) await commitTo(journal, [{ type: "document.create", record: { id: await journal.mintId<DocumentId>(), ...BASE_ADDRESS }, content: { version: 1, kind: "base", value: { entry: history.baseId } } }], context);
    return { kind: "base_document", messages: history.total, indexedFrom: options.indexed, indexedTo: options.indexed };
  }
  // No journal history: what the legacy reads gave, from the legacy log, then Pi's messages past it. With no legacy log
  // they gave no history at all, though the journal may hold an import's archive: a person decides.
  const records = await options.legacy.read();
  if (!records.length) throw new LegacyReview("This session's journal has no history of its own and its legacy log is empty");
  const old = await legacyHistory(journal, records);
  const indexedTo = await indexRest(options, old);
  const total = old.messages.length;
  const { model, kept } = checkpoint(old.messages, await currentSystemMessage(journal), options.limit, now);
  if (!options.dryRun) {
    const existing = await JournalHistory.baseDocument(journal);
    const writes: StorageWrite[] = [
      ...baseWrites(await journal.mintId<EntryId>(), { t: "base", total, active: false, turnStart: total, awaiting: [] }, { id: existing ?? await journal.mintId<DocumentId>(), create: !existing }),
    ];
    const ids: number[] = [];
    for (let index = 0; index < Math.max(1, model.length); index++) ids.push(await journal.mintId());
    writes.push(...contextWrites(ids, conversationId, model, { migrated: { at: now, keptMessages: kept } }));
    // As a retirement leaves it, so no release reads the host's records again.
    if (rolledBack) writes.push(
      { type: "entry", value: { id: await journal.mintId<EntryId>(), conversationId, kind: "camel.host.disabled", data: { retired: "journal" } } },
      { type: "document.change", id: rolledBack.documentId, content: { version: 1, kind: "base", value: { ...rolledBack.value, enabled: false, retired: "journal" } as JsonObject } },
    );
    await commitTo(journal, writes, context);
  }
  return { kind: "not_on_pi", messages: total, indexedFrom: options.indexed, indexedTo, keptMessages: kept };
}

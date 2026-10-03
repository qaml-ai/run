import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createCompactionSummaryMessage } from "./pi-harness/messages.ts";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { fileAppendLog, type AppendLog } from "../shared/append-log.ts";

export const transcriptPath = (directory: string) => join(directory, "transcript.jsonl");

/** A compaction: `summary` replaces every message before absolute index `cut`. */
export interface CompactionState {
  summary: string;
  cut: number;
  tokensBefore: number;
  details?: unknown;
  at: number;
}

/** Native Pi messages, appended as each one ends; never re-serialized per delta. */
export type TranscriptRecord =
  | { t: "message"; message: AgentMessage }
  /** Drops the latest message: a provider error that was retried. */
  | { t: "retract" }
  | { t: "turn"; active: boolean }
  /**
   * Tool calls a suspended turn leaves open until a person answers (inputs.ts): no result is written
   * for them meanwhile, and a reload does not close them. `released` hands them back to the running
   * turn, just before an approved call runs, so a crash then closes them as unknown like any call.
   */
  | { t: "awaiting"; calls: string[]; released?: true }
  /** Replaces all earlier messages (import, or folding the log). */
  | { t: "reset"; messages: AgentMessage[]; compaction?: CompactionState }
  /**
   * The runtime's system messages, never a tenant's. `leading` pins the context's first one, the
   * provider's cached prefix; any other changes the prompt or tools from this point in the conversation.
   */
  | { t: "system"; message: SystemMessage; leading?: true }
  /**
   * The model's context from now on is `summary` plus messages from index `cut`. `system` is the
   * leading system message with every change before the cut folded in.
   */
  | ({ t: "compaction"; system?: SystemMessage } & CompactionState);

/** Read an agent's full history from a single-host directory. */
export async function readTranscript(directory: string): Promise<AgentMessage[]> {
  return historyOf(await fileAppendLog<TranscriptRecord>(transcriptPath(directory)).read());
}

/** Read an agent's full history from any log. Never writes, so it is safe beside a live owner. */
export async function readTranscriptLog(log: AppendLog<TranscriptRecord>): Promise<AgentMessage[]> {
  return historyOf(await log.read());
}

function historyOf(records: TranscriptRecord[]): AgentMessage[] {
  let messages: AgentMessage[] = [];
  for (const record of records) {
    if (record.t === "message") messages.push(record.message);
    else if (record.t === "retract") messages.pop();
    else if (record.t === "reset") messages = [...record.messages];
  }
  return messages;
}

/**
 * Messages the agent's history index (history-pages.ts) does not have yet, from absolute index
 * `from` on, and where runs began among them (`turn` records). Memory holds those from `kept` on,
 * with each one's size; the ones before it (more than a backlog holds) are read from the log.
 */
export interface Backlog { from: number; kept: number; messages: AgentMessage[]; sizes: number[]; bytes: number; turns: number[] }

/** The most a backlog holds in memory by default; past it, what it holds is left to the log. */
const BACKLOG_BYTES = Number(process.env.AGENT_HISTORY_BACKLOG_BYTES) || 8_000_000;

/** Where conversational turns begin in `messages` (absolute index `from` on) without turn records: at a user message after anything else, and at 0. */
function userTurns(from: number, messages: AgentMessage[]) {
  return messages.flatMap((message, index) => message.role === "user" && (from + index === 0 || messages[index - 1]?.role !== "user") ? [from + index] : []);
}

/**
 * The agent's working set: the latest compaction summary plus the messages after
 * its cut. Earlier messages stay in the log (for history) but not in memory, so an
 * agent's memory and load time stop growing with its age.
 */
/** The request a user message was sent by, if it names one. */
const requestOf = (message: AgentMessage) => message.role === "user" ? (message as { requestId?: string }).requestId : undefined;
/** The ids of the tool calls an assistant message makes. */
const callsOf = (message: AgentMessage) => message.role === "assistant" ? message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []) : [];

export class Transcript {
  /** Messages at absolute indexes `offset` .. `total - 1`. */
  context: AgentMessage[] = [];
  /** Messages ever recorded (after retractions); absolute indexes run 0 .. total - 1. */
  total = 0;
  compaction?: CompactionState;
  /** The pinned leading system message; until a change needs one, it is built from configuration. */
  system?: SystemMessage;
  /** Later system messages, each placed before the message at absolute index `at`. */
  updates: { at: number; message: SystemMessage }[] = [];
  /** A turn was running when the log was last written. */
  active = false;
  /** `total` when the running turn started. */
  turnStart = 0;
  /** Tool calls waiting on a person's input, in the order they were suspended. */
  awaiting: string[] = [];
  /** The requests whose user messages the whole log holds (compacted ones included): a request's message is taken once. */
  requests = new Set<string>();
  /** Each tool call id, and the index of the latest assistant message that made a call with it, over the whole log. */
  calls = new Map<string, number>();
  /** What the history index lacks, kept while this transcript is written; undefined when nothing indexes it. */
  backlog?: Backlog;
  readonly log: AppendLog<TranscriptRecord>;
  /** Past this many bytes, the backlog's messages are left to the log (see `Backlog`). */
  private readonly bound: number;
  /** `indexed`: how many messages the history index has; this transcript then keeps the ones after as `backlog`. */
  constructor(log: AppendLog<TranscriptRecord>, indexed?: number, bound = BACKLOG_BYTES) {
    this.log = log;
    this.bound = bound;
    if (indexed !== undefined) this.backlog = { from: indexed, kept: indexed, messages: [], sizes: [], bytes: 0, turns: [] };
  }

  /** The history index now has messages up to `indexed`: they leave the backlog. */
  indexed(indexed: number) {
    const backlog = this.backlog;
    if (!backlog || indexed <= backlog.from) return;
    const taken = Math.max(0, Math.min(indexed - backlog.kept, backlog.messages.length));
    backlog.messages.splice(0, taken);
    for (const size of backlog.sizes.splice(0, taken)) backlog.bytes -= size;
    backlog.from = indexed;
    backlog.kept = Math.max(backlog.kept, indexed);
    backlog.turns = backlog.turns.filter(turn => turn >= indexed);
  }

  /** Leave what the backlog holds to the log: memory keeps only messages from here on. */
  private spill(backlog: Backlog) {
    backlog.kept += backlog.messages.length;
    backlog.messages = [];
    backlog.sizes = [];
    backlog.bytes = 0;
  }

  get offset() { return this.total - this.context.length; }

  /** What the model sees after the leading system message: the summary, and the kept messages with later system messages in place. */
  view(): AgentMessage[] {
    const view: AgentMessage[] = this.compaction ? [summaryMessage(this.compaction)] : [];
    let next = 0;
    this.context.forEach((message, index) => {
      for (; next < this.updates.length && this.updates[next].at <= this.offset + index; next++) view.push(this.updates[next].message);
      view.push(message);
    });
    for (; next < this.updates.length; next++) view.push(this.updates[next].message);
    return view;
  }

  async load() {
    for (const record of await this.log.read()) this.apply(record);
  }

  apply(record: TranscriptRecord) {
    const backlog = this.backlog;
    if (record.t === "message") {
      if (backlog && this.total >= backlog.kept + backlog.messages.length) {
        const size = JSON.stringify(record.message).length;
        backlog.messages.push(record.message);
        backlog.sizes.push(size);
        backlog.bytes += size;
        if (backlog.bytes > this.bound) this.spill(backlog);
      }
      this.context.push(record.message);
      this.total++;
      const request = requestOf(record.message);
      if (request) this.requests.add(request);
      for (const id of callsOf(record.message)) this.calls.set(id, this.total - 1);
      if (record.message.role === "toolResult") this.awaiting = this.awaiting.filter(id => id !== (record.message as { toolCallId: string }).toolCallId);
    }
    else if (record.t === "retract") {
      const popped = this.context.pop();
      if (popped) {
        const request = requestOf(popped);
        if (request) this.requests.delete(request);
        for (const id of callsOf(popped)) if (this.calls.get(id) === this.total - 1) this.calls.delete(id);
        this.total--;
        if (backlog && this.total >= backlog.kept && this.total === backlog.kept + backlog.messages.length - 1) {
          backlog.messages.pop();
          backlog.bytes -= backlog.sizes.pop()!;
        } else if (backlog && this.total < backlog.kept) backlog.kept = Math.max(backlog.from, this.total);
      }
      for (const update of this.updates) update.at = Math.min(update.at, this.total);
    }
    else if (record.t === "turn") {
      this.active = record.active;
      if (record.active) this.turnStart = this.total;
      if (record.active && backlog && this.total >= backlog.from) backlog.turns.push(this.total);
    }
    else if (record.t === "awaiting") this.awaiting = record.released ? this.awaiting.filter(id => !record.calls.includes(id)) : [...this.awaiting, ...record.calls.filter(id => !this.awaiting.includes(id))];
    else if (record.t === "reset") {
      if (backlog) {
        // A reset is an import into an empty transcript: its messages have no turn records.
        const messages = record.messages.slice(backlog.from);
        backlog.kept = backlog.from;
        backlog.messages = messages;
        backlog.sizes = messages.map(message => JSON.stringify(message).length);
        backlog.bytes = backlog.sizes.reduce((sum, size) => sum + size, 0);
        backlog.turns = userTurns(backlog.from, messages);
        if (backlog.bytes > this.bound) this.spill(backlog);
      }
      this.total = record.messages.length;
      this.requests = new Set(record.messages.map(requestOf).filter((request): request is string => !!request));
      this.calls = new Map(record.messages.flatMap((message, index) => callsOf(message).map(id => [id, index] as const)));
      this.compaction = record.compaction;
      this.context = record.messages.slice(record.compaction?.cut ?? 0);
      this.system = undefined;
      this.updates = [];
      this.awaiting = [];
    } else if (record.t === "system") {
      if (record.leading) { this.system = record.message; this.updates = []; }
      else this.updates.push({ at: this.total, message: record.message });
    } else if (record.t === "compaction") {
      const { t: _type, system, ...state } = record;
      if (state.cut < this.offset || state.cut > this.total) throw new Error(`Compaction cut ${state.cut} is outside the working set (${this.offset}..${this.total})`);
      this.context = this.context.slice(state.cut - this.offset);
      this.compaction = state;
      if (system) this.system = system;
      this.updates = this.updates.filter(update => update.at > state.cut);
    } else throw new Error(`Unknown transcript record: ${(record as { t: string }).t}`);
  }

  /** The commit line: one write at a time, in order. */
  private line: Promise<unknown> = Promise.resolve();
  /** Why a write failed. The log may hold part of what it wrote, so nothing more is written: only a reload knows what it holds. */
  failed?: unknown;

  /** Run `job` on the commit line, once every earlier commit has settled; none runs after a failed write. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.line.then(() => {
      if (this.failed !== undefined) throw this.failed;
      return job();
    });
    this.line = run.catch(() => {});
    return run;
  }

  /**
   * Commit the records `change` gives as of every earlier commit: they are written durably, then applied, so memory
   * (and what the agent acts on) never holds what the log may not. A failed write leaves memory as it was, and every
   * later commit fails with it. `change` may give none, to write nothing.
   */
  commit(change: () => TranscriptRecord[]): Promise<void> {
    return this.enqueue(async () => {
      const records = change();
      if (!records.length) return;
      for (const record of records) this.log.append(record);
      try { await this.log.flush(true); }
      catch (error) { this.failed = error; throw error; }
      for (const record of records) this.apply(record);
    });
  }

  push(message: AgentMessage) { return this.append([message]); }
  append(messages: AgentMessage[]) { return this.commit(() => messages.map(message => ({ t: "message" as const, message }))); }
  retract() { return this.commit(() => [{ t: "retract" }]); }
  setActive(active: boolean) { return this.commit(() => [{ t: "turn", active }]); }
  /** Leave tool calls open for a person's input, or (`released`) give them back to the turn. */
  await(calls: string[], released = false) { return this.commit(() => [{ t: "awaiting", calls, ...(released ? { released: true as const } : {}) }]); }
  /**
   * Change the prompt or tools from here on, after the leading system message, pinning `leading` as it first when
   * nothing has been pinned yet: one commit, so a node reloading the agent rebuilds the same context.
   */
  declareSystem(message: SystemMessage, leading: SystemMessage) {
    return this.commit(() => [...(this.system ? [] : [{ t: "system" as const, message: leading, leading: true as const }]), { t: "system", message }]);
  }

  /**
   * Replace the messages before `state.cut` with its summary, only onto the working set it summarized: `previous` still
   * the latest summary, and the cut within what history holds. System messages before the cut fold into the leading one
   * (`fold`). Whether it was written, and the system messages it folded.
   */
  async compact(state: CompactionState, previous: CompactionState | undefined, fold: (changes: SystemMessage[]) => SystemMessage | undefined) {
    let folded: SystemMessage[] | undefined;
    await this.commit(() => {
      if (this.compaction !== previous || state.cut < this.offset || state.cut > this.total) return [];
      folded = this.updates.filter(update => update.at <= state.cut).map(update => update.message);
      const system = folded.length ? fold(folded) : undefined;
      return [{ t: "compaction", ...state, ...(system ? { system } : {}) }];
    });
    return folded;
  }

  /** Atomically replace the history (imports), folding the log to a single snapshot record. */
  replace(messages: AgentMessage[], active = this.active, compaction?: CompactionState) {
    return this.enqueue(async () => {
      const reset = { t: "reset" as const, messages: [...messages], ...(compaction ? { compaction } : {}) };
      try { await this.log.rewrite(() => [reset, ...(active ? [{ t: "turn" as const, active: true }] : [])]); }
      catch (error) { this.failed = error; throw error; }
      this.apply(reset);
      this.active = active;
    });
  }
}

/** A fork's copy of a transcript: the records it starts from, and the history index of the last message they hold (null: none). */
export interface ForkCut { records: TranscriptRecord[]; through: number | null }

const forkRefused = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });

/**
 * Where a fork of a transcript ends, and the records it starts from: the source's own up to there, so its compactions
 * and system messages (the provider's cached prefix) come along. By default it ends with the last turn that ended,
 * never in a turn still running or waiting on a person's input. `at` a history index keeps that message and the tool
 * results that answer it; a request id keeps the turn that request ran, whole. A message of the running turn, or one
 * whose tool calls have no results yet, is refused (409 FORK_POINT_RUNNING).
 */
export function forkCut(records: TranscriptRecord[], at?: number | string): ForkCut {
  const replay = new Transcript(undefined as never);
  // After each record: how many messages the history had, and whether no turn was running or waiting on input.
  const states = records.map(record => { replay.apply(record); return { total: replay.total, settled: !replay.active && !replay.awaiting.length }; });
  /** The record that brought the history to `count` messages for the last time: from there on it never has fewer. */
  const crossing = (count: number) => states.findLastIndex((state, index) => state.total >= count && (index ? states[index - 1].total : 0) < count);
  const whole = (end: number): ForkCut => ({ records: records.slice(0, end + 1), through: end >= 0 && states[end].total ? states[end].total - 1 : null });
  if (at === undefined) return whole(states.findLastIndex(state => state.settled));
  const messages = historyOf(records);
  if (typeof at === "string") {
    const index = messages.findLastIndex(message => requestOf(message) === at);
    if (index < 0) throw forkRefused(400, "FORK_POINT_INVALID", `No message in this agent's history was sent by request ${at}`);
    const from = crossing(index + 1);
    const end = states.findIndex((state, position) => position >= from && state.settled);
    if (end < 0) throw forkRefused(409, "FORK_POINT_RUNNING", `Request ${at}'s turn has not ended yet; fork once it has, or at an earlier message`);
    return whole(end);
  }
  if (!Number.isSafeInteger(at) || at < 0 || at >= messages.length) throw forkRefused(400, "FORK_POINT_INVALID", `atMessage is a history index from 0 to ${messages.length - 1}, or a request id`);
  let count = at + 1;
  while (messages[count]?.role === "toolResult") count++;
  // Calls the kept messages leave without results: their turn is running, or waits on a person.
  const open = new Set<string>();
  for (const message of messages.slice(0, count)) {
    if (message.role === "assistant") { open.clear(); for (const id of callsOf(message)) open.add(id); }
    else if (message.role === "toolResult") open.delete(message.toolCallId);
    else if (message.role === "user") open.clear();
  }
  if (open.size || (replay.active && count > replay.turnStart)) throw forkRefused(409, "FORK_POINT_RUNNING", `Message ${at} is in a turn that has not ended yet; fork at an earlier message, or once it ends`);
  const end = crossing(count);
  const kept = records.slice(0, end + 1);
  const last = kept[end];
  // An import holding more messages than the fork keeps: only those, and its summary if it covers no more.
  if (last?.t === "reset" && last.messages.length > count) {
    kept[end] = { t: "reset", messages: last.messages.slice(0, count), ...(last.compaction && last.compaction.cut <= count ? { compaction: last.compaction } : {}) };
  }
  // The fork's transcript ends between turns, so it is never mid-turn when it loads.
  const fork = new Transcript(undefined as never);
  for (const record of kept) fork.apply(record);
  if (fork.awaiting.length) kept.push({ t: "awaiting", calls: fork.awaiting, released: true });
  if (fork.active) kept.push({ t: "turn", active: false });
  return { records: kept, through: count - 1 };
}

/** Every message the records hold, in their own records or an import's. */
export function recordedMessages(records: TranscriptRecord[]): AgentMessage[] {
  return records.flatMap(record => record.t === "message" ? [record.message] : record.t === "reset" ? record.messages : []);
}

export function summaryMessage(state: CompactionState): AgentMessage {
  return createCompactionSummaryMessage(state.summary, state.tokensBefore, new Date(state.at).toISOString()) as AgentMessage;
}

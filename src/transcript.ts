import { join } from "node:path";
import { createCompactionSummaryMessage, type AgentMessage } from "@earendil-works/pi-agent-core";
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
 * The agent's working set: the latest compaction summary plus the messages after
 * its cut. Earlier messages stay in the log (for history) but not in memory, so an
 * agent's memory and load time stop growing with its age.
 */
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
  readonly log: AppendLog<TranscriptRecord>;
  constructor(log: AppendLog<TranscriptRecord>) { this.log = log; }

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
    if (record.t === "message") { this.context.push(record.message); this.total++; }
    else if (record.t === "retract") {
      if (this.context.pop()) this.total--;
      for (const update of this.updates) update.at = Math.min(update.at, this.total);
    }
    else if (record.t === "turn") { this.active = record.active; if (record.active) this.turnStart = this.total; }
    else if (record.t === "reset") {
      this.total = record.messages.length;
      this.compaction = record.compaction;
      this.context = record.messages.slice(record.compaction?.cut ?? 0);
      this.system = undefined;
      this.updates = [];
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

  private async write(record: TranscriptRecord) {
    this.log.append(record);
    this.apply(record);
    await this.log.flush(true);
  }

  push(message: AgentMessage) { return this.write({ t: "message", message }); }
  retract() { return this.write({ t: "retract" }); }
  setActive(active: boolean) { return this.write({ t: "turn", active }); }
  compact(state: CompactionState, system?: SystemMessage) { return this.write({ t: "compaction", ...state, ...(system ? { system } : {}) }); }
  /** Pin the leading system message, or (without `leading`) change the prompt or tools from here on. */
  declareSystem(message: SystemMessage, leading = false) { return this.write({ t: "system", message, ...(leading ? { leading: true as const } : {}) }); }

  async append(messages: AgentMessage[]) {
    for (const message of messages) { this.log.append({ t: "message", message }); this.apply({ t: "message", message }); }
    await this.log.flush(true);
  }

  /** Atomically replace the history (imports), folding the log to a single snapshot record. */
  async replace(messages: AgentMessage[], active = this.active) {
    this.apply({ t: "reset", messages });
    this.active = active;
    await this.log.rewrite(() => [{ t: "reset", messages: [...messages] }, ...(this.active ? [{ t: "turn" as const, active: true }] : [])]);
  }
}

export function summaryMessage(state: CompactionState): AgentMessage {
  return createCompactionSummaryMessage(state.summary, state.tokensBefore, new Date(state.at).toISOString()) as AgentMessage;
}

// What a workflow tells the agent that owns it (docs/design/workflow-simplification.md, cut 3): to its owner a workflow
// is a background child. workflow_start writes its row in the owner's children table (delegation.ts registerWorkflow);
// when the workflow ends, or stops for its budget or its payer, its object stages a child ending in its own outbox
// (ending-outbox.ts, the same one an agent child keeps) in the transaction that wrote the status, and its alarm delivers
// it to the owner's `receiveEnding` until the owner answers. The owner takes it once (keyed by the workflow and its
// attempt) and lands it as a <workflow_notification> through its notification outbox, as any child's ending.
//
// A stop ends the row's current attempt (`<workflow id>_a<n>`); whatever the workflow does next is attempt n+1. An
// ending the owner has no row for is answered `accepted: false` and dropped. An API-started workflow has no owner and
// stages nothing.
import type { Owner } from "../../../shared/owner.ts";
import { ChildOutbox, type ChildEnding, type Receipt } from "./ending-outbox.ts";
import type { ChildRun } from "./delegation.ts";
import { workflowRunId } from "./delegation.ts";

/** A fault as the owner reads it: its message cut to FAULT_MESSAGE_CHARS (a VM crash echoes raw engine text). */
export const FAULT_MESSAGE_CHARS = 500;
export function shortFault(fault: { code: string; message: string }) {
  return fault.message.length > FAULT_MESSAGE_CHARS ? { code: fault.code, message: `${fault.message.slice(0, FAULT_MESSAGE_CHARS)}… (cut)` } : fault;
}
/** The most of a result (or a fault's message) an ending carries; workflow_status has it whole. */
export const ENDING_RESULT_CHARS = 16_000;

export type EndingSummary = { status: string; pauseReason?: string; result?: unknown; error?: string; fault?: { code: string; message: string }; counts?: Record<string, number>; spent?: { usd: number }; budget?: { usd: number | null } };
const ENDED = new Set(["completed", "failed", "aborted"]);

/** Why a workflow stopped such that its owner hears it, or undefined: its budget, or its payer's credit. */
export function stopReason(summary: Pick<EndingSummary, "status" | "pauseReason">): string | undefined {
  if (summary.status === "budget_exhausted") return "budget_exhausted";
  if (summary.status === "paused" && summary.pauseReason === "payer_exhausted") return "payer_exhausted";
  return undefined;
}

const cut = (value: unknown) => {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > ENDING_RESULT_CHARS ? `${text.slice(0, ENDING_RESULT_CHARS)}… (cut at ${ENDING_RESULT_CHARS} characters; workflow_status has it whole)` : value;
};

/**
 * The child record of a workflow that ended or stopped, or undefined when the owner hears nothing of this status (it
 * runs; a person paused it; it waits for the account's capacity). MODEL-FACING: `reply` is the notification's line.
 */
export function endingRecord(workflowId: string, name: string, summary: EndingSummary): ChildRun | undefined {
  const stopped = ENDED.has(summary.status) ? undefined : stopReason(summary);
  if (!ENDED.has(summary.status) && !stopped) return undefined;
  const fault = summary.fault ? shortFault(summary.fault) : undefined;
  const failure = fault ?? (summary.error ? { code: "error", message: summary.error } : undefined);
  const reply = summary.status === "completed" ? `Workflow ${name} completed.`
    : summary.status === "aborted" ? `Workflow ${name} was aborted.`
    : summary.status === "failed" ? `Workflow ${name} failed (${failure?.code ?? "error"}): ${String(cut(failure?.message ?? "no message"))}`
    : stopped === "budget_exhausted" ? `Workflow ${name} stopped: its budget is spent. Raise it with workflow_budget to go on.`
    : `Workflow ${name} stopped: a sub-agent was refused for credit. It tries again by itself. Use workflow_resume to retry now.`;
  const output = {
    workflowId, status: summary.status, ...(summary.result !== undefined ? { result: cut(summary.result) } : {}),
    ...(summary.error && !fault ? { error: cut(summary.error) } : {}), ...(fault ? { fault } : {}),
    counts: summary.counts ?? {}, spentUsd: summary.spent?.usd ?? 0, budgetUsd: summary.budget?.usd ?? null,
  };
  const error = summary.status === "failed" ? failure?.message : undefined;
  return {
    state: "completed", status: stopped ? "stopped" : summary.status,
    // Its own children billed what it spent (and roll up into the owner): the row charges nothing again.
    outcome: { result: { reply, output, usage: { costUsd: 0 }, ...(stopped ? { stopped } : {}) }, ...(error ? { error } : {}) },
  };
}

export interface EndingsHost {
  storage: DurableObjectStorage;
  workflowId: string;
  owner(): Owner | undefined;
  name(): string | undefined;
  /** The owner agent's receiveEnding (binding). */
  receiveEnding(owner: string, ending: ChildEnding): Promise<Receipt>;
  arm(at: number): Promise<void>;
  now?(): number;
}

/**
 * The workflow's side: which attempt the owner's row is on, staging each ending in the status's transaction, and the
 * outbox that delivers them. Everything here is in the workflow object's own SQLite.
 */
export class WorkflowEndings {
  readonly outbox: ChildOutbox;
  private readonly host: EndingsHost;
  private ready = false;
  constructor(host: EndingsHost) {
    this.host = host;
    this.outbox = new ChildOutbox({
      storage: host.storage,
      receiveEnding: async (owner, ending) => {
        const receipt = await host.receiveEnding(owner.id, ending);
        if (!receipt.accepted) console.error(JSON.stringify({ type: "workflow_ending_unknown", workflow: host.workflowId, owner: owner.id, requestId: ending.requestId }));
        return receipt;
      },
      receiveProgress: async () => ({ accepted: true }),
      arm: at => host.arm(at),
      ...(host.now ? { now: host.now } : {}),
    });
    // Made here, outside any transaction (a status's transaction that rolled back would take the table with it).
    void this.sql;
  }
  private get sql() {
    const sql = this.host.storage.sql;
    if (!this.ready) {
      // `stopped`: the stop the owner last heard, while nothing else has happened since (see statusWritten).
      sql.exec("CREATE TABLE IF NOT EXISTS workflow_owner_row (id INTEGER PRIMARY KEY CHECK (id = 1), attempt INTEGER NOT NULL, stopped TEXT)");
      sql.exec("INSERT OR IGNORE INTO workflow_owner_row (id, attempt) VALUES (1, 1)");
      this.ready = true;
    }
    return sql;
  }
  /** The attempt the owner's row is on: its next ending is that attempt's. */
  attempt(): number { return Number(this.sql.exec<{ attempt: number }>("SELECT attempt FROM workflow_owner_row WHERE id = 1").one().attempt); }

  /**
   * A status was written (the runner's `onStatus`, inside its transaction): stage what the owner hears of it, in the
   * same transaction. Synchronous; the outbox's write is a plain SQL insert, keyed by the attempt, so staged again it is
   * the same row. A stop moves the row on to its next attempt.
   */
  statusWritten(summary: EndingSummary) {
    const owner = this.host.owner();
    if (owner?.kind !== "agent") return;
    const record = endingRecord(this.host.workflowId, this.host.name() ?? this.host.workflowId, summary);
    if (!record) return;
    const stopped = record.outcome?.result?.stopped;
    // A payer stop retries by itself, and each retry the payer refuses again stops it again: the owner hears the first,
    // and again only after another stop or an ending, not every retry for days.
    if (stopped === "payer_exhausted" && this.sql.exec<{ stopped: string | null }>("SELECT stopped FROM workflow_owner_row WHERE id = 1").one().stopped === stopped) return;
    const attempt = this.attempt();
    void this.outbox.stageEnding(undefined, owner, { agentId: this.host.workflowId, requestId: workflowRunId(this.host.workflowId, attempt), record });
    if (record.status === "stopped") this.sql.exec("UPDATE workflow_owner_row SET attempt = ?, stopped = ? WHERE id = 1", attempt + 1, stopped ?? null);
    else this.sql.exec("UPDATE workflow_owner_row SET stopped = NULL WHERE id = 1");
  }

  /** Endings not yet taken by the owner. */
  pending(): number { return this.outbox.size(); }
}

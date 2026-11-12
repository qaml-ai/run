// What a workflow tells the agent that owns it (docs/design/swarm-workflows.md, "An agent writes and steers one"):
// when it completes, fails, is aborted, pauses (its budget, its payer, capacity, a fault, a confirm) or finishes a
// phase, a <workflow_notification> reaches the owner as a message of its own, so the owner gets a turn and reports
// back without polling. A notice is written to the workflow's own outbox first, in its SQLite, and delivered to the
// owner's `receiveAgentMessage` until it is taken; the owner admits it as a runtime notice (counted against its
// wake budget) under a request id fixed by the workflow and the notice's sequence, so a delivery made again is the
// same request.
import type { Owner } from "../../../shared/owner.ts";
import type { NoticeRequest, RuntimeNotice } from "./delegation-notifications.ts";

export type NoticeSummary = { status: string; pauseReason?: string; phase?: string; result?: unknown; error?: string; fault?: { code: string; message: string }; counts?: Record<string, number>; spent?: { usd: number }; budget?: { usd: number | null }; revision?: number };

/**
 * What a stopped workflow waits for, as its owner reads it (a notice, workflow_status): a fault ends it, and the owner
 * starts a fixed one (finished results are reused); every other stop names who goes on and how. Undefined while it runs
 * or waits, and once it ended any other way.
 */
export function workflowNext(summary: Pick<NoticeSummary, "status" | "pauseReason" | "fault">): string | undefined {
  if (summary.fault?.code === "vm_crash") return "The script's VM crashed (not the script's error): start it again with workflow_start; finished agent() and job() results are reused.";
  if (summary.fault?.code === "runtime_upgraded") return "It was started on an older runtime: start the workflow again.";
  if (summary.fault) return `The script failed (${summary.fault.code}): fix it and start a new workflow; finished agent() and job() results are reused.`;
  if (summary.status === "budget_exhausted") return "Its budget is spent: raise it with workflow_budget to go on.";
  if (summary.status !== "paused") return undefined;
  switch (summary.pauseReason) {
    case "user": return "Paused: workflow_resume goes on.";
    case "payer_exhausted": return "A sub-agent or job was refused for credit (the spend limit): it tries again by itself; workflow_resume tries now.";
    case "capacity_refused": return "The account is at its running-workflows limit: it goes on by itself once another ends.";
    default: return "Paused: workflow_resume goes on.";
  }
}

/** A fault as the owner reads it: its message cut to FAULT_MESSAGE_CHARS (a VM crash echoes raw engine text). */
export const FAULT_MESSAGE_CHARS = 500;
export function shortFault(fault: { code: string; message: string }) {
  return fault.message.length > FAULT_MESSAGE_CHARS ? { code: fault.code, message: `${fault.message.slice(0, FAULT_MESSAGE_CHARS)}… (cut)` } : fault;
}

/** The largest notice body (its JSON); a larger result is cut, saying so (workflow_status has it whole). */
export const NOTICE_BODY_CHARS = 16_000;
const ENDED = new Set(["completed", "failed", "aborted"]);
const STOPPED = new Set(["paused", "budget_exhausted"]);

/** What changed between two summaries that the owner should hear: an ending, a stop, or a phase finished. */
export function noticeEvent(before: { status?: string; pauseReason?: string; phase?: string } | undefined, after: NoticeSummary): string | undefined {
  if (!before) return undefined;
  if (after.status !== before.status || after.pauseReason !== before.pauseReason) {
    if (ENDED.has(after.status)) return after.status;
    if (STOPPED.has(after.status)) return after.status === "paused" ? (after.pauseReason ?? "paused") : after.status;
    return undefined;
  }
  if (after.status === "running" || after.status === "waiting") {
    if (before.phase !== undefined && after.phase !== before.phase) return "phase";
  }
  return undefined;
}

export interface NoticeDeps {
  sql: SqlStorage;
  workflowId: string;
  owner(): Owner | undefined;
  name(): string | undefined;
  bucket(): string | undefined;
  /** The owner agent's `receiveAgentMessage` (binding). */
  send(owner: string, request: NoticeRequest, notice: RuntimeNotice): Promise<unknown>;
  /**
   * Make sure the object's alarm fires by `at` (no later; an earlier alarm stays): a notice not yet taken is retried
   * by the alarm, durably, whatever the workflow's own state (a completed workflow arms nothing else).
   */
  arm(at: number): Promise<void>;
  now?(): number;
  random?(): number;
}

/** First retry after 1 s, times four each time, at most 5 minutes apart, each up to a fifth later at random. */
export const NOTICE_RETRY = { firstMs: 1_000, maxMs: 5 * 60_000, jitter: 0.2 } as const;
/** A notice its owner never takes is dropped after this long (as a child's outbox row is). */
export const NOTICE_GIVE_UP_MS = 7 * 86_400_000;

export class WorkflowNotices {
  private readonly deps: NoticeDeps;
  private flushing?: Promise<void>;
  constructor(deps: NoticeDeps) {
    this.deps = deps;
    deps.sql.exec("CREATE TABLE IF NOT EXISTS workflow_notice_state (id INTEGER PRIMARY KEY CHECK (id = 1), status TEXT, pause_reason TEXT, phase TEXT)");
    deps.sql.exec("CREATE TABLE IF NOT EXISTS workflow_notices (seq INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)");
    // When each is next due, and when it was made (a table made by an earlier build gets the columns, its rows due now).
    const columns = deps.sql.exec<{ name: string }>("PRAGMA table_info(workflow_notices)").toArray().map(column => column.name);
    if (!columns.includes("next_at")) deps.sql.exec("ALTER TABLE workflow_notices ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("created_at")) deps.sql.exec("ALTER TABLE workflow_notices ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
    // A row from before created_at was made now, as far as giving up goes: seen first here, it gets its week from now.
    deps.sql.exec("UPDATE workflow_notices SET created_at = ? WHERE created_at = 0", this.now());
  }
  private now() { return this.deps.now?.() ?? Date.now(); }

  /**
   * Compare the workflow with what the owner last heard, and stage a notice when it should hear more. Synchronous: it
   * commits with the caller's storage. The first look records where the workflow is, with no notice.
   */
  check(summary: NoticeSummary) {
    const { sql } = this.deps;
    const row = sql.exec<{ status: string | null; pause_reason: string | null; phase: string | null }>("SELECT status, pause_reason, phase FROM workflow_notice_state WHERE id = 1").toArray()[0];
    const before = row ? { status: row.status ?? undefined, pauseReason: row.pause_reason ?? undefined, phase: row.phase ?? undefined } : undefined;
    const event = noticeEvent(before, summary);
    sql.exec("INSERT INTO workflow_notice_state (id, status, pause_reason, phase) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, pause_reason = excluded.pause_reason, phase = excluded.phase",
      summary.status, summary.pauseReason ?? null, summary.phase ?? null);
    const owner = this.deps.owner();
    if (!event || owner?.kind !== "agent") return;
    const body: Record<string, unknown> = {
      workflowId: this.deps.workflowId, status: summary.status, ...(summary.pauseReason ? { pauseReason: summary.pauseReason } : {}),
      ...(event === "phase" ? { finishedPhase: before?.phase, phase: summary.phase } : summary.phase ? { phase: summary.phase } : {}),
      counts: summary.counts, spentUsd: summary.spent?.usd, budgetUsd: summary.budget?.usd,
      ...(summary.result !== undefined ? { result: summary.result } : {}), ...(summary.error ? { error: summary.error } : {}),
      ...(summary.fault ? { fault: shortFault(summary.fault) } : {}), ...(workflowNext(summary) ? { next: workflowNext(summary) } : {}),
    };
    let text = JSON.stringify(body);
    if (text.length > NOTICE_BODY_CHARS) text = JSON.stringify({ ...body, result: `(cut: ${text.length} characters; workflow_status has it)` });
    sql.exec("INSERT INTO workflow_notices (event, body, status, next_at, created_at) VALUES (?, ?, ?, ?, ?)", event, text, summary.status, this.now(), this.now());
  }

  /** Stage a notice of an event that is not a change of status (a gate opened), in order with the others. */
  stage(event: string, body: Record<string, unknown>, status: string) {
    if (this.deps.owner()?.kind !== "agent") return;
    this.deps.sql.exec("INSERT INTO workflow_notices (event, body, status, next_at, created_at) VALUES (?, ?, ?, ?, ?)", event, JSON.stringify({ workflowId: this.deps.workflowId, event, status, ...body }), status, this.now(), this.now());
  }

  /**
   * Deliver staged notices in order, those that are due; one that fails stops the rest (they keep their order) and is
   * tried again from the alarm, with backoff, for at most a week.
   */
  flush(): Promise<void> {
    this.flushing ??= this.flushOnce().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async flushOnce() {
    const owner = this.deps.owner();
    if (owner?.kind !== "agent") return;
    const { sql } = this.deps;
    for (;;) {
      const next = sql.exec<{ seq: number; event: string; body: string; status: string; attempts: number; next_at: number; created_at: number }>("SELECT seq, event, body, status, attempts, next_at, created_at FROM workflow_notices ORDER BY seq LIMIT 1").toArray()[0];
      if (!next) return;
      // Not due yet: the alarm comes back for it (arming again costs nothing when it is already set earlier).
      if (Number(next.next_at) > this.now()) { await this.deps.arm(Number(next.next_at)); return; }
      if (this.now() - Number(next.created_at) > NOTICE_GIVE_UP_MS) {
        console.error(JSON.stringify({ type: "workflow_notice_dropped", workflow: this.deps.workflowId, seq: next.seq, event: next.event, attempts: next.attempts }));
        sql.exec("DELETE FROM workflow_notices WHERE seq = ?", next.seq);
        continue;
      }
      const bucket = this.deps.bucket();
      const request: NoticeRequest = { id: `${this.deps.workflowId}_n${next.seq}`, method: "prompt", params: { text: next.body, allowDisconnected: true, whileRunning: "followUp", ...(bucket ? { bucket } : {}) } };
      const notice: RuntimeNotice = {
        source: { kind: "agent", agentId: this.deps.workflowId, name: this.deps.name() ?? "workflow" }, root: owner.id, costUsd: 0,
        metadata: { kind: "workflow", workflowId: this.deps.workflowId, status: next.status, event: next.event },
      };
      try {
        const answer = await this.deps.send(owner.id, request, notice) as { gone?: boolean } | undefined;
        if (answer?.gone) {
          // The owner was deleted or expired: no notice can reach it, now or later. The rest go with this one.
          const dropped = sql.exec<{ n: number }>("SELECT count(*) AS n FROM workflow_notices").one().n;
          console.error(JSON.stringify({ type: "workflow_notice_dropped", workflow: this.deps.workflowId, reason: "owner_gone", owner: owner.id, notices: Number(dropped) }));
          sql.exec("DELETE FROM workflow_notices");
          return;
        }
        sql.exec("DELETE FROM workflow_notices WHERE seq = ?", next.seq);
      } catch (error) {
        const attempts = Number(next.attempts) + 1;
        const delay = Math.min(NOTICE_RETRY.maxMs, NOTICE_RETRY.firstMs * 4 ** Math.min(5, attempts - 1));
        const nextAt = this.now() + Math.round(delay * (1 + NOTICE_RETRY.jitter * (this.deps.random?.() ?? Math.random())));
        sql.exec("UPDATE workflow_notices SET attempts = ?, next_at = ? WHERE seq = ?", attempts, nextAt, next.seq);
        console.error(JSON.stringify({ type: "workflow_notice_failed", workflow: this.deps.workflowId, seq: next.seq, attempts, error: String(error) }));
        await this.deps.arm(nextAt);
        return;
      }
    }
  }

  /** When the alarm must come back for the next notice (strictly in the future), or undefined: none waiting. */
  retryAt(): number | undefined {
    // The first in order: the ones behind it wait for it, whatever their own times.
    const row = this.deps.sql.exec<{ at: number }>("SELECT next_at AS at FROM workflow_notices ORDER BY seq LIMIT 1").toArray()[0];
    return row === undefined ? undefined : Math.max(Number(row.at), this.now() + 1);
  }

  /** Notices not yet taken by the owner. */
  /**
   * Before a first send that runs in the background: arm the alarm for the first retry, so a send the isolate dies in
   * the middle of (nothing recorded its failure, and nothing else may arm the alarm) is still retried.
   */
  async guard() { if (this.pending()) await this.deps.arm(this.now() + NOTICE_RETRY.firstMs); }

  pending(): number { return Number(this.deps.sql.exec<{ n: number }>("SELECT count(*) AS n FROM workflow_notices").one().n); }
}

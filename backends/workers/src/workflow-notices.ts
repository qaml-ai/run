// What a workflow tells the agent that owns it (docs/design/swarm-workflows.md, "An agent writes and steers one"):
// when it completes, fails, is aborted, pauses (its budget, its payer, capacity, a fault, a confirm) or finishes a
// phase, a <workflow_notification> reaches the owner as a message of its own, so the owner gets a turn and reports
// back without polling. A notice is written to the workflow's own outbox first, in its SQLite, and delivered to the
// owner's `receiveAgentMessage` until it is taken; the owner admits it as a runtime notice (counted against its
// wake budget) under a request id fixed by the workflow and the notice's sequence, so a delivery made again is the
// same request.
import type { Owner } from "../../../shared/owner.ts";
import type { NoticeRequest, RuntimeNotice } from "./delegation-notifications.ts";

export type NoticeSummary = { status: string; pauseReason?: string; phase?: string; result?: unknown; error?: string; counts?: Record<string, number>; spent?: { usd: number }; budget?: { usd: number | null }; revision?: number };

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
  /** Try again later (the object's waitUntil, with a delay). */
  later(afterMs: number, task: () => Promise<void>): void;
}

export class WorkflowNotices {
  private readonly deps: NoticeDeps;
  private flushing?: Promise<void>;
  constructor(deps: NoticeDeps) {
    this.deps = deps;
    deps.sql.exec("CREATE TABLE IF NOT EXISTS workflow_notice_state (id INTEGER PRIMARY KEY CHECK (id = 1), status TEXT, pause_reason TEXT, phase TEXT)");
    deps.sql.exec("CREATE TABLE IF NOT EXISTS workflow_notices (seq INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)");
  }

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
    };
    let text = JSON.stringify(body);
    if (text.length > NOTICE_BODY_CHARS) text = JSON.stringify({ ...body, result: `(cut: ${text.length} characters; workflow_status has it)` });
    sql.exec("INSERT INTO workflow_notices (event, body, status) VALUES (?, ?, ?)", event, text, summary.status);
  }

  /** Deliver staged notices in order; one that fails stops the rest (they keep their order) and is tried again later. */
  flush(): Promise<void> {
    this.flushing ??= this.flushOnce().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async flushOnce() {
    const owner = this.deps.owner();
    if (owner?.kind !== "agent") return;
    const { sql } = this.deps;
    for (;;) {
      const next = sql.exec<{ seq: number; event: string; body: string; status: string; attempts: number }>("SELECT seq, event, body, status, attempts FROM workflow_notices ORDER BY seq LIMIT 1").toArray()[0];
      if (!next) return;
      const bucket = this.deps.bucket();
      const request: NoticeRequest = { id: `${this.deps.workflowId}_n${next.seq}`, method: "prompt", params: { text: next.body, allowDisconnected: true, whileRunning: "followUp", ...(bucket ? { bucket } : {}) } };
      const notice: RuntimeNotice = {
        source: { kind: "agent", agentId: this.deps.workflowId, name: this.deps.name() ?? "workflow" }, root: owner.id, costUsd: 0,
        metadata: { kind: "workflow", workflowId: this.deps.workflowId, status: next.status, event: next.event },
      };
      try {
        await this.deps.send(owner.id, request, notice);
        sql.exec("DELETE FROM workflow_notices WHERE seq = ?", next.seq);
      } catch (error) {
        const attempts = Number(next.attempts) + 1;
        sql.exec("UPDATE workflow_notices SET attempts = ? WHERE seq = ?", attempts, next.seq);
        console.error(JSON.stringify({ type: "workflow_notice_failed", workflow: this.deps.workflowId, seq: next.seq, attempts, error: String(error) }));
        this.deps.later(Math.min(5 * 60_000, 1000 * 4 ** Math.min(5, attempts - 1)), () => this.flush());
        return;
      }
    }
  }

  /** Notices not yet taken by the owner. */
  pending(): number { return Number(this.deps.sql.exec<{ n: number }>("SELECT count(*) AS n FROM workflow_notices").one().n); }
}

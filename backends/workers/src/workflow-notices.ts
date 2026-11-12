// The old way a workflow told its owner (a <workflow_notification> sent to the owner's `receiveAgentMessage`), kept
// for one release as the rolling deploy's fallback only (docs/design/workflow-simplification.md, cut 3, "Rolling
// deploy"). A workflow's endings now come as a child's (workflow-endings.ts). Two things still use this:
//
// - An ending the owner refuses (`accepted: false`: it has no row for the workflow, which every workflow started before
//   this build lacks) is sent once more the old way, under a request id fixed by the workflow and its attempt, so a
//   delivery made again is the same request. A throw is a failed delivery: the ending stays in the outbox and is retried.
// - Notices an earlier build staged and the owner has not taken: an ending (or a budget or payer stop) is delivered as
//   before; the rest (a phase, a gate, another pause) are dropped, logged `workflow_notice_dropped reason=retired`.
//
// The contract PR, one release later, deletes this file, its tables and `receiveAgentMessage`'s workflow kind.
import type { Owner } from "../../../shared/owner.ts";
import type { NoticeRequest, RuntimeNotice } from "./delegation-notifications.ts";
import type { ChildEnding } from "./ending-outbox.ts";

/** The events a notice may still carry: endings and the stops the owner must hear. */
const KEPT = new Set(["completed", "failed", "aborted", "budget_exhausted", "payer_exhausted"]);
/** First retry after 1 s, times four each time, at most 5 minutes apart, each up to a fifth later at random. */
export const NOTICE_RETRY = { firstMs: 1_000, maxMs: 5 * 60_000, jitter: 0.2 } as const;
/** A notice its owner never takes is dropped after this long (as a child's outbox row is). */
export const NOTICE_GIVE_UP_MS = 7 * 86_400_000;

export interface NoticeDeps {
  sql: SqlStorage;
  workflowId: string;
  owner(): Owner | undefined;
  name(): string | undefined;
  bucket(): string | undefined;
  /** The owner agent's `receiveAgentMessage` (binding). */
  send(owner: string, request: NoticeRequest, notice: RuntimeNotice): Promise<unknown>;
  /** Make sure the object's alarm fires by `at` (no later; an earlier alarm stays). */
  arm(at: number): Promise<void>;
  now?(): number;
  random?(): number;
}

const notice = (workflowId: string, name: string, owner: string, status: string, event: string): RuntimeNotice => ({
  source: { kind: "agent", agentId: workflowId, name }, root: owner, costUsd: 0,
  metadata: { kind: "workflow", workflowId, status, event },
});

export class WorkflowNotices {
  private readonly deps: NoticeDeps;
  private flushing?: Promise<void>;
  private readonly table: boolean;
  constructor(deps: NoticeDeps) {
    this.deps = deps;
    // Only an object an earlier build ran has the table; nothing here makes it.
    this.table = deps.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflow_notices'").toArray().length > 0;
    if (!this.table) return;
    const columns = deps.sql.exec<{ name: string }>("PRAGMA table_info(workflow_notices)").toArray().map(column => column.name);
    if (!columns.includes("next_at")) deps.sql.exec("ALTER TABLE workflow_notices ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("created_at")) deps.sql.exec("ALTER TABLE workflow_notices ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
    deps.sql.exec("UPDATE workflow_notices SET created_at = ? WHERE created_at = 0", this.now());
  }
  private now() { return this.deps.now?.() ?? Date.now(); }

  /**
   * The status an earlier build last told the owner of (its notice state), or undefined: one this build made, or one
   * whose owner was never told anything. A terminal status it already told is not told again.
   */
  told(): string | undefined {
    if (this.deps.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflow_notice_state'").toArray().length === 0) return undefined;
    return this.deps.sql.exec<{ status: string | null }>("SELECT status FROM workflow_notice_state WHERE id = 1").toArray()[0]?.status ?? undefined;
  }

  /**
   * An ending its owner refused (no row for the workflow): sent the old way, once. The request id is the workflow's and
   * the attempt's, so a send made again (the outbox retried after a throw) is the same request to the owner.
   */
  async fallback(owner: string, ending: ChildEnding) {
    const result = (ending.record.outcome?.result ?? {}) as { reply?: string; output?: unknown; stopped?: string };
    const status = (result.output as { status?: string } | undefined)?.status ?? ending.record.status ?? "completed";
    const bucket = this.deps.bucket();
    const request: NoticeRequest = { id: `${ending.requestId}_notice`, method: "prompt", params: { text: `${result.reply ?? ""}\n${JSON.stringify(result.output ?? {})}`, allowDisconnected: true, whileRunning: "followUp", ...(bucket ? { bucket } : {}) } };
    const answer = await this.deps.send(owner, request, notice(this.deps.workflowId, this.deps.name() ?? "workflow", owner, status, result.stopped ?? status)) as { gone?: boolean } | undefined;
    console.error(JSON.stringify({ type: "workflow_ending_fallback", workflow: this.deps.workflowId, owner, requestId: ending.requestId, ...(answer?.gone ? { gone: true } : {}) }));
  }

  /**
   * Deliver what an earlier build staged, in order, those that are due; one that fails stops the rest (they keep their
   * order) and is tried again from the alarm, with backoff, for at most a week. A notice of a removed event is dropped.
   */
  flush(): Promise<void> {
    this.flushing ??= this.flushOnce().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async flushOnce() {
    if (!this.table) return;
    const owner = this.deps.owner();
    const { sql } = this.deps;
    for (;;) {
      const next = sql.exec<{ seq: number; event: string; body: string; status: string; attempts: number; next_at: number; created_at: number }>("SELECT seq, event, body, status, attempts, next_at, created_at FROM workflow_notices ORDER BY seq LIMIT 1").toArray()[0];
      if (!next) return;
      if (owner?.kind !== "agent" || !KEPT.has(next.event) || this.now() - Number(next.created_at) > NOTICE_GIVE_UP_MS) {
        console.error(JSON.stringify({ type: "workflow_notice_dropped", reason: owner?.kind !== "agent" || KEPT.has(next.event) ? "expired" : "retired", workflow: this.deps.workflowId, seq: next.seq, event: next.event, attempts: next.attempts }));
        sql.exec("DELETE FROM workflow_notices WHERE seq = ?", next.seq);
        continue;
      }
      // Not due yet: the alarm comes back for it.
      if (Number(next.next_at) > this.now()) { await this.deps.arm(Number(next.next_at)); return; }
      const bucket = this.deps.bucket();
      const request: NoticeRequest = { id: `${this.deps.workflowId}_n${next.seq}`, method: "prompt", params: { text: next.body, allowDisconnected: true, whileRunning: "followUp", ...(bucket ? { bucket } : {}) } };
      try {
        const answer = await this.deps.send(owner.id, request, notice(this.deps.workflowId, this.deps.name() ?? "workflow", owner.id, next.status, next.event)) as { gone?: boolean } | undefined;
        if (answer?.gone) {
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
    if (!this.table) return undefined;
    const row = this.deps.sql.exec<{ at: number }>("SELECT next_at AS at FROM workflow_notices ORDER BY seq LIMIT 1").toArray()[0];
    return row === undefined ? undefined : Math.max(Number(row.at), this.now() + 1);
  }

  /** Notices an earlier build staged, not yet taken by the owner. */
  pending(): number { return this.table ? Number(this.deps.sql.exec<{ n: number }>("SELECT count(*) AS n FROM workflow_notices").one().n) : 0; }
}

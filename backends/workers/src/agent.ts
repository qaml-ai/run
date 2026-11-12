import { DurableObject } from "cloudflare:workers";
import { guardAlarms } from "./alarm-guard.ts";
import type { Placement } from "../../../shared/owner.ts";
import { type RuntimeNotice, type NoticeRequest, type WakeDecision } from "./delegation-notifications.ts";
import type { ChildProgressReport } from "./delegation.ts";
import type { ChildEnding, Receipt } from "./ending-outbox.ts";
import { Env } from "./agent-types.ts";
import { AgentRuntime } from "./agent-runtime.ts";
import { ARM_AGENT, DUE_HUMAN_INPUTS } from "./agent-internals.ts";
export type { Env } from "./agent-types.ts";
export { json } from "./agent-types.ts";

/** Durable Object entry points. Runtime internals stay off the RPC surface. */
export class CamelAgent extends DurableObject<Env> {
  readonly #runtime = new AgentRuntime(this.ctx, this.env, this);
  /** Per method: when a call to this deleted agent was last logged, and how many came since (deleted_agent_rpc). */
  readonly #goneLogged = new Map<string, { at: number; since: number }>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // After the runtime's lifecycle installed its alarm handler on this instance (field initializers run first).
    guardAlarms(this as never, ctx, "CamelAgent", { test: (env as { TEST_MODE?: unknown }).TEST_MODE === "1" });
  }

  removeMember(member: string) { return this.#runtime.removeMember(member); }

  /**
   * Whether this agent is gone for good: deleted, or past its expiry. Both are durable facts in its own storage (the
   * flag is never cleared, the expiry never moves back), so an agent merely evicted, hibernating or busy is never taken
   * for gone. A call to a gone agent is logged by method and caller kind, at most once a minute per method, so a sender
   * that keeps calling one shows up.
   */
  async #gone(method: string, caller: string) {
    const storage = this.ctx.storage;
    if (await storage.get("deleted") !== true) {
      const expiresAt = (await storage.get<{ expiresAt?: number }>("configuration"))?.expiresAt;
      if (!expiresAt || expiresAt > Date.now()) return false;
    }
    const seen = this.#goneLogged.get(method), now = Date.now();
    // Tests count every call (TEST_MODE), to see that a sender stops.
    if (!seen || now - seen.at >= 60_000 || (this.env as { TEST_MODE?: string }).TEST_MODE === "1") {
      console.warn(JSON.stringify({ type: "deleted_agent_rpc", agent: this.ctx.id.name ?? null, method, caller, suppressed: seen?.since ?? 0 }));
      this.#goneLogged.set(method, { at: now, since: 0 });
    } else seen.since++;
    return true;
  }

  /** Binding-only pilot counters; no runtime state, SQL or values are exposed. */
  databaseProfile(reset = false) {
    if (this.env.PILOT_DB_PROFILE !== "1")
      return Promise.reject(new Error("Pilot database profiling is disabled"));
    return this.#runtime.databaseProfile(reset);
  }

  protected [ARM_AGENT](retry?: number) {
    return this.#runtime.arm(retry);
  }

  protected [DUE_HUMAN_INPUTS](at: number) {
    return this.#runtime.dueHumanInputs(at);
  }

  purgeAccountData(tenant: string, id: string) {
    return this.#runtime.purgeAccountData(tenant, id);
  }

  admitDelegateWake(id: string): Promise<WakeDecision> {
    return this.#runtime.admitDelegateWake(id);
  }

  /** Who may answer the gates of a workflow this agent owns (workflow-gates.ts). */
  inboxAudience() {
    return this.#runtime.inboxAudience();
  }
  /**
   * A message or notice for this agent (a child's send_message, a workflow's notice). A gone agent answers `{ gone:
   * true }`: the sender drops it rather than retrying a delivery that can never land.
   */
  async receiveAgentMessage(
    request: NoticeRequest,
    notice: RuntimeNotice,
  ): Promise<unknown> {
    if (await this.#gone("receiveAgentMessage", String(notice?.metadata?.kind ?? notice?.source?.kind ?? "message"))) return { gone: true };
    return this.#runtime.receiveAgentMessage(request, notice);
  }

  /** A child's progress report, delivered by the child's outbox (binding-only). A gone owner acknowledges it. */
  async receiveProgress(report: ChildProgressReport): Promise<Receipt> {
    if (await this.#gone("receiveProgress", "child")) return { accepted: true };
    return this.#runtime.receiveProgress(report);
  }

  /** A child's ending, delivered by the child's outbox until this answers (binding-only). A gone owner acknowledges it. */
  async receiveEnding(ending: ChildEnding): Promise<Receipt> {
    if (await this.#gone("receiveEnding", "child")) return { accepted: true };
    return this.#runtime.receiveEnding(ending);
  }

  /** A child run its owner starts, with its placement in the chain (binding-only). */
  admitDelegated(request: unknown, placement: Placement) {
    return this.#runtime.admitDelegated(request, placement);
  }

  async hasChild(id: string): Promise<boolean> {
    if (await this.#gone("hasChild", "browser")) return false;
    return this.#runtime.hasChild(id);
  }

  /** Stop a run (its owner's cancel). A gone agent runs nothing: there is nothing to stop, and the cancel is done. */
  async cancelRequest(id: string) {
    if (await this.#gone("cancelRequest", "owner")) return false;
    return this.#runtime.cancelRequest(id);
  }

  fetch(request: Request): Promise<Response> {
    return this.#runtime.fetch(request);
  }

  onStart() {
    return this.#runtime.onStart();
  }

  onJob(context: { job: { fn: string } }) {
    return this.#runtime.onJob(context);
  }

  webSocketMessage(socket: WebSocket, _data: string | ArrayBuffer) {
    return this.#runtime.webSocketMessage(socket, _data);
  }

  webSocketClose(socket: WebSocket, code: number) {
    return this.#runtime.webSocketClose(socket, code);
  }

  webSocketError(socket: WebSocket) {
    return this.#runtime.webSocketError(socket);
  }

}

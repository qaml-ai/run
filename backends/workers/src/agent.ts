import type { RefMove } from "./camelfs/notify.ts";
import { AgentInvocation } from "./agent-invocation.ts";
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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Lifecycle installs the alarm handler and dispatches each agent job through onJob.
    guardAlarms(this as never, ctx, "CamelAgent", { test: (env as { TEST_MODE?: unknown }).TEST_MODE === "1" });
  }

  removeMember(member: string) { return this.#runtime.removeMember(new AgentInvocation(), member); }

  /** Binding-only pilot counters; no runtime state, SQL or values are exposed. */
  databaseProfile(reset = false) {
    if (this.env.PILOT_DB_PROFILE !== "1")
      return Promise.reject(new Error("Pilot database profiling is disabled"));
    return this.#runtime.databaseProfile(new AgentInvocation(), reset);
  }

  protected [ARM_AGENT](retry?: number) {
    return this.#runtime.arm(retry, new AgentInvocation());
  }

  protected [DUE_HUMAN_INPUTS](at: number) {
    return this.#runtime.dueHumanInputs(new AgentInvocation(), at);
  }

  purgeAccountData(tenant: string, id: string) {
    return this.#runtime.purgeAccountData(new AgentInvocation(), tenant, id);
  }

  admitDelegateWake(id: string): Promise<WakeDecision> {
    return this.#runtime.admitDelegateWake(new AgentInvocation(), id);
  }

  receiveAgentMessage(
    request: NoticeRequest,
    notice: RuntimeNotice,
  ): Promise<unknown> {
    return this.#runtime.receiveAgentMessage(new AgentInvocation(), request, notice);
  }

  /** A child's progress report, delivered by the child's outbox (binding-only). */
  receiveProgress(report: ChildProgressReport): Promise<Receipt> {
    return this.#runtime.receiveProgress(new AgentInvocation(), report);
  }

  /** A child's ending, delivered by the child's outbox until this answers (binding-only). */
  receiveEnding(ending: ChildEnding): Promise<Receipt> {
    return this.#runtime.receiveEnding(new AgentInvocation(), ending);
  }

  /** A child run its owner starts, with its placement in the chain (binding-only). */
  admitDelegated(request: unknown, placement: Placement) {
    return this.#runtime.admitDelegated(new AgentInvocation(), request, placement);
  }

  hasChild(id: string): Promise<boolean> {
    return this.#runtime.hasChild(new AgentInvocation(), id);
  }

  cancelRequest(id: string) {
    return this.#runtime.cancelRequest(new AgentInvocation(), id);
  }

  fetch(request: Request): Promise<Response> {
    return this.#runtime.fetch(new AgentInvocation(), request);
  }

  onStart() {
    return this.#runtime.onStart(new AgentInvocation());
  }

  onJob(context: { job: { fn: string } }) {
    return this.#runtime.onJob(new AgentInvocation(), context);
  }

  webSocketMessage(socket: WebSocket, _data: string | ArrayBuffer) {
    return this.#runtime.webSocketMessage(new AgentInvocation(), socket, _data);
  }

  webSocketClose(socket: WebSocket, code: number) {
    return this.#runtime.webSocketClose(new AgentInvocation(), socket, code);
  }

  webSocketError(socket: WebSocket) {
    return this.#runtime.webSocketError(new AgentInvocation(), socket);
  }

  /** A camel-fs notify delivery for a watched repo (an idempotent outbox row). */
  vmEnded(delivery: string, vm: string) { return this.#runtime.vmEnded(new AgentInvocation(), delivery, vm); }
  stageRepoMove(move: RefMove) { return this.#runtime.stageRepoMove(new AgentInvocation(), move); }
}

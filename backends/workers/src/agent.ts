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

  removeMember(member: string) { return AgentInvocation.run(invocation => this.#runtime.removeMember(invocation, member)); }

  /** Binding-only pilot counters; no runtime state, SQL or values are exposed. */
  databaseProfile(reset = false) {
    if (this.env.PILOT_DB_PROFILE !== "1")
      return Promise.reject(new Error("Pilot database profiling is disabled"));
    return AgentInvocation.run(invocation => this.#runtime.databaseProfile(invocation, reset));
  }

  protected [ARM_AGENT](retry?: number) {
    return AgentInvocation.run(invocation => this.#runtime.arm(retry, invocation));
  }

  protected [DUE_HUMAN_INPUTS](at: number) {
    return AgentInvocation.run(invocation => this.#runtime.dueHumanInputs(invocation, at));
  }

  purgeAccountData(tenant: string, id: string) {
    return AgentInvocation.run(invocation => this.#runtime.purgeAccountData(invocation, tenant, id));
  }

  admitDelegateWake(id: string): Promise<WakeDecision> {
    return AgentInvocation.run(invocation => this.#runtime.admitDelegateWake(invocation, id));
  }

  receiveAgentMessage(
    request: NoticeRequest,
    notice: RuntimeNotice,
  ): Promise<unknown> {
    return AgentInvocation.run(invocation => this.#runtime.receiveAgentMessage(invocation, request, notice));
  }

  /** A child's progress report, delivered by the child's outbox (binding-only). */
  receiveProgress(report: ChildProgressReport): Promise<Receipt> {
    return AgentInvocation.run(invocation => this.#runtime.receiveProgress(invocation, report));
  }

  /** A child's ending, delivered by the child's outbox until this answers (binding-only). */
  receiveEnding(ending: ChildEnding): Promise<Receipt> {
    return AgentInvocation.run(invocation => this.#runtime.receiveEnding(invocation, ending));
  }

  /** A child run its owner starts, with its placement in the chain (binding-only). */
  admitDelegated(request: unknown, placement: Placement) {
    return AgentInvocation.run(invocation => this.#runtime.admitDelegated(invocation, request, placement));
  }

  hasChild(id: string): Promise<boolean> {
    return AgentInvocation.run(invocation => this.#runtime.hasChild(invocation, id));
  }

  cancelRequest(id: string) {
    return AgentInvocation.run(invocation => this.#runtime.cancelRequest(invocation, id));
  }

  fetch(request: Request): Promise<Response> {
    return AgentInvocation.run(invocation => this.#runtime.fetch(invocation, request));
  }

  onStart() {
    return AgentInvocation.run(invocation => this.#runtime.onStart(invocation));
  }

  onJob(context: { job: { fn: string } }) {
    return AgentInvocation.run(invocation => this.#runtime.onJob(invocation, context));
  }

  webSocketMessage(socket: WebSocket, _data: string | ArrayBuffer) {
    return AgentInvocation.run(invocation => this.#runtime.webSocketMessage(invocation, socket, _data));
  }

  webSocketClose(socket: WebSocket, code: number) {
    return AgentInvocation.run(invocation => this.#runtime.webSocketClose(invocation, socket, code));
  }

  webSocketError(socket: WebSocket) {
    return AgentInvocation.run(invocation => this.#runtime.webSocketError(invocation, socket));
  }

  /** A camel-fs notify delivery for a watched repo (an idempotent outbox row). */
  vmEnded(delivery: string, vm: string) { return AgentInvocation.run(invocation => this.#runtime.vmEnded(invocation, delivery, vm)); }
  stageRepoMove(move: RefMove) { return AgentInvocation.run(invocation => this.#runtime.stageRepoMove(invocation, move)); }
}

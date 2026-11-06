import { DurableObject } from "cloudflare:workers";
import { type RuntimeNotice, type NoticeRequest, type WakeDecision } from "./delegation-notifications.ts";
import type { ChildProgressReport } from "./delegation.ts";
import { Env } from "./agent-types.ts";
import { AgentRuntime } from "./agent-runtime.ts";
import { ARM_AGENT, DUE_HUMAN_INPUTS } from "./agent-internals.ts";
export type { Env } from "./agent-types.ts";
export { json } from "./agent-types.ts";

/** Durable Object entry points. Runtime internals stay off the RPC surface. */
export class CamelAgent extends DurableObject<Env> {
  readonly #runtime = new AgentRuntime(this.ctx, this.env, this);

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

  receiveAgentMessage(
    request: NoticeRequest,
    notice: RuntimeNotice,
  ): Promise<unknown> {
    return this.#runtime.receiveAgentMessage(request, notice);
  }

  receiveAgentProgress(report: ChildProgressReport): Promise<unknown> {
    return this.#runtime.receiveAgentProgress(report);
  }

  hasBackgroundChild(id: string): Promise<boolean> {
    return this.#runtime.hasBackgroundChild(id);
  }

  cancelRequest(id: string) {
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

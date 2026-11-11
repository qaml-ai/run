// A separate Worker is required to keep synchronous QuickJS off the agent thread.
import { CodemodeSandboxDurableObject, cloudflareQuickJSWasm } from "@earendil-works/pi-codemode/cloudflare";
import type { CodemodeRemoteExchange } from "@earendil-works/pi-codemode/portable";
import { EXCHANGE_CEILINGS, SANDBOX_HEAP_BYTES, type ExchangeRequest } from "./exchange.ts";
import { serveExchange } from "./limits.ts";
import type { WorkflowStepRequest } from "./workflow-protocol.ts";
import { serveWorkflowStep } from "./workflow-vm.ts";

export class CodemodeSandbox extends CodemodeSandboxDurableObject {
  // Three independent 24 MiB heaps leave headroom for Wasm and the host in a
  // 128 MiB isolate. Enforce on the remote, including after caller recovery.
  protected override maxInterruptBudget = EXCHANGE_CEILINGS.interruptBudget;
  protected override maxMemoryLimitBytes = SANDBOX_HEAP_BYTES;
  private active = 0;
  override async execute(request: ExchangeRequest, exchange: CodemodeRemoteExchange) {
    if (this.active >= 3) throw new Error("Agent sandbox concurrency limit (3) reached");
    this.active++;
    // The request's own exchange parameters; one this sandbox cannot serve throws (`Remote sandbox failed: ...`).
    try { await serveExchange(request, exchange, (served, bounded) => super.execute(served, bounded)); }
    finally { this.active--; }
  }
  /**
   * Exchange protocol 3: one workflow step (workflow-protocol.ts). It takes one of the three heap slots, as an
   * execution does. Its VM is the same build of QuickJS, which pi-codemode bundles and Wrangler compiles.
   */
  async step(request: WorkflowStepRequest) {
    if (this.active >= 3) throw new Error("Agent sandbox concurrency limit (3) reached");
    this.active++;
    try { return await serveWorkflowStep(request, cloudflareQuickJSWasm as WebAssembly.Module); }
    finally { this.active--; }
  }
}
export default { fetch: () => new Response("Not found", { status: 404 }) };

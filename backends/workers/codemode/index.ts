// A separate Worker is required to keep synchronous QuickJS off the agent thread.
import { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import type { CodemodeRemoteExchange } from "@earendil-works/pi-codemode/portable";
import { EXCHANGE_CEILINGS, SANDBOX_HEAP_BYTES, type ExchangeRequest } from "./exchange.ts";
import { serveExchange } from "./limits.ts";

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
}
export default { fetch: () => new Response("Not found", { status: 404 }) };

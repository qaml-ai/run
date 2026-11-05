// A separate Worker is required to keep synchronous QuickJS off the agent thread.
import { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import type { CodemodeRemoteRequest, CodemodeRemoteExchange } from "@earendil-works/pi-codemode/portable";

export class CodemodeSandbox extends CodemodeSandboxDurableObject {
  // Three independent 24 MiB heaps leave headroom for Wasm and the host in a
  // 128 MiB isolate. Enforce on the remote, including after caller recovery.
  protected override maxMemoryLimitBytes = 24 * 1024 * 1024;
  private active = 0;
  override async execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange) {
    if (this.active >= 3) throw new Error("Agent sandbox concurrency limit (3) reached");
    this.active++;
    try { await super.execute(request, exchange); }
    finally { this.active--; }
  }
}
export default { fetch: () => new Response("Not found", { status: 404 }) };

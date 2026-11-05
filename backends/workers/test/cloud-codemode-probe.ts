// Fixed synthetic cases only. Deploy under a temporary camelrun-proto-* name and delete afterwards.
import { SessionCodemodeSandbox } from "../codemode/sandbox.ts";
import type { CodemodeRemote } from "@earendil-works/pi-codemode/portable";

export default {
  async fetch(request: Request, env: { SANDBOX: DurableObjectNamespace & { getByName(name: string): CodemodeRemote } }) {
    if (new URL(request.url).pathname !== "/smoke" || request.method !== "POST") return new Response("Not found", { status: 404 });
    const session = `cloud-probe-${crypto.randomUUID()}`;
    const sandbox = new SessionCodemodeSandbox({ remote: () => env.SANDBOX.getByName(session), tools: [{ name: "wait", execute: async (args, { signal }) => {
      const ms = Number((args as { ms: number }).ms);
      await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); reject(new Error("cancelled")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", done); resolve(); }, ms);
        signal.addEventListener("abort", done, { once: true });
      });
      return "waited";
    } }] });
    const started = Date.now();
    const arithmetic = await sandbox.execute("return 2 * 3");
    const memory = await sandbox.execute("return new Uint8Array(40 * 1024 * 1024).length");
    const concurrency = await Promise.all(Array.from({ length: 4 }, () => sandbox.execute("await tools.wait({ms:500}); return 1")));
    const abort = new AbortController();
    const cancelled = sandbox.execute("await tools.wait({ms:5000}); return 1", { signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    const cancellation = await cancelled;
    await sandbox.close();
    const result = {
      session, elapsedMs: Date.now() - started,
      arithmetic: arithmetic.ok ? arithmetic.value : arithmetic.error,
      memory: memory.ok ? { unexpectedValue: memory.value } : memory.error,
      concurrency: concurrency.map(value => value.ok ? { value: value.value } : value.error),
      cancellation: cancellation.ok ? { unexpectedValue: cancellation.value } : cancellation.error,
    };
    const passed = result.arithmetic === 6 && !memory.ok && concurrency.filter(x => x.ok).length === 3 && !cancellation.ok && cancellation.error.kind === "aborted";
    return Response.json({ passed, ...result }, { status: passed ? 200 : 500 });
  },
};

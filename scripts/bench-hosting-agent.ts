// The agent host (src/agent-child.ts) with benchmark operations beside its protocol, for scripts/bench-hosting.ts:
// messages of type "bench", which the host's Rpc ignores, answered with "bench-result". "spin" and "grow" misbehave as a
// host with a bug could; "memory" reports this isolate's heap; "quickjs" runs a script in pi-codemode's QuickJS sandbox
// here, in a worker of this thread's own (CodemodeSandbox) or on this thread (InlineCodemodeSandbox).
import { parentPort } from "node:worker_threads";
import { CodemodeSandbox, InlineCodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";

const send = (message: unknown) => parentPort ? parentPort.postMessage(JSON.stringify(message)) : process.send!(message);
const kept: unknown[] = [];

async function operation(request: any) {
  if (request.op === "spin") for (;;);
  if (request.op === "grow") for (;;) kept.push(Array.from({ length: 100_000 }, (_, i) => ({ i })));
  if (request.op === "memory") { const { heapUsed, heapTotal, rss, external, arrayBuffers } = process.memoryUsage(); return { heapUsed, heapTotal, rss, external, arrayBuffers }; }
  if (request.op === "quickjs") {
    const options = { timeoutMs: request.timeoutMs ?? 5_000, ...(request.memoryLimitBytes ? { memoryLimitBytes: request.memoryLimitBytes } : {}), tools: [{ name: "echo", execute: (args: unknown) => args }] };
    const sandbox = request.inline ? new InlineCodemodeSandbox({ ...options, wasm: loadQuickJSWasm() }) : new CodemodeSandbox(options);
    const started = performance.now();
    try {
      const result = await sandbox.execute(request.code);
      return { ms: performance.now() - started, ok: result.ok, ...(result.ok ? { value: result.value } : { error: `${result.error.kind}: ${result.error.message.slice(0, 120)}` }) };
    } finally { await sandbox.close(); }
  }
  throw new Error(`Unknown benchmark operation ${request.op}`);
}

const heard = (message: unknown) => {
  const request = (typeof message === "string" ? JSON.parse(message) : message) as any;
  if (request?.type !== "bench") return;
  operation(request).then(result => send({ type: "bench-result", id: request.id, result }), error => send({ type: "bench-result", id: request.id, error: String(error?.message ?? error) }));
};
if (parentPort) parentPort.on("message", heard);
else process.on("message", heard);

await import("../src/agent-child.ts");

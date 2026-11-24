import { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import { RemoteCodemodeSandbox, type CodemodeRemote } from "@earendil-works/pi-codemode/portable";

export class CodemodeSandbox extends CodemodeSandboxDurableObject {
  protected override maxInterruptBudget = 500_000;
  protected override maxMemoryLimitBytes = 32 * 1024 * 1024;
}

interface Env {
  CODEMODE_SANDBOX: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const input = new URL(request.url).pathname.slice(1);
    const controller = new AbortController();
    const reason = new Error("Run cancelled");
    const code = input === "unresolved" ? "await new Promise(() => {})" : "return await tools.test({})";
    let stopped = false;

    const sandbox = new RemoteCodemodeSandbox({
      remote: () => env.CODEMODE_SANDBOX.getByName(`sandbox-test-${input}`) as unknown as CodemodeRemote,
      timeoutMs: input === "complete" ? 5_000 : 150,
      interruptBudget: 500_000,
      tools: [
        {
          name: "test",
          execute: async (_args, { signal }) => {
            if (input === "complete") return 42;
            if (input === "cancel") controller.abort(reason);
            stopped = signal.aborted;
            signal.addEventListener("abort", () => { stopped = true; }, { once: true });
            return new Promise(() => {});
          },
        },
      ],
    });

    const outcome = await sandbox.execute(code, { signal: controller.signal });
    if (outcome.ok) {
      const logs = outcome.output
        .filter((i): i is { type: "text"; text: string } => i.type === "text")
        .map((i) => i.text);
      return Response.json({ result: outcome.value, logs });
    }
    return Response.json({ kind: outcome.error.kind, error: outcome.error.message, stopped });
  },
};

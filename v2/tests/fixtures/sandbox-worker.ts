import { runCodemodeScript } from "../../worker/src/sandbox.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const input = new URL(request.url).pathname.slice(1);
    const controller = new AbortController();
    const reason = new Error("Run cancelled");
    const code = input === "unresolved" ? "await new Promise(() => {})" : "return await tools.test()";
    let stopped = false;
    try {
      const result = await runCodemodeScript(code, async (_tool, _args, signal) => {
        if (input === "complete") return 42;
        if (input === "cancel") controller.abort(reason);
        stopped = signal.aborted;
        signal.addEventListener("abort", () => { stopped = true; }, { once: true });
        return new Promise(() => {});
      }, { timeoutMs: input === "complete" ? 5_000 : 150, signal: controller.signal });
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error), stopped });
    }
  },
};

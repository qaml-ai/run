import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { getModel } from "../src/pi-catalog.ts";
import { fixture } from "./client-fixture.ts";
import { until } from "./runtime-server.ts";

for (const earlyUsage of [false, true]) for (const action of ["abort", "delete", "concurrent delete"] as const) {
  test(`${action} during a model stream with ${earlyUsage ? "partial nonzero" : "missing"} usage reports billable usage before the agent stops`, async t => {
    const f = await fixture(t);
    const provider = createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume the request */ }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "fixture", ...(earlyUsage ? { usage: { prompt_tokens: 1000, completion_tokens: 2, total_tokens: 1002 } } : {}), choices: [{ index: 0, delta: { role: "assistant", content: "Already generated and charged by the provider." }, finish_reason: null }] })}\n\n`);
      // OpenRouter's final usage would arrive at the end, after the client has canceled.
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    t.after(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
    f.setModel({ ...getModel("openrouter", "anthropic/claude-opus-4.1")!, api: "openai-completions", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1` });
    const usage: any[] = [];
    f.sessions.options.apiKeyFor = () => ({ key: "fixture-only", platform: true });
    f.sessions.options.catalogPriced = async () => true;
    f.sessions.options.onUsage = (_tenant, _agent, message) => usage.push(message);
    let streamed = false;
    const agent = await f.start({}, { onEvent: event => {
      if (event.type === "message_update") streamed = true;
    } });
    // The SDK receives real streamed deltas before the cancellation.
    const pending = agent.prompt("Generate a long reply.").catch(error => error);
    await until(() => streamed, "the provider's partial response");
    if (action === "concurrent delete") await Promise.all([
      f.sessions.destroyAgent(agent.session.id, "default"),
      f.sessions.destroyAgent(agent.session.id, "default"),
    ]);
    else if (action === "delete") await f.sessions.destroyAgent(agent.session.id, "default");
    else await f.sessions.abortAgent(agent.session.id, "default");
    if (action !== "abort") assert.equal(usage.length, 1, "deletion waits for billing before stopping the host");
    await pending;
    await until(() => usage.length > 0, "usage for the canceled response");
    assert.equal(usage.length, 1);
    assert.equal(usage[0].stopReason, "aborted");
    assert.ok(usage[0].usage.input > 0, "the prompt is billed even without a final provider usage event");
    assert.ok(usage[0].usage.output > 2, "the streamed output is billed beyond a stale early count");
    assert.ok(usage[0].usage.cost.total > 0);
  });
}

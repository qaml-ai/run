import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startFixture } from "./fixture.ts";

// A cold owner woken by its workflow's notice, in workerd: the owner starts a workflow that sleeps, goes idle and cold,
// and the workflow's ending, delivered by RPC to the cold owner, must start it and land on the first attempt (no startup
// reset, no retried notice). The model is the scripted provider below.

const textOf = (message: any) => typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part: any) => part.text ?? "").join("\n");
const systemOf = (body: any) => body.messages.filter((message: any) => message.role === "system").map(textOf).join("\n");
const lastUser = (body: any) => textOf(body.messages.filter((message: any) => message.role === "user").at(-1));

function provider(respond: (body: any) => { content?: string; tool?: { name: string; args: unknown; id: string }; tokens?: number }) {
  const bodies: any[] = [];
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    const answer = respond(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (chunk: unknown) => response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    const base = { id: "wf-model", object: "chat.completion.chunk", created: 1, model: "wf-model" };
    const delta = answer.tool
      ? { role: "assistant", tool_calls: [{ index: 0, id: answer.tool.id, type: "function", function: { name: answer.tool.name, arguments: JSON.stringify(answer.tool.args) } }] }
      : { role: "assistant", content: answer.content ?? "" };
    send({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
    // Priced at $1,000/M input tokens (below): each token costs $0.001.
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: answer.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: answer.tokens ?? 1, completion_tokens: 0, total_tokens: answer.tokens ?? 1 } });
    response.end("data: [DONE]\n\n");
  });
  return { server, bodies };
}

async function until<T>(check: () => Promise<T | undefined | false>, description: string, timeout = 90_000, last?: () => Promise<unknown>): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}${last ? ` (last: ${JSON.stringify(await last())})` : ""}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}


test("a cold agent woken by its workflow's notice starts at once and takes it on the first attempt", { timeout: 600_000 }, async t => {
  // B3 (2026-11-12): a notice delivered to a cold owner started it from inside its own send, and startup's drain waited
  // on that send, which waited on startup: Workers reset the object after 30 s, on every wake. The owner here goes idle
  // and cold while its workflow sleeps; the ending must land at once.
  let workflowId: string | undefined;
  const model = provider(body => {
    const user = lastUser(body), last = body.messages.at(-1);
    if (user.includes("<workflow_notification")) return { content: "REPORT" };
    if (last.role === "tool") { workflowId = JSON.parse(textOf(last)).workflowId; return { content: "started" }; }
    return { tool: { name: "workflow_start", args: { script: "await sleep(100); return 'late';", budgetUsd: 1, name: "sleepy" }, id: "start" } };
  });
  model.server.listen(0, "127.0.0.1"); await once(model.server, "listening");
  t.after(() => { model.server.closeAllConnections(); return new Promise<void>(resolve => model.server.close(() => resolve())); });
  const fixture = await startFixture({ vars: { TEST_MODEL: "0", MODEL: "openai/gpt-4o-mini" } });
  t.after(() => fixture.stop());
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(fixture.url + path, { method, headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response.json() as any;
  };
  await call("/v1/providers/wf-fixture", { type: "openai-completions", baseUrl: `http://127.0.0.1:${(model.server.address() as { port: number }).port}/v1`, models: [{ id: "wf-model", contextWindow: 32768, pricing: { input: 1, output: 0 } }] }, "PUT");
  const agent = await call("/v1/agents", { model: "wf-fixture/wf-model", codeMode: false, fileTools: false, builtins: ["delegate"], delegate: { instructions: true } });
  await call(`/v1/agents/${agent.id}/prompt`, { text: "go" });
  const done = await until(async () => { if (!workflowId) return false; const w = await call(`/v1/workflows/${workflowId}`); return w.status === "completed" && w; }, "the workflow", 300_000);
  const report = await until(async () => (((await call(`/v1/agents/${agent.id}`)).requests ?? []) as any[]).find(r => r.id.startsWith(`${workflowId}_n`) && r.state === "completed"), "the owner's report", 60_000,
    async () => fixture.worker.logs().split("\n").filter(line => /notice|agent_start|blockConcurrencyWhile/.test(line)).slice(-20));
  const logs = fixture.worker.logs();
  assert.ok(!/blockConcurrencyWhile\(\) in a Durable Object waited for too long/.test(logs), "no startup was reset");
  assert.ok(!logs.includes("workflow_notice_failed"), "the first send landed");
  assert.ok(!logs.includes("agent_start_stuck"), "no startup step waited");
  assert.ok((report.startedAt ?? report.createdAt) - done.updatedAt < 20_000, JSON.stringify({ report, completedAt: done.updatedAt }));
});

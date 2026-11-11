import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startFixture } from "./fixture.ts";

// Workflows end to end in workerd: an agent writes a workflow with its `workflows` builtin, the workflow runs three
// keyed agent() children in parallel and a critic, every child a real agent the workflow owns (its ending delivered
// by the child's outbox), and the agent reports the result. Then a budget too small pauses a workflow, and a raise
// and a resume finish it. Every model call is the scripted provider below, priced so spend is real.

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

async function until<T>(check: () => Promise<T | undefined | false>, description: string, timeout = 90_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

const SCRIPT = `
phase("review");
const reviews = await parallel(["a", "b", "c"], file => agent("REVIEW " + file, { key: "review:" + file, type: "worker" }));
phase("judge");
const verdict = await agent("CRITIC: check " + JSON.stringify(reviews), { key: "critic", type: "critic", output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } });
return { reviews, verdict, files: args.files };`;

test("an agent starts a workflow of keyed workers and a critic, owned by the workflow, and reports its result; a spent budget pauses one until a raise and a resume", { timeout: 300_000 }, async t => {
  let workflowId: string | undefined;
  const model = provider(body => {
    const system = systemOf(body), user = lastUser(body), last = body.messages.at(-1);
    if (system.includes("You are a worker in a workflow")) return { content: `reviewed ${user.replace("REVIEW ", "")}` };
    if (system.includes("You are a critic in a workflow")) return { tool: { name: "final_output", args: { ok: true }, id: "verdict" } };
    if (user.includes("EXPENSIVE")) return { content: "costly answer", tokens: 600 };
    if (system.includes("You are a sub-agent")) return { content: `plain answer to ${user}` };
    // The orchestrating agent: start the workflow, wait for it, report.
    if (last.role === "tool" && !workflowId) {
      workflowId = JSON.parse(textOf(last)).workflowId;
      return { tool: { name: "workflow_status", args: { workflowId, waitSeconds: 110 }, id: "status" } };
    }
    if (last.role === "tool") return { content: `REPORT ${textOf(last)}` };
    return { tool: { name: "workflow_start", args: { script: SCRIPT, args: { files: 3 }, budgetUsd: 1, name: "review three" }, id: "start" } };
  });
  model.server.listen(0, "127.0.0.1"); await once(model.server, "listening");
  t.after(() => { model.server.closeAllConnections(); return new Promise<void>(resolve => model.server.close(() => resolve())); });
  const fixture = await startFixture({ vars: { TEST_MODEL: "0", MODEL: "openai/gpt-4o-mini", AGENT_WORKFLOW_CLASS_MODELS: JSON.stringify({ fast: "wf-fixture/wf-model", strong: "wf-fixture/wf-model", max: "wf-fixture/wf-model" }) } });
  t.after(() => fixture.stop());
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(fixture.url + path, { method, headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() as any };
  };
  const ok = async (path: string, body?: unknown, method?: string) => {
    const { status, value } = await call(path, body, method);
    assert.ok(status >= 200 && status < 300, `${path}: ${status} ${JSON.stringify(value)}`);
    return value;
  };
  assert.equal((await call("/v1/providers/wf-fixture", { type: "openai-completions", baseUrl: `http://127.0.0.1:${(model.server.address() as { port: number }).port}/v1`, models: [{ id: "wf-model", contextWindow: 32768, pricing: { input: 1000, output: 0 } }] }, "PUT")).status, 200);

  // An agent that may delegate has the workflows builtin; it writes and runs one.
  const agent = await ok("/v1/agents", { model: "wf-fixture/wf-model", codeMode: false, fileTools: false, builtins: ["delegate"], delegate: { instructions: true } });
  const run = await ok(`/v1/agents/${agent.id}/prompt`, { text: "go" });
  const done = await until(async () => { const record = await ok(`/v1/agents/${agent.id}/requests/${run.id}`); return record.state === "completed" && record; }, "the agent's run");
  const reply = String(done.outcome?.result?.reply ?? "");
  assert.match(reply, /^REPORT /, JSON.stringify(done.outcome));
  const reported = JSON.parse(reply.slice("REPORT ".length));
  assert.equal(reported.status, "completed", reply);
  assert.deepEqual(reported.result, { reviews: ["reviewed a", "reviewed b", "reviewed c"], verdict: { ok: true }, files: 3 });

  // The workflow, through the public API: completed, its four effects done, its spend in its ledger.
  const workflow = await ok(`/v1/workflows/${workflowId}`);
  assert.equal(workflow.status, "completed");
  assert.deepEqual(workflow.owner, { kind: "agent", id: agent.id });
  assert.equal(workflow.name, "review three");
  assert.ok(workflow.spent.usd > 0 && workflow.spent.usd <= 1, JSON.stringify(workflow.spent));
  const items = (await ok(`/v1/workflows/${workflowId}/items`)).items as { key: string; kind: string; status: string }[];
  assert.deepEqual(items.filter(item => item.kind === "agent").map(item => [item.key, item.status]).sort(), [["critic", "done"], ["review:a", "done"], ["review:b", "done"], ["review:c", "done"]]);
  // Each child is a real agent the workflow owns, placed under it.
  const children = (await fixture.db.query("select header->'owner' as owner, header->'rootOwner' as root, header->>'parentAgentId' as parent from agents where header->'config'->>'type' = 'subagent'")).rows;
  assert.equal(children.length, 4);
  for (const child of children) {
    assert.deepEqual(child.owner, { kind: "workflow", id: workflowId });
    assert.deepEqual(child.root, { kind: "workflow", id: workflowId });
  }
  // Another tenant's key does not find it; a workflow of no one is not found either.
  assert.equal((await call("/v1/workflows/wf_unknown")).status, 404);

  // A budget too small: the expensive first agent spends more than the whole budget, so the second is refused for
  // budget, and the workflow pauses instead of handing the script a null. A raise and a resume finish it.
  const small = await ok("/v1/workflows", { script: `const a = await agent("EXPENSIVE one", { key: "one" }); const b = await agent("cheap two", { key: "two" }); return [a, b];`, budget: { usd: 0.5 }, concurrency: 1 });
  assert.match(small.id, /^wf_/);
  const paused = await until(async () => { const value = await ok(`/v1/workflows/${small.id}`); return ["budget_exhausted", "paused"].includes(value.status) && value; }, "the budget pause");
  assert.equal(paused.status, "budget_exhausted", JSON.stringify(paused));
  assert.ok(paused.spent.usd >= 0.5, JSON.stringify(paused.spent));
  await ok(`/v1/workflows/${small.id}/budget`, { usd: 5 });
  await ok(`/v1/workflows/${small.id}/resume`, {});
  const finished = await until(async () => { const value = await ok(`/v1/workflows/${small.id}`); return value.status === "completed" && value; }, "the resumed workflow");
  assert.deepEqual(finished.result, ["costly answer", "plain answer to cheap two"]);

});

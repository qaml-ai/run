import { test } from "node:test";
import assert from "node:assert/strict";
import { Agents } from "../clients/node.ts";
import { OPERATOR, runtime, toolCall, toolResults, until, watchEvents } from "./runtime-server.ts";

/** The model request's system text: its system messages, wherever they are, in order. */
const systemText = (body: any) => body.messages.filter((message: any) => message.role === "system" || message.role === "developer")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")).join("\n");
const userText = (body: any) => body.messages.filter((message: any) => message.role === "user").map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")).join("\n");

/** A workflow that lists work with one agent call, does it with a pipeline, and returns both. */
const SCAN = `export const meta = { name: "scan", description: "Find items, then work them" }
phase("list")
const list = await agent("list items", { agent: "worker", label: "list", schema: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "string" } } } } })
phase("each")
const out = await pipeline(list.items, item => agent(\`work \${item}\`, { agent: "worker", label: String(item) }))
log(\`worked \${out.length}\`)
return { items: list.items, out }`;

test("the SDK runs a stateless workflow with its builtin added automatically", async t => {
  const r = await runtime(t, body => {
    if (systemText(body).includes("WORKER")) return { role: "assistant", content: "worked" };
    return toolResults(body).length
      ? { role: "assistant", content: JSON.parse(toolResults(body).at(-1)).value }
      : toolCall("run_workflow", { script: `return await agent("work", { instructions: "You are WORKER." })` });
  });
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  const result = await agents.run({ input: "go", workflow: { instructions: true } });
  assert.equal(result.text, "worked");
  assert.ok(result.toolCalls.some(call => call.tool === "run_workflow" && call.ok));
});

test("run_workflow coordinates child agents from a script and returns only the script's value", async t => {
  const r = await runtime(t, body => {
    if (systemText(body).includes("WORKER")) {
      if (userText(body).includes("list items")) return toolCall("final_output", { items: ["alpha", "beta"] }, "call_list");
      return { role: "assistant", content: `done ${userText(body).trim().split(/\s+/).pop()}` };
    }
    return toolResults(body).length ? { role: "assistant", content: "done" } : toolCall("run_workflow", { script: SCAN }, "call_workflow");
  });
  await r.call("/v1/definitions", { headers: { "Idempotency-Key": "worker" }, body: { name: "Worker", description: "Does one item", systemPrompt: "You are WORKER." } });
  // The builtin and its settings go together, as delegate's do.
  assert.equal((await r.call("/v1/agents", { body: { builtins: ["workflow"] } })).status, 400);
  assert.equal((await r.call("/v1/agents", { body: { workflow: { agents: ["worker"] } } })).status, 400);
  const created = await r.call("/v1/agents", { body: { builtins: ["workflow"], workflow: { agents: ["worker"], maxParallel: 2 } } });
  assert.equal(created.status, 201, created.text);
  const parent = created.json.id;

  const watcher = await watchEvents(t, `${r.base}/v1/agents/${parent}/events`, { Authorization: `Bearer ${OPERATOR}` }, { query: "watch=1&subagents=1" });
  const record = await r.prompt(parent, "Run the scan");
  const seen = watcher.frames.map(frame => frame.data.event).filter(Boolean);
  assert.equal(record.error, undefined, JSON.stringify(record));
  const answered = JSON.parse(toolResults(r.model.bodies.at(-1))[0]);
  assert.equal(answered.status, "completed", JSON.stringify(answered));

  const call = record.outcome.result.toolCalls.find((entry: any) => entry.tool === "run_workflow");
  assert.equal(call.ok, true, JSON.stringify(call));
  assert.equal(call.agentId, undefined, "a workflow's call runs many children; it names none of them");
  // What the model got back is the script's return value, and nothing else.
  assert.equal(answered.agents.length, 3);
  assert.equal(answered.value.items.length, 2);
  assert.deepEqual(answered.value.out, ["done alpha", "done beta"]);

  // The model saw the target and what it is for.
  const tool = r.model.bodies[0].tools.find((entry: any) => entry.function.name === "run_workflow").function;
  assert.match(tool.description, /worker: Does one item/);

  // Every agent() call made a real child: three of them, linked to this run, one step down the chain.
  const children = (await r.call("/v1/agents")).json.filter((agent: any) => agent.parentAgentId === parent);
  assert.equal(children.length, 3);
  for (const child of children) {
    const detail = (await r.call(`/v1/agents/${child.id}`)).json;
    assert.equal(detail.parentRunId, record.id);
    const run = detail.requests.find((request: any) => request.method === "prompt");
    assert.equal(run.metadata.delegationDepth, "1");
    assert.equal(run.metadata.parentAgentId, parent);
  }

  // Its progress reaches a stream that asked for children's events.
  await until(() => seen.some((event: any) => event.type === "workflow_start"), "workflow_start");
  assert.ok(seen.some((event: any) => event.type === "workflow_progress" && event.phase === "each"));
  assert.ok(seen.some((event: any) => event.type === "subagent_start"));
  assert.ok(seen.some((event: any) => event.type === "workflow_end" && event.status === "completed"));
});

test("an agent call the settings do not allow answers null instead of failing the script", async t => {
  const r = await runtime(t, body => {
    if (systemText(body).includes("WORKER")) return { role: "assistant", content: "fine" };
    if (toolResults(body).length) return { role: "assistant", content: "done" };
    return toolCall("run_workflow", { script: `const answer = await agent("hi", { agent: "nobody" }); return { answer }` }, "call_bad");
  });
  await r.call("/v1/definitions", { headers: { "Idempotency-Key": "worker" }, body: { name: "Worker", description: "Does one item", systemPrompt: "You are WORKER." } });
  const parent = (await r.call("/v1/agents", { body: { builtins: ["workflow"], workflow: { agents: ["worker"] } } })).json.id;
  const record = await r.prompt(parent, "Run it");
  const call = record.outcome.result.toolCalls.find((entry: any) => entry.tool === "run_workflow");
  assert.equal(call.ok, true, JSON.stringify(call));
  assert.equal(call.agentId, undefined, "a workflow's call runs many children; it names none of them");
  const answered = JSON.parse(toolResults(r.model.bodies.at(-1))[0]);
  assert.deepEqual(answered.value, { answer: null }, "an agent the settings do not allow answers null instead of failing the script");
});

test("an agent's workflow settings reach its definition and its detail", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const definition = await r.call("/v1/definitions", { headers: { "Idempotency-Key": "wf" }, body: { name: "Scripted", systemPrompt: "You are SCRIPTED.", workflow: { agents: ["worker"] } } });
  assert.equal(definition.status, 400, "workflow settings need the workflow builtin");
  assert.match(definition.json.error, /workflow builtin/);
  const saved = await r.call("/v1/definitions", { headers: { "Idempotency-Key": "wf2" }, body: { name: "Scripted", systemPrompt: "You are SCRIPTED.", builtins: ["workflow"], workflow: { agents: ["worker"], maxAgents: 5 } } });
  assert.equal(saved.status, 201, saved.text);
  assert.deepEqual(saved.json.workflow, { agents: [{ name: "worker", definition: "worker" }], maxAgents: 5 });
  const agent = await r.call("/v1/agents", { body: { definition: saved.json.id } });
  assert.equal(agent.status, 201, agent.text);
  assert.deepEqual((await r.call(`/v1/agents/${agent.json.id}`)).json.workflow, { agents: [{ name: "worker", definition: "worker" }], maxAgents: 5 });
  // Without a definition, an agent's own settings are its own.
  const own = await r.call("/v1/agents", { body: { builtins: ["workflow"], workflow: { instructions: true } } });
  assert.deepEqual((await r.call(`/v1/agents/${own.json.id}`)).json.workflow, { instructions: true });
});

test("an agent with the workflow builtin is offered run_workflow; one without never sees it", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const offered = async (body: unknown) => {
    const agent = (await r.call("/v1/agents", { body })).json.id;
    await r.prompt(agent, "hi");
    return r.model.bodies.at(-1).tools.map((tool: any) => tool.function.name);
  };
  assert.ok((await offered({ builtins: ["workflow"], workflow: { instructions: true } })).includes("run_workflow"));
  assert.ok(!(await offered({ builtins: ["web_search"] })).includes("run_workflow"));
});

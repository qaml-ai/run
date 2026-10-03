import { test } from "node:test";
import assert from "node:assert/strict";
import { Agents, type StreamPart } from "../clients/node.ts";
import { watchAgent } from "../clients/watch.ts";
import { OPERATOR, runtime, toolCall, toolResults, until } from "./runtime-server.ts";

const systemText = (body: any) => body.messages.filter((message: any) => message.role === "system" || message.role === "developer")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")).join("\n");

test("SDK: delegate settings on upsert bring their builtin; a run lists its child's id, and a stream with subagents shows it start and end", async t => {
  const r = await runtime(t, body => {
    if (systemText(body).includes("HELPER")) return { role: "assistant", content: "helped" };
    return body.messages.at(-1).role === "tool" ? { role: "assistant", content: `done: ${JSON.parse(toolResults(body).at(-1)).text}` } : toolCall("delegate", { instructions: "You are HELPER.", task: "help" }, `call_${body.messages.length}`);
  });
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  const agent = await agents.upsert("coordinator", { delegate: { instructions: true }, subagents: true });
  assert.deepEqual((await r.call(`/v1/agents/${agent.id}`)).json.builtins, ["delegate"]);

  const run = await agent.run("go");
  assert.equal(run.text, "done: helped");
  const call = run.toolCalls.find(entry => entry.tool === "delegate")!;
  assert.match(call.agentId!, /^client_/);
  assert.ok(run.usage);

  // A browser's watcher follows the sub-agent too, under its delegate call.
  const minted = (await r.call(`/v1/agents/${agent.id}/browser-tokens`, { body: {} })).json;
  const watcher = watchAgent({ url: r.base, agentId: agent.id, token: minted.token, expiresAt: minted.expiresAt, subagents: true });
  t.after(() => watcher.close());
  await until(() => watcher.state.connected, "the watcher connected");

  const parts: StreamPart[] = [];
  for await (const part of agent.stream("again")) parts.push(part);
  const followed = await until(() => [...watcher.state.subagents.values()].find(child => child.status === "completed"), "the watcher saw the sub-agent end");
  assert.ok(followed.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes("helped")));
  const start = parts.find(part => part.type === "subagent_start") as Extract<StreamPart, { type: "subagent_start" }>;
  const end = parts.find(part => part.type === "subagent_end") as Extract<StreamPart, { type: "subagent_end" }>;
  assert.ok(start && end, JSON.stringify(parts.map(part => part.type)));
  assert.equal(start.agentId, end.agentId);
  assert.equal(end.status, "completed");
});

test("SDK: a definition upserted with handoff settings brings its builtin, and a run lists its handoffs", async t => {
  const r = await runtime(t, body => {
    const system = systemText(body);
    return system.lastIndexOf("BILLING") > system.lastIndexOf("TRIAGE") ? { role: "assistant", content: "billing" } : toolCall("handoff", { to: "billing" }, `call_${body.messages.length}`);
  });
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  await agents.runtime.upsertDefinition("billing", { name: "Billing", systemPrompt: "You are BILLING." });
  const triage = await agents.runtime.upsertDefinition("triage", { name: "Triage", systemPrompt: "You are TRIAGE.", handoff: { definitions: ["billing"] } });
  assert.deepEqual(triage.builtins, ["handoff"]);
  const agent = await agents.upsert("conversation", { definition: triage.id });
  const parts: StreamPart[] = [];
  const stream = agent.stream("refund");
  for await (const part of stream) parts.push(part);
  const run = await stream.result();
  assert.equal(run.text, "billing");
  assert.deepEqual(run.handoffs.map(handoff => [handoff.from, handoff.to]), [["Triage", "billing"]]);
  assert.ok(parts.some(part => part.type === "handoff" && part.to === "billing"));
});

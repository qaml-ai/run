import { test } from "node:test";
import assert from "node:assert/strict";
import { Agents } from "../clients/node.ts";
import { OPERATOR, runtime, toolCall, until } from "./runtime-server.ts";

/** The model request's user messages, as text. */
const userTexts = (body: any) => body.messages.filter((message: any) => message.role === "user")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join(""));
const ignored = (logs: string[], source: string) => logs.map(line => { try { return JSON.parse(line); } catch { return undefined; } })
  .filter(entry => entry?.type === "history_none_ignored" && entry.source === source);

test("a prompt's history: \"none\" is accepted and ignored: the run sees the agent's history, logged once per agent", async t => {
  const r = await runtime(t, (_body, index) => ({ role: "assistant", content: `answer ${index}` }));
  const id = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.prompt(id, "first question");
  await r.prompt(id, "second question", undefined, { history: "none" });
  await r.prompt(id, "third question", undefined, { history: "none" });
  await r.prompt(id, "fourth question", undefined, { history: "full" });
  for (const [index, seen] of [[1, ["first", "second"]], [2, ["first", "second", "third"]], [3, ["first", "second", "third", "fourth"]]] as const) {
    assert.deepEqual(userTexts(r.model.bodies[index]).map((text: string) => text.match(/(first|second|third|fourth) question/)?.[1]), seen);
  }
  // Not marked on the stored message.
  const history = (await r.call(`/v1/agents/${id}/history`)).json.messages;
  assert.ok(history.every((message: any) => message.history === undefined));
  // Logged once for the agent, however often it is sent.
  await until(() => ignored(r.logs, "prompt").length > 0, "the deprecation log");
  assert.deepEqual(ignored(r.logs, "prompt").map(entry => [entry.agent, typeof entry.tenant]), [[id, "string"]]);
  // Only full or none, as before.
  assert.equal((await r.call(`/v1/agents/${id}/prompt`, { body: { text: "x", history: "some" } })).status, 400);
});

test("the SDK still takes history: \"none\" (ignored), codeMode and configHash", async t => {
  const r = await runtime(t, body => body.tool_choice ? toolCall("final_output", { yes: true }) : ({ role: "assistant", content: "ok" }));
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  const agent = await agents.upsert("yes-no", { instructions: "Answer yes or no.", codeMode: false, fileTools: false });
  const again = await agents.upsert("yes-no", { instructions: "Answer yes or no.", codeMode: false, fileTools: false });
  assert.match(agent.configHash!, /^[0-9a-f]{64}$/);
  assert.equal(again.configHash, agent.configHash);
  assert.equal((await agents.get("yes-no")).configHash, agent.configHash);
  assert.equal((await agents.runtime.listAgents()).find(entry => entry.id === agent.id)?.configHash, agent.configHash);
  await agent.run("First question");
  const run = await agent.run("Second question", { history: "none", output: { type: "object", properties: { yes: { type: "boolean" } }, required: ["yes"] } });
  assert.deepEqual(run.output, { yes: true });
  const body = r.model.bodies.at(-1);
  assert.deepEqual(userTexts(body).map((text: string) => text.includes("First question") || text.includes("Second question")), [true, true]);
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "final_output" } });
  assert.doesNotMatch(JSON.stringify(body), /js_exec/);
});

test("a schedule's history: \"none\", sent or stored, is accepted and ignored: its wake-up sees the agent's history", async t => {
  const r = await runtime(t, (_body, index) => ({ role: "assistant", content: `answer ${index}` }));
  const id = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.prompt(id, "first question");
  const sent = await r.call(`/v1/agents/${id}/schedules`, { body: { text: "nightly triage", history: "none", inSeconds: 0 } });
  assert.equal(sent.status, 201, sent.text);
  assert.equal(sent.json.history, undefined, "not stored");
  const woken = await until(() => r.model.bodies.find((body: any) => userTexts(body).some((text: string) => text.includes("nightly triage"))), "the wake-up");
  assert.ok(userTexts(woken).some((text: string) => text.includes("first question")), "the wake-up sees the history");
  // One an earlier release stored with history "none" wakes with the history too.
  const stored = await r.call(`/v1/agents/${id}/schedules`, { body: { text: "stored triage", inSeconds: 3600 } });
  await r.db.query("update schedules set history = 'none', due_at = 0 where id = $1", [stored.json.id]);
  const storedWake = await until(() => r.model.bodies.find((body: any) => userTexts(body).some((text: string) => text.includes("stored triage"))), "the stored wake-up");
  assert.ok(userTexts(storedWake).some((text: string) => text.includes("nightly triage")));
  await until(async () => (await r.call(`/v1/agents/${id}/schedules`)).json.length === 0, "the one-off schedules gone");
  assert.deepEqual(ignored(r.logs, "schedule").map(entry => entry.agent), [id], "logged once for the agent");
  // Only full or none, as before; a code schedule may carry it too, ignored.
  assert.equal((await r.call(`/v1/agents/${id}/schedules`, { body: { text: "x", history: "some", inSeconds: 60 } })).status, 400);
  assert.equal((await r.call(`/v1/agents/${id}/schedules`, { body: { code: "return 1", history: "none", inSeconds: 60 } })).status, 201);
});

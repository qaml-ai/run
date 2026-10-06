import { test } from "node:test";
import assert from "node:assert/strict";
import { Agents } from "../clients/node.ts";
import { OPERATOR, runtime, toolCall } from "./runtime-server.ts";

/** The model request's user messages, as text. */
const userTexts = (body: any) => body.messages.filter((message: any) => message.role === "user")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join(""));
const systemText = (body: any) => body.messages.filter((message: any) => message.role === "system" || message.role === "developer")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")).join("\n");

test("a prompt with history: \"none\" shows the model the system prompt as it stands and this message alone; its run is still history", async t => {
  const r = await runtime(t, (_body, index) => ({ role: "assistant", content: `answer ${index}` }));
  const id = (await r.call("/v1/agents", { body: { systemPrompt: "Answer in one word." } })).json.id as string;
  await r.prompt(id, "first question");
  // The instructions change between runs: a fresh run sees them as they are now.
  const configured = await r.call(`/v1/agents/${id}/configuration`, { method: "PATCH", body: { systemPrompt: "Answer yes or no." } });
  assert.equal(configured.status, 202, configured.text);
  const fresh = await r.prompt(id, "second question", undefined, { history: "none" });
  assert.equal(fresh.outcome.result.reply, "answer 1");
  assert.deepEqual(userTexts(r.model.bodies[1]).map((text: string) => text.includes("second question")), [true], "no earlier message");
  assert.equal(r.model.bodies[1].messages.filter((message: any) => message.role === "assistant").length, 0);
  assert.match(systemText(r.model.bodies[1]), /Answer yes or no\./);
  assert.doesNotMatch(systemText(r.model.bodies[1]), /Answer in one word\./);
  // Recorded for audit, marked; and a later run without it sees the whole history, the fresh run's included.
  const history = (await r.call(`/v1/agents/${id}/history`)).json.messages;
  assert.deepEqual(history.map((message: any) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(history[2].history, "none");
  assert.equal(history[0].history, undefined);
  await r.prompt(id, "third question");
  assert.deepEqual(userTexts(r.model.bodies[2]).map((text: string) => text.match(/(first|second|third) question/)?.[1]), ["first", "second", "third"]);
  // Fresh runs one after another each see only their own message, with structured output too.
  const r2 = await runtime(t, (_body, index) => toolCall("final_output", { yes: index % 2 === 0 }, `call_${index}`));
  const agent = (await r2.call("/v1/agents", { body: {} })).json.id as string;
  for (const question of ["Is water wet?", "Is fire cold?"]) {
    const record = await r2.prompt(agent, question, undefined, { history: "none", output: { schema: { type: "object", properties: { yes: { type: "boolean" } }, required: ["yes"] } } });
    assert.equal(typeof record.outcome.result.output.yes, "boolean", JSON.stringify(record));
  }
  assert.deepEqual(userTexts(r2.model.bodies[1]).map((text: string) => text.includes("Is fire cold?")), [true]);
  assert.match(systemText(r2.model.bodies[1]), /<structured_output>/);
});

test("history is \"full\" or \"none\", for a prompt that starts its own turn", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const id = (await r.call("/v1/agents", { body: {} })).json.id as string;
  for (const body of [{ text: "x", history: "some" }, { text: "x", history: "none", whileRunning: "steer" }]) {
    const refused = await r.call(`/v1/agents/${id}/prompt`, { body });
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  const viaToken = await r.call("/v1/agents", { body: {} });
  const execute = await fetch(`${r.base}/clients/${viaToken.json.id}/requests`, { method: "POST", headers: { Authorization: `Bearer ${viaToken.json.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: "x1", method: "execute", params: { code: "return 1", history: "none" } }) });
  assert.equal(execute.status, 400);
  assert.match((await execute.json()).error, /history is "full" or "none", for a prompt/);
  // full is the default, the same as leaving it out.
  assert.equal((await r.prompt(id, "hello", undefined, { history: "full" })).outcome.result.reply, "ok");
});

test("the SDK: codeMode, history: \"none\" and configHash", async t => {
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
  assert.deepEqual(userTexts(body).map((text: string) => text.includes("Second question")), [true]);
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "final_output" } });
  assert.doesNotMatch(JSON.stringify(body), /js_exec/);
});

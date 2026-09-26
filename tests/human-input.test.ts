import { test } from "node:test";
import assert from "node:assert/strict";
import { lastUser, runtime, toolCall, toolResults, until } from "./runtime-server.ts";

const ASK = { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }, { label: "US" }], allowOther: true }] };

/** An agent with ask_user, from a definition. */
async function asker(r: Awaited<ReturnType<typeof runtime>>, humanInput?: object) {
  const definition = (await r.call("/v1/definitions", { body: { name: "Asker", builtins: ["ask_user"], ...(humanInput ? { humanInput } : {}) } })).json;
  const created = await r.call("/v1/agents", { body: { definition: definition.id, ttlSeconds: null } });
  assert.equal(created.status, 201, created.text);
  return created.json.id as string;
}
const request = (r: Awaited<ReturnType<typeof runtime>>, agent: string, id: string) =>
  until(async () => { const record = (await r.call(`/v1/agents/${agent}/requests/${id}`)).json; return record.state === "completed" && record; }, `request ${id}`);

test("ask_user suspends the turn; the answer, after the agent unloaded, resumes it with the answer as the call's result", async t => {
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("ask_user", ASK, "call_ask")
    : { role: "assistant", content: `Deploying to ${JSON.parse(toolResults(body).at(-1)).answers["Which region?"]}` }, { AGENT_IDLE_MS: "1000" });
  const agent = await asker(r);
  const suspended = await r.prompt(agent, "Deploy it");
  assert.equal(suspended.outcome.result.stopped, "input_required");
  const [input] = suspended.outcome.result.inputs;
  assert.equal(input.kind, "question");
  assert.equal(input.message, "Which region?");
  assert.equal(input.toolCallId, "call_ask");
  assert.deepEqual(input.detail.questions[0].options.map((option: any) => option.label), ["EU", "US"]);
  assert.ok(input.expiresAt - Date.now() > 6 * 86_400_000, "inputs wait 7 days by default");
  assert.equal(r.model.bodies.length, 1, "the model is not called while the turn waits");
  const system = r.model.bodies[0].messages.find((message: any) => message.role === "system" || message.role === "developer").content;
  assert.match(system, /ask them with ask_user; your turn pauses until they answer/);

  // Nothing runs while it waits: the agent unloads, and the transcript holds the call open with no result.
  await until(async () => !(await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).running, "the idle agent to stop");
  const history = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.equal(history.at(-1).role, "assistant");
  assert.equal(history.filter((message: any) => message.role === "toolResult").length, 0);
  assert.deepEqual((await r.call(`/v1/agents/${agent}/inputs?state=pending`)).json.map((entry: any) => entry.id), [input.id]);

  // Answers must fit the question.
  for (const content of [undefined, { answers: {} }, { answers: { "Which region?": ["EU"] } }]) {
    assert.equal((await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", content } })).status, 400);
  }
  const answered = await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", content: { answers: { "Which region?": "EU" } }, from: { id: "u1", name: "Ada" } } });
  assert.equal(answered.status, 202, answered.text);
  assert.equal(answered.json.input.state, "answered");
  assert.equal(answered.json.request.method, "resume");
  // Retrying the same answer is safe; a different one conflicts and says what was recorded.
  assert.equal((await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", content: { answers: { "Which region?": "EU" } }, from: { id: "u1", name: "Ada" } } })).status, 200);
  const conflict = await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "decline" } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.input.state, "answered");

  const resumed = await request(r, agent, answered.json.request.id);
  assert.equal(resumed.outcome.result.reply, "Deploying to EU");
  const result = JSON.parse(toolResults(r.model.bodies[1]).at(-1));
  assert.deepEqual(result.answers, { "Which region?": "EU" });
  assert.equal(result.answeredBy, "Ada");
  assert.match(result.waited, /^\d+s$/);
  assert.equal(r.model.bodies[1].messages.filter((message: any) => message.role === "user").length, 1, "the answer is the call's result, not a new message");
});

test("a new message supersedes a waiting input; its call is closed and the prompt runs", async t => {
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("ask_user", ASK) : { role: "assistant", content: `Read: ${lastUser(body)}` });
  const agent = await asker(r);
  const [input] = (await r.prompt(agent, "Deploy it")).outcome.result.inputs;
  const next = await r.prompt(agent, "Never mind, what time is it?");
  assert.equal(next.outcome.result.reply, "Read: Never mind, what time is it?");
  assert.match(toolResults(r.model.bodies[1]).at(-1), /Not answered: the user sent a new message instead/);
  assert.equal((await r.call(`/v1/agents/${agent}/inputs`)).json[0].state, "superseded");
  assert.equal((await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", content: { answers: { "Which region?": "EU" } } } })).status, 409);
});

test("abort cancels waiting inputs and closes the turn without the model; expiry does the same", async t => {
  const r = await runtime(t, () => toolCall("ask_user", ASK));
  const agent = await asker(r);
  await r.prompt(agent, "Deploy it");
  assert.equal((await r.call(`/v1/agents/${agent}/abort`, { method: "POST" })).status, 200);
  const cancelled = (await r.call(`/v1/agents/${agent}/inputs`)).json[0];
  assert.equal(cancelled.state, "cancelled");
  await until(async () => (await r.call(`/v1/agents/${agent}/history`)).json.messages.at(-1)?.role === "toolResult", "the call to be closed");
  assert.match((await r.call(`/v1/agents/${agent}/history`)).json.messages.at(-1).content[0].text, /Cancelled by the application/);
  assert.equal(r.model.bodies.length, 1);

  // Expired inputs (made due here) are closed by the scheduler, again without the model.
  await r.prompt(agent, "Deploy it again");
  await r.db.query("update agent_inputs set expires_at = 0 where state = 'pending'");
  await until(async () => (await r.call(`/v1/agents/${agent}/inputs`)).json[0].state === "expired", "the input to expire");
  await until(async () => /expired/.test((await r.call(`/v1/agents/${agent}/history`)).json.messages.at(-1)?.content?.[0]?.text ?? ""), "the call to be closed");
  assert.equal(r.model.bodies.length, 2);
});

test("only whoever started the turn, or an approver, may answer", async t => {
  const r = await runtime(t, (_body, index) => index === 0 ? toolCall("ask_user", ASK) : { role: "assistant", content: "done" });
  const agent = await asker(r, { approvers: ["boss"] });
  const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "Deploy", from: { id: "alice" } } });
  const [input] = (await request(r, agent, accepted.json.id)).outcome.result.inputs;
  assert.deepEqual(input.responders, { audience: ["alice"] });
  const answer = (from?: object) => r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", content: { answers: { "Which region?": "US" } }, ...(from ? { from } : {}) } });
  assert.equal((await answer({ id: "mallory" })).status, 403);
  assert.equal((await answer({ id: "boss" })).status, 202);
});

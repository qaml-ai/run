import { test } from "node:test";
import assert from "node:assert/strict";
import { listen, runtime, sleep, toolCall, until } from "./runtime-server.ts";
import { signedHeaders } from "../src/usage-webhooks.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_USAGE_WEBHOOK_RETRY_MS: "100" };
const LIFECYCLE = ["run.started", "run.finished", "input.requested", "input.resolved"];
const ASK = { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }, { label: "US" }] }] };

async function receiver(t: { after(fn: () => void): void }) {
  const received: { headers: Record<string, any>; body: string; json: any }[] = [];
  const url = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ headers: req.headers, body, json: JSON.parse(body) });
    res.writeHead(204).end();
  });
  const find = (type: string, requestId?: string) => received.find(entry => entry.json.type === type && (requestId === undefined || entry.json.requestId === requestId))?.json;
  return { url, received, find };
}

test("a webhook that selects them gets each run's start and end, with its outcome and usage, and each input's request and resolution, signed", async t => {
  const hook = await receiver(t);
  const r = await runtime(t, (_body, index) => index === 0
    ? { ...toolCall("ask_user", ASK, "call_ask"), usage: { prompt_tokens: 100, completion_tokens: 10 } }
    : { role: "assistant", content: "Deploying to EU", usage: { prompt_tokens: 120, completion_tokens: 5 } }, LOCAL);

  assert.equal((await r.call("/v1/usage-webhook", { method: "PUT", body: { url: hook.url, events: ["run.started", "nope"] } })).status, 400);
  const set = await r.call("/v1/usage-webhook", { method: "PUT", body: { url: hook.url, events: LIFECYCLE } });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual(set.json.events, LIFECYCLE);
  const secret = set.json.secret;
  assert.deepEqual((await r.call("/v1/usage-webhook")).json.events, LIFECYCLE);

  const definition = (await r.call("/v1/definitions", { body: { name: "Asker", builtins: ["ask_user"] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id as string;
  const suspended = await r.prompt(agent, "Deploy it");
  const started = await until(() => hook.find("run.started", suspended.id), "run.started");
  assert.deepEqual([started.tenant, started.agent, started.method], ["alice", agent, "prompt"]);
  const requested = await until(() => hook.find("input.requested", suspended.id), "input.requested");
  const [input] = suspended.outcome.result.inputs;
  assert.deepEqual([requested.agent, requested.input.id, requested.input.message, requested.input.state], [agent, input.id, "Which region?", "pending"]);
  const paused = await until(() => hook.find("run.finished", suspended.id), "run.finished of the suspended turn");
  assert.equal(paused.outcome.result.stopped, "input_required");
  assert.deepEqual([paused.usage.responses, paused.usage.input, paused.usage.output], [1, 100, 10]);

  const answered = await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", content: { answers: { "Which region?": "EU" } } } });
  const resume = answered.json.request.id;
  const resolved = await until(() => hook.find("input.resolved", suspended.id), "input.resolved");
  assert.deepEqual([resolved.input.id, resolved.input.state], [input.id, "answered"]);
  const finished = await until(() => hook.find("run.finished", resume), "run.finished of the resumed turn");
  assert.equal(finished.method, "resume");
  assert.equal(finished.outcome.result.reply, "Deploying to EU");
  const history = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.equal(finished.outcome.result.replyIndex, history.length - 1, "the final assistant message's index in the history");
  assert.equal(history[finished.outcome.result.replyIndex].role, "assistant");
  assert.deepEqual([finished.usage.responses, finished.usage.input, finished.usage.output], [1, 120, 5]);
  assert.ok(finished.usage.costUsd >= 0);

  await r.call("/v1/usage");
  await until(() => hook.find("run.started", resume), "run.started of the resumed turn");
  for (const entry of hook.received) {
    const expected = signedHeaders(entry.headers["webhook-id"], entry.body, [secret], Number(entry.headers["webhook-timestamp"]) * 1000);
    assert.equal(entry.headers["webhook-signature"], expected["webhook-signature"]);
    assert.equal(entry.json.id, entry.headers["webhook-id"]);
    assert.ok(LIFECYCLE.includes(entry.json.type), `only selected types: ${entry.json.type}`);
  }
  assert.equal(new Set(hook.received.map(entry => entry.json.id)).size, hook.received.length, "each event has its own id");

  // Setting the URL again keeps the selection; choosing usage alone sends usage, typed, and no lifecycle events.
  assert.deepEqual((await r.call("/v1/usage-webhook", { method: "PUT", body: { url: hook.url } })).json.events, LIFECYCLE);
  assert.deepEqual((await r.call("/v1/usage-webhook", { method: "PUT", body: { url: hook.url, events: ["usage"] } })).json.events, ["usage"]);
  const before = hook.received.length;
  const again = await r.prompt(agent, "Once more");
  await r.call("/v1/usage");
  const usage = await until(() => hook.find("usage", again.id), "the usage event");
  assert.equal(usage.kind, "response");
  assert.deepEqual(hook.received.slice(before).map(entry => entry.json.type), ["usage"]);
});

test("a new webhook sends usage alone unless it selects more", async t => {
  const hook = await receiver(t);
  const r = await runtime(t, () => ({ role: "assistant", content: "hi", usage: { prompt_tokens: 10, completion_tokens: 1 } }), LOCAL);
  assert.deepEqual((await r.call("/v1/usage-webhook", { method: "PUT", body: { url: hook.url } })).json.events, ["usage"]);
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const done = await r.prompt(agent, "Hi");
  await r.call("/v1/usage");
  await until(() => hook.find("usage", done.id), "the usage event");
  assert.deepEqual(hook.received.map(entry => entry.json.type), ["usage"]);
});

test("a run whose run.finished could not be written when it ended has it written with the agent's next load or run, once", async t => {
  const hook = await receiver(t);
  const r = await runtime(t, () => ({ role: "assistant", content: "done" }), { ...LOCAL, AGENT_IDLE_MS: "1000" });
  await r.call("/v1/usage-webhook", { method: "PUT", body: { url: hook.url, events: ["run.finished"] } });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const unloaded = () => until(async () => !(await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).running, "the idle agent to unload");

  await r.db.query("alter table usage_webhook_outbox rename to usage_webhook_outbox_away");
  const lost = await r.prompt(agent, "first");
  await sleep(300);
  await r.db.query("alter table usage_webhook_outbox_away rename to usage_webhook_outbox");
  assert.equal(hook.find("run.finished", lost.id), undefined);
  await unloaded();

  const next = await r.prompt(agent, "second");
  await until(() => hook.find("run.finished", lost.id) && hook.find("run.finished", next.id), "both runs' events");
  assert.equal(hook.find("run.finished", lost.id).outcome.result.reply, "done");
  await unloaded();
  const third = await r.prompt(agent, "third");
  await until(() => hook.find("run.finished", third.id), "the third run's event");
  await sleep(500);
  assert.equal(hook.received.filter(entry => entry.json.requestId === lost.id).length, 1, "written once, not at every load");
});

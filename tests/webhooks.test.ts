import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listen, runtime, sleep, toolCall, until } from "./runtime-server.ts";
import { cluster, fakeModel, token } from "./cluster-helpers.ts";
import { signedHeaders } from "../src/webhooks.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_USAGE_WEBHOOK_RETRY_MS: "100" };
const ASK = { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }, { label: "US" }] }] };

async function receiver(t: { after(fn: () => void): void }, status = 204) {
  const received: { headers: Record<string, any>; body: string; json: any }[] = [];
  const url = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ headers: req.headers, body, json: JSON.parse(body) });
    res.writeHead(status).end();
  });
  const find = (type: string, requestId?: string) => received.find(entry => entry.json.type === type && (requestId === undefined || entry.json.data?.requestId === requestId))?.json;
  return { url, received, find };
}

test("webhook endpoints: registered with the event types they want, managed, and each sent its events in a signed envelope", async t => {
  const hook = await receiver(t);
  const other = await receiver(t);
  const r = await runtime(t, (_body, index) => index === 0
    ? { ...toolCall("ask_user", ASK, "call_ask"), usage: { prompt_tokens: 100, completion_tokens: 10 } }
    : { role: "assistant", content: "Deploying to EU", usage: { prompt_tokens: 120, completion_tokens: 5 } }, LOCAL);

  for (const events of [["run.started", "nope"], [], ["run.started", "run.started"]]) {
    assert.equal((await r.call("/v1/webhooks", { body: { url: hook.url, events } })).status, 400, JSON.stringify(events));
  }
  assert.equal((await r.call("/v1/webhooks", { body: { url: "http://10.0.0.1/hook", events: ["run.started"] } })).status, 400, "the outbound guard applies");
  const lifecycle = ["run.started", "run.completed", "run.failed", "input.requested", "input.resolved"];
  const created = await r.call("/v1/webhooks", { body: { url: hook.url, events: lifecycle, description: "agents" } });
  assert.equal(created.status, 201, created.text);
  assert.match(created.json.id, /^we_/);
  assert.match(created.json.secret, /^whsec_/);
  const endpoint = created.json.id;
  const usageOnly = (await r.call("/v1/webhooks", { body: { url: other.url, events: ["usage.recorded"] } })).json;
  assert.deepEqual((await r.call("/v1/webhooks")).json.map((entry: any) => [entry.id, entry.events, entry.secret]), [[endpoint, lifecycle, undefined], [usageOnly.id, ["usage.recorded"], undefined]]);
  assert.equal((await r.call(`/v1/webhooks/${endpoint}`)).json.description, "agents");
  assert.equal((await r.call(`/v1/webhooks/${endpoint}`, { token: "other-operator-token-at-least-24-chars" })).status, 404, "another tenant's is not found");

  const definition = (await r.call("/v1/definitions", { body: { name: "Asker", builtins: ["ask_user"] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id as string;
  const metadata = { source: "automation", job: "deploy-42" };
  const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "Deploy it", requestId: "deploy-1", metadata } });
  assert.equal(accepted.status, 202, accepted.text);
  const started = await until(() => hook.find("run.started", "deploy-1"), "run.started");
  assert.deepEqual(Object.keys(started).sort(), ["created", "data", "id", "type"], "the envelope");
  assert.match(started.id, /^evt_/);
  assert.ok(Math.abs(started.created - Date.now() / 1000) < 60, "created is in Unix seconds");
  assert.deepEqual(started.data, { agentId: agent, requestId: "deploy-1", method: "prompt", metadata });
  const requested = await until(() => hook.find("input.requested", "deploy-1"), "input.requested");
  const inputId = requested.data.inputId;
  assert.deepEqual(requested.data, { agentId: agent, requestId: "deploy-1", inputId, toolCallId: "call_ask", kind: "question", expiresAt: requested.data.expiresAt });
  const paused = await until(() => hook.find("run.completed", "deploy-1"), "run.completed of the suspended turn");
  assert.deepEqual([paused.data.stopped, paused.data.inputIds, paused.data.metadata], ["input_required", [inputId], metadata]);
  assert.deepEqual([paused.data.usage.responses, paused.data.usage.input, paused.data.usage.output], [1, 100, 10]);

  const answered = await r.call(`/v1/agents/${agent}/inputs/${inputId}`, { body: { action: "accept", content: { answers: { "Which region?": "EU" } } } });
  const resume = answered.json.request.id;
  assert.deepEqual((await until(() => hook.find("input.resolved", "deploy-1"), "input.resolved")).data, { agentId: agent, requestId: "deploy-1", inputId, state: "answered" });
  const finished = await until(() => hook.find("run.completed", resume), "run.completed of the resumed turn");
  assert.equal(finished.data.method, "resume");
  const history = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.deepEqual([finished.data.replyIndex, finished.data.messageCount], [history.length - 1, history.length], "the final assistant message's index, and the history's length");
  assert.equal(history[finished.data.replyIndex].role, "assistant");
  assert.equal(finished.data.stopped, undefined);
  assert.deepEqual([finished.data.usage.responses, finished.data.usage.input, finished.data.usage.output], [1, 120, 5]);
  assert.equal(JSON.stringify(finished).includes("Deploying"), false, "ids and key facts, not the reply itself");

  // The usage-only endpoint gets usage, enveloped; the lifecycle one none of it.
  await r.call("/v1/usage");
  const usage = await until(() => other.find("usage.recorded", "deploy-1"), "usage.recorded");
  assert.deepEqual([usage.data.agentId, usage.data.kind, usage.data.input], [agent, "response", 100]);
  await until(() => hook.find("run.started", resume), "run.started of the resumed turn");
  for (const entry of hook.received) {
    const expected = signedHeaders(entry.headers["webhook-id"], entry.body, [created.json.secret], Number(entry.headers["webhook-timestamp"]) * 1000);
    assert.equal(entry.headers["webhook-signature"], expected["webhook-signature"]);
    assert.equal(entry.json.id, entry.headers["webhook-id"]);
    assert.ok(lifecycle.includes(entry.json.type), `only selected types: ${entry.json.type}`);
  }
  assert.equal(new Set(hook.received.map(entry => entry.json.id)).size, hook.received.length, "each event has its own id");
  assert.deepEqual(other.received.map(entry => entry.json.type), ["usage.recorded", "usage.recorded"]);

  // Updated, rotated and deleted.
  const updated = await r.call(`/v1/webhooks/${endpoint}`, { method: "PATCH", body: { events: ["run.failed"] } });
  assert.deepEqual([updated.json.url, updated.json.events, updated.json.description], [hook.url, ["run.failed"], "agents"]);
  const rotated = (await r.call(`/v1/webhooks/${endpoint}/secret`, { method: "POST" })).json.secret;
  assert.notEqual(rotated, created.json.secret);
  const before = hook.received.length;
  await r.prompt(agent, "Once more");
  await sleep(500);
  assert.equal(hook.received.length, before, "no run.completed or run.started once it selects run.failed alone");
  assert.equal((await r.call(`/v1/webhooks/${endpoint}`, { method: "DELETE" })).status, 200);
  assert.equal((await r.call(`/v1/webhooks/${endpoint}`)).status, 404);
});

test("a run that ends with an error is sent as run.failed", async t => {
  const hook = await receiver(t);
  const failing = await listen(t, (_req, res) => void res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "bad request: no such model" } })));
  const r = await runtime(t, () => ({}), { ...LOCAL, AGENT_BASE_URL: `${failing}/v1` });
  await r.call("/v1/webhooks", { body: { url: hook.url, events: ["run.completed", "run.failed"] } });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const done = await r.prompt(agent, "Hi");
  const failed = await until(() => hook.find("run.failed", done.id), "run.failed");
  assert.match(failed.data.error, /no such model|400/);
  assert.equal(hook.find("run.completed", done.id), undefined);
});

test("the usage webhook still works, apart from endpoints, and gets usage in its original body", async t => {
  const legacy = await receiver(t);
  const r = await runtime(t, () => ({ role: "assistant", content: "hi", usage: { prompt_tokens: 10, completion_tokens: 1 } }), LOCAL);
  const set = await r.call("/v1/usage-webhook", { method: "PUT", body: { url: legacy.url } });
  assert.match(set.json.secret, /^whsec_/);
  assert.equal((await r.call("/v1/usage-webhook", { method: "PUT", body: { url: legacy.url, events: ["run.started"] } })).status, 400, "it takes a URL alone");
  assert.deepEqual((await r.call("/v1/webhooks")).json, [], "and is not listed among endpoints");
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const done = await r.prompt(agent, "Hi");
  await r.call("/v1/usage");
  const [event] = await until(() => legacy.received.length && legacy.received, "the usage event");
  assert.equal(event.json.type, undefined, "no envelope");
  assert.deepEqual([event.json.agent, event.json.requestId, event.json.input], [agent, done.id, 10]);
  const expected = signedHeaders(event.headers["webhook-id"], event.body, [set.json.secret], Number(event.headers["webhook-timestamp"]) * 1000);
  assert.equal(event.headers["webhook-signature"], expected["webhook-signature"]);
  // With no endpoint for run events, its runs journal no mark for one.
  const journal = (await readFile(join(r.root, "client-sessions", `${agent}.journal.jsonl`), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual([...new Set(journal.map(record => record.t))], ["request"]);
  assert.equal(journal.some(record => record.record?.announce), false);
});

test("a run whose event could not be written when it ended has it written with the agent's next load or run, once", async t => {
  const hook = await receiver(t);
  const r = await runtime(t, () => ({ role: "assistant", content: "done" }), { ...LOCAL, AGENT_IDLE_MS: "1000" });
  await r.call("/v1/webhooks", { body: { url: hook.url, events: ["run.completed"] } });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const unloaded = () => until(async () => !(await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).running, "the idle agent to unload");

  await r.db.query("alter table webhook_deliveries rename to webhook_deliveries_away");
  const lost = await r.prompt(agent, "first");
  await sleep(300);
  await r.db.query("alter table webhook_deliveries_away rename to webhook_deliveries");
  assert.equal(hook.find("run.completed", lost.id), undefined);
  await unloaded();

  const next = await r.prompt(agent, "second");
  await until(() => hook.find("run.completed", lost.id) && hook.find("run.completed", next.id), "both runs' events");
  assert.equal(hook.find("run.completed", lost.id).data.replyIndex, 1);
  await unloaded();
  const third = await r.prompt(agent, "third");
  await until(() => hook.find("run.completed", third.id), "the third run's event");
  await sleep(500);
  assert.equal(hook.received.filter(entry => entry.json.data.requestId === lost.id).length, 1, "written once, not at every load");
});

test("runs of a tenant with no endpoint for run events write none, and journal no mark; an endpoint made on another node gets the next run's", async t => {
  const hook = await receiver(t);
  const c = await cluster(t);
  const model = await fakeModel(t, () => ({ role: "assistant", content: "ok" }));
  const env = { ...model.env, ...LOCAL, AGENT_SECRETS_KEY: randomBytes(32).toString("hex") };
  const a = await c.start("a", env);
  const b = await c.start("b", env);
  const call = (base: string, path: string, body?: unknown) => fetch(base + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(response => response.json() as Promise<any>);
  const agent = (await call(b.url, "/v1/agents", {})).id as string;
  const prompt = async (id: string) => {
    await call(b.url, `/v1/agents/${agent}/prompt`, { text: "hi", requestId: id });
    await until(async () => (await call(b.url, `/v1/agents/${agent}/requests/${id}`)).state === "completed", `request ${id}`);
  };
  // A usage-only endpoint is not one for run events.
  await call(a.url, "/v1/webhooks", { url: hook.url, events: ["usage.recorded"] });
  await prompt("quiet");
  assert.equal(Number((await c.db.query("select count(*) from usage_webhook_outbox where body->>'type' like 'run.%'")).rows[0].count), 0);

  // Made on A, while B had read that the tenant has none: B hears of it, and its next run is sent.
  await call(a.url, "/v1/webhooks", { url: hook.url, events: ["run.started", "run.completed"] });
  await sleep(300);
  await prompt("heard");
  await until(() => hook.find("run.completed", "heard") && hook.find("run.started", "heard"), "the next run's events");
  assert.equal(hook.find("run.completed", "quiet"), undefined);
});

test("in a rolling deploy, nodes of the previous release see only usage webhook deliveries, and their usage webhook changes take effect", async t => {
  const hook = await receiver(t, 500);
  const legacy = await receiver(t, 500);
  const moved = await receiver(t, 500);
  // Refused deliveries wait an hour, where the test can read them.
  const r = await runtime(t, () => ({ role: "assistant", content: "hi", usage: { prompt_tokens: 10, completion_tokens: 1 } }), { ...LOCAL, AGENT_USAGE_WEBHOOK_RETRY_MS: "3600000" });
  await r.call("/v1/webhooks", { body: { url: hook.url, events: ["run.completed", "usage.recorded"] } });
  await r.call("/v1/usage-webhook", { method: "PUT", body: { url: legacy.url } });
  // A node of the previous release moves the usage webhook, as its PUT did: in usage_webhooks alone.
  await r.db.query("update usage_webhooks set url = $1 where tenant = 'alice'", [moved.url]);
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const done = await r.prompt(agent, "Hi");
  await r.call("/v1/usage");
  await until(() => moved.received.length && hook.find("run.completed", done.id) && hook.find("usage.recorded", done.id), "every delivery attempted");
  assert.equal(legacy.received.length, 0, "sent where the usage webhook now points");
  // The previous release's outbox, which its nodes send from, holds usage webhook bodies alone.
  const bodies = (await r.db.query("select body from usage_webhook_outbox")).rows.map(row => row.body);
  assert.deepEqual(bodies.map(body => [body.type, body.requestId]), [[undefined, done.id]]);
});

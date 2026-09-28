import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { listen, OPERATOR, runtime, toolCall, until } from "./runtime-server.ts";
import { anthropic, gateway } from "./provider-fixtures.ts";
import { signedHeaders } from "../src/webhooks.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_USAGE_WEBHOOK_RETRY_MS: "100" };

test("each model response's usage is POSTed, signed, to the tenant's webhook: retried after a failure, and kept across a restart", async t => {
  // The receiver refuses until told otherwise.
  let accepting = false;
  const received: { headers: Record<string, any>; body: string; status: number }[] = [];
  const receiver = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const status = accepting ? 204 : 500;
    received.push({ headers: req.headers, body, status });
    res.writeHead(status).end();
  });
  // The first response reports its own cost, as OpenRouter does; the second does not.
  const respond = (_body: any, index: number) => index % 2 === 0
    ? { ...toolCall("js_exec", { code: "return 1" }, `call_${index}`), usage: { prompt_tokens: 1000, completion_tokens: 20, cost: 0.0123 } }
    : { role: "assistant", content: "done", usage: { prompt_tokens: 1100, completion_tokens: 5 } };
  const env = { ...LOCAL, AGENT_SECRETS_KEY: randomBytes(32).toString("hex") };
  const first = await runtime(t, respond, env);

  assert.equal((await first.call("/v1/usage-webhook", { method: "PUT", body: { url: "http://10.0.0.1/hook" } })).status, 400, "the outbound guard applies");
  const set = await first.call("/v1/usage-webhook", { method: "PUT", body: { url: `${receiver}/usage` } });
  assert.equal(set.status, 200, set.text);
  const secret = set.json.secret;
  assert.match(secret, /^whsec_/);
  assert.equal((await first.call("/v1/usage-webhook", { method: "PUT", body: { url: `${receiver}/usage` } })).json.secret, undefined, "the secret is shown once");
  assert.equal((await first.call("/v1/usage-webhook")).json.url, `${receiver}/usage`);

  await first.call("/v1/key-scopes/org_1/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or-org1", baseUrl: first.model.url } });
  const agent = (await first.call("/v1/agents", { body: { keyScope: "org_1", subject: "u_1", context: { org: "org_1" } } })).json.id;
  const accepted = await first.call(`/v1/agents/${agent}/prompt`, { body: { text: "Go", actor: "u_2" } });
  await until(async () => (await first.call(`/v1/agents/${agent}/requests/${accepted.json.id}`)).json.state === "completed", "the turn");
  // Reading usage writes it now, events included; both are refused at first.
  await first.call("/v1/usage");
  await until(() => new Set(received.map(entry => entry.headers["webhook-id"])).size === 2, "both events attempted");

  // The node stops with the events undelivered; the next one delivers them.
  first.child.kill("SIGTERM");
  await once(first.child, "exit");
  accepting = true;
  await runtime(t, respond, env, undefined, { databaseUrl: first.databaseUrl });
  await until(() => received.filter(entry => entry.status === 204).length === 2, "delivery after the restart");

  const delivered = received.filter(entry => entry.status === 204).map(entry => {
    const expected = signedHeaders(entry.headers["webhook-id"], entry.body, [secret], Number(entry.headers["webhook-timestamp"]) * 1000);
    assert.equal(entry.headers["webhook-signature"], expected["webhook-signature"], "signed with the tenant's secret");
    const body = JSON.parse(entry.body);
    assert.equal(body.id, entry.headers["webhook-id"]);
    return body;
  }).sort((a, b) => a.at - b.at);
  const failed = new Set(received.filter(entry => entry.status === 500).map(entry => entry.headers["webhook-id"]));
  assert.deepEqual(new Set(delivered.map(body => body.id)), failed, "the same events, retried");
  for (const body of delivered) {
    assert.deepEqual([body.tenant, body.agent, body.requestId, body.subject, body.actor, body.context, body.keyScope, body.provider, body.model, body.kind],
      ["alice", agent, accepted.json.id, "u_1", "u_2", { org: "org_1" }, "org_1", "openrouter", "openai/gpt-4o-mini", "response"]);
  }
  assert.deepEqual([delivered[0].input, delivered[0].output, delivered[0].cost], [1000, 20, { usd: 0.0123, source: "provider" }]);
  assert.equal(delivered[1].cost.source, "catalog");
  assert.ok(delivered[1].cost.usd > 0);
});

test("a rotated usage webhook secret signs beside the old one for a day, and removing the webhook stops events", async t => {
  const received: { headers: Record<string, any>; body: string }[] = [];
  const receiver = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ headers: req.headers, body });
    res.writeHead(200).end();
  });
  const r = await runtime(t, () => ({ role: "assistant", content: "hi", usage: { prompt_tokens: 10, completion_tokens: 1 } }), LOCAL);
  const old = (await r.call("/v1/usage-webhook", { method: "PUT", body: { url: receiver } })).json.secret;
  const rotated = (await r.call("/v1/usage-webhook/secret", { method: "POST" })).json.secret;
  assert.notEqual(rotated, old);
  const agent = (await r.call("/v1/agents", { body: {} })).json.id;
  await r.prompt(agent, "Hi");
  await r.call("/v1/usage");
  const [event] = await until(() => received.length && received, "the event");
  const signed = signedHeaders(event.headers["webhook-id"], event.body, [rotated, old], Number(event.headers["webhook-timestamp"]) * 1000);
  assert.equal(event.headers["webhook-signature"], signed["webhook-signature"]);

  assert.equal((await r.call("/v1/usage-webhook", { method: "DELETE" })).status, 200);
  assert.equal((await r.call("/v1/usage-webhook")).status, 404);
  await r.prompt(agent, "Again");
  await r.call("/v1/usage");
  const rows = await r.db.query("select count(*)::int as count from usage_webhook_outbox");
  assert.equal(rows.rows[0].count, 0);
});

test("calls through a tenant's own endpoint are sent too, named as the agent names its model", async t => {
  const received: any[] = [];
  const receiver = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.writeHead(200).end();
  });
  const endpoint = await gateway(t, () => anthropic([{ type: "text", text: "Via the endpoint." }], "end_turn", { input_tokens: 30, output_tokens: 4 }));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL, { tenants: { alice: { tokenSha256: sha(OPERATOR), modelEndpoints: { chiridion: { baseUrl: endpoint.url } } } } });
  await r.call("/v1/usage-webhook", { method: "PUT", body: { url: receiver } });
  const agent = (await r.call("/v1/agents", { body: { model: "chiridion/anthropic/claude-opus-5" } })).json.id;
  assert.equal((await r.prompt(agent, "Hi")).outcome.result.reply, "Via the endpoint.");
  await r.call("/v1/usage");
  const [event] = await until(() => received.length && received, "the event");
  assert.deepEqual([event.provider, event.model, event.input, event.output, event.cost], ["chiridion", "anthropic/claude-opus-5", 30, 4, { usd: 0, source: "catalog" }]);
});

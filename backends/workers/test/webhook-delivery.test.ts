import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { EndUserCredits } from "../src/end-user-credits.ts";
import { transaction, type Db } from "../src/postgres.ts";
import { enqueueEvents, signedHeaders, Subscribers, usageEvent, Webhooks, webhookEvent } from "../src/webhook-policy.ts";
import { testDatabase } from "./billing-database.ts";
import { TestOutbound, type Delivery } from "./webhook-outbound.ts";

// Service-level equivalents of tests/{webhooks,usage-webhooks,end-user-webhooks}.test.ts.
// Source HTTP/model/cluster bodies are explicitly excluded by webhook-policy-port.json.
async function fixture() {
  const { db } = await testDatabase();
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: {} }) });
  const accounts = new Accounts({ db, tenants, secretsKey: "ab".repeat(32) });
  const outbound = new TestOutbound();
  const subscribers = new Subscribers(db);
  const webhooks = new Webhooks({ db, accounts, outbound, subscribers, retryBaseMs: 60_000 });
  return { db, accounts, outbound, subscribers, webhooks };
}

function signature(delivery: Delivery, secrets: string[]) {
  const expected = signedHeaders(delivery.headers["webhook-id"], delivery.body, secrets, Number(delivery.headers["webhook-timestamp"]) * 1000);
  assert.equal(delivery.headers["webhook-signature"], expected["webhook-signature"]);
  assert.equal(delivery.json.id, delivery.headers["webhook-id"]);
  assert.equal(delivery.headers["content-type"], "application/json");
}

const count = async (db: Db, table: "webhook_deliveries" | "usage_webhook_outbox") => Number((await db.query(`select count(*) from ${table}`)).rows[0].count);
const modelUsage = (overrides = {}) => ({
  provider: "openrouter", model: "openai/gpt-4o-mini", timestamp: Date.now(),
  requestId: "request-1", identity: { subject: "u_1", context: { org: "org_1" } }, actor: "u_2", keyScope: "org_1",
  usage: { input: 1000, output: 20, providerCost: 0.0123, cost: { total: 0.001 } },
  ...overrides,
});

test("webhook endpoint policy preserves validation, tenant isolation, event selection and signed envelopes", async () => {
  const { db, webhooks, outbound } = await fixture();
  for (const events of [["run.started", "nope"], [], ["run.started", "run.started"]]) {
    await assert.rejects(webhooks.create("alice", { url: "http://127.0.0.1/hook", events }), (e: any) => e.status === 400);
  }
  await assert.rejects(webhooks.create("alice", { url: "http://10.0.0.1/hook", events: ["run.started"] }), (e: any) => e.status === 400);
  const lifecycle = ["run.started", "run.completed", "run.failed", "input.requested", "input.resolved"];
  const endpoint = await webhooks.create("alice", { url: "http://127.0.0.1/hook", events: lifecycle, description: "agents" }, "token-1");
  const usageOnly = await webhooks.create("alice", { url: "http://127.0.0.1/usage", events: ["usage.recorded"] });
  assert.match(endpoint.id, /^we_/);
  assert.match(endpoint.secret, /^whsec_/);
  assert.deepEqual((await webhooks.list("alice")).map((entry: any) => [entry.id, entry.events, entry.secret]), [[endpoint.id, lifecycle, undefined], [usageOnly.id, ["usage.recorded"], undefined]]);
  assert.equal((await webhooks.get("alice", endpoint.id)).description, "agents");
  await assert.rejects(webhooks.get("bob", endpoint.id), (e: any) => e.status === 404);
  assert.deepEqual(await webhooks.setBy("alice", "token-1"), [{ kind: "webhook", id: endpoint.id, url: endpoint.url }]);
  const stored = (await db.query("select secret from webhook_endpoints where id = $1", [endpoint.id])).rows[0].secret;
  assert.equal(JSON.stringify(stored).includes(endpoint.secret), false, "the signing secret is encrypted at rest");
  const started = webhookEvent("run.started", "alice", { agentId: "a", requestId: "r", method: "prompt", metadata: { source: "automation" } }, "run:a:r:started");
  const completed = webhookEvent("run.completed", "alice", { agentId: "a", requestId: "r", method: "prompt" }, "run:a:r:completed");
  await enqueueEvents(db, [started, completed]);
  await enqueueEvents(db, [started, completed]);
  assert.equal(await count(db, "webhook_deliveries"), 2, "replayed run records enqueue once per endpoint");
  await webhooks.send();
  assert.equal(outbound.deliveries.length, 2);
  for (const entry of outbound.deliveries) {
    signature(entry, [endpoint.secret]);
    assert.equal(entry.url, endpoint.url);
    assert.deepEqual(Object.keys(entry.json).sort(), ["created", "data", "id", "type"]);
    assert.ok(Math.abs(entry.json.created - Date.now() / 1000) < 60);
    assert.ok(lifecycle.includes(entry.json.type));
  }
  assert.equal(await count(db, "webhook_deliveries"), 0);
});

test("endpoint updates, rotation overlap, expiration and deletion preserve the source lifecycle", async () => {
  const { db, webhooks, outbound } = await fixture();
  const endpoint = await webhooks.create("alice", { url: "http://127.0.0.1/hook", events: ["run.started"], description: "agents" });
  const updated = await webhooks.update("alice", endpoint.id, { events: ["run.failed"] });
  assert.deepEqual([updated.url, updated.events, updated.description], [endpoint.url, ["run.failed"], "agents"]);
  const rotated = (await webhooks.rotate("alice", endpoint.id)).secret;
  assert.notEqual(rotated, endpoint.secret);
  await enqueueEvents(db, [webhookEvent("run.started", "alice", {}), webhookEvent("run.failed", "alice", {})]);
  await webhooks.send();
  assert.equal(outbound.deliveries.length, 1, "only the new selection receives events");
  signature(outbound.deliveries[0], [rotated, endpoint.secret]);
  await db.query("update webhook_endpoints set previous_until = $2 where id = $1", [endpoint.id, Date.now() - 1]);
  await enqueueEvents(db, [webhookEvent("run.failed", "alice", {})]);
  await webhooks.send();
  signature(outbound.deliveries[1], [rotated]);
  await enqueueEvents(db, [webhookEvent("run.failed", "alice", {})]);
  await webhooks.delete("alice", endpoint.id);
  assert.equal(await count(db, "webhook_deliveries"), 0, "deletion removes waiting deliveries");
  await assert.rejects(webhooks.get("alice", endpoint.id), (e: any) => e.status === 404);
  await webhooks.send();
  assert.equal(outbound.deliveries.length, 2);
});

test("Accounts commits usage and both outbox formats atomically, preserving costs and attribution", async () => {
  const { db, accounts, webhooks, outbound } = await fixture();
  const endpoint = await webhooks.create("alice", { url: "http://127.0.0.1/events", events: ["usage.recorded"] });
  const legacy = await webhooks.setUsageWebhook("alice", "http://127.0.0.1/legacy");
  assert.match(legacy.secret!, /^whsec_/);
  assert.equal((await webhooks.setUsageWebhook("alice", legacy.url)).secret, undefined, "the secret is shown once");
  await assert.rejects(transaction(db, async sql => {
    await accounts.recordUsageIn(sql, "alice", "agent-1", modelUsage());
    throw new Error("crash before commit");
  }), /crash before commit/);
  assert.equal(await count(db, "webhook_deliveries"), 0);
  assert.equal(await count(db, "usage_webhook_outbox"), 0);
  assert.equal(Number((await db.query("select count(*) from usage")).rows[0].count), 0);
  await transaction(db, sql => accounts.recordUsageIn(sql, "alice", "agent-1", modelUsage()));
  const bodies = (await db.query("select body from usage_webhook_outbox")).rows.map(row => row.body);
  assert.deepEqual(bodies.map(body => [body.type, body.requestId]), [[undefined, "request-1"]], "legacy outbox has flat usage bodies only");
  // A previous release changes this row directly. Delivery reads its latest destination.
  await db.query("update usage_webhooks set url = $1 where tenant = 'alice'", ["http://127.0.0.1/moved"]);
  await webhooks.send();
  const flat = outbound.deliveries.find(entry => entry.url.endsWith("/moved"))!;
  const envelope = outbound.deliveries.find(entry => entry.url.endsWith("/events"))!;
  signature(flat, [legacy.secret!]);
  signature(envelope, [endpoint.secret]);
  assert.equal(flat.json.type, undefined);
  assert.deepEqual([flat.json.tenant, flat.json.agent, flat.json.requestId, flat.json.subject, flat.json.actor, flat.json.context, flat.json.keyScope, flat.json.provider, flat.json.model, flat.json.kind],
    ["alice", "agent-1", "request-1", "u_1", "u_2", { org: "org_1" }, "org_1", "openrouter", "openai/gpt-4o-mini", "response"]);
  assert.deepEqual([flat.json.input, flat.json.output, flat.json.cost], [1000, 20, { usd: 0.0123, source: "provider" }]);
  assert.equal(envelope.json.type, "usage.recorded");
  assert.equal(envelope.json.data.agentId, "agent-1");
  assert.equal(await count(db, "usage_webhook_outbox"), 0);
});

test("failed delivery survives service restart, keeps its event id and obeys retry backoff", async () => {
  const { db, accounts, webhooks, outbound } = await fixture();
  const { secret } = await webhooks.setUsageWebhook("alice", "http://127.0.0.1/legacy");
  const response = usageEvent("alice", "agent-1", modelUsage())!;
  const compaction = usageEvent("alice", "agent-1", modelUsage({ kind: "compaction", usage: { input: 1100, output: 5, cost: { total: 0.0008 } } }))!;
  await enqueueEvents(db, [response, compaction]);
  outbound.respond = () => new Response(null, { status: 500 });
  await webhooks.send();
  assert.equal(outbound.deliveries.length, 2);
  const rows = (await db.query("select id, attempts, due, last_error from usage_webhook_outbox")).rows;
  assert.equal(rows.every(row => row.attempts === 1 && row.due > Date.now() + 50_000 && row.last_error === "HTTP 500"), true);
  await webhooks.send();
  assert.equal(outbound.deliveries.length, 2, "not retried before due");
  const restarted = new Webhooks({ db, accounts, outbound, retryBaseMs: 60_000 });
  outbound.respond = () => new Response(null, { status: 204 });
  await db.query("update usage_webhook_outbox set due = 0");
  await restarted.send();
  const delivered = outbound.deliveries.slice(2);
  assert.equal(delivered.length, 2);
  assert.deepEqual(new Set(delivered.map(entry => entry.json.id)), new Set(outbound.deliveries.slice(0, 2).map(entry => entry.json.id)), "the same events, retried");
  for (const entry of delivered) signature(entry, [secret!]);
  assert.deepEqual(delivered.map(entry => [entry.json.kind, entry.json.cost.source]).sort(), [["compaction", "catalog"], ["response", "provider"]]);
  assert.equal(await count(db, "usage_webhook_outbox"), 0);
});

test("legacy usage rotation signs both secrets for a day; custom provider names and removal are preserved", async () => {
  const { db, webhooks, outbound } = await fixture();
  const old = (await webhooks.setUsageWebhook("alice", "http://127.0.0.1/legacy")).secret!;
  const rotated = (await webhooks.rotateUsageWebhook("alice")).secret;
  const event = () => usageEvent("alice", "agent-1", modelUsage({ provider: "chiridion/anthropic", model: "claude-opus-5", usage: { input: 30, output: 4 } }))!;
  await enqueueEvents(db, [event()]);
  await webhooks.send();
  signature(outbound.deliveries[0], [rotated, old]);
  const body = outbound.deliveries[0].json;
  assert.deepEqual([body.provider, body.model, body.input, body.output, body.cost], ["chiridion", "anthropic/claude-opus-5", 30, 4, { usd: 0, source: "catalog" }]);
  await db.query("update usage_webhooks set previous_until = $1 where tenant = 'alice'", [Date.now() - 1]);
  await enqueueEvents(db, [event()]);
  await webhooks.send();
  signature(outbound.deliveries[1], [rotated]);
  await enqueueEvents(db, [event()]);
  assert.equal(await webhooks.deleteUsageWebhook("alice"), true);
  assert.equal(await webhooks.usageWebhook("alice"), undefined);
  await enqueueEvents(db, [event()]);
  assert.equal(await count(db, "usage_webhook_outbox"), 0);
});

test("concurrent senders claim a delivery once and a crashed sender's lease can be recovered", async () => {
  const { db, accounts, webhooks, outbound } = await fixture();
  await webhooks.create("alice", { url: "http://127.0.0.1/hook", events: ["run.completed"] });
  const completed = () => webhookEvent("run.completed", "alice", {});
  await enqueueEvents(db, [completed()]);
  let arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  outbound.respond = async () => { arrive(); await released; return new Response(null, { status: 204 }); };
  const active = webhooks.send();
  await arrived;
  const second = new Webhooks({ db, accounts, outbound });
  await second.send();
  assert.equal(outbound.deliveries.length, 1, "a second sender cannot claim an in-flight delivery");
  release();
  await active;
  outbound.respond = () => new Response(null, { status: 204 });
  await enqueueEvents(db, [completed()]);
  await db.query("update webhook_deliveries set attempts = 1, due = $1", [Date.now() + 60_000]);
  await second.send();
  assert.equal(outbound.deliveries.length, 1);
  await db.query("update webhook_deliveries set due = $1", [Date.now() - 1]);
  await second.send();
  assert.equal(outbound.deliveries.length, 2, "a lost sender's due lease is retried");
  assert.equal(await count(db, "webhook_deliveries"), 0);
  await enqueueEvents(db, [completed()]);
  await db.query("update webhook_deliveries set created_at = $1", [Date.now() - 3 * 24 * 60 * 60_000 - 1]);
  await second.send();
  assert.equal(outbound.deliveries.length, 2, "source three-day maximum delivery age is preserved");
  assert.equal(await count(db, "webhook_deliveries"), 0);
});

test("end-user balance and exhaustion events are committed with the debit and delivered signed", async () => {
  const { db, webhooks, outbound } = await fixture();
  const endpoint = await webhooks.create("alice", { url: "http://127.0.0.1/hook", events: ["end_user.balance.low", "end_user.credit.exhausted"] });
  const credits = new EndUserCredits(db);
  await credits.setSettings("alice", { enabled: true, lowBalance: 60_000 });
  await credits.post("alice", "person", { kind: "grant", amount: 100_000, key: "pay" });
  await credits.post("alice", "person", { kind: "spend", amount: 100_000, key: "purchase" });
  assert.equal(await count(db, "webhook_deliveries"), 2);
  await webhooks.send();
  const bodies = outbound.deliveries.map(entry => entry.json);
  assert.deepEqual(bodies.map(body => body.type).sort(), ["end_user.balance.low", "end_user.credit.exhausted"]);
  for (const entry of outbound.deliveries) signature(entry, [endpoint.secret]);
  assert.equal(bodies.find(body => body.type === "end_user.credit.exhausted").data.reason, "balance");
  assert.equal((await credits.get("alice", "person")).balance, 0);
});

test("subscriber cache ignores usage-only endpoints, invalidates on local change and fails open", async () => {
  const { db, webhooks, subscribers } = await fixture();
  assert.equal(await subscribers.runs("alice"), false);
  await webhooks.create("alice", { url: "http://127.0.0.1/usage", events: ["usage.recorded"] });
  assert.equal(await subscribers.runs("alice"), false);
  const endpoint = await webhooks.create("alice", { url: "http://127.0.0.1/hook", events: ["run.started"] });
  assert.equal(await subscribers.runs("alice"), true);
  await webhooks.delete("alice", endpoint.id);
  assert.equal(await subscribers.runs("alice"), false);
  const failing = new Subscribers({ ...db, query: async () => { throw new Error("database unavailable"); } });
  assert.equal(await failing.runs("alice"), true, "a read outage must not silently discard run events");
});

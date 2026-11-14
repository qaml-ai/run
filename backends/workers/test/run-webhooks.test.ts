import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pg from "pg";
import { stageInputMirror } from "../src/input-mirror.ts";
import { AgentWebhooks, stageWebhook } from "../src/run-webhooks.ts";
import { webhookEvent } from "../src/webhook-policy.ts";
import type { WebhookEnv } from "../src/webhooks.ts";

function fixture(t: TestContext) {
  const data = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value); },
    delete: async (key: string) => data.delete(key),
    list: async ({ prefix, limit }: { prefix: string; limit: number }) =>
      new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
    transaction: async (work: (tx: unknown) => Promise<void>) => work(storage),
  } as unknown as DurableObjectStorage;
  const statements: { text: string; values?: unknown[] }[] = [];
  let failWrite = false;
  t.mock.method(pg.Client.prototype, "connect", async () => {});
  t.mock.method(pg.Client.prototype, "end", async () => {});
  t.mock.method(pg.Client.prototype, "query", async (text: string, values?: unknown[]) => {
    statements.push({ text: text.trim(), values });
    if (text.includes("select count(*) as pending")) {
      return { rows: [{ pending: 1, oldest: 0, deliveries: ["delivery"], emails: [] }], rowCount: 1 };
    }
    if (failWrite && text.includes("insert into webhook_deliveries")) throw new Error("write failed");
    return { rows: [], rowCount: 0 };
  });
  const sendBatch = t.mock.fn(async () => {});
  const env = {
    API_TOKEN: "test-only", HYPERDRIVE: { connectionString: "postgres://fake/db" },
    WEBHOOKS: { sendBatch } as unknown as WebhookEnv["WEBHOOKS"],
  };
  return {
    data, storage, statements, sendBatch, webhooks: new AgentWebhooks(storage, env),
    failWrites: () => { failWrite = true; },
  };
}

test("a batch without mirrors writes both outboxes in one statement", async t => {
  const { storage, statements, sendBatch, webhooks } = fixture(t);
  const legacy = {
    id: "00000000-0000-4000-a000-000000000001", tenant: "tenant", agent: "agent",
    requestId: "request", subject: "subject", actor: null, context: {}, keyScope: null,
    provider: "provider", model: "model", kind: "response" as const,
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
    cost: { usd: 0, source: "provider" as const }, at: 1,
  };
  const event = { ...webhookEvent("usage.recorded", "tenant", { requestId: "request" }), legacy };
  await stageWebhook(storage, event);
  await webhooks.flush();

  assert.equal(statements.length, 2);
  assert.match(statements[0].text, /^with deliveries as/);
  assert.match(statements[0].text, /insert into webhook_deliveries[\s\S]*on conflict \(id\) do nothing/);
  const legacyInsert = statements[0].text.split("insert into usage_webhook_outbox ")[1];
  assert.match(legacyInsert, /where exists \(select 1 from usage_webhooks/);
  assert.doesNotMatch(legacyInsert, /on conflict/i);
  assert.deepEqual(statements[0].values?.slice(0, 2), [JSON.stringify([event]), JSON.stringify([legacy])]);
  assert.match(statements[1].text, /^select count\(\*\) as pending/);
  assert.equal(sendBatch.mock.callCount(), 1);
});

test("a batch with an input mirror writes the mirror and event in one transaction", async t => {
  const { data, storage, statements, webhooks } = fixture(t);
  await stageInputMirror(storage, {
    id: "input", agent: "agent", requestId: "request", toolCallId: "tool", version: 1,
    kind: "question", message: "Question", question: "Question", priority: "normal", blocking: true,
    attachments: undefined, links: undefined, recommendation: undefined, applyRecommendationOnExpiry: undefined,
    detail: {}, state: "pending", responders: {}, createdAt: 1, expiresAt: 2,
    tenant: "tenant", subject: null, audience: [], lineage: ["agent"],
  });
  const event = webhookEvent("input.requested", "tenant", { inputId: "input" });
  await stageWebhook(storage, event);
  await webhooks.flush();

  assert.deepEqual(statements.map(({ text }) => text.split(/\s+/).slice(0, 3).join(" ")), [
    "begin", "insert into agent_inputs", "insert into webhook_deliveries", "commit", "select count(*) as",
  ]);
  assert.deepEqual([...data.keys()], [`webhook-sent:${event.id}`]);
});

test("queued flushes publish once after both batches write", async t => {
  const { storage, statements, sendBatch, webhooks } = fixture(t);
  for (let index = 0; index < 101; index++) {
    await stageWebhook(storage, webhookEvent("run.started", "tenant", {}, `run:${index}`));
  }
  await Promise.all([webhooks.flush(), webhooks.flush()]);

  assert.deepEqual(statements.map(({ text }) => text.split(/\s+/, 1)[0]), ["with", "with", "select"]);
  assert.equal(sendBatch.mock.callCount(), 1);
});

test("an empty tail publishes for the preceding write but an empty chain never publishes", async t => {
  const { storage, statements, sendBatch, webhooks } = fixture(t);
  await stageWebhook(storage, webhookEvent("run.started", "tenant", {}));
  await Promise.all([webhooks.flush(), webhooks.flush()]);
  await webhooks.flush();

  assert.deepEqual(statements.map(({ text }) => text.split(/\s+/, 1)[0]), ["with", "select"]);
  assert.equal(sendBatch.mock.callCount(), 1);
});

test("a failed write keeps its intent and does not publish", async t => {
  const { data, storage, statements, sendBatch, webhooks, failWrites } = fixture(t);
  const event = webhookEvent("run.started", "tenant", {});
  await stageWebhook(storage, event);
  failWrites();
  await webhooks.flush();

  assert.equal(statements.length, 1);
  assert.match(statements[0].text, /^with deliveries as/);
  assert.deepEqual([...data], [[`webhook-pending:${event.id}`, event]]);
  assert.equal(sendBatch.mock.callCount(), 0);
});

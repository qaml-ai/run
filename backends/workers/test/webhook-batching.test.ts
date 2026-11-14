import { test } from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./billing-database.ts";
import { pendingDeliveries } from "../src/webhooks.ts";
import { AgentWebhooks, stageWebhook } from "../src/run-webhooks.ts";
import { usageEvent, webhookEvent } from "../src/webhook-policy.ts";

test("one delivery scan preserves due ordering, email selection and backlog", async () => {
  const { db } = await testDatabase();
  await db.query(`insert into webhook_endpoints(id,tenant,url,events,secret,created_at)
    values ('endpoint','tenant','https://example.com',array['run.started'],'{}',1)`);
  await db.query(`insert into webhook_deliveries(id,tenant,endpoint,body,due,created_at) values
    ('00000000-0000-4000-a000-000000000001','tenant','endpoint','{}',10,1),
    ('00000000-0000-4000-a000-000000000002','tenant','endpoint','{}',30,2)`);
  await db.query(`insert into usage_webhook_outbox(id,tenant,body,due,created_at)
    values ('00000000-0000-4000-a000-000000000003','tenant','{}',5,1)`);
  await db.query(`insert into idempotency_keys(tenant,key,fingerprint,status,body,content_type,created_at) values
    ('tenant','workers:email:pending','x',102,'{}','application/json',1),
    ('tenant','workers:email:sent','x',200,'{}','application/json',2)`);
  let queries = 0;
  const result = await pendingDeliveries({ query: (...args) => { queries++; return db.query(...args); } }, 20);
  assert.equal(queries, 1);
  assert.equal(Number(result.pending), 2);
  assert.equal(Number(result.oldest), 1);
  assert.deepEqual(result.deliveries, ['00000000-0000-4000-a000-000000000003', '00000000-0000-4000-a000-000000000001']);
  assert.deepEqual(result.emails, ['workers:email:pending']);
});

test("a batch committed before a lost DO acknowledgement replays once per event", async () => {
  const { db, url } = await testDatabase();
  await db.query(`insert into usage_webhooks(tenant,url,secret,created_at)
    values ('tenant','https://example.com/legacy','{}',1)`);
  await db.query(`insert into webhook_endpoints(id,tenant,url,events,secret,created_at) values
    ('endpoint','tenant','https://example.com',array['run.started','run.completed','usage.recorded'],'{}',1),
    ('usage','tenant','https://example.com/usage',array['usage.recorded'],'{}',1)`);
  const data = new Map<string, unknown>();
  let loseAcknowledgement = true;
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value); },
    delete: async (key: string) => data.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...data].filter(([key]) => key.startsWith(prefix))),
    transaction: async (work: (tx: unknown) => Promise<void>) => {
      if (loseAcknowledgement) throw new Error("lost acknowledgement");
      await work(storage);
    },
  } as unknown as DurableObjectStorage;
  await stageWebhook(storage, webhookEvent('run.started', 'tenant', { requestId: 'r' }, 'start:r'));
  await stageWebhook(storage, webhookEvent('run.completed', 'tenant', { requestId: 'r' }, 'end:r'));
  const event = usageEvent('tenant', 'agent', { provider: 'openrouter', model: 'openai/gpt-4o-mini', usage: { input: 10, output: 2 } });
  assert.ok(event?.legacy);
  await stageWebhook(storage, event);
  const legacyRows = () => db.query('select id from usage_webhook_outbox').then(result => result.rows);
  const env = { HYPERDRIVE: { connectionString: url }, API_TOKEN: 'test-only' };
  await new AgentWebhooks(storage, env).flush();
  assert.equal(Number((await db.query('select count(*) from webhook_deliveries')).rows[0].count), 4);
  assert.deepEqual(await legacyRows(), [{ id: event.legacy.id }]);
  assert.equal([...data.keys()].filter(key => key.startsWith('webhook-pending:')).length, 3);
  loseAcknowledgement = false;
  await new AgentWebhooks(storage, env).flush();
  assert.equal([...data.keys()].filter(key => key.startsWith('webhook-pending:')).length, 0);
  assert.equal([...data.keys()].filter(key => key.startsWith('webhook-sent:')).length, 3);
  assert.equal(Number((await db.query('select count(*) from webhook_deliveries')).rows[0].count), 4);
  const deliveries = await db.query("select endpoint from webhook_deliveries where body->>'id' = $1 order by endpoint", [event.id]);
  assert.deepEqual(deliveries.rows, [{ endpoint: 'endpoint' }, { endpoint: 'usage' }]);
  assert.deepEqual(await legacyRows(), [{ id: event.legacy.id }]);
});

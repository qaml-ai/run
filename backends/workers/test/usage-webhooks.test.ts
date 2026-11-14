// Ported from tests/usage-webhooks.test.ts. Included assertions and test bodies are unchanged.
// Only imports and the isolated Postgres fixture differ; see webhook-policy-port.json for ECS exclusions.
import { test } from "node:test";

import assert from "node:assert/strict";

import { once } from "node:events";

import { createHash, randomBytes } from "node:crypto";

import { testDatabase } from "./billing-database.ts";

import { transaction } from "../src/postgres.ts";

import { enqueueEvents, signedHeaders, usageEvent } from "../src/webhook-policy.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_USAGE_WEBHOOK_RETRY_MS: "100" };

test("replaying a committed usage batch leaves one legacy row and one delivery per endpoint", async () => {
  const { db } = await testDatabase();
  await db.query(`insert into usage_webhooks(tenant,url,secret,created_at)
    values ('alice','https://example.com/legacy','{}',1)`);
  await db.query(`insert into webhook_endpoints(id,tenant,url,events,secret,created_at) values
    ('first','alice','https://example.com/first',array['usage.recorded'],'{}',1),
    ('second','alice','https://example.com/second',array['usage.recorded'],'{}',1)`);
  const event = usageEvent("alice", "agent", { provider: "openrouter", model: "openai/gpt-4o-mini", usage: { input: 10, output: 2 } });
  assert.ok(event?.legacy);

  const enqueue = () => transaction(db, sql => enqueueEvents(sql, [event]));
  await enqueue();
  // The first transaction committed, but its caller lost the acknowledgement.
  await enqueue();

  const legacy = await db.query("select id from usage_webhook_outbox");
  assert.deepEqual(legacy.rows, [{ id: event.legacy.id }]);
  const deliveries = await db.query("select endpoint, body->>'id' as id from webhook_deliveries order by endpoint");
  assert.deepEqual(deliveries.rows, [{ endpoint: "first", id: event.id }, { endpoint: "second", id: event.id }]);
});

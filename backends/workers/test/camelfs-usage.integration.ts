import assert from "node:assert/strict";
import { test } from "node:test";
import { pollUsage, settleUsage } from "../src/camelfs/usage.ts";
import { meterBilling } from "../src/computers/meter-billing.ts";
import type { ComputerCharge } from "../src/computers/meter.ts";
import { HOSTS_PROVIDER } from "../src/jobs/host-pricing.ts";
import { testDatabase } from "./billing-database.ts";

import { config, event, page, tenant } from "./camelfs-usage-fixture.ts";

test("page and cursor commit together, and page and receipt replays charge just once past zero", async t => {
  const { db, url } = await testDatabase();
  const env = config(url);
  await db.query("insert into tenants(id,created_at,billing) values($1,$2,'prepaid')", [tenant, Date.now()]);
  await db.query("insert into credit_accounts(tenant,balance) values($1,1000)", [tenant]);

  const read = async () => ({
    cursor: (await db.query("select cursor from camelfs_usage_cursor")).rows,
    events: (await db.query("select event_id, settled_at from camelfs_usage_events order by event_id")).rows,
  });
  let reply = page([event], "page-1");
  let after = "";
  const poll = () => pollUsage(env, async (_env, request) => {
    assert.deepEqual(request, {
      method: "GET", path: "/v1/usage", query: { after, limit: 1000 }, claims: { sub: "runtime:usage", acc: "r" },
    });
    return reply;
  });

  // A failure writing the cursor occurs after the event insert inside the same transaction.
  await db.query("alter table camelfs_usage_cursor add constraint usage_test_cursor check (cursor <> 'page-1')");
  await assert.rejects(poll, { code: "23514" });
  assert.deepEqual(await read(), { cursor: [], events: [] });
  await db.query("alter table camelfs_usage_cursor drop constraint usage_test_cursor");
  await poll();
  assert.deepEqual(await read(), { cursor: [{ cursor: "page-1" }], events: [{ event_id: "vm:1", settled_at: null }] });

  // A crash before settlement leaves the journal and cursor committed. A repeated ID on the next page is ignored.
  after = "page-1";
  reply = page([{ ...event, seconds: 0 }, { ...event, eventId: "vm:2", to: event.from }], "page-2");
  await poll();
  assert.deepEqual(await read(), {
    cursor: [{ cursor: "page-2" }], events: [{ event_id: "vm:1", settled_at: null }, { event_id: "vm:2", settled_at: null }],
  });
  assert.deepEqual((await db.query("select body from camelfs_usage_events where event_id = 'vm:1'")).rows[0].body, event);
  const charge = meterBilling(env, HOSTS_PROVIDER).charge;
  const attempts: ComputerCharge[] = [];
  const log = t.mock.method(console, "error", () => {});
  await settleUsage(env, async input => {
    attempts.push(input);
    await charge(input);
    throw new Error("lost acknowledgement after charge commit");
  });
  assert.equal((await read()).events[0].settled_at, null);
  assert.equal(log.mock.calls.length, 1);
  assert.equal(JSON.parse(log.mock.calls[0].arguments[0]).type, "usage_charge_failed");

  await settleUsage(env, async input => { attempts.push(input); await charge(input); });
  assert.ok((await read()).events.every(row => row.settled_at));
  assert.deepEqual(attempts, Array(2).fill({
    tenant, agent: "workflow", kind: "workflow", id: "camelfs:vm:1", instance: "test-2vcpu-4096mib",
    startedAt: 1000, endedAt: 3500, seconds: 2.5, costUsd: 0.005,
  }));
  const receipts = await db.query(`select message->'_workersAuxiliary' as receipt from pi_usage_receipts where tenant=$1`, [tenant]);
  assert.deepEqual(receipts.rows, [{ receipt: {
    kind: "computer", callId: "computer:camelfs:vm:1", requestId: null, startedAt: 1000,
    costUsd: 0.005, provider: HOSTS_PROVIDER, model: "test-2vcpu-4096mib",
  } }]);
  after = "page-2";
  reply = page([], after);
  await poll();
  assert.deepEqual((await read()).cursor, [{ cursor: after }]);
  assert.equal((await db.query("select balance from credit_accounts where tenant=$1", [tenant])).rows[0].balance, -4000);
});

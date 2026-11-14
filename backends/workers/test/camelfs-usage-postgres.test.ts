import assert from "node:assert/strict";
import { test } from "node:test";
import { pollUsage, settleUsage } from "../src/camelfs/usage.ts";
import { testDatabase } from "./billing-database.ts";
import { config, event, page } from "./camelfs-usage-fixture.ts";

test("unbillable events are settled, counted and logged without charges", async t => {
  const { db, url } = await testDatabase();
  const env = config(url);
  const errors = t.mock.method(console, "error", () => {});
  const metrics = t.mock.method(console, "log", () => {});
  const warnings = t.mock.method(console, "warn", () => {});
  const events = [
    { ...event, eventId: "vm:1", payer: "not JSON" },
    { ...event, eventId: "vm:2", from: 1000.5 },
    { ...event, eventId: "vm:3", from: -1 },
    { ...event, eventId: "vm:4", to: 0 },
    { ...event, eventId: "vm:5", to: Number.MAX_SAFE_INTEGER + 1 },
    { ...event, eventId: "storage:1", type: "usage.storage", vm: undefined },
  ];
  const reasons = ["bad_payer", "bad_interval", "bad_interval", "bad_interval", "bad_interval", "unhandled_type:usage.storage"];
  await pollUsage(env, async () => page(events, "advanced", Date.now() - 301_000));
  const charge = t.mock.fn(async () => {});
  await settleUsage(env, charge);
  await settleUsage(env, charge);
  assert.equal(charge.mock.calls.length, 0);
  const { rows } = await db.query(`select event_id, settled_at is not null as settled, settle_error, unbillable_reason
    from camelfs_usage_events order by event_id`);
  assert.deepEqual(rows, events.map((item, i) => ({
    event_id: item.eventId, settled: true, settle_error: null, unbillable_reason: reasons[i],
  })).sort((a, b) => a.event_id.localeCompare(b.event_id)));
  const expected = events.map((item, i) => ({ type: "usage_unbillable", eventId: item.eventId, vm: item.vm ?? "", reason: reasons[i] }));
  assert.deepEqual(errors.mock.calls.map(call => JSON.parse(call.arguments[0])).sort((a, b) => a.eventId.localeCompare(b.eventId)),
    expected.sort((a, b) => a.eventId.localeCompare(b.eventId)));
  assert.deepEqual(metrics.mock.calls.map(call => {
    const line = JSON.parse(call.arguments[0]);
    assert.equal(line.type, "usage_unbillable");
    assert.equal(line.usage_unbillable, 1);
    assert.deepEqual(line._aws.CloudWatchMetrics[0].Dimensions, [["ServiceName", "reason"]]);
    assert.deepEqual(line._aws.CloudWatchMetrics[0].Metrics, [{ Name: "usage_unbillable", Unit: "Count" }]);
    return line.reason;
  }).sort(), [...reasons].sort());
  const lag = JSON.parse(warnings.mock.calls[0].arguments[0]);
  assert.equal(lag.type, "usage_poll_lag");
  assert.ok(lag.lagMs > 300_000);
  assert.equal((await db.query("select cursor from camelfs_usage_cursor")).rows[0].cursor, "advanced");
});

test("terminal charge refusals settle with an error and a transient failure can be retried", async t => {
  const { db, url } = await testDatabase();
  const env = config(url);
  const errors = t.mock.method(console, "error", () => {});
  const statuses = new Map([["vm:1", 404], ["vm:2", 409], ["vm:3", 503]]);
  await pollUsage(env, async () => page([...statuses.keys()].map(eventId => ({ ...event, eventId })), "page"));
  const settle = () => settleUsage(env, async charge => {
    const status = statuses.get(charge.id.slice("camelfs:".length));
    if (status) throw Object.assign(new Error("charge failed"), { status });
  });
  const rows = async () => (await db.query(`select event_id, settled_at is not null as settled, settle_error, unbillable_reason
    from camelfs_usage_events order by event_id`)).rows;
  await settle();
  const expected = [
    { event_id: "vm:1", settled: true, settle_error: "404", unbillable_reason: null },
    { event_id: "vm:2", settled: true, settle_error: "409", unbillable_reason: null },
    { event_id: "vm:3", settled: false, settle_error: null, unbillable_reason: null },
  ];
  assert.deepEqual(await rows(), expected);
  assert.deepEqual(errors.mock.calls.map(call => JSON.parse(call.arguments[0]).type),
    ["usage_charge_dropped", "usage_charge_dropped", "usage_charge_failed"]);
  statuses.clear();
  await settle();
  expected[2].settled = true;
  assert.deepEqual(await rows(), expected);
});

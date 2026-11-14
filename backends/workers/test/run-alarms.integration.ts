import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { startFixture } from "./fixture.ts";

async function fixture(t: TestContext) {
  const f = await startFixture({
    entrypoint: fileURLToPath(new URL("./alarm-entry.ts", import.meta.url)),
    vars: { PILOT_DB_PROFILE: "1" },
  });
  t.after(() => f.stop());
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(f.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json() as any;
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  };
  const receiptCount = async () => Number((await f.db.query("select count(*) n from usage_flushes")).rows[0].n);
  const waitForReceipt = async () => {
    for (let i = 0; i < 200; i++) {
      if (await receiptCount()) return;
      await delay(50);
    }
    assert.fail("accepted turn did not settle without a client poll");
  };
  return { f, call, receiptCount, waitForReceipt };
}

test("a tracked slow turn checks its admission limits between deadlines and settles without polling", { timeout: 60000 }, async t => {
  const { call, receiptCount, waitForReceipt } = await fixture(t);
  const { id } = await call("/v1/agents", { model: "test/echo" });
  await call(`/v1/agents/${id}/requests`, {
    id: "slow-tracked", method: "prompt", params: { text: "slow:6500:tracked completion" },
  });
  // Let any alarm armed before the tracker was attached finish.
  await delay(1700);
  const before = await call(`/experimental/agents/${id}/__test/alarm-state`);
  await delay(2200);
  const after = await call(`/experimental/agents/${id}/__test/alarm-state`);
  assert.ok(after.wakes > before.wakes, "the durable watchdog must remain armed for a crash");
  const queries = (state: any) => Object.values(state.profile.phases).reduce((sum: number, phase: any) => sum + phase.queries, 0);
  const idleQueries = queries(after) - queries(before);
  assert.equal(idleQueries, 0, `Postgres statements in ${after.wakes - before.wakes} watchdog wakes`);
  assert.equal(await receiptCount(), 0);
  await waitForReceipt();
  assert.equal(await receiptCount(), 1);
  const result = await call(`/v1/agents/${id}/requests/slow-tracked`);
  assert.equal(result.state, "completed");
  assert.equal(result.status, "completed");
});

test("a tracked model keeps its admission time limit when tenant policy changes", { timeout: 60000 }, async t => {
  const { f, call, waitForReceipt } = await fixture(t);
  const { id } = await call("/v1/agents", { model: "test/echo", runLimits: { maxSeconds: 60 } });
  await call(`/v1/agents/${id}/requests`, {
    id: "live-limit", method: "prompt", params: { text: "slow:4000:keeps its admitted time limit" },
  });
  let started = false;
  for (let i = 0; i < 100; i++) {
    if (Number((await f.db.query("select count(*) n from model_attempts where agent=$1", [id])).rows[0].n)) { started = true; break; }
    await delay(20);
  }
  assert.ok(started, "the provider call must start before the tenant limit changes");
  await delay(1200);
  await f.db.query("update tenants set limits=coalesce(limits,'{}'::jsonb) || '{\"maxRunSeconds\":1}'::jsonb where id=$1", ["camelrun-proto-local"]);
  await waitForReceipt();
  const result = await call(`/v1/agents/${id}/requests/live-limit`);
  assert.equal(result.status, "completed", JSON.stringify(result));
});

test("an interrupted result waiter re-arms durable settlement recovery", { timeout: 60000 }, async t => {
  const { call, waitForReceipt, receiptCount } = await fixture(t);
  const { id } = await call("/v1/agents", { model: "test/echo" });
  await call(`/experimental/agents/${id}/__test/fail-next-waiter`, {});
  await call(`/v1/agents/${id}/requests`, {
    id: "interrupted-waiter", method: "prompt", params: { text: "slow:1500:recover waiter" },
  });
  await waitForReceipt();
  assert.equal(await receiptCount(), 1);
  const observed = await call(`/experimental/agents/${id}/__test/alarm-state`);
  assert.ok(observed.wakes >= 1, "the durable alarm must replace the failed waiter");
  const result = await call(`/v1/agents/${id}/requests/interrupted-waiter`);
  assert.equal(result.status, "completed");
});

test("a tracked turn retains its elapsed-time deadline after a hard restart", { timeout: 60000 }, async t => {
  const { f, call, waitForReceipt, receiptCount } = await fixture(t);
  const { id } = await call("/v1/agents", { model: "test/echo", runLimits: { maxSeconds: 4 } });
  const started = Date.now();
  await call(`/v1/agents/${id}/requests`, {
    id: "restart-deadline", method: "prompt", params: { text: "slow:15000:must stop at deadline" },
  });
  for (let i = 0; i < 100; i++) {
    if (Number((await f.db.query("select count(*) n from model_attempts where agent=$1", [id])).rows[0].n)) break;
    await delay(20);
  }
  await f.restart({}, true);
  await waitForReceipt();
  assert.ok(Date.now() - started < 12000, "the restored deadline must interrupt the 15-second provider call");
  assert.equal(await receiptCount(), 1);
  const result = await call(`/v1/agents/${id}/requests/restart-deadline`);
  assert.equal(result.state, "completed");
  assert.equal(result.outcome.result.code, "turn_limit", JSON.stringify(result));
  assert.equal(Number((await f.db.query("select count(*) n from credit_holds")).rows[0].n), 0);
});

test("a deleted agent keeps retrying a committed receipt without charging twice", { timeout: 60000 }, async t => {
  const { f, call, waitForReceipt } = await fixture(t);
  const { id } = await call("/v1/agents", { model: "test/echo" });
  await call(`/experimental/agents/${id}/__test/crash-next-settlement`, {});
  await call(`/v1/agents/${id}/requests`, {
    id: "delete-with-receipt", method: "prompt", params: { text: "receipt survives deletion" },
  });
  await waitForReceipt();
  let state = await call(`/experimental/agents/${id}/__test/alarm-state`);
  assert.equal(state.pending, 1, "the committed receipt has not been acknowledged");
  const charges = await f.db.query("select count(*)::int n, sum(amount)::text total from credit_ledger where kind='usage'");
  await call(`/experimental/agents/${id}/__test/delete-before-billing-retry`, {});
  state = await call(`/experimental/agents/${id}/__test/alarm-state`);
  assert.ok(state.alarm, "deletion must not discard the financial retry alarm");
  for (let i = 0; i < 150 && state.pending; i++) {
    await delay(50);
    state = await call(`/experimental/agents/${id}/__test/alarm-state`);
  }
  assert.equal(state.pending, 0);
  assert.deepEqual((await f.db.query("select count(*)::int n, sum(amount)::text total from credit_ledger where kind='usage'")).rows, charges.rows);
});

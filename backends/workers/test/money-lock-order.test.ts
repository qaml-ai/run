// Every money transaction locks the tenant's balance row (credit_accounts) before the rows that hang off it: usage
// totals, the hour's usage entry, spend minutes, holds. These tests hold the balance lock as a turn receipt does
// (control.ts recordTurn), let a usage flush queue behind it, then touch the rows the flush would have locked first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { Accounts, applyUsageRows } from "../src/accounts.ts";
import { accrueUsage } from "../src/billing.ts";
import { transaction, type Db } from "../src/postgres.ts";
import { DEFAULT_PRICING, micros } from "../../../src/pricing.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./billing-database.ts";

const tenantsFile = { tenants: { payg: { tokenSha256: "0".repeat(64), apiKeys: {}, billing: "prepaid" } }, platformKeys: { anthropic: "fixture-platform-key" } };
const response = (cost: number) => ({ provider: "anthropic", model: "m", usage: { input: 10, output: 1, cost: { total: cost } }, platform: true });
const zero = { responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, platformResponses: 0, platformCost: 0 };

async function accountsOn(db: Db) {
  const tenants = new Tenants({ read: async () => JSON.stringify(tenantsFile) });
  await tenants.reload();
  return new Accounts({ tenants, db, pricing: DEFAULT_PRICING, publicUrl: "https://agents.example.test" });
}

/** Resolves once another connection of this schema has waited on a row lock for longer than deadlock_timeout. */
async function queued(db: Db, schema: string) {
  const timeout = (await db.query("select setting::int as ms from pg_settings where name = 'deadlock_timeout'")).rows[0].ms;
  for (let i = 0; i < 500; i++) {
    const waiting = (await db.query("select count(*)::int as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'", [schema])).rows[0].n;
    // Past deadlock_timeout the waiter's own deadlock check has run and found no cycle, so if one forms now, the
    // balance holder below is the transaction that finds it and fails: the outcome under test.
    if (waiting) return sleep(timeout + 500);
    await sleep(20);
  }
  throw new Error("the flush never queued behind the balance lock");
}

for (const shape of ["usage totals", "the hour's usage entry"] as const) {
  test(`a usage flush queues behind a held balance lock without holding ${shape}`, async () => {
    const { db, schema } = await testDatabase();
    const accounts = await accountsOn(db);
    await accounts.billing.post([{ tenant: "payg", kind: "grant", amount: micros(1), key: "grant:payg" }]);
    const day = new Date().toISOString().slice(0, 10);
    let locked!: () => void, proceed!: () => void;
    const holding = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { proceed = resolve; });
    // A turn receipt's order: balance row, the hour's usage entry, then the day's usage totals. No rerun, so a deadlock
    // this transaction detects fails the test instead of being retried away.
    const receipt = transaction(db, async sql => {
      await sql.query("select balance from credit_accounts where tenant = 'payg' for update");
      locked();
      await gate;
      if (shape === "the hour's usage entry") await accrueUsage(sql, [{ tenant: "payg", amount: 1_000, metadata: { tokens: 1_000 } }]);
      await applyUsageRows(sql, [{ tenant: "payg", day, model: "anthropic/m", ...zero, responses: 1 }]);
    }, { rerun: false });
    await holding;
    accounts.recordUsage("payg", "a", response(0.001));
    const flushed = accounts.flushUsage();
    await queued(db, schema);
    proceed();
    await receipt;
    await flushed;
    const balance = Number((await db.query("select balance from credit_accounts where tenant = 'payg'")).rows[0].balance);
    const ledger = Number((await db.query("select sum(amount) as sum from credit_ledger where tenant = 'payg'")).rows[0].sum);
    const charged = micros(0.001) + (shape === "the hour's usage entry" ? 1_000 : 0);
    assert.equal(balance, micros(1) - charged, "both charges land once");
    assert.equal(ledger, balance);
    const responses = Number((await db.query("select sum(responses) as n from usage where tenant = 'payg'")).rows[0].n);
    assert.equal(responses, 2);
  });
}

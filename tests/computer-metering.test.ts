import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { usageKind } from "../src/admin-accounts.ts";
import { postLedger } from "../src/billing.ts";
import { Computers } from "../src/computers/service.ts";
import { EndUserCredits, HOLD_MS } from "../src/end-user-credits.ts";
import { HttpError } from "../src/http.ts";
import { Outbound } from "../src/outbound.ts";
import { DEFAULT_PRICING, leaseCost, micros } from "../src/pricing.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";

const PER_HOUR = DEFAULT_PRICING.computerHour;
const cost = (seconds: number) => leaseCost(seconds, PER_HOUR);

async function fixture(options: { platform?: boolean; provider?: string; leaseSeconds?: number; balance?: number; payer?: { id: string; bucket: string } } = {}) {
  const { db } = await testDatabase();
  await db.query("insert into agents(id,tenant,header,revision,name,type,model) values ('a','payg','{}',1,'A','test','x'),('b','rich','{}',1,'B','test','x')");
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: {
    payg: { tokenSha256: createHash("sha256").update("payg").digest("hex"), apiKeys: {}, billing: "prepaid" },
    rich: { tokenSha256: createHash("sha256").update("rich").digest("hex"), apiKeys: {}, billing: "prepaid" },
  } }) });
  await tenants.reload();
  const accounts = new Accounts({ db, tenants, pricing: DEFAULT_PRICING, secretsKey: "ab".repeat(32) });
  const endUsers = new EndUserCredits(db);
  const fund = (tenant: string, amount: number, key: string) => postLedger(db, [{ tenant, kind: "purchase", amount, key }]);
  await fund("payg", options.balance ?? micros(10), "fund");
  await fund("rich", micros(10), "fund-rich");
  accounts.billing.invalidate(["payg", "rich"]);
  let now = Date.now(), closes = 0, closeFails = false, createFails = false;
  const service = new Computers({
    db, accounts, outbound: new Outbound(), now: () => now, endUsers, payer: () => options.payer,
    ...(options.platform === false ? {} : { platformLease: () => true }),
    driver: () => ({
      async create(id: string) { if (createFails) throw new Error("provider down"); return { id }; },
      async call() { return { exitCode: 0, stdout: "" }; },
      async close() { closes++; if (closeFails) throw new Error("provider unavailable"); },
    }),
  });
  const connect = (tenant: string, agent: string) => service.create(tenant, { agent, provider: (options.provider ?? "e2b") as any, credentials: { apiKey: "k" }, leaseSeconds: options.leaseSeconds ?? 900, dailySeconds: 86400 });
  await connect("payg", "a");
  const balance = async (tenant = "payg") => Number((await db.query("select balance from credit_accounts where tenant=$1", [tenant])).rows[0]?.balance ?? 0);
  const ledger = async (tenant = "payg") => (await db.query("select * from credit_ledger where tenant=$1 and kind='usage'", [tenant])).rows;
  const lease = async (agent = "a") => (await db.query("select * from computer_leases where agent=$1 order by sequence desc limit 1", [agent])).rows[0];
  const spent = async (tenant = "payg") => (tenant === "payg" ? options.balance ?? micros(10) : micros(10)) - await balance(tenant);
  const leaseCount = async () => Number((await db.query("select count(*)::int as n from computer_leases")).rows[0].n);
  const holds = async () => (await db.query("select * from end_user_holds")).rows;
  const start = (key = "start", agent = "a", tenant = "payg") => service.call(tenant, agent, "computer_start", {}, key);
  const stop = (key = "stop", agent = "a", tenant = "payg") => service.call(tenant, agent, "computer_stop", {}, key);
  return { db, accounts, endUsers, service, connect, start, stop, balance, ledger, lease, spent, leaseCount, holds, advance: (ms: number) => { now += ms; },
    closes: () => closes, closeFail: (value: boolean) => { closeFails = value; }, createFail: (value: boolean) => { createFails = value; }, invalidate: () => accounts.billing.invalidate(["payg", "rich"]) };
}

test("a sweep charges a running lease per second from credit, and a repeated or concurrent sweep charges nothing more", async () => {
  const f = await fixture();
  await f.start();
  await f.service.sweep();
  assert.equal(await f.spent(), 0, "nothing has run yet");

  f.advance(30_500);
  await f.service.sweep();
  assert.equal(await f.spent(), cost(30), "whole seconds; the half stays for the next sweep");
  await f.service.sweep();
  await Promise.all([f.service.sweep(), f.service.sweep(), f.service.sweep()]);
  assert.equal(await f.spent(), cost(30), "the same time is never charged twice");
  assert.equal(Number((await f.lease()).metered_seconds), 30);

  f.advance(29_500);
  await f.service.sweep();
  assert.equal(await f.spent(), cost(60));

  const [entry] = await f.ledger();
  assert.equal(Number(entry.amount), -cost(60));
  assert.deepEqual([entry.metadata.computer, entry.metadata.computerSeconds], [cost(60), 60]);
  assert.equal(entry.metadata.browser, undefined);
  await f.accounts.flushUsage();
  const usage = (await f.accounts.usage("payg", 0)).days;
  assert.deepEqual(usage.map(row => [row.kind, row.model, row.responses, row.platformResponses]), [["computer", "e2b/computer", 0, 0]]);
  assert.equal(usage[0].platformCost, cost(60) / 1e6);
  assert.deepEqual((await f.service.usage("payg")).map(row => [row.provider, row.sessions, row.costUsd]), [["e2b", 1, cost(60) / 1e6]]);
  assert.deepEqual((await f.db.query(`select ${usageKind()} as kind from usage u`)).rows, [{ kind: "compute" }], "not counted as model spend in admin reports");
  // Balance and ledger agree.
  assert.equal(Number((await f.db.query("select sum(amount) as sum from credit_ledger where tenant='payg'")).rows[0].sum), await f.balance());
});

test("charging in pieces comes to the same as charging the total, to the micro-USD", async () => {
  const f = await fixture();
  await f.start();
  for (const seconds of [1, 1, 1, 7, 13, 2, 11, 1, 29, 3]) {
    f.advance(seconds * 1000);
    await f.service.sweep();
  }
  assert.equal(await f.spent(), cost(69));
  assert.equal(cost(69), 2300);
});

test("an accrual that fails before it commits leaves nothing charged and nothing moved, and the next sweep catches up", async () => {
  const f = await fixture();
  await f.start();
  f.advance(30_000);
  const recordUsageIn = f.accounts.recordUsageIn;
  f.accounts.recordUsageIn = async function () { throw new Error("database refused"); };
  const logged: string[] = [], error = console.error;
  console.error = (line: string) => { logged.push(line); };
  try { await f.service.sweep(); } finally { console.error = error; f.accounts.recordUsageIn = recordUsageIn; }
  assert.equal(await f.spent(), 0);
  assert.equal(Number((await f.lease()).metered_seconds), 0);
  assert.equal(JSON.parse(logged[0]).type, "computer_meter_failed");

  await f.service.sweep();
  assert.equal(await f.spent(), cost(30));
});

test("an accrual whose commit went through but whose caller never heard does not charge again", async () => {
  const f = await fixture();
  await f.start();
  f.advance(30_000);
  const usageCommitted = f.accounts.usageCommitted;
  f.accounts.usageCommitted = async function () { throw new Error("connection lost after commit"); };
  const error = console.error;
  console.error = () => {};
  try { await f.service.sweep(); } finally { console.error = error; f.accounts.usageCommitted = usageCommitted; }
  assert.equal(await f.spent(), cost(30));
  await f.service.sweep();
  assert.equal(await f.spent(), cost(30));
});

test("a lease closed between sweeps pays for its last second, rounded up, and nothing after", async () => {
  const f = await fixture();
  await f.start();
  f.advance(30_000);
  await f.service.sweep();
  f.advance(12_200);
  await f.stop();
  assert.equal(await f.spent(), cost(43));
  assert.equal((await f.lease()).state, "closed");
  assert.equal(Number((await f.lease()).metered_seconds), 43);
  f.advance(600_000);
  await f.service.sweep();
  await f.stop("stop-again");
  assert.equal(await f.spent(), cost(43));
});

test("a lease whose cleanup keeps failing is not charged past the moment it was stopped", async () => {
  const f = await fixture();
  await f.start();
  f.advance(10_000);
  f.closeFail(true);
  await assert.rejects(f.stop(), /cleanup failed/);
  assert.equal(await f.spent(), cost(10));
  f.advance(300_000);
  await f.service.sweep();
  assert.equal(await f.spent(), cost(10), "the machine lingering is our cost, not the tenant's");
  f.closeFail(false);
  f.advance(1000);
  await f.service.sweep();
  assert.equal((await f.lease()).state, "closed");
  assert.equal(await f.spent(), cost(10));
});

test("time past a lease's expiry is never charged, however late the sweep", async () => {
  const f = await fixture({ leaseSeconds: 60 });
  await f.start();
  f.advance(40_000);
  await f.service.sweep();
  f.advance(5 * 3_600_000);
  await f.service.sweep();
  assert.equal(await f.spent(), cost(60));
  assert.equal((await f.lease()).state, "closed");
});

test("running out of credit mid-lease stops the lease within the sweep, with the overdraft of one sweep's time, and leaves other tenants alone", async () => {
  const f = await fixture({ balance: 500 });
  await f.connect("rich", "b");
  await f.start();
  await f.start("start-b", "b", "rich");
  f.advance(10_000);
  await f.service.sweep();
  assert.equal(await f.balance(), 500 - cost(10), "333 micro-USD spent, still in credit");
  assert.equal((await f.lease()).state, "active");

  f.advance(30_000);
  const logged: any[] = [], error = console.error;
  console.error = (line: string) => { logged.push(JSON.parse(line)); };
  try { await f.service.sweep(); } finally { console.error = error; }
  assert.equal(await f.balance(), 500 - cost(40), "the sweep's charge is posted though it overdraws");
  assert.ok(await f.balance() < 0);
  assert.equal((await f.lease()).state, "closed");
  assert.equal(f.closes(), 1);
  assert.deepEqual(logged.map(line => [line.type, line.tenant]), [["computer_credit_stop", "payg"]]);

  assert.equal((await f.lease("b")).state, "active");
  assert.equal(await f.spent("rich"), cost(40));
  f.advance(60_000);
  await f.service.sweep();
  assert.equal(await f.balance(), 500 - cost(40), "stopped means stopped");
});

test("a browser lease is priced and counted as a browser", async () => {
  const f = await fixture({ provider: "browser-use" });
  await f.start();
  f.advance(36_000);
  await f.service.sweep();
  assert.equal(await f.spent(), leaseCost(36, DEFAULT_PRICING.browserHour));
  assert.equal(await f.spent(), 1000);
  const [entry] = await f.ledger();
  assert.deepEqual([entry.metadata.browser, entry.metadata.browserSeconds, entry.metadata.computer], [1000, 36, undefined]);
  await f.accounts.flushUsage();
  assert.deepEqual((await f.accounts.usage("payg", 0)).days.map(row => [row.kind, row.model]), [["browser", "browser-use/browser"]]);
});

test("a lease's price is fixed at its start", async () => {
  const f = await fixture();
  await f.start();
  await f.db.query("update computer_leases set price_hour=$1", [micros(3.6)]);
  f.advance(10_000);
  await f.service.sweep();
  assert.equal(await f.spent(), 10_000);
  assert.equal((await f.service.usage("payg"))[0].costUsd, 0.01);
});

test("a metered tenant's end user has the whole lease held at its start, and pays what it cost, once, at the markup", async () => {
  const payer = { id: "u", bucket: "work" };
  const f = await fixture({ payer });
  await f.endUsers.setSettings("payg", { enabled: true, markupBps: 5_000 });
  await f.endUsers.post("payg", "u", { kind: "grant", amount: micros(1), key: "grant" });
  await f.start();

  const [hold] = await f.holds();
  assert.deepEqual([hold.end_user, hold.bucket, Number(hold.paid)], ["u", "work", leaseCost(900, PER_HOUR) * 1.5]);
  assert.equal((await f.lease()).hold, hold.id);

  f.advance(60_000);
  await f.service.sweep();
  assert.equal(await f.spent(), cost(60), "the tenant pays as it goes");
  assert.equal((await f.endUsers.get("payg", "u", ["work"])).balance, micros(1), "the user at the end");
  assert.equal((await f.holds()).length, 1);

  f.advance(30_000);
  await f.stop();
  assert.equal(await f.spent(), cost(90));
  const user = await f.endUsers.get("payg", "u", ["work"]);
  assert.equal(user.balance, micros(1) - cost(90) * 1.5);
  assert.equal(user.held, 0);
  assert.deepEqual(await f.holds(), []);
  assert.equal((await f.lease()).hold, null);
  const { entries } = await f.endUsers.ledger("payg", "u", {});
  const usage = entries.filter(entry => entry.kind === "usage");
  assert.equal(usage.length, 1);
  assert.deepEqual([usage[0].raw, usage[0].bucket, usage[0].metadata.call, usage[0].metadata.provider, usage[0].metadata.lease], [cost(90), "work", "computer", "e2b", (await f.lease()).id]);

  await f.service.sweep();
  assert.equal((await f.endUsers.get("payg", "u", ["work"])).balance, micros(1) - cost(90) * 1.5);
});

test("an end user who can't cover the whole lease is refused the start: no lease, no machine, no charge", async () => {
  const f = await fixture({ payer: { id: "poor", bucket: "work" } });
  await f.endUsers.setSettings("payg", { enabled: true });
  await f.endUsers.post("payg", "poor", { kind: "grant", amount: cost(900) - 1, key: "grant" });
  await assert.rejects(f.start(), (error: unknown) => error instanceof HttpError && error.status === 402 && error.code === "END_USER_CREDIT");
  assert.equal(await f.leaseCount(), 0);
  assert.deepEqual(await f.holds(), []);
  assert.equal(await f.spent(), 0);
});

test("an end user's hold outlives HOLD_MS while the lease runs", async () => {
  const f = await fixture({ payer: { id: "u", bucket: "work" } });
  await f.endUsers.setSettings("payg", { enabled: true });
  await f.endUsers.post("payg", "u", { kind: "grant", amount: micros(1), key: "grant" });
  await f.start();
  for (let elapsed = 0; elapsed < HOLD_MS + 60_000; elapsed += 30_000) {
    f.advance(30_000);
    await f.service.sweep();
  }
  const [hold] = await f.holds();
  assert.ok(Number(hold.expires_at) > Number((await f.lease()).metered_until), "still held");
});

test("a settlement that fails at stop is retried by the sweep, and posts once", async () => {
  const f = await fixture({ payer: { id: "u", bucket: "work" } });
  await f.endUsers.setSettings("payg", { enabled: true });
  await f.endUsers.post("payg", "u", { kind: "grant", amount: micros(1), key: "grant" });
  await f.start();
  f.advance(90_000);
  const settleHold = f.endUsers.settleHold;
  f.endUsers.settleHold = async function () { throw new Error("database refused"); };
  const error = console.error;
  console.error = () => {};
  try { await f.stop(); } finally { console.error = error; f.endUsers.settleHold = settleHold; }
  assert.equal((await f.lease()).state, "closed", "the machine goes all the same");
  assert.ok((await f.lease()).hold);

  await f.service.sweep();
  assert.equal((await f.endUsers.get("payg", "u", ["work"])).balance, micros(1) - cost(90));
  assert.equal((await f.lease()).hold, null);

  // Posted, but the hold was not cleared: the key keeps it from posting again.
  await f.db.query("update computer_leases set hold=gen_random_uuid()");
  await f.service.sweep();
  assert.equal((await f.endUsers.get("payg", "u", ["work"])).balance, micros(1) - cost(90));
  assert.equal((await f.lease()).hold, null);
});

test("a create that fails charges nobody and gives the hold back", async () => {
  const f = await fixture({ payer: { id: "u", bucket: "work" } });
  await f.endUsers.setSettings("payg", { enabled: true });
  await f.endUsers.post("payg", "u", { kind: "grant", amount: micros(1), key: "grant" });
  f.createFail(true);
  await assert.rejects(f.start(), /may have made a machine/);
  assert.equal((await f.lease()).state, "uncertain");
  assert.equal((await f.lease()).metered_until, null);
  f.advance(60_000);
  await f.service.sweep();
  assert.equal(await f.spent(), 0);
  assert.deepEqual(await f.holds(), []);
  assert.equal((await f.lease()).hold, null);
  assert.equal((await f.endUsers.get("payg", "u", ["work"])).balance, micros(1));
});

test("a lease on the tenant's own provider account is never charged or held", async () => {
  const f = await fixture({ platform: false, payer: { id: "u", bucket: "work" } });
  await f.endUsers.setSettings("payg", { enabled: true });
  await f.start();
  const lease = await f.lease();
  assert.deepEqual([lease.platform, lease.metered_until, lease.price_hour, lease.hold], [false, null, null, null]);
  assert.deepEqual(await f.holds(), []);
  f.advance(60_000);
  await f.service.sweep();
  // Not even with its meter columns set by hand.
  await f.db.query("update computer_leases set metered_until=$1, price_hour=120000", [Date.now()]);
  f.advance(60_000);
  await f.service.sweep();
  await f.stop();
  assert.equal(await f.spent(), 0);
  assert.deepEqual(await f.ledger(), []);
  await f.accounts.flushUsage();
  assert.deepEqual((await f.accounts.usage("payg", 0)).days, []);
  assert.equal((await f.service.usage("payg"))[0].costUsd, 0);
});

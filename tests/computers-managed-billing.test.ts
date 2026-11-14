import { test } from "node:test";
import assert from "node:assert/strict";
import { usageKind } from "../src/admin-accounts.ts";
import { HttpError } from "../src/http.ts";
import { micros } from "../src/pricing.ts";
import { HOUR, cost, fixture, pass, fund, USER } from "./computers-fixture.ts";

test("a pass charges what Boat reports since the last charge, and a repeated or concurrent pass charges nothing more", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  await pass(f);
  assert.equal(await f.spent(), 0, "nothing has run yet");
  f.advance(60_000);
  await pass(f);
  assert.equal(await f.spent(), cost(60_000));
  await pass(f);
  await Promise.all([pass(f), pass(f), pass(f)]);
  assert.equal(await f.spent(), cost(60_000));
  f.advance(60_000);
  await pass(f);
  assert.equal(await f.spent(), cost(120_000));

  const entry = (await f.db.query("select * from credit_ledger where tenant='payg' and kind='usage'")).rows[0];
  assert.deepEqual([Number(entry.amount), entry.metadata.computer, entry.metadata.computerSeconds], [-cost(120_000), cost(120_000), 60]);
  await f.accounts.flushUsage();
  const usage = (await f.accounts.usage("payg", 0)).days;
  assert.deepEqual(usage.map(day => [day.kind, day.model, day.responses]), [["computer", "boat/computer", 0]]);
  assert.deepEqual((await f.db.query(`select ${usageKind()} as kind from usage u`)).rows, [{ kind: "compute" }]);
  assert.deepEqual((await f.service.usage("payg")).map(line => [line.provider, line.sessions, line.costUsd]), [["boat", 1, cost(120_000) / 1e6]]);
  assert.equal(Number((await f.db.query("select sum(amount) as sum from credit_ledger where tenant='payg'")).rows[0].sum), await f.balance());
  f.done();
});

test("a charge that fails before it commits moves nothing and the next pass catches up; one whose caller didn't hear charges no more", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  f.advance(60_000);
  const recordUsageIn = f.accounts.recordUsageIn;
  f.accounts.recordUsageIn = async function () { throw new Error("database refused"); };
  await pass(f);
  f.accounts.recordUsageIn = recordUsageIn;
  assert.equal(await f.spent(), 0);
  assert.equal(Number((await f.row()).usage_micros), 0);
  assert.ok(f.logged.some(line => line.type === "computer_charge_failed"));
  const usageCommitted = f.accounts.usageCommitted;
  f.accounts.usageCommitted = async function () { throw new Error("lost after commit"); };
  await pass(f);
  f.accounts.usageCommitted = usageCommitted;
  assert.equal(await f.spent(), cost(60_000));
  await pass(f);
  assert.equal(await f.spent(), cost(60_000));
  f.done();
});

test("a new period starts the count over, and nothing is lost or charged twice around it", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  f.advance(60_000);
  await pass(f);
  f.rollover(new Date(f.now()).toISOString());
  f.advance(60_000);
  await pass(f);
  assert.equal(await f.spent(), cost(60_000) + cost(60_000));
  await pass(f);
  assert.equal(await f.spent(), 2 * cost(60_000));
  f.done();
});

test("the price scales what Boat reports: at cost by default, the operator's if set", async () => {
  const f = await fixture({ price: micros(0.036) });
  await f.connect();
  await f.start();
  f.advance(60_000);
  await pass(f);
  assert.equal(await f.spent(), 2 * cost(60_000));
  assert.equal(Number((await f.row()).charged_micros), 2 * cost(60_000));
  f.done();
});

test("out of credit mid-run: the charge posts though it overdraws, the machine stops at that pass, and other tenants are left alone", async () => {
  const f = await fixture({ balance: 50 });
  await f.connect();
  await f.connect("rich", "c");
  await f.start();
  await f.start("rich", "c", "start-c");
  f.advance(120_000);
  await pass(f);
  assert.equal(await f.balance(), 50 - cost(120_000));
  assert.ok(await f.balance() < 0);
  assert.ok((await f.row()).ended_at);
  assert.equal(f.state.removed.length, 1);
  assert.deepEqual(f.logged.filter(line => line.type === "computer_credit_stop").map(line => line.tenant), ["payg"]);
  assert.equal((await f.row("c")).ended_at, null);
  f.done();
});

test("a start refuses a spent balance and an account that never bought credit, with nothing created", async () => {
  const spent = await fixture({ balance: 1000 });
  await spent.connect();
  await spent.db.query("update credit_accounts set balance = 0 where tenant = 'payg'");
  await assert.rejects(spent.start(), (error: unknown) => error instanceof HttpError && error.status === 402 && error.code === "INSUFFICIENT_CREDIT");
  assert.deepEqual(await spent.rows(), []);
  assert.equal(spent.state.creates, 0);
  spent.done();

  const free = await fixture({ purchased: false });
  await free.connect();
  await assert.rejects(free.start(), (error: unknown) => error instanceof HttpError && error.status === 403 && /bought credit/.test(error.message));
  assert.deepEqual(await free.rows(), []);
  free.done();

  const none = await fixture({ platformKey: false });
  await none.connect();
  await assert.rejects(none.start(), (error: unknown) => error instanceof HttpError && error.status === 503);
  assert.deepEqual(await none.rows(), []);
  none.done();
});

test("an internal account with no purchased credit starts, records usage without a debit, and keeps running", async () => {
  const f = await fixture({ billing: "none", purchased: false, balance: 0 });
  try {
    assert.equal(await f.accounts.billing.spendable("payg", f.db), 0);
    await f.connect();
    await f.start();
    assert.equal(f.state.creates, 1);
    assert.equal((await f.row()).platform, true);
    f.advance(120_000);
    await pass(f);
    assert.equal((await f.row()).ended_at, null);
    assert.equal(await f.balance(), 0);
    assert.equal(Number((await f.db.query("select count(*) as n from credit_ledger where tenant='payg' and kind='usage'")).rows[0].n), 0);
    assert.equal(Number((await f.row()).charged_micros), cost(120_000));
    await f.stop();
    assert.equal(f.state.removed.length, 1);
  } finally { f.done(); }
});

test("an internal account refuses a computer at zero end-user credit and starts at one micro-dollar", async () => {
  const f = await fixture({ billing: "none", purchased: false, balance: 0, payer: USER });
  try {
    await f.endUsers.setSettings("payg", { enabled: true });
    await f.connect();
    await assert.rejects(f.start(), (error: unknown) => error instanceof HttpError && error.status === 402 && error.code === "END_USER_CREDIT");
    assert.equal(f.state.creates, 0);
    await fund(f, 1);
    await f.start("payg", "a", "funded-user");
    assert.equal(f.state.creates, 1);
    assert.equal((await f.row()).end_user, "u");
    await f.stop();
  } finally { f.done(); }
});

test("a computer debits the full interval and stops at the checkpoint when its user goes negative", async () => {
  const f = await fixture({ payer: USER });
  try {
    await fund(f, 1);
    await f.connect();
    await f.start();
    assert.equal((await f.row()).end_user, "u");
    f.advance(60_000);
    await pass(f);
    assert.ok((await f.row()).ended_at);
    assert.equal((await f.endUsers.get("payg", "u")).balance, 1 - cost(60_000));
    await pass(f);
    const usage = (await f.endUsers.ledger("payg", "u", { kinds: ["usage"] })).entries;
    assert.deepEqual(usage.map(entry => [entry.raw, entry.metadata.call, entry.metadata.provider]), [[cost(60_000), "computer", "boat"]]);
    await assert.rejects(f.start("payg", "a", "again"), (error: unknown) => error instanceof HttpError && error.code === "END_USER_CREDIT");
  } finally { f.done(); }
});

test("a metering transaction that fails retries the same cost once", async () => {
  const f = await fixture({ payer: USER });
  try {
    await fund(f);
    await f.connect();
    await f.start();
    f.advance(60_000);
    const debit = f.endUsers.debit;
    f.endUsers.debit = async () => { throw new Error("database refused"); };
    await pass(f);
    assert.equal(Number((await f.row()).charged_micros), 0);
    f.endUsers.debit = debit;
    await pass(f);
    await pass(f);
    assert.equal((await f.endUsers.get("payg", "u")).balance, micros(1) - cost(60_000));
  } finally { f.done(); }
});

test("a command keeps the computer for its idle time from now, up to 24 hours from its start, moving the machine's expiry", async () => {
  const f = await fixture({ payer: USER });
  await fund(f);
  await f.connect();
  await f.start();
  const started = Number((await f.row()).created_at);
  assert.equal(Number((await f.row()).deadline), started + 2 * HOUR);
  f.advance(30 * 60_000);
  await f.exec("soon");
  assert.deepEqual(f.state.extended, [], "more than half is left");
  f.advance(40 * 60_000);
  await pass(f);
  await f.exec("later");
  assert.equal(Number((await f.row()).deadline), f.now() + 2 * HOUR);
  assert.deepEqual(f.state.extended, [7200]);
  for (let elapsed = 70; elapsed < 22 * 60; elapsed += 90) { f.advance(90 * 60_000); await pass(f); await f.exec(`step-${elapsed}`); }
  f.advance(60 * 60_000);
  await f.exec("near-the-end");
  assert.equal(Number((await f.row()).deadline), started + 24 * HOUR, "never past its hard stop");

  f.done();
});

test("a refused user cannot extend the computer's deadline", async () => {
  const f = await fixture({ payer: USER });
  try {
    await fund(f);
    await f.connect();
    await f.start();
    const deadline = Number((await f.row()).deadline);
    await f.endUsers.post("payg", "u", { kind: "spend", amount: micros(1), key: "spend" });
    f.advance(65 * 60_000);
    await f.exec("no-extension");
    assert.equal(Number((await f.row()).deadline), deadline);
    assert.deepEqual(f.state.extended, []);
  } finally { f.done(); }
});

test("pieces add up to the total at any price, and a lower figure never charges or moves anything", async () => {
  const price = micros(0.0173);
  const f = await fixture({ price });
  await f.connect();
  await f.start();
  for (const seconds of [3, 7, 11, 2, 5, 13, 9, 1, 17, 4, 6, 8]) { f.advance(seconds * 1000); await pass(f); }
  const total = cost(86_000);
  assert.equal(await f.spent(), Math.round(total * price / micros(0.018)));
  assert.equal(Number((await f.row()).charged_micros), await f.spent());

  // Six decimals as Boat may send them, and the float they arrive as.
  const g = await fixture();
  await g.connect();
  await g.start();
  for (const dollars of [0.00029, 0.000291, 0.000583, 0.1, 0.100001]) { g.state.dollars = dollars; await pass(g); assert.equal(await g.spent(), Math.round(dollars * 1e6)); }

  g.state.dollars = 0.05;
  await pass(g);
  assert.equal(await g.spent(), 100001, "no negative charge");
  assert.equal(Number((await g.row()).usage_micros), 100001, "and the count stays where it was");
  g.state.dollars = 0.100002;
  await pass(g);
  assert.equal(await g.spent(), 100002);
  f.done();
  g.done();
});

test("a tenant at its monthly spend limit starts no computer, on the platform's key or its own, with nothing created", async () => {
  for (const adminKey of [false, true]) {
    const f = await fixture({ maxMonthlyCost: 0, adminKey });
    await f.connect();
    await assert.rejects(f.start(), (error: unknown) => error instanceof HttpError && error.status === 402 && error.code === "SPEND_LIMIT" && /monthly spend limit of \$0\.00/.test(error.message) && /Nothing was created or charged/.test(error.message));
    assert.deepEqual(await f.rows(), []);
    assert.equal(f.state.creates, 0);
    f.done();
  }
});

test("a running machine stops at the pass that finds its tenant at its monthly spend limit, though credit is left; other tenants are left alone", async () => {
  // Under the limit at the start; the first pass's charge reaches it.
  const f = await fixture({ maxMonthlyCost: cost(60_000) / 1_000_000 });
  await f.connect();
  await f.connect("rich", "c");
  await f.start();
  await f.start("rich", "c", "start-c");
  f.advance(120_000);
  await pass(f);
  assert.ok(await f.balance() > 0, "credit is left: the limit, not the balance, stops it");
  assert.ok((await f.row()).ended_at);
  assert.deepEqual(f.logged.filter(line => line.type === "computer_spend_limit_stop").map(line => [line.tenant, line.reason]), [["payg", "spend_limit"]]);
  assert.deepEqual(f.logged.filter(line => line.type === "computer_credit_stop"), []);
  assert.equal((await f.row("c")).ended_at, null);
  // Its agent hears why at its next start.
  await assert.rejects(f.start(undefined, undefined, "start-again"), (error: unknown) => error instanceof HttpError && error.code === "SPEND_LIMIT");
  f.done();
});

test("limits that cannot be read stop nothing: said as computer_limits_read_failed, not as a failed charge", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  const spendLimit = f.accounts.spendLimit;
  f.accounts.spendLimit = async function () { throw new Error("database unavailable"); };
  f.advance(60_000);
  await pass(f);
  f.accounts.spendLimit = spendLimit;
  assert.equal((await f.row()).ended_at, null, "still running");
  assert.deepEqual(f.logged.filter(line => line.type === "computer_limits_read_failed").map(line => line.tenant), ["payg"]);
  assert.deepEqual(f.logged.filter(line => line.type === "computer_charge_failed"), []);
  f.done();
});

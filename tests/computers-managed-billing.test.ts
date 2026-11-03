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

test("a start refuses credit that model calls hold all of, and an account that never bought credit, with nothing created", async () => {
  const held = await fixture({ balance: 1000 });
  await held.connect();
  await held.credit.reserve("payg", "11111111-1111-4111-8111-111111111111", 1000, 1000, held.now());
  await assert.rejects(held.start(), (error: unknown) => error instanceof HttpError && error.status === 402 && error.code === "INSUFFICIENT_CREDIT");
  assert.deepEqual(await held.rows(), []);
  assert.equal(held.state.creates, 0);
  held.done();

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
    assert.equal(await f.credit.available("payg", f.now()), 0);
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

test("internal accounts still reserve and enforce end-user credit", async () => {
  const f = await fixture({ billing: "none", purchased: false, balance: 0, payer: USER });
  try {
    await fund(f, 1);
    await f.connect();
    await assert.rejects(f.start(), (error: unknown) => error instanceof HttpError && error.status === 402);
    assert.equal(f.state.creates, 0);
    await f.endUsers.post("payg", "u", { kind: "grant", amount: micros(1), key: "enough" });
    await f.start("payg", "a", "funded-user");
    assert.equal(f.state.creates, 1);
    assert.equal((await f.holds()).length, 1);
    await f.stop();
  } finally { f.done(); }
});

test("an end user has the idle time held at the start, pays once when it ends, and a refused hold refuses the start", async () => {
  const f = await fixture({ payer: USER });
  await fund(f);
  await f.connect();
  await f.start();
  const [hold] = await f.holds();
  assert.equal(Number(hold.paid), Math.ceil(7200 * micros(0.018) / 3600));
  assert.equal((await f.row()).hold, hold.id);
  f.advance(60_000);
  await pass(f);
  assert.equal((await f.endUsers.get("payg", "u", ["work"])).balance, micros(1), "the tenant pays as it goes; the user at the end");
  await f.stop();
  const user = await f.endUsers.get("payg", "u", ["work"]);
  assert.deepEqual([user.balance, user.held], [micros(1) - cost(60_000), 0]);
  assert.equal((await f.row()).hold, null);
  const usage = (await f.endUsers.ledger("payg", "u", {})).entries.filter(entry => entry.kind === "usage");
  assert.deepEqual(usage.map(entry => [entry.raw, entry.metadata.call, entry.metadata.provider]), [[cost(60_000), "computer", "boat"]]);
  await pass(f);
  assert.equal((await f.endUsers.get("payg", "u", ["work"])).balance, micros(1) - cost(60_000));
  f.done();

  const poor = await fixture({ payer: USER });
  await fund(poor, 100);
  await poor.connect();
  await assert.rejects(poor.start(), (error: unknown) => error instanceof HttpError && error.status === 402 && error.code === "END_USER_CREDIT");
  assert.deepEqual([await poor.rows(), await poor.holds()], [[], []]);
  poor.done();
});

test("a settlement that fails is retried by the pass, and posts once", async () => {
  const f = await fixture({ payer: USER });
  await fund(f);
  await f.connect();
  await f.start();
  f.advance(60_000);
  const settleHold = f.endUsers.settleHold;
  f.endUsers.settleHold = async function () { throw new Error("database refused"); };
  await f.stop();
  f.endUsers.settleHold = settleHold;
  assert.ok((await f.row()).hold);
  await pass(f);
  assert.equal((await f.row()).hold, null);
  await f.db.query("update managed_computers set hold=gen_random_uuid()");
  await pass(f);
  assert.equal((await f.endUsers.get("payg", "u", ["work"])).balance, micros(1) - cost(60_000));
  f.done();
});

test("a command keeps the computer for its idle time from now, up to 24 hours from its start, moving the machine's own expiry and the end user's hold", async () => {
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
  const held = Number((await f.holds())[0].paid);
  assert.ok(held > Math.ceil(7200 * micros(0.018) / 3600), "more of the user's credit is held");
  for (let elapsed = 70; elapsed < 22 * 60; elapsed += 90) { f.advance(90 * 60_000); await pass(f); await f.exec(`step-${elapsed}`); }
  f.advance(60 * 60_000);
  await f.exec("near-the-end");
  assert.equal(Number((await f.row()).deadline), started + 24 * HOUR, "never past its hard stop");

  f.done();
});

test("a hold refused leaves the expiry as it is, says so, and the command still runs", async () => {
  const f = await fixture({ payer: USER });
  await fund(f, Math.ceil(7200 * micros(0.018) / 3600));
  await f.connect();
  await f.start();
  const deadline = Number((await f.row()).deadline);
  for (let minutes = 0; minutes < 61; minutes += 5) { f.advance(5 * 60_000); await pass(f); }
  assert.deepEqual(await f.exec("refused"), { exitCode: 0, stdout: "done", stderr: "", truncated: false });
  assert.equal(Number((await f.row()).deadline), deadline);
  assert.ok(f.logged.some(line => line.type === "computer_hold_refused"));
  f.done();
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

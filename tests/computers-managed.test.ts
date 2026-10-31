import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { usageKind } from "../src/admin-accounts.ts";
import { postLedger } from "../src/billing.ts";
import { signatures } from "../src/computers/abuse.ts";
import { boatMachines, BoatRefused, unitCommand, type Machine, type ManagedMachines } from "../src/computers/managed.ts";
import { Computers } from "../src/computers/service.ts";
import { CreditHolds } from "../src/credit-holds.ts";
import { EndUserCredits } from "../src/end-user-credits.ts";
import { HttpError } from "../src/http.ts";
import { Outbound } from "../src/outbound.ts";
import { DEFAULT_PRICING, micros } from "../src/pricing.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";

const HOUR = 3_600_000;
/** What Boat bills a small machine: a billable second every two seconds, at 1e-5 dollars each. */
const cost = (ms: number) => Math.floor(ms / 2000) * 10;

/** Boat as these tests need it: a machine per key, what it has cost by the clock, and refusals when told to refuse. */
function fakeBoat(clock: () => number) {
  const machines = new Map<string, { id: string; tenant: string; createdAt: number; since: string; ttlUntil: number }>();
  const state = { refusals: [] as { code: string; retryAfterMs?: number }[], loseAnswer: false, creates: 0, removed: [] as string[], extended: [] as number[], runs: [] as { command: string; timeoutSeconds: number }[], listFails: false, removeFails: false, stderr: "", hidden: new Set<string>(), dollars: undefined as number | undefined };
  let since = "2026-10-01T00:00:00.000Z";
  const expire = () => { for (const [key, machine] of machines) if (machine.ttlUntil <= clock()) machines.delete(key); };
  const boat: ManagedMachines = {
    async create(computer, tenant, ttlSeconds) {
      const refusal = state.refusals.shift();
      if (refusal) throw new BoatRefused(refusal);
      state.creates++;
      let machine = machines.get(computer);
      if (!machine) machines.set(computer, machine = { id: `bx_${machines.size + state.creates}`, tenant, createdAt: clock(), since, ttlUntil: clock() + ttlSeconds * 1000 });
      if (state.loseAnswer) { state.loseAnswer = false; throw new Error("the answer was lost"); }
      return { id: machine.id };
    },
    async extend(id, ttlSeconds) { state.extended.push(ttlSeconds); for (const machine of machines.values()) if (machine.id === id) machine.ttlUntil = clock() + ttlSeconds * 1000; },
    async remove(id) { if (state.removeFails) throw new Error("provider down"); state.removed.push(id); for (const [key, machine] of machines) if (machine.id === id) machines.delete(key); },
    async list(computer) {
      if (state.listFails) throw new Error("provider down");
      expire();
      return [...machines].filter(([key]) => computer ? key === computer : !state.hidden.has(key)).map(([key, machine]): Machine => {
        const start = Math.max(machine.createdAt, Date.parse(since) > machine.createdAt ? Date.parse(since) : 0);
        const micro = cost(clock() - start);
        return { id: machine.id, computer: key, tenant: machine.tenant, createdAt: machine.createdAt, since, seconds: micro / 10, dollars: state.dollars ?? micro / 1e6 };
      });
    },
    async run(_id, command, timeoutSeconds) { state.runs.push({ command, timeoutSeconds }); return { exitCode: 0, stdout: "done", stderr: state.stderr, truncated: false }; },
  };
  return { boat, state, machines, rollover: (at: string) => { since = at; } };
}

async function fixture(options: { flag?: boolean; platformKey?: boolean; adminKey?: boolean; purchased?: boolean; balance?: number; payer?: { id: string; bucket: string }; price?: number; extraAgents?: string[]; outbound?: any } = {}) {
  const { db } = await testDatabase();
  for (const [agent, tenant] of [["a", "payg"], ["b", "payg"], ["c", "rich"], ...(options.extraAgents ?? []).map(id => [id, "payg"])]) await db.query("insert into agents(id,tenant,header,revision,name,type,model) values ($1,$2,'{}',1,'A','test','x')", [agent, tenant]);
  const entry = (name: string, extra = {}) => ({ tokenSha256: createHash("sha256").update(name).digest("hex"), apiKeys: {}, billing: "prepaid", ...extra });
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { payg: entry("payg", options.adminKey ? { apiKeys: { boat: "admin-key" } } : {}), rich: entry("rich") }, platformKeys: options.platformKey === false ? {} : { boat: "platform-key" } }) });
  await tenants.reload();
  const accounts = new Accounts({ db, tenants, pricing: { ...DEFAULT_PRICING, ...options.price ? { computerHour: options.price } : {} }, secretsKey: "ab".repeat(32) });
  const endUsers = new EndUserCredits(db), credit = new CreditHolds(db, accounts.billing);
  const balanceAtStart = options.balance ?? micros(10);
  await postLedger(db, [options.purchased === false ? { tenant: "payg", kind: "grant", amount: balanceAtStart, key: "fund" } : { tenant: "payg", kind: "purchase", amount: balanceAtStart, key: "fund" }, { tenant: "rich", kind: "purchase", amount: micros(10), key: "fund-rich" }]);
  accounts.billing.invalidate(["payg", "rich"]);
  let now = Date.now();
  const { boat, state, machines, rollover } = fakeBoat(() => now);
  const keys: string[] = [], waits: number[] = [];
  const make = (flag: boolean) => new Computers({ db, accounts, outbound: options.outbound ?? new Outbound(), now: () => now, enabled: flag, runtime: "https://run.test", endUsers: () => endUsers, credit: () => credit, payer: () => options.payer, machines: options.outbound ? undefined : key => { keys.push(key); return boat; }, sleep: async ms => { waits.push(ms); },
    driver: () => ({ async create(id: string) { return { id }; }, async call() { return { exitCode: 0, stdout: "byo" }; }, async close() {} }) });
  const service = make(options.flag !== false);
  const logged: any[] = [], error = console.error;
  console.error = (line: string) => { try { logged.push(JSON.parse(line)); } catch { error(line); } };
  const row = async (agent = "a") => (await db.query("select * from managed_computers where agent=$1 order by ended_at is null desc, created_at desc limit 1", [agent])).rows[0];
  const rows = async () => (await db.query("select * from managed_computers")).rows;
  const balance = async (tenant = "payg") => Number((await db.query("select balance from credit_accounts where tenant=$1", [tenant])).rows[0]?.balance ?? 0);
  const spent = async (tenant = "payg") => (tenant === "payg" ? balanceAtStart : micros(10)) - await balance(tenant);
  const holds = async () => (await db.query("select * from end_user_holds")).rows;
  const connect = (tenant = "payg", agent = "a", input: Record<string, number> = {}, on = service) => on.create(tenant, { agent, provider: "boat", ...input });
  const start = (tenant = "payg", agent = "a", key = "start", on = service) => on.call(tenant, agent, "computer_start", {}, key);
  const stop = (tenant = "payg", agent = "a", key = "stop") => service.call(tenant, agent, "computer_stop", {}, key);
  const exec = (key: string, args: Record<string, unknown> = {}) => service.call("payg", "a", "computer_exec", { command: "make", ...args }, key);
  return { db, accounts, endUsers, credit, service, make, state, machines, rollover, keys, waits, logged, row, rows, balance, spent, holds, connect, start, stop, exec, advance: (ms: number) => { now += ms; }, now: () => now, done: () => { console.error = error; } };
}
const pass = (f: { service: Computers }) => f.service.managed.pass();
const fund = async (f: Awaited<ReturnType<typeof fixture>>, amount = micros(1)) => { await f.endUsers.setSettings("payg", { enabled: true }); await f.endUsers.post("payg", "u", { kind: "grant", amount, key: "grant" }); };
const USER = { id: "u", bucket: "work" };

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

test("stop reads the last of the cost, then deletes the machine, and charges nothing after", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  const { machine } = await f.row();
  f.advance(45_000);
  await f.stop();
  assert.equal(await f.spent(), cost(45_000));
  assert.deepEqual(f.state.removed, [machine]);
  assert.ok((await f.row()).ended_at);
  f.advance(HOUR);
  await pass(f);
  assert.equal(await f.spent(), cost(45_000));
  f.done();
});

test("a machine past its TTL ends by itself: its row ends at the next pass, and the time since the last charge is not charged", async () => {
  const f = await fixture({ payer: USER });
  await fund(f);
  await f.connect("payg", "a", { leaseSeconds: 300 });
  await f.start();
  f.advance(240_000);
  await pass(f);
  assert.equal(await f.spent(), cost(240_000));
  f.advance(120_000);
  await pass(f);
  assert.equal(await f.spent(), cost(240_000), "the last minute of a machine that is gone can't be read");
  assert.ok((await f.row()).ended_at);
  assert.deepEqual(f.state.removed, [], "nothing to delete");
  assert.deepEqual(await f.holds(), []);
  const user = await f.endUsers.get("payg", "u", ["work"]);
  assert.equal(user.balance, micros(1) - cost(240_000));
  await f.start("payg", "a", "again");
  assert.equal((await f.row()).ended_at, null);
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

test("a lost answer is the same machine: the next start finds it by its key, or the next pass by its label, and nothing is charged twice", async () => {
  const f = await fixture();
  await f.connect();
  f.state.loseAnswer = true;
  await assert.rejects(f.start(), (error: unknown) => error instanceof HttpError && error.status === 502 && /Call computer_start again/.test(error.message));
  const row = await f.row();
  assert.deepEqual([row.machine, row.ended_at], [null, null]);
  assert.equal(f.machines.size, 1);
  await f.start("payg", "a", "retry");
  assert.equal(f.machines.size, 1, "the same key: no second machine");
  assert.equal((await f.row()).id, row.id);
  assert.equal((await f.row()).machine, [...f.machines.values()][0].id);
  f.done();

  const g = await fixture();
  await g.connect();
  g.state.loseAnswer = true;
  await assert.rejects(g.start());
  g.advance(60_000);
  await pass(g);
  assert.equal((await g.row()).machine, [...g.machines.values()][0].id, "adopted from the listing");
  assert.equal(await g.spent(), cost(60_000));
  g.done();

  const h = await fixture();
  await h.connect();
  h.state.loseAnswer = true;
  await assert.rejects(h.start());
  h.machines.clear();
  h.advance(5 * 60_000);
  await pass(h);
  assert.equal((await h.row()).ended_at, null, "may still be coming");
  h.advance(6 * 60_000);
  await pass(h);
  assert.ok((await h.row()).ended_at);
  h.done();
});

test("two starts at once make one machine", async () => {
  const f = await fixture();
  await f.connect();
  await Promise.all([f.start("payg", "a", "one"), f.start("payg", "a", "two"), f.start("payg", "a", "three")]);
  assert.equal(f.machines.size, 1);
  assert.equal((await f.rows()).length, 1);
  f.done();
});

test("a listing that fails changes nothing, and a machine with no row is only said: not deleted", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  f.state.listFails = true;
  f.advance(HOUR);
  await f.service.sweep();
  assert.equal((await f.row()).ended_at, null);
  assert.ok(f.logged.some(line => line.type === "computer_pass_failed"));
  f.state.listFails = false;
  f.machines.set("cmp_other", { id: "bx_other", tenant: "payg", createdAt: f.now() - 20 * 60_000, since: "2026-10-01T00:00:00.000Z", ttlUntil: f.now() + HOUR });
  await pass(f);
  assert.deepEqual(f.logged.filter(line => line.type === "computer_leak").map(line => [line.computer, line.machine]), [["cmp_other", "bx_other"]]);
  assert.deepEqual(f.state.removed, []);
  f.done();
});

test("only this runtime's machines are listed, created with the key and labels that say so; another runtime's are never seen", async () => {
  const requests: { path: string; method: string; body?: any; headers?: any }[] = [];
  let processPolls = 0;
  const outbound = { fetch: async (url: string, init: any) => {
    const parsed = new URL(url), path = parsed.pathname.replace("/api/v1", "") + parsed.search, method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, headers: init.headers, ...body ? { body } : {} });
    if (path.startsWith("/sandboxes?")) return Response.json(parsed.searchParams.get("cursor")
      ? { sandboxes: [{ id: "b2", state: "idle", createdAt: "2026-10-31T00:00:00Z", labels: { computer: "cmp_2", tenant: "t2" }, cost: { since: "2026-10-01T00:00:00Z", seconds: 8, dollars: 0.00008 } }, { id: "old", state: "stopped", createdAt: "2026-10-31T00:00:00Z", labels: { computer: "cmp_3" } }], pageInfo: { hasMore: false } }
      : { sandboxes: Array.from({ length: 200 }, (_, i) => ({ id: i ? "elsewhere" : "b1", state: i ? "stopped" : "running", createdAt: "2026-10-31T00:00:00Z", labels: { computer: "cmp_1", tenant: "t1" }, cost: { since: "2026-10-01T00:00:00Z", seconds: 4, dollars: 0.00004 } })), pageInfo: { hasMore: true, nextCursor: "next" } });
    if (path.endsWith("/commands") && body.detached) return Response.json({ processId: "p1" });
    if (path.endsWith("/commands")) return Response.json({ exitCode: 0, stdout: "waited\u001b[3J", stderr: "TERM environment variable not set.\n" });
    if (path.endsWith("/commands/p1")) return Response.json(++processPolls < 2 ? { status: "running", running: true } : { status: "exited", running: false, exitCode: 3, stdout: "polled", stderr: "e" });
    return Response.json({ sandbox: { id: "bx_1", state: "provisioned" } });
  } } as any;
  const boat = boatMachines("k", outbound, "https://run.test", "apply-rules");
  assert.deepEqual(await boat.create("cmp_1", "payg", 7200), { id: "bx_1" });
  assert.deepEqual(requests[0].body.labels, { "camelrun-runtime": "https://run.test", computer: "cmp_1", tenant: "payg" });
  assert.equal(requests[0].headers["Idempotency-Key"], "cmp_1");
  assert.deepEqual([requests[0].body.type, requests[0].body.ttlSeconds, requests[0].body.snapshots, requests[0].body.noEnv], ["small", 7200, false, true]);
  assert.match(requests[1].body.command, /apply-rules/, "set up before anyone uses it");

  requests.length = 0;
  assert.deepEqual((await boat.list()).map(m => [m.id, m.computer, m.seconds, m.dollars]), [["b1", "cmp_1", 4, 0.00004], ["b2", "cmp_2", 8, 0.00008]]);
  assert.match(requests[0].path, /include=cost/);
  assert.equal(new URL(`https://x${requests[0].path}`).searchParams.get("label"), "camelrun-runtime=https://run.test");
  await boat.extend("bx_1", 7200);
  assert.deepEqual([requests.at(-1)!.method, requests.at(-1)!.body], ["PATCH", { ttlSeconds: 7200 }]);

  const waited = await boat.run("bx_1", "make", 590);
  assert.deepEqual([waited.stdout, waited.stderr], ["waited", ""], "what Boat's own shell adds on some machines isn't the command's");
  assert.equal(requests.at(-1)!.body.timeoutSeconds, 595, "its unit's own limit comes first");
  assert.match(requests.at(-1)!.body.command, /systemd-run/);
  const long = await boat.run("bx_1", "make", 1800);
  assert.deepEqual([long.exitCode, long.stdout, long.stderr], [3, "polled", "e"]);
});

test("Boat's refusals are read by code, a stored one's retry time from where Boat puts it", async () => {
  const answer = (status: number, body: unknown) => ({ fetch: async () => Response.json(body, { status }) }) as any;
  const f = await fixture();
  await f.connect();
  const refusal = async (status: number, body: unknown) => {
    const boat = boatMachines("k", answer(status, body), "r");
    return boat.create("cmp", "t", 60).then(() => assert.fail("should refuse"), error => (error as any).refused);
  };
  assert.deepEqual(await refusal(503, { code: "out_of_capacity" }), { code: "out_of_capacity" });
  assert.deepEqual(await refusal(429, { error: { code: "limit_reached" } }), { code: "limit_reached" });
  const limited = await refusal(429, { code: "rate_limited", error: { code: "rate_limited", details: { nextStartAt: new Date(Date.now() + 8000).toISOString() } } });
  assert.ok(limited.retryAfterMs > 5000 && limited.retryAfterMs <= 8000);
  assert.deepEqual(await refusal(401, {}), { code: "http_401" });
  assert.equal(await refusal(500, {}), undefined, "what it may have made isn't known");
  assert.equal(await refusal(503, { code: "something_new" }), undefined);
  f.done();
});

test("out_of_capacity is tried again briefly and logged each time; if it lasts, a clear error, nothing charged, the hold back, and the next start works", async () => {
  const f = await fixture({ payer: USER });
  await fund(f);
  await f.connect();
  const OUT = { code: "out_of_capacity" };
  f.state.refusals.push(OUT, OUT);
  await f.start();
  assert.deepEqual(f.waits, [5000, 10000]);
  assert.equal((await f.row()).ended_at, null);
  await f.stop();

  f.waits.length = 0;
  f.state.refusals.push(OUT, OUT, OUT);
  await assert.rejects(f.start("payg", "a", "lasting"), (error: unknown) => error instanceof HttpError && error.status === 503 && error.code === "COMPUTER_UNAVAILABLE" && error.details?.reason === "out_of_capacity" && /no machines free right now. Nothing was created or charged/.test(error.message));
  assert.ok((await f.row()).ended_at);
  assert.equal(Number((await f.row()).charged_micros), 0);
  assert.deepEqual(await f.holds(), []);
  assert.equal(f.logged.filter(line => line.type === "computer_unavailable" && line.code === "out_of_capacity").length, 5);
  await f.start("payg", "a", "next");
  assert.equal((await f.row()).ended_at, null);
  f.done();
});

test("rate_limited waits when Boat says it is soon and says when otherwise; limit_reached and billing_required don't wait", async () => {
  const f = await fixture();
  await f.connect();
  f.state.refusals.push({ code: "rate_limited", retryAfterMs: 8000 });
  await f.start("payg", "a", "soon");
  assert.deepEqual(f.waits, [8000]);
  await f.stop();
  f.state.refusals.push({ code: "rate_limited", retryAfterMs: 90_000 });
  await assert.rejects(f.start("payg", "a", "later"), (error: unknown) => error instanceof HttpError && error.status === 429 && /in about 90 seconds/.test(error.message));
  f.state.refusals.push({ code: "limit_reached" });
  await assert.rejects(f.start("payg", "a", "full"), (error: unknown) => error instanceof HttpError && error.status === 503 && /Too many computers are running/.test(error.message));
  f.state.refusals.push({ code: "billing_required" });
  await assert.rejects(f.start("payg", "a", "wallet"), (error: unknown) => error instanceof HttpError && error.status === 503 && /operator/.test(error.message));
  assert.deepEqual(f.waits, [8000]);
  f.done();
});

test("a connection needs no credentials, the flag gates it, and an admin's key is the tenant's to account for", async () => {
  const off = await fixture({ flag: false });
  await assert.rejects(off.connect(), (error: unknown) => error instanceof HttpError && error.status === 403);
  await off.db.query("insert into computer_connections(id,tenant,agent,provider,credentials,lease_seconds,daily_seconds,created_at,managed) values('c','payg','a','boat','{}',7200,86400,1,true)");
  assert.deepEqual(await off.service.tools("payg", "a"), []);
  await assert.rejects(off.start(), (error: unknown) => error instanceof HttpError && error.status === 403);
  assert.deepEqual(await off.rows(), []);
  off.done();

  const f = await fixture();
  const connection = await f.connect();
  assert.deepEqual([connection.provider, connection.managed, connection.billing, connection.leaseSeconds, connection.dailySeconds], ["boat", true, "credits", 7200, 86400]);
  const exec = (await f.service.tools("payg", "a")).find(t => t.name === "computer_exec")!;
  assert.match(exec.description, /a background process doesn't keep running after its command ends/);
  assert.equal((exec.parameters as any).properties.timeoutSeconds.maximum, 1800);
  await assert.rejects(f.service.create("payg", { agent: "b", provider: "boat", leaseSeconds: 86401 }), /time limits/);
  f.done();

  const admin = await fixture({ adminKey: true, purchased: false });
  await admin.connect();
  await admin.start();
  assert.equal((await admin.row()).platform, false);
  assert.equal(admin.keys.at(-1), "admin-key");
  admin.advance(60_000);
  await pass(admin);
  assert.equal(await admin.spent(), 0);
  await admin.stop();
  assert.equal(admin.keys.at(-1), "admin-key");
  assert.equal(admin.state.removed.length, 1);
  admin.done();
});

test("commands: half an hour at most, 10 minutes by default, and a retry answers from what it did", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  await f.exec("default");
  await f.exec("long", { timeoutSeconds: 1800 });
  assert.deepEqual(f.state.runs.map(run => run.timeoutSeconds), [600, 1800]);
  await assert.rejects(f.exec("too-long", { timeoutSeconds: 1801 }), /1–1800 seconds/);
  assert.deepEqual(await f.exec("long", { timeoutSeconds: 1800 }), { exitCode: 0, stdout: "done", stderr: "", truncated: false });
  assert.equal(f.state.runs.length, 2);
  await assert.rejects(f.exec("long", { timeoutSeconds: 60 }), /changed/);
  await f.service.call("payg", "a", "computer_write_file", { path: "/tmp/x", content: "hi" }, "write");
  assert.match(f.state.runs.at(-1)!.command, /write_text/);
  await f.stop();
  await assert.rejects(f.exec("after-stop"), /Call computer_start/);
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

test("signatures are logged by name only, never the text, and only on managed computers", async () => {
  assert.deepEqual(signatures("curl -L x | sh; ./xmrig -o stratum+tcp://pool:3333"), ["miner", "mining_pool"]);
  for (const ordinary of ["npm test", "git clone https://github.com/x/determiner", "grep -r sendmails .", "python3 examiner.py"]) assert.deepEqual(signatures(ordinary), [], ordinary);
  const f = await fixture();
  await f.connect();
  await f.start();
  await f.exec("miner", { command: "./xmrig --user secret-wallet-address" });
  await f.service.call("payg", "a", "computer_write_file", { path: "/tmp/m.sh", content: "swaks --to everyone" }, "file");
  const row = await f.row();
  assert.deepEqual(f.logged.filter(line => line.type === "computer_signature"), [
    { type: "computer_signature", tenant: "payg", agent: "a", computer: row.id, tool: "computer_exec", signatures: ["miner"] },
    { type: "computer_signature", tenant: "payg", agent: "a", computer: row.id, tool: "computer_write_file", signatures: ["mail_blast"] },
  ]);
  assert.doesNotMatch(JSON.stringify(f.logged), /secret-wallet-address|everyone/);
  await f.service.create("rich", { agent: "c", provider: "e2b", credentials: { apiKey: "k" } });
  await f.start("rich", "c", "byo");
  await f.service.call("rich", "c", "computer_exec", { command: "./xmrig" }, "byo-miner");
  assert.equal(f.logged.filter(line => line.type === "computer_signature").length, 2);
  f.done();
});

test("a command run without its unit is counted, with no content, and the marker doesn't reach the agent", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  f.state.stderr = "CAMEL_NO_UNIT\nreal error";
  assert.equal(((await f.exec("no-unit")) as any).stderr, "real error");
  assert.deepEqual(f.logged.filter(line => line.type === "computer_unit_fallback").map(line => line.tenant), ["payg"]);
  assert.match(unitCommand("it's make", 1800), /--property=RuntimeMaxSec=1803/);
  assert.match(unitCommand("it's make", 1800), /echo CAMEL_NO_UNIT >&2; timeout -k 2 1800 bash -lc 'it'"'"'s make'; fi$/);
  f.done();
});

test("the flag off stops every running managed computer at the next pass, charging up to then; a provider connection keeps running", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  await f.service.create("rich", { agent: "c", provider: "e2b", credentials: { apiKey: "k" } });
  await f.start("rich", "c", "byo");
  f.advance(60_000);
  const off = f.make(false);
  await off.sweep();
  assert.ok((await f.row()).ended_at);
  assert.equal(await f.spent(), cost(60_000));
  assert.equal((await f.db.query("select state from computer_leases where agent='c'")).rows[0].state, "active");
  assert.equal(f.logged.filter(line => line.type === "computer_kill_stop").length, 1);
  f.done();
});

test("the operator's stop gets every computer of an account, however many; with block no new one starts until lifted", async () => {
  const agents = Array.from({ length: 250 }, (_, i) => `agent-${i}`);
  const f = await fixture({ extraAgents: agents });
  for (const agent of agents) await f.connect("payg", agent);
  await f.connect("rich", "c");
  await f.db.query(`insert into managed_computers(id,tenant,agent,connection,platform,machine,deadline,created_at)
    select 'cmp_' || agent, 'payg', agent, id, true, 'bx_' || agent, $1::bigint, $2::bigint from computer_connections where tenant='payg'`, [f.now() + HOUR, f.now()]);
  await f.start("rich", "c", "start-c");
  const result = await f.service.managed.stopTenant("payg", "ops", true);
  assert.deepEqual(result, { stopped: 250, failed: 0, blocked: true });
  assert.equal((await f.db.query("select count(*)::int as n from managed_computers where tenant='payg' and ended_at is null")).rows[0].n, 0);
  assert.equal((await f.row("c")).ended_at, null);
  await assert.rejects(f.start("payg", "agent-0", "blocked"), (error: unknown) => error instanceof HttpError && error.status === 403 && /turned off for this account/.test(error.message));
  assert.equal(f.logged.filter(line => line.type === "computer_tenant_stopped").at(-1).by, "ops");
  assert.deepEqual(await f.service.managed.unblockTenant("payg"), { blocked: false });
  await f.start("payg", "agent-0", "after");
  f.done();
});

test("a failed delete: stop says so and can be retried, stop-all counts it and doesn't loop on it", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  f.state.removeFails = true;
  await assert.rejects(f.stop(), (error: unknown) => error instanceof HttpError && error.status === 502);
  assert.equal((await f.row()).ended_at, null);
  assert.deepEqual(await f.service.managed.stopTenant("payg", "ops", false), { stopped: 0, failed: 1, blocked: false });
  f.state.removeFails = false;
  await f.service.call("payg", "a", "computer_stop", {}, "stop-again");
  assert.ok((await f.row()).ended_at);
  f.done();
});

test("the API shows a managed session as a session, and disconnecting stops the machine", async () => {
  const f = await fixture();
  const connection = await f.connect();
  await f.start();
  const row = await f.row();
  const [listed] = await f.service.list("payg");
  assert.deepEqual([listed.session!.id, listed.session!.state, listed.session!.provider, listed.session!.recoveryRequired], [row.id, "active", "boat", false]);
  assert.equal((await f.service.status("payg", "a")).session!.expiresAt, Number(row.deadline));
  await f.service.remove("payg", connection.id);
  assert.deepEqual(f.state.removed, [row.machine]);
  assert.ok((await f.row()).ended_at);
  f.done();
});

test("a listing with a page that fails or falls short is no listing: nothing ends, even past 200 machines", async () => {
  const agents = Array.from({ length: 250 }, (_, i) => `agent-${i}`);
  const box = (i: number) => ({ id: `bx_${i}`, state: "idle", createdAt: "2026-10-31T00:00:00Z", labels: { computer: `cmp_agent-${i}`, tenant: "payg" }, cost: { since: "2026-10-01T00:00:00Z", seconds: 10, dollars: 0.0001 } });
  const whole = Array.from({ length: 250 }, (_, i) => box(i));
  let second: () => Response = () => new Response("", { status: 500 });
  const f = await fixture({ extraAgents: agents, outbound: { fetch: async (url: string) => {
    const cursor = new URL(url).searchParams.get("cursor");
    return cursor ? second() : Response.json({ sandboxes: whole.slice(0, 200), pageInfo: { hasMore: true, nextCursor: "page-2" } });
  } } });
  for (const agent of agents) await f.connect("payg", agent);
  await f.db.query(`insert into managed_computers(id,tenant,agent,connection,platform,machine,deadline,created_at)
    select 'cmp_' || agent, 'payg', agent, id, true, 'bx_' || agent, $1::bigint, $2::bigint from computer_connections where tenant='payg'`, [f.now() + HOUR, f.now()]);
  f.advance(10 * 60_000);
  const open = async () => Number((await f.db.query("select count(*)::int as n from managed_computers where ended_at is null")).rows[0].n);

  const broken: (() => Response)[] = [
    () => new Response("", { status: 500 }),
    () => new Response("", { status: 429 }),
    () => { throw new Error("connection lost"); },
    () => Response.json({ sandboxes: whole.slice(200) }), // no pageInfo
    () => Response.json({ pageInfo: { hasMore: false } }), // no machines at all
    () => Response.json({ sandboxes: whole.slice(200, 210), pageInfo: { hasMore: true, nextCursor: "page-3" } }), // short, with more to come
    () => Response.json({ sandboxes: whole.slice(0, 200), pageInfo: { hasMore: true } }), // more, but no way to it
    () => Response.json({ sandboxes: whole.slice(0, 200), pageInfo: { hasMore: true, nextCursor: "page-2" } }), // the same page again
    () => Response.json({ sandboxes: whole.slice(200).map(({ cost: _cost, ...rest }) => rest), pageInfo: { hasMore: false } }), // no costs
  ];
  for (const answer of broken) {
    second = answer;
    await assert.rejects(pass(f));
    assert.equal(await open(), 250);
  }
  assert.equal(await f.spent(), 0, "nothing charged from half a listing");

  second = () => Response.json({ sandboxes: whole.slice(200), pageInfo: { hasMore: false } });
  await pass(f);
  assert.equal(await open(), 250);
  assert.equal(await f.spent(), 250 * 100);
  f.done();
});

test("a row a listing misses ends only when a listing of that row alone agrees", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  const row = await f.row();
  f.advance(10 * 60_000);
  f.state.hidden.add(row.id);
  await pass(f);
  assert.equal((await f.row()).ended_at, null, "still there when asked by name");
  f.state.hidden.clear();
  f.machines.clear();
  await pass(f);
  assert.ok((await f.row()).ended_at);
  f.done();
});

test("an agent revoked, purged, expired or deleted takes its machine with it at the next pass, charged up to then; others keep theirs", async () => {
  const agents = ["gone-revoked", "gone-purged", "gone-expired", "gone-deleted", "stays"];
  const f = await fixture({ extraAgents: agents });
  for (const agent of agents) { await f.connect("payg", agent); await f.start("payg", agent, `start-${agent}`); }
  f.advance(60_000);
  await f.db.query("update agents set revoked=true where id='gone-revoked'");
  await f.db.query("update agents set purged_at=$1 where id='gone-purged'", [f.now()]);
  await f.db.query("update agents set expires_at=$1 where id='gone-expired'", [f.now() - 1]);
  await f.db.query("delete from agents where id='gone-deleted'");
  await pass(f);
  for (const agent of agents.slice(0, 4)) assert.ok((await f.row(agent)).ended_at, agent);
  assert.equal((await f.row("stays")).ended_at, null);
  assert.equal(f.state.removed.length, 4);
  assert.equal(await f.spent(), 5 * cost(60_000));
  assert.equal(f.logged.filter(line => line.type === "computer_agent_gone").length, 4);
  f.done();
});

test("a connection removed, or an account deleted, stops its machines; a failed stop is not removed and says so", async () => {
  const f = await fixture();
  const a = await f.connect("payg", "a");
  await f.connect("payg", "b");
  await f.start("payg", "a");
  await f.start("payg", "b", "start-b");
  f.advance(60_000);
  f.state.removeFails = true;
  await assert.rejects(f.service.remove("payg", a.id), (error: unknown) => error instanceof HttpError && error.status === 502);
  assert.equal((await f.row("a")).ended_at, null);
  f.state.removeFails = false;
  await f.service.removeTenant("payg");
  assert.ok((await f.row("a")).ended_at);
  assert.ok((await f.row("b")).ended_at);
  assert.equal(f.state.removed.length, 2);
  assert.equal(await f.spent(), 2 * cost(60_000));
  assert.deepEqual(await f.service.list("payg"), []);
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

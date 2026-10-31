import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { postLedger } from "../src/billing.ts";
import { driver as realDriver, unitCommand, type ComputerDriver, type Unavailable } from "../src/computers/providers.ts";
import { Computers } from "../src/computers/service.ts";
import { EndUserCredits } from "../src/end-user-credits.ts";
import { HttpError } from "../src/http.ts";
import { Outbound } from "../src/outbound.ts";
import { DEFAULT_PRICING, leaseCost, micros } from "../src/pricing.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";

const HOUR = 3_600_000;
class Refusal extends Error {
  readonly detail: Unavailable;
  constructor(detail: Unavailable) { super(detail.code); this.detail = detail; }
}
/** A database of `slots` connections, as a node's pool is, so waiting for a second one while holding one can hang. */
function pooled(db: any, slots: number) {
  let free = slots;
  const waiting: (() => void)[] = [];
  const take = () => free > 0 ? (free--, Promise.resolve()) : new Promise<void>(resolve => waiting.push(resolve));
  const give = () => { const next = waiting.shift(); if (next) next(); else free++; };
  return {
    held: () => slots - free,
    db: {
      async query(...args: any[]) { await take(); try { return await db.query(...args); } finally { give(); } },
      async connect() {
        await take();
        const client = await db.connect(), release = client.release.bind(client);
        client.release = (...args: any[]) => { release(...args); give(); };
        return client;
      },
    } as any,
  };
}

async function fixture(options: { flag?: boolean; platformKey?: boolean; adminKey?: boolean; purchased?: boolean; payer?: { id: string; bucket: string }; slots?: number; agents?: string[] } = {}) {
  const { db } = await testDatabase();
  const agents = options.agents ?? ["a"];
  for (const agent of agents) await db.query("insert into agents(id,tenant,header,revision,name,type,model) values ($1,'payg','{}',1,'A','test','x')", [agent]);
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: {
    payg: { tokenSha256: createHash("sha256").update("payg").digest("hex"), apiKeys: options.adminKey ? { boat: "admin-boat-key" } : {}, billing: "prepaid" },
  }, platformKeys: options.platformKey === false ? {} : { boat: "platform-boat-key" } }) });
  await tenants.reload();
  const accounts = new Accounts({ db, tenants, pricing: DEFAULT_PRICING, secretsKey: "ab".repeat(32) });
  const endUsers = new EndUserCredits(db);
  if (options.purchased !== false) await postLedger(db, [{ tenant: "payg", kind: "purchase", amount: micros(10), key: "fund" }]);
  else await postLedger(db, [{ tenant: "payg", kind: "grant", amount: micros(5), key: "grant" }]);
  accounts.billing.invalidate(["payg"]);
  let now = Date.now();
  const creates: Unavailable[] = [], refusals: Unavailable[] = [], keys: string[] = [], managedFlags: boolean[] = [], extended: number[] = [], waits: number[] = [], closes: string[] = [];
  const calls: any[] = [];
  let gate: Promise<void> | undefined;
  const fake: ComputerDriver = {
    unavailable: error => error instanceof Refusal ? error.detail : undefined,
    async extend(_ref, seconds) { extended.push(seconds); },
    async create(id: string) { const refusal = refusals.shift(); if (refusal) { creates.push(refusal); throw new Refusal(refusal); } return { id }; },
    async call(_ref, _op, args) { calls.push(args); await gate; return { exitCode: 0, stdout: "done" }; },
    async close(ref) { closes.push(ref.id); },
  };
  const pool = pooled(db, options.slots ?? 100);
  const service = new Computers({
    db: pool.db, accounts, outbound: new Outbound(), now: () => now, endUsers, payer: () => options.payer, managed: options.flag !== false, sleep: async ms => { waits.push(ms); },
    driver: (_provider, credentials, _outbound, driverOptions) => { keys.push(credentials.apiKey); managedFlags.push(!!driverOptions?.managed); return fake; },
  });
  const logged: any[] = [], error = console.error;
  console.error = (line: string) => { try { logged.push(JSON.parse(line)); } catch { error(line); } };
  const done = () => { console.error = error; };
  const lease = async (agent = "a") => (await db.query("select * from computer_leases where agent=$1 order by sequence desc limit 1", [agent])).rows[0];
  const leases = async () => Number((await db.query("select count(*)::int as n from computer_leases")).rows[0].n);
  const balance = async () => Number((await db.query("select balance from credit_accounts where tenant='payg'")).rows[0]?.balance ?? 0);
  const start = (key = "start", agent = "a") => service.call("payg", agent, "computer_start", {}, key);
  const exec = (key: string, args: Record<string, unknown> = {}) => service.call("payg", "a", "computer_exec", { command: "make", ...args }, key);
  return { db, accounts, endUsers, service, pool, start, exec, lease, leases, balance, done, logged, refusals, creates, keys, managedFlags, extended, waits, closes, calls, advance: (ms: number) => { now += ms; }, now: () => now,
    connect: (agent = "a", input: Record<string, number> = {}) => service.create("payg", { agent, provider: "boat", ...input }), block: () => { let open!: () => void; gate = new Promise<void>(resolve => { open = resolve; }); return () => { gate = undefined; open(); }; } };
}
const OUT = { code: "out_of_capacity" };

test("AGENT_MANAGED_COMPUTERS off: no managed connection, no start on an existing one, and its tools are gone", async () => {
  const f = await fixture({ flag: false });
  await assert.rejects(f.connect(), (error: unknown) => error instanceof HttpError && error.status === 403);
  await f.db.query("insert into computer_connections(id,tenant,agent,provider,credentials,lease_seconds,daily_seconds,created_at,managed) values('c','payg','a','boat','{}',7200,86400,1,true)");
  assert.deepEqual(await f.service.tools("payg", "a"), []);
  await assert.rejects(f.start(), (error: unknown) => error instanceof HttpError && error.status === 403);
  assert.equal(await f.leases(), 0);
  f.done();
});

test("a managed connection needs no credentials, defaults to two hours and a whole day, and bills to credit", async () => {
  const f = await fixture();
  const connection = await f.connect();
  assert.deepEqual([connection.provider, connection.managed, connection.billing, connection.leaseSeconds, connection.dailySeconds], ["boat", true, "credits", 7200, 86400]);
  const tools = await f.service.tools("payg", "a");
  const exec = tools.find(t => t.name === "computer_exec")!;
  assert.match(exec.description, /a background process doesn't keep running after its command ends/);
  assert.equal((exec.parameters as any).properties.timeoutSeconds.maximum, 1800);
  assert.equal(exec.timeoutMs, 1860_000);
  await assert.rejects(f.service.create("payg", { agent: "a", provider: "boat", leaseSeconds: 86401 }), /time limits/);
  f.done();
});

test("a start on the platform's key is charged at Boat's price with the platform's key; a machine that started bills from then", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  const lease = await f.lease();
  assert.deepEqual([lease.provider, lease.platform, Number(lease.price_hour), lease.state], ["boat", true, micros(0.018), "active"]);
  assert.deepEqual([f.keys, f.managedFlags], [["platform-boat-key"], [true]]);
  const before = await f.balance();
  f.advance(3_600_000);
  await f.service.sweep();
  assert.equal(before - await f.balance(), micros(0.018), "an hour of a small machine, at cost");
  f.done();
});

test("an admin's key for the tenant makes the computer the tenant's to account for: no charge, even on free credit", async () => {
  const f = await fixture({ adminKey: true, purchased: false });
  await f.connect();
  await f.start();
  const lease = await f.lease();
  assert.deepEqual([lease.platform, lease.price_hour, lease.metered_until], [false, null, null]);
  assert.equal(f.keys[0], "admin-boat-key");
  const before = await f.balance();
  f.advance(HOUR);
  await f.service.sweep();
  await f.service.call("payg", "a", "computer_stop", {}, "stop");
  assert.equal(await f.balance(), before);
  assert.deepEqual(f.keys.at(-1), "admin-boat-key", "closed with the key that made it");
  f.done();
});

test("an account that has never bought credit is refused on the platform's key, with nothing created", async () => {
  const f = await fixture({ purchased: false });
  await f.connect();
  await assert.rejects(f.start(), (error: unknown) => error instanceof HttpError && error.status === 403 && /bought credit/.test(error.message));
  assert.equal(await f.leases(), 0);
  f.done();
});

test("no key to run on: a clear refusal, with nothing created", async () => {
  const f = await fixture({ platformKey: false });
  await f.connect();
  await assert.rejects(f.start(), (error: unknown) => error instanceof HttpError && error.status === 503);
  assert.equal(await f.leases(), 0);
  f.done();
});

test("out_of_capacity is tried again briefly, and logged each time, then a start that succeeds bills only from then", async () => {
  const f = await fixture();
  await f.connect();
  f.refusals.push(OUT, OUT);
  await f.start();
  assert.deepEqual(f.waits, [5000, 10000]);
  assert.equal((await f.lease()).state, "active");
  assert.deepEqual(f.logged.filter(line => line.type === "computer_unavailable").map(line => [line.code, line.attempt, line.provider, line.tenant]), [["out_of_capacity", 0, "boat", "payg"], ["out_of_capacity", 1, "boat", "payg"]]);
  f.done();
});

test("out_of_capacity that lasts: a clear error, nothing charged, the hold back, and the next start works", async () => {
  const f = await fixture({ payer: { id: "u", bucket: "work" } });
  await f.endUsers.setSettings("payg", { enabled: true });
  await f.endUsers.post("payg", "u", { kind: "grant", amount: micros(1), key: "grant" });
  await f.connect();
  f.refusals.push(OUT, OUT, OUT);
  const before = await f.balance();
  await assert.rejects(f.start(), (error: unknown) => error instanceof HttpError && error.status === 503 && error.code === "COMPUTER_UNAVAILABLE" && /no machines free right now. Nothing was created or charged/.test(error.message) && error.details?.reason === "out_of_capacity");
  const lease = await f.lease();
  assert.deepEqual([lease.state, lease.metered_until, lease.hold, Number(lease.metered_seconds)], ["closed", null, null, 0]);
  assert.deepEqual((await f.db.query("select * from end_user_holds")).rows, []);
  assert.equal(await f.balance(), before);
  assert.equal(f.logged.filter(line => line.type === "computer_unavailable").length, 3);
  await f.start("start-again");
  assert.equal((await f.lease()).state, "active");
  f.done();
});

test("rate_limited waits when Boat says it is soon, and says when otherwise; limit_reached and billing_required don't wait", async () => {
  const f = await fixture();
  await f.connect();
  f.refusals.push({ code: "rate_limited", retryAfterMs: 8000 });
  await f.start("soon");
  assert.deepEqual(f.waits, [8000]);
  await f.service.call("payg", "a", "computer_stop", {}, "stop");

  f.refusals.push({ code: "rate_limited", retryAfterMs: 90_000 });
  await assert.rejects(f.start("later"), (error: unknown) => error instanceof HttpError && error.status === 429 && /in about 90 seconds/.test(error.message));
  f.refusals.push({ code: "limit_reached" });
  await assert.rejects(f.start("full"), (error: unknown) => error instanceof HttpError && error.status === 503 && /Too many computers are running/.test(error.message));
  f.refusals.push({ code: "billing_required" });
  await assert.rejects(f.start("wallet"), (error: unknown) => error instanceof HttpError && error.status === 503 && /operator/.test(error.message));
  assert.deepEqual(f.waits, [8000]);
  f.done();
});

test("a command may run half an hour, 10 minutes by default; a provider connection's stay at 2 minutes", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  await f.exec("default");
  await f.exec("long", { timeoutSeconds: 1800 });
  assert.deepEqual(f.calls.map(args => args.timeoutSeconds), [600, 1800]);
  await assert.rejects(f.exec("too-long", { timeoutSeconds: 1801 }), /1–1800 seconds/);
  f.done();

  const byo = await fixture();
  await byo.service.create("payg", { agent: "a", provider: "boat", credentials: { apiKey: "k" } });
  await byo.start();
  await assert.rejects(byo.exec("too-long", { timeoutSeconds: 121 }), /1–120 seconds/);
  await byo.exec("default");
  assert.equal(byo.calls[0].timeoutSeconds, 60);
  assert.equal(byo.managedFlags.at(-1), false);
  assert.equal(byo.keys.at(-1), "k");
  byo.done();
});

test("a command holds no connection while it runs, and the computer can be stopped under it", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  const open = f.block();
  const running = f.exec("long", { timeoutSeconds: 1800 });
  for (let i = 0; i < 200 && !f.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls.length, 1);
  assert.equal(f.pool.held(), 0, "nothing held while the command runs");
  assert.deepEqual(await f.service.call("payg", "a", "computer_stop", {}, "stop"), { stopped: true });
  assert.equal((await f.lease()).state, "closed");
  open();
  assert.deepEqual(await running, { exitCode: 0, stdout: "done" });
  // Its operation is recorded though it finished after the lock: a retry answers from it.
  assert.deepEqual(await f.exec("long", { timeoutSeconds: 1800 }), { exitCode: 0, stdout: "done" });
  assert.equal(f.calls.length, 1);
  f.done();
});

test("a provider connection's command still runs under the lock", async () => {
  const f = await fixture();
  await f.service.create("payg", { agent: "a", provider: "e2b", credentials: { apiKey: "k" } });
  await f.start();
  const open = f.block();
  const running = f.exec("one");
  for (let i = 0; i < 200 && !f.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.pool.held(), 1);
  open();
  await running;
  f.done();
});

test("many stops and starts at once finish on a small pool: nothing holds its lock waiting for a second connection", async () => {
  const agents = Array.from({ length: 12 }, (_, i) => `agent-${i}`);
  const f = await fixture({ agents, slots: 3, payer: { id: "u", bucket: "work" } });
  await f.endUsers.setSettings("payg", { enabled: true });
  await f.endUsers.post("payg", "u", { kind: "grant", amount: micros(1), key: "grant" });
  for (const agent of agents) await f.connect(agent);
  const within = <T>(work: Promise<T>) => Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the pool is stuck")), 30_000).unref())]);
  await within(Promise.all(agents.map(agent => f.start(`start-${agent}`, agent))));
  f.advance(30_000);
  const before = await f.balance();
  await within(Promise.all(agents.map(agent => f.service.call("payg", agent, "computer_stop", {}, `stop-${agent}`))));
  assert.equal(f.closes.length, 12);
  assert.equal(before - await f.balance(), 12 * leaseCost(30, micros(0.018)));
  assert.deepEqual((await f.db.query("select * from end_user_holds")).rows, []);
  assert.equal(f.pool.held(), 0);
  f.done();
});

test("a command keeps the computer for its idle time from now, up to 24 hours from its start, and moves the machine's own expiry", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  const started = Number((await f.lease()).created_at);
  assert.equal(Number((await f.lease()).expires_at), started + 2 * HOUR);

  // More than half is left: nothing to do.
  f.advance(30 * 60_000);
  await f.exec("soon");
  assert.equal(Number((await f.lease()).expires_at), started + 2 * HOUR);
  assert.deepEqual(f.extended, []);

  f.advance(40 * 60_000);
  await f.exec("later");
  assert.equal(Number((await f.lease()).expires_at), f.now() + 2 * HOUR);
  assert.deepEqual(f.extended, [7200]);

  for (let elapsed = 70 * 60_000; elapsed < 21.5 * HOUR; elapsed += 90 * 60_000) { f.advance(90 * 60_000); await f.exec(`step-${elapsed}`); }
  f.advance(60 * 60_000);
  await f.exec("near-the-end");
  assert.equal(Number((await f.lease()).expires_at), started + 24 * HOUR, "never past its hard stop");
  f.done();
});

test("left alone, it is released after its idle time and charged for no more", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  const before = await f.balance();
  f.advance(3 * HOUR);
  await f.service.sweep();
  assert.equal((await f.lease()).state, "closed");
  assert.deepEqual(f.closes.length, 1);
  assert.equal(before - await f.balance(), leaseCost(7200, micros(0.018)));
  f.done();
});

test("a longer stay holds more of the end user's credit, and if they can't cover it the computer keeps its expiry", async () => {
  const f = await fixture({ payer: { id: "u", bucket: "work" } });
  await f.endUsers.setSettings("payg", { enabled: true });
  await f.endUsers.post("payg", "u", { kind: "grant", amount: 2 * leaseCost(7200, micros(0.018)), key: "grant" });
  await f.connect();
  await f.start();
  const held = async () => Number((await f.db.query("select sum(paid)::bigint as paid from end_user_holds")).rows[0].paid);
  assert.equal(await held(), leaseCost(7200, micros(0.018)));

  f.advance(HOUR + 60_000);
  await f.service.sweep();
  await f.exec("extended");
  const extended = Number((await f.lease()).expires_at);
  assert.equal(extended, f.now() + 2 * HOUR);
  assert.ok(await held() > leaseCost(7200, micros(0.018)));

  // Past what they have left: refused, logged, and the command still runs.
  await f.db.query("update end_users set balance=0");
  f.advance(HOUR + 60_000);
  await f.service.sweep();
  assert.deepEqual(await f.exec("refused"), { exitCode: 0, stdout: "done" });
  assert.equal(Number((await f.lease()).expires_at), extended);
  assert.ok(f.logged.some(line => line.type === "computer_hold_refused"));
  f.done();
});

test("the unit a managed command runs in ends its background processes and its time, and works without sudo", () => {
  const command = unitCommand("it's make", 1800);
  assert.match(command, /systemd-run --quiet --wait --pipe --collect/);
  assert.match(command, /--property=RuntimeMaxSec=1803/);
  assert.match(command, /timeout -k 2 1800 bash -lc 'it'"'"'s make'; else timeout -k 2 1800 bash -lc 'it'"'"'s make'; fi$/);
});

test("the Boat driver: a managed command in its unit, a long one detached and polled, Boat's refusals by code, and the expiry moved", async () => {
  const requests: { path: string; method: string; body?: any }[] = [];
  let polls = 0;
  const answers: Record<string, () => Response> = {};
  const outbound = { fetch: async (url: string, init: any) => {
    const path = new URL(url).pathname.replace("/api/v1", ""), method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, ...(body ? { body } : {}) });
    if (answers[`${method} ${path}`]) return answers[`${method} ${path}`]();
    if (method === "POST" && path.endsWith("/commands")) return body.detached ? Response.json({ processId: "p1" }) : Response.json({ exitCode: 0, stdout: "waited", stderr: "" });
    if (method === "GET" && path.endsWith("/commands/p1")) return Response.json(++polls < 2 ? { status: "running", running: true } : { status: "exited", running: false, exitCode: 3, stdout: "polled", stderr: "e" });
    if (method === "PATCH") return Response.json({ ok: true });
    return Response.json({ sandbox: { id: "bx_1", state: "idle" } });
  } } as any;
  const d = await realDriver("boat", { apiKey: "k" }, outbound, { managed: true });

  assert.equal(((await d.call({ id: "bx_1" }, "computer_exec", { command: "make", timeoutSeconds: 590 })) as any).stdout, "waited");
  assert.equal(requests.at(-1)!.body.timeoutSeconds, 595, "its unit's own limit comes first");
  assert.match(requests.at(-1)!.body.command, /systemd-run/);

  const long: any = await d.call({ id: "bx_1" }, "computer_exec", { command: "make", timeoutSeconds: 1800 });
  assert.deepEqual([long.exitCode, long.stdout, long.stderr], [3, "polled", "e"]);
  assert.equal(requests.find(r => r.body?.detached)!.body.detached, true);

  await d.extend!({ id: "bx_1" }, 7200);
  assert.deepEqual(requests.at(-1), { path: "/sandboxes/bx_1", method: "PATCH", body: { ttlSeconds: 7200 } });

  const start = "POST /sandboxes";
  const refusedWith = async (status: number, body: unknown) => {
    answers[start] = () => Response.json(body, { status });
    return d.create("cmp_1", 7200).then(() => assert.fail("should refuse"), error => d.unavailable!(error));
  };
  assert.deepEqual(await refusedWith(503, { code: "out_of_capacity" }), { code: "out_of_capacity" });
  assert.deepEqual(await refusedWith(429, { error: { code: "limit_reached" } }), { code: "limit_reached" });
  const limited = await refusedWith(429, { code: "rate_limited", nextStartAt: new Date(Date.now() + 8000).toISOString() });
  assert.equal(limited!.code, "rate_limited");
  assert.ok(limited!.retryAfterMs! > 5000 && limited!.retryAfterMs! <= 8000);
  assert.equal(await refusedWith(503, { code: "something_new" }), undefined, "what it may have made isn't known");
  assert.equal(await refusedWith(500, {}), undefined);

  const plain = await realDriver("boat", { apiKey: "k" }, outbound);
  delete answers[start];
  await plain.call({ id: "bx_1" }, "computer_exec", { command: "make", timeoutSeconds: 60 });
  assert.doesNotMatch(requests.at(-1)!.body.command, /systemd-run/, "a provider connection runs as it did");
});

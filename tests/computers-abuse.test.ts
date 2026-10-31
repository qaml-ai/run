import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { postLedger } from "../src/billing.ts";
import { signatures } from "../src/computers/abuse.ts";
import { driver as realDriver, type ComputerDriver, type DriverOptions, type ManagedMachine } from "../src/computers/providers.ts";
import { Computers } from "../src/computers/service.ts";
import { EndUserCredits } from "../src/end-user-credits.ts";
import { HttpError } from "../src/http.ts";
import { Outbound } from "../src/outbound.ts";
import { DEFAULT_PRICING, micros } from "../src/pricing.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";

async function fixture(options: { flag?: boolean; payer?: { id: string; bucket: string }; platformKey?: boolean } = {}) {
  const { db } = await testDatabase();
  for (const [id, tenant] of [["a", "payg"], ["b", "payg"], ["c", "rich"]]) await db.query("insert into agents(id,tenant,header,revision,name,type,model) values ($1,$2,'{}',1,'A','test','x')", [id, tenant]);
  const entry = (name: string) => ({ tokenSha256: createHash("sha256").update(name).digest("hex"), apiKeys: {}, billing: "prepaid" });
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { payg: entry("payg"), rich: entry("rich") }, platformKeys: options.platformKey === false ? {} : { boat: "platform-boat-key" } }) });
  await tenants.reload();
  const accounts = new Accounts({ db, tenants, pricing: DEFAULT_PRICING, secretsKey: "ab".repeat(32) });
  const endUsers = new EndUserCredits(db);
  await postLedger(db, [{ tenant: "payg", kind: "purchase", amount: micros(10), key: "fund" }, { tenant: "rich", kind: "purchase", amount: micros(10), key: "fund-rich" }]);
  accounts.billing.invalidate(["payg", "rich"]);
  let now = Date.now(), machines: ManagedMachine[] = [], createFails = false;
  const closes: string[] = [], driverOptions: DriverOptions[] = [], calls: any[] = [];
  const fake: ComputerDriver = {
    async create(id: string) { if (createFails) throw new Error("the answer was lost"); return { id }; },
    async call(_ref, _op, args) { calls.push(args); return { exitCode: 0, stdout: "done" }; },
    async close(ref) { closes.push(ref.id); },
    async list() { return machines; },
  };
  const make = (flag: boolean) => new Computers({
    db, accounts, outbound: new Outbound(), now: () => now, endUsers, payer: () => options.payer, managed: flag,
    driver: (_provider, _credentials, _outbound, value) => { driverOptions.push(value ?? {}); return fake; },
  });
  const service = make(options.flag !== false);
  const logged: any[] = [], error = console.error;
  console.error = (line: string) => { try { logged.push(JSON.parse(line)); } catch { error(line); } };
  const lease = async (agent = "a") => (await db.query("select * from computer_leases where agent=$1 order by sequence desc limit 1", [agent])).rows[0];
  return { db, accounts, endUsers, service, make, lease, logged, closes, driverOptions, calls, done: () => { console.error = error; },
    connect: (tenant = "payg", agent = "a", on = service) => on.create(tenant, { agent, provider: "boat" }),
    start: (tenant = "payg", agent = "a", key = "start", on = service) => on.call(tenant, agent, "computer_start", {}, key),
    advance: (ms: number) => { now += ms; }, now: () => now, machines: (value: ManagedMachine[]) => { machines = value; }, createFail: (value: boolean) => { createFails = value; } };
}

test("signatures name what matched: miners, pools, mail blasts and scanners, and not ordinary work", () => {
  assert.deepEqual(signatures("curl -L x | sh; ./xmrig -o stratum+tcp://pool:3333"), ["miner", "mining_pool"]);
  assert.deepEqual(signatures("swaks --to a@b"), ["mail_blast"]);
  assert.deepEqual(signatures("MASSCAN 0.0.0.0/0"), ["scanner"]);
  for (const ordinary of ["npm test", "git clone https://github.com/x/determiner", "grep -r sendmails .", "make -j8 && ./configure", "python3 examiner.py"]) assert.deepEqual(signatures(ordinary), [], ordinary);
});

test("a matching command is logged by signature only, never its text, and still runs", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  await f.service.call("payg", "a", "computer_exec", { command: "./xmrig --user secret-wallet-address" }, "miner");
  await f.service.call("payg", "a", "computer_write_file", { path: "/tmp/m.sh", content: "swaks --to everyone" }, "file");
  await f.service.call("payg", "a", "computer_exec", { command: "npm test" }, "ordinary");
  const lease = await f.lease();
  const found = f.logged.filter(line => line.type === "computer_signature");
  assert.deepEqual(found, [
    { type: "computer_signature", tenant: "payg", agent: "a", lease: lease.id, tool: "computer_exec", signatures: ["miner"] },
    { type: "computer_signature", tenant: "payg", agent: "a", lease: lease.id, tool: "computer_write_file", signatures: ["mail_blast"] },
  ]);
  assert.doesNotMatch(JSON.stringify(f.logged), /secret-wallet-address|everyone/);
  assert.equal(f.calls.length, 3, "only logged");
  f.done();
});

test("a provider connection's commands aren't scanned: it's the tenant's own account", async () => {
  const f = await fixture();
  await f.service.create("payg", { agent: "a", provider: "e2b", credentials: { apiKey: "k" } });
  await f.start();
  await f.service.call("payg", "a", "computer_exec", { command: "./xmrig" }, "miner");
  assert.deepEqual(f.logged.filter(line => line.type === "computer_signature"), []);
  f.done();
});

test("each machine is told its tenant, and a provider connection's isn't", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  assert.equal(f.driverOptions.at(-1)!.tenant, "payg");
  assert.equal(f.driverOptions.at(-1)!.managed, true);
  await f.service.create("rich", { agent: "c", provider: "e2b", credentials: { apiKey: "k" } });
  await f.start("rich", "c");
  assert.deepEqual(f.driverOptions.at(-1), { managed: false });
  f.done();
});

test("the flag turned off stops every running managed computer at the next sweep, charging up to then; a provider connection keeps running", async () => {
  const f = await fixture();
  await f.connect();
  await f.start();
  await f.service.create("rich", { agent: "c", provider: "e2b", credentials: { apiKey: "k" } });
  await f.start("rich", "c");
  const balance = async () => Number((await f.db.query("select balance from credit_accounts where tenant='payg'")).rows[0].balance);
  const before = await balance();
  f.advance(60_000);
  const off = f.make(false);
  await off.sweep();
  assert.equal((await f.lease("a")).state, "closed");
  assert.equal((await f.lease("c")).state, "active");
  assert.ok(before - await balance() > 0);
  assert.deepEqual(f.logged.filter(line => line.type === "computer_kill_stop").map(line => line.lease), [(await f.lease("a")).id]);
  await assert.rejects(f.start("payg", "a", "again", off), (error: unknown) => error instanceof HttpError && error.status === 403);
  f.done();
});

test("the operator's stop ends one account's managed computers; with block it can't start another until lifted", async () => {
  const f = await fixture();
  await f.connect("payg", "a");
  await f.connect("payg", "b");
  await f.connect("rich", "c");
  await f.start("payg", "a");
  await f.start("payg", "b", "start-b");
  await f.start("rich", "c", "start-c");

  assert.deepEqual(await f.service.stopTenant("payg", "ops", false), { stopped: 2, failed: 0, blocked: false });
  assert.deepEqual([(await f.lease("a")).state, (await f.lease("b")).state, (await f.lease("c")).state], ["closed", "closed", "active"]);
  await f.start("payg", "a", "free-to-start");
  assert.equal((await f.lease("a")).state, "active");

  assert.deepEqual(await f.service.stopTenant("payg", "ops", true), { stopped: 1, failed: 0, blocked: true });
  await assert.rejects(f.start("payg", "a", "blocked"), (error: unknown) => error instanceof HttpError && error.status === 403 && /turned off for this account/.test(error.message));
  assert.equal(f.logged.filter(line => line.type === "computer_tenant_stopped").at(-1).by, "ops");

  assert.deepEqual(await f.service.unblockTenant("payg"), { blocked: false });
  await f.start("payg", "a", "after-unblock");
  assert.equal((await f.lease("a")).state, "active");
  f.done();
});

test("reconcile deletes machines no lease accounts for, past a start's time, and leaves the rest", async () => {
  const f = await fixture();
  await f.connect("payg", "a");
  await f.connect("payg", "b");
  await f.start("payg", "a");
  await f.start("payg", "b", "start-b");
  const running = await f.lease("a"), stopped = await f.lease("b");
  await f.service.call("payg", "b", "computer_stop", {}, "stop-b");
  f.closes.length = 0;
  f.advance(3600_000);
  const old = f.now() - 3000_000;
  const machine = (id: string, lease: string, createdAt = old) => ({ id, lease, tenant: "payg", createdAt });
  f.machines([machine("running", running.id), machine("stopped", stopped.id), machine("no-lease", "cmp_unknown"), machine("too-new", "cmp_new", f.now() - 60_000)]);
  assert.deepEqual(await f.service.reconcile(), { machines: 4, leaked: 2, cleared: 0 });
  assert.deepEqual(f.closes, ["stopped", "no-lease"]);
  assert.deepEqual(f.logged.filter(line => line.type === "computer_leak").map(line => [line.machine, line.tenant, line.state]), [["stopped", "payg", "closed"], ["no-lease", "payg", "none"]]);
  f.done();
});

test("reconcile settles an uncertain managed create: its machine goes, or is not there, and the agent can start again, uncharged", async () => {
  const f = await fixture();
  await f.connect("payg", "a");
  f.createFail(true);
  await assert.rejects(f.start("payg", "a"), /may have made a machine/);
  const uncertain = await f.lease("a");
  assert.equal(uncertain.state, "uncertain");
  f.createFail(false);

  // Too soon to tell: left alone.
  f.machines([]);
  assert.deepEqual(await f.service.reconcile(), { machines: 0, leaked: 0, cleared: 0 });
  assert.equal((await f.lease("a")).state, "uncertain");

  f.advance(20 * 60_000);
  f.machines([{ id: "made-after-all", lease: uncertain.id, tenant: "payg", createdAt: f.now() - 19 * 60_000 }]);
  assert.deepEqual(await f.service.reconcile(), { machines: 1, leaked: 1, cleared: 1 });
  assert.deepEqual(f.closes, ["made-after-all"]);
  const lease = await f.lease("a");
  assert.deepEqual([lease.state, lease.error, lease.metered_until], ["closed", null, null]);
  await f.start("payg", "a", "again");
  assert.equal((await f.lease("a")).state, "active");
  f.done();
});

test("reconcile does nothing without a platform key, and a listing that fails changes nothing", async () => {
  const none = await fixture({ platformKey: false });
  assert.deepEqual(await none.service.reconcile(), { machines: 0, leaked: 0, cleared: 0 });
  none.done();

  const f = await fixture();
  await f.connect();
  f.createFail(true);
  await assert.rejects(f.start(), /may have made a machine/);
  f.advance(20 * 60_000);
  const broken = new Computers({ ...f.service.options, driver: () => ({ async create() { return { id: "x" }; }, async call() { return {}; }, async close() {}, async list() { throw new Error("provider down"); } }) });
  await assert.rejects(broken.reconcile(), /provider down/);
  assert.equal((await f.lease()).state, "uncertain");
  f.done();
});

test("what one lock leaves for after it runs after that lock, not another's: a slow settlement doesn't hold up another stop", async () => {
  const f = await fixture({ payer: { id: "u", bucket: "work" } });
  await f.endUsers.setSettings("payg", { enabled: true });
  await f.endUsers.post("payg", "u", { kind: "grant", amount: micros(1), key: "grant" });
  await f.connect("payg", "a");
  await f.connect("payg", "b");
  await f.start("payg", "a");
  await f.start("payg", "b", "start-b");
  const slow = (await f.lease("a")).hold;
  f.advance(60_000);
  let open!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; }), at = new Promise<void>(resolve => { reached = resolve; });
  const settleHold = f.endUsers.settleHold.bind(f.endUsers);
  f.endUsers.settleHold = async (...args: Parameters<typeof settleHold>) => { if (args[3] === slow) { reached(); await gate; } return settleHold(...args); };
  const first = f.service.call("payg", "a", "computer_stop", {}, "stop-a");
  await at;
  await f.service.call("payg", "b", "computer_stop", {}, "stop-b");
  assert.equal((await f.lease("b")).hold, null, "its own settled, while the other's still waits");
  assert.ok((await f.lease("a")).hold);
  open();
  await first;
  assert.equal((await f.lease("a")).hold, null);
  f.done();
});

test("an agent's own stop waits for its settlement, in the same call", async () => {
  const f = await fixture({ payer: { id: "u", bucket: "work" } });
  await f.endUsers.setSettings("payg", { enabled: true });
  await f.endUsers.post("payg", "u", { kind: "grant", amount: micros(1), key: "grant" });
  await f.connect();
  await f.start();
  await f.service.call("payg", "a", "computer_stop", {}, "stop");
  assert.equal((await f.lease()).hold, null);
  f.done();
});

test("the Boat driver: a managed machine is labelled with its lease and tenant, set up before use, and listed by label; a provider connection's isn't labelled", async () => {
  const requests: { path: string; method: string; body?: any }[] = [];
  let setupExit = 0;
  const outbound = { fetch: async (url: string, init: any) => {
    const parsed = new URL(url), path = parsed.pathname.replace("/api/v1", "") + parsed.search, method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, ...(body ? { body } : {}) });
    if (path.startsWith("/sandboxes?")) {
      return Response.json(parsed.searchParams.get("cursor")
        ? { sandboxes: [{ id: "b2", state: "idle", createdAt: "2026-10-31T00:00:00Z", labels: { lease: "cmp_2", tenant: "t2" } }, { id: "gone", state: "stopped", createdAt: "2026-10-31T00:00:00Z", labels: { lease: "cmp_3", tenant: "t3" } }], pageInfo: { hasMore: false } }
        : { sandboxes: [{ id: "b1", state: "running", createdAt: "2026-10-31T00:00:00Z", labels: { lease: "cmp_1", tenant: "t1" } }], pageInfo: { hasMore: true, nextCursor: "next" } });
    }
    if (path.endsWith("/commands")) return Response.json({ exitCode: setupExit, stdout: "", stderr: "" });
    return Response.json({ sandbox: { id: "bx_1", state: "idle" } });
  } } as any;
  const managed = await realDriver("boat", { apiKey: "k" }, outbound, { managed: true, tenant: "payg", setup: "apply-rules" });
  const allocated: unknown[] = [];
  await managed.create("cmp_1", 7200, async ref => { allocated.push(ref); });
  assert.deepEqual(requests[0].body.labels, { "camelrun-managed": "true", lease: "cmp_1", tenant: "payg" });
  const setup = requests.find(r => r.path.endsWith("/commands"))!;
  assert.deepEqual(setup.body, { command: "apply-rules", timeoutSeconds: 60 });
  setupExit = 1;
  await assert.rejects(managed.create("cmp_2", 7200, async ref => { allocated.push(ref); }), /setup failed/);
  assert.equal(allocated.length, 2, "the machine was allocated, so its lease closes it");
  setupExit = 0;

  requests.length = 0;
  assert.deepEqual((await managed.list!()).map(m => [m.id, m.lease, m.tenant]), [["b1", "cmp_1", "t1"], ["b2", "cmp_2", "t2"]]);
  assert.match(requests[0].path, /label=camelrun-managed%3Dtrue/);

  requests.length = 0;
  const plain = await realDriver("boat", { apiKey: "k" }, outbound, { managed: false });
  await plain.create("cmp_9", 900);
  assert.equal(requests[0].body.labels, undefined);
  assert.equal(requests.filter(r => r.path.endsWith("/commands")).length, 0);
});

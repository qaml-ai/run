import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { ComputerMeter, SETTLE_MARGIN_MS } from "../src/computers/meter.ts";
import { applyScope } from "../../../shared/apply-scope.ts";
import type { WireJob, WireResult } from "../../../shared/job-host-protocol.ts";
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {} export const waitUntil = p => p;", shortCircuit: true };
  return next(specifier, context);
} });
const { JobHost, HostJob } = await import("../src/jobs/hosts.ts");
hooks.deregister();
const spec: WireJob = { command: "true", timeoutSeconds: 30, outputs: [], files: [], limits: {}, internet: false };
const empty = { data: "", size: 0, truncated: false };
const result: WireResult = { ok: true, exitCode: 0, timedOut: false, stdout: empty, stderr: empty, outputs: {}, missing: [], pids: "unenforced", timings: { startMs: 1, totalMs: 10, commandMs: 9, collectMs: 0, syncMs: 0 } };
function storage(t: any) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const values = new Map<string, any>();
  return {
    sql: { exec(query: string, ...args: any[]) {
      for (const arg of args) if (typeof arg === "string") assert.ok(Buffer.byteLength(arg) < 2 * 1024 * 1024, "SQLite value must fit within 2 MiB");
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
      return { toArray: () => rows };
    } },
    transactionSync<T>(callback: () => T): T {
      db.exec("BEGIN");
      try { const result = callback(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    async get<T>(key: string) { return values.get(key) as T; },
    async put(key: string, value: any) { values.set(key, structuredClone(value)); },
    async delete(key: string) { return values.delete(key); },
    async list({ prefix }: { prefix: string }) { return new Map([...values].filter(([key]) => key.startsWith(prefix))); },
    async setAlarm() {},
  };
}
function host(store: ReturnType<typeof storage>) {
  const instance = new JobHost({ storage: store } as never, {} as never), sent: any[] = [];
  (instance as any).socket = { send: (frame: string) => sent.push(JSON.parse(frame)) };
  return { instance, sent, receive: (message: any) => (instance as any).receive("host", message) };
}
test("dispatch joins in-flight calls and replays the first stored answer without sending", async t => {
  const store = storage(t), h = host(store);
  const first = h.instance.dispatch("one", spec, 1000), second = h.instance.dispatch("one", spec, 1000);
  await h.receive({ type: "started", id: "one", at: Date.now() });
  await h.receive({ type: "result", id: "one", result });
  assert.deepEqual(await first, await second);
  await h.receive({ type: "result", id: "one", result: { ok: false, code: "stopped", message: "late" } });
  assert.deepEqual(await h.instance.dispatch("one", spec, 1000), await first);
  assert.equal(h.sent.filter(m => m.type === "job").length, 1);
  assert.equal(h.sent.filter(m => m.type === "ack").length, 2);
  await h.receive({ type: "result", id: "unknown", result });
  assert.equal(store.sql.exec("SELECT * FROM host_dispatches WHERE id = ?", "unknown").toArray().length, 0);
  assert.deepEqual(h.sent.at(-1), { type: "ack", id: "unknown" });
});
test("a reconstructed host accepts results without a waiter and preserves start and deadline", async t => {
  const store = storage(t); host(store);
  const now = Date.now();
  store.sql.exec("INSERT INTO host_dispatches (id, sent_at, deadline_at, started_at) VALUES (?, ?, ?, ?)", "restart", now - 100, now + 200, now - 50);
  const h = host(store);
  assert.equal(h.instance.cancel("restart"), true);
  await h.receive({ type: "result", id: "restart", result });
  const answer = await h.instance.dispatch("restart", spec, 10_000);
  assert.equal(answer.ok, true); assert.equal(answer.ranFrom, now - 50);
  store.sql.exec("INSERT INTO host_dispatches (id, sent_at, deadline_at) VALUES (?, ?, ?)", "expired", now - 100, now - 1);
  assert.equal((await h.instance.dispatch("expired", spec, 10_000)).ok, false);
  assert.equal(h.sent.filter(m => m.type === "job").length, 0);
  store.sql.exec("UPDATE host_dispatches SET answered_at = ? WHERE id = ?", now - 25 * 3600_000, "restart");
  await h.instance.dispatch("expired", spec, 100);
  assert.equal(store.sql.exec("SELECT * FROM host_dispatches WHERE id = ?", "restart").toArray().length, 0);
  assert.equal(store.sql.exec("SELECT * FROM host_dispatch_parts WHERE id = ?", "restart").toArray().length, 0);
});
test("HostJob resumes the persisted meter once, skips admission and replays its completed result", async t => {
  const store = storage(t), charges: any[] = [];
  const meter = () => new ComputerMeter({ store, billing: { admit: async () => { throw new Error("admitted twice"); }, charge: async charge => { charges.push(charge); } }, idleMs: 60_000, schedule: async () => {} });
  const payer = { tenant: "test", agent: "wf_test", kind: "workflow" as const }, began = Date.now() - 3000;
  await meter().started(payer, "test", 60_000, 0, "job:resume", { rate: 0.001, at: began });
  await store.put("dispatch:resume", { phase: "dispatched", host: "host", dispatchedAt: began, rate: 0.001, pool: "test", shape: { vcpus: 1, memoryMiB: 4096, diskMiB: 8192 }, lifetimeMs: 60_000 });
  let calls = 0;
  const env = { JOB_HOSTS: { getByName: () => ({ dispatch: async () => { calls++; return { ...result, ranFrom: began + 10, ranUntil: began + 1900 }; } }) }, JOB_HOST_REGISTRY: { getByName: () => ({ touch: async () => {}, release: async () => {} }) } };
  const job = new HostJob({ storage: store, waitUntil: () => {} } as never, env as never); (job as any).meter = meter;
  const input = { id: "resume", command: "true", timeoutSeconds: 30, outputs: [], payer };
  const running = job.run(input);
  const concurrent = await job.run(input);
  assert.equal(concurrent.ok, false);
  if (!concurrent.ok) assert.equal(concurrent.code, "job_running");
  const answer = await running;
  assert.equal(answer.ok, true); assert.equal(charges.length, 1);
  assert.equal(charges[0].id, "job:resume"); assert.equal(charges[0].seconds, 1.89);
  assert.equal(await store.get("dispatch:resume"), undefined);
  const again = new HostJob({ storage: store, waitUntil: () => {} } as never, env as never); (again as any).meter = meter;
  const replay = await again.run(input);
  assert.equal(replay.ok, true); assert.equal(replay.costUsd, answer.costUsd);
  assert.equal(calls, 2); assert.equal(charges.length, 1);
});


test("a new waiter after restart waits for the original dispatch", async t => {
  const store = storage(t); host(store);
  const now = Date.now();
  store.sql.exec("INSERT INTO host_dispatches (id, sent_at, deadline_at) VALUES (?, ?, ?)", "in-flight", now - 100, now + 1000);
  const h = host(store), waiting = h.instance.dispatch("in-flight", spec, 100_000);
  assert.equal(h.sent.length, 0);
  await h.receive({ type: "started", id: "in-flight", at: now });
  await h.receive({ type: "result", id: "in-flight", result });
  assert.equal((await waiting).ok, true);
  assert.equal(h.sent.filter(m => m.type === "job").length, 0);
});

test("an 8 MiB stdout is chunked, acknowledged once and replayed intact after restart", async t => {
  const store = storage(t), h = host(store);
  const large: WireResult = { ...result, stdout: { data: Buffer.alloc(8 * 1024 * 1024, 65).toString("base64"), size: 8 * 1024 * 1024, truncated: false }, outputs: { "🦊.txt": empty } };
  const waiting = h.instance.dispatch("large", spec, 10_000);
  await h.receive({ type: "result", id: "large", result: large });
  assert.deepEqual(await waiting, large);
  const parts = store.sql.exec("SELECT n, data FROM host_dispatch_parts WHERE id = ? ORDER BY n", "large").toArray() as { n: number; data: string }[];
  assert.ok(parts.length > 8);
  assert.ok(parts.every((part, n) => part.n === n && part.data.length <= 1024 * 1024));
  assert.equal(h.sent.filter(message => message.type === "ack").length, 1);
  const recovered = host(store);
  assert.deepEqual(await recovered.instance.dispatch("large", spec, 10_000), large);
  assert.equal(recovered.sent.length, 0);
});

test("a failed result transaction rolls back all parts and leaves the result unacknowledged", async t => {
  const store = storage(t), h = host(store);
  const now = Date.now();
  store.sql.exec("INSERT INTO host_dispatches (id, sent_at, deadline_at) VALUES (?, ?, ?)", "rollback", now, now + 1000);
  const exec = store.sql.exec;
  store.sql.exec = (query, ...args) => {
    if (query.startsWith("INSERT INTO host_dispatch_parts") && args[1] === 1) throw new Error("write failed");
    return exec(query, ...args);
  };
  const large = { ...result, stdout: { data: "A".repeat(2 * 1024 * 1024), size: 1_572_864, truncated: false } };
  await assert.rejects(h.receive({ type: "result", id: "rollback", result: large }), /write failed/);
  assert.equal(store.sql.exec("SELECT * FROM host_dispatch_parts WHERE id = ?", "rollback").toArray().length, 0);
  assert.equal(store.sql.exec("SELECT result FROM host_dispatches WHERE id = ?", "rollback").toArray()[0]!.result, null);
  assert.equal(h.sent.length, 0);
  store.sql.exec = exec;
  await h.receive({ type: "result", id: "rollback", result: large });
  assert.equal((await h.instance.dispatch("rollback", spec, 1000)).ok, true);
  assert.deepEqual(h.sent, [{ type: "ack", id: "rollback" }]);
});

test("recovery before the first JobHost insert dispatches the job's files", async t => {
  const store = storage(t), h = host(storage(t)), charges: any[] = [];
  const meter = () => new ComputerMeter({ store, billing: { admit: async () => { throw new Error("admitted twice"); }, charge: async charge => { charges.push(charge); } }, idleMs: 60_000, schedule: async () => {} });
  const payer = { tenant: "test", agent: "wf_test", kind: "workflow" as const }, began = Date.now() - 1000;
  await meter().started(payer, "test", 60_000, 0, "job:unsent", { rate: 0.001, at: began });
  await store.put("dispatch:unsent", { phase: "dispatched", host: "host", dispatchedAt: began, rate: 0.001, pool: "test", shape: { vcpus: 1, memoryMiB: 4096, diskMiB: 8192 }, lifetimeMs: 60_000 });
  const env = { JOB_HOSTS: { getByName: () => ({ dispatch: async (id: string, wire: WireJob, deadline: number) => {
    const waiting = h.instance.dispatch(id, wire, deadline);
    await h.receive({ type: "result", id, result });
    return waiting;
  } }) }, JOB_HOST_REGISTRY: { getByName: () => ({ touch: async () => {}, release: async () => {}, want: async () => { throw new Error("placed twice"); } }) } };
  const job = new HostJob({ storage: store, waitUntil: () => {} } as never, env as never); (job as any).meter = meter;
  const bytes = new TextEncoder().encode("hello from the original files");
  const answer = await job.run({ id: "unsent", command: "cat hello.txt", timeoutSeconds: 30, outputs: [], files: { "hello.txt": bytes }, payer });
  assert.equal(answer.ok, true);
  const sent = h.sent.filter(message => message.type === "job");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].spec.files, [{ path: "hello.txt", data: Buffer.from(bytes).toString("base64") }]);
  assert.equal(charges.length, 1);
});

test("a late host result is logged and acknowledged while the first failure is retained", async t => {
  const store = storage(t), h = host(store), logs: string[] = [];
  const failure = { ok: false, code: "container_failed", message: "The job host went away" };
  const waiting = h.instance.dispatch("late", spec, 1000);
  (h.instance as any).answer("late", failure);
  assert.deepEqual(await waiting, failure);
  t.mock.method(console, "warn", (line: string) => logs.push(line));
  await h.receive({ type: "result", id: "late", result });
  assert.deepEqual(logs.map(line => JSON.parse(line)), [{ type: "jobhost_late_result_dropped", id: "late" }]);
  assert.deepEqual(await h.instance.dispatch("late", spec, 1000), failure);
  assert.equal(h.sent.filter(message => message.type === "ack").length, 1);
});

test("a crash after meter.started but before dispatch persistence reuses one session and charges only the VM span", async t => {
  let now = 10_000, starts = 0, failPut = true;
  t.mock.method(Date, "now", () => now);
  const store = storage(t), charges: any[] = [];
  const meter = () => {
    const value = new ComputerMeter({ store, billing: { admit: async () => {}, charge: async charge => { charges.push(charge); } }, idleMs: 60_000, schedule: async () => {}, now: () => now });
    const started = value.started.bind(value);
    value.started = async (...args) => { starts++; await started(...args); };
    return value;
  };
  const put = store.put;
  store.put = async (key, value) => {
    if (key === "dispatch:crash" && failPut) { failPut = false; throw new Error("crashed before dispatch put"); }
    await put(key, value);
  };
  const env = {
    JOB_HOST_REGISTRY: { getByName: () => ({ want: async () => "host", unwant: async () => {}, touch: async () => {}, release: async () => {} }) },
    JOB_HOSTS: { getByName: () => ({ dispatch: async () => { now = 25_000; return { ...result, ranFrom: 21_000, ranUntil: now }; } }) },
  };
  const input = { id: "crash", command: "true", timeoutSeconds: 30, outputs: [], payer: { tenant: "test", agent: "wf_test", kind: "workflow" } };
  // Exercise admission and reserveComputer without opening a Postgres connection.
  const sql = { async query() { return { rows: [{ n: 0 }], rowCount: 0 }; } };
  const first = new HostJob({ storage: store, waitUntil: () => {} } as never, env as never); (first as any).meter = meter;
  await applyScope.run({ sql: sql as never }, () => assert.rejects(first.run(input), /crashed before dispatch put/));
  assert.equal(await store.get("dispatch:crash"), undefined);
  const original = await meter().openSession();
  assert.equal(original?.id, "job:crash");
  assert.equal(charges.length, 0);
  now = 20_000;
  const recovered = new HostJob({ storage: store, waitUntil: () => {} } as never, env as never); (recovered as any).meter = meter;
  assert.equal((await applyScope.run({ sql: sql as never }, () => recovered.run(input))).ok, true);
  assert.equal(starts, 1, "recovery never closes and reopens the named session");
  assert.equal(charges.length, 1);
  assert.equal(charges[0].id, "job:crash");
  assert.equal(charges[0].startedAt, 21_000);
  assert.equal(charges[0].endedAt, 25_000);
  assert.equal(charges[0].seconds, 4);
  assert.equal(await meter().openSession(), undefined);
});

test("host alarms only settle within the grace window and close once at the original lifetime bound", async t => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const store = storage(t), charges: any[] = [], scheduled: number[] = [];
  const meter = () => new ComputerMeter({ store, billing: { admit: async () => {}, charge: async charge => { charges.push(charge); } }, idleMs: 60_000, schedule: async at => { scheduled.push(at); }, now: () => now });
  await meter().started({ tenant: "test", agent: "wf_test", kind: "workflow" }, "test", 400_000, 0, "job:alarm", { rate: 0.001 });
  const original = await meter().openSession();
  await store.put("dispatch:alarm", { dispatchedAt: 10_000, lifetimeMs: 400_000 });
  const job = new HostJob({ storage: { ...store, setAlarm: async (at: number) => { scheduled.push(at); } } } as never, {} as never);
  (job as any).meter = meter;
  now = 410_001; // Past the lifetime, still inside its five-second grace window.
  await job.alarm();
  assert.deepEqual(await meter().openSession(), original, "settle neither checkpoints nor extends the session");
  assert.equal(charges.length, 0);
  assert.equal(scheduled.at(-1), 415_000);
  now = 415_001;
  await job.alarm();
  assert.equal(charges.length, 1);
  assert.equal(charges[0].id, "job:alarm");
  assert.equal(charges[0].endedAt, 410_000);
  assert.equal(charges[0].seconds, 400);
  assert.equal(await meter().openSession(), undefined);
  now = 500_000;
  await job.alarm();
  assert.equal(charges.length, 1, "later alarms never open a second charge");
});

test("a stop during recovery cancels the host and ends the one open charge at the stop", async t => {
  let now = 10_000, cancelled = 0;
  t.mock.method(Date, "now", () => now);
  const store = storage(t), charges: any[] = [];
  const meter = () => new ComputerMeter({ store, billing: { admit: async () => { throw new Error("admitted twice"); }, charge: async charge => { charges.push(charge); } }, idleMs: 60_000, schedule: async () => {}, now: () => now });
  const payer = { tenant: "test", agent: "wf_test", kind: "workflow" as const };
  await meter().started(payer, "test", 60_000, 0, "job:stop", { rate: 0.001 });
  await store.put("dispatch:stop", { phase: "dispatched", host: "host", dispatchedAt: now, rate: 0.001, pool: "test", shape: { vcpus: 1, memoryMiB: 4096, diskMiB: 8192 }, lifetimeMs: 60_000 });
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const env = {
    JOB_HOST_REGISTRY: { getByName: () => ({ touch: async () => {}, release: async () => {} }) },
    JOB_HOSTS: { getByName: () => ({
      cancel: async (id: string) => { assert.equal(id, "stop"); cancelled++; return true; },
      dispatch: async () => { now = 25_000; return { ok: false, code: "stopped", message: "The job was stopped", ranFrom: 11_000, ranUntil: now }; },
    }) },
  };
  const job = new HostJob({ storage: store, waitUntil: () => {} } as never, env as never); (job as any).meter = meter;
  (job as any).files = async () => { entered.resolve(); await resume.promise; return { files: [] }; };
  now = 20_000;
  const running = job.run({ id: "stop", command: "true", timeoutSeconds: 30, outputs: [], payer });
  await entered.promise;
  const stoppedAt = now;
  assert.deepEqual(await job.stop(), { stopped: true });
  resume.resolve();
  const answer = await running;
  assert.equal(answer.ok, false);
  if (!answer.ok) assert.equal(answer.code, "stopped");
  assert.equal(cancelled, 1);
  assert.equal(charges.length, 1);
  assert.equal(charges[0].id, "job:stop");
  assert.equal(charges[0].startedAt, 11_000);
  assert.equal(charges[0].endedAt, stoppedAt);
  assert.equal(charges[0].seconds, 9);
  assert.equal(await meter().openSession(), undefined);
  assert.equal(await store.get("dispatch:stop"), undefined);
});

test("repo dispatch recovery reuses the mounted tree and fence without resolving or acquiring again", async t => {
  const store = storage(t), began = Date.now() - 1000, fence = { holder: "host:host/resume-repo", epoch: 4 };
  const payer = { tenant: "test", agent: "wf_test", kind: "workflow" as const };
  const source = { tenant: "test", repo: "repo_one", ref: "main", owner: "workflow:wf_test" };
  const saved = { phase: "dispatched", host: "host", dispatchedAt: began, rate: 0.001, pool: "test", shape: { vcpus: 1, memoryMiB: 4096, diskMiB: 8192 }, lifetimeMs: 60_000,
    repo: { repo: source, expect: "a".repeat(40), tree: "b".repeat(40), lineage: "test:repo_one", fence } };
  await store.put("dispatch:resume-repo", saved);
  const meter = () => new ComputerMeter({ store, billing: { admit: async () => { throw Error("admitted twice"); }, charge: async () => {} }, idleMs: 60_000, schedule: async () => {} });
  await meter().started(payer, "test", 60_000, 0, "job:resume-repo", { rate: 0.001, at: began });
  let renews = 0, releases = 0, dispatches = 0;
  const stub = { renew: async (got: any, ttl: number) => { assert.deepEqual(got, { ref: "job/resume-repo", ...fence }); assert.equal(ttl, 600000); renews++; },
    release: async (got: any) => { assert.deepEqual(got, { ref: "job/resume-repo", ...fence }); releases++; },
    acquire: async () => { throw Error("acquired twice"); }, resolve: async () => { throw Error("resolved twice"); } };
  const env = { CAMELFS: { fetch: async () => { throw Error("imported"); } }, CAMELFS_API_TOKEN: "test-only",
    TENANTS: { getByName: () => ({ repoRow: async () => ({ deletedAt: null, lineage: "test:repo_one" }) }) }, REPOS: { getByName: () => stub },
    JOB_HOST_REGISTRY: { getByName: () => ({ touch: async () => {}, release: async () => {} }) },
    JOB_HOSTS: { getByName: () => ({ dispatch: async (_: string, wire: WireJob) => {
      dispatches++; assert.deepEqual(wire.camelfs, { lineage: "test:repo_one", tree: saved.repo.tree, parent: saved.repo.expect, fence }); assert.deepEqual(wire.files, []); assert.equal(wire.sync, undefined); return result;
    } }) } };
  const background: Promise<unknown>[] = [], ctx = { storage: store, waitUntil: (p: Promise<unknown>) => background.push(p) };
  t.after(() => Promise.all(background));
  const job = new HostJob(ctx as never, env as never); (job as any).meter = meter;
  const input = { id: "resume-repo", command: "true", timeoutSeconds: 30, repo: source, payer };
  assert.equal((await job.run(input)).ok, true); assert.equal(renews, 1); assert.equal(releases, 1); assert.equal(dispatches, 1);
  await store.delete("result:resume-repo"); await store.put("dispatch:resume-repo", saved);
  await job.alarm(); assert.equal(renews, 2, "live dispatch alarms renew its persisted fence");
  stub.renew = async () => { throw Error("fenced"); };
  const logs: any[] = [];
  t.mock.method(console, "error", (line: string) => logs.push(JSON.parse(line)));
  await job.alarm();
  assert.equal(logs[0].type, "host_job_lease_renew_failed");
  const recovered = new HostJob(ctx as never, env as never); (recovered as any).meter = meter;
  const failed = await recovered.run(input);
  assert.equal(failed.ok, false); if (!failed.ok) assert.match(failed.message, /fenced/);
  assert.equal(dispatches, 1, "lost fence never redispatches or reacquires");
});

test("a result returns with its cost while accounting blocks, and replay charges once", async t => {
  let now = 10_000, calls = 0, released = 0;
  t.mock.method(Date, "now", () => now);
  const store = storage(t), background: Promise<unknown>[] = [], charges: any[] = [];
  const gate = Promise.withResolvers<void>();
  const payer = { tenant: "test", agent: "wf_test", kind: "workflow" as const };
  const meter = () => new ComputerMeter({ store, idleMs: 60_000, now: () => now, schedule: async () => {}, billing: {
    admit: async () => { throw new Error("admitted twice"); },
    charge: async charge => { calls++; await gate.promise; charges.push(charge); },
  } });
  await meter().started(payer, "test", 60_000, 0, "job:background", { rate: 0.001 });
  await store.put("dispatch:background", { phase: "dispatched", host: "host", dispatchedAt: now, rate: 0.001, pool: "test", shape: { vcpus: 1, memoryMiB: 4096, diskMiB: 8192 }, lifetimeMs: 60_000 });
  const env = {
    JOB_HOSTS: { getByName: () => ({ dispatch: async () => { now = 15_000; return { ...result, ranFrom: 11_000, ranUntil: now }; } }) },
    JOB_HOST_REGISTRY: { getByName: () => ({ touch: async () => {}, release: async () => { released++; } }) },
  };
  const job = new HostJob({ storage: store, waitUntil: (p: Promise<unknown>) => background.push(p) } as never, env as never);
  (job as any).meter = meter;
  const input = { id: "background", command: "true", timeoutSeconds: 30, outputs: [], payer };
  try {
    const answer = await job.run(input);
    assert.equal(answer.ok, true);
    assert.equal(answer.costUsd, 0.004);
    assert.equal(released, 1);
    assert.equal(charges.length, 0, "accounting still blocks when run resolves");
    assert.equal(await meter().isOpen(), false);
    assert.equal((await store.list({ prefix: "meter:unsettled:" })).size, 1);
    assert.equal((await job.run(input)).costUsd, answer.costUsd);
    assert.equal(calls, 1, "replay starts no additional settlement");
  } finally { gate.resolve(); await Promise.all(background); }
  assert.equal(charges.length, 1);
  assert.equal(charges[0].id, "job:background");
  assert.equal(charges[0].costUsd, 0.004);
  assert.equal(await meter().settled(), true);
});

test("HostJob alarm recovers a closed charge with no dispatch and backs off failures", async t => {
  let now = 10_000, attempts = 0;
  t.mock.method(Date, "now", () => now);
  const store = storage(t), scheduled: number[] = [], charges: any[] = [];
  const meter = () => new ComputerMeter({ store, idleMs: 60_000, now: () => now, schedule: async at => { scheduled.push(at); }, billing: {
    admit: async () => {}, charge: async charge => { attempts++; if (attempts <= 2) throw new Error("database unavailable"); charges.push(charge); },
  } });
  const value = meter();
  await value.started({ tenant: "test", agent: "wf_test", kind: "workflow" }, "test", 60_000, 0, "job:lost", { rate: 0.001 });
  now += 4_000;
  await value.closed(); // Crash here: no background settle starts; only durable state survives.
  assert.equal(value.spentUsd(), 0.004);
  assert.equal(attempts, 0);
  assert.equal(scheduled.at(-1), now + SETTLE_MARGIN_MS);
  assert.equal(await store.get("dispatch:lost"), undefined);
  const job = new HostJob({ storage: store } as never, {} as never);
  (job as any).meter = meter;
  const logs: string[] = [];
  t.mock.method(console, "error", (line: string) => logs.push(line));
  now = scheduled.at(-1)!;
  await job.alarm();
  assert.equal(scheduled.at(-1), now + 60_000);
  assert.equal(charges.length, 0);
  now = scheduled.at(-1)!;
  await job.alarm();
  assert.equal(scheduled.at(-1), now + 120_000);
  assert.equal(charges.length, 0);
  now = scheduled.at(-1)!;
  await job.alarm();
  await job.alarm();
  assert.equal(attempts, 3);
  assert.equal(charges.length, 1);
  assert.equal(charges[0].costUsd, 0.004);
  assert.equal(charges[0].id, "job:lost");
  assert.equal(await meter().settled(), true);
  assert.equal(logs.length, 2);
});

test("a second host job follows admission while a previous charge is unsettled", async t => {
  let now = 10_000, balance = 0.001, admissions = 0, dispatches = 0;
  t.mock.method(Date, "now", () => now);
  const payer = { tenant: "test", agent: "wf_test", kind: "workflow" as const };
  const pendingStore = storage(t), store = storage(t), background: Promise<unknown>[] = [];
  const billing = {
    admit: async (who: typeof payer) => { assert.deepEqual(who, payer); admissions++; if (balance <= 0) throw new Error("credit spent"); },
    charge: async (charge: { costUsd: number }) => { balance -= charge.costUsd; },
  };
  const previous = new ComputerMeter({ store: pendingStore, billing, idleMs: 60_000, now: () => now, schedule: async () => {} });
  await previous.started(payer, "test", 60_000, 0, "job:previous", { rate: 0.001 });
  now += 4_000;
  await previous.closed();
  const env = {
    JOB_HOST_REGISTRY: { getByName: () => ({ want: async () => "host", unwant: async () => {}, touch: async () => {}, release: async () => {} }) },
    JOB_HOSTS: { getByName: () => ({ dispatch: async () => { dispatches++; return { ...result, ranFrom: now, ranUntil: now }; } }) },
  };
  const job = new HostJob({ storage: store, waitUntil: (p: Promise<unknown>) => background.push(p) } as never, env as never);
  (job as any).meter = () => new ComputerMeter({ store, billing, idleMs: 60_000, now: () => now, schedule: async () => {} });
  const sql = { async query() { return { rows: [{ n: 0 }], rowCount: 0 }; } };
  const input = { id: "second", command: "true", timeoutSeconds: 30, outputs: [], payer };
  // Admission sees recorded balance, not another DO's unsettled charges. The window is this payer's jobs
  // finished since settlement caught up: normally background accounting latency, at worst until alarm retries
  // succeed. Containers already have an equivalent window while an open session accrues cost, until its
  // checkpoint or stop charges it (objects.ts and meter.ts).
  const answer = await applyScope.run({ sql: sql as never }, () => job.run(input));
  assert.equal(answer.ok, true);
  assert.equal(admissions, 1);
  assert.equal(dispatches, 1);
  assert.equal(balance, 0.001);
  assert.equal(await previous.settled(), false);
  await Promise.all(background);
  await previous.settle();
  const refused = await job.run({ ...input, id: "third" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "admission_refused");
  assert.equal(admissions, 2);
  assert.equal(dispatches, 1);
});

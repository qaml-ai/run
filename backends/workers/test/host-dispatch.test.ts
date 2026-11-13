import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { ComputerMeter } from "../src/computers/meter.ts";
import type { WireJob, WireResult } from "../../../shared/job-host-protocol.ts";
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}", shortCircuit: true };
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
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
      return { toArray: () => rows };
    } },
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
});
test("HostJob resumes the persisted meter once, skips admission and replays its completed result", async t => {
  const store = storage(t), charges: any[] = [];
  const meter = () => new ComputerMeter({ store, billing: { admit: async () => { throw new Error("admitted twice"); }, charge: async charge => { charges.push(charge); } }, idleMs: 60_000, schedule: async () => {} });
  const payer = { tenant: "test", agent: "wf_test", kind: "workflow" as const }, began = Date.now() - 3000;
  await meter().started(payer, "test", 60_000, 0, "job:resume", { rate: 0.001, at: began });
  await store.put("dispatch:resume", { phase: "dispatched", host: "host", dispatchedAt: began, rate: 0.001, pool: "test", shape: { vcpus: 1, memoryMiB: 4096, diskMiB: 8192 }, lifetimeMs: 60_000 });
  let calls = 0;
  const env = { JOB_HOSTS: { getByName: () => ({ dispatch: async () => { calls++; return { ...result, ranFrom: began + 10, ranUntil: began + 1900 }; } }) }, JOB_HOST_REGISTRY: { getByName: () => ({ touch: async () => {}, release: async () => {} }) } };
  const job = new HostJob({ storage: store } as never, env as never); (job as any).meter = meter;
  const input = { id: "resume", command: "true", timeoutSeconds: 30, outputs: [], payer };
  const running = job.run(input);
  const concurrent = await job.run(input);
  assert.equal(concurrent.ok, false);
  if (!concurrent.ok) assert.equal(concurrent.code, "job_running");
  const answer = await running;
  assert.equal(answer.ok, true); assert.equal(charges.length, 1);
  assert.equal(charges[0].id, "job:resume"); assert.equal(charges[0].seconds, 1.89);
  assert.equal(await store.get("dispatch:resume"), undefined);
  const again = new HostJob({ storage: store } as never, env as never); (again as any).meter = meter;
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

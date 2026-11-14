import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { registerHooks } from "node:module";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { Config, Env } from "../src/agent-types.ts";

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers")
    return { url: "data:text/javascript,export class DurableObject {} export const waitUntil=p=>p", shortCircuit: true };
  if (specifier.endsWith("/tool-identity.ts"))
    return { url: 'data:text/javascript,export const runtimeSigner=async()=>({camelfsToken:async()=> "test"})', shortCircuit: true };
  return next(specifier, context);
} });
const { BashSessions, BASH_WORKDIR } = await import("../src/camelfs/bash.ts");
const { BASH_OUTPUT_KEEP } = await import("../src/camelfs/bash-stream.ts");
const { handleCamelfsNotify } = await import("../src/camelfs/notify.ts");
hooks.deregister();

const frame = (event: string, data: unknown) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
const stream = (body: string) => new Response(body, { headers: { "Content-Type": "text/event-stream" } });
const output = (text: string, offset = 0, kind = "stdout") => frame(kind, { offset, data: Buffer.from(text).toString("base64") });
const exit = frame("exit", { code: 0, timedOut: false, ms: 10 });
const fail = (status: number, code: string) => Response.json({ error: { code } }, { status });

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const storage = {
    sql: { exec(query: string, ...args: SQLInputValue[]) {
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
      return { toArray: () => rows, one: () => rows[0] };
    } },
    transactionSync<T>(run: () => T) {
      db.exec("BEGIN");
      try { const value = run(); db.exec("COMMIT"); return value; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } as unknown as DurableObjectStorage;
  const branch = { branch: "fork", lineage: "t:r", ref: "fork/child/main" };
  const conf: Config = { tenantId: "t", id: "agent-with-dash", revision: 1, expiresAt: null, config: {} };
  const pending: Promise<unknown>[] = [];
  const errors: string[] = [];
  const calls: { method: string; path: string; body: any }[] = [];
  const vms = new Map<string, { phase: string; deadline: number; lastCheckpoint?: { version: string; tree: string } }>();
  const results = new Map<string, string>();
  const flags = {
    refused: false, drop: false, leaseExpired: false, checkpointError: false,
    crash: "", crashAfter: "", runs: 0, pollerStarts: 0, tailStatus: 200, unchanged: false,
    stdout: "ok",
  };
  let sessions: InstanceType<typeof BashSessions>;
  const env = {
    CAMELFS_URL: "https://tier.example", AGENT_PUBLIC_URL: "https://runtime.example",
    CAMELFS_COMPUTE: "1", GUEST_IMAGE_SHA256: "a".repeat(64), CAMELFS_NOTIFY_KEY: "fixture",
    CAMELFS_USAGE: { getByName: () => ({ start: async () => { flags.pollerStarts++; } }) },
    AGENTS: { getByName: (agent: string) => {
      assert.equal(agent, conf.id);
      return { vmEnded: (id: string, vm: string) => sessions.ended(id, vm) };
    } },
  } as unknown as Env;
  function fetchTier(url: URL, init: RequestInit) {
    const method = init.method!;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    const [, , , id, op, execId] = url.pathname.split("/");
    if (!id) {
      assert.equal(new Headers(init.headers).get("Idempotency-Key"), body.id);
      assert.equal(body.ref, branch.ref);
      assert.equal(body.lineage, branch.lineage);
      assert.equal(body.idleStopS, undefined);
      assert.ok(JSON.parse(body.usage.payer).rate > 0);
      const vm = vms.get(body.id);
      if (vm) assert.equal(body.deadline, vm.deadline);
      else vms.set(body.id, { phase: "running", deadline: body.deadline });
      return Response.json({ id: body.id, phase: "requested" }, { status: 202 });
    }
    const vm = vms.get(id)!;
    if (!op) return Response.json(vm);
    if (op === "deadline") {
      if (flags.leaseExpired) return Response.json({ error: "lease_expired" }, { status: 409 });
      vm.deadline = body.deadline;
      return Response.json({ deadline: vm.deadline });
    }
    if (vm.phase !== "running") return fail(409, "not_running");
    if (op === "shells") return Response.json({ shell: "shell" });
    if (op === "checkpoint") {
      if (flags.checkpointError) return fail(502, "host_unreachable");
      const head = { version: "version", tree: "tree" };
      if (!flags.unchanged) vm.lastCheckpoint = head;
      return Response.json({ ...head, changed: !flags.unchanged, diff: [] });
    }
    if (method === "GET") {
      assert.equal(url.searchParams.get("offset"), "2");
      if (flags.tailStatus !== 200) return fail(flags.tailStatus, "tail_truncated");
      return stream(output("!", 2, "stderr") + exit);
    }
    const key = id + "/" + body.execId;
    if (!results.has(key)) {
      flags.runs++;
      results.set(key, flags.stdout);
    }
    return stream(output(results.get(key)!) + (flags.drop ? "" : exit));
  }
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    const suffix = (op: string) => op && url.pathname.endsWith(op);
    if (suffix(flags.crash)) { flags.crash = ""; throw new Error("simulated crash before request"); }
    const response = fetchTier(url, init);
    if (suffix(flags.crashAfter)) { flags.crashAfter = ""; throw new Error("simulated crash after request"); }
    return response;
  });
  function restart() {
    sessions = new BashSessions(storage, env, work => pending.push(work), async () => {},
      async (_, __, error) => { errors.push(error); },
      async () => { if (flags.refused) throw Object.assign(new Error("credit"), { status: 402 }); });
  }
  restart();
  const run = (key: string) => sessions.execute(conf, branch, key, key, "run", { command: "echo hi" });
  const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  const row = () => db.prepare("SELECT vm_id,state,deadline FROM agent_vms").get() as { vm_id: string; state: string; deadline: number } | undefined;
  async function ended(id: string, vm: string) {
    const body = JSON.stringify({ id, type: "vm.ended", vm });
    const ts = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", "fixture").update(`${ts}.${body}`).digest("hex");
    const request = new Request("https://runtime/notify", { method: "POST", body, headers: { "Camel-Signature": `t=${ts},v1=${signature}` } });
    assert.equal((await handleCamelfsNotify(request, env as never)).status, 204);
  }
  return { db, conf, flags, calls, errors, vms, row, run, flush, restart, ended, get sessions() { return sessions; } };
}

test("creates once, reuses its shell, checkpoints after the result, and replaces an idle VM", async t => {
  const f = fixture(t);
  assert.equal((await f.run("one")).stdout, "ok");
  const first = f.row()!.vm_id;
  assert.equal(f.flags.pollerStarts, 1);
  assert.equal(f.calls.find(c => c.path.endsWith("/exec"))!.body.cwd, BASH_WORKDIR);
  assert.equal(f.calls.filter(c => c.path.endsWith("/checkpoint")).length, 0);
  await f.flush();
  assert.equal(f.db.prepare("SELECT version FROM agent_vm_heads").get()?.version, "version");
  await f.run("two");
  await f.flush();
  assert.equal(f.flags.runs, 2);
  assert.equal(f.row()!.vm_id, first);
  assert.equal(f.calls.filter(c => c.path.endsWith("/exec")).at(-1)!.body.cwd, undefined);
  f.vms.get(first)!.phase = "ended";
  await f.run("three");
  await f.flush();
  const second = f.row()!.vm_id;
  assert.notEqual(first, second);
  await f.ended("old", first);
  assert.equal(f.row()!.state, "running");
  await f.ended("new", second);
  await f.ended("new", second);
  assert.equal(f.row()!.state, "stopped");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_vm_deliveries").get()?.n, 2);
  await f.run("four");
  await f.flush();
  assert.notEqual(f.row()!.vm_id, second);
});

test("refusal never creates or renews and an expired lease stops the row", async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  const f = fixture(t);
  f.flags.refused = true;
  await assert.rejects(f.run("one"), /no credit for compute/);
  assert.equal(f.calls.length, 0);
  f.flags.refused = false;
  await f.run("two");
  await f.flush();
  const original = f.row()!.deadline;
  t.mock.timers.tick(180_000);
  await f.sessions.wake(f.conf);
  assert.equal(f.row()!.deadline, original + 180_000);
  f.flags.refused = true;
  t.mock.timers.tick(180_000);
  await f.sessions.wake(f.conf);
  assert.equal(f.calls.filter(c => c.path.endsWith("/deadline")).length, 1);
  t.mock.timers.tick(600_000);
  f.vms.get(f.row()!.vm_id)!.phase = "ended";
  await f.sessions.wake(f.conf);
  assert.equal(f.row()!.state, "stopped");
  f.flags.refused = false;
  await f.run("three");
  await f.flush();
  f.flags.leaseExpired = true;
  t.mock.timers.tick(180_000);
  await f.sessions.wake(f.conf);
  assert.equal(f.row()!.state, "stopped");
});

test("replays each persisted boot/exec boundary without running twice", async t => {
  const f = fixture(t);
  for (const [flag, path] of [["crash", "/v1/vms"], ["crashAfter", "/v1/vms"], ["crash", "/shells"], ["crashAfter", "/shells"], ["crash", "/exec"], ["crashAfter", "/exec"]] as const) {
    f.flags[flag] = path;
    await assert.rejects(f.run("one"), /tier unreachable/);
    f.restart();
  }
  assert.equal((await f.run("one")).stdout, "ok");
  await f.flush();
  f.restart();
  assert.equal((await f.run("one")).stdout, "ok");
  assert.equal(f.flags.runs, 1);
  assert.equal(f.vms.size, 1);
});

test("keeps exact byte windows, resumes a dropped stream, and records a checkpoint failure", async t => {
  const f = fixture(t);
  const half = BASH_OUTPUT_KEEP / 2;
  const head = "a".repeat(half), tail = "b".repeat(half);
  f.flags.stdout = head + tail;
  const exact = await f.run("exact");
  assert.equal(exact.stdout, head + tail);
  assert.equal(exact.truncated, false);
  f.flags.stdout = head + "discard" + tail;
  const cut = await f.run("cut");
  assert.equal(cut.stdout, head + "\n[… 7 bytes truncated …]\n" + tail);
  assert.equal(cut.truncated, true);
  f.flags.stdout = "ok";
  f.flags.drop = true;
  assert.deepEqual(await f.run("dropped"), { stdout: "ok", stderr: "!", exitCode: 0, timedOut: false, truncated: false });
  await f.flush();
  f.flags.tailStatus = 410;
  f.flags.checkpointError = true;
  const lost = await f.run("lost");
  assert.equal(lost.exitCode, null);
  assert.equal(lost.stdout, "ok");
  assert.equal(lost.truncated, true);
  assert.equal(lost.checkpointError, undefined);
  await f.flush();
  assert.deepEqual(f.errors, ["host_unreachable"]);
  assert.equal((await f.run("lost")).checkpointError, "host_unreachable");
});


test("recovers a pending checkpoint after restart and records its head only when changed", async t => {
  const f = fixture(t);
  f.flags.unchanged = true;
  await f.run("unchanged");
  await f.flush();
  assert.equal(f.db.prepare("SELECT version FROM agent_vm_heads").get(), undefined);

  f.flags.unchanged = false;
  await f.run("pending");
  const before = f.calls.filter(call => call.path.endsWith("/checkpoint")).length;
  // Eviction before dispatch leaves the result and a pending checkpoint in SQLite.
  f.restart();
  await f.sessions.wake(f.conf);
  await f.flush();
  assert.equal(f.calls.filter(call => call.path.endsWith("/checkpoint")).length, before + 1);
  assert.equal(f.db.prepare("SELECT version FROM agent_vm_heads").get()?.version, "version");
});


test("replays an ambiguous renewal with the same deadline", async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  const f = fixture(t);
  await f.run("first");
  await f.flush();
  t.mock.timers.tick(180_000);
  f.flags.crashAfter = "/deadline";
  await f.sessions.wake(f.conf);
  const target = f.calls.at(-1)!.body.deadline;
  f.restart();
  t.mock.timers.tick(180_000);
  await f.sessions.wake(f.conf);
  assert.equal(f.calls.at(-1)!.body.deadline, target);
  assert.equal(f.row()!.deadline, target);
});

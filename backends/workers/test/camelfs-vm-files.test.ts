import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const { BashSessions } = await import("../src/camelfs/bash.ts");
const { vmFiles } = await import("../src/camelfs/vm-files.ts");
hooks.deregister();

const head = { version: "version", tree: "tree" };
const scope = { tenant: "t", agent: "agent", repo: "child", ref: "main" };
const branch = { lineage: "t:parent", ref: "fork/child/main", branch: JSON.stringify(["t:parent", "fork/child/main"]) };
const conf: Config = { tenantId: scope.tenant, id: scope.agent, revision: 1, expiresAt: null, config: {} };
const idleStopMs = 10_000;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "vm-files-"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
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
  const env = {
    CAMELFS_URL: "https://tier.example", AGENT_PUBLIC_URL: "https://runtime.example",
    CAMELFS_COMPUTE: "1", CAMELFS_POOLS: '{"default":"test"}', GUEST_IMAGE_SHA256: "a".repeat(64),
    CAMELFS_USAGE: { getByName: () => ({ start: async () => {} }) },
    TENANTS: { getByName: () => ({ repoRow: async () => ({ id: scope.repo, lineage: branch.lineage, deletedAt: null }) }) },
  } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const sessions = new BashSessions(storage, env, work => pending.push(work), async () => {}, async () => {}, async () => {});
  const activity: { event: string; execId: string; at: number }[] = [];
  const ops: string[] = [];
  const flags = { checkpoints: 0, create: 0, stopped: false, changed: false, checkpointGate: undefined as Promise<void> | undefined, bashGate: undefined as Promise<void> | undefined };
  let lastActivity = Date.now();
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    const [, , resource, id, op] = url.pathname.split("/");
    assert.equal(resource, "vms");
    if (!id) {
      flags.create++;
      return Response.json({ phase: "requested" });
    }
    if (!op) return Response.json({ phase: "running" });
    if (op === "shells") return Response.json({ shell: "agent-shell" });
    if (flags.stopped || (op === "exec" && Date.now() - lastActivity >= idleStopMs))
      return Response.json({ error: { code: "not_running" } }, { status: 409 });
    if (op === "checkpoint") {
      flags.checkpoints++;
      await flags.checkpointGate;
      return Response.json({ ...head, changed: flags.changed, diff: [] });
    }
    assert.equal(op, "exec");
    const body = JSON.parse(String(init.body));
    activity.push({ event: "ExecStarted", execId: body.execId, at: Date.now() });
    let stdout = "bash";
    if (body.stdin) {
      assert.equal(body.cwd, "/workspace");
      assert.equal(body.shell, undefined);
      assert.match(body.execId, /^vmfiles-[a-f0-9-]+$/);
      ops.push(JSON.parse(body.stdin).op);
      // The tier is fake. Run only the generated command against a local temporary directory.
      const result = spawnSync("bash", ["-lc", body.command], { cwd: dir, input: body.stdin, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 2000 });
      assert.equal(result.status, 0, result.stderr);
      stdout = result.stdout;
    } else {
      assert.equal(body.shell, "agent-shell");
      await flags.bashGate;
    }
    lastActivity = Date.now();
    activity.push({ event: "ExecEnded", execId: body.execId, at: lastActivity });
    return new Response(frame("stdout", { offset: 0, data: Buffer.from(stdout).toString("base64") }) +
      frame("exit", { code: 0, timedOut: false, ms: 1 }), { headers: { "Content-Type": "text/event-stream" } });
  });
  const get = (ref = scope.ref) => vmFiles({ ...env, bashSessions: sessions }, { ...scope, ref });
  const bash = (id: string) => sessions.execute(conf, branch, id, id, "run", { command: "true" });
  const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  return { db, dir, sessions, flags, activity, ops, get, bash, flush };
}

test("running branch uses isolated execs for every file operation", async t => {
  const f = fixture(t);
  assert.equal(await f.get(), undefined);
  await f.bash("boot");
  await f.flush();
  assert.equal(await f.get("another-branch"), undefined);
  const vm = (await f.get())!;
  const bytes = Buffer.from("first\nMATCH\nlast\n");
  const path = "nested/'literal $(false)";
  assert.deepEqual(await vm.write(path, bytes, { mode: "100755", expectSha256: "none" }), { size: bytes.length, sha256: sha(bytes) });
  await vm.write("nested/link", Buffer.from("elsewhere"), { mode: "120000" });
  assert.deepEqual(await vm.stat([path, "missing", "nested/link"]), {
    [path]: { size: bytes.length, mode: "100755", sha256: sha(bytes) },
    missing: null,
    "nested/link": { size: 9, mode: "120000", sha256: sha(Buffer.from("elsewhere")) },
  });
  const read = await vm.read(path, { offset: 6, length: 5 });
  assert.equal(Buffer.from(read.bytes).toString(), "MATCH");
  assert.equal(read.size, bytes.length);
  assert.equal(read.sha256, sha(bytes));
  assert.equal(Buffer.from((await vm.read("nested/link")).bytes).toString(), "elsewhere");
  assert.deepEqual(await vm.list({ limit: 1, recursive: true }), {
    entries: [{ path, size: bytes.length, mode: "100755" }], next: path,
  });
  assert.deepEqual(await vm.list({ prefix: "nested", after: path, limit: 1, recursive: true }), {
    entries: [{ path: "nested/link", size: 9, mode: "120000" }],
  });
  assert.deepEqual(await vm.list({ limit: 1, recursive: false }), {
    entries: [{ path: "nested", size: 0, mode: "040000" }],
  });
  assert.deepEqual(await vm.grep({ tree: "unused", q: "^match$", path: "nested/**", regex: true, ignoreCase: true, limit: 1, context: 1 }), {
    matches: [{ path, line: 2, text: "MATCH", before: ["first"], after: ["last"] }], files: 2, truncated: false,
  });
  await vm.delete([path], { expectSha256: { [path]: sha(bytes) } });
  await assert.rejects(vm.read(path), { status: 404, code: "no_file" });
  for (const bad of ["/absolute", "nested/../x", "nul\0"]) await assert.rejects(async () => vm.stat([bad]), { code: "bad_path" });
  symlinkSync(tmpdir(), join(f.dir, "outside"));
  await assert.rejects(vm.write("outside/no", bytes), { code: "no_file" });
  assert.deepEqual(f.ops, ["write", "write", "stat", "read", "read", "list", "list", "list", "grep", "delete", "read", "write"]);
  const started = f.activity.filter(x => x.event === "ExecStarted");
  assert.equal(new Set(started.map(x => x.execId)).size, started.length);
  await f.flush();
});

test("CAS refusals preserve files and reads allow a bounded range of a large file", async t => {
  const f = fixture(t);
  await f.bash("boot");
  const vm = (await f.get())!;
  const bytes = Buffer.alloc(1024 * 1024 + 1, 97);
  const written = await vm.write("large", bytes);
  assert.equal(written.sha256, sha(bytes));
  await assert.rejects(vm.read("large"), { code: "too_large", status: 413 });
  const exact = await vm.read("large", { length: 1024 * 1024 });
  assert.equal(exact.bytes.length, 1024 * 1024);
  assert.deepEqual(exact.bytes, new Uint8Array(bytes.subarray(0, exact.bytes.length)));
  await assert.rejects(vm.write("large", Buffer.from("overwrite"), { expectSha256: "none" }), { code: "stale_path", status: 412 });
  await assert.rejects(vm.write("missing/file", Buffer.from("create"), { expectSha256: written.sha256 }), { code: "stale_path" });
  await vm.write("other", Buffer.from("other"));
  await assert.rejects(vm.delete(["other", "large"], { expectSha256: { large: "0".repeat(64) } }), { code: "stale_path" });
  assert.ok((await vm.stat(["other"])).other);
  assert.equal((await vm.stat(["large"])).large?.sha256, written.sha256);
  await f.flush();
});

test("dirty writes checkpoint asynchronously and an explicit checkpoint waits for the pending save", async t => {
  const f = fixture(t);
  await f.bash("boot");
  await f.flush();
  const vm = (await f.get())!;
  await vm.write("a", Buffer.from("a"));
  assert.equal(f.flags.checkpoints, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_vm_calls WHERE checkpoint=1").get()?.n, 1);
  const gate = Promise.withResolvers<void>();
  f.flags.checkpointGate = gate.promise;
  const flush = f.flush();
  const save = vm.checkpoint();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.flags.checkpoints, 2);
  gate.resolve();
  assert.deepEqual(await save, head);
  await flush;
  assert.equal(f.flags.checkpoints, 2);
  await vm.write("b", Buffer.from("b"));
  f.flags.changed = true;
  await f.flush();
  assert.equal(f.flags.checkpoints, 3);
  assert.deepEqual(await vm.checkpoint(), head);
  assert.equal(f.flags.checkpoints, 3);
  assert.equal(f.db.prepare("SELECT version FROM agent_vm_heads").get()?.version, head.version);
});

test("file ops run beside a running bash command and wait only for a checkpoint in flight", async t => {
  const f = fixture(t);
  await f.bash("boot");
  await f.flush();
  const vm = (await f.get())!;
  await vm.write("a", Buffer.from("a"));
  await f.flush();
  const bashGate = Promise.withResolvers<void>();
  f.flags.bashGate = bashGate.promise;
  let bashDone = false;
  const long = f.bash("long").then(result => { bashDone = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(Buffer.from((await vm.read("a")).bytes).toString(), "a");
  await vm.write("b", Buffer.from("b"));
  assert.equal(bashDone, false);
  bashGate.resolve();
  f.flags.bashGate = undefined;
  await long;
  await f.flush();
  const checkpointGate = Promise.withResolvers<void>();
  f.flags.checkpointGate = checkpointGate.promise;
  f.flags.changed = true;
  const checkpoints = f.flags.checkpoints;
  await vm.write("c", Buffer.from("c"));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.flags.checkpoints, checkpoints + 1);
  let readDone = false;
  const read = vm.read("b").then(result => { readDone = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(readDone, false);
  checkpointGate.resolve();
  assert.equal(Buffer.from((await read).bytes).toString(), "b");
  await f.flush();
});

test("file exec resets idle activity, and a stopped VM fails without changing backend", async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  const f = fixture(t);
  await f.bash("boot");
  await f.flush();
  const vm = (await f.get())!;
  t.mock.timers.tick(5000);
  await vm.write("a", Buffer.from("a"));
  const [start, end] = f.activity.slice(-2);
  assert.deepEqual([start.event, end.event], ["ExecStarted", "ExecEnded"]);
  assert.equal(start.execId, end.execId);
  assert.equal(end.at, Date.now());
  t.mock.timers.tick(idleStopMs - 1);
  await f.bash("before-idle");
  await f.flush();
  assert.equal(f.flags.create, 1);
  f.flags.stopped = true;
  await assert.rejects(vm.read("a"), { status: 409, message: "the VM stopped; retry" });
  assert.equal(await f.get(), undefined);
  await assert.rejects(vm.checkpoint(), /the VM stopped; retry/);
});

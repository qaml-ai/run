import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { registerHooks } from "node:module";
import { applyScope } from "../../../shared/apply-scope.ts";
import type { WorkflowJobsEnv } from "../src/workflow-jobs.ts";
import type { StartedEffect, EffectOutcome } from "../src/workflow-runner.ts";
import { JobSpecError, type JobResult, type JobSpec } from "../src/jobs/job.ts";
import { fixture } from "./workflow-repo-fixture.ts";
import { harness, FakeCapacity } from "./workflow-harness.ts";

// The job and volume modules reach Durable Objects; a stand-in base class lets them load in Node.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {} export const waitUntil = p => p;", shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { WorkflowJobs, jobId, redact, PUSH_SCRIPT } = await import("../src/workflow-jobs.ts");
const { byKind, WorkflowObject } = await import("../src/workflow-object.ts");
const { BranchJanitor } = await import("../src/workflow-forks.ts");
hooks.deregister();
const run = promisify(execFile);

test("job() and push() hold job slots under jobConcurrency, apart from agents; commit() holds none", { timeout: 60_000 }, async () => {
  const capacity = new FakeCapacity(8);
  const h = harness({ capacity });
  h.init({
    code: `
      const built = await parallel(["a", "b", "c"], name => job({ key: "build:" + name, command: "make " + name, timeoutSeconds: 60 }));
      const reviewed = await agent("review", { key: "review" });
      const landed = await commit({repo:"repo_1",ref:"fork/one",base:{ref:"main",version:"v"}}, { key: "land" });
      const pushed = await push({ key: "push", volume: "vol_base", repo: "acme/app", branch: "wf", app: "gha_1" });
      return { built: built.map(b => b.exitCode), reviewed: reviewed.answer, landed, pushed };`,
    concurrency: 4, jobConcurrency: 2,
  });
  await h.wake();
  assert.equal(h.runner.get().jobConcurrency, 2);
  assert.deepEqual(h.world.queue.map(effect => [effect.key, effect.kind]), [["build:a", "job"], ["build:b", "job"]], "two jobs at once");
  assert.ok(capacity.calls.includes("acquire build:a job") && capacity.calls.includes("acquire build:b job"), JSON.stringify(capacity.calls));
  const answer = (effect: StartedEffect): EffectOutcome | undefined => {
    if (effect.kind === "job") return { ok: true, value: { exitCode: 0 } };
    if (effect.kind === "commit") return { ok: true, value: { committed: true, files: ["/a"] } };
    if (effect.kind === "push") return { ok: true, value: { pushed: true } };
    return undefined;
  };
  await h.next(answer);
  assert.deepEqual(h.world.queue.map(effect => effect.key), ["build:b", "build:c"], "a landed job's slot goes to the next");
  await h.run(answer);
  const result = h.runner.get();
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.result, { built: [0, 0, 0], reviewed: "re: review", landed: { committed: true, files: ["/a"] }, pushed: { pushed: true } });
  assert.ok(!capacity.calls.some(call => call.startsWith("acquire land")), "a commit takes no slot");
  assert.ok(capacity.calls.includes("acquire push job"));
  assert.throws(() => harness().init({ code: "return 1", jobConcurrency: 65, seed: 1, startedAt: 1 }), /jobConcurrency must be an integer from 1 to 64/);
});

test("the script's job(), commit() and push() check their arguments", { timeout: 60_000 }, async () => {
  for (const [code, message] of [
    [`return await job({ timeoutSeconds: 5 })`, /job\(\{ command \}\) needs a command/],
    [`return await job({ command: "true" })`, /job\(\) needs timeoutSeconds/],
    [`return await commit({})`, /commit\(fork\) needs a fork/],
    [`return await push({ volume: "v", repo: "a/b", branch: "x" })`, /push\(\{ volume, repo, branch, app \}\)/],
  ] as const) {
    const h = harness();
    h.init({ code });
    await h.wake();
    const state = h.runner.get();
    assert.equal(state.status, "failed", code);
    assert.match(state.error ?? "", message, code);
  }
});

test("byKind sends agents to the children, job/commit/push to the jobs, polls by kind, and recovers both", async () => {
  const calls: string[] = [];
  const executor = (name: string) => ({
    start: async (effect: StartedEffect) => { calls.push(`${name} start ${effect.kind}`); },
    cancel: async (effect: StartedEffect) => { calls.push(`${name} cancel ${effect.kind}`); },
    recover: async () => { calls.push(`${name} recover`); },
    abort: async () => { calls.push(`${name} abort`); },
  });
  const children = executor("children"), jobs = { ...executor("jobs"), poll: async (effect: StartedEffect) => { calls.push(`jobs poll ${effect.kind}`); return undefined; } };
  const both = byKind({ agent: children, job: jobs, commit: jobs, push: jobs });
  const effect = (kind: string) => ({ key: kind, attempt: 1, kind, args: {} });
  for (const kind of ["agent", "job", "commit", "push"]) await both.start(effect(kind));
  await both.cancel!(effect("job"));
  await both.poll!(effect("commit"));
  await both.recover!();
  await both.abort!();
  assert.deepEqual(calls, ["children start agent", "jobs start job", "jobs start commit", "jobs start push", "jobs cancel job", "jobs poll commit", "children recover", "jobs recover", "children abort", "jobs abort"]);
});

/** WorkflowJobs over a fake driver and storage: what it lands. */
function jobs(result: (spec: JobSpec) => JobResult | Promise<JobResult>, available = true, payer: string | null = "agent_owner", env = {} as WorkflowJobsEnv) {
  const rows = new Map<string, unknown>();
  const storage = {
    put: async (key: string, value: unknown) => { rows.set(key, value); },
    delete: async (key: string) => rows.delete(key),
    get: async (key: string) => rows.get(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
  };
  const landed: [string, number, unknown, unknown?][] = [], specs: JobSpec[] = [], pending: Promise<unknown>[] = [], stopped: string[] = [];
  const driver = { provider: "cloudflare-containers" as const, run: async (spec: JobSpec) => { specs.push(spec); return result(spec); }, stop: async (id: string) => { stopped.push(id); return { stopped: true }; } };
  const executor = new WorkflowJobs({ ...fixture({after: () => {}}).env, ...env }, {
    workflow: { id: "wf_1", tenant: "t1" }, storage: storage as never, payer: () => payer ?? undefined,
    land: async (key, attempt, outcome, usage) => { landed.push([key, attempt, outcome, usage]); },
    waitUntil: promise => { pending.push(promise); },
  }, () => available ? { ok: true, driver } : { ok: false, code: "JOBS_UNAVAILABLE", message: "Jobs need Cloudflare Containers" });
  return { executor, landed, specs, rows, stopped, settled: async () => { while (pending.length) await pending.shift(); } };
}
const effect = (key: string, args: Record<string, unknown>, kind = "job"): StartedEffect => ({ key, attempt: 1, kind, args });
const timings = { startedAt: 0, endedAt: 1, startMs: 0, syncMs: 0, commandMs: 0, collectMs: 0, totalMs: 1 };

test("WorkflowJobs: refusals and failures land as values; a job is paid by the workflow; a restart runs it again", async () => {
  // Off the pilot: a clear failure, no compute.
  let j = jobs(() => { throw new Error("no driver"); }, false);
  await j.executor.start(effect("a", { command: "true", timeoutSeconds: 5 }));
  await j.settled();
  assert.deepEqual(j.landed.map(entry => entry.slice(0, 3)), [["a", 1, { ok: false, error: "JOBS_UNAVAILABLE: Jobs need Cloudflare Containers" }]]);
  assert.equal(j.rows.size, 0, "its row goes once it lands");

  // A bad option fails the effect without starting anything.
  j = jobs(() => { throw new Error("never"); });
  await j.executor.start(effect("b", { command: "true", timeoutSeconds: 5, computer: "fresh" }));
  await j.settled();
  assert.match((j.landed[0]![2] as { error: string }).error, /job\(\) has no option computer/);
  assert.equal(j.specs.length, 0);

  // The payer's admission refused: a refusal (the workflow pauses), not a failure.
  j = jobs(spec => ({ ok: false, id: spec.id, code: "admission_refused", message: "The tenant has no credit left", timings }));
  await j.executor.start(effect("c", { command: "true", timeoutSeconds: 5, files: { "a.txt": "x" } }));
  await j.settled();
  assert.deepEqual(j.landed[0]![2], { refused: "The tenant has no credit left", code: "payer_exhausted" });
  const spec = j.specs[0]!;
  assert.deepEqual(spec.payer, { tenant: "t1", agent: "agent_owner" }, "the agent that owns the workflow pays");
  assert.equal(spec.id, await jobId("wf_1", "c", 1));
  assert.match(spec.id, /^wf-[0-9a-f]{40}$/);
  // With camelFS configured, inline files are committed on the job's branch of the workflow repo.
  assert.equal(spec.files, undefined); assert.equal(spec.repo?.ref, `job/${spec.id}`); assert.equal(spec.repo?.owner, "workflow:wf_1");

  // A failure lands its code; a run still held by an earlier start lands nothing (that run lands).
  j = jobs(spec => ({ ok: false, id: spec.id, code: "disk_low", message: "under 2 GiB free", timings }));
  await j.executor.start(effect("d", { command: "true", timeoutSeconds: 5 }));
  await j.settled();
  assert.deepEqual(j.landed[0]![2], { ok: false, error: "disk_low: under 2 GiB free" });
  j = jobs(spec => ({ ok: false, id: spec.id, code: "job_running", message: "running", timings }));
  await j.executor.start(effect("e", { command: "true", timeoutSeconds: 5 }));
  await j.settled();
  assert.equal(j.landed.length, 0);
  assert.equal(j.rows.size, 1, "kept, so the next restart asks again");

  // A restart: the row of a job started and not landed runs again; cancel stops its container.
  let runs = 0;
  j = jobs(spec => ({ ok: false, id: spec.id, code: runs++ ? "stopped" : "job_running", message: "x", timings }));
  await j.executor.start(effect("f", { command: "true", timeoutSeconds: 5 }));
  await j.settled();
  await j.executor.recover();
  await j.settled();
  assert.equal(j.specs.length, 2);
  assert.deepEqual(j.landed.map(entry => entry[0]), ["f"]);
  await j.executor.cancel(effect("f", {}));
  assert.deepEqual(j.stopped, [await jobId("wf_1", "f", 1)]);

  // A workflow an API key started has no owner agent: its tenant pays, under the workflow's id; a refusal of that
  // payer pauses it as an owner's would.
  j = jobs(spec => ({ ok: false, id: spec.id, code: "admission_refused", message: "This tenant has reached its monthly spend limit", timings }), true, null);
  await j.executor.start(effect("api", { command: "true", timeoutSeconds: 5 }));
  await j.settled();
  assert.deepEqual(j.specs[0]!.payer, { tenant: "t1", agent: "wf_1", kind: "workflow" }, "the workflow's tenant pays, under the workflow");
  assert.deepEqual(j.landed[0]![2], { refused: "This tenant has reached its monthly spend limit", code: "payer_exhausted" });

  // A failure's metered cost still reaches the workflow's ledger (the usage it lands with).
  j = jobs(spec => ({ ok: false, id: spec.id, code: "container_failed", message: "out of memory", timings, costUsd: 0.02 }));
  await j.executor.start(effect("oom", { command: "true", timeoutSeconds: 5 }));
  await j.settled();
  assert.deepEqual(j.landed[0]![3], { costUsd: 0.02, durationMs: 1 });

  // The sweep's poll runs again a job whose run threw (nothing in flight here), and never one in flight.
  let calls = 0;
  j = jobs(spec => { if (calls++ === 0) throw new Error("the container's object is unreachable"); return { ok: false, id: spec.id, code: "disk_low", message: "full", timings }; });
  await j.executor.start(effect("g", { command: "true", timeoutSeconds: 5 }));
  await j.settled();
  assert.equal(j.landed.length, 0);
  assert.equal(await j.executor.poll(effect("g", {})), undefined);
  await j.settled();
  assert.deepEqual(j.landed.map(entry => entry[0]), ["g"]);
  assert.equal(j.rows.size, 0);

  // commit() lands from the background: start returns while its landing waits (the runner holds its queue while it
  // starts effects, and a landing waits on that queue, so a start that awaited it would never return).
  j = jobs(() => { throw new Error("never"); });
  let release!: () => void;
  const queue = new Promise<void>(resolve => { release = resolve; });
  const host = j.executor as unknown as { host: { land: (...args: unknown[]) => Promise<void> } };
  const land = host.host.land;
  host.host.land = async (...args) => { await queue; return land(...args); };
  await j.executor.start(effect("h", { fork: 7 }, "commit"));
  assert.equal(j.landed.length, 0);
  release();
  await j.settled();
  assert.deepEqual(j.landed.map(entry => [entry[0], (entry[2] as { error?: string }).error]), [["h", "commit() needs { fork: { repo, ref, base } }"]]);
});

test("WorkflowJobs: commit needs at and a boolean", async () => {
  for (const [commit, error] of [[true, "job() commit needs at: the volume whose tree it checkpoints"], ["true", "job() commit is true or false"]]) {
    const j = jobs(() => { throw new Error("never"); });
    await j.executor.start(effect("checkpoint", { command: "true", timeoutSeconds: 5, commit }));
    await j.settled();
    assert.deepEqual(j.landed[0]![2], { ok: false, error });
    assert.equal(j.specs.length, 0);
  }
});

test("WorkflowJobs: a checkpoint's ids, errors and timings reach the script", async t => {
  const checkpoint = { walkMs: 1, streamMs: 2, freezeMs: 3, files: 4, bytes: 5, skipped: 6,
    changedChunks: 7, uploadedChunks: 8, changedBytes: 9, reflinkMs: 10, fiemapMs: 11, hashMs: 12, uploadMs: 13 };
  const step = { warm: true, mountMs: 2, applyMs: 3, checkpointMs: 4, checkpoint };
  for (const fields of [{ commit: "c".repeat(40), tree: "b".repeat(40), root: "r" }, { checkpointError: "checkpoint failed" }]) {
    const written: string[] = [];
    const env = { ...fixture(t).env, VOLUMES: { getByName: () => ({
      initialize: async () => {}, snapshot: async () => ({ id: "snapshot" }),
      write: async (path: string) => { written.push(path); return { path }; },
    }) } } as unknown as WorkflowJobsEnv;
    const sql = { query: async (text: string) => {
      if (text.startsWith("SELECT name,created_at")) return { rows: [{ name: "test", created_at: 0, tenant: "t1", deleted_at: null }], rowCount: 1 };
      if (text.startsWith("INSERT INTO volumes")) return { rows: [], rowCount: 1 };
      if (text.includes("billing_accounts") || text === "select billing, limits from tenants where id = $1") return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected SQL: ${text}`);
    } };
    await applyScope.run({ sql: sql as never }, async () => {
      const j = jobs(spec => ({ ok: true, id: spec.id, instance: "standard-1", exitCode: 1, timedOut: false,
        stdout: { bytes: new Uint8Array(), size: 0, truncated: false }, stderr: { bytes: new Uint8Array(), size: 0, truncated: false },
        outputs: {}, missing: [], timings: { ...timings, steps: { hostMs: 5 } }, camelfs: { ...step, ...fields },
      }), true, "agent_owner", env);
      await j.executor.start(effect("checkpoint", { command: "false", timeoutSeconds: 5, at: "vol_source", commit: true }));
      await j.settled();
      assert.equal(j.specs[0]?.commit, true);
      assert.deepEqual(j.specs[0]?.volume, { tenant: "t1", volume: "vol_source", snapshot: "snapshot" });
      const outcome = j.landed[0]?.[2] as { ok: boolean; value: Record<string, any> };
      assert.equal(outcome?.ok, true);
      for (const key of ["commit", "tree", "root", "checkpointError"] as const) assert.equal(outcome.value[key], fields[key as keyof typeof fields]);
      assert.deepEqual(outcome.value.timings.camelfs, step);
      assert.equal(outcome.value.timings.steps.hostMs, 5);
      for (const name of ["snapshotMs", "driverMs", "keepMs"]) {
        assert.equal(typeof outcome.value.timings.steps[name], "number");
        assert.ok(Number.isInteger(outcome.value.timings.steps[name]) && outcome.value.timings.steps[name] >= 0, name);
      }
      assert.equal(outcome.value.exitCode, 1);
      assert.match(String(outcome.value.repo), /^repo_/);
      assert.match(String(outcome.value.version), /^[0-9a-f]{40}$/);
    });
  }
});

test("WorkflowJobs: commit without camelFS, or refused by the driver, lands as the script's error and is not retried", async t => {
  const without = jobs(() => assert.fail("no job runs"));
  delete (without.executor as any).env.CAMELFS;
  await without.executor.start(effect("nofs", { command: "true", timeoutSeconds: 5, at: "vol_source", commit: true }));
  await without.settled();
  assert.deepEqual(without.landed[0]![2], { ok: false, error: "job() commit needs camelFS job hosts, which this deployment does not have" });
  const env = { ...fixture(t).env, VOLUMES: { getByName: () => ({
    initialize: async () => {}, snapshot: async () => ({ id: "snapshot" }),
  }) } } as unknown as WorkflowJobsEnv;
  const sql = { query: async (text: string) => {
    if (text.startsWith("SELECT name,created_at")) return { rows: [{ name: "test", created_at: 0, tenant: "t1", deleted_at: null }], rowCount: 1 };
    throw new Error(`Unexpected SQL: ${text}`);
  } };
  await applyScope.run({ sql: sql as never }, async () => {
    const refused = jobs(() => { throw new JobSpecError("commit needs camelFS job hosts; Cloudflare containers cannot checkpoint a job's tree"); }, true, "agent_owner", env);
    await refused.executor.start(effect("containers", { command: "true", timeoutSeconds: 5, at: "vol_source", commit: true }));
    await refused.settled();
    assert.deepEqual(refused.landed[0]![2], { ok: false, error: "commit needs camelFS job hosts; Cloudflare containers cannot checkpoint a job's tree" });
    assert.equal([...refused.rows.keys()].filter(key => key.startsWith("workflow-job:")).length, 0, "its row is gone: no sweep runs it again");
  });
});

test("redact replaces a token wherever a command printed it", () => {
  const token = "ghs_abcdefghijklmnopqrstuvwxyz123456";
  assert.equal(redact(`fatal: could not read from https://x-access-token:${token}@github.com\n${token}`, [token]), "fatal: could not read from https://x-access-token:***@github.com\n***");
  assert.equal(redact("short", ["abc"]), "short", "too short a secret is never matched");
});

test("the push job writes the volume's tree on the branch, from the branch if it exists, and pushes nothing new twice", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "push-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args: string[], cwd = root) => run("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  // A remote with one commit on main, standing in for github.com/acme/app.
  await git(["init", "-q", "--bare", "-b", "main", join(root, "remote.git")]);
  await git(["clone", "-q", join(root, "remote.git"), join(root, "seed")]);
  await writeFile(join(root, "seed", "old.txt"), "old\n");
  await writeFile(join(root, "seed", "keep.txt"), "keep\n");
  await git(["add", "-A"], join(root, "seed"));
  await git(["commit", "-q", "-m", "seed"], join(root, "seed"));
  await git(["push", "-q", "origin", "HEAD:main"], join(root, "seed"));
  // The volume's tree: keep.txt changed, old.txt gone, src/new.txt new.
  const source = join(root, "volume");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "keep.txt"), "kept and changed\n");
  await writeFile(join(source, "src", "new.txt"), "new\n");
  const token = "ghs_fake_token_value_that_must_not_print";
  const env = {
    PATH: process.env.PATH!, HOME: root, GIT_PUSH_TOKEN: token, PUSH_REPO: "acme/app", PUSH_BRANCH: "wf/edits", PUSH_MESSAGE: "workflow edits",
    PUSH_NAME: "camelRun workflow", PUSH_EMAIL: "workflows@camelai.com", PUSH_DATE: "@1700000000 +0000", PUSH_SOURCE: source,
    // github.com/acme/app is the local remote here.
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${join(root, "remote.git")}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/acme/app.git",
  };
  const first = await run("bash", ["-c", PUSH_SCRIPT], { cwd: root, env });
  assert.match(first.stdout, /^PUSH_RESULT pushed [0-9a-f]{40}$/m);
  assert.ok(!first.stdout.includes(token) && !first.stderr.includes(token));
  const files = (await git(["ls-tree", "-r", "--name-only", "wf/edits"], join(root, "remote.git"))).stdout.trim().split("\n");
  assert.deepEqual(files, ["keep.txt", "src/new.txt"]);
  assert.equal((await git(["log", "--format=%s %P", "-1", "wf/edits"], join(root, "remote.git"))).stdout.trim().split(" ")[0], "workflow");
  assert.equal((await git(["rev-list", "--count", "wf/edits"], join(root, "remote.git"))).stdout.trim(), "2", "built on main's history");
  // Run again (a job made again after a restart): the branch already holds the tree.
  const again = await run("bash", ["-c", PUSH_SCRIPT], { cwd: root, env });
  assert.match(again.stdout, /^PUSH_RESULT unchanged [0-9a-f]{40}$/m);
  assert.equal((await git(["rev-list", "--count", "wf/edits"], join(root, "remote.git"))).stdout.trim(), "2");
});

test("a workflow's forks are deleted once it ends; a failed delete is tried again later, never while a commit is landing", async () => {
  const rows = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => rows.get(key),
    put: async (key: string, value: unknown) => { rows.set(key, value); },
    delete: async (key: string) => rows.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
  };
  let now = 1_000_000;
  const deleted: string[] = [], failing = new Set<string>();
  const janitor = () => new BranchJanitor({ storage: storage as never, now: () => now, deleteOwned: async id => {
    if (failing.has(id)) throw new Error("storage unavailable");
    deleted.push(id); return { held: [] };
  } });
  let forks = janitor();
  await storage.put("workflow-repo:" + "vol_a", true);
  await storage.put("workflow-repo:" + "vol_b", true);
  await storage.put("workflow-repo:" + "vol_c", true);
  // A commit still landing (its row in WorkflowJobs) keeps every fork: it is tried again later.
  rows.set("workflow-job:wf-1", { kind: "commit", key: "land", attempt: 1 });
  assert.equal(await forks.ended(), now + 60_000);
  assert.deepEqual(deleted, []);
  rows.delete("workflow-job:wf-1");
  // One delete fails: the others go, and the retry backs off.
  failing.add("vol_b");
  assert.equal(await forks.ended(), now + 120_000);
  assert.deepEqual(deleted, ["vol_a", "vol_c"]);
  assert.equal(await forks.retryAt(), now + 120_000);
  // A crash, then the alarm: a new instance over the same storage finishes it, and the retry is cleared.
  failing.clear();
  now += 120_000;
  forks = janitor();
  assert.equal(await forks.ended(), undefined);
  assert.deepEqual(deleted, ["vol_a", "vol_c", "vol_b"]);
  assert.equal(await forks.retryAt(), undefined);
  assert.equal([...rows.keys()].filter(key => key.startsWith("workflow-repo")).length, 0);
  // Nothing left: ending again does nothing.
  assert.equal(await forks.ended(), undefined);
  assert.equal(deleted.length, 3);
});

test("a job, commit or push whose landing a crash lost is found by the alarm's sweep, with no capacity alarm to wake it", { timeout: 60_000 }, async () => {
  for (const kind of ["job", "commit", "push"] as const) {
    const h = harness();
    const call = kind === "job" ? `job({ key: "k", command: "true", timeoutSeconds: 5 })`
      : kind === "commit" ? `commit({repo:"repo_1",ref:"fork/one",base:{ref:"main",version:"v"}}, { key: "k" })` : `push({ key: "k", volume: "v", repo: "a/b", branch: "x", app: "gha_1" })`;
    h.init({ code: `return await ${call};` });
    await h.wake();
    assert.deepEqual(h.world.queue.map(effect => effect.kind), [kind]);
    // The landing is lost: nothing will deliver it. The sweep must still be armed for it.
    h.world.queue.splice(0);
    (h.world as unknown as { answer: (effect: StartedEffect) => EffectOutcome }).answer = () => ({ ok: true, value: { landed: kind } });
    assert.notEqual(h.alarmAt, null, `${kind}: an unlanded ${kind} keeps the sweep's alarm armed`);
    for (let guard = 0; guard < 5 && h.runner.get().status !== "completed"; guard++) {
      h.clock = Math.max(h.clock, h.alarmAt!);
      await h.runner.alarm();
    }
    assert.equal(h.runner.get().status, "completed", kind);
    assert.deepEqual(h.runner.get().result, { landed: kind });
  }
});

test('keep writes outputs and both streams in one commit with stable paths', async t => {
  const f = fixture(t);
  const bytes = (s: string) => new TextEncoder().encode(s);
  const j = jobs(spec => ({ok:true,id:spec.id,instance:'standard-1',exitCode:0,timedOut:false,
    stdout:{bytes:bytes('stdout'),size:6,truncated:false},stderr:{bytes:bytes('stderr'),size:6,truncated:false},
    outputs:{'report.txt':{bytes:bytes('report'),size:6,truncated:false}},missing:[],timings}),true,'agent_owner',f.env);
  await j.executor.start(effect('keep',{command:'true',timeoutSeconds:5,outputs:['report.txt']}));
  await j.settled();
  const value = (j.landed[0][2] as any).value;
  const repo = f.env.REPOS.getByName(`t1:${value.repo}`), refs = repo.refs();
  const head = await repo.commit(value.version);
  assert.equal(head.parents.length,1);
  assert.equal((await repo.commit(head.parents[0])).parents.length,0,'one commit after repo creation');
  const files = (await repo.list({version:value.version,limit:100})).entries;
  const id = await jobId('wf_1','keep',1);
  assert.deepEqual(files.map((f:any)=>f.path).sort(),[`jobs/${id}/out/report.txt`,`jobs/${id}/stderr.txt`,`jobs/${id}/stdout.txt`]);
  assert.equal(refs.find((r:any)=>r.name==='main').version,value.version);
  assert.equal(value.volume,undefined);
});

test('commit merges cleanly, reports conflicts, rejects snapshots and retries storage failures', async t => {
  const f = fixture(t), ctx = await f.create();
  const { childBranch, repoAt } = await import('../src/workflow-branches.ts');
  const mem = { get:async()=>undefined,put:async()=>{} };
  const fork = await childBranch(f.env,'t',mem as never,{workflow:'wf_1',key:'a',attempt:1},repoAt(ctx.repoId));
  await f.write(ctx,{a:{bytes:new TextEncoder().encode('one')}},{ref:fork.ref});
  const j = jobs(()=>{throw new Error('no job')},true,'agent_owner',f.env);
  // The fixture tenant registry is shared; the repo belongs to t, matching the workflow's tenant here.
  (j.executor as any).host.workflow.tenant='t';
  await j.executor.start(effect('merge',{fork},'commit')); await j.settled();
  assert.equal((j.landed[0][2] as any).value.committed,true);
  await j.executor.start(effect('again',{fork},'commit')); await j.settled();
  assert.equal((j.landed[1][2] as any).value.changed,false);
  await j.executor.start(effect('snapshot',{fork,snapshot:'old'},'commit')); await j.settled();
  assert.match((j.landed[2][2] as any).error,/no snapshot/);
  const bare = {...fork,base:{version:fork.base.version}};
  await j.executor.start(effect('bare',{fork:bare},'commit')); await j.settled();
  assert.match((j.landed[3][2] as any).error,/no base ref/);
  const conflicting = await childBranch(f.env,'t',mem as never,{workflow:'wf_1',key:'conflict',attempt:1},repoAt(ctx.repoId));
  await f.write(ctx,{a:{bytes:new TextEncoder().encode('ours')}});
  await f.write(ctx,{a:{bytes:new TextEncoder().encode('theirs')}},{ref:conflicting.ref});
  await j.executor.start(effect('conflict',{fork:conflicting},'commit')); await j.settled();
  const conflict = (j.landed[4][2] as any).value;
  assert.equal(conflict.committed,false);
  assert.equal(conflict.conflicts[0].path,'a');
  assert.equal(conflict.conflicts[0].reason,'both_modified');
  const fetch = f.env.CAMELFS.fetch;
  f.env.CAMELFS.fetch = async () => { throw new Error('storage unavailable'); };
  await j.executor.start(effect('retry',{fork:conflicting},'commit')); await j.settled();
  assert.equal(j.landed.length,5,'storage failures do not land');
  assert.ok([...j.rows.values()].some((row:any)=>row.key==='retry'&&row.kind==='commit'));
  f.env.CAMELFS.fetch = fetch;
  await j.executor.recover(); await j.settled();
  assert.equal((j.landed[5][2] as any).value.committed,false);
  assert.equal(j.rows.size,0);

});

test('result cache keys on trees and recreates branches; a missing version is a logged miss', async t => {
  const f = fixture(t), ctx = await f.create(), old = await ctx.stub.resolve('main');
  const rows = new Map<string, unknown>(), keys: string[] = [];
  let cached: any;
  const cache = { lookup: async (_kind: string,key: string) => { keys.push(key); return cached; } };
  const storage = {get:async(k:string)=>rows.get(k),put:async(k:string,v:unknown)=>{rows.set(k,v);}};
  const self = {ctx:{storage},results:()=>({tenant:'t',cache}),settings:()=>({})};
  const results = (WorkflowObject.prototype as any).resultCache.call(self,f.env,'wf_new');
  const args = JSON.stringify({at:{repo:ctx.repoId},command:'true'});
  await results.lookup('job',args,{key:'j',attempt:1});
  await f.write(ctx,{}, {allowEmpty:true});
  await results.lookup('job',args,{key:'j',attempt:1});
  assert.equal(keys[0],keys[1],'new versions with equal trees share keys');
  const agent = JSON.stringify({prompt:'edit',repo:ctx.repoId,model:'test/model'});
  cached = {value:{text:'cached'},source:'old:k:1',fork:{repo:ctx.repoId,version:old.version}};
  const hit = await results.lookup('agent',agent,{key:'a',attempt:1});
  assert.equal((await ctx.stub.resolve(hit.hit.value.fork.ref)).version,old.version);
  assert.equal(rows.get(`workflow-repo:${ctx.repoId}`),true);
  cached = {...cached,fork:{repo:ctx.repoId,version:'f'.repeat(40)}};
  const lines: string[] = [], error = console.error;
  console.error = line => lines.push(line);
  try {
    const miss = await results.lookup('agent',agent,{key:'missing',attempt:1});
    assert.equal(miss.hit,undefined);
    assert.equal(JSON.parse(lines[0]).type,'workflow_cache_fork_missing');
  } finally { console.error = error; }
});

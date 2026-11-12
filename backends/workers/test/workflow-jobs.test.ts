import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { registerHooks } from "node:module";
import type { StartedEffect, EffectOutcome } from "../src/workflow-runner.ts";
import type { JobResult, JobSpec } from "../src/jobs/job.ts";
import { harness, FakeCapacity } from "./workflow-harness.ts";

// The job and volume modules reach Durable Objects; a stand-in base class lets them load in Node.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}", shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { WorkflowJobs, jobId, redact, PUSH_SCRIPT } = await import("../src/workflow-jobs.ts");
const { byKind } = await import("../src/workflow-object.ts");
const { forkChanges } = await import("../src/workflow-volumes.ts");
const { ForkJanitor } = await import("../src/workflow-forks.ts");
hooks.deregister();
const run = promisify(execFile);

test("job() and push() hold job slots under jobConcurrency, apart from agents; commit() holds none", { timeout: 60_000 }, async () => {
  const capacity = new FakeCapacity(8);
  const h = harness({ capacity });
  h.init({
    code: `
      const built = await parallel(["a", "b", "c"], name => job({ key: "build:" + name, command: "make " + name, timeoutSeconds: 60 }));
      const reviewed = await agent("review", { key: "review" });
      const landed = await commit("vol_fork", { key: "land" });
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

test("byKind sends agents and gates to the children, job/commit/push to the jobs, polls by kind, and recovers both", async () => {
  const calls: string[] = [];
  const executor = (name: string) => ({
    start: async (effect: StartedEffect) => { calls.push(`${name} start ${effect.kind}`); },
    cancel: async (effect: StartedEffect) => { calls.push(`${name} cancel ${effect.kind}`); },
    recover: async () => { calls.push(`${name} recover`); },
    abort: async () => { calls.push(`${name} abort`); },
  });
  const children = executor("children"), jobs = { ...executor("jobs"), poll: async (effect: StartedEffect) => { calls.push(`jobs poll ${effect.kind}`); return undefined; } };
  const both = byKind({ agent: children, gate: children, job: jobs, commit: jobs, push: jobs });
  const effect = (kind: string) => ({ key: kind, attempt: 1, kind, args: {}, options: undefined, phase: undefined });
  for (const kind of ["agent", "gate", "job", "commit", "push"]) await both.start(effect(kind));
  await both.cancel!(effect("job"));
  await both.poll!(effect("commit"));
  await both.recover!();
  await both.abort!();
  assert.deepEqual(calls, ["children start agent", "children start gate", "jobs start job", "jobs start commit", "jobs start push", "jobs cancel job", "jobs poll commit", "children recover", "jobs recover", "children abort", "jobs abort"]);
});

/** WorkflowJobs over a fake driver and storage: what it lands. */
function jobs(result: (spec: JobSpec) => JobResult | Promise<JobResult>, available = true, payer: string | null = "agent_owner") {
  const rows = new Map<string, unknown>();
  const storage = {
    put: async (key: string, value: unknown) => { rows.set(key, value); },
    delete: async (key: string) => rows.delete(key),
    get: async (key: string) => rows.get(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
  };
  const landed: [string, number, unknown, unknown?][] = [], specs: JobSpec[] = [], pending: Promise<unknown>[] = [], stopped: string[] = [];
  const driver = { provider: "cloudflare-containers" as const, run: async (spec: JobSpec) => { specs.push(spec); return result(spec); }, stop: async (id: string) => { stopped.push(id); return { stopped: true }; } };
  const executor = new WorkflowJobs({} as never, {
    workflow: { id: "wf_1", tenant: "t1" }, storage: storage as never, payer: () => payer ?? undefined,
    land: async (key, attempt, outcome, usage) => { landed.push([key, attempt, outcome, usage]); },
    waitUntil: promise => { pending.push(promise); },
  }, () => available ? { ok: true, driver } : { ok: false, code: "JOBS_UNAVAILABLE", message: "Jobs need Cloudflare Containers" });
  return { executor, landed, specs, rows, stopped, settled: async () => { while (pending.length) await pending.shift(); } };
}
const effect = (key: string, args: Record<string, unknown>, kind = "job"): StartedEffect => ({ key, attempt: 1, kind, args, options: undefined, phase: undefined });
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
  assert.deepEqual(Object.keys(spec.files!), ["a.txt"]);

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
  assert.deepEqual(j.landed.map(entry => [entry[0], (entry[2] as { error?: string }).error]), [["h", "commit() needs a fork's volume id"]]);
});

test("a fork's changes: written paths are those whose content differs from the base it was made from; removed ones", () => {
  const file = (path: string, key: string, version = 1) => ({ path, key, version, size: 1, contentType: "text/plain", updatedAt: 0 });
  const { written, removed, before } = forkChanges(
    [file("/same", "k1"), file("/changed", "k2"), file("/gone", "k3", 4)],
    [file("/same", "k1"), file("/changed", "k9", 7), file("/new", "k5", 8)],
  );
  assert.deepEqual(written.map(entry => entry.path), ["/changed", "/new"]);
  assert.deepEqual(removed.map(entry => [entry.path, entry.version]), [["/gone", 4]]);
  assert.equal(before.get("/changed")?.version, 1, "the base version the commit checks");
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
  const janitor = () => new ForkJanitor({ storage: storage as never, now: () => now, deleteFork: async id => {
    if (failing.has(id)) throw new Error("storage unavailable");
    deleted.push(id);
  } });
  let forks = janitor();
  await forks.made("vol_a");
  await forks.made("vol_b");
  await forks.made("vol_c");
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
  assert.equal([...rows.keys()].filter(key => key.startsWith("workflow-fork")).length, 0);
  // Nothing left: ending again does nothing.
  assert.equal(await forks.ended(), undefined);
  assert.equal(deleted.length, 3);
});

test("at the end, a fork the result cache adopts is handed over, not deleted; the rest are deleted; one it cannot tell about waits", async () => {
  const rows = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => rows.get(key),
    put: async (key: string, value: unknown) => { rows.set(key, value); },
    delete: async (key: string) => rows.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
  };
  const deleted: string[] = [];
  let unsure = true;
  const forks = new ForkJanitor({ storage: storage as never, now: () => 1_000, deleteFork: async id => { deleted.push(id); },
    adopt: async id => { if (id === "vol_unsure" && unsure) throw new Error("the cache is down"); return id === "vol_kept"; } });
  await forks.made("vol_kept");
  await forks.made("vol_free");
  await forks.made("vol_unsure");
  assert.equal(await forks.ended(), 1_000 + 60_000, "tried again later");
  assert.deepEqual(deleted, ["vol_free"]);
  assert.deepEqual([...rows.keys()].filter(key => key.startsWith("workflow-fork:")), ["workflow-fork:vol_unsure"], "the cache's fork is forgotten here");
  unsure = false;
  assert.equal(await forks.ended(), undefined);
  assert.deepEqual(deleted, ["vol_free", "vol_unsure"]);
});
test("a job, commit or push whose landing a crash lost is found by the alarm's sweep, with no capacity alarm to wake it", { timeout: 60_000 }, async () => {
  for (const kind of ["job", "commit", "push"] as const) {
    const h = harness();
    const call = kind === "job" ? `job({ key: "k", command: "true", timeoutSeconds: 5 })`
      : kind === "commit" ? `commit("vol_fork", { key: "k" })` : `push({ key: "k", volume: "v", repo: "a/b", branch: "x", app: "gha_1" })`;
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

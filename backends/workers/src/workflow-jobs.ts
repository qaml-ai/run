import { StorageError } from "./repos/storage.ts";
// The workflow's `job()`, `commit()` and `push()` effects (docs/design/swarm-workflows.md, "Jobs: the ephemeral compute
// boundary"). A job runs through the JobDriver (jobs/driver.ts) on its own container, paid by the agent that owns the
// workflow (its metering, receipts and spend limits), or, for a workflow an API key started, by its tenant under the
// workflow's id (computers/meter-billing.ts); the cost also lands in the workflow's ledger. It runs in a job slot of the
// capacity limiter the runner holds for it; its named outputs and its
// output streams are kept in the workflow's repo, and the script gets a small result that names them. A commit lands
// a child's fork on its base (workflow-branches.ts). A push is a job that writes a volume to a GitHub branch with the
// GitHub App's installation token, which only the job's process sees.
import { createRepo, repoContext, type RepoEnv } from "./repos/registry.ts";
import { commitChanges, type WriteInput } from "./repos/write.ts";
import { mergeRefs } from "./repos/merge.ts";
import { repoErrorFrom } from "./repos/repo-policy.ts";
import { repoAt, type RepoAt } from "./repos/target.ts";
import type { WorkflowFork } from "./workflow-branches.ts";
import { volume, type FileBindings } from "./files.ts";
import { workerGitHubApps, type GitHubAppsEnv } from "./github-apps.ts";
import { camelfsConfigured, type CamelfsEnv } from "./jobs/camelfs.ts";
import { jobDriver, type JobDriver, type JobDriverEnv } from "./jobs/driver.ts";
import { JOB_LIMITS, JobSpecError, jobVolume, type JobResult, type JobSpec, type JobStream } from "./jobs/job.ts";
import { digest } from "./volume.ts";
import { WORKFLOW_LIMITS, type EffectExecutor, type EffectOutcome, type EffectUsage, type StartedEffect } from "./workflow-runner.ts";

export type WorkflowJobsEnv = FileBindings & JobDriverEnv & GitHubAppsEnv & CamelfsEnv;

export interface WorkflowJobsHost {
  workflow: { id: string; tenant: string };
  /**
   * Who pays for its jobs: the agent that owns the workflow (it started it with the `workflows` builtin), whose metering,
   * receipts and spend limits the container time goes through. Undefined for a workflow an API key started: its tenant
   * pays, under the workflow's id (its spend limit and credit admit the job; its usage shows the workflow).
   */
  payer(): string | undefined;
  /** The effect ended: `WorkflowRunner.land`. A second landing is ignored by the runner. */
  land(key: string, attempt: number, outcome: EffectOutcome | { refused: string; code: "payer_exhausted" }, usage?: EffectUsage): Promise<void>;
  /** Keep a job's run alive past the call that started it. */
  waitUntil(promise: Promise<unknown>): void;
  storage: DurableObjectStorage;
}

/** How long the snapshot a job syncs from (its `at` volume) is kept: the job's whole life, with room. */
const SYNC_SNAPSHOT_TTL_MS = 86_400_000;
/** Of each stream, what the script sees inline (its end): the whole stream is in the workflow's repo. */
const TAIL_CHARS = 1_500;
const ROW = "workflow-job:";

/** The job's id: one per effect `key:attempt`, so a run made again is the same job (its container object, its slot). */
export async function jobId(workflow: string, key: string, attempt: number) {
  return `wf-${(await digest(new TextEncoder().encode(`${workflow}\n${key}\n${attempt}`))).slice(0, 40)}`;
}

/** Replace every secret in `text` (a token a command printed), so no result or log carries it. */
export function redact(text: string, secrets: string[]) {
  return secrets.filter(secret => secret.length >= 8).reduce((out, secret) => out.split(secret).join("***"), text);
}

const decoder = new TextDecoder();
type JobArgs = {
  command: string; timeoutSeconds: number; outputs?: string[]; limits?: JobSpec["limits"]; internet?: boolean;
  /** A volume of the tenant's whose files the job starts with, in /repo (synced from a snapshot taken now). */
  at?: string | RepoAt;
  /** Checkpoint /repo when the command ends; needs `at` and camelFS job hosts. */
  commit?: boolean;
  /** Small files given inline, path to text. */
  files?: Record<string, string>;
};
type PushArgs = { volume: string; repo: string; branch: string; app: string; message?: string; installation?: number; timeoutSeconds?: number };

/** Push a volume's tree (in /repo) onto `branch`: cloned from it if it exists, else from the default branch. */
export const PUSH_SCRIPT = String.raw`set -euo pipefail
PUSH_SOURCE=$(printenv PUSH_SOURCE || true)
helper='!f() { echo username=x-access-token; echo "password=$GIT_PUSH_TOKEN"; }; f'
remote="https://github.com/$PUSH_REPO.git"
export GIT_TERMINAL_PROMPT=0 GIT_AUTHOR_NAME="$PUSH_NAME" GIT_AUTHOR_EMAIL="$PUSH_EMAIL" GIT_COMMITTER_NAME="$PUSH_NAME" GIT_COMMITTER_EMAIL="$PUSH_EMAIL"
export GIT_AUTHOR_DATE="$PUSH_DATE" GIT_COMMITTER_DATE="$PUSH_DATE"
work=$(mktemp -d)
if ! git -c credential.helper="$helper" clone -q --depth 1 --branch "$PUSH_BRANCH" "$remote" "$work" 2>/dev/null; then
  git -c credential.helper="$helper" clone -q --depth 1 "$remote" "$work"
  git -C "$work" checkout -q -b "$PUSH_BRANCH"
fi
find "$work" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
src=$PUSH_SOURCE; [ -n "$src" ] || src=/repo
(cd "$src" && tar cf - --exclude=./.git .) | (cd "$work" && tar xf -)
cd "$work"
git add -A
if git diff --cached --quiet; then echo "PUSH_RESULT unchanged $(git rev-parse HEAD)"; exit 0; fi
git commit -q -m "$PUSH_MESSAGE"
git -c credential.helper="$helper" push -q origin "HEAD:refs/heads/$PUSH_BRANCH"
echo "PUSH_RESULT pushed $(git rev-parse HEAD)"`;

export class WorkflowJobs implements EffectExecutor {
  private readonly env: WorkflowJobsEnv;
  private readonly host: WorkflowJobsHost;
  private readonly driver: () => ReturnType<typeof jobDriver>;
  /** Runs this instance has in flight, by job id: a restart has none, and runs again what its rows hold. */
  private readonly running = new Map<string, Promise<void>>();
  constructor(env: WorkflowJobsEnv, host: WorkflowJobsHost, driver: () => ReturnType<typeof jobDriver> = () => jobDriver(env)) {
    this.env = env; this.host = host; this.driver = driver;
  }

  /**
   * Start an effect: its row, then its work in the background. It lands from there, never from inside this call, which
   * the runner makes while it holds its queue (a landing waits on that queue).
   */
  async start(effect: StartedEffect): Promise<void> {
    if (effect.kind !== "job" && effect.kind !== "push" && effect.kind !== "commit") throw new Error(`WorkflowJobs runs job(), commit() and push(), not ${effect.kind}()`);
    const id = await jobId(this.host.workflow.id, effect.key, effect.attempt);
    // Its row first: a restart before it lands runs it again (`recover`). A job is run again, not resumed: what a job
    // does must be safe to do twice (a build, a test, a push of the same tree, which pushes nothing new); a commit made
    // again finds its files already landed (mergeRefs).
    await this.host.storage.put(ROW + id, { key: effect.key, attempt: effect.attempt, kind: effect.kind, args: effect.args });
    this.launch(id, effect);
  }

  /** A restart: run again each job this object started and that has not landed. */
  async recover() {
    for (const [name, effect] of await this.host.storage.list<StartedEffect>({ prefix: ROW }))
      if (!this.running.has(name.slice(ROW.length))) this.launch(name.slice(ROW.length), effect);
  }

  /**
   * The runner's sweep asks after an effect that has not landed: one whose run is not in flight here (it threw: storage
   * down, the container's object unreachable) is run again. Its landing comes from that run.
   */
  async poll(effect: StartedEffect) {
    const id = await jobId(this.host.workflow.id, effect.key, effect.attempt);
    const row = await this.host.storage.get<StartedEffect>(ROW + id);
    if (row && !this.running.has(id)) this.launch(id, row);
    return undefined;
  }

  async cancel(effect: StartedEffect) {
    if (effect.kind !== "job" && effect.kind !== "push") return;
    const found = this.driver();
    if (found.ok) await found.driver.stop(await jobId(this.host.workflow.id, effect.key, effect.attempt));
  }

  async abort() {
    const found = this.driver();
    for (const [name] of await this.host.storage.list({ prefix: ROW })) if (found.ok) await found.driver.stop(name.slice(ROW.length)).catch(() => undefined);
  }

  private launch(id: string, effect: Pick<StartedEffect, "key" | "attempt" | "kind" | "args">) {
    const run = this.run(id, effect)
      .catch(error => console.error(JSON.stringify({ type: "workflow_job_failed", workflow: this.host.workflow.id, job: id, error: error instanceof Error ? error.message.slice(0, 300) : "Error" })))
      .finally(() => this.running.delete(id));
    this.running.set(id, run);
    this.host.waitUntil(run);
  }

  private async run(id: string, effect: Pick<StartedEffect, "key" | "attempt" | "kind" | "args">) {
    const done = async (outcome: Parameters<WorkflowJobsHost["land"]>[2], usage?: EffectUsage) => {
      await this.host.land(effect.key, effect.attempt, outcome, usage);
      await this.host.storage.delete(ROW + id);
    };
    if (effect.kind === "commit") return done(await this.commit(effect.args as { fork?: unknown; snapshot?: unknown }));
    const found = this.driver();
    if (!found.ok) return done({ ok: false, error: `${found.code}: ${found.message}` });
    let snapshotMs: number | undefined;
    let spec: JobSpec, secrets: string[] = [], parse: (result: Extract<JobResult, { ok: true }>, value: Record<string, unknown>) => Record<string, unknown> = (_, value) => value;
    try {
      if (effect.kind === "push") ({ spec, snapshotMs, secrets, parse } = await this.pushSpec(id, effect.args as PushArgs));
      else ({ spec, snapshotMs } = await this.jobSpec(id, effect.args as JobArgs));
    } catch (error) {
      if (error instanceof StorageError) throw error;
      // A bad argument, an unknown volume, a GitHub App that will not give a token: the script gets null and the item says why.
      if (error instanceof JobSpecError || (error as { status?: number }).status !== undefined && (error as { status: number }).status < 500)
        return done({ ok: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    let result: JobResult;
    // A spec only the driver can judge (commit on a driver without camelFS) is the script's error, landed like any bad
    // argument; left to throw, the row would be run again by every sweep.
    const driverFrom = Date.now();
    try { result = await found.driver.run(spec); }
    catch (error) { if (error instanceof JobSpecError) return done({ ok: false, error: error.message }); throw error; }
    const driverMs = Date.now() - driverFrom;
    if (!result.ok) {
      if (result.code === "job_running") return; // an earlier run of this job still holds its container: its landing comes from there
      if (result.code === "admission_refused") return done({ refused: result.message, code: "payer_exhausted" });
      return done({ ok: false, error: `${result.code}: ${redact(result.message, secrets)}` }, { costUsd: result.costUsd ?? 0, durationMs: result.timings.totalMs });
    }
    const keepFrom = Date.now();
    const value = parse(result, await this.keep(id, result, secrets, { ...(snapshotMs !== undefined ? { snapshotMs } : {}), driverMs }, keepFrom));
    // The container time its payer was charged also counts in the workflow's ledger (its budget), once per key:attempt.
    await done({ ok: true, value }, { costUsd: result.costUsd ?? 0, model: `cloudflare/${result.instance}`, durationMs: result.timings.totalMs });
  }

  /** Who pays for a job: the owner agent, or, for a workflow no agent owns, its tenant under the workflow's id. */
  private payer(): JobSpec["payer"] {
    const tenant = this.host.workflow.tenant, owner = this.host.payer();
    return owner ? { tenant, agent: owner } : { tenant, agent: this.host.workflow.id, kind: "workflow" };
  }

  /** A script's job() as a JobSpec: paid by `payer()`, its container in that payer's computer tree. */
  private async jobSpec(id: string, args: JobArgs): Promise<{ spec: JobSpec; snapshotMs?: number }> {
    const known = ["command", "timeoutSeconds", "outputs", "limits", "internet", "at", "files", "nocache", "commit"];
    const extra = Object.keys(args ?? {}).find(name => !known.includes(name));
    if (extra) throw new JobSpecError(`job() has no option ${extra}: it takes ${known.join(", ")}`);
    if (args.commit !== undefined && typeof args.commit !== "boolean") throw new JobSpecError("job() commit is true or false");
    if (args.commit && args.at === undefined) throw new JobSpecError("job() commit needs at: the volume whose tree it checkpoints");
    if (args.commit && !camelfsConfigured(this.env)) throw new JobSpecError("job() commit needs camelFS job hosts, which this deployment does not have");
    if (args.at !== undefined && args.files !== undefined) throw new JobSpecError("job() takes at or files, not both");
    if (args.files !== undefined && (!args.files || typeof args.files !== "object" || Object.values(args.files).some(text => typeof text !== "string")))
      throw new JobSpecError("job() files maps paths to text");
    const tenant = this.host.workflow.tenant;
    let source: Pick<JobSpec, "volume" | "files" | "repo"> = {};
    let snapshotMs: number | undefined;
    if (args.at !== undefined) {
      if (typeof args.at !== "string") {
        const target = repoAt(args.at);
        await this.host.storage.put(`workflow-repo:${target.repo}`, true);
        source = { repo: { ...target, tenant, owner: `workflow:${this.host.workflow.id}` } };
      } else {
        const at = args.at;
        const base = await jobVolume(() => volume(this.env, tenant, at), at);
        const snapshotFrom = Date.now();
        const snapshot = await base.snapshot(`job ${id}`, { pinned: true, labels: { workflow: this.host.workflow.id }, expiresAt: Date.now() + SYNC_SNAPSHOT_TTL_MS });
        snapshotMs = Date.now() - snapshotFrom;
        source = { volume: { tenant, volume: args.at, snapshot: snapshot.id } };
      }
    } else if (args.files) source = { files: Object.fromEntries(Object.entries(args.files).map(([path, text]) => [path, new TextEncoder().encode(text)])) };
    return { snapshotMs, spec: {
      id, command: args.command, timeoutSeconds: Math.ceil(args.timeoutSeconds), ...(args.outputs ? { outputs: args.outputs } : {}),
      ...(args.limits ? { limits: args.limits } : {}), ...(args.internet ? { internet: true } : {}), ...(args.commit ? { commit: true } : {}), ...source,
      payer: this.payer(),
    } };
  }

  /** A push as a job: the volume's tree in /repo, the token in the command's environment only. */
  private async pushSpec(id: string, args: PushArgs) {
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(args.repo ?? "")) throw new JobSpecError("push() repo is owner/name");
    if (!/^(?!\/|.*\/\/|.*\.\.|.*\.lock$|.*\/$)[A-Za-z0-9._\/-]{1,200}$/.test(args.branch ?? "")) throw new JobSpecError("push() branch is a branch name");
    const auth = { type: "github-app" as const, app: args.app, repositories: [args.repo], permissions: { contents: "write" as const }, ...(args.installation ? { installation: args.installation } : {}) };
    const minted = await (await workerGitHubApps(this.env)).token(this.host.workflow.tenant, auth, `https://github.com/${args.repo}.git`);
    const { spec: base, snapshotMs } = await this.jobSpec(id, { command: PUSH_SCRIPT, timeoutSeconds: args.timeoutSeconds ?? 600, at: args.volume, internet: true });
    const spec: JobSpec = {
      ...base,
      secretEnv: {
        GIT_PUSH_TOKEN: minted.token, PUSH_REPO: args.repo, PUSH_BRANCH: args.branch, PUSH_MESSAGE: (args.message ?? `Workflow ${this.host.workflow.id}`).slice(0, 4000),
        PUSH_NAME: "camelRun workflow", PUSH_EMAIL: "workflows@camelai.com", PUSH_DATE: `@${Math.floor(Date.now() / 1000)} +0000`,
      },
    };
    return {
      spec, snapshotMs, secrets: [minted.token],
      parse: (result: Extract<JobResult, { ok: true }>, value: Record<string, unknown>) => {
        const line = /PUSH_RESULT (pushed|unchanged) ([0-9a-f]{40})/.exec(decoder.decode(result.stdout.bytes));
        return { ...value, pushed: result.exitCode === 0 && line?.[1] === "pushed", ...(line ? { commit: line[2] } : {}), branch: args.branch };
      },
    };
  }

  /**
   * The job's outputs and streams, kept in the workflow's repo under /jobs/<id>/; the script gets their paths and
   * sizes, and each stream's end, within the inline result's size.
   */
  private async keep(id: string, result: Extract<JobResult, { ok: true }>, secrets: string[], steps: Record<string, number>, keepFrom: number) {
    const tenant = this.host.workflow.tenant;
    const made = await createRepo(this.env as RepoEnv, tenant, { key: `workflow:${this.host.workflow.id}`, author: `workflow:${this.host.workflow.id}` });
    const ctx = await repoContext(this.env as RepoEnv, tenant, made.info.id), changes: WriteInput['changes'] = {};
    const write = async (name: string, bytes: Uint8Array) => {
      const path = `jobs/${id}/${name}`;
      changes[path] = { bytes };
      return '/' + path;
    };
    const stream = async (name: string, value: JobStream) => {
      const text = redact(decoder.decode(value.bytes), secrets);
      const path = await write(name, new TextEncoder().encode(text));
      return { path, bytes: value.size, truncated: value.truncated, tail: text.slice(-TAIL_CHARS) };
    };
    const outputs: Record<string, { path: string; bytes: number; truncated: boolean }> = {};
    for (const [name, output] of Object.entries(result.outputs)) outputs[name] = { path: await write(`out/${name}`, output.bytes), bytes: output.size, truncated: output.truncated };
    const keptSteps = { ...result.timings.steps, ...steps, keepMs: 0 };
    const value: Record<string, unknown> = {
      exitCode: result.exitCode, timedOut: result.timedOut, repo: made.info.id,
      stdout: await stream("stdout.txt", result.stdout), stderr: await stream("stderr.txt", result.stderr), outputs, missing: result.missing,
      timings: { totalMs: result.timings.totalMs, commandMs: result.timings.commandMs, steps: keptSteps },
    };
    const kept = await commitChanges(ctx, { ref: 'main', changes, message: `job ${id}`, author: `workflow:${this.host.workflow.id}`, who: `workflow:${this.host.workflow.id}`, why: 'keep', idempotencyKey: `keep:${id}` });
    value.version = kept.version;
    if (result.camelfs) {
      const { tree, root, commit, checkpointError, warm, mountMs, applyMs, checkpointMs, checkpoint } = result.camelfs;
      for (const [key, field] of Object.entries({ tree, root, commit, checkpointError })) if (field !== undefined) value[key] = field;
      (value.timings as Record<string, unknown>).camelfs = {
        warm, mountMs, applyMs, ...(checkpointMs ? { checkpointMs } : {}), ...(checkpoint ? { checkpoint } : {}),
      };
    }
    // The inline result stays under the runner's cap: the tails shrink first (the streams are whole in the repo).
    for (let tail = TAIL_CHARS; new TextEncoder().encode(JSON.stringify(value)).byteLength > WORKFLOW_LIMITS.inlineResultBytes - 512 && tail > 0; tail = Math.floor(tail / 2)) {
      for (const name of ["stdout", "stderr"] as const) (value[name] as { tail: string }).tail = (value[name] as { tail: string }).tail.slice(-tail);
    }
    // Keep time up to building the value, excluding only this last write.
    keptSteps.keepMs = Date.now() - keepFrom;
    return value;
  }

  /** commit(fork): the fork's edits onto its base, or the conflicts. Storage down throws: its row stays, a restart tries again. */
  private async commit(args: { fork?: unknown; snapshot?: unknown }): Promise<EffectOutcome> {
    try {
      if ('snapshot' in args) throw Object.assign(new Error('commit() has no snapshot option'), { status: 400 });
      const fork = args.fork as WorkflowFork;
      if (!fork || typeof fork !== 'object' || typeof fork.repo !== 'string' || typeof fork.ref !== 'string' || !fork.base)
        throw Object.assign(new Error('commit() needs { fork: { repo, ref, base } }'), { status: 400 });
      if (!fork.base.ref) return { ok: false, error: 'A fork of a version has no base ref to merge into' };
      const ctx = await repoContext(this.env as RepoEnv, this.host.workflow.tenant, fork.repo);
      try {
        const merged = await mergeRefs(ctx, { into: fork.base.ref, from: fork.ref });
        return { ok: true, value: { committed: true, version: merged.version, changed: merged.changed, ...('files' in merged ? { files: Object.keys(merged.files) } : {}) } };
      } catch (error) {
        const found = repoErrorFrom(error);
        if (found?.code === 'conflicts') return { ok: true, value: { committed: false, conflicts: found.detail?.conflicts } };
        throw error;
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      const status = (error as { status?: number }).status;
      if (status === undefined || status >= 500) throw error;
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Jobs' share of the limits a script sees in its job()'s result streams. */
export const WORKFLOW_JOB_LIMITS = Object.freeze({ tailChars: TAIL_CHARS, streamBytes: JOB_LIMITS.streamBytes });

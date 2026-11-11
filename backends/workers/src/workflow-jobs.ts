// The workflow's `job()`, `commit()` and `push()` effects (docs/design/swarm-workflows.md, "Jobs: the ephemeral compute
// boundary"). A job runs through the JobDriver (jobs/driver.ts) on its own container, paid by the workflow's tenant (its
// payer is the workflow), in a job slot of the capacity limiter the runner holds for it; its named outputs and its
// output streams are kept in the workflow's volume, and the script gets a small result that names them. A commit lands
// a child's fork on its base (workflow-volumes.ts). A push is a job that writes a volume to a GitHub branch with the
// GitHub App's installation token, which only the job's process sees.
import { createVolume } from "./file-mounts.ts";
import { volume, type FileBindings } from "./files.ts";
import { workerGitHubApps, type GitHubAppsEnv } from "./github-apps.ts";
import { jobDriver, type JobDriver, type JobDriverEnv } from "./jobs/driver.ts";
import { JOB_LIMITS, JobSpecError, type JobResult, type JobSpec, type JobStream } from "./jobs/job.ts";
import { assertStorageWrite } from "./storage-quota.ts";
import { digest } from "./volume.ts";
import { commitFork } from "./workflow-volumes.ts";
import { WORKFLOW_LIMITS, type EffectExecutor, type EffectOutcome, type EffectUsage, type StartedEffect } from "./workflow-runner.ts";

export type WorkflowJobsEnv = FileBindings & JobDriverEnv & GitHubAppsEnv;

export interface WorkflowJobsHost {
  workflow: { id: string; tenant: string };
  /** The effect ended: `WorkflowRunner.land`. A second landing is ignored by the runner. */
  land(key: string, attempt: number, outcome: EffectOutcome | { refused: string; code: "payer_exhausted" }, usage?: EffectUsage): Promise<void>;
  /** Keep a job's run alive past the call that started it. */
  waitUntil(promise: Promise<unknown>): void;
  storage: DurableObjectStorage;
}

/** How long the snapshot a job syncs from (its `at` volume) is kept: the job's whole life, with room. */
const SYNC_SNAPSHOT_TTL_MS = 86_400_000;
/** Of each stream, what the script sees inline (its end): the whole stream is in the workflow's volume. */
const TAIL_CHARS = 1_500;
const ROW = "workflow-job:";

/** The job's id: one per effect `key:attempt`, so a run made again is the same job (its container object, its slot). */
export async function jobId(workflow: string, key: string, attempt: number) {
  return `wf-${(await digest(new TextEncoder().encode(`${workflow}\n${key}\n${attempt}`))).slice(0, 40)}`;
}

/** The workflow's own volume: job outputs and streams, under /jobs/<job id>/. Made once, by key. */
export async function workflowVolume(env: FileBindings, tenant: string, workflow: string) {
  const made = await createVolume(env, tenant, { name: `workflow ${workflow}`.slice(0, 120), key: `workflow:${workflow}:files` });
  return made.id;
}

/** Replace every secret in `text` (a token a command printed), so no result or log carries it. */
export function redact(text: string, secrets: string[]) {
  return secrets.filter(secret => secret.length >= 8).reduce((out, secret) => out.split(secret).join("***"), text);
}

const decoder = new TextDecoder();
type JobArgs = {
  command: string; timeoutSeconds: number; outputs?: string[]; limits?: JobSpec["limits"]; internet?: boolean;
  /** A volume of the tenant's whose files the job starts with, in /repo (synced from a snapshot taken now). */
  at?: string;
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

  async start(effect: StartedEffect): Promise<void> {
    if (effect.kind === "commit") return this.commit(effect);
    if (effect.kind !== "job" && effect.kind !== "push") throw new Error(`WorkflowJobs runs job(), commit() and push(), not ${effect.kind}()`);
    const id = await jobId(this.host.workflow.id, effect.key, effect.attempt);
    // Its row first: a restart before it lands runs it again (`recover`). A job is run again, not resumed: what a job
    // does must be safe to do twice (a build, a test, a push of the same tree, which pushes nothing new).
    await this.host.storage.put(ROW + id, { key: effect.key, attempt: effect.attempt, kind: effect.kind, args: effect.args });
    this.launch(id, effect);
  }

  /** A restart: run again each job this object started and that has not landed. */
  async recover() {
    for (const [name, effect] of await this.host.storage.list<StartedEffect>({ prefix: ROW }))
      if (!this.running.has(name.slice(ROW.length))) this.launch(name.slice(ROW.length), effect);
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
    const found = this.driver();
    if (!found.ok) return done({ ok: false, error: `${found.code}: ${found.message}` });
    let spec: JobSpec, secrets: string[] = [], parse: (result: Extract<JobResult, { ok: true }>, value: Record<string, unknown>) => Record<string, unknown> = (_, value) => value;
    try {
      if (effect.kind === "push") ({ spec, secrets, parse } = await this.pushSpec(id, effect.args as PushArgs));
      else spec = await this.jobSpec(id, effect.args as JobArgs);
    } catch (error) {
      // A bad argument, an unknown volume, a GitHub App that will not give a token: the script gets null and the item says why.
      if (error instanceof JobSpecError || (error as { status?: number }).status !== undefined && (error as { status: number }).status < 500)
        return done({ ok: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const result = await found.driver.run(spec);
    if (!result.ok) {
      if (result.code === "job_running") return; // an earlier run of this job still holds its container: its landing comes from there
      if (result.code === "admission_refused") return done({ refused: result.message, code: "payer_exhausted" });
      return done({ ok: false, error: `${result.code}: ${redact(result.message, secrets)}` }, { costUsd: 0, durationMs: result.timings.totalMs });
    }
    const value = parse(result, await this.keep(id, result, secrets));
    await done({ ok: true, value }, { costUsd: 0, model: `cloudflare/${result.instance}`, durationMs: result.timings.totalMs });
  }

  /** A script's job() as a JobSpec: paid by the workflow's tenant, with the workflow as its agent (its computer tree). */
  private async jobSpec(id: string, args: JobArgs): Promise<JobSpec> {
    const known = ["command", "timeoutSeconds", "outputs", "limits", "internet", "at", "files"];
    const extra = Object.keys(args ?? {}).find(name => !known.includes(name));
    if (extra) throw new JobSpecError(`job() has no option ${extra}: it takes ${known.join(", ")}`);
    if (args.at !== undefined && args.files !== undefined) throw new JobSpecError("job() takes at or files, not both");
    if (args.files !== undefined && (!args.files || typeof args.files !== "object" || Object.values(args.files).some(text => typeof text !== "string")))
      throw new JobSpecError("job() files maps paths to text");
    const tenant = this.host.workflow.tenant;
    let source: Pick<JobSpec, "volume" | "files"> = {};
    if (args.at !== undefined) {
      if (typeof args.at !== "string") throw new JobSpecError("job() at is a volume id");
      const base = await volume(this.env, tenant, args.at);
      const snapshot = await base.snapshot(`job ${id}`, { pinned: true, labels: { workflow: this.host.workflow.id }, expiresAt: Date.now() + SYNC_SNAPSHOT_TTL_MS });
      source = { volume: { tenant, volume: args.at, snapshot: snapshot.id } };
    } else if (args.files) source = { files: Object.fromEntries(Object.entries(args.files).map(([path, text]) => [path, new TextEncoder().encode(text)])) };
    return {
      id, command: args.command, timeoutSeconds: Math.ceil(args.timeoutSeconds), ...(args.outputs ? { outputs: args.outputs } : {}),
      ...(args.limits ? { limits: args.limits } : {}), ...(args.internet ? { internet: true } : {}), ...source,
      payer: { tenant, agent: this.host.workflow.id },
    };
  }

  /** A push as a job: the volume's tree in /repo, the token in the command's environment only. */
  private async pushSpec(id: string, args: PushArgs) {
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(args.repo ?? "")) throw new JobSpecError("push() repo is owner/name");
    if (!/^(?!\/|.*\/\/|.*\.\.|.*\.lock$|.*\/$)[A-Za-z0-9._\/-]{1,200}$/.test(args.branch ?? "")) throw new JobSpecError("push() branch is a branch name");
    const auth = { type: "github-app" as const, app: args.app, repositories: [args.repo], permissions: { contents: "write" as const }, ...(args.installation ? { installation: args.installation } : {}) };
    const minted = await (await workerGitHubApps(this.env)).token(this.host.workflow.tenant, auth, `https://github.com/${args.repo}.git`);
    const base = await this.jobSpec(id, { command: PUSH_SCRIPT, timeoutSeconds: args.timeoutSeconds ?? 600, at: args.volume, internet: true });
    const spec: JobSpec = {
      ...base,
      secretEnv: {
        GIT_PUSH_TOKEN: minted.token, PUSH_REPO: args.repo, PUSH_BRANCH: args.branch, PUSH_MESSAGE: (args.message ?? `Workflow ${this.host.workflow.id}`).slice(0, 4000),
        PUSH_NAME: "camelRun workflow", PUSH_EMAIL: "workflows@camelai.com", PUSH_DATE: `@${Math.floor(Date.now() / 1000)} +0000`,
      },
    };
    return {
      spec, secrets: [minted.token],
      parse: (result: Extract<JobResult, { ok: true }>, value: Record<string, unknown>) => {
        const line = /PUSH_RESULT (pushed|unchanged) ([0-9a-f]{40})/.exec(decoder.decode(result.stdout.bytes));
        return { ...value, pushed: result.exitCode === 0 && line?.[1] === "pushed", ...(line ? { commit: line[2] } : {}), repo: args.repo, branch: args.branch };
      },
    };
  }

  /**
   * The job's outputs and streams, kept in the workflow's volume under /jobs/<id>/; the script gets their paths and
   * sizes, and each stream's end, within the inline result's size.
   */
  private async keep(id: string, result: Extract<JobResult, { ok: true }>, secrets: string[]) {
    const tenant = this.host.workflow.tenant;
    const volumeId = await workflowVolume(this.env, tenant, this.host.workflow.id);
    const files = await volume(this.env, tenant, volumeId);
    const write = async (name: string, bytes: Uint8Array) => {
      await assertStorageWrite(this.env, tenant, bytes.byteLength);
      const file = await files.write(`/jobs/${id}/${name}`, bytes);
      return file.path;
    };
    const stream = async (name: string, value: JobStream) => {
      const text = redact(decoder.decode(value.bytes), secrets);
      const path = await write(name, new TextEncoder().encode(text));
      return { path, bytes: value.size, truncated: value.truncated, tail: text.slice(-TAIL_CHARS) };
    };
    const outputs: Record<string, { path: string; bytes: number; truncated: boolean }> = {};
    for (const [name, output] of Object.entries(result.outputs)) outputs[name] = { path: await write(`out/${name}`, output.bytes), bytes: output.size, truncated: output.truncated };
    const value: Record<string, unknown> = {
      exitCode: result.exitCode, timedOut: result.timedOut, volume: volumeId,
      stdout: await stream("stdout.txt", result.stdout), stderr: await stream("stderr.txt", result.stderr), outputs, missing: result.missing,
      timings: { totalMs: result.timings.totalMs, commandMs: result.timings.commandMs },
    };
    // The inline result stays under the runner's cap: the tails shrink first (the streams are whole in the volume).
    for (let tail = TAIL_CHARS; new TextEncoder().encode(JSON.stringify(value)).byteLength > WORKFLOW_LIMITS.inlineResultBytes - 512 && tail > 0; tail = Math.floor(tail / 2)) {
      for (const name of ["stdout", "stderr"] as const) (value[name] as { tail: string }).tail = (value[name] as { tail: string }).tail.slice(-tail);
    }
    return value;
  }

  /** commit(fork): the fork's edits onto its base, or the conflicts. */
  private async commit(effect: StartedEffect) {
    const args = effect.args as { fork?: unknown; snapshot?: unknown };
    let outcome: EffectOutcome;
    try {
      if (typeof args.fork !== "string") throw Object.assign(new Error("commit() needs a fork's volume id"), { status: 400 });
      if (args.snapshot !== undefined && typeof args.snapshot !== "string") throw Object.assign(new Error("commit() snapshot is a name"), { status: 400 });
      outcome = { ok: true, value: await commitFork(this.env, this.host.workflow.tenant, args.fork, args.snapshot ? { snapshot: args.snapshot } : {}) };
    } catch (error) {
      const status = (error as { status?: number }).status;
      // Not the script's to see as a failure when storage is down: the start is tried again (the runner's sweep).
      if (status === undefined || status >= 500) throw error;
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    await this.host.land(effect.key, effect.attempt, outcome);
  }
}

/** Jobs' share of the limits a script sees in its job()'s result streams. */
export const WORKFLOW_JOB_LIMITS = Object.freeze({ tailChars: TAIL_CHARS, streamBytes: JOB_LIMITS.streamBytes });

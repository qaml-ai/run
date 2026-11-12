// One workflow (docs/design/swarm-workflows.md, Part 1): a Durable Object whose SQLite holds the runner's journal,
// snapshot, ledger and events, and whose one alarm multiplexes timers, gate expiry, the step-rate window and the
// sweep. Its steps run in the code mode sandbox Worker (exchange protocol 3).
//
// Its `agent()` effects run on WorkflowAgents (workflow-agents.ts): children the workflow owns (`owner = { kind:
// "workflow", id }`), whose endings come back by their outboxes to `receiveEnding`. Effects of other kinds are
// composed in by kind (`byKind`). With TEST_WORKFLOW_EXECUTOR=stub a test gives the object a stand-in executor that
// answers at once instead.
import { guardAlarms } from "./alarm-guard.ts";
import { DurableObject } from "cloudflare:workers";
import type { WorkflowSandbox } from "../codemode/workflow-protocol.ts";
import { keyServices } from "./security-services.ts";
import type { SecurityEnv } from "./security-services.ts";
import { WorkflowAgents, workflowChildren } from "./workflow-agents.ts";
import { WorkflowJobs, type WorkflowJobsEnv } from "./workflow-jobs.ts";
import { deleteFork, forkForChild, forkId } from "./workflow-volumes.ts";
import { ForkJanitor } from "./workflow-forks.ts";
import { cacheKey, type WorkflowResults } from "./workflow-results.ts";
import { volume } from "./files.ts";

const ENDED = new Set(["completed", "failed", "aborted"]);

/** Where a child of a repo edits its fork. */
export const FORK_MOUNT_PATH = "/repo";
import { WorkflowNotices } from "./workflow-notices.ts";
import { WorkflowGates } from "./workflow-gates.ts";
import { database, type PostgresEnv } from "./postgres.ts";
import type { InboxAnswer, InboxOutcome } from "../../../shared/inbox-answers.ts";
import { alarmAt, runAlarm } from "./workflow-alarm.ts";
import { workflowStub } from "./workflow-routes.ts";
import type { AgentType, ModelClass } from "./workflow-types.ts";
import type { Owner } from "../../../shared/owner.ts";
import type { Env } from "./agent-types.ts";
import {
  WorkflowRunner, WorkflowError, refusable, type CapacitySeam, type EffectExecutor, type EffectOutcome, type EffectUsage, type ResultCache, type StartedEffect, type WorkflowInit,
} from "./workflow-runner.ts";

/** The tenant's capacity limiter (WorkflowCapacity, workflow-capacity-object.ts), as this object calls it over RPC. */
interface CapacityStub {
  open(workflow: string, asked: { concurrency?: number; jobConcurrency?: number; leaseMs?: number }, limits: { busyAgents: number | null; computerLimit?: number | null }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  acquire(workflow: string, kind: "child" | "job", key: string, leaseMs?: number): Promise<{ ok: true; granted: true; lease: { id: string } } | { ok: true; granted: false } | { ok: false; code: string; message: string }>;
  release(workflow: string, id: string): Promise<void>;
  renew(workflow: string, leaseMs?: number): Promise<{ ok: true; held: { id: string; kind: "child" | "job"; key: string }[] } | { ok: false; code: string; message: string }>;
  close(workflow: string): Promise<void>;
}

export interface WorkflowEnv extends SecurityEnv, Omit<WorkflowJobsEnv, keyof SecurityEnv> {
  CODEMODE_SANDBOX: DurableObjectNamespace;
  WORKFLOWS: DurableObjectNamespace<WorkflowObject>;
  /** The owners' result caches (workflow-results.ts); absent where not deployed: then nothing is reused. */
  WORKFLOW_RESULTS?: DurableObjectNamespace<WorkflowResults>;
  /** Absent where the capacity limiter is not deployed: then nothing but the workflow's own concurrency bounds it. */
  WORKFLOW_CAPACITY?: { getByName(tenant: string): CapacityStub };
  TEST_MODE?: string;
  /** TEST_MODE only: "stub" gives workflows the stand-in executor (agents and gates answer at once). */
  TEST_WORKFLOW_EXECUTOR?: string;
}

/** What a capacity grant (a wake from the limiter) carries. */
export interface CapacityGrant { workflow: string; id: string; kind: string; key: string; expiresAt: number }

/**
 * The executor the owner model provides (#804's WorkflowAgents): besides starting effects it takes the endings and
 * progress its children deliver to this object.
 */
export interface ChildEffects extends EffectExecutor {
  receiveEnding?(ending: unknown): Promise<unknown>;
  receiveProgress?(report: unknown): Promise<unknown>;
}

const CAPACITY_LEASE_MS = 10 * 60_000;

/** The limiter, for the workflow named `workflow` of `tenant`, as the runner's seam. */
function capacitySeam(env: WorkflowEnv, workflow: string, tenant: () => string | undefined): CapacitySeam | undefined {
  const namespace = env.WORKFLOW_CAPACITY;
  if (!namespace) return undefined;
  const stub = () => {
    const owner = tenant();
    if (!owner) throw new WorkflowError("A workflow under a capacity limiter needs its tenant", 500);
    return namespace.getByName(owner);
  };
  const refused = (result: { ok: false; code: string; message: string }) => new Error(`Workflow capacity ${result.code}: ${result.message}`);
  return {
    leaseMs: CAPACITY_LEASE_MS,
    async open(concurrency, jobConcurrency) {
      // The tenant's busy-agent limit bounds its workflows' children (Infinity: none), its computer limit their jobs.
      const { accounts } = await keyServices(env);
      const { limit } = await accounts.billing.busyLimit(tenant()!);
      const computers = accounts.tenants.computerLimit(tenant()!);
      const opened = await stub().open(workflow, { concurrency, jobConcurrency, leaseMs: CAPACITY_LEASE_MS }, { busyAgents: Number.isFinite(limit) ? limit : null, computerLimit: computers ?? null });
      return opened.ok ? { ok: true } : { ok: false, message: opened.message };
    },
    async acquire(key, kind) {
      const slot = await stub().acquire(workflow, kind, key, CAPACITY_LEASE_MS);
      if (!slot.ok) throw refused(slot);
      return slot.granted ? { granted: true, lease: slot.lease.id } : { granted: false };
    },
    release: lease => stub().release(workflow, lease),
    async renew() {
      const renewed = await stub().renew(workflow, CAPACITY_LEASE_MS);
      if (!renewed.ok) return { ok: false, message: `${renewed.code}: ${renewed.message}` };
      return { ok: true, held: renewed.held.map(lease => ({ key: lease.key, lease: lease.id, kind: lease.kind })) };
    },
    close: () => stub().close(workflow),
  };
}

/**
 * The seam the owner model fills: an executor that starts `agent` effects as children owned by this workflow (the
 * delegation path, `callId` = the effect key, attempt = the effect's attempt) and `gate` effects as inbox items the
 * workflow owns, and lands their endings through `WorkflowObject.land`. Until then every start is refused loudly.
 */
export const unwiredExecutor: EffectExecutor = {
  async start(effect) {
    throw new WorkflowError(`Workflow ${effect.kind}() has no executor on this runtime yet`, 501);
  },
};

/**
 * One executor from several, by effect kind: `start` and `cancel` go to the kind's executor (a kind with none is
 * refused loudly), `recover` and `abort` to every one, and children's endings and progress to the `agent` executor.
 * Other lanes add a kind with one entry (job, commit, push).
 */
export function byKind(executors: Record<string, ChildEffects>): ChildEffects {
  const of = (kind: string) => executors[kind] ?? unwiredExecutor;
  const each = [...new Set(Object.values(executors))];
  return {
    start: effect => of(effect.kind).start(effect),
    cancel: async effect => { await of(effect.kind).cancel?.(effect); },
    poll: async effect => of(effect.kind).poll?.(effect),
    recover: async () => { for (const executor of each) await executor.recover?.(); },
    abort: async () => { for (const executor of each) await executor.abort?.(); },
    receiveEnding: ending => {
      const agents = executors.agent;
      if (!agents?.receiveEnding) throw new WorkflowError("This workflow has no child executor", 501);
      return agents.receiveEnding(ending);
    },
    receiveProgress: report => {
      const agents = executors.agent;
      if (!agents?.receiveProgress) throw new WorkflowError("This workflow has no child executor", 501);
      return agents.receiveProgress(report);
    },
  };
}


/** What a workflow is started with beside its script, kept by its object (runner.ts has the script and budget). */
export interface WorkflowSettings {
  name?: string;
  /** The start's `args`: the script sees them as the `args` global. */
  args?: unknown;
  classes?: Partial<Record<AgentType, ModelClass>>;
  allowFastJudgment?: boolean;
  /** Who started it: an account key, a console user, or an agent (the `workflows` builtin), which then owns it. */
  owner?: Owner;
  /**
   * The origin it was started at (the account's request, or its owner agent's), which its children are configured
   * with, as an agent made at that origin is. AGENT_PUBLIC_URL, when set, wins over it.
   */
  runtimeOrigin?: string;
}

/** The script as the runner runs it: the start's `args` first, as a frozen global the script reads. */
export function withArgs(script: string, args: unknown) {
  return `const args = Object.freeze(${JSON.stringify(args ?? null)});\n${script}`;
}

/** TEST_MODE only: agents answer with their prompt, gates with their recommendation, at once. */
function testExecutor(land: (key: string, attempt: number, outcome: EffectOutcome, usage?: EffectUsage) => Promise<void>, ctx: DurableObjectState): EffectExecutor {
  const answer = (effect: StartedEffect): EffectOutcome => effect.kind === "gate"
    ? { ok: true, value: (effect.args as { recommended?: unknown }).recommended ?? "yes" }
    : { ok: true, value: { answer: `re: ${(effect.args as { prompt: string }).prompt}` } };
  return {
    async start(effect) {
      ctx.waitUntil(Promise.resolve().then(() => land(effect.key, effect.attempt, answer(effect), { costUsd: 0.01, model: "test/echo" })).catch(error => console.error("test executor landing failed", error)));
    },
  };
}

export class WorkflowObject extends DurableObject<WorkflowEnv> {
  private readonly runner: WorkflowRunner;
  private readonly executor: ChildEffects;
  /** What the owner agent hears (workflow-notices.ts): endings, stops and finished phases. */
  private readonly notices: WorkflowNotices;
  readonly agents: WorkflowAgents;
  private readonly forks: ForkJanitor;
  /** Its gates: decisions in the account's inbox (workflow-gates.ts). */
  private readonly gates: WorkflowGates;

  constructor(ctx: DurableObjectState, env: WorkflowEnv) {
    super(ctx, env);
    guardAlarms(this, ctx, "WorkflowObject", { test: (env as { TEST_MODE?: unknown }).TEST_MODE === "1" });
    const name = ctx.id.name;
    const sandbox: WorkflowSandbox = {
      step: request => (env.CODEMODE_SANDBOX.getByName(ctx.id.toString()) as unknown as WorkflowSandbox).step(request),
    };
    const self = this;
    this.forks = new ForkJanitor({ storage: ctx.storage, deleteFork: id => deleteFork(env, self.runner.identity().tenant!, id) });
    this.agents = new WorkflowAgents({
      storage: ctx.storage,
      get workflow() { const identity = self.runner.identity(); return { id: name!, tenant: identity.tenant!, ...(identity.bucket ? { bucket: identity.bucket } : {}) }; },
      // Remaining budget from the ledger; a workflow with no cap is Infinity (its children get no share limit).
      budget: () => { const summary = self.runner.get(); return summary.budget.usd === null ? Infinity : summary.budget.usd - summary.spent.usd; },
      get concurrency() { return self.runner.get().concurrency; },
      land: (key, attempt, outcome, usage) => self.land(key, attempt, outcome, usage),
      defer: task => ctx.waitUntil(task().catch(error => console.error(JSON.stringify({ type: "workflow_landing_failed", workflow: name, error: String(error) })))),
      usageRoot: () => { const owner = self.settings().owner; return owner?.kind === "agent" ? owner.id : undefined; },
      classes: () => { const settings = self.settings(); return { ...(settings.classes ? { classes: settings.classes } : {}), ...(settings.allowFastJudgment ? { allowFastJudgment: true } : {}) }; },
      // A child of a repo (`agent(..., { repo })`) edits a fork of it at /repo, and answers with the fork, for commit().
      childVolume: async (effect, args) => {
        if (args.repo === undefined) return undefined;
        if (typeof args.repo !== "string") throw Object.assign(new Error("agent() repo is a volume id"), { status: 400 });
        const identity = self.runner.identity();
        // Recorded before it is made, so the workflow's end deletes it whatever happens in between.
        await self.forks.made(await forkId(identity.tenant!, { workflow: name!, key: effect.key, attempt: effect.attempt }));
        const fork = await forkForChild(env, identity.tenant!, { workflow: name!, key: effect.key, attempt: effect.attempt, repo: args.repo });
        return { mounts: [{ volumeId: fork.volume, path: FORK_MOUNT_PATH, mode: "rw" }], result: { fork: { volume: fork.volume, base: fork.base } } };
      },
      children: workflowChildren(env as unknown as Env, () => { const identity = self.runner.identity(); return { id: name!, tenant: identity.tenant! }; }, { runtimeOrigin: () => (env as { AGENT_PUBLIC_URL?: string }).AGENT_PUBLIC_URL || self.settings().runtimeOrigin }),
    });
    const jobs = new WorkflowJobs(env, {
      get workflow() { return { id: name ?? "", tenant: self.runner.identity().tenant ?? "" }; },
      payer: () => { const owner = self.settings().owner; return owner?.kind === "agent" ? owner.id : undefined; },
      land: (...args) => self.land(...args), waitUntil: promise => ctx.waitUntil(promise), storage: ctx.storage,
    });
    const defer = (task: () => Promise<void>) => ctx.waitUntil(task().catch(error => console.error(JSON.stringify({ type: "workflow_landing_failed", workflow: name, error: String(error) }))));
    this.gates = new WorkflowGates({
      get workflow() { return { id: name ?? "", tenant: self.runner.identity().tenant ?? "" }; },
      db: () => database(env as unknown as PostgresEnv), storage: ctx.storage,
      land: (key, attempt, outcome) => self.land(key, attempt, outcome), defer,
      // Who may answer: as for the owner agent's own decisions (its approvers, its subject); with no owner agent (a
      // workflow started with an API key), anyone the account vouches for.
      audience: async () => {
        const owner = self.settings().owner;
        if (owner?.kind !== "agent") return {};
        return await (env as unknown as { AGENTS: { getByName(name: string): { inboxAudience(): Promise<{ approvers?: string[]; subject?: string }> } } }).AGENTS.getByName(owner.id).inboxAudience();
      },
      opened: gate => { self.notices.stage("gate_opened", { gate }, self.runner.get().status); self.told(undefined); },
    });
    const stub = env.TEST_MODE === "1" && env.TEST_WORKFLOW_EXECUTOR === "stub" ? testExecutor((...args) => this.land(...args), ctx) : undefined;
    this.executor = byKind({ agent: stub ?? this.agents, gate: stub ?? this.gates, job: jobs, commit: jobs, push: jobs });
    this.notices = new WorkflowNotices({
      sql: ctx.storage.sql, workflowId: name ?? "",
      owner: () => self.settings().owner, name: () => self.settings().name, bucket: () => self.runner.identity().bucket,
      send: (owner, request, notice) => (env as unknown as Env).AGENTS.getByName(owner).receiveAgentMessage(request, notice),
      arm: at => self.armBy(at),
    });
    this.runner = new WorkflowRunner(
      { sql: ctx.storage.sql, transactionSync: fn => ctx.storage.transactionSync(fn) },
      sandbox, this.executor,
      {
        // One alarm for the runner, a notice's retry and the forks' cleanup retry, whichever is due first: a notice whose
        // delivery failed, or a fork delete that failed, is retried even once the workflow has ended.
        alarm: { set: async at => {
          const next = alarmAt(at, this.notices.retryAt(), await this.forks.retryAt());
          await (next === undefined ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(next));
        } },
        capacity: name ? capacitySeam(env, name, () => this.runner.identity().tenant) : undefined,
        results: name && env.WORKFLOW_RESULTS ? this.resultCache(env, name) : undefined,
      },
    );
  }

  /**
   * The owner's result cache, as the runner uses it (workflow-results.ts). Scoped to the owner agent (`tenant:agent`), or
   * `tenant:api` for a workflow started with an API key. An effect that reads a volume (an agent() on a fork of `repo`,
   * a job() `at` one) is keyed with that volume's version at lookup, which the runner keeps for its landing (see
   * `ResultCache`). A landing whose result names a fork pins that fork here first: the end does not delete it while an
   * entry keeps it.
   */
  private resultCache(env: WorkflowEnv, name: string): ResultCache {
    const scope = () => { const owner = this.settings().owner; return `${this.runner.identity().tenant}:${owner?.kind === "agent" ? owner.id : "api"}`; };
    const read = (kind: string, args: string) => {
      try {
        const parsed = JSON.parse(args) as { repo?: unknown; at?: unknown };
        const source = kind === "agent" ? parsed.repo : kind === "job" ? parsed.at : undefined;
        return typeof source === "string" ? source : undefined;
      } catch { return undefined; }
    };
    const cache = () => env.WORKFLOW_RESULTS!.getByName(scope());
    return {
      lookup: async (kind, args) => {
        const source = read(kind, args);
        const key = cacheKey(args, source === undefined ? undefined : (await (await volume(env, this.runner.identity().tenant!, source)).info()).seq);
        const hit = await cache().lookup(kind, key);
        return { key, ...(hit ? { hit } : {}) };
      },
      landed: effect => {
        const fork = effect.kind === "agent" ? (effect.value as { fork?: { volume?: unknown } } | null)?.fork?.volume : undefined;
        // Pinned before anything else (its write is issued now), so an end that follows the landing keeps the fork.
        const pinned = typeof fork === "string" ? this.forks.pin(fork) : undefined;
        const release = async () => { if (typeof fork === "string") { await this.forks.unpin(fork); await this.ended(); } };
        this.ctx.waitUntil((async () => {
          await pinned;
          const { stored } = await cache().put({ kind: effect.kind, key: effect.cacheKey, source: `${name}:${effect.key}:${effect.attempt}`, workflow: name, value: effect.value, ...(typeof fork === "string" ? { fork } : {}) });
          if (!stored) await release();
        })().catch(async error => {
          console.error(JSON.stringify({ type: "workflow_cache_put_failed", workflow: name, key: effect.key, error: error instanceof Error ? error.message.slice(0, 200) : String(error) }));
          await release().catch(() => {});
        }));
      },
    };
  }

  /**
   * A pinned fork whose base moved on since the fork was made (a commit landed there) can never be found by its cache
   * entry again (the entry's key has the base's version from before): its pin goes, so the end deletes it now rather than
   * when the entry expires. One that cannot be read stays pinned (the entry's release still frees it).
   */
  private async unreachable() {
    const tenant = this.runner.identity().tenant;
    if (!tenant) return;
    for (const fork of await this.forks.pinned()) {
      try {
        const origin = (await (await volume(this.env as WorkflowEnv, tenant, fork)).info()).origin;
        if (!origin) continue;
        if ((await (await volume(this.env as WorkflowEnv, tenant, origin.volume)).info()).seq > origin.seq) await this.forks.unpin(fork);
      } catch (error) {
        console.error(JSON.stringify({ type: "workflow_fork_check_failed", fork, error: error instanceof Error ? error.message.slice(0, 200) : String(error) }));
      }
    }
  }

  /** The result cache let go of a fork this workflow made (its entry expired or was evicted): an ended workflow deletes it. */
  async forkReleased(fork: string) {
    await this.forks.unpin(fork);
    await this.ended();
  }


  /**
   * Create the workflow (once; a second create returns it) and run its first step. The object is addressed by name:
   * the workflow's id (`wf_…`), unique across tenants; `tenant` is who it bills, fixed here.
   */
  create(init: Omit<WorkflowInit, "seed" | "startedAt">, settings: WorkflowSettings = {}) { return refusable(() => this.created(init, settings)); }
  private async created(init: Omit<WorkflowInit, "seed" | "startedAt">, settings: WorkflowSettings) {
    if (!this.ctx.id.name) throw new WorkflowError("A WorkflowObject is addressed by its workflow id (getByName)", 500);
    if (!this.exists()) await this.checkScript(init.code);
    this.settingsTable();
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO workflow_settings (id, body) VALUES (1, ?)", JSON.stringify(settings));
    this.runner.init({ ...init, code: withArgs(init.code, this.settings().args), seed: crypto.getRandomValues(new Uint32Array(1))[0]!, startedAt: Date.now() });
    // Where the owner's notices start from: the workflow as created, before its first step.
    this.notices.check(this.runner.get());
    await this.runner.wake();
    await this.failWithoutOrigin();
    return this.told(this.runner.get());
  }

  /** Whether this object holds a workflow already (a repeated create returns it unchanged). */
  private exists() {
    return this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_state'").toArray().length > 0
      && this.ctx.storage.sql.exec("SELECT 1 FROM workflow_state WHERE id = 1").toArray().length > 0;
  }

  /**
   * Compile the script in the sandbox before anything runs: a syntax error is refused here, as `script_error` with
   * its line and column in the script as written, so the author fixes it before a workflow starts or an edit lands.
   */
  private async checkScript(code: unknown) {
    if (typeof code !== "string") return; // the runner refuses a missing script with its own message
    const sandbox = this.env.CODEMODE_SANDBOX.getByName(this.ctx.id.toString()) as unknown as { checkScript(code: string): Promise<{ ok: true } | { ok: false; message: string; line: number; column: number }> };
    let checked;
    try { checked = await sandbox.checkScript(code); }
    catch (error) {
      if (error instanceof Error && /checkScript/.test(error.message) && /(not a function|does not (implement|have)|no such method)/i.test(error.message))
        throw new WorkflowError("The sandbox Worker cannot check workflow scripts yet: the workflow runner and the sandbox Worker run different versions", 503);
      throw error;
    }
    if (!checked.ok) throw Object.assign(new WorkflowError(`script_error: ${checked.message}`, 400), { code: "script_error", line: checked.line, column: checked.column });
  }

  /**
   * Where its children are configured from: AGENT_PUBLIC_URL, else the origin it was started at. A workflow started
   * before origins were stored (#818), where AGENT_PUBLIC_URL is not set either, cannot start a child: it fails once,
   * saying so, instead of retrying every child on every alarm.
   */
  private async failWithoutOrigin() {
    if ((this.env as { AGENT_PUBLIC_URL?: string }).AGENT_PUBLIC_URL || this.settings().runtimeOrigin) return;
    if (!this.exists()) return;
    const summary = this.runner.get();
    if (ENDED.has(summary.status)) return;
    const waiting = this.runner.items({ kind: "agent", status: "pending", limit: 1 }).items.length + this.runner.items({ kind: "agent", status: "running", limit: 1 }).items.length;
    if (!waiting) return;
    await this.runner.fail("This workflow was started before its origin was recorded, and AGENT_PUBLIC_URL is not set, so its agents cannot be configured. Start it again.", "missing_origin");
    await this.ended();
    this.told(undefined);
  }

  /**
   * After anything that may have moved the workflow: stage what the owner should hear about it and deliver it (in the
   * background; a delivery that fails is tried again later, and on the next wake). Returns `value`.
   */
  private told<T>(value: T): T {
    try { this.notices.check(this.runner.get()); }
    catch (error) { console.error(JSON.stringify({ type: "workflow_notice_check_failed", workflow: this.ctx.id.name, error: String(error) })); }
    // The alarm is armed for the first retry before the background send: an isolate that dies mid-send leaves a notice
    // due and nothing else that would arm the alarm for it.
    if (this.notices.pending()) this.ctx.waitUntil((async () => { await this.notices.guard(); await this.notices.flush(); })()
      .catch(error => console.error(JSON.stringify({ type: "workflow_notice_failed", workflow: this.ctx.id.name, error: String(error) }))));
    return value;
  }

  get() { return refusable(() => this.runner.get()); }
  /** What it was started with besides its script (its args, classes and owner). */
  settings(): WorkflowSettings {
    this.settingsTable();
    const row = this.ctx.storage.sql.exec<{ body: string }>("SELECT body FROM workflow_settings WHERE id = 1").toArray()[0];
    return row ? JSON.parse(row.body) as WorkflowSettings : {};
  }
  private settingsTable() { this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS workflow_settings (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)"); }
  /** The summary with the settings a client sees: its name, args, classes and owner. */
  // The RPC surface the API and the builtin use answers a WorkflowError as a refusal (refusable), not a throw.
  view() { return refusable(() => { const { name, args, classes, owner } = this.settings(); return { ...this.runner.get(), ...(name ? { name } : {}), ...(args !== undefined ? { args } : {}), ...(classes ? { classes } : {}), ...(owner ? { owner } : {}) }; }); }
  items(query: Parameters<WorkflowRunner["items"]>[0]) { return refusable(() => this.runner.items(query)); }
  events(query: Parameters<WorkflowRunner["events"]>[0]) { return refusable(() => this.runner.events(query)); }
  pause(options: Parameters<WorkflowRunner["pause"]>[0]) { return refusable(async () => { await this.runner.pause(options); return this.told(this.runner.get()); }); }
  resume() { return refusable(async () => { await this.runner.resume(); return this.told(this.runner.get()); }); }
  abort() { return refusable(async () => { await this.runner.abort(); await this.ended(); return this.told(this.runner.get()); }); }
  setBudget(usd: number | null) { return refusable(async () => { await this.runner.setBudget(usd); return this.told(this.runner.get()); }); }
  /** An executor's landing of effect `key:attempt`. */
  async land(key: string, attempt: number, outcome: EffectOutcome, usage?: EffectUsage) { await this.failWithoutOrigin(); await this.runner.land(key, attempt, outcome, usage); await this.ended(); this.told(undefined); }
  /** `POST /v1/inbox/answers` for this workflow's gates, from `tenant` (another tenant's answers find nothing). */
  async answerGates(tenant: string, answers: InboxAnswer[]): Promise<InboxOutcome[]> {
    if (this.runner.identity().tenant !== tenant) return answers.map(answer => ({ id: answer.id, outcome: "unknown", status: 404, error: "Unknown input" }));
    const outcomes = await this.gates.answer(answers);
    await this.ended();
    this.told(undefined);
    return outcomes;
  }
  /** A child's ending, delivered by its outbox until acknowledged (owner `{ kind: "workflow", id }`). */
  receiveEnding(ending: unknown) {
    if (!this.executor.receiveEnding) throw new WorkflowError("This workflow has no child executor yet", 501);
    return this.executor.receiveEnding(ending);
  }
  /** A child's progress report. */
  receiveProgress(report: unknown) {
    if (!this.executor.receiveProgress) throw new WorkflowError("This workflow has no child executor yet", 501);
    return this.executor.receiveProgress(report);
  }
  /** The capacity limiter's wake: slots granted to this workflow's waiting children. A grant from another tenant is ignored. */
  async capacityGranted(tenant: string, grants: CapacityGrant[]) {
    const own = this.runner.identity().tenant;
    if (!own || tenant !== own) { console.error(JSON.stringify({ type: "workflow_capacity_grant_ignored", workflow: this.ctx.id.name, tenant })); return; }
    await this.runner.capacityGranted(grants.filter(grant => (grant.kind === "child" || grant.kind === "job") && grant.workflow === this.ctx.id.name)
      .map(grant => ({ key: grant.key, lease: grant.id, kind: grant.kind as "child" | "job" })));
    // A grant starts its effect, which may end the workflow (a start that fails at once).
    await this.ended();
    this.told(undefined);
  }
  /** After an eviction or a deploy: start what was committed but not started, and run due steps. */
  async wake() { await this.failWithoutOrigin(); await this.runner.wake(); await this.ended(); this.told(undefined); }

  override async alarm() { await this.alarmed(); }

  /**
   * The alarm: the runner, then its children's fork cleanup, then what the owner hears and the notices that are due.
   * Each is isolated (one that throws is logged and the others still run), and the alarm is armed again whatever
   * happens, for the earliest any of them needs: a concern that keeps failing never costs the notices their retries,
   * and the alarm never relies on the platform's own few retries of a handler that threw.
   */
  private async alarmed() {
    const workflow = this.ctx.id.name;
    await runAlarm({
      concerns: [
        ["origin", () => this.failWithoutOrigin()],
        // The runner isolates its own concerns; one that failed (a cancel left for later, a renew) is reported here too,
        // so the alarm's failure floor applies rather than a second's re-arm.
        ["runner", async () => { if ((await this.runner.alarm()).failed) throw new Error("a runner concern failed and was left for later (see its alarm_failed or cancel events)"); }],
        ["forks", () => this.ended()],
        ["notices", async () => { this.told(undefined); await this.notices.flush(); }],
      ],
      next: async () => {
        let runner: number | null = null;
        try { runner = this.runner.nextAlarm(); }
        catch (error) { console.error(JSON.stringify({ type: "workflow_alarm_failed", workflow, concern: "runner next", error: String(error) })); }
        return alarmAt(runner, this.notices.retryAt(), await this.forks.retryAt());
      },
      arm: at => this.armBy(at),
      log: (concern, error) => console.error(JSON.stringify({ type: "workflow_alarm_failed", workflow, concern, error: String(error) })),
    });
  }

  /**
   * Make sure the alarm fires by `at`, strictly in the future: an alarm already set no later stays. One set in the
   * past and not yet fired is kept too: it fires at once. (Inside the alarm handler the firing alarm reads as none.)
   */
  private async armBy(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1));
  }

  /** Once the workflow has ended: delete its children's forks, and keep the alarm for a retry if any delete failed. */
  private async ended() {
    if (!ENDED.has(this.runner.get().status)) return;
    await this.unreachable();
    const retry = await this.forks.ended();
    if (retry === undefined) return;
    await this.armBy(retry);
  }
  /** TEST_MODE: what the alarm does, now. */
  async fireAlarm() { await this.alarmed(); }
}

/**
 * TEST_MODE's way in (`/__test/workflows/:name[/:action]`, operator key only): there is no public route until the
 * owner model lands. Actions: POST create `{ code, budgetUsd?, concurrency? }`, GET, GET items|events|diff, POST
 * pause|resume|edit|abort|budget, POST alarm (fires the alarm now), POST wake.
 */
export async function workflowTestRoute(request: Request, env: WorkflowEnv, path: string, tenant: string): Promise<Response | undefined> {
  const match = /^\/__test\/workflows\/([A-Za-z0-9_-]{1,64})(?:\/([a-z]+))?$/.exec(path);
  if (!match) return undefined;
  const object = env.WORKFLOWS.getByName(match[1]!);
  const stub = Object.assign(workflowStub(env, match[1]!), { fireAlarm: () => object.fireAlarm(), wake: () => object.wake() });
  const action = match[2] ?? "", post = request.method === "POST";
  const input = post ? await request.json().catch(() => ({})) as Record<string, unknown> : {};
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  try {
    if (!action && post) return respond(await stub.create({ ...input, tenant } as never, {}), 201);
    if (!action) return respond(await stub.get());
    if (action === "items" && !post) return respond(await stub.items({ ...query, after: query.after ? Number(query.after) : undefined, limit: query.limit ? Number(query.limit) : undefined }));
    if (action === "events" && !post) return respond(await stub.events({ after: query.after ? Number(query.after) : undefined }));
    if (!post) return respond({ error: "Not found" }, 404);
    if (action === "pause") return respond(await stub.pause(input as never));
    if (action === "resume") return respond(await stub.resume());
    if (action === "abort") return respond(await stub.abort());
    if (action === "budget") return respond(await stub.setBudget((input.usd ?? null) as number | null));
    if (action === "alarm") { await stub.fireAlarm(); return respond(await stub.get()); }
    if (action === "wake") { await stub.wake(); return respond(await stub.get()); }
    return respond({ error: "Not found" }, 404);
  } catch (error) {
    return respond({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
}

// One workflow (docs/design/swarm-workflows.md, Part 1): a Durable Object whose SQLite holds the runner's journal,
// snapshot, ledger and events, and whose one alarm multiplexes timers, gate expiry, the step-rate window and the
// sweep. Its steps run in the code mode sandbox Worker (exchange protocol 3).
//
// Its `agent()` effects run on WorkflowAgents (workflow-agents.ts): children the workflow owns (`owner = { kind:
// "workflow", id }`), whose endings come back by their outboxes to `receiveEnding`. Effects of other kinds are
// composed in by kind (`byKind`). With TEST_WORKFLOW_EXECUTOR=stub a test gives the object a stand-in executor that
// answers at once instead.
import { DurableObject } from "cloudflare:workers";
import type { WorkflowSandbox } from "../codemode/workflow-protocol.ts";
import { keyServices } from "./security-services.ts";
import type { SecurityEnv } from "./security-services.ts";
import { WorkflowAgents, workflowChildren } from "./workflow-agents.ts";
import type { AgentType, ModelClass } from "./workflow-types.ts";
import type { Owner } from "../../../shared/owner.ts";
import type { Env } from "./agent-types.ts";
import {
  WorkflowRunner, WorkflowError, type CapacitySeam, type EffectExecutor, type EffectOutcome, type EffectUsage, type StartedEffect, type WorkflowInit,
} from "./workflow-runner.ts";

/** The tenant's capacity limiter (WorkflowCapacity, workflow-capacity-object.ts), as this object calls it over RPC. */
interface CapacityStub {
  open(workflow: string, asked: { concurrency?: number; leaseMs?: number }, limits: { busyAgents: number | null; computerLimit?: number | null }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  acquire(workflow: string, kind: "child", key: string, leaseMs?: number): Promise<{ ok: true; granted: true; lease: { id: string } } | { ok: true; granted: false } | { ok: false; code: string; message: string }>;
  release(workflow: string, id: string): Promise<void>;
  renew(workflow: string, leaseMs?: number): Promise<{ ok: true; held: { id: string; kind: string; key: string }[] } | { ok: false; code: string; message: string }>;
  close(workflow: string): Promise<void>;
}

export interface WorkflowEnv extends SecurityEnv {
  CODEMODE_SANDBOX: DurableObjectNamespace;
  WORKFLOWS: DurableObjectNamespace<WorkflowObject>;
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
    async open(concurrency) {
      // The tenant's busy-agent limit bounds its workflows' children (Infinity: none).
      const { accounts } = await keyServices(env);
      const { limit } = await accounts.billing.busyLimit(tenant()!);
      const opened = await stub().open(workflow, { concurrency, leaseMs: CAPACITY_LEASE_MS }, { busyAgents: Number.isFinite(limit) ? limit : null });
      return opened.ok ? { ok: true } : { ok: false, message: opened.message };
    },
    async acquire(key) {
      const slot = await stub().acquire(workflow, "child", key, CAPACITY_LEASE_MS);
      if (!slot.ok) throw refused(slot);
      return slot.granted ? { granted: true, lease: slot.lease.id } : { granted: false };
    },
    release: lease => stub().release(workflow, lease),
    async renew() {
      const renewed = await stub().renew(workflow, CAPACITY_LEASE_MS);
      if (!renewed.ok) return { ok: false, message: `${renewed.code}: ${renewed.message}` };
      return { ok: true, held: renewed.held.filter(lease => lease.kind === "child").map(lease => ({ key: lease.key, lease: lease.id })) };
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
  readonly agents: WorkflowAgents;

  constructor(ctx: DurableObjectState, env: WorkflowEnv) {
    super(ctx, env);
    const name = ctx.id.name;
    const sandbox: WorkflowSandbox = {
      step: request => (env.CODEMODE_SANDBOX.getByName(ctx.id.toString()) as unknown as WorkflowSandbox).step(request),
    };
    const self = this;
    this.agents = new WorkflowAgents({
      storage: ctx.storage,
      get workflow() { const identity = self.runner.identity(); return { id: name!, tenant: identity.tenant!, ...(identity.bucket ? { bucket: identity.bucket } : {}) }; },
      // Remaining budget from the ledger; a workflow with no cap is Infinity (its children get no share limit).
      budget: () => { const summary = self.runner.get(); return summary.budget.usd === null ? Infinity : summary.budget.usd - summary.spent.usd; },
      get concurrency() { return self.runner.get().concurrency; },
      land: (key, attempt, outcome, usage) => self.land(key, attempt, outcome, usage),
      classes: () => { const settings = self.settings(); return { ...(settings.classes ? { classes: settings.classes } : {}), ...(settings.allowFastJudgment ? { allowFastJudgment: true } : {}) }; },
      children: workflowChildren(env as unknown as Env, () => { const identity = self.runner.identity(); return { id: name!, tenant: identity.tenant! }; }, { runtimeOrigin: (env as { AGENT_PUBLIC_URL?: string }).AGENT_PUBLIC_URL }),
    });
    this.executor = env.TEST_MODE === "1" && env.TEST_WORKFLOW_EXECUTOR === "stub" ? testExecutor((...args) => this.land(...args), ctx) : byKind({ agent: this.agents });
    this.runner = new WorkflowRunner(
      { sql: ctx.storage.sql, transactionSync: fn => ctx.storage.transactionSync(fn) },
      sandbox, this.executor,
      {
        alarm: { set: at => at === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(at) },
        capacity: name ? capacitySeam(env, name, () => this.runner.identity().tenant) : undefined,
      },
    );
  }

  /**
   * Create the workflow (once; a second create returns it) and run its first step. The object is addressed by name:
   * the workflow's id (`wf_…`), unique across tenants; `tenant` is who it bills, fixed here.
   */
  async create(init: Omit<WorkflowInit, "seed" | "startedAt">, settings: WorkflowSettings = {}) {
    if (!this.ctx.id.name) throw new WorkflowError("A WorkflowObject is addressed by its workflow id (getByName)", 500);
    this.settingsTable();
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO workflow_settings (id, body) VALUES (1, ?)", JSON.stringify(settings));
    this.runner.init({ ...init, code: withArgs(init.code, this.settings().args), seed: crypto.getRandomValues(new Uint32Array(1))[0]!, startedAt: Date.now() });
    await this.runner.wake();
    return this.runner.get();
  }

  get() { return this.runner.get(); }
  /** What it was started with besides its script (its args, classes and owner). */
  settings(): WorkflowSettings {
    this.settingsTable();
    const row = this.ctx.storage.sql.exec<{ body: string }>("SELECT body FROM workflow_settings WHERE id = 1").toArray()[0];
    return row ? JSON.parse(row.body) as WorkflowSettings : {};
  }
  private settingsTable() { this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS workflow_settings (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)"); }
  /** The summary with the settings a client sees: its name, args, classes and owner. */
  view() { const { name, args, classes, owner } = this.settings(); return { ...this.runner.get(), ...(name ? { name } : {}), ...(args !== undefined ? { args } : {}), ...(classes ? { classes } : {}), ...(owner ? { owner } : {}) }; }
  items(query: Parameters<WorkflowRunner["items"]>[0]) { return this.runner.items(query); }
  diff(revision?: number) { return this.runner.diff(revision); }
  events(query: Parameters<WorkflowRunner["events"]>[0]) { return this.runner.events(query); }
  async pause(options: Parameters<WorkflowRunner["pause"]>[0]) { await this.runner.pause(options); return this.runner.get(); }
  async resume(options: Parameters<WorkflowRunner["resume"]>[0]) { await this.runner.resume(options); return this.runner.get(); }
  async edit(options: Parameters<WorkflowRunner["edit"]>[0]) { return { ...(await this.runner.edit({ ...options, code: withArgs(options.code, this.settings().args) })), workflow: this.runner.get() }; }
  async abort() { await this.runner.abort(); return this.runner.get(); }
  async setBudget(usd: number | null) { await this.runner.setBudget(usd); return this.runner.get(); }
  /** An executor's landing of effect `key:attempt`. */
  land(key: string, attempt: number, outcome: EffectOutcome, usage?: EffectUsage) { return this.runner.land(key, attempt, outcome, usage); }
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
    await this.runner.capacityGranted(grants.filter(grant => grant.kind === "child" && grant.workflow === this.ctx.id.name).map(grant => ({ key: grant.key, lease: grant.id })));
  }
  /** After an eviction or a deploy: start what was committed but not started, and run due steps. */
  wake() { return this.runner.wake(); }

  override async alarm() { await this.runner.alarm(); }
  /** TEST_MODE: what the alarm does, now. */
  fireAlarm() { return this.runner.alarm(); }
}

/**
 * TEST_MODE's way in (`/__test/workflows/:name[/:action]`, operator key only): there is no public route until the
 * owner model lands. Actions: POST create `{ code, budgetUsd?, concurrency? }`, GET, GET items|events|diff, POST
 * pause|resume|edit|abort|budget, POST alarm (fires the alarm now), POST wake.
 */
export async function workflowTestRoute(request: Request, env: WorkflowEnv, path: string, tenant: string): Promise<Response | undefined> {
  const match = /^\/__test\/workflows\/([A-Za-z0-9_-]{1,64})(?:\/([a-z]+))?$/.exec(path);
  if (!match) return undefined;
  const stub = env.WORKFLOWS.getByName(match[1]!);
  const action = match[2] ?? "", post = request.method === "POST";
  const input = post ? await request.json().catch(() => ({})) as Record<string, unknown> : {};
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  try {
    if (!action && post) return respond(await stub.create({ ...input, tenant } as never), 201);
    if (!action) return respond(await stub.get());
    if (action === "items" && !post) return respond(await stub.items({ ...query, after: query.after ? Number(query.after) : undefined, limit: query.limit ? Number(query.limit) : undefined }));
    if (action === "events" && !post) return respond(await stub.events({ after: query.after ? Number(query.after) : undefined }));
    if (action === "diff" && !post) return respond(await stub.diff(query.revision ? Number(query.revision) : undefined));
    if (!post) return respond({ error: "Not found" }, 404);
    if (action === "pause") return respond(await stub.pause(input as never));
    if (action === "resume") return respond(await stub.resume(input as never));
    if (action === "edit") return respond(await stub.edit(input as never));
    if (action === "abort") return respond(await stub.abort());
    if (action === "budget") return respond(await stub.setBudget((input.usd ?? null) as number | null));
    if (action === "alarm") { await stub.fireAlarm(); return respond(await stub.get()); }
    if (action === "wake") { await stub.wake(); return respond(await stub.get()); }
    return respond({ error: "Not found" }, 404);
  } catch (error) {
    return respond({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
}

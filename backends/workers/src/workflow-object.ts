// One workflow (docs/design/swarm-workflows.md, Part 1): a Durable Object whose SQLite holds the runner's journal,
// snapshot, ledger and events, and whose one alarm multiplexes timers, gate expiry, the step-rate window and the
// sweep. Its steps run in the code mode sandbox Worker (exchange protocol 3).
//
// Internal for now: there is no public route or builtin. A workflow's children need the delegation owner model
// (#792), which makes the workflow the owner of the agents it starts; until it lands `agent()` and `gate()` have no
// executor in production (`unwiredExecutor`) and nothing outside tests creates a workflow. TEST_MODE gives the
// object a stand-in executor that answers at once, so the fixture can drive a workflow end to end.
import { DurableObject } from "cloudflare:workers";
import type { WorkflowSandbox } from "../codemode/workflow-protocol.ts";
import {
  WorkflowRunner, WorkflowError, type EffectExecutor, type EffectOutcome, type EffectUsage, type StartedEffect, type WorkflowInit,
} from "./workflow-runner.ts";

export interface WorkflowEnv {
  CODEMODE_SANDBOX: DurableObjectNamespace;
  WORKFLOWS: DurableObjectNamespace<WorkflowObject>;
  TEST_MODE?: string;
}

/**
 * The seam the owner model fills: an executor that starts `agent` effects as children owned by this workflow (the
 * delegation path, `callId` = the effect key, attempt = the effect's attempt) and `gate` effects as inbox items the
 * workflow owns, and lands their endings through `WorkflowObject.land`. Until then every start is refused loudly.
 */
export const unwiredExecutor: EffectExecutor = {
  async start(effect) {
    throw new WorkflowError(`Workflow ${effect.kind}() has no executor yet: it needs the delegation owner model (#792)`, 501);
  },
};

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

  constructor(ctx: DurableObjectState, env: WorkflowEnv) {
    super(ctx, env);
    const sandbox: WorkflowSandbox = {
      step: request => (env.CODEMODE_SANDBOX.getByName(ctx.id.toString()) as unknown as WorkflowSandbox).step(request),
    };
    const executor = env.TEST_MODE === "1" ? testExecutor((...args) => this.land(...args), ctx) : unwiredExecutor;
    this.runner = new WorkflowRunner(
      { sql: ctx.storage.sql, transactionSync: fn => ctx.storage.transactionSync(fn) },
      sandbox, executor,
      { alarm: { set: at => at === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(at) } },
    );
  }

  /** Create the workflow (once; a second create returns it) and run its first step. */
  async create(init: Omit<WorkflowInit, "seed" | "startedAt">) {
    this.runner.init({ ...init, seed: crypto.getRandomValues(new Uint32Array(1))[0]!, startedAt: Date.now() });
    await this.runner.wake();
    return this.runner.get();
  }

  get() { return this.runner.get(); }
  items(query: Parameters<WorkflowRunner["items"]>[0]) { return this.runner.items(query); }
  diff(revision?: number) { return this.runner.diff(revision); }
  events(query: Parameters<WorkflowRunner["events"]>[0]) { return this.runner.events(query); }
  async pause(options: Parameters<WorkflowRunner["pause"]>[0]) { await this.runner.pause(options); return this.runner.get(); }
  async resume(options: Parameters<WorkflowRunner["resume"]>[0]) { await this.runner.resume(options); return this.runner.get(); }
  async edit(options: Parameters<WorkflowRunner["edit"]>[0]) { return { ...(await this.runner.edit(options)), workflow: this.runner.get() }; }
  async abort() { await this.runner.abort(); return this.runner.get(); }
  async setBudget(usd: number | null) { await this.runner.setBudget(usd); return this.runner.get(); }
  /** An executor's landing of effect `key:attempt`. */
  land(key: string, attempt: number, outcome: EffectOutcome, usage?: EffectUsage) { return this.runner.land(key, attempt, outcome, usage); }
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
export async function workflowTestRoute(request: Request, env: WorkflowEnv, path: string): Promise<Response | undefined> {
  const match = /^\/__test\/workflows\/([A-Za-z0-9_-]{1,64})(?:\/([a-z]+))?$/.exec(path);
  if (!match) return undefined;
  const stub = env.WORKFLOWS.getByName(match[1]!);
  const action = match[2] ?? "", post = request.method === "POST";
  const input = post ? await request.json().catch(() => ({})) as Record<string, unknown> : {};
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  try {
    if (!action && post) return respond(await stub.create(input as never), 201);
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

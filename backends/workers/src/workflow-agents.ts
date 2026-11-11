// A workflow's `agent()` effects (docs/design/swarm-workflows.md, "Children and exactly-once"): the real executor
// behind `EffectExecutor` (workflow-runner.ts). The workflow object owns its children as an agent does
// (`owner = { kind: "workflow", id }`, the `children` table in its own SQLite); each child is a real agent started
// through the binding with its placement, and its ending comes back by the child's own outbox (ending-outbox.ts) to the
// workflow's `receiveEnding`, which lands it on the effect.
//
// Exactly once: an effect's child is keyed by `key:attempt` (attemptedCall). Its row is written before anything is
// made, the child is made under a key derived from it and its run submitted with a request id derived from it, so a
// start made again (after a restart, or `wake()`) finds the same row, the same agent and the same request. A new
// attempt (a rerun, a re-issue after `payer_exhausted`) is a new child.
import type { EffectExecutor, EffectOutcome, StartedEffect } from "./workflow-runner.ts";
import { ChildRows } from "./children-table.ts";
import { callIdentity, childUsageCost, type ChildRun, type DelegatedChild } from "./delegation.ts";
import type { ChildEnding, ChildProgress, Receipt } from "./ending-outbox.ts";
import { childStatus, MULTI_AGENT_LIMITS, modelOutputSchema, roleAndTask, SUBAGENT_PROMPT } from "./multi-agent-policy.ts";
import { digest } from "./api-contract.ts";
import type { Owner, Placement } from "../../../shared/owner.ts";
import { recordChildParent, type ChildPlace } from "./child-parent.ts";
import { Directory } from "./control.ts";
import { provisionDefinition, resolveDefinition } from "./definitions.ts";
import type { Env } from "./agent-types.ts";

/** What a script's `agent(prompt, opts)` issues (workflow-vm.ts): its prompt and its options but `key`. */
export type AgentArgs = { prompt: string; definition?: string; instructions?: string; model?: string; output?: unknown; label?: string; type?: string; [option: string]: unknown };

/**
 * A refusal for money, landed as the effect's outcome: the runner marks the effect `refused` and pauses the workflow
 * with `code` (resume re-issues it under the next attempt). The script never sees it.
 */
export type Refused = { refused: string; code: "payer_exhausted" | "budget_exhausted" };
export type LandedOutcome = EffectOutcome | Refused;
/** What a child spent, for the workflow's ledger: landed with its outcome, which the ledger keys by `key:attempt`. */
export type EffectUsage = { costUsd: number; model?: string; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; durationMs?: number };

/** Below this (USD) what is left of a budget cannot pay for a child's turn: the workflow pauses with `budget_exhausted`. */
export const MIN_CHILD_BUDGET_USD = 0.01;

export interface WorkflowAgentsHost {
  storage: DurableObjectStorage;
  workflow: { id: string; tenant: string; bucket?: string };
  /**
   * What is left of the workflow's budget (`budget.usd` less its ledger), in USD; `Infinity` for a workflow with no cap,
   * whose children then run with no spend limit of the workflow's (the tenant's own limits still apply). Never undefined.
   */
  budget(): Promise<number> | number;
  /** Children running at once, at most (the workflow's `concurrency`). */
  concurrency: number;
  /**
   * The effect ended (`WorkflowRunner.land`): its result, or a refusal, with what its child spent. Landed again (a
   * redelivery after a crash), the runner keeps the first landing and the ledger its one row per `key:attempt`, so a
   * child's spend reaches the ledger exactly once however often its ending comes.
   */
  land(key: string, attempt: number, outcome: LandedOutcome, usage?: EffectUsage): Promise<void>;
  /** Everything that reaches outside the workflow object (workflowChildren for the real one). */
  children: WorkflowChildren;
}

/** Making and reaching child agents. */
export interface WorkflowChildren {
  /** The child's configuration: its definition's, or an inline child's on the workflow's default model. */
  config(args: AgentArgs): Promise<Record<string, unknown>>;
  /** Make the child under `key` (the same key makes the same agent), recording its place under the workflow. */
  create(config: Record<string, unknown>, key: string, place: ChildPlace & { ownerRun: string }): Promise<{ id: string }>;
  /** Start its run through the binding, with its placement (agent.ts `admitDelegated`). */
  submit(childId: string, request: { id: string; method: "prompt"; params: Record<string, unknown> }, placement: Placement): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  /** Stop exactly that run. */
  cancel(childId: string, requestId: string): Promise<unknown>;
}

/** The workflow's one run (steps are not runs): what its children's placements name as the owner's run. */
export const workflowRun = (id: string) => `${id}:main`;

const ROW_PREFIX = "workflow-";
/** A child's row in the workflow's table: queued (no slot yet), running, or how it ended. */
type Row = DelegatedChild & { effectKey: string; args?: AgentArgs; refusal?: Refused; startedRun?: number };

function owner(id: string): Owner { return { kind: "workflow", id }; }

/**
 * Configuration a workflow's child never takes from a definition: no computer (`job()` is a workflow's compute), no
 * `subject` (admission and billing charge an agent's subject's end-user pool: a workflow's children bill its tenant),
 * and no agent spend limit of its own (each run's spend limit is its share of the workflow's budget).
 */
export const WORKFLOW_CHILD_REFUSED_KEYS = ["computer", "subject", "spendLimit"] as const;

/** What `agent()` returns: a schema's validated object, else the text; a failed or aborted child is an error. */
export function agentOutcome(record: ChildRun): EffectOutcome {
  const result = record.outcome?.result;
  const status = childStatus(record);
  if (status === "completed" && !result?.stopped) return { ok: true, value: result?.output !== undefined ? result.output : result?.reply ?? "" };
  return { ok: false, error: record.error ?? record.outcome?.error ?? (result?.stopped ? `The sub-agent stopped: ${result.stopped}` : `The sub-agent ${status}`) };
}

/** What a child's run spent, as the ledger keeps it. */
export function effectUsage(record: ChildRun | undefined, durationMs?: number): EffectUsage | undefined {
  const usage = record?.outcome?.result?.usage as (Record<string, unknown> & Parameters<typeof childUsageCost>[0]) | undefined;
  if (!usage) return undefined;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  return {
    costUsd: childUsageCost(usage),
    ...(typeof usage.model === "string" ? { model: usage.model } : {}),
    ...(number(usage.input) !== undefined ? { inputTokens: number(usage.input) } : {}),
    ...(number(usage.cacheRead) !== undefined ? { cachedInputTokens: number(usage.cacheRead) } : {}),
    ...(number(usage.output) !== undefined ? { outputTokens: number(usage.output) } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** A start that may be tried again with the same request: the child (or the directory) unreachable, or a 5xx. */
const retryable = (status: number | undefined) => status === undefined || status >= 500;

export class WorkflowAgents implements EffectExecutor {
  readonly rows: ChildRows;
  private readonly host: WorkflowAgentsHost;
  private pumping?: Promise<void>;
  constructor(host: WorkflowAgentsHost) {
    this.host = host;
    this.rows = new ChildRows(host.storage);
  }

  private async keyOf(effect: { key: string; attempt: number }) {
    return (await callIdentity(workflowRun(this.host.workflow.id), effect.key, effect.attempt)).slice(0, 48);
  }

  /**
   * Start `agent()` effect `key:attempt`: its row first, then (when a slot is free) its child. Made again, it finds the
   * row: a queued or running child goes on, an ended one lands its outcome again (the runner keeps the first).
   */
  async start(effect: StartedEffect): Promise<void> {
    if (effect.kind !== "agent") throw new Error(`WorkflowAgents runs agent() effects, not ${effect.kind}`);
    const args = effect.args as AgentArgs;
    const identity = await this.keyOf(effect), key = ROW_PREFIX + identity;
    const existing = await this.rows.get(key) as Row | undefined;
    if (existing) {
      if (existing.status !== "running" && existing.status !== "queued") await this.settle(existing);
      return this.recover();
    }
    if (!args || typeof args.prompt !== "string" || !args.prompt) return this.host.land(effect.key, effect.attempt, { ok: false, error: "agent() needs a prompt" });
    if (args.computer !== undefined) return this.host.land(effect.key, effect.attempt, { ok: false, error: "A workflow's agents have no computer: run a job() for compute" });
    const row: Row = {
      id: "", key, effectKey: effect.key, attempt: effect.attempt, callId: effect.key, toolCallId: effect.key, outbox: true,
      owner: owner(this.host.workflow.id), rootOwner: owner(this.host.workflow.id), chain: [this.host.workflow.id], root: this.host.workflow.id,
      depth: 1, maxDepth: MULTI_AGENT_LIMITS.maxDepth, requestId: `workflow_${identity}`, parentRequestId: workflowRun(this.host.workflow.id),
      name: typeof args.label === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(args.label) ? args.label : `agent-${identity.slice(0, 8)}`,
      background: true, made: true, createdAt: Date.now(), status: "queued", args,
      ...(this.host.workflow.bucket ? { bucket: this.host.workflow.bucket } : {}),
    };
    await this.rows.put(row);
    await this.pump();
  }

  /** Start queued children while slots and budget allow, oldest first. One pump at a time. */
  pump(): Promise<void> {
    this.pumping ??= this.pumpOnce().finally(() => { this.pumping = undefined; });
    return this.pumping;
  }

  private async pumpOnce() {
    for (;;) {
      const running = (await this.rows.withStatus("running")) as Row[];
      const [next] = (await this.rows.withStatus("queued")) as Row[];
      if (!next || running.length >= this.host.concurrency) return;
      await this.launch(next, running);
    }
  }

  /**
   * After a restart: a child marked running whose start was not acknowledged is submitted again (the same request,
   * which it dedupes), then queued ones start. The workflow object calls this as it wakes.
   */
  async recover() {
    const running = (await this.rows.withStatus("running")) as Row[];
    for (const row of running.filter(row => !row.accepted && !row.cancelRequested)) await this.launch(row, running.filter(other => other !== row));
    await this.pump();
  }

  /** End a row that never ran (refused, failed, aborted) and land it, unless it moved on meanwhile (an abort). */
  private async end(row: Row, status: string, outcome: LandedOutcome) {
    const ended = await this.host.storage.transaction(async tx => {
      const current = await this.rows.get(row.key) as Row | undefined;
      if (current && current.status !== row.status) return undefined;
      const next: Row = { ...row, status, endedAt: Date.now(), held: undefined, ...("refused" in outcome ? { refusal: outcome, error: outcome.refused } : outcome.ok ? {} : { error: outcome.error }) };
      await this.rows.put(next, tx);
      return next;
    });
    if (ended) await this.settle(ended);
  }

  private async launch(row: Row, running: Row[]) {
    // Its share of what is left: the remaining budget less what running children hold, over the free slots. A start
    // made again keeps the share it was given (its request must be the same to dedupe).
    let held = row.held;
    if (row.status === "queued") {
      const left = await this.host.budget();
      // A host that says nothing about the budget is a bug, not an unlimited workflow: no cap is said with Infinity.
      if (typeof left !== "number" || Number.isNaN(left)) return this.end(row, "refused", { refused: "The workflow's budget is unknown", code: "budget_exhausted" });
      if (Number.isFinite(left)) {
        const free = left - running.reduce((sum, child) => sum + (child.held ?? 0), 0);
        if (free < MIN_CHILD_BUDGET_USD) return this.end(row, "refused", { refused: "The workflow's budget is spent", code: "budget_exhausted" });
        held = free / Math.max(1, this.host.concurrency - running.length);
      }
    }
    const args = row.args!;
    const place: ChildPlace & { ownerRun: string } = { depth: row.depth, maxDepth: row.maxDepth!, chain: row.chain!, owner: row.owner, rootOwner: row.rootOwner, ownerRun: row.parentRequestId };
    try {
      if (!row.id) {
        const config = await this.host.children.config(args);
        for (const name of WORKFLOW_CHILD_REFUSED_KEYS) delete config[name];
        const { id } = await this.host.children.create({ ...config, name: row.name, type: "subagent", ttlSeconds: MULTI_AGENT_LIMITS.childTtlSeconds, ...(row.bucket ? { bucket: row.bucket } : {}) }, row.key, place);
        row = { ...row, id };
      }
      // Running before it is submitted, unless an abort (or anything else) moved the row on while the child was being
      // made: then nothing is started. A start made again after a crash here submits the same request, which dedupes.
      const claimed = await this.host.storage.transaction(async tx => {
        const current = await this.rows.get(row.key) as Row | undefined;
        if (!current || current.status !== row.status || current.cancelRequested) return undefined;
        const next: Row = { ...current, id: row.id, status: "running", startedRun: current.startedRun ?? Date.now(), ...(held !== undefined ? { held } : {}) };
        await this.rows.put(next, tx);
        return next;
      });
      if (!claimed) return;
      row = claimed;
      const text = args.instructions === undefined ? args.prompt : roleAndTask(String(args.instructions), args.prompt);
      const placement: Placement = { owner: row.owner!, rootOwner: row.rootOwner!, chain: row.chain!, depth: row.depth, maxDepth: row.maxDepth!, toolCallId: row.effectKey, ownerRun: row.parentRequestId };
      const submitted = await this.host.children.submit(row.id, { id: row.requestId, method: "prompt", params: {
        text, ...(row.bucket ? { bucket: row.bucket } : {}), whileRunning: "queue",
        metadata: { workflowId: this.host.workflow.id, effectKey: row.effectKey, effectAttempt: String(row.attempt) },
        ...(row.held !== undefined ? { spendLimit: { usd: row.held } } : {}),
        ...(args.output !== undefined ? { output: { schema: modelOutputSchema(args.output) } } : {}),
      } }, placement);
      if (!submitted.ok) {
        if (submitted.status === 402) return this.end(row, "refused", { refused: submitted.error || "The workflow's tenant has no credit left", code: "payer_exhausted" });
        if (retryable(submitted.status)) throw Object.assign(new Error(submitted.error || "The sub-agent's start failed"), { status: submitted.status });
        return this.end(row, "failed", { ok: false, error: submitted.error || "The sub-agent could not be started" });
      }
      const current = await this.rows.get(row.key) as Row | undefined;
      if (current?.status === "running") await this.rows.put({ ...current, accepted: true });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 402) return this.end(row, "refused", { refused: (error as Error).message, code: "payer_exhausted" });
      // The directory or the child unreachable, or a 5xx: the same start is made again (recover, or the runner's wake),
      // with the same key and request, which dedupe. The row keeps its place (queued, or running unacknowledged).
      if (retryable(status)) throw error;
      return this.end(row, "failed", { ok: false, error: error instanceof Error ? error.message : "The sub-agent could not be started" });
    }
  }

  /** Land an ended row on its effect, with what its child spent (the ledger keeps one row per `key:attempt`). */
  private async settle(row: Row) {
    const usage = effectUsage(row.outcome ? { state: "completed", outcome: row.outcome } : undefined, row.endedAt && row.startedRun ? row.endedAt - row.startedRun : undefined);
    const outcome: LandedOutcome = row.refusal ?? (row.outcome ? agentOutcome({ state: "completed", status: row.status, outcome: row.outcome, error: row.error }) : { ok: false, error: row.error ?? `The sub-agent ${row.status}` });
    return this.host.land(row.effectKey, row.attempt ?? 1, outcome, usage);
  }

  /**
   * A child's ending, from its outbox (the workflow object's `receiveEnding`). Idempotent: the row's status decides in
   * one transaction whether this delivery ends it; either way the effect is landed (again) with its usage, since the
   * runner keeps the first landing and the ledger one row per effect, and a crash may have come between the two. The
   * receipt goes back only after the landing, so the child delivers again until it is made.
   */
  async receiveEnding(ending: ChildEnding): Promise<Receipt> {
    let row = await this.rows.byRun(ending.agentId, ending.requestId) as Row | undefined ?? await this.resumed(ending);
    if (!row || row.id !== ending.agentId) return { accepted: false };
    if (ending.record?.state !== "completed") return { accepted: true };
    const record = ending.record;
    row = await this.host.storage.transaction(async tx => {
      const current = await this.rows.get(row!.key) as Row ?? row!;
      if (current.status !== "running") return current;
      const stopped = record.outcome?.result?.stopped === "spend_limit";
      const spent = childUsageCost(record.outcome?.result?.usage);
      // Stopped at its spend limit: its share of the workflow's budget is spent (budget_exhausted), or, short of it,
      // its tenant's credit is (payer_exhausted).
      const refusal: Refused | undefined = stopped ? (current.held !== undefined && spent >= current.held * 0.99
        ? { refused: "The sub-agent spent its share of the workflow's budget", code: "budget_exhausted" }
        : { refused: record.error ?? record.outcome?.error ?? "The workflow's tenant has no credit left", code: "payer_exhausted" }) : undefined;
      const next: Row = { ...current, status: refusal ? "refused" : childStatus(record), endedAt: Date.now(), outcome: record.outcome, error: record.error ?? record.outcome?.error, spent, held: undefined, ...(refusal ? { refusal } : {}) };
      await this.rows.put(next, tx);
      return next;
    });
    // A child waiting on a person has not ended: its resumed run's ending comes later (`resumed`).
    if (row.status === "input_required") return { accepted: true };
    await this.settle(row);
    await this.pump();
    return { accepted: true };
  }

  /** A child that waited on a person runs again under `resume_<digest of its run>`: the same row takes that ending. */
  private async resumed(ending: ChildEnding): Promise<Row | undefined> {
    if (!ending.requestId.startsWith("resume_")) return;
    for (const row of await this.rows.ofChild(ending.agentId) as Row[]) {
      if (row.status !== "input_required") continue;
      if (ending.requestId !== `resume_${(await digest(row.requestId)).slice(0, 40)}`) continue;
      const resumed: Row = { ...row, status: "running", requestId: ending.requestId };
      await this.rows.put(resumed);
      return resumed;
    }
  }

  /** A child's progress report: its latest, on its row (the items API shows it). Never lands anything. */
  async receiveProgress(report: ChildProgress): Promise<Receipt> {
    const row = await this.rows.byRun(report.agentId, report.requestId);
    if (!row) return { accepted: false, error: "Unknown sub-agent run" };
    if (row.status === "running" && !(row.progressCalls ?? []).includes(report.callId))
      await this.rows.put({ ...row, progress: { text: String(report.text).slice(0, MULTI_AGENT_LIMITS.progressChars), at: Date.now(), sequence: (row.progressCalls?.length ?? 0) + 1 }, progressCalls: [...row.progressCalls ?? [], report.callId] });
    return { accepted: true };
  }

  /** Stop one effect's child (the runner's per-effect cancel, on abort or a pause that aborts children). */
  async cancel(effect: { key: string; attempt: number }) {
    const row = await this.rows.get(ROW_PREFIX + await this.keyOf(effect)) as Row | undefined;
    if (row) await this.stop(row);
  }

  private async stop(row: Row) {
    if (row.status === "queued") {
      await this.host.storage.transaction(async tx => {
        const current = await this.rows.get(row.key) as Row | undefined;
        if (current?.status === "queued") await this.rows.put({ ...current, status: "aborted", endedAt: Date.now(), error: "The workflow was aborted" }, tx);
      });
      return;
    }
    // Re-read in a transaction: the row passed in may be stale (abort() reads every row first, and an ending may land
    // during an earlier row's cancel), and writing it back would turn an ended child running again.
    const current = await this.host.storage.transaction(async tx => {
      const current = await this.rows.get(row.key) as Row | undefined;
      if (current?.status !== "running") return undefined;
      const next = { ...current, cancelRequested: true };
      await this.rows.put(next, tx);
      return next;
    });
    if (current?.id) await this.host.children.cancel(current.id, current.requestId);
  }

  /**
   * The workflow was aborted: queued children never start, running ones are stopped (each stops its own children, as
   * an aborted run does), and one being made right now is not started once made. Their endings still come and land;
   * the runner of an aborted workflow takes nothing from them.
   */
  async abort() {
    for (const row of await this.rows.all() as Row[]) await this.stop(row);
  }
}

/**
 * The real `WorkflowChildren` for a workflow object: children are agents of the workflow's tenant, made through the
 * directory under the effect's key, placed under the workflow (their header's `owner`, `rootOwner`; recordChildParent),
 * and started through `admitDelegated`. `defaults.model` is the workflow's default model for inline children.
 */
export function workflowChildren(env: Env, workflow: { id: string; tenant: string }, defaults: { model?: unknown; runtimeOrigin?: string } = {}): WorkflowChildren {
  return {
    async config(args) {
      if (typeof args.definition === "string") {
        const definition = await resolveDefinition(env, workflow.tenant, args.definition);
        return await provisionDefinition(env, workflow.tenant, { definition: definition.id }) as Record<string, unknown>;
      }
      const model = args.model ?? defaults.model;
      return { ...(model !== undefined ? { model } : {}), systemPrompt: SUBAGENT_PROMPT };
    },
    async create(config, key, place) {
      const entry = await new Directory(env, workflow.tenant).upsert(config, key, defaults.runtimeOrigin);
      if ("failed" in entry) throw Object.assign(new Error(entry.error), { status: entry.status ?? 400 });
      await recordChildParent(env, workflow.tenant, entry.id, workflow.id, place.ownerRun, place);
      return { id: entry.id };
    },
    submit: (childId, request, placement) => env.AGENTS.getByName(childId).admitDelegated(request, placement),
    cancel: (childId, requestId) => env.AGENTS.getByName(childId).cancelRequest(requestId),
  };
}

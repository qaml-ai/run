// A workflow's `gate()` (docs/design/swarm-workflows.md, "Long waits, gates, timers"): a decision for a person, as an
// item in the account's inbox (`agent_inputs`, the decision kind `request_decision` uses), owned by the workflow
// (`owner_kind = 'workflow'`, and `agent` the workflow's id, so `POST /v1/inbox/answers` routes its answer here). The
// workflow waits durably: its effect stays pending, its expiry is the runner's due time on the object's one alarm, and
// the answer lands on the effect exactly once (the row is settled compare-and-set, and the runner keeps the first
// landing). A restart finds the item by its id, fixed by the effect: one that was answered lands; one never written is
// written now.
import { createHash } from "node:crypto";
import { answerInboxGroup, type InboxAnswer, type InboxOutcome } from "../../../shared/inbox-answers.ts";
import { answerInput, decisionDetail, expiryAnswer, Inputs, mayAnswer, type InputRow, type Responder } from "./decision-inputs.ts";
import { transaction, type Db } from "./postgres.ts";
import { enqueueEvents, webhookEvent } from "./webhook-policy.ts";
import type { EffectExecutor, EffectOutcome, StartedEffect } from "./workflow-runner.ts";

/** A gate's item: the same one for the same effect `key:attempt`, made again or not. */
export const gateInputId = (workflow: string, key: string, attempt: number) =>
  `inp_${createHash("sha256").update(JSON.stringify(["workflow-gate", workflow, key, attempt])).digest("hex").slice(0, 32)}`;
const ROW = "workflow-gate:";
/** An open gate: its item and its effect. */
type Open = { id: string; key: string; attempt: number };
/** A gate whose expiry paused its workflow stays answerable this much longer: the answer lands and a resume goes on. */
export const GATE_PAUSED_ANSWERABLE_MS = 30 * 86_400_000;

export interface WorkflowGatesHost {
  workflow: { id: string; tenant: string };
  db(): Db;
  storage: Pick<DurableObjectStorage, "get" | "put" | "delete" | "list">;
  /** The effect's outcome (WorkflowRunner.land): never awaited from `start`, which the runner calls inside its step. */
  land(key: string, attempt: number, outcome: EffectOutcome): Promise<void>;
  defer(task: () => Promise<void>): void;
  /** Who may answer besides anyone the account vouches for (the owner agent's `humanInput.approvers`), and its subject. */
  audience(): Promise<{ approvers?: string[]; subject?: string }>;
  /** A gate opened (the object delivers anything staged; the owner is not told of a gate). */
  opened(gate: { key: string; inputId: string; title: string; expiresAt: number }): void;
}

/** What `gate()` gives the script for an answer: the chosen option (or the person's words), else the whole answer. */
export function gateValue(input: Pick<InputRow, "detail" | "answer">): unknown {
  const answer = input.answer;
  if (!answer || answer.action !== "accept") return null;
  const answers = (answer.content as { answers?: Record<string, unknown> } | undefined)?.answers;
  const title = input.detail.title as string;
  return answers && Object.hasOwn(answers, title) ? answers[title] : answer.content ?? null;
}

/** The decision a script's `gate({ title, body?, options?, recommended?, reason?, priority? })` asks. */
export function gateDetail(args: Record<string, unknown>) {
  const title = typeof args.title === "string" ? args.title : args.question;
  const options = Array.isArray(args.options) ? args.options.map(option => typeof option === "string" ? { label: option } : option) : undefined;
  // A label (or the person's own words); any other value is shown as its JSON.
  const recommended = args.recommended === undefined || typeof args.recommended === "string" ? args.recommended : JSON.stringify(args.recommended);
  return decisionDetail({
    title, body: typeof args.body === "string" ? args.body : "", ...(options ? { options } : {}),
    ...(args.priority !== undefined ? { priority: args.priority } : {}), ...(Array.isArray(args.links) ? { links: args.links } : {}),
    ...(recommended !== undefined ? { recommendation: { answer: recommended, reason: typeof args.reason === "string" && args.reason.trim() ? args.reason : "The workflow's recommendation" } } : {}),
  });
}

/**
 * When a gate's item expires: the runner's deadline for the gate, so the inbox and the workflow agree on it (the runner
 * decides at that deadline, and moves a paused gate's item on). A gate with no deadline left (its expiry paused the
 * workflow) stays answerable for GATE_PAUSED_ANSWERABLE_MS.
 */
function deadline(effect: StartedEffect, now = Date.now()) {
  if (effect.dueAt !== undefined) return effect.dueAt;
  return now + GATE_PAUSED_ANSWERABLE_MS;
}

export class WorkflowGates implements EffectExecutor {
  private readonly host: WorkflowGatesHost;
  constructor(host: WorkflowGatesHost) { this.host = host; }
  private inputs() { return new Inputs({ db: this.host.db() }); }

  /** Open the gate: its record here first (so a restart finds it), then its item, from the background. */
  async start(effect: StartedEffect): Promise<void> {
    if (effect.kind !== "gate") throw new Error(`WorkflowGates runs gate(), not ${effect.kind}()`);
    const id = gateInputId(this.host.workflow.id, effect.key, effect.attempt);
    let detail: ReturnType<typeof gateDetail>;
    try { detail = gateDetail(effect.args as Record<string, unknown>); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.host.defer(() => this.host.land(effect.key, effect.attempt, { ok: false, error: `gate(): ${message}` }));
      return;
    }
    await this.host.storage.put(ROW + id, { id, key: effect.key, attempt: effect.attempt } satisfies Open);
    this.host.defer(() => this.open(id, effect, detail, deadline(effect)));
  }

  /** Write the item, once: a second write of the same id (a restart) changes nothing. */
  private async open(id: string, effect: Pick<StartedEffect, "key" | "attempt">, detail: ReturnType<typeof gateDetail>, expiresAt: number) {
    const { workflow } = this.host;
    const { approvers, subject } = await this.host.audience();
    const createdAt = Date.now();
    const stored = { message: detail.title, detail, responders: {}, tool: "gate", argumentsHash: id };
    const priority = (detail as { priority?: string }).priority ?? "normal";
    const rank = { urgent: 0, high: 1, normal: 2, low: 3 }[priority as "urgent" | "high" | "normal" | "low"] ?? 2;
    const inserted = await transaction(this.host.db(), async sql => {
      const { rowCount } = await sql.query(`insert into agent_inputs (id, agent, tenant, request_id, tool_call_id, kind, input, created_at, expires_at,
        priority, priority_rank, blocking, responders, root_agent, lineage, item_key, subject, owner_kind, owner_id)
        values ($1, $2, $3, $4, $5, 'decision', $6, $7, $8, $9, $10, false, $11, $2, $12, $13, $14, 'workflow', $2) on conflict (id) do nothing`,
        [id, workflow.id, workflow.tenant, workflow.id, `${effect.key}:${effect.attempt}`, JSON.stringify(stored), createdAt, expiresAt,
          priority, rank, approvers ?? [], [workflow.id], effect.key.slice(0, 200), subject ?? null]);
      if (!rowCount) return false;
      await enqueueEvents(sql, [webhookEvent("input.requested", workflow.tenant, { agentId: workflow.id, requestId: workflow.id, inputId: id, toolCallId: `${effect.key}:${effect.attempt}`, kind: "decision", expiresAt, workflowId: workflow.id }, `input.requested:${id}`)]);
      await sql.query("select pg_notify('inbox', $1)", [workflow.tenant]);
      return true;
    });
    if (inserted) this.host.opened({ key: effect.key, inputId: id, title: detail.title, expiresAt });
  }

  /** The gate's item, if it is this workflow's. */
  private async item(id: string): Promise<InputRow | undefined> {
    const found = (await this.host.db().query("select owner_kind, owner_id, tenant from agent_inputs where id = $1", [id])).rows[0];
    if (!found || found.owner_kind !== "workflow" || found.owner_id !== this.host.workflow.id || found.tenant !== this.host.workflow.tenant) return undefined;
    return this.inputs().get(id);
  }

  /** Land a settled item on its effect, and forget the gate; a pending one stays. */
  private async settled(open: Open, input: InputRow) {
    if (input.state === "pending") return false;
    // An expiry the runner already decided (the recommendation, or a pause) is not landed again here.
    if ((input.answer?.by as Responder | undefined)?.system !== "expired") await this.host.land(open.key, open.attempt, { ok: true, value: gateValue(input) });
    await this.host.storage.delete(ROW + open.id);
    return true;
  }

  /**
   * `POST /v1/inbox/answers` for this workflow's gates: checked as any inbox answer (who may answer, the version, what
   * fits the question), settled compare-and-set, and landed on the effect.
   */
  async answer(answers: InboxAnswer[]): Promise<InboxOutcome[]> {
    const { approvers } = await this.host.audience();
    return answerInboxGroup(answers, async id => {
      const input = await this.item(id);
      return input && { ...input, detail: input.detail };
    }, (input, body) => {
      if (!mayAnswer(input, { via: "api", actor: body.actor, from: body.from }, approvers ?? []))
        throw Object.assign(new Error("This person may not answer this input"), { status: 403 });
      return answerInput(input, body);
    }, async group => {
      // Every item was pending when checked: one settled since (another answer, an expiry) fails the write, and each
      // item is classified again (an answer of ours that went in is `same`).
      let status = 202;
      for (const { id, body } of group) {
        const answer = { action: body.action, ...(body.content !== undefined ? { content: body.content } : {}), by: { via: "api" as const, ...(body.actor ? { actor: body.actor } : {}), ...(body.from ? { from: body.from } : {}) }, at: Date.now() };
        const done = await this.inputs().settle(id, answer);
        if (!done) throw Object.assign(new Error("Input is already settled"), { status: 409 });
        const open = await this.host.storage.get<Open>(ROW + id);
        if (open) await this.settled(open, done);
      }
      return { status };
    });
  }

  /**
   * After a restart: an item answered while its landing was lost lands. Deferred, as the runner calls this inside its
   * step, which a landing waits for.
   */
  async recover() { this.host.defer(() => this.recoverNow()); }
  private async recoverNow() {
    for (const [, open] of await this.host.storage.list<Open>({ prefix: ROW })) {
      const input = await this.inputs().get(open.id);
      if (input) await this.settled(open, input);
    }
  }
  async poll(effect: StartedEffect) {
    const id = gateInputId(this.host.workflow.id, effect.key, effect.attempt);
    const open = await this.host.storage.get<Open>(ROW + id);
    const input = await this.inputs().get(id);
    if (!input && open) {
      // Its item was never written (a crash before it was): write it now.
      this.host.defer(() => this.open(id, effect, gateDetail(effect.args as Record<string, unknown>), deadline(effect)));
      return undefined;
    }
    if (!input || input.state === "pending") return undefined;
    if (open) await this.host.storage.delete(ROW + id);
    return (input.answer?.by as Responder | undefined)?.system === "expired" ? undefined : { outcome: { ok: true, value: gateValue(input) } as EffectOutcome };
  }

  /** The workflow ended, or the effect was dropped: its item leaves the inbox (withdrawn, nobody answered). */
  async cancel(effect: StartedEffect) {
    const id = gateInputId(this.host.workflow.id, effect.key, effect.attempt);
    await this.inputs().settle(id, { action: "cancel", by: { system: "aborted" }, at: Date.now() }, "withdrawn");
    await this.host.storage.delete(ROW + id);
  }
  async abort() {
    for (const [, open] of await this.host.storage.list<Open>({ prefix: ROW })) {
      await this.inputs().settle(open.id, { action: "cancel", by: { system: "aborted" }, at: Date.now() }, "withdrawn");
      await this.host.storage.delete(ROW + open.id);
    }
  }

  /**
   * The gate at its deadline (the runner's alarm, before it decides). The item is closed to answers first, compare-
   * and-set: one that takes the recommendation is settled as expired with it (the runner then lands it); one that
   * pauses the workflow stays answerable, its expiry moved on (GATE_PAUSED_ANSWERABLE_MS), so a later answer lands and
   * a resume goes on. An answer that settled the item first wins: its outcome is returned, and the runner lands that.
   */
  async expire(effect: StartedEffect, take: boolean, now = Date.now()): Promise<{ outcome: EffectOutcome } | undefined> {
    const id = gateInputId(this.host.workflow.id, effect.key, effect.attempt);
    for (let attempt = 0; attempt < 3; attempt++) {
      const input = await this.inputs().get(id);
      if (input && input.state !== "pending") {
        await this.host.storage.delete(ROW + id);
        const system = (input.answer?.by as Responder | undefined)?.system;
        return system ? undefined : { outcome: { ok: true, value: gateValue(input) } };
      }
      if (!input) {
        // Never written (a crash before its write): nothing to close. A pausing gate's item is written now, answerable.
        if (take) await this.host.storage.delete(ROW + id);
        else if (await this.host.storage.get<Open>(ROW + id)) await this.open(id, effect, gateDetail(effect.args as Record<string, unknown>), now + GATE_PAUSED_ANSWERABLE_MS);
        return undefined;
      }
      if (take) {
        const done = await this.inputs().settle(id, expiryAnswer({ ...input, detail: { ...input.detail, applyRecommendationOnExpiry: true } }, now), "expired");
        if (done) { await this.host.storage.delete(ROW + id); return undefined; }
      } else {
        // The version stays: what a person saw is still the question they answer.
        const moved = await this.host.db().query("update agent_inputs set expires_at = $2, updated_at = now() where id = $1 and state = 'pending' returning id", [id, now + GATE_PAUSED_ANSWERABLE_MS]);
        if (moved.rows.length) return undefined;
      }
      // An answer settled it in between: read it again.
    }
    throw new Error(`Gate ${effect.key}:${effect.attempt} kept changing while it expired`);
  }
}

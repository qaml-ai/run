import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { errorText } from "../protocol.ts";
import { outputInput } from "../tool-policy.ts";
import { type ClientEvent, type RequestRecord } from "../../shared/client-protocol.ts";
import { HttpError } from "../http.ts";
import { type Db } from "../db.ts";
import { underClaim } from "../ownership.ts";
import { type McpResult } from "../mcp-results.ts";
import { jsonResult, type ToolCall } from "../tool-servers.ts";
import { safeError } from "../metrics.ts";
import type { Mount } from "../volumes.ts";
import { definitionId, MULTI_AGENT_LIMITS, PARENT_KEYS, roleAndTask, SUBAGENT_PROMPT, type AgentTarget, type DelegateFiles, type DelegateSettings } from "../multi-agent.ts";
import * as events from "./events.ts";
import * as spend from "./spend.ts";
import { type Child, type Session, type ClientSessionOptions, runningRun } from "./state.ts";

export type DelegationContext = {
  options: ClientSessionOptions;
  db: Db;
  sessions: Map<string, Session>;
  spendContext: spend.SpendContext;
  agentId(tenant: string, key: string): string;
  awaitRequest(agent: string, tenant: string, requestId: string, waitMs: number, signal?: AbortSignal): Promise<RequestRecord | undefined>;
  submit(agent: string, tenant: string, body: { id: string; method: string; params: Record<string, unknown> }): Promise<RequestRecord>;
  publish(session: Session, data: ClientEvent): void;
  spent(session: Session, cost: number): void;
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** How long a stop waits for the delegate children it aborted to end (`stopDelegates`) before it answers without them. */
const STOP_CHILDREN_MS = 10_000;

/** What each definition target is for, as its definition describes it, for the tools' descriptions. */
export async function targetDescriptions(ctx: DelegationContext, tenant: string, targets: AgentTarget[]) {
  const found = new Map<string, string>();
  await Promise.all(targets.filter(target => target.definition !== undefined && !target.description).map(async target => {
    const id = definitionId(tenant, target.definition!);
    const description = await ctx.options.definitionFor?.(tenant, id).then(definition => definition.description, () => undefined);
    if (description) found.set(id, description);
  }));
  return (target: AgentTarget) => target.definition !== undefined ? found.get(definitionId(tenant, target.definition)) : undefined;
}

/**
 * A delegate call: a child agent on the task, and its answer. The child is a real agent, made from a definition target or
 * with the model's instructions (a named target is an existing agent, with its own history), keyed by this call, and its
 * prompt's request id is the call's too: made again (a turn resumed on another node), the call finds the same child and run
 * and collects its answer, never running it twice. Its row in `agent_children` (kind 'delegate'), written before its
 * prompt is sent, lets the parent's abort, stop and delete reach it from any node, and lands its ending once
 * (`landDelegate`). Children count against the tenant's busy agents, spend and run rate as any agent does; the parent's
 * spend limits bound theirs and are charged with what they spent; a chain is at most `maxDepth` deep, and at most
 * `maxParallel` of a run's calls are in flight at once (the rest wait).
 */
export async function delegate(ctx: DelegationContext, session: Session, settings: DelegateSettings, call: ToolCall): Promise<McpResult> {
  const { header } = session;
  const tenant = header.tenant;
  const run = runningRun(session);
  const { createAgent, submit } = ctx.options;
  if (!createAgent || !submit) throw new Error("Delegation is not enabled on this runtime");
  if (!run || !call.toolCallId || call.innerCallId || !call.idempotencyKey) throw new Error("delegate is called directly, not from js_exec");
  const toolCallId = call.toolCallId;
  const { target, task, output } = childTarget(settings, call.args, "delegate to");
  const { depth, maxDepth, chain } = childPlace(ctx, session, run, settings, "Delegation");
  await delegationSlot(session, settings.maxParallel ?? MULTI_AGENT_LIMITS.maxParallel, call.signal);
  let untap: (() => void) | undefined;
  let child: Child | undefined;
  let held: number | undefined;
  try {
    const key = `delegate-${call.idempotencyKey}`;
    const requestId = `delegate_${call.idempotencyKey}`;
    const made = target?.agent === undefined;
    let agent = made ? ctx.agentId(tenant, key) : await agentByKey(ctx, tenant, target!.agent!);
    if (!agent) throw new Error(`The agent ${target!.name} does not exist`);
    if (chain.includes(agent)) throw new Error(`${target!.name} is already working on this task's chain: delegating to it would wait on itself`);
    // The child's row first, kept when the call is made again: an abort that reads the rows after this finds the child.
    const now = Date.now();
    await underClaim(ctx.db, session.claim, sql => sql.query(`insert into agent_children (id, tenant, parent, child, request_id, name, depth, root, parent_run, tool_call_id, kind, made, checked_at, created_at, updated_at)
      values ($1, $2, $3, $4, $1, $5, $6, $7, $8, $9, 'delegate', $10, $11, $11, $11) on conflict do nothing`, [requestId, tenant, header.id, agent, target?.name ?? "subagent", depth, chain[0], run.id, toolCallId, made, now]));
    // An abort that read the rows before this one was written: the call stops here, before the child has a prompt.
    call.signal.throwIfAborted();
    if (session.aborted?.has(run.id)) throw new Error("The run was aborted");
    // Made again (a resumed turn): the same child and request, with the answer it has or will have.
    let record = await requestOf(ctx, agent, tenant, requestId, 0, call.signal).catch(error => { if ((error as HttpError).status === 404) return undefined; throw error; });
    if (!record && made) agent = await makeChild(ctx, session, run, settings, target, key, toolCallId, depth);
    child = { agent, requestId, made };
    (session.children ??= new Map()).set(toolCallId, child);
    const at = { toolCallId, agentId: agent, requestId };
    const end = (status: string, error?: string) => ctx.publish(session, { type: "event", requestId: run.id, event: { type: "subagent_end", ...at, status, ...(error ? { error } : {}) } });
    ctx.publish(session, { type: "event", requestId: run.id, event: { type: "subagent_start", ...at, name: target?.name ?? "subagent", depth } });
    // Listening before the child's run is sent, so its first events are relayed too.
    untap = relay(ctx, session, run.id, at);
    if (!record) {
      try {
        const budget = await spend.holdBudget(ctx.spendContext, session, run.id);
        held = budget;
        if (budget !== undefined && budget <= 0) throw new Error("This run has no budget left for a sub-agent: its spend limit is reached");
        call.signal.throwIfAborted();
        record = await submit(agent, tenant, { id: requestId, method: "prompt", params: childPrompt(ctx, session, run, call, { agent, requestId, depth, maxDepth, chain, task, output, budget }) });
      } catch (error) {
        // Refused (the tenant's busy agents, its spend, the child's own limits): the call fails with why, and the row is done.
        child.done = true;
        end("failed", errorText(error));
        if ((error as HttpError).code !== "IDEMPOTENCY_CONFLICT") await landDelegate(ctx, requestId, "failed", "call").catch(() => {});
        throw error;
      }
    }
    const finished = record.state === "completed" ? record : await childOutcome(ctx, agent, tenant, requestId, call.signal).catch(async error => {
      // The parent's run stopped waiting (aborted, or its node stopping): its stream says the child is no longer followed,
      // and its row is left open for the stop (`stopDelegates`), the run's next owner or a sweep. Else the child is gone.
      if (call.signal.aborted) end("failed", "The parent's run stopped waiting for it");
      else await landDelegate(ctx, requestId, "failed", "call").catch(() => {});
      throw error;
    });
    child.done = true;
    // What the child spent counts against this agent's spend limit and this run's, once: not when the parent's stop took
    // its ending first (`stopDelegates`). A call made again on a new node charges again, as the first node's count was lost with it.
    const landed = await landDelegate(ctx, requestId, finished.status ?? "failed", "call").catch(() => ({ won: true, by: "call" }));
    if (landed.won || landed.by === "call") chargeDelegate(ctx, session, run.id, finished);
    const result = (finished.outcome?.result ?? {}) as { reply?: string; output?: unknown };
    const status = finished.status ?? "failed";
    end(status, finished.error);
    const value = {
      agentId: agent, requestId, status, ...(result.reply ? { text: result.reply } : {}), ...(result.output !== undefined ? { output: result.output } : {}),
      ...(finished.error ? { error: finished.error } : {}), ...(finished.stopped ? { stopped: finished.stopped } : {}),
    };
    return { ...jsonResult(value), ...(status === "completed" ? {} : { isError: true }) };
  } finally {
    untap?.();
    // What the child spent is in `childSpend` by now: its hold goes.
    if (held !== undefined) spend.releaseBudget(session, run.id, held);
    releaseDelegation(session);
  }
}

/**
 * Land a delegate child's ending on its row, once: by the call that took its answer ('call'), or the parent's stop that
 * waited for it ('stop'). Returns whether this landed it, and who did.
 */
async function landDelegate(ctx: DelegationContext, id: string, status: string, by: "call" | "stop"): Promise<{ won: boolean; by?: string }> {
  const now = Date.now();
  const { rows } = await ctx.db.query(`update agent_children set ended_at = coalesce(ended_at, $2), status = coalesce(status, $3), state = 'notified', landed_at = $2, landed_by = $4, updated_at = $2
    where id = $1 and landed_at is null returning id`, [id, now, status, by]);
  if (rows.length) return { won: true, by };
  return { won: false, by: (await ctx.db.query("select landed_by from agent_children where id = $1", [id])).rows[0]?.landed_by ?? undefined };
}

/** What a delegate child's run spent (its own, its children's and its images), as its outcome says. */
export function delegateCost(record: Pick<RequestRecord, "outcome">) {
  const usage = (record.outcome?.result as { usage?: { costUsd?: number; subagentCostUsd?: number; imageCostUsd?: number } | null } | undefined)?.usage;
  return (usage?.costUsd ?? 0) + (usage?.subagentCostUsd ?? 0) + (usage?.imageCostUsd ?? 0);
}

/** Charge what a delegate child spent to this agent's spend limit, and to run `runId` (its usage and limit) while the run is here. */
function chargeDelegate(ctx: DelegationContext, session: Session, runId: string, record: Pick<RequestRecord, "outcome">) {
  const cost = delegateCost(record);
  if (!(cost > 0)) return;
  ctx.spent(session, cost);
  if (session.running.has(runId)) (session.childSpend ??= new Map()).set(runId, (session.childSpend.get(runId) ?? 0) + cost);
}

/** What a delegate or spawn_agent call asks for: an allowlisted agent by name, or (when allowed) the model's instructions, and the task. */
export function childTarget(settings: DelegateSettings, args: Record<string, unknown>, verb: string) {
  const { agent: name, instructions, task, output: schema } = args as { agent?: string; instructions?: string; task?: unknown; output?: unknown };
  const target = name === undefined ? undefined : settings.agents?.find(entry => entry.name === name);
  if (name !== undefined && !target) throw new Error(`There is no agent ${name} to ${verb}`);
  if (instructions !== undefined && !settings.instructions) throw new Error(`Name an agent to ${verb}: instructions of your own are not allowed here`);
  if ((target === undefined) === (instructions === undefined)) throw new Error(settings.instructions && settings.agents?.length ? `Name an agent to ${verb} (agent), or give instructions of your own (instructions): one of them, not both` : settings.instructions ? "Give instructions too: who the sub-agent is and how it should work, besides its task" : `Name an agent to ${verb} (agent)`);
  if (typeof task !== "string" || !task.trim()) throw new Error("Give the sub-agent its task");
  // The model's own instructions go to the sub-agent with its task, as its first message (SUBAGENT_PROMPT).
  return { target, task: instructions === undefined ? task : roleAndTask(instructions, task), output: schema === undefined ? undefined : outputInput({ schema }) };
}

/** Where a child of this run goes in its chain: one deeper, within the chain's limit and the settings' (`what` names the refusal). */
export function childPlace(ctx: DelegationContext, session: Session, run: RequestRecord, settings: DelegateSettings, what: string) {
  // Where this run is in its chain: the prompt that started it says so, if a delegate or spawn_agent call sent it (signed by the runtime).
  const place = delegation(ctx, session.header.id, run.id, run.metadata);
  const depth = place.depth + 1;
  const maxDepth = Math.min(place.maxDepth, settings.maxDepth ?? MULTI_AGENT_LIMITS.maxDepth);
  if (depth > maxDepth) throw new Error(`${what} has reached its depth limit of ${maxDepth}: do this task yourself`);
  return { depth, maxDepth, chain: [...place.chain, session.header.id] };
}

/**
 * Make the child agent a call starts, keyed by `key` (made again, the same agent): from its definition target, or with
 * SUBAGENT_PROMPT on the parent's model (the model's instructions come with its task). It acts for whom its parent acts, with the same keys.
 */
export async function makeChild(ctx: DelegationContext, session: Session, run: RequestRecord, settings: DelegateSettings, target: AgentTarget | undefined, key: string, toolCallId: string, depth: number) {
  const { header } = session, tenant = header.tenant;
  const web = (header.sources?.builtins ?? []).filter(builtin => builtin === "web_search" || builtin === "web_fetch");
  // An inline child has its parent's model: as it is (its endpoint too), or by name on the tenant's own providers, which take only names.
  const { provider, id: modelId } = header.config.model;
  const named = Object.hasOwn(ctx.options.modelEndpoints?.(tenant) ?? {}, provider) || Object.hasOwn(await ctx.options.customProviders?.(tenant, header.keyScope) ?? {}, provider);
  return (await ctx.options.createAgent!(tenant, {
    ...target?.definition !== undefined ? { definition: definitionId(tenant, target.definition) } : {
      model: named ? `${provider}/${modelId}` : header.config.model, systemPrompt: SUBAGENT_PROMPT, ...web.length ? { builtins: web } : {},
      ...childMounts(header.mounts, settings.files),
    },
    name: target?.name ?? "subagent", type: "subagent", ttlSeconds: MULTI_AGENT_LIMITS.childTtlSeconds,
    ...header.identity?.subject !== undefined ? { subject: header.identity.subject } : {}, ...header.identity?.context ? { context: header.identity.context } : {},
    ...header.keyScope ? { keyScope: header.keyScope } : {},
    // Its parent's end user pays for it, from the bucket the parent's run spends.
    bucket: spend.bucketOf(ctx.spendContext, session, run),
  }, key, { agentId: header.id, runId: run.id, toolCallId, depth })).id;
}

/**
 * What a child of the model's own design mounts of its parent's files (`delegate.files`), so a path its parent names
 * works there as is: "write" (default), the parent's mounts as they are, shared, and no workspace of its own; "read",
 * the parent's mounts at the same paths, read-only, and its own workspace at /scratch (or another free path) for what
 * it writes; "none", nothing of the parent's (its own /workspace). Nothing either way for a parent without
 * mounts. Watches (notify) stay the parent's.
 */
export function childMounts(mounts: Mount[] | undefined, files: DelegateFiles = "write") {
  if (files === "none" || !mounts?.length) return {};
  const shared = mounts.map(({ volumeId, path, mode, subpath }) => ({ volumeId, path, mode: files === "write" ? mode : "ro" as const, ...subpath ? { subpath } : {} }));
  if (files === "write") return { mounts: [...shared, { workspace: false }] };
  const free = (path: string) => !mounts.some(mount => mount.path === path || mount.path.startsWith(`${path}/`) || path.startsWith(`${mount.path}/`));
  const scratch = ["/scratch", "/sub-agent"].find(free);
  return { mounts: [...shared, scratch ? { workspace: true, path: scratch } : { workspace: false }] };
}

/** A child's prompt: its task, and its place in the chain, signed for its agent and request so only the runtime places a run in one. */
export function childPrompt(ctx: DelegationContext, session: Session, run: RequestRecord, call: ToolCall, child: { agent: string; requestId: string; depth: number; maxDepth: number; chain: string[]; task: string; output?: unknown; budget?: number }) {
  const { agent, requestId, depth, maxDepth, chain, task, output, budget } = child;
  return {
    text: task, ...output ? { output } : {}, ...budget !== undefined ? { spendLimit: { usd: budget } } : {}, ...run.actor ? { actor: run.actor } : {},
    metadata: { [PARENT_KEYS.agent]: session.header.id, [PARENT_KEYS.run]: run.id, [PARENT_KEYS.toolCall]: call.toolCallId!, [PARENT_KEYS.depth]: String(depth), [PARENT_KEYS.maxDepth]: String(maxDepth), [PARENT_KEYS.chain]: chain.join(","),
      [PARENT_KEYS.signature]: delegationSignature(ctx, agent, requestId, String(depth), String(maxDepth), chain.join(",")) },
  };
}

/** In a child's run (its chain signed by the runtime): its parent agent and its chain's first, for identity tokens. */
export function lineage(ctx: DelegationContext, session: Session, run: RequestRecord | undefined) {
  const chain = run ? delegation(ctx, session.header.id, run.id, run.metadata).chain : [];
  return chain.length ? { parent: chain.at(-1)!, root: chain[0] } : undefined;
}

/**
 * Abort a background child's running turn: one the runtime made at once; a named agent only while it runs this row's
 * request, never another's.
 */
export async function abortChild(ctx: DelegationContext, tenant: string, row: any, id = `abort-${randomUUID()}`) {
  const submit = ctx.options.submit ?? ((agent, tenant, request) => ctx.submit(agent, tenant, request));
  if (!row.made) {
    const record = await requestOf(ctx, row.child, tenant, row.request_id, 0).catch(() => undefined);
    if (record?.state !== "running" || !record.began) return;
  }
  await submit(row.child, tenant, { id, method: "abort", params: {} });
}

/**
 * Where run `runId` of agent `agentId` is in a delegation chain: as its prompt's metadata says when the runtime signed
 * it for that agent and run (a delegate call's child run), else at a chain's start. Metadata is the caller's to send,
 * so a caller that names the same keys cannot set its run's depth, raise its limit or hide the chain.
 */
export function delegation(ctx: DelegationContext, agentId: string, runId: string, metadata: Record<string, string> | undefined): { depth: number; maxDepth: number; chain: string[] } {
  const start = { depth: 0, maxDepth: MULTI_AGENT_LIMITS.depthCeiling, chain: [] };
  const depth = metadata?.[PARENT_KEYS.depth], maxDepth = metadata?.[PARENT_KEYS.maxDepth], chain = metadata?.[PARENT_KEYS.chain] ?? "", signature = metadata?.[PARENT_KEYS.signature];
  if (depth === undefined || maxDepth === undefined || typeof signature !== "string") return start;
  const expected = Buffer.from(delegationSignature(ctx, agentId, runId, depth, maxDepth, chain));
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), expected)) return start;
  return { depth: Number(depth), maxDepth: Number(maxDepth), chain: chain.split(",").filter(Boolean) };
}

export function delegationSignature(ctx: DelegationContext, agentId: string, runId: string, depth: string, maxDepth: string, chain: string) {
  return createHmac("sha256", ctx.options.secret).update(`delegation-v1:${agentId}:${runId}:${depth}:${maxDepth}:${chain}`).digest("hex");
}

/** Wait until one of the running run's delegate calls may go: at most `max` are in flight at once. */
async function delegationSlot(session: Session, max: number, signal: AbortSignal) {
  const slots = session.delegating ??= { active: 0, waiting: [] };
  while (slots.active >= max) {
    signal.throwIfAborted();
    await new Promise<void>(resolve => { slots.waiting.push(resolve); signal.addEventListener("abort", () => resolve(), { once: true }); });
  }
  signal.throwIfAborted();
  slots.active++;
}

function releaseDelegation(session: Session) {
  const slots = session.delegating;
  if (!slots) return;
  slots.active--;
  // Each waiter looks again: one takes the slot, the rest wait on.
  for (const wake of slots.waiting.splice(0)) wake();
}

/** The tenant's live agent made with `key`, if there is one. */
export async function agentByKey(ctx: DelegationContext, tenant: string, key: string): Promise<string | undefined> {
  const { rows } = await ctx.db.query("select id from agents where tenant = $1 and header->>'key' = $2 and not revoked and (expires_at is null or expires_at > $3) order by id limit 1", [tenant, key, Date.now()]);
  return rows[0]?.id;
}

/** An agent's request, here or on the node serving it (see `awaitRequest`). */
export function requestOf(ctx: DelegationContext, agent: string, tenant: string, requestId: string, waitMs: number, signal?: AbortSignal) {
  return ctx.options.requestAnywhere ? ctx.options.requestAnywhere(agent, tenant, requestId, waitMs, signal) : ctx.awaitRequest(agent, tenant, requestId, waitMs, signal);
}

/** Wait for a child's request to settle, wherever the child is served, riding out its moves between nodes. */
export async function childOutcome(ctx: DelegationContext, agent: string, tenant: string, requestId: string, signal: AbortSignal): Promise<RequestRecord> {
  for (let delay = 250; ;) {
    signal.throwIfAborted();
    let record: RequestRecord | undefined;
    try { record = await requestOf(ctx, agent, tenant, requestId, events.MAX_POLL_WAIT_MS, signal); }
    catch (error) {
      signal.throwIfAborted();
      const status = (error as HttpError).status;
      if (status === 404 || status === 410) throw new Error("The sub-agent was deleted before it answered");
      // The child is moving between nodes, or its node has no room yet: ask again shortly.
      await sleep(delay);
      delay = Math.min(delay * 2, 5_000);
      continue;
    }
    if (!record) throw new Error("The sub-agent no longer has this task's request");
    if (record.state === "completed") return record;
    delay = 250;
  }
}

/** Relay a child's events of its request to this agent's stream as `subagent_event`, while the child runs on this node. Returns the undo. */
function relay(ctx: DelegationContext, session: Session, runId: string, at: { toolCallId: string; agentId: string; requestId: string }) {
  const child = ctx.sessions.get(at.agentId);
  if (!child) return undefined;
  // Streamed text is left out: a child's progress is its finished messages, tool calls and its own children.
  const tap = (data: ClientEvent) => {
    if (data.type !== "event" || data.requestId !== at.requestId || data.event?.type === "message_update") return;
    ctx.publish(session, { type: "event", requestId: runId, event: { type: "subagent_event", agentId: at.agentId, toolCallId: at.toolCallId, event: data.event } });
  };
  (child.taps ??= new Set()).add(tap);
  return () => { child.taps?.delete(tap); };
}

/**
 * Abort the agent's delegate children that have not ended, found by their rows, so on any node (the one that made them
 * may be lost), and wait for them to end, at most STOP_CHILDREN_MS: an abort or a delete of this agent cascades to
 * them. Each ending lands on its row once (`landDelegate`), charged to this agent, and to its run while the run is
 * here, whose ending waits for this (`stoppingChildren`). Those still running then are logged, and left to the sweep
 * (`sweepDelegate`). Never rejects.
 */
export function stopDelegates(ctx: DelegationContext, session: Session, scope?: { run: string; toolCallId: string }): Promise<void> {
  const { id } = session.header;
  const deadline = Date.now() + STOP_CHILDREN_MS;
  const stopping = (async () => {
    // A scope stops one call's children (a workflow's, when its script ends); no scope stops every child the agent has.
    const { rows } = scope
      ? await ctx.db.query("select * from agent_children where parent = $1 and kind = 'delegate' and ended_at is null and parent_run = $2 and tool_call_id = $3", [id, scope.run, scope.toolCallId])
      : await ctx.db.query("select * from agent_children where parent = $1 and kind = 'delegate' and ended_at is null", [id]);
    if (!rows.length) return;
    const ended = new Set<string>();
    const stopped = Promise.all(rows.map(row => stopDelegate(ctx, session, row, deadline).then(running => { if (!running) ended.add(row.id); }, error => {
      console.error(JSON.stringify({ type: "subagent_abort_failed", agent: id, child: row.child, error: safeError(error) }));
    })));
    // Bounded even when asking after a child waits itself (its node has no room for it yet).
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([stopped, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now()) + 1_000); })]); }
    finally { clearTimeout(timer); }
    const left = rows.filter(row => !ended.has(row.id)).map(row => row.child as string);
    if (left.length) console.error(JSON.stringify({ type: "subagent_stop_timeout", agent: id, children: left, waitedMs: STOP_CHILDREN_MS }));
  })().catch(error => console.error(JSON.stringify({ type: "subagent_abort_failed", agent: id, error: safeError(error) })));
  const previous = session.stoppingChildren;
  const both = previous ? Promise.all([previous, stopping]).then(() => {}) : stopping;
  session.stoppingChildren = both;
  void both.then(() => { if (session.stoppingChildren === both) session.stoppingChildren = undefined; });
  return stopping;
}

/**
 * Abort one delegate child and wait for its run to end, until `deadline`: then land its ending. A named agent is aborted
 * only while it runs the call's request, never another's. Returns whether it is still running.
 */
async function stopDelegate(ctx: DelegationContext, session: Session, row: any, deadline: number) {
  const tenant = session.header.tenant;
  let aborted = false;
  for (let delay = 250; Date.now() < deadline;) {
    let record: RequestRecord | undefined;
    try { record = await requestOf(ctx, row.child, tenant, row.request_id, aborted ? Math.max(0, deadline - Date.now()) : 0); }
    catch (error) {
      if ([404, 410].includes((error as HttpError).status)) { await landDelegate(ctx, row.id, "failed", "stop"); return false; }
      // The child is moving between nodes: ask again shortly.
      await sleep(delay);
      delay = Math.min(delay * 2, 2_000);
      continue;
    }
    if (record?.state === "completed") {
      if ((await landDelegate(ctx, row.id, record.status ?? "failed", "stop")).won) chargeDelegate(ctx, session, row.parent_run, record);
      return false;
    }
    if (record && !aborted) {
      await abortChild(ctx, tenant, row);
      aborted = true;
      continue;
    }
    // Its prompt is not sent yet (or a named agent's request waits behind another): ask again shortly.
    await sleep(delay);
    delay = Math.min(delay * 2, 2_000);
  }
  return true;
}

import { errorText } from "../protocol.ts";
import { outputInput } from "../tool-policy.ts";
import { type ClientEvent, type Outcome, type RequestRecord } from "../../shared/client-protocol.ts";
import { HttpError } from "../http.ts";
import { transaction } from "../db.ts";
import { underClaim } from "../ownership.ts";
import { type Sources } from "../tool-sources.ts";
import { type McpResult } from "../mcp-results.ts";
import { jsonResult, type ToolCall, type ToolServer, type ToolSourceView } from "../tool-servers.ts";
import { safeError } from "../metrics.ts";
import { agentMessage, agentsTools, agentUpdates, childNotice, delegateTool, MULTI_AGENT_LIMITS, PARENT_KEYS, REPORT_PROGRESS, SEND_MESSAGE, startsChildren, type ChildNotice, type DelegateSettings } from "../multi-agent.ts";
import { reachable, sometimes } from "../assert.ts";

import * as spend from "./spend.ts";
import { type Session, validSessionId, runningRun } from "./state.ts";

import * as delegation from "./delegation.ts";
import { resumeId } from "./inputs.ts";

export type ChildrenContext = delegation.DelegationContext & {
  /** A sweep for undelivered children's endings is under way here (`sweepChildren`), and the hour whose old wake counts were last deleted. */
  state: { sweepingChildren: boolean; wakesSwept?: number };
  isClosed(): boolean;
  isDraining(): boolean;
  upsertRequest(session: Session, record: RequestRecord): void;
  commit(session: Session, durable: boolean): Promise<void>;
  startStep(session: Session, record: RequestRecord, work: () => Promise<boolean>): Promise<boolean>;
};

/** A child's notification as the runtime sends it (multi-agent.ts `childNotice`). */
export const validNotice = (value: any) => !!value && typeof value === "object" && value.source?.kind === "agent" && validSessionId(String(value.source.agentId)) && typeof value.source.name === "string"
  && typeof value.root === "string" && typeof value.costUsd === "number" && !!value.metadata && typeof value.metadata === "object";

/** How long a spawned child may go without its request (its agent being made, its prompt sent) before a sweep calls it never started. */
const CHILD_START_GRACE_MS = 120_000;

/** How often a sweep asks after a child's resume that is not sent yet: it waits on a person, maybe for days. */
const RESUME_CHECK_MS = 10 * 60_000;

/**
 * How long a node holds a child's row while it delivers the child's ending, before another may: two sweeps. A node lost
 * mid-delivery delays the notification by that much; one slower than it is joined by another node's delivery, which the
 * parent takes once all the same (its request id).
 */
const childClaimMs = (sweepMs: number | undefined) => Math.max(5_000, 2 * (sweepMs || MULTI_AGENT_LIMITS.sweepMs));

/**
 * The delegate and agents tools of an agent whose sources enable them (multi-agent.ts), answered here rather than by a
 * tool source: a child is an agent of its own. A child spawn_agent made has send_message, to message its parent, and
 * any child the runtime made (spawn_agent's or delegate's) has report_progress.
 */
export function multiAgentServer(ctx: ChildrenContext, session: Session, sources: Sources | undefined): ToolServer | undefined {
  const settings = startsChildren(sources?.builtins) ? sources!.delegate : undefined;
  const spawned = !!session.header.key?.startsWith("spawn-");
  const reporting = spawned || !!session.header.key?.startsWith("delegate-");
  if (!settings && !reporting) return undefined;
  const delegating = !!settings && sources!.builtins!.includes("delegate"), spawning = !!settings && sources!.builtins!.includes("agents");
  if (spawning) session.spawns = true;
  const tools = async () => {
    const describe = await delegation.targetDescriptions(ctx, session.header.tenant, settings?.agents ?? []);
    return [...delegating ? [delegateTool(settings!, describe)] : [], ...spawning ? agentsTools(settings!, describe) : spawned ? [SEND_MESSAGE] : [], ...reporting ? [REPORT_PROGRESS] : []];
  };
  return {
    tools,
    sources: async () => (await tools()).map((tool): ToolSourceView => ({ kind: "builtin", name: tool.name, status: "listed", tools: [tool] })),
    call: async call => {
      if (call.name === "delegate" && delegating) return delegation.delegate(ctx, session, settings!, call);
      if (call.name === "spawn_agent" && spawning) return starting(session, spawnAgent(ctx, session, settings!, call));
      // A response may start a sub-agent and, beside it, wait for or message it: those calls run once it has started.
      if (["wait_agent", "list_agents", "send_message", "interrupt_agent"].includes(call.name)) await Promise.allSettled([...session.spawnsStarting ?? []]);
      if (call.name === "wait_agent" && spawning) return waitAgents(ctx, session, call);
      if (call.name === "list_agents" && spawning) return jsonResult({ agents: shown(session, await childrenOf(ctx, session.header.id)) });
      if (call.name === "report_progress" && reporting) return reportProgress(ctx, session, call);
      if (call.name === "send_message" && (spawning || spawned)) return sendMessage(ctx, session, settings, call);
      if (call.name === "interrupt_agent" && spawning) return interruptAgent(ctx, session, call);
      throw new Error(`Unknown tool ${call.name}`);
    },
  };
}

/** A spawn_agent call in progress, which the agent's other agents tools wait for. */
function starting<T>(session: Session, work: Promise<T>): Promise<T> {
  const spawns = session.spawnsStarting ??= new Set();
  spawns.add(work);
  return work.finally(() => spawns.delete(work));
}

/**
 * A spawn_agent call: a child on the task in the background, answered at once with its id and name. Its row in
 * `agent_children`, keyed by this call, is written before its prompt is sent: made again (a turn resumed on another
 * node), the call finds the same row, child and request, and never starts it twice. When the child's run ends, its
 * ending reaches this agent as a notification (`deliverChild`). At most `maxParallel` of the agent's children run at once.
 */
async function spawnAgent(ctx: ChildrenContext, session: Session, settings: DelegateSettings, call: ToolCall): Promise<McpResult> {
  const { header } = session;
  const tenant = header.tenant;
  const run = runningRun(session);
  if (!ctx.options.createAgent || !ctx.options.submit) throw new Error("Sub-agents are not enabled on this runtime");
  if (!run || !call.toolCallId || call.innerCallId || !call.idempotencyKey) throw new Error("spawn_agent is called directly, not from js_exec");
  const { target, task, output } = delegation.childTarget(settings, call.args, "start");
  const asked = call.args.name;
  if (asked !== undefined && (typeof asked !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(asked))) throw new Error("A name is 1 to 64 letters, digits, _ and -");
  const key = `spawn-${call.idempotencyKey}`;
  const made = target?.agent === undefined;
  const agent = made ? ctx.agentId(tenant, key) : await delegation.agentByKey(ctx, tenant, target!.agent!);
  if (!agent) throw new Error(`The agent ${target!.name} does not exist`);
  return startChild(ctx, session, run, call, settings, {
    agent, made, ...(asked !== undefined ? { name: asked as string } : {}), base: target?.name ?? "subagent", task, ...(output ? { output } : {}),
    ...(made ? { make: (depth: number) => delegation.makeChild(ctx, session, run, target, key, call.toolCallId!, depth) } : {}),
  });
}

/**
 * Start a background child on a task, for a spawn_agent call or a trusted tool's spawn directive: its row in
 * `agent_children`, keyed by the call, is written before its prompt is sent, so made again (a turn resumed on another
 * node) the call finds the same row, child and request, and never starts it twice. When the child's run ends, its
 * ending reaches this agent as a notification (`deliverChild`). At most `maxParallel` of the agent's children run at
 * once, and an agent already in the chain is refused. A child already busy (a persistent worker) queues the task.
 */
async function startChild(ctx: ChildrenContext, session: Session, run: RequestRecord, call: ToolCall, settings: DelegateSettings | undefined,
  child: { agent: string; made: boolean; name?: string; preferred?: string; base: string; task: string; output?: unknown; make?: (depth: number) => Promise<string> }): Promise<McpResult> {
  const { header } = session;
  const tenant = header.tenant;
  const submit = ctx.options.submit!;
  // A stateless run ends with its turn: nothing would hear its children.
  if (header.run) throw new Error("A stateless run cannot start sub-agents in the background: use delegate");
  const toolCallId = call.toolCallId!;
  session.spawns = true;
  const { depth, maxDepth, chain } = delegation.childPlace(ctx, session, run, settings ?? {}, "Sub-agents have");
  const requestId = `spawn_${call.idempotencyKey}`;
  let { agent } = child;
  const { made, task, output } = child;
  if (chain.includes(agent)) throw new Error(`${child.base} is already working on this task's chain`);
  const row = await childRow(ctx, session, { id: requestId, child: agent, name: child.name, ...(child.preferred ? { preferred: child.preferred } : {}), base: child.base, depth, root: chain[0], run: run.id, toolCallId, made }, settings?.maxParallel ?? MULTI_AGENT_LIMITS.maxParallel);
  if (row.state !== "running" && row.status === "failed" && !row.ended_at) throw new Error("This sub-agent could not be started");
  (session.children ??= new Map()).set(toolCallId, { agent, requestId, made, done: true });
  const at = { toolCallId, agentId: agent, requestId };
  ctx.publish(session, { type: "event", requestId: run.id, event: { type: "subagent_start", ...at, name: row.name, depth, background: true } });
  let record = await delegation.requestOf(ctx, agent, tenant, requestId, 0, call.signal).catch(error => { if ((error as HttpError).status === 404) return undefined; throw error; });
  if (!record) {
    try {
      if (child.make) agent = await child.make(depth);
      const budget = await spend.childShare(ctx.spendContext, session, requestId, settings?.maxParallel ?? MULTI_AGENT_LIMITS.maxParallel);
      if (budget !== undefined && budget <= 0) throw new Error("This agent has no budget left for a sub-agent: its spend limit is reached");
      relayChild(ctx, session, run.id, at);
      record = await submit(agent, tenant, { id: requestId, method: "prompt", params: delegation.childPrompt(ctx, session, run, call, { agent, requestId, depth, maxDepth, chain, task, output, budget }) });
    } catch (error) {
      // Refused (the tenant's busy agents, its spend, the child's own limits): the call fails with why, and the row is done.
      await ctx.db.query("update agent_children set state = 'notified', status = 'failed', updated_at = $2 where id = $1 and ended_at is null", [requestId, Date.now()]);
      ctx.publish(session, { type: "event", requestId: run.id, event: { type: "subagent_end", ...at, status: "failed", error: errorText(error), background: true } });
      throw error;
    }
  }
  return jsonResult({ agentId: agent, name: row.name, ...record.began || record.state === "completed" ? {} : { queued: true } });
}

/**
 * A tool's spawn directive (`_meta["camelrun/spawn"]`: `{ agent, task, name?, output? }`): the tool, from a source the
 * tenant trusts (an MCP server with auth "runtime", whose identity tokens it verifies), prepared an agent of the tenant's
 * for this task, and the runtime starts it as a background child, as spawn_agent would. The model sees `{ agentId,
 * name }` as the call's result, so it never names an agent itself. Limits and the chain hold as for spawn_agent.
 */
export async function toolSpawn(ctx: ChildrenContext, session: Session, call: ToolCall, directive: unknown): Promise<McpResult> {
  const { header } = session;
  const run = runningRun(session);
  if (!ctx.options.submit) throw new Error("Sub-agents are not enabled on this runtime");
  if (session.toolSources?.get(call.name) !== "served") throw new Error(`${call.name} asked to start a sub-agent (camelrun/spawn), which only a tool server with auth "runtime" may`);
  if (!run || !call.toolCallId || call.innerCallId || !call.idempotencyKey) throw new Error(`${call.name} starts a sub-agent: call it directly, not from js_exec`);
  const { agent, task, name, output: schema, ...rest } = (directive ?? {}) as Record<string, unknown>;
  if (!directive || typeof directive !== "object" || Array.isArray(directive) || Object.keys(rest).length || typeof agent !== "string" || !validSessionId(agent) || typeof task !== "string" || !task.trim() || task.length > MULTI_AGENT_LIMITS.taskChars
    || (name !== undefined && (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name)))) {
    throw new Error(`${call.name} answered with an invalid camelrun/spawn: { agent: "<agent id>", task, name?, output? }`);
  }
  // The tenant's own agent, alive.
  const { rows } = await ctx.db.query("select name from agents where id = $1 and tenant = $2 and not revoked and (expires_at is null or expires_at > $3)", [agent, header.tenant, Date.now()]);
  if (!rows[0]) throw new Error(`${call.name} asked to start an agent this account does not have`);
  reachable("a tool's spawn directive started a background child");
  const output = schema === undefined ? undefined : outputInput({ schema });
  // A worker given task after task keeps one name while it runs one, and numbered ones beside it.
  const base = (name as string | undefined) ?? (String(rows[0].name ?? "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 56) || "worker");
  return startChild(ctx, session, run, call, header.sources?.delegate, { agent, made: false, preferred: base.slice(0, 64), base: base.slice(0, 56), task, ...(output ? { output } : {}) });
}

/**
 * The row of a spawn_agent call's child, written first: the existing one when the call is made again. One call at a
 * time per parent (only its owner runs its turns), so `max` running children holds. A name is unique among the running
 * ones: the default is the target's name and the next number.
 */
async function childRow(ctx: ChildrenContext, session: Session, child: { id: string; child: string; name?: string; base: string; depth: number; root: string; run: string; toolCallId: string; made: boolean; preferred?: string }, max: number) {
  const previous = session.spawning ?? Promise.resolve();
  let release!: () => void;
  session.spawning = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const parent = session.header.id;
    const found = async () => (await ctx.db.query("select * from agent_children where id = $1", [child.id])).rows[0];
    const existing = await found();
    if (existing) return existing;
    // Children running: one waiting on a person (a resume row) is not.
    const running = Number((await ctx.db.query("select count(distinct child) as n from agent_children where parent = $1 and state = 'running' and ended_at is null and kind in ('spawn', 'message')", [parent])).rows[0].n);
    if (running >= max) throw new Error(`${running} sub-agents are running, this agent's most at once: wait for one to finish (wait_agent) before starting another`);
    let next = Number((await ctx.db.query("select count(*) as n from agent_children where parent = $1 and kind = 'spawn' and name like $2", [parent, `${child.base}-%`])).rows[0].n) + 1;
    // A tool's directive prefers its name, and takes the next numbered one when a running sibling has it.
    for (let attempt = 0; attempt < 10; attempt++) {
      const name = child.name ?? (attempt === 0 && child.preferred ? child.preferred : `${child.base}-${next++}`);
      const now = Date.now();
      const { rows } = await underClaim(ctx.db, session.claim, sql => sql.query(`insert into agent_children (id, tenant, parent, child, request_id, name, depth, root, parent_run, tool_call_id, made, checked_at, created_at, updated_at)
        values ($1, $2, $3, $4, $1, $5, $6, $7, $8, $9, $10, $11, $11, $11) on conflict do nothing returning *`, [child.id, session.header.tenant, parent, child.child, name, child.depth, child.root, child.run, child.toolCallId, child.made, now]));
      if (rows[0]) return rows[0];
      if (child.name) throw new Error(`A sub-agent named ${child.name} is running: pick another name`);
    }
    throw new Error("Could not name the sub-agent: give it a name");
  } finally { release(); }
}

/** Relay a background child's events of its request to this agent's stream, while it runs on this node, until its run ends. */
function relayChild(ctx: ChildrenContext, session: Session, runId: string, at: { toolCallId: string; agentId: string; requestId: string }) {
  const child = ctx.sessions.get(at.agentId);
  if (!child) return;
  const tap = (data: ClientEvent) => {
    if (data.type === "response" && data.id === at.requestId) { child.taps?.delete(tap); return; }
    if (data.type !== "event" || data.requestId !== at.requestId || data.event?.type === "message_update") return;
    ctx.publish(session, { type: "event", requestId: runId, event: { type: "subagent_event", agentId: at.agentId, toolCallId: at.toolCallId, event: data.event } });
  };
  (child.taps ??= new Set()).add(tap);
}

/**
 * An agent's background children, by when each started: what list_agents answers. Each as its latest run says (a
 * message or a resume starts it again); one whose resume waits on a person is input_required.
 */
async function childrenOf(ctx: ChildrenContext, parent: string) {
  const { rows } = await ctx.db.query(`select * from (select distinct on (child) child, name, status, kind, ended_at, landed_by, created_at,
    min(created_at) over (partition by child) as started from agent_children where parent = $1 and kind <> 'delegate' and landed_by is distinct from 'steer' and landed_by is distinct from 'superseded'
    order by child, created_at desc, id desc) latest order by started, child limit 200`, [parent]);
  const progress = await progressOf(ctx, parent);
  return rows.map(row => {
    const report = row.ended_at === null ? progress.get(row.child) : undefined;
    return {
      agentId: row.child as string, name: row.name as string,
      status: row.ended_at === null ? row.kind === "resume" ? "input_required" : "running" : row.status as string,
      startedAt: Number(row.started), ...row.ended_at !== null ? { endedAt: Number(row.ended_at) } : {},
      ...report ? { progress: report.progress as string, progressAt: Number(report.progress_at) } : {},
      // Not answered: what the model is shown is marked seen (`shown`), so its next tool result does not repeat it.
      ...report ? { report } : {},
    };
  });
}

/**
 * The latest progress report of each of the agent's running background children, by child: of the row whose run it is
 * working on (its spawn's, or a message's that started a turn; a message its running turn took has no run of its own).
 */
async function progressOf(ctx: ChildrenContext, parent: string): Promise<Map<string, any>> {
  const { rows } = await ctx.db.query(`select distinct on (child) id, child, name, progress, progress_seq, progress_at from agent_children
    where parent = $1 and kind in ('spawn', 'message') and ended_at is null and progress_seq > 0 order by child, progress_at desc limit 50`, [parent]);
  return new Map(rows.map(row => [row.child as string, row]));
}

/** Mark a child's report as shown to the model, so its next tool result's <agent_updates> does not repeat it. */
const markShown = (session: Session, report: { id: string; progress_seq: unknown }) =>
  (session.progressShown ??= new Map()).set(report.id, Math.max(Number(report.progress_seq), session.progressShown.get(report.id) ?? 0));

/** Children listed for the model: their progress marked shown, the bookkeeping left out. */
function shown<T extends { report?: { id: string; progress_seq: unknown } }>(session: Session, children: T[]) {
  for (const child of children) if (child.report) markShown(session, child.report);
  return children.map(({ report: _report, ...child }) => child);
}

/**
 * The <agent_updates> part for a tool result of this agent's: its running background children's latest progress
 * reports it was not shown yet, or undefined. A child that ended is left out: its notification supersedes its reports.
 * Asked only of an agent that may have children (`spawns`), once per direct tool call.
 */
export async function pendingUpdates(ctx: ChildrenContext, session: Session) {
  if (!session.spawns) return undefined;
  const seen = session.progressShown ??= new Map();
  const fresh = [...(await progressOf(ctx, session.header.id)).values()].filter(row => Number(row.progress_seq) > (seen.get(row.id) ?? 0));
  if (!fresh.length) return undefined;
  for (const row of fresh) seen.set(row.id, Number(row.progress_seq));
  return agentUpdates(fresh.map(row => ({ name: row.name as string, text: row.progress as string, at: Number(row.progress_at) })));
}

/**
 * A report_progress call of a child the runtime made: its latest status on its run's row in `agent_children` (its
 * parent's spawn or delegate row, or a message's), latest wins. It never starts a turn: a background child's parent is
 * shown it with its next tool result (`pendingUpdates`) and in list_agents; watchers of the parent's stream get
 * `subagent_progress` at once, and a delegate call's progress (`tool_execution_update`), while the parent runs on this
 * node. A row whose child ended takes nothing: its ending supersedes it.
 */
async function reportProgress(ctx: ChildrenContext, session: Session, call: ToolCall): Promise<McpResult> {
  const run = runningRun(session);
  if (!run || !call.toolCallId || call.innerCallId) throw new Error("report_progress is called directly, not from js_exec");
  const { text } = call.args as { text?: unknown };
  if (typeof text !== "string" || !text.trim() || text.length > MULTI_AGENT_LIMITS.progressChars) throw new Error(`A progress report is 1 to ${MULTI_AGENT_LIMITS.progressChars} characters`);
  const sent = session.progressSent ??= new Map();
  const count = sent.get(run.id) ?? 0;
  if (count >= MULTI_AGENT_LIMITS.progressPerRun) throw new Error(`This turn has reported progress ${count} times, the most one turn may: report less often`);
  sent.set(run.id, count + 1);
  const lineage = delegation.lineage(ctx, session, run);
  if (!lineage) throw new Error("You have no parent agent to report to: only a sub-agent has one");
  const now = Date.now();
  const { rows } = await ctx.db.query(`update agent_children set progress = $4, progress_seq = progress_seq + 1, progress_at = $5, updated_at = $5
    where child = $1 and request_id = $2 and parent = $3 and ended_at is null returning name, kind, tool_call_id, parent_run`, [session.header.id, run.id, lineage.parent, text.trim(), now]);
  const row = rows[0];
  if (!row) throw new Error("Your parent is no longer waiting on this task: there is no one to report to");
  const parent = ctx.sessions.get(lineage.parent);
  if (parent) {
    const requestId = runningRun(parent)?.id ?? row.parent_run;
    const at = { agentId: session.header.id, name: row.name as string, toolCallId: row.tool_call_id as string };
    ctx.publish(parent, { type: "event", requestId, event: { type: "subagent_progress", ...at, text: text.trim(), ...row.kind === "delegate" ? {} : { background: true } } });
    // A delegate call waits on this child: its progress is the call's, as a tool server's would be.
    if (row.kind === "delegate") ctx.publish(parent, { type: "event", requestId, event: {
      type: "tool_execution_update", toolCallId: at.toolCallId, toolName: "delegate",
      partialResult: { content: [{ type: "text", text: text.trim() }], details: { type: "progress", tool: "delegate", message: text.trim() } },
    } });
  }
  return jsonResult({ reported: true });
}

/**
 * A wait_agent call: wait until one of the agent's running children (or those named) ends, or the timeout passes,
 * and answer each one's status. An ending the wait answers is taken here (`takeEnding`): it is charged to this run,
 * and its notification is never sent.
 */
async function waitAgents(ctx: ChildrenContext, session: Session, call: ToolCall): Promise<McpResult> {
  const run = runningRun(session);
  if (!run || call.innerCallId) throw new Error("wait_agent is called directly, not from js_exec");
  const { agents: names, timeoutMs, untilProgress } = call.args as { agents?: unknown; timeoutMs?: unknown; untilProgress?: unknown };
  if (untilProgress !== undefined && typeof untilProgress !== "boolean") throw new Error("untilProgress is true or false");
  if (names !== undefined && (!Array.isArray(names) || names.some(name => typeof name !== "string"))) throw new Error("agents is a list of names or agentIds");
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1_000 || (timeoutMs as number) > MULTI_AGENT_LIMITS.maxWaitMs)) throw new Error(`timeoutMs is an integer from 1000 to ${MULTI_AGENT_LIMITS.maxWaitMs}`);
  const parent = session.header.id, tenant = session.header.tenant;
  const rows = async () => (await ctx.db.query("select * from agent_children where parent = $1 and kind <> 'delegate' order by created_at, id", [parent])).rows;
  // Rows of runs folded into another (a message a running turn took) are no one's to wait for; a resume waits on a person, and only when named.
  const open = (row: any) => row.landed_at === null;
  // Each sub-agent's latest turn: a message the parent sent after an answer starts a turn whose answer is the one it waits
  // for (the earlier answer still comes as its notification).
  const latest = (rows: any[]) => [...new Map(rows.map(row => [row.child, row])).values()];
  const pick = (all: any[]) => {
    if (names === undefined) return latest(all.filter(row => open(row) && row.kind !== "resume"));
    return (names as string[]).map(name => {
      const named = all.filter(row => (row.name === name || row.child === name) && !["steer", "superseded"].includes(row.landed_by));
      if (!named.length) throw new Error(`You have no sub-agent ${name}`);
      return named.filter(open).at(-1) ?? named.at(-1);
    });
  };
  let chosen = pick(await rows());
  if (!chosen.length) return jsonResult({ agents: [], message: "No sub-agents are running" });
  // A sub-agent's message cuts the wait short, as does one already on its way to the model: it reads it next.
  const messaged = new Set(session.agentMessages?.values() ?? []);
  // With untilProgress, a report it has not seen ends the wait too, once it has waited progressWaitMs: reports coalesce.
  const updated = new Set<string>();
  const earliest = Date.now() + (ctx.options.progressWaitMs ?? MULTI_AGENT_LIMITS.progressWaitMs);
  const reported = async (signal: AbortSignal) => {
    if (!untilProgress) return new Promise<never>(() => {});
    const pause = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
    await pause(earliest - Date.now());
    while (!signal.aborted) {
      const watched = new Set(chosen.filter(row => row.ended_at === null).map(row => row.child as string));
      for (const report of (await progressOf(ctx, parent)).values()) {
        if (watched.has(report.child) && Number(report.progress_seq) > (session.progressShown?.get(report.id) ?? 0)) updated.add(report.name);
      }
      if (updated.size) return;
      await pause(1_000);
    }
    return new Promise<never>(() => {});
  };
  let wake: (() => void) | undefined;
  const waiter = (name: string) => { messaged.add(name); wake?.(); };
  (session.messageWaiters ??= new Set()).add(waiter);
  try {
    // A resume not yet sent (its person has not answered) is answered as waiting on them, not waited for.
    const waitable = (row: any) => row.ended_at === null && row.kind !== "resume";
    const ready = () => chosen.some(row => open(row) && row.ended_at !== null) || !chosen.some(waitable);
    const deadline = Date.now() + ((timeoutMs as number | undefined) ?? MULTI_AGENT_LIMITS.waitMs);
    // Until one of them ends, or the timeout: a run folded into another (a steered message) ends without being an answer.
    while (!ready() && !messaged.size && !updated.size && Date.now() < deadline) {
      const stop = new AbortController();
      const abort = () => stop.abort();
      wake = abort;
      call.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, deadline - Date.now());
      const timedOut = new Promise<void>(resolve => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
      try {
        await Promise.race([timedOut, reported(stop.signal), ...chosen.filter(waitable).map(async row => {
          let record: RequestRecord | undefined;
          try { record = await delegation.childOutcome(ctx, row.child, tenant, row.request_id, stop.signal); }
          catch (error) {
            if (stop.signal.aborted) return new Promise<never>(() => {});
            record = { status: "failed", error: errorText(error) } as RequestRecord;
          }
          await recordEnding(ctx, row, record);
        })]);
      } catch (error) { if (!stop.signal.aborted) throw error; }
      finally { clearTimeout(timer); call.signal.removeEventListener("abort", abort); stop.abort(); }
      call.signal.throwIfAborted();
      chosen = pick(await rows());
      if (!chosen.length) return jsonResult({ agents: [], message: "No sub-agents are running" });
    }
  } finally { session.messageWaiters.delete(waiter); }
  const answers = [];
  const progress = await progressOf(ctx, parent);
  for (const row of chosen) {
    const taken = row.landed_at === null && row.ended_at !== null ? await takeEnding(ctx, session, run, row) : undefined;
    const notice = (taken ?? row).notice as ChildNotice | null;
    answers.push({
      agentId: row.child, name: row.name, status: row.ended_at === null && !taken ? row.kind === "resume" ? "input_required" : "running" : row.status ?? taken?.status,
      ...(taken ? { text: notice!.text, ...(notice!.notice.metadata.output !== undefined ? { output: notice!.notice.metadata.output } : {}), ...(notice!.notice.metadata.error ? { error: notice!.notice.metadata.error } : {}) }
        : row.ended_at !== null ? { note: "Its answer comes (or came) as a notification" } : progress.has(row.child) ? { progress: progress.get(row.child).progress, progressAt: Number(progress.get(row.child).progress_at) } : {}),
    });
    // Shown here, so its next tool result's <agent_updates> does not repeat it.
    if (!taken && row.ended_at === null && progress.has(row.child)) markShown(session, progress.get(row.child));
  }
  const senders = [...messaged];
  if (senders.length) return jsonResult({ agents: answers, messaged: senders, message: `${senders.join(", ")} sent you a message, which follows this result: read it, then wait again if you need to` });
  if (updated.size && answers.some(answer => answer.status === "running")) return jsonResult({ agents: answers, updated: [...updated] });
  return jsonResult({ agents: answers, ...(answers.every(answer => answer.status === "running") ? { timedOut: true } : {}) });
}

/**
 * Take an ended child's notice for a wait in run `run`, once: unless its notification landed first. It is charged to the
 * run as the notification's landing would be, and its row is notified: a notification already on its way to the parent
 * finds it taken as it lands, and ends without its message (`landNotice`).
 */
async function takeEnding(ctx: ChildrenContext, session: Session, run: RequestRecord, row: any) {
  const now = Date.now();
  const { rows } = await ctx.db.query(`update agent_children set state = 'notified', landed_at = $2, landed_by = 'wait', updated_at = $2
    where id = $1 and landed_at is null and ended_at is not null returning *`, [row.id, now]);
  const taken = rows[0];
  if (!taken) return undefined;
  const notice = taken.notice as ChildNotice;
  chargeNotice(ctx, session, run.id, notice.notice.costUsd);
  ctx.publish(session, { type: "event", requestId: run.id, event: { type: "subagent_end", toolCallId: taken.tool_call_id, agentId: taken.child, requestId: taken.request_id, status: taken.status, ...(notice.notice.metadata.error ? { error: notice.notice.metadata.error } : {}), background: true } });
  return taken;
}

/** What a background child spent, charged to its parent (its spend limit) and to the parent's run `runId` (its usage). */
function chargeNotice(ctx: ChildrenContext, session: Session, runId: string, usd: number) {
  if (!(usd > 0)) return;
  ctx.spent(session, usd);
  (session.childSpend ??= new Map()).set(runId, (session.childSpend.get(runId) ?? 0) + usd);
}

/**
 * Record a child's ending on its row once (the first recorded wins), as its notice; returns the row as it now is. A
 * message its running turn took (`steeredInto`) is folded into that turn, whose own row answers: it lands nothing. One
 * that waits on a person gets the row of the turn it resumes once they answer, which notifies again.
 */
async function recordEnding(ctx: ChildrenContext, row: { id: string; tenant?: string; parent?: string; child: string; name: string; root: string; request_id?: string }, record: Pick<RequestRecord, "status" | "error" | "outcome" | "steeredInto">) {
  const now = Date.now();
  if (record.steeredInto) {
    const { rows } = await ctx.db.query("update agent_children set ended_at = $2, state = 'notified', landed_at = $2, landed_by = 'steer', updated_at = $2 where id = $1 and ended_at is null returning *", [row.id, now]);
    return rows[0] ?? (await ctx.db.query("select * from agent_children where id = $1", [row.id])).rows[0];
  }
  const notice = childNotice({ agentId: row.child, name: row.name, root: row.root }, record);
  const status = notice.notice.metadata.status;
  const ended = await transaction(ctx.db, async sql => {
    const { rows } = await sql.query("update agent_children set ended_at = $2, status = $3, notice = $4, updated_at = $2 where id = $1 and ended_at is null returning *", [row.id, now, status, JSON.stringify(notice)]);
    const done = rows[0];
    // Its resume, once a person answers: a row of its own, written with this ending so no sweep can miss it.
    if (done && status === "input_required") {
      const resume = resumeId(done.request_id);
      await sql.query(`insert into agent_children (id, tenant, parent, child, request_id, name, depth, root, parent_run, tool_call_id, kind, made, checked_at, created_at, updated_at)
        values ($1, $2, $3, $4, $1, $5, $6, $7, $8, $9, 'resume', $10, $11, $11, $11) on conflict do nothing`, [resume, done.tenant, done.parent, done.child, done.name, done.depth, done.root, done.parent_run, done.tool_call_id, done.made, now]);
    }
    return done;
  });
  return ended ?? (await ctx.db.query("select * from agent_children where id = $1", [row.id])).rows[0];
}

/** A child's run ended on this node (the fast path): its ending is recorded and delivered to its parent now. */
export async function childEnded(ctx: ChildrenContext, child: string, record: RequestRecord) {
  const row = (await ctx.db.query("select * from agent_children where child = $1 and request_id = $2", [child, record.id])).rows[0];
  if (!row || row.state !== "running") return;
  const ended = await recordEnding(ctx, row, record);
  if (ended.landed_at !== null) return;
  const now = Date.now();
  const claimed = (await ctx.db.query("update agent_children set claimed_until = $2 where id = $1 and state = 'running' and ended_at is not null and (claimed_until is null or claimed_until < $3) returning *", [ended.id, now + childClaimMs(ctx.options.childSweepMs), now])).rows[0];
  if (claimed) await deliverChild(ctx, claimed);
}

/**
 * Deliver a claimed child's ending to its parent: a prompt with request id `child_<request>`, which the parent takes
 * once however often it is sent, built from the row's stored notice so every attempt sends the same request. Then the
 * row is notified. A parent waiting on a person is left be (a new message would supersede what it asked): the next
 * sweep tries again. One that is gone takes nothing.
 */
async function deliverChild(ctx: ChildrenContext, row: any) {
  const release = () => ctx.db.query("update agent_children set claimed_until = null where id = $1", [row.id]).catch(() => {});
  try {
    if ((await ctx.options.inputs?.pending(row.parent))?.length) return void await release();
    const submit = ctx.options.submit ?? ((agent, tenant, request) => ctx.submit(agent, tenant, request));
    await submit(row.parent, row.tenant, { id: `child_${row.request_id}`, method: "prompt", params: { ...row.notice, allowDisconnected: true } });
  } catch (error) {
    const status = (error as HttpError).status;
    if (status !== 404 && status !== 410 && (error as HttpError).code !== "IDEMPOTENCY_CONFLICT") {
      reachable("a child's notification failed to reach its parent and was left for a sweep");
      console.error(JSON.stringify({ type: "child_notice_failed", agent: row.parent, child: row.child, error: safeError(error) }));
      return void await release();
    }
  }
  await ctx.db.query("update agent_children set state = 'notified', claimed_until = null, updated_at = $2 where id = $1", [row.id, Date.now()]);
}

/**
 * Sweep for children whose ending was not delivered, on any node: rows whose ending is recorded, and running rows not
 * checked for a while, whose child's request is asked after (its node may have been lost as the run ended). Claimed a
 * batch at a time (`skip locked`), so nodes sweeping together share the work. A delegate child's row is its own case
 * (`sweepDelegate`): its answer goes to its call, never as a notification.
 */
export async function sweepChildren(ctx: ChildrenContext, now = Date.now()) {
  if (ctx.isClosed() || ctx.isDraining() || ctx.state.sweepingChildren) return;
  ctx.state.sweepingChildren = true;
  try {
    const every = ctx.options.childSweepMs ?? MULTI_AGENT_LIMITS.sweepMs;
    const hour = Math.floor(now / 3_600_000);
    if (ctx.state.wakesSwept !== hour) {
      ctx.state.wakesSwept = hour;
      await ctx.db.query("delete from agent_wakes where hour < $1", [hour - 1]);
    }
    const { rows } = await ctx.db.query(`update agent_children set claimed_until = $2
      where id in (select id from agent_children where state = 'running' and (claimed_until is null or claimed_until < $1) and (ended_at is not null or checked_at < $3)
        order by checked_at limit 50 for update skip locked)
      returning *`, [now, now + childClaimMs(every), now - every]);
    for (const claimed of rows) {
      let row = claimed;
      if (row.kind === "delegate") {
        await sweepDelegate(ctx, row, now).catch(async error => {
          console.error(JSON.stringify({ type: "child_sweep_failed", agent: row.parent, child: row.child, error: safeError(error) }));
          await ctx.db.query("update agent_children set claimed_until = null where id = $1", [row.id]);
        });
        continue;
      }
      if (row.ended_at === null) {
        let record: RequestRecord | undefined, gone = false;
        try { record = await delegation.requestOf(ctx, row.child, row.tenant, row.request_id, 0); }
        catch (error) {
          gone = [404, 410].includes((error as HttpError).status);
          if (!gone) { await ctx.db.query("update agent_children set claimed_until = null where id = $1", [row.id]); continue; }
        }
        // A child whose request is missing past the time its spawn takes was never started (its parent's turn was lost first).
        // A resume's is missing until a person answers, for as long as they take: it is asked after less often.
        const failure = gone ? "The sub-agent was deleted before it answered" : !record && row.kind !== "resume" && Number(row.created_at) < now - CHILD_START_GRACE_MS ? "The sub-agent was never started" : undefined;
        if (record?.state !== "completed" && !failure) {
          await ctx.db.query("update agent_children set claimed_until = null, checked_at = $2 where id = $1", [row.id, !record && row.kind === "resume" ? now + RESUME_CHECK_MS : now]);
          continue;
        }
        row = await recordEnding(ctx, row, failure ? { status: "failed", error: failure } : record!);
        if (row.landed_at !== null) continue;
        reachable("a sweep found a child's ended run that no one had recorded");
      }
      else reachable("a sweep delivered a child's ending recorded before");
      await deliverChild(ctx, row);
    }
  } catch (error) {
    console.error(JSON.stringify({ type: "child_sweep_failed", error: safeError(error) }));
  } finally { ctx.state.sweepingChildren = false; }
}

/**
 * A delegate child's open row, claimed by a sweep. While its parent's run goes on, the call (or the run's next owner,
 * making it again) takes the answer. Once that run has ended without it (its node lost, then the run aborted, or the
 * parent deleted), nothing will: a child still running is aborted, and its ending, once it comes, is charged here to its
 * parent's spend limit, in the transaction that lands it ('late'). That run's usage has been reported by then.
 */
async function sweepDelegate(ctx: ChildrenContext, row: any, now: number) {
  const checked = () => ctx.db.query("update agent_children set claimed_until = null, checked_at = $2 where id = $1", [row.id, now]);
  const ask = async (agent: string, request: string) => {
    try { return { record: await delegation.requestOf(ctx, agent, row.tenant, request, 0) }; }
    catch (error) {
      if ([404, 410].includes((error as HttpError).status)) return { gone: true };
      throw error;
    }
  };
  const parent = await ask(row.parent, row.parent_run);
  if (parent.record && parent.record.state !== "completed") return void await checked();
  const child = await ask(row.child, row.request_id);
  const record = child.record;
  const failure = child.gone ? "The sub-agent was deleted before it answered" : !record && Number(row.created_at) < now - CHILD_START_GRACE_MS ? "The sub-agent was never started" : undefined;
  if (record?.state !== "completed" && !failure) {
    // Nothing waits on it any more: it is stopped, and the next sweep lands its ending.
    if (record) await delegation.abortChild(ctx, row.tenant, row);
    return void await checked();
  }
  const cost = record?.state === "completed" ? delegation.delegateCost(record) : 0;
  const landed = await transaction(ctx.db, async sql => {
    const { rows } = await sql.query(`update agent_children set ended_at = $2, status = $3, state = 'notified', landed_at = $2, landed_by = 'late', claimed_until = null, updated_at = $2
      where id = $1 and landed_at is null returning id`, [row.id, now, failure ? "failed" : record!.status ?? "failed"]);
    // A spend limit set after the child started counts from zero, as the parent's own writes do (`spendWrite`).
    if (rows.length && cost > 0) await sql.query("update agent_spend_limits set spent = spent + $2 where agent = $1 and set_at <= $3", [row.parent, cost, Number(row.created_at)]);
    return rows.length > 0;
  });
  if (landed) console.log(JSON.stringify({ type: "subagent_late_ending", agent: row.parent, child: row.child, request: row.request_id, costUsd: cost }));
}

/** Whether `child` is one of `parent`'s background sub-agents (a browser token's `children` scope). */
export async function isChildOf(ctx: ChildrenContext, child: string, parent: string) {
  return (await ctx.db.query("select 1 from agent_children where parent = $1 and child = $2 and kind <> 'delegate' limit 1", [parent, child])).rows.length > 0;
}

/** The latest row of one of the agent's children, by its name or id; undefined when it has none by that name. */
async function childNamed(ctx: ChildrenContext, parent: string, name: string) {
  const { rows } = await ctx.db.query(`select * from agent_children where parent = $1 and (name = $2 or child = $2) and kind <> 'delegate' and landed_by is distinct from 'steer'
    order by created_at desc, id desc limit 1`, [parent, name]);
  return rows[0];
}

/**
 * A send_message call: to one of the agent's children (by name or id), or to its parent ("parent", from the run's signed
 * chain), and no one else. Its request id is the call's, so a call made again (a turn resumed on another node) sends
 * nothing twice. To the parent, it is delivered as a notification is, without the child's turn ending. To a child, it
 * joins the child's running turn, or starts one that keeps its history: a row of its own, written first, so that
 * turn's end notifies the parent again. At most MULTI_AGENT_LIMITS.messagesPerRun per run.
 */
async function sendMessage(ctx: ChildrenContext, session: Session, settings: DelegateSettings | undefined, call: ToolCall): Promise<McpResult> {
  const { header } = session;
  const tenant = header.tenant;
  const run = runningRun(session);
  const { submit } = ctx.options;
  if (!submit) throw new Error("Sub-agents are not enabled on this runtime");
  if (!run || !call.toolCallId || call.innerCallId || !call.idempotencyKey) throw new Error("send_message is called directly, not from js_exec");
  const { to, text } = call.args as { to?: unknown; text?: unknown };
  if (typeof to !== "string" || !to) throw new Error("Say whom the message is for: a sub-agent's name or agentId, or \"parent\"");
  if (typeof text !== "string" || !text.trim() || text.length > MULTI_AGENT_LIMITS.taskChars) throw new Error(`The message is 1 to ${MULTI_AGENT_LIMITS.taskChars} characters`);
  const requestId = `msg_${call.idempotencyKey}`;
  const sent = session.messagesSent ??= new Map();
  const count = sent.get(run.id) ?? new Set<string>();
  if (!count.has(requestId) && count.size >= MULTI_AGENT_LIMITS.messagesPerRun) {
    throw new Error(`This turn has sent ${count.size} messages, the most one turn may send: finish the turn, or wait for answers (wait_agent)`);
  }
  count.add(requestId);
  sent.set(run.id, count);
  const lineage = delegation.lineage(ctx, session, run);
  if (to === "parent") {
    if (!lineage) throw new Error("You have no parent agent to message: only a sub-agent has one");
    // The parent's name for this agent, as its notifications say.
    const named = (await ctx.db.query("select name from agent_children where parent = $1 and child = $2 order by created_at desc limit 1", [lineage.parent, header.id])).rows[0]?.name as string | undefined;
    const message = agentMessage({ agentId: header.id, name: named ?? header.metadata?.name ?? "subagent", root: lineage.root }, text, "parent");
    // Its running turn takes it in at its next step (a wait_agent of its answers at once); an idle parent, as a turn of its own.
    const record = await submit(lineage.parent, tenant, { id: requestId, method: "prompt", params: { ...message, allowDisconnected: true, whileRunning: "steer" } });
    return jsonResult({ sent: true, to: "parent", into: record.steer === "accepted" || record.steeredInto ? "its running turn" : "a new turn of its own" });
  }
  const latest = await childNamed(ctx, header.id, to);
  if (!latest) throw new Error(`You have no sub-agent ${to}: you can message the sub-agents you started (by name or agentId), and "parent"`);
  const child = latest.child as string;
  // The child's turn is placed in this agent's chain, signed, so its "parent" and depth hold in it.
  const place = delegation.delegation(ctx, header.id, run.id, run.metadata);
  const chain = [...place.chain, header.id];
  const depth = Number(latest.depth);
  const maxDepth = Math.min(place.maxDepth, settings?.maxDepth ?? MULTI_AGENT_LIMITS.maxDepth);
  const metadata = { [PARENT_KEYS.agent]: header.id, [PARENT_KEYS.run]: run.id, [PARENT_KEYS.toolCall]: call.toolCallId, [PARENT_KEYS.depth]: String(depth), [PARENT_KEYS.maxDepth]: String(maxDepth), [PARENT_KEYS.chain]: chain.join(","),
    [PARENT_KEYS.signature]: delegation.delegationSignature(ctx, child, requestId, String(depth), String(maxDepth), chain.join(",")) };
  const message = agentMessage({ agentId: header.id, name: "parent", root: chain[0] }, text, "child");
  const now = Date.now();
  // Written first, as a spawn's row is; a running turn of the child takes the message in (whileRunning: steer), and its
  // row is then folded into that turn's (`recordEnding`).
  const open = (await ctx.db.query("select request_id from agent_children where parent = $1 and child = $2 and state = 'running' and ended_at is null and kind in ('spawn', 'message') and id <> $3 order by created_at desc limit 1", [header.id, child, requestId])).rows[0];
  const running = !!open;
  // A turn the child was just given (a spawn of this response) may not have begun: wait a moment for it, so the message
  // joins it rather than queuing behind all of it.
  if (open) await turnBegun(ctx, child, tenant, open.request_id, call.signal);
  await transaction(ctx.db, async sql => {
    const { rows } = await sql.query(`insert into agent_children (id, tenant, parent, child, request_id, name, depth, root, parent_run, tool_call_id, kind, made, checked_at, created_at, updated_at)
      values ($1, $2, $3, $4, $1, $5, $6, $7, $8, $9, 'message', $10, $11, $11, $11) on conflict do nothing returning id`, [requestId, tenant, header.id, child, latest.name, depth, chain[0], run.id, call.toolCallId, latest.made, now]);
    // A new message supersedes what the child waits on a person for: its resume will not come.
    if (rows.length && !running) await sql.query("update agent_children set ended_at = $3, state = 'notified', landed_at = $3, landed_by = 'superseded', updated_at = $3 where parent = $1 and child = $2 and kind = 'resume' and ended_at is null", [header.id, child, now]);
  });
  const at = { toolCallId: call.toolCallId, agentId: child, requestId };
  try {
    const record = await submit(child, tenant, { id: requestId, method: "prompt", params: { ...message, metadata, ...running ? { whileRunning: "steer" } : {} } });
    if (record.steer !== "accepted" && !record.steeredInto) relayChild(ctx, session, run.id, at);
    return jsonResult({ sent: true, to: latest.name, agentId: child, ...record.steer === "accepted" || record.steeredInto ? { into: "its running turn" } : { into: "a new turn: its answer comes as a notification" } });
  } catch (error) {
    if ((error as HttpError).code !== "IDEMPOTENCY_CONFLICT") await ctx.db.query("update agent_children set state = 'notified', status = 'failed', updated_at = $2 where id = $1 and ended_at is null", [requestId, Date.now()]);
    throw error;
  }
}

/** How long a message waits for its child's accepted turn to begin, before it queues behind it. */
const TURN_BEGIN_WAIT_MS = 10_000;
async function turnBegun(ctx: ChildrenContext, child: string, tenant: string, requestId: string, signal: AbortSignal) {
  for (const deadline = Date.now() + TURN_BEGIN_WAIT_MS; Date.now() < deadline;) {
    const record = await delegation.requestOf(ctx, child, tenant, requestId, 0, signal).catch(() => undefined);
    if (!record || record.began || record.state === "completed") return;
    await new Promise(resolve => setTimeout(resolve, 100));
    signal.throwIfAborted();
  }
}

/** An interrupt_agent call: abort one of the agent's running children; its notification follows, aborted. */
async function interruptAgent(ctx: ChildrenContext, session: Session, call: ToolCall): Promise<McpResult> {
  const { agent: name } = call.args as { agent?: unknown };
  if (typeof name !== "string" || !name) throw new Error("Name the sub-agent to interrupt");
  const latest = await childNamed(ctx, session.header.id, name);
  if (!latest) throw new Error(`You have no sub-agent ${name}`);
  const running = (await ctx.db.query("select * from agent_children where parent = $1 and child = $2 and ended_at is null and kind in ('spawn', 'message') order by created_at desc", [session.header.id, latest.child])).rows;
  if (!running.length) return jsonResult({ agentId: latest.child, name: latest.name, interrupted: false, status: latest.status ?? "running", message: "It is not running" });
  await delegation.abortChild(ctx, session.header.tenant, running[0], call.idempotencyKey ? `interrupt_${call.idempotencyKey}` : undefined);
  return jsonResult({ agentId: latest.child, name: latest.name, interrupted: true, message: "Its turn is being aborted: its notification follows" });
}

/**
 * A child's message the agent's running turn accepted (`whileRunning: "steer"`): the model gets it at its next step. Until
 * then it is pending (`agentMessages`), and a wait_agent call in progress answers now, so the model is not kept from it.
 */
export function messageAccepted(session: Session, id: string, params: any) {
  const metadata = params?.notice?.metadata;
  if (metadata?.kind !== "message" || metadata.to !== "parent" || !session.running.has(id)) return;
  (session.agentMessages ??= new Map()).set(id, String(metadata.name ?? "a sub-agent"));
  for (const wake of session.messageWaiters ?? []) wake(String(metadata.name ?? "a sub-agent"));
}

/** A child's message the running turn `turn` took: the model has it. Shown on the stream, as a message's own turn shows it. */
export function messageTaken(ctx: ChildrenContext, session: Session, id: string, params: any, turn: string) {
  const notice = params?.notice;
  if (notice?.metadata?.kind !== "message" || notice.metadata.to !== "parent") return;
  ctx.publish(session, { type: "event", requestId: turn, event: { type: "subagent_message", agentId: notice.source.agentId, name: notice.source.name, text: params.text } });
}

/** Abort the agent's running background children: its abort or deletion cascades to them (`children: "keep"` opts out). */
export function abortBackground(ctx: ChildrenContext, session: Session) {
  const { id, tenant } = session.header;
  void (async () => {
    const { rows } = await ctx.db.query("select * from agent_children where parent = $1 and state = 'running' and ended_at is null and kind in ('spawn', 'message')", [id]);
    await Promise.all(rows.map(row => delegation.abortChild(ctx, tenant, row).catch(error => console.error(JSON.stringify({ type: "subagent_abort_failed", agent: id, child: row.child, error: safeError(error) })))));
  })().catch(error => console.error(JSON.stringify({ type: "subagent_abort_failed", agent: id, error: safeError(error) })));
}

/**
 * A child's notification, or an agent's message, starting its run: a notification lands once (`landed_at`, which a
 * wait_agent may have taken first: then the run ends without it), and what the child spent is charged here; a child's
 * message is shown on the stream (`subagent_message`). The turn runs unless the agent is at its spend limit or the
 * chain's root at its wake cap: then the message lands in history and no model is asked. The decision is made durable
 * on the run's record before the message lands, so a next owner of a turn cut short keeps it (`resume`). `again`: the
 * run's next owner landing it (its first may have done this already).
 */
async function landNotice(ctx: ChildrenContext, session: Session, record: RequestRecord, params: any, again = false): Promise<{ params: any } | { outcome: Outcome }> {
  const notice = params.notice as { source: { agentId: string; name: string }; root: string; costUsd: number; metadata: Record<string, any> };
  const { metadata } = notice;
  const now = Date.now();
  const message = metadata.kind === "message";
  const childRequest = record.id.slice("child_".length);
  // Landing is one statement, made again by a run tried again (`landing`), and a landing found already made by this
  // request (its earlier attempt, or its earlier owner) is not charged or counted again.
  let fresh = message && !again, toolCallId: string | undefined;
  if (!message) {
    const landed = await ctx.db.query("update agent_children set landed_at = $3, landed_by = 'notice', state = 'notified', updated_at = $3 where child = $1 and request_id = $2 and landed_at is null returning tool_call_id", [notice.source.agentId, childRequest, now]);
    if (landed.rows.length) { fresh = true; toolCallId = landed.rows[0].tool_call_id ?? undefined; }
    else {
      const row = (await ctx.db.query("select landed_by from agent_children where child = $1 and request_id = $2", [notice.source.agentId, childRequest])).rows[0];
      if (row && row.landed_by !== "notice") return { outcome: { result: { error: null, skipped: "wait_agent answered this sub-agent's ending already" } } };
    }
  }
  if (message) {
    session.agentMessages?.delete(record.id);
    if (metadata.to === "parent" && fresh) ctx.publish(session, { type: "event", requestId: record.id, event: { type: "subagent_message", agentId: notice.source.agentId, name: notice.source.name, text: params.text } });
  } else if (fresh) {
    // What the child spent counts before the spend check below.
    chargeNotice(ctx, session, record.id, notice.costUsd);
    ctx.publish(session, { type: "event", requestId: record.id, event: { type: "subagent_end", ...toolCallId ? { toolCallId } : {}, agentId: notice.source.agentId, requestId: childRequest, name: notice.source.name, status: metadata.status, ...(metadata.error ? { error: metadata.error } : {}), background: true } });
  }
  // Stopped before it ran (`stop`): it lands without a turn, which counts no wake.
  const stopped = session.requests.get(record.id)?.landOnly;
  if (stopped) return { params: { ...params, landOnly: stopped } };
  const refused = await spend.runLimit(ctx.spendContext, session, "prompt");
  const cap = ctx.options.wakesPerHour ?? MULTI_AGENT_LIMITS.wakesPerHour;
  const hour = Math.floor(now / 3_600_000);
  const turns = refused ? 0 : Number((fresh
    ? await ctx.db.query("insert into agent_wakes (root, hour, turns) values ($1, $2, 1) on conflict (root, hour) do update set turns = agent_wakes.turns + 1 returning turns", [notice.root, hour])
    : await ctx.db.query("select turns from agent_wakes where root = $1 and hour = $2", [notice.root, hour])).rows[0]?.turns ?? 0);
  const refusal = refused ? { message: refused.message, ...spend.refusalStop(refused) ?? { stopped: "spend_limit" } }
    : turns > cap ? { stopped: "agent_loop_limit", message: `This agent's chain has had ${cap} turns started by sub-agent notifications and messages this hour, its limit (AGENT_WAKES_PER_HOUR): the message is in its history, but no turn ran. Send a message to go on` } : undefined;
  if (!refusal) return { params };
  if (refusal.stopped === "agent_loop_limit") sometimes(true, "a notification reached its chain's wake cap");
  // Durable before the message lands: whoever has the turn next keeps the refusal.
  ctx.upsertRequest(session, { ...session.requests.get(record.id)!, landOnly: refusal });
  await ctx.commit(session, true);
  return { params: { ...params, landOnly: refusal } };
}

/**
 * A notification's or message's landing (`landNotice`), tried again when the database refuses it for now or cannot be
 * reached, as a run's start is (`startStep`). Should it still fail, the message lands anyway, without its bookkeeping:
 * it is the runtime's, and its request is never sent again. Undefined: the session was given up meanwhile.
 */
export async function landing(ctx: ChildrenContext, session: Session, record: RequestRecord, params: any, again = false): Promise<{ params: any } | { outcome: Outcome } | undefined> {
  let result: { params: any } | { outcome: Outcome } | undefined, tries = 0;
  try {
    if (!await ctx.startStep(session, record, async () => { result = await landNotice(ctx, session, record, params, again || tries++ > 0); return true; })) return undefined;
  } catch (error) {
    console.error(JSON.stringify({ type: "notice_landing_failed", agent: session.header.id, request: record.id, error: safeError(error) }));
    return { params };
  }
  if (tries > 1) reachable("a notification's landing met a transient refusal and was tried again");
  return result;
}

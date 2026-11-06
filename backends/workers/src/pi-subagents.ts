/**
 * SPIKE (AGENT_PI_SUBAGENTS=1, default off): subagents as Pi child conversations in this agent's own Harness, owned by
 * the calling tool's task (pi-durable's "Abort and Subagents" pattern), instead of separate agents (delegation.ts).
 * See docs/pi-owned-subagents.md. What Pi gives for free here: the child is found again by its owner task on a replay
 * (scanConversations + a stable requestId), aborting the call or the parent aborts the child bottom-up, the parent is
 * idle only once the child is, and deleting the agent deletes its children (they are its own SQLite rows).
 *
 * - delegate: the child is owned by the delegate call's task; the call waits for its answer.
 * - spawn_agent: the child is owned by a background anchor task, so the parent's turn ends and Esc does not reach it;
 *   a background reporter task delivers each message to it and lands the answer as a notification (example 22).
 * - wait_agent waits on reporters; one Pi commit decides whether the wait or the notification takes an answer.
 * - list_agents, send_message, interrupt_agent and report_progress work on the parent's `camel.subagents` document.
 *
 * Children have synthetic ids (`<agent>-c<conversation>`): they are not agents of their own, so GET /v1/agents/<id>,
 * their own history, files, computers and spend lines do not exist. The spike keeps camelRun's request records for
 * notifications (the existing outbox), so a notification is still a `child_<request>` run of the parent.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type ConversationId,
  configure,
  defineDoc,
  defineTask,
  defineTool,
  type EntryId,
  type Harness,
  type ModelRef,
  ProviderDoc,
  type TaskId,
  type ToolExecutionApi,
  type ToolRegistration,
  type Tx,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { HttpError } from "./errors.ts";
import { MULTI_AGENT_LIMITS, REPORT_PROGRESS, SEND_MESSAGE, agentsTools, agentUpdates, delegateTool, roleAndTask, type DelegateSettings } from "./multi-agent-policy.ts";
import { childConfig } from "./child-config.ts";
import type { DelegatedChild, ParentRun } from "./delegation.ts";

const context = BACKGROUND_CONTEXT;

/** Where a conversation sits in the tree; absent on the root conversation (depth 0). */
type Subagent = {
  name: string;
  agentId: string;
  depth: number;
  maxDepth: number;
  /** The root run whose budget and usage the child counts in. */
  runId: string;
  parent: string;
  background: boolean;
  systemPrompt?: string;
  delegate?: DelegateSettings;
  /** The JSON Schema a delegate call asked the answer in, and the answer final_output gave. */
  output?: Record<string, unknown>;

};
export const SubagentDoc = defineDoc<{ value: any }>({
  kind: "camel.subagent", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ value: null }), checkpointWhen: () => false,
});

type ChildRow = {
  conversationId: string; agentId: string; name: string; parent: string; runId: string; toolCallId: string;
  background: boolean; createdAt: number; status: "running" | "completed" | "failed" | "aborted";
  /** The tool call's task that made it: a replay of the call finds this row. */
  callTask?: string;
  /** The agent at the chain's root (wake cap), and the run that took a background child's answer (where its cost lands). */
  rootAgent?: string; landedRun?: string;
  endedAt?: number; text?: string; output?: unknown; error?: string; costUsd?: number; reporter?: string;
  /** Who took the latest answer: a wait_agent result or a notification. Decided in one Pi commit. */
  landedBy?: "wait" | "notice"; requestId: string; progress?: { text: string; at: number; sequence: number }; progressShown?: number;
};
/** Every child of this agent, at any depth, on the root conversation. */
export const ChildrenDoc = defineDoc<{ children: Record<string, any>; reports: number }>({
  kind: "camel.subagents", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ children: {}, reports: 0 }), checkpointWhen: () => false,
});

export interface PiSubagentsHost {
  pi(): Promise<Harness>;
  /** The calling run and the agent's configuration, as Delegation's host gives them. */
  context(api?: ToolExecutionApi): Promise<{ id: string; config: Record<string, any>; run: ParentRun }>;
  target(ref: { agent?: string; definition?: string }): Promise<{ id?: string; config: Record<string, any>; description?: string }>;
  /** The model a child configuration names, registered with the agent's models. */
  model(config: Record<string, any>): ModelRef;
  /** The tools a child configuration enables, from what this agent has installed. */
  tools(config: Record<string, any>): Promise<{ tools?: readonly ToolRegistration[] }>;
  emit(event: unknown): Promise<void>;
  /** Land a background child's answer as a `child_<request>` notification (the existing outbox and wake cap). */
  notify(child: DelegatedChild): Promise<void>;
  /** A child's message to its parent: a steer or a new turn of the parent agent. */
  messageParent(from: { agentId: string; name: string }, text: string, requestId: string): Promise<unknown>;
}

/** Pi conversation ids are numbers; the documents keep them as strings (record keys). */
const cid = (id: string) => Number(id) as unknown as ConversationId;
/** A plain copy of document state: a commit's drafts are unusable once it settles. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const synthetic = (agent: string, conversation: string) => `${agent}-c${conversation}`;
const textOf = (message: AssistantMessage | undefined) => (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/** A child's cost so far, its own children's included: Pi keeps usage per conversation. */
async function costOf(harness: Harness, rows: Record<string, ChildRow>, conversation: string): Promise<number> {
  const usage = await harness.snapshot(UsageDoc, cid(conversation), context);
  let total = 0;
  for (const bucket of Object.values(usage?.models ?? {})) total += (bucket as { cost?: { total?: number } }).cost?.total ?? 0;
  for (const row of Object.values(rows)) if (row.parent === conversation) total += await costOf(harness, rows, row.conversationId);
  return total;
}

export class PiSubagents {
  readonly host: PiSubagentsHost;
  /** Provider session id -> child conversation: model hooks tell a child's request from the root's by it. */
  readonly sessions = new Map<string, string>();
  constructor(host: PiSubagentsHost) { this.host = host; }

  /** The child's latest answer text, from its own transcript. */
  private async lastText(pi: Harness, conversation: string) {
    const child = await pi.conversation(cid(conversation), context);
    const page = await child?.entries({ order: "descending" }, 20, undefined, context);
    for (const entry of page?.items ?? []) if (entry.kind === "pi.assistant") {
      const text = textOf(entry.model?.[0] as AssistantMessage | undefined);
      if (text) return text;
    }
    return "";
  }

  private rootSession?: string;
  /** Whether a model request belongs to a child conversation. After a restart the map is rebuilt from the docs. */
  async isChildSession(session?: string) {
    if (session === undefined) return false;
    if (this.sessions.has(session)) return true;
    if (this.rootSession === undefined) {
      const pi = await this.host.pi(), root = await pi.root(context);
      this.rootSession = (await pi.snapshot(ProviderDoc, root.id, context))?.sessionId;
    }
    if (session === this.rootSession) return false;
    await this.remap();
    return this.sessions.has(session);
  }

  /** The schema a child's answer must take, when its delegate call gave one. */
  async outputSchema(api: ToolExecutionApi) {
    return ((await api.snapshot(SubagentDoc, api.conversationId, context))?.value as Subagent | null)?.output;
  }

  /** The answer a child gave through final_output: its result's details, in the child's own transcript. */
  private async outputOf(pi: Harness, conversation: string) {
    const child = await pi.conversation(cid(conversation), context);
    const page = await child?.entries({ order: "descending" }, 20, undefined, context);
    for (const entry of page?.items ?? []) {
      const message = entry.model?.[0] as { role?: string; toolName?: string; details?: { output?: unknown } } | undefined;
      if (message?.role === "toolResult" && message.toolName === "final_output" && message.details?.output !== undefined) return message.details.output;
    }
    return undefined;
  }

  /** The system prompt section of a child conversation: its own, not the parent agent's. */
  async childPrompt(read: { snapshot: Harness["snapshot"] }, conversation: ConversationId) {
    return (await read.snapshot(SubagentDoc, conversation, context))?.value ?? undefined;
  }

  /** A child's streamed delta, relayed to subscribers that ask (`?subagents=1`), never into the parent's own run. */
  async childEvent(session: string, event: { type: string; delta?: string }) {
    if (event.type !== "text_delta") return;
    const conversation = this.sessions.get(session)!;
    const rows = await this.rows();
    const row = rows[conversation];
    if (!row) return;
    await this.host.emit({ type: "event", requestId: row.runId, event: { type: "subagent_event", toolCallId: row.toolCallId, agentId: row.agentId, requestId: row.requestId, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: event.delta } } } });
  }

  async rows() {
    const pi = await this.host.pi(), root = await pi.root(context);
    return (await pi.snapshot(ChildrenDoc, root.id, context))?.children ?? {};
  }

  /** What a run's children spent (subagentCostUsd), from Pi's per-conversation usage. */
  async cost(runId: string) {
    const pi = await this.host.pi(), rows = await this.rows(), root = await pi.root(context);
    let total = 0;
    for (const row of Object.values(rows)) if (row.parent === String(root.id) && ((row.runId === runId && !row.background) || row.landedRun === runId)) total += await costOf(pi, rows, row.conversationId);
    return total;
  }

  /** Abort background children (the parent's Esc stops at their anchors). Delegate children go with their calls. */
  async abortBackground() {
    const pi = await this.host.pi();
    for (const row of Object.values(await this.rows())) if (row.background && row.status === "running")
      await (await pi.conversation(cid(row.conversationId), context))?.abort(context);
  }

  async remap() {
    const pi = await this.host.pi();
    for (const row of Object.values(await this.rows())) {
      const provider = await pi.snapshot(ProviderDoc, cid(row.conversationId), context);
      if (provider) this.sessions.set(provider.sessionId, row.conversationId);
    }
  }

  private async place(api: ToolExecutionApi) {
    const own = (await api.snapshot(SubagentDoc, api.conversationId, context))?.value ?? undefined;
    const { id, config, run } = await this.host.context(api);
    const settings: DelegateSettings | undefined = own ? own.delegate : config.delegate;
    if (!settings) throw new HttpError(400, "This agent has no delegation settings");
    const depth = (own?.depth ?? 0) + 1;
    const maxDepth = Math.min(own?.maxDepth ?? MULTI_AGENT_LIMITS.depthCeiling, settings.maxDepth ?? MULTI_AGENT_LIMITS.maxDepth);
    return { id, config, run, settings, depth, maxDepth, own };
  }

  /** Validate, admit under maxParallel, and create (or find again) the child conversation owned by `owner`. */
  private async start(args: Record<string, unknown>, api: ToolExecutionApi, signal: AbortSignal, background: boolean) {
    const { id, config, run, settings, depth, maxDepth, own } = await this.place(api);
    const target = args.agent === undefined ? undefined : settings.agents?.find((entry) => entry.name === args.agent);
    if (args.agent !== undefined && !target) throw new HttpError(400, `There is no agent ${String(args.agent)} to delegate to`);
    if (args.instructions !== undefined && !settings.instructions) throw new HttpError(400, "Instructions of your own are not allowed here");
    if ((target === undefined) === (args.instructions === undefined)) throw new HttpError(400, "Name an agent or give instructions, one of them");
    if (typeof args.task !== "string" || !args.task.trim() || args.task.length > MULTI_AGENT_LIMITS.taskChars) throw new HttpError(400, "Give the sub-agent its task");
    if (depth > maxDepth) throw new HttpError(400, `Delegation has reached its depth limit of ${maxDepth}: do this task yourself`, "DELEGATION_DEPTH");
    // A persistent agent (`agent:` target) is an agent of its own: this spike leaves it to delegation.ts.
    const resolved = target ? await this.host.target(target) : undefined;
    if (resolved?.id) throw new HttpError(400, "Delegating to an existing agent is not part of the Pi subagent spike");
    const childConf: Record<string, any> = childConfig(config, resolved?.config, run.params);
    const maxParallel = settings.maxParallel ?? MULTI_AGENT_LIMITS.maxParallel;
    const runId = own?.runId ?? run.id;
    const pi = await this.host.pi();
    const root = await pi.root(context);
    const tools = await this.host.tools(childConf);
    const model = this.host.model(childConf);
    for (;;) {
      signal.throwIfAborted();
      // Admission and creation are one Pi commit: a replay finds the child this call already made. A delegate child is
      // owned by the call's task; a background child by an anchor task created in this same commit (example 22), so the
      // anchor cannot finish before it owns the child.
      const admitted = await api.commit(async (tx: Tx) => {
        const doc = await tx.doc(ChildrenDoc, root.id);
        const existing = Object.values(doc.children).find((row) => row.callTask === String(api.taskId));
        if (existing) return plain(existing);
        const running = Object.values(doc.children).filter((row) => row.parent === String(api.conversationId) && row.status === "running" && (background ? row.background : row.runId === runId && !row.background));
        if (running.length >= maxParallel) {
          if (background) throw new HttpError(400, `${running.length} sub-agents are running, this agent's most at once: wait for one to finish (wait_agent) before starting another`);
          return undefined;
        }
        const name = typeof args.name === "string" ? args.name : `${target?.name ?? "subagent"}-${Object.values(doc.children).filter((row) => row.parent === String(api.conversationId)).length + 1}`;
        if (args.name && running.some((row) => row.name === args.name)) throw new HttpError(400, "A sub-agent with this name is already running");
        const anchor = background ? await tx.createTask(this.Anchor, null, { ownership: { kind: "conversation" }, background: true }) : api.taskId;
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
        const conversation = String(created.id);
        const delegate = childConf.delegate as DelegateSettings | undefined;
        await configure(tx, created.id, { model, instructions: null, ...(tools.tools ? { tools: tools.tools } : {}) });
        const subagent: Subagent = { name, agentId: synthetic(id, conversation), depth, maxDepth, runId, parent: String(api.conversationId), background, systemPrompt: (childConf.systemPrompt as string | undefined), ...(delegate ? { delegate } : {}), ...(args.output !== undefined ? { output: args.output as Record<string, unknown> } : {}) };
        (await tx.doc(SubagentDoc, created.id)).value = subagent;
        const row: ChildRow = { conversationId: conversation, agentId: subagent.agentId, name, parent: subagent.parent, runId, toolCallId: api.callId, background, createdAt: Date.now(), status: "running", requestId: `${background ? "spawn" : "delegate"}_${api.taskId}`, callTask: String(api.taskId), rootAgent: id };
        doc.children[conversation] = row;
        return plain(row);
      }, context);
      if (admitted) {
        const provider = await pi.snapshot(ProviderDoc, cid(admitted.conversationId), context);
        if (provider) this.sessions.set(provider.sessionId, admitted.conversationId);
        const task = args.instructions === undefined ? args.task : roleAndTask(args.instructions as string, args.task);
        return { row: admitted, task: task as string };
      }
      await sleep(25, signal);
    }
  }

  private async finish(conversation: string, settled: { status: string; type?: string; answer?: unknown; reason?: unknown }, landedBy?: "wait") {
    const pi = await this.host.pi(), root = await pi.root(context);
    const answer = settled.status === "done" && settled.type === "input" && settled.answer !== undefined ? await root.commit((tx) => tx.entry(AssistantEntry, settled.answer as EntryId), context) : undefined;
    const rows = await this.rows();
    const costUsd = await costOf(pi, rows, conversation);
    const output = await this.outputOf(pi, conversation);
    const lastText = await this.lastText(pi, conversation);
    return root.commit(async (tx) => {
      const doc = await tx.doc(ChildrenDoc, root.id);
      const row = doc.children[conversation]!;
      if (row.status !== "running") return plain(row);
      row.status = settled.status === "done" ? "completed" : settled.reason === "aborted" ? "aborted" : "failed";
      row.endedAt = Date.now();
      row.text = textOf(answer?.model?.[0] as AssistantMessage | undefined) || lastText;
      if (output !== undefined) row.output = output;
      if (row.status === "failed") row.error = String(settled.reason ?? "failed");
      row.costUsd = costUsd;
      if (landedBy) row.landedBy = landedBy;
      return plain(row);
    }, context);
  }

  private answer(row: ChildRow) {
    return { agentId: row.agentId, requestId: row.requestId, name: row.name, status: row.status, ...(row.text ? { text: row.text } : {}), ...(row.output !== undefined ? { output: row.output } : {}), ...(row.error ? { error: row.error } : {}) };
  }

  private async event(row: ChildRow, type: "subagent_start" | "subagent_end") {
    // The child's run is open (the separate-agent design relays the child's own turn_opened).
    if (type === "subagent_start") await this.host.emit({ type: "event", requestId: row.runId, event: { type: "subagent_event", toolCallId: row.toolCallId, agentId: row.agentId, requestId: row.requestId, event: { type: "turn_opened", index: 0 } } });
    await this.host.emit({ type: "event", requestId: row.runId, event: { type, toolCallId: row.toolCallId, agentId: row.agentId, requestId: row.requestId, name: row.name, ...(type === "subagent_start" ? { depth: 1 } : { status: row.status, ...(row.error ? { error: row.error } : {}) }), ...(row.background ? { background: true } : {}) } });
  }

  private async withUpdates(value: unknown, api: ToolExecutionApi) {
    const pi = await this.host.pi(), root = await pi.root(context);
    const reports = await root.commit(async (tx) => {
      const doc = await tx.doc(ChildrenDoc, root.id);
      const out = [];
      for (const row of Object.values(doc.children)) if (row.parent === String(api.conversationId) && row.status === "running" && row.progress && row.progress.sequence > (row.progressShown ?? 0)) {
        out.push({ name: row.name, text: row.progress.text, at: row.progress.at });
        row.progressShown = row.progress.sequence;
      }
      return out;
    }, context);
    return { output: [{ type: "text" as const, text: JSON.stringify(value) }, ...(reports.length ? [agentUpdates(reports)] : [])], structuredOutput: value as never };
  }

  /** The reporter: deliver one message to a background child and land its answer once (example 22's Reporter). */
  readonly Reporter = defineTask<{ conversation: string; message: string; requestId: string; followUp: boolean }, { phase: "deliver" } | { phase: "report"; ended: ChildRow | null }, null>({
    name: "camel.subagent-reporter", version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, taskContext) => {
        const child = (await runtime.conversation(cid(task.input.conversation), taskContext))!;
        const submission = await child.submit({ type: "input", content: task.input.message, requestId: task.input.requestId, whenBusy: task.input.followUp ? "followUp" : "steer" }, taskContext);
        const settled = await submission.wait(taskContext);
        const ended = await this.finish(task.input.conversation, settled as never);
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", ended } }), taskContext);
      },
      report: async (task, runtime, taskContext) => {
        const ended = task.state.checkpoint.ended;
        // One commit claims the landing, so a wait_agent that took the answer first wins and no notification follows.
        const pi = await this.host.pi(), root = await pi.root(context);
        const claimed = ended && await root.commit(async (tx) => {
          const row = (await tx.doc(ChildrenDoc, root.id)).children[ended.conversationId]!;
          if (row.landedBy) return false;
          row.landedBy = "notice"; row.landedRun = `child_${row.requestId}`;
          return true;
        }, taskContext);
        if (ended) await this.event(ended, "subagent_end");
        if (claimed && ended) await this.host.notify({ key: `pi-${ended.conversationId}-${task.id}`, id: ended.agentId, requestId: ended.requestId, root: ended.rootAgent ?? ended.agentId, name: ended.name, status: ended.status, outcome: { result: { reply: ended.text, usage: { costUsd: ended.costUsd ?? 0 } } }, error: ended.error, spent: ended.costUsd ?? 0 } as unknown as DelegatedChild);
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext);
      },
    },
    abort: (_task, runtime, taskContext) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
  });

  /** A background anchor: owns a persistent child conversation, outside the parent's Esc and idle waits. */
  readonly Anchor = defineTask<null, { phase: "done" }, null>({
    name: "camel.subagent-anchor", version: 1,
    initial: () => ({ phase: "done" }),
    phases: { done: (_task, runtime, taskContext) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext) },
    abort: (_task, runtime, taskContext) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
  });

  tasks() { return [this.Anchor, this.Reporter]; }

  tools(settings: DelegateSettings, builtins: readonly string[], describe: Parameters<typeof delegateTool>[1] = () => undefined): ToolRegistration[] {
    const definitions = [...(builtins.includes("delegate") ? [delegateTool(settings, describe)] : []), ...(builtins.includes("agents") ? agentsTools(settings, describe) : [])];
    // Any child may report progress or message its parent; the tools check it is one.
    definitions.push(REPORT_PROGRESS, ...(!definitions.some((tool) => tool.name === "send_message") ? [SEND_MESSAGE] : []));
    return definitions.map((definition) => defineTool({
      name: definition.name, description: definition.description, parameters: definition.parameters as never,
      ...(definition.callers ? { callers: definition.callers as ("model" | "tools")[] } : {}),
      structuredOutputSchema: {}, replay: "safe",
      execute: async (args: Record<string, unknown>, api: ToolExecutionApi, callContext: Context) => {
        const signal = callContext.abortSignal ?? new AbortController().signal;
        try {
          return await this.execute(definition.name, args, api, callContext, signal);
        } catch (error) {
          console.error(JSON.stringify({ type: "pi_subagent_tool_failed", tool: definition.name, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), stack: error instanceof Error ? error.stack?.split("\n").slice(0, 6).join(" | ") : undefined }));
          throw error;
        }
      },
    }) as ToolRegistration);
  }

  private async execute(name: string, args: Record<string, unknown>, api: ToolExecutionApi, callContext: Context, signal: AbortSignal) {
    const pi = await this.host.pi(), root = await pi.root(context);
    if (name === "delegate") {
      const { row, task } = await this.start(args, api, signal, false);
      await this.event(row, "subagent_start");
      const child = (await api.conversation(cid(row.conversationId), callContext))!;
      // The stable request id makes a rerun after a crash find the submission it made.
      let step = "submit";
      try {
        const settled = await (await child.submit({ type: "input", content: task, requestId: `delegate:${api.taskId}` }, callContext)).wait(callContext);
        step = "finish";
        const ended = await this.finish(row.conversationId, settled as never, "wait");
        step = "end";
        await this.event(ended, "subagent_end");
        step = "result";
        return { ...(await this.withUpdates(this.answer(ended), api)), ...(ended.status === "completed" ? {} : { isError: true }) };
      } catch (error) {
        throw new Error(`delegate ${step}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    if (name === "spawn_agent") {
      const { row, task } = await this.start(args, api, signal, true);
      const reporter = await api.memo<string>("reporter", callContext) ?? await api.memo("reporter", String(await api.createTask(this.Reporter, { conversation: row.conversationId, message: task, requestId: `spawn:${api.taskId}`, followUp: true }, { ownership: { kind: "conversation" }, background: true }, callContext)), callContext);
      await root.commit(async (tx) => { (await tx.doc(ChildrenDoc, root.id)).children[row.conversationId]!.reporter = reporter; }, callContext);
      await this.event(row, "subagent_start");
      return this.withUpdates({ agentId: row.agentId, requestId: row.requestId, name: row.name, status: "running" }, api);
    }
    const own = (await api.snapshot(SubagentDoc, api.conversationId, callContext))?.value ?? undefined;
    const mine = Object.values(await this.rows()).filter((row) => row.parent === String(api.conversationId));
    const find = (ref: unknown) => [...mine].reverse().find((row) => row.agentId === ref || row.name === ref);
    if (name === "report_progress") {
      if (!own) throw new HttpError(400, "This run has no parent");
      const text = String(args.text ?? "").trim();
      if (!text || text.length > MULTI_AGENT_LIMITS.progressChars) throw new HttpError(400, "Invalid progress report");
      const row = await root.commit(async (tx) => {
        const current = (await tx.doc(ChildrenDoc, root.id)).children[String(api.conversationId)];
        if (!current || current.status !== "running") return undefined;
        current.progress = { text, at: Date.now(), sequence: (current.progress?.sequence ?? 0) + 1 };
        return plain(current);
      }, callContext);
      if (row) await this.host.emit({ type: "event", requestId: row.runId, event: { type: "subagent_progress", toolCallId: row.toolCallId, agentId: row.agentId, requestId: row.requestId, name: row.name, text, at: row.progress!.at, ...(row.background ? { background: true } : {}) } });
      return this.withUpdates({ reported: true }, api);
    }
    if (name === "list_agents")
      return this.withUpdates({ agents: mine.filter((row) => row.background).map((row) => ({ agentId: row.agentId, name: row.name, status: row.status, startedAt: row.createdAt, ...(row.endedAt ? { endedAt: row.endedAt } : {}), ...(row.progress ? { progress: row.progress.text, progressAt: row.progress.at } : {}) })) }, api);
    if (name === "send_message") {
      const text = String(args.text ?? "");
      if (!text.trim() || text.length > MULTI_AGENT_LIMITS.taskChars) throw new HttpError(400, "Invalid message");
      if (args.to === "parent") {
        if (!own) throw new HttpError(400, "This run has no parent");
        if (own.parent !== String(root.id)) throw new HttpError(400, "Messages to a parent that is itself a sub-agent are not part of the spike");
        const response = await this.host.messageParent({ agentId: own.agentId, name: own.name }, text, `msg_${api.taskId}`) as { steer?: string; steeredInto?: string } | undefined;
        return this.withUpdates({ sent: true, to: "parent", into: response?.steer === "accepted" || response?.steeredInto ? "its running turn" : "a new turn of its own" }, api);
      }
      const row = find(args.to);
      if (!row) throw new HttpError(404, "Unknown sub-agent");
      const busy = row.status === "running";
      if (!busy) await root.commit(async (tx) => {
        const current = (await tx.doc(ChildrenDoc, root.id)).children[row.conversationId]!;
        Object.assign(current, { status: "running", endedAt: undefined, landedBy: undefined, text: undefined, error: undefined, requestId: `msg_${api.taskId}` });
      }, callContext);
      const reporter = await api.memo<string>("reporter", callContext) ?? await api.memo("reporter", String(await api.createTask(this.Reporter, { conversation: row.conversationId, message: text, requestId: `msg:${api.taskId}`, followUp: !busy }, { ownership: { kind: "conversation" }, background: true }, callContext)), callContext);
      if (!busy) await root.commit(async (tx) => { (await tx.doc(ChildrenDoc, root.id)).children[row.conversationId]!.reporter = reporter; }, callContext);
      return this.withUpdates({ sent: true, to: row.name, agentId: row.agentId, into: busy ? "its running turn" : "a new turn: its answer comes as a notification" }, api);
    }
    if (name === "interrupt_agent") {
      const row = find(args.agent);
      if (!row) throw new HttpError(404, "Unknown sub-agent");
      await (await api.conversation(cid(row.conversationId), callContext))?.abort(callContext);
      return this.withUpdates({ agentId: row.agentId, interrupted: true }, api);
    }
    if (name === "wait_agent") {
      if (args.agents !== undefined && (!Array.isArray(args.agents) || args.agents.some((entry) => typeof entry !== "string"))) throw new HttpError(400, "agents is a list of names or agentIds");
      const timeoutMs = Number(args.timeoutMs ?? MULTI_AGENT_LIMITS.waitMs);
      const background = mine.filter((row) => row.background);
      const selected = background.filter((row) => (Array.isArray(args.agents) ? args.agents.includes(row.agentId) || args.agents.includes(row.name) : !row.landedBy));
      if (Array.isArray(args.agents)) for (const ref of args.agents) if (!selected.some((row) => row.agentId === ref || row.name === ref)) throw new HttpError(400, `You have no sub-agent ${ref}`);
      if (!selected.length) return this.withUpdates({ agents: [] }, api);
      const deadline = Date.now() + timeoutMs;
      // Wait for the first selected child's reporter to settle its answer, or the timeout.
      while (Date.now() < deadline) {
        const rows = await this.rows();
        if (selected.some((row) => rows[row.conversationId]?.status !== "running")) break;
        await sleep(Math.min(50, Math.max(1, deadline - Date.now())), signal);
      }
      // The run that takes an answer here is charged what that child spent.
      const waitRun = own?.runId ?? (await this.host.context(api)).run.id;
      const answers = await root.commit(async (tx) => {
        const doc = await tx.doc(ChildrenDoc, root.id);
        return selected.map((old) => {
          const row = doc.children[old.conversationId]!;
          if (row.status !== "running" && row.landedBy) return { agentId: row.agentId, name: row.name, status: row.status, note: "Its answer comes (or came) as a notification" };
          if (row.status !== "running") { row.landedBy = "wait"; row.landedRun = waitRun; }
          return plain(this.answer(row));
        });
      }, callContext);
      return this.withUpdates({ agents: answers, ...(answers.every((entry) => entry.status === "running") ? { timedOut: true } : {}) }, api);
    }
    throw new HttpError(400, "Unknown delegation tool");
  }
}

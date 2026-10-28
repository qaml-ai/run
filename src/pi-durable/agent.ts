import { estimateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { AgentEvent, AgentMessage, AgentOptions, AgentState, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentSystemMessage, getSystemMessageText, type AssistantMessage, type ImageContent, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { convertToLlm as contextMessages, COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "../pi-harness/messages.ts";
import {
  GenerationTask, Harness, LiveDoc, createRegistry, createSession, defineDoc, hook, section,
  type Conversation, type ConversationId, type EntryRecord, type FailedAttempt, type HarnessOptions, type RetryDecision, type RegistryReader, type RegistrySnapshot, type Report, type Storage,
} from "@earendil-works/pi-durable";

/** Small latest-value document: loading an agent never scans its journal for a limit. */
export const ContextLimitDoc = defineDoc({
  kind: "camel.context.limit", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: (): { provider: string; model: string; window: number } => ({ provider: "", model: "", window: 0 }),
  checkpointWhen: () => true,
});

// Evidence is separate from the limit: one dropped stream must not pin future turns to a smaller window.
const InferredOverflowDoc = defineDoc({
  kind: "camel.context.inferred-overflow", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ provider: "", model: "", at: 0 }),
  checkpointWhen: () => true,
});

interface DurableCursor { entryId: number; index: number }
interface DurableMessage { message: AgentMessage; cursor: DurableCursor }
export type DurableAgentOptions = Omit<AgentOptions, "transformContext"> & {
  durable: {
    storage: Storage;
    conversationId?: ConversationId | number;
    cursor?: DurableCursor;
    /** The latest journal message the host wrote itself: a run's new messages are the ones after it. */
    written?: () => DurableCursor | undefined;
    /**
     * The host's system message as its configuration makes it, for the sections of a request whose context shows none
     * yet (the first after a compaction, before Pi writes its baseline), and the fixed part of the recent context kept.
     */
    leading?: () => AgentMessage | undefined;
    /** Telemetry only: Pi's held context before conversion, and the request sent. */
    onContextRequest?: (held: number, sent: number) => void;
    contextWindow?: number;
    maxOutputTokens?: number;
    summaryStream?: AgentOptions["streamFn"];
    onSummary?: (message: AssistantMessage) => void | Promise<void>;
    onCompaction?: (state: { summary: string; keptMessages: number; at: number; reason: "threshold" | "overflow" }) => void | Promise<void>;
    /**
     * Pi's Session failed (`storage_failed`: a storage call failed past the Storage's own retries, by Pi's rule) and closed
     * the Storage, or the agent's commit observer failed or was ended, so what it holds may lag what is stored: the host
     * must be given up and reopened from what was committed.
     */
    onStorageFailure?: (error: unknown) => void;
    /** Whether Pi makes a failed model request again (`beforeRetry`); without, it does not. Failed attempts it retries leave no entry. */
    beforeRetry?: (failed: FailedAttempt) => RetryDecision | undefined;
  };
};
type Listener = (event: AgentEvent & { durable?: DurableCursor }, signal: AbortSignal) => void | Promise<void>;
const context = BACKGROUND_CONTEXT;
const nativeKinds = new Set(["pi.user", "pi.assistant", "pi.tool-result", "camel.user", "camel.message"]);

/** Read both full user messages and entries with content stored only in Pi's model message. */
function originalUser(entry: EntryRecord): AgentMessage | undefined {
  const message = entry.kind === "camel.user" ? (entry.data as { message?: Extract<AgentMessage, { role: "user" }> } | undefined)?.message : undefined;
  return message && { ...message, content: message.content ?? entry.model?.[0]?.content } as AgentMessage;
}

/** The messages a journal entry adds to the agent's history: its native messages, as the host's history holds them. */
export function durableEntryMessages(entry: EntryRecord): DurableMessage[] {
  if (!nativeKinds.has(entry.kind)) return [];
  const original = originalUser(entry);
  const diagnostics = (entry.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics ?? [];
  // A call the node cut off (`restart_limit`: cut off too often to run again) may or may not have run.
  const uncertain = diagnostics.some(item => ["aborted", "interrupted", "abandoned", "restart_limit"].includes(item.code!));
  return (original ? [original] : entry.model ?? []).map((message, index) => ({
    message: structuredClone(message.role === "toolResult" && uncertain ? { ...message,
      content: [{ type: "text", text: `Tool ${message.toolName} was interrupted; its outcome is unknown and it may or may not have run.` }],
      isError: true } : message) as AgentMessage, cursor: { entryId: entry.id, index },
  })).filter(item => !(item.message.role === "toolResult" && (item.message.details as { inputRequired?: boolean } | undefined)?.inputRequired));
}

/** Whether Pi's journal holds a run that has not ended (`pi.live`'s run): one a close or a crash cut off, which Pi resumes. */
export async function piRunning(storage: Pick<Storage, "findDocument" | "document">, conversationId: ConversationId | number): Promise<boolean> {
  const record = await storage.findDocument({ kind: "pi.live", scope: { kind: "conversation", conversationId: conversationId as ConversationId } }, "current", context);
  return !!record && (await storage.document(record.id, "current", context))?.value?.run !== undefined;
}

async function latestDurableCursor(storage: Storage, conversationId: ConversationId): Promise<DurableCursor | undefined> {
  let cursor;
  do {
    const page = await storage.scanEntries({ conversationId, order: "descending" }, 64, cursor, context);
    for (const entry of page.items) if (nativeKinds.has(entry.kind) && entry.model?.length) {
      return { entryId: entry.id, index: entry.model.length - 1 };
    } else if (entry.kind === "camel.legacy.context" || entry.kind === "camel.context.message") {
      // This checkpoint supersedes the imported archive as the provider working
      // set. A session that has never run under Pi has no native message yet.
      return { entryId: entry.id, index: -1 };
    }
    cursor = page.next;
  } while (cursor !== undefined);
}

// Aggregators advertise larger Luna windows, but an upstream host may only serve the native window.
const isLuna = (model: { id: string }) => /(?:^|[/.])gpt-(?:(?:6|5\.6)-luna(?:-pro|-fast)?|luna-latest)(?::[a-z]+)?$/.test(model.id);
// Half the native window keeps learning useful below an aggregator's advertised million-token window.
const limitFloor = (model: { id: string; contextWindow: number }) => Math.max(32_768,
  Math.min(model.contextWindow, isLuna(model) ? 272_000 : Infinity) / 2);
const byteRefusal = (message: AssistantMessage) => /request_too_large|(?:^413\s|\b(?:status|HTTP)\s+413\b)|request (?:body |payload )?too large/i.test(message.errorMessage ?? "");

const summaryOf = (message: AssistantMessage) => {
  const text = message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim();
  return text || undefined;
};

/**
 * Pi's summary request (a system prompt, and a user message holding `<conversation>…</conversation>` and its prompt)
 * split into requests that each fit `window` with `maxTokens` to answer: each takes a part of the conversation, cut
 * between lines, after the summary of the parts before it. Undefined when the request fits as it is (or is not one).
 */
function summaryChunks(messages: Message[], window: number, maxTokens: number): ((before?: string) => Message[])[] | undefined {
  const [system, user] = messages;
  const text = user?.role === "user" && typeof user.content === "string" ? user.content : user?.role === "user" && Array.isArray(user.content) && user.content.length === 1 && user.content[0].type === "text" ? user.content[0].text : undefined;
  const match = text?.match(/^<conversation>\n([\s\S]*)\n<\/conversation>\n\n([\s\S]*)$/);
  if (messages.length !== 2 || !match || !Number.isFinite(window)) return undefined;
  const [, conversation, prompt] = match;
  const tokens = (value: string) => Math.ceil(value.length / 2.5);
  // Room for a part: the window less the answer, the prompts, and the summary carried in (bounded by the answer's size).
  const fixed = tokens(JSON.stringify(system)) + tokens(prompt) + 1_024;
  if (fixed + tokens(conversation) + maxTokens <= window && tokens(conversation) <= window / 2) return undefined;
  const room = Math.floor(Math.min(window / 2, window - maxTokens - fixed - Math.max(maxTokens, 1_000)) * 2.5);
  if (room < 4_000) throw new Error("Summarization failed: effective context window is too small");
  const parts: string[] = [];
  let part = "";
  for (const line of conversation.split("\n")) {
    for (let at = 0; at < Math.max(line.length, 1); at += room) {
      const piece = line.slice(at, at + room);
      if (part && part.length + piece.length + 1 > room) { parts.push(part); part = ""; }
      part = part ? `${part}\n${piece}` : piece;
    }
  }
  if (part) parts.push(part);
  return parts.map(content => (before?: string) => [system, { ...user, content: [{ type: "text", text:
    `${before === undefined ? "" : `<previous-summary>\n${before.slice(0, Math.floor(Math.max(maxTokens, 1_000) * 2.5))}\n</previous-summary>\n\nThe summary above covers the conversation before this part. Summarize both together.\n\n`}<conversation>\n${content}\n</conversation>\n\n${prompt}` }] } as Message]);
}

export async function recoverDurableMessages(storage: Pick<Storage, "scanEntries">, conversationId: ConversationId | number, after?: DurableCursor): Promise<DurableMessage[]> {
  const messages: DurableMessage[] = [];
  let cursor;
  do {
    const page = await storage.scanEntries({ conversationId: conversationId as ConversationId,
      ...(after ? { minEntryId: after.entryId as never } : {}), order: "ascending" }, 256, cursor, context);
    for (const entry of page.items) for (const item of durableEntryMessages(entry)) {
      if (!after || item.cursor.entryId > after.entryId || item.cursor.entryId === after.entryId && item.cursor.index > after.index) messages.push(item);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return messages;
}

/**
 * Agent event/policy boundary around Pi's durable Harness. Pi owns compaction;
 * credentials, tools and run limits remain host responsibilities.
 */
export class DurableAgent {
  readonly state: AgentState;
  readonly options: DurableAgentOptions;
  readonly listeners = new Set<Listener>();
  private harness!: Harness;
  private conversation!: Conversation;
  private registry = createRegistry();
  private _messages: AgentMessage[] = [];
  /** The system section keys the native `camel` extension renders, in order: reinstalled when they change. */
  private sectionKeys?: string;
  private tools: AgentTool[];
  private controller?: AbortController;
  private running?: Promise<void>;
  private events = Promise.resolve();
  private eventError?: unknown;
  private pending = new Set<string>();
  /**
   * Steers not given to Pi yet: one goes to Pi's inbox as a tool round ends, which places it at that boundary, or starts
   * the next run after an answer; a run starts with all of them after its input. Never left in Pi's inbox, where an abort
   * would withdraw it and keep its request id.
   */
  private queued: AgentMessage[] = [];
  /** Steers only for the run they were given in (`steer(message, true)`): dropped when it ends without taking them. */
  private runOnly = new WeakSet<AgentMessage>();
  private originalInputs = new Map<number, { native: Message; message: AgentMessage }>();
  private _latestCursor?: DurableCursor;
  private streamingMessage?: AgentMessage;
  /**
   * The context a provider refused as too long (a context overflow), in tokens: the real limit is below it, whatever the
   * model's declared window. Pi's compaction scales its reserve and the recent context it keeps from the window, so
   * after an overflow it compacts against this, as the legacy compactor kept about a fifth of the context.
   */
  private overflowWindow = Infinity;
  private sentTokens = 0;
  /** Where Pi compacts before a request: the window less its reserve (set in `create`). */
  private compactAt = () => Infinity;
  /** `compactLanded`'s last measure of the context plus what landed since (none: measure again), and when it may next start a compaction after one failed. */
  private landedTokens?: number;
  private landedRetryAt = 0;
  /** Whether this run has started a compaction for a request that sent less than Pi holds (`compactSoon`). */
  private compactedShort = false;
  private heldTokenEstimates = new WeakMap<Message, number>();
  get contextTokens() { return { sent: this.sentTokens, window: Math.min(this.state.model.contextWindow, this.options.durable.contextWindow ?? Infinity, this.overflowWindow) }; }
  private errorMessage?: string;
  private lastTurn?: AssistantMessage;
  private lastTurnResults: ToolResultMessage[] = [];
  private stoppedByFinishTurn = false;
  private closed = false;
  private closing?: Promise<void>;

  private get messages() { return this._messages; }
  /** Pi's context as the agent last read it, with the run's messages since; a change of its system section keys reinstalls the `camel` extension's sections. */
  private set messages(value: AgentMessage[]) {
    this._messages = value;
    if (this.sectionKeys !== undefined && JSON.stringify(Object.keys(this.sections())) !== this.sectionKeys) this.installTools();
  }
  /**
   * The host's system sections as its working set holds them (hosts write their own system messages), or as its
   * configuration makes them where the working set shows none. Pi renders the section `instructions` itself, from a
   * conversation's instructions, so a host's own section of that name (an older one, which the host declares again under
   * a key of its own) is not rendered here.
   */
  private sections(): Record<string, string> {
    return Object.fromEntries(Object.entries(getCurrentSystemMessage(this._messages)?.sections ?? this.leading()?.sections ?? {})
      .filter((entry): entry is [string, string] => entry[1] !== null && entry[0] !== "instructions"));
  }

  private constructor(options: DurableAgentOptions) {
    this.options = options;
    this.tools = [...options.initialState?.tools ?? []];
    const self = this;
    this.state = {
      model: options.initialState!.model!, thinkingLevel: options.initialState?.thinkingLevel ?? "off",
      // Pi's context: the host changes it through the journal (its own entries, edits and system messages), not here.
      get messages() { return self.messages; },
      set messages(_value) { throw new Error("Pi's context changes through its journal: replaceContext, or the host's own entries"); },
      get tools() { return self.tools; }, set tools(value) { self.tools = [...value]; self.installTools(); },
      get systemPrompt() { const system = self.messages.findLast(message => message.role === "system"); return system ? getSystemMessageText(system) : ""; },
      get isStreaming() { return self.controller !== undefined; },
      get streamingMessage() { return self.streamingMessage; }, get pendingToolCalls() { return self.pending; },
      get errorMessage() { return self.errorMessage; },
    };
  }

  static async create(options: DurableAgentOptions): Promise<DurableAgent> {
    const agent = new DurableAgent(options);
    agent.installTools();
    // Pi's generation task with one change: preparation does not take a context checkpoint (`camel.legacy.context`) for a
    // head marker.
    const original = GenerationTask.definition;
    const task = { definition: { ...original, phases: { ...original.phases,
      prepare: async (...args: Parameters<typeof original.phases.prepare>) => {
        const [record, runtime, taskContext] = args;
        const prepared = new Proxy(runtime, { get(target, key) {
          if (key === "context") return async (...params: Parameters<typeof runtime.context>) => {
            const current = await target.context(...params);
            return current.head?.kind === "camel.legacy.context" ? { ...current, head: undefined } : current;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
        return original.phases.prepare(record, prepared, taskContext);
      },
    } } };
    const registry: RegistryReader = {
      subscribe: listener => agent.registry.subscribe(listener),
      snapshot: () => {
        const snapshot = agent.registry.snapshot();
        return new Proxy(snapshot, { get(target, key) {
          if (key === "task") return (name: string) => name === original.name ? task : target.task(name);
          if (key === "tasks") return () => target.tasks().map(item => item.definition.name === original.name ? task : item);
          const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
        } }) as RegistrySnapshot;
      },
    };
    // Generation and summarization use the same credential resolver, network
    // policy and provider instrumentation. Summaries omit run-only output settings.
    const models = {
      getModel: () => ({ ...agent.state.model, contextWindow: window() }),
      // Pi 1.4 wraps the host's Models to add its request identity and binds `getAuth` while wrapping. Credentials come
      // from the host's own resolver (getApiKey), so nothing in Pi should ask this object for them.
      getAuth: () => { throw new Error("camelRun resolves model credentials itself"); },
      streamSimple: (_model: unknown, view: { messages: Message[] }, streamOptions: unknown) => agent.stream(streamOptions, view.messages),
      completeSimple: async (_model: unknown, view: { messages: Message[] }, streamOptions: unknown) => {
        await agent.flushEvents();
        const apiKey = await options.getApiKey?.(agent.state.model.provider);
        const summarize = async (messages: Message[]) => {
          const output = (streamOptions as { maxTokens?: number } | undefined)?.maxTokens ?? 0;
          if (messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + output + 512 > window())
            throw new Error("Summarization failed: request exceeds the effective context window");
          const events = await (options.durable.summaryStream ?? options.streamFn)(agent.state.model, { ...view, messages } as never,
            { ...(streamOptions as object), apiKey } as never);
          const result = await events.result();
          await agent.conversation.commit(tx => tx.appendEntry(agent.conversation.id, {
            kind: "camel.compaction.usage", data: { message: result } as never,
          }), context);
          await options.durable.onSummary?.(result);
          return result;
        };
        // Pi asks for one summary of the whole prefix. One larger than the window (an imported history, a model whose
        // window is small) is summarized in parts that fit, each carrying the summary so far, as the legacy compactor did.
        const chunks = summaryChunks(view.messages, window(), (streamOptions as { maxTokens?: number } | undefined)?.maxTokens ?? 0);
        if (!chunks) return summarize(view.messages);
        let summary: AssistantMessage | undefined;
        for (const chunk of chunks) {
          const before = summary && summaryOf(summary);
          if (summary && before === undefined) return summary;
          summary = await summarize(chunk(before));
          if (summary.stopReason !== "stop") return summary;
        }
        return summary!;
      },
    };
    const window = () => Math.min(agent.state.model.contextWindow, options.durable.contextWindow ?? Infinity, agent.overflowWindow);
    const reserve = () => {
      // The output the provider sets aside from the window, plus a margin for the chars/4 estimate.
      const limit = agent.state.model.maxTokens || Infinity, output = Math.min(options.durable.maxOutputTokens ?? limit, limit);
      return Math.min(Math.floor(window() * 0.15), (Number.isFinite(output) ? output : 0) + 16_384);
    };
    agent.compactAt = () => window() - reserve();
    // The host gives the agent up (and reopens it from what was committed) once, whichever failure says so first.
    let givenUp = false;
    const giveUp = (error: unknown) => { if (!givenUp) { givenUp = true; options.durable.onStorageFailure?.(error); } };
    agent.harness = await Harness.open(options.durable.storage, { registry, models: models as unknown as HarnessOptions["models"],
      // Pi 1.4 attributes every request to pi by default (OpenRouter `HTTP-Referer: https://pi.dev` and
      // `X-OpenRouter-Title: pi`, NVIDIA and OpenCode origin headers): requests are the tenant's, so send none.
      identity: { attribution: null },
      // What Pi contains rather than throws (a faulted phase, a throwing hook or section, a dropped progress commit) is
      // otherwise silent.
      // A task cut off `restartLimit` times in a row ends (`task_interrupted`, reason `restart_limit`; a generation ends
      // its run with `runFailure`), and so does a run whose model request a lost node left in flight (reason `interrupted`).
      onReport: (report: Report) => {
        if (report.kind === "storage_failed") giveUp(report.error);
        const task = "task" in report ? report.task : undefined;
        console.error(JSON.stringify({ type: "pi_report", report: report.kind,
          ...task ? { task: task.kind, taskId: task.id } : {}, ..."reason" in report ? { reason: report.reason } : {},
          error: report.error instanceof Error ? report.error.message : String(report.error) }));
      },
      settings: { compaction: { enabled: true,
        get reserveTokens() { return reserve(); },
        // The recent context a summary keeps, but never so much that what is fixed (the system prompt) and it fill the
        // window again within a quarter of it: then every turn would be summarized again (the legacy compactor waited
        // for that quarter too).
        get keepRecentTokens() {
          const limit = window(), reserved = reserve();
          const system = agent.messages.findLast(message => message.role === "system") ?? agent.leading();
          const fixed = system ? Math.ceil(JSON.stringify(system).length / 4) : 0;
          return Math.max(1_000, Math.min(20_000, Math.floor(limit * 0.25), limit - reserved - fixed - Math.floor(limit / 4)));
        }, backgroundTokens: 0 },
        // Live answers and tool output stream to the host from the provider and the tool, not from these commits:
        // they only bound what a lost node's run keeps, so each costs a journal write once a second, not every 100 ms.
        // Pi defers storing them by up to `persistWithinMs` (default 1 s); 0 stores each right after its commit, as before.
        progress: { partialIntervalMs: 1_000, outputIntervalMs: 1_000, persistWithinMs: 0 },
        retry: { enabled: false, keepRetried: false }, toolExecution: options.toolExecution ?? "parallel",
        steeringMode: options.steeringMode ?? "one-at-a-time", contextRetentionMs: 0 },
    }, context);
    agent.conversation = options.durable.conversationId === undefined ? await agent.harness.root(context) :
      (await agent.harness.conversation(options.durable.conversationId as ConversationId, context))!;
    if (!agent.conversation) throw new Error("Pi durable conversation does not exist");
    const limit = await agent.harness.snapshot(ContextLimitDoc, agent.conversation.id, context);
    if (limit?.provider === agent.state.model.provider && limit.model === agent.state.model.id && Number.isFinite(limit.window) && limit.window > 0)
      agent.overflowWindow = Math.max(limit.window, limitFloor(agent.state.model));
    // Pi detaches an observer that throws (ending it `listener_error`), and ends it `failed` when the Session fails. Either
    // way the agent no longer sees what is committed (it would go stale, and a turn could end on an older answer): the
    // host gives it up and reopens it, as after a storage failure. An error here is caught, so the commit it missed does
    // not go unnoticed either.
    const observerFailed = (error: unknown) => {
      console.error(JSON.stringify({ type: "pi_observer_error", error: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error) }));
      giveUp(error);
    };
    agent.harness.observeCommits({ end: end => {
      if (end.kind === "listener_error") observerFailed(end.error);
      else if (end.kind === "failed") giveUp(end.error);
    }, advance: publication => { try {
      // A generation that ended without an answer fails the run: one that failed, and one whose phase threw (faulted) or
      // that no installed definition could take (orphaned), which would otherwise end the run as if it had answered.
      for (const change of publication.changes) if (change.type === "task" && change.value.kind === original.name && change.value.state.status === "terminal") {
        const outcome = change.value.state.outcome;
        if (outcome.status === "failed" || outcome.status === "faulted") agent.errorMessage = outcome.error.message;
        else if (outcome.status === "orphaned") agent.errorMessage = `Pi generation was orphaned: ${outcome.reason}`;
      }
      const entries = publication.changes.filter(change => change.type === "entry" && change.value.conversationId === agent.conversation.id)
        .sort((a, b) => (a as { value: EntryRecord }).value.id - (b as { value: EntryRecord }).value.id);
      for (const change of entries) if (change.type === "entry") {
        const entry = change.value;
        if (entry.kind === "camel.user" && entry.model?.[0]?.role === "user") {
          const original = originalUser(entry);
          if (original) agent.originalInputs.set(entry.id, { native: entry.model[0], message: original });
        }
        if (nativeKinds.has(entry.kind) && entry.model?.length) agent.advanceCursor({ entryId: entry.id, index: entry.model.length - 1 });
        if (entry.kind === "pi.compaction") agent.queueEvent(() => agent.adoptCompaction(entry));
        const items = durableEntryMessages(entry);
        // A waiting tool's placeholder is streamed but never enters Camel's
        // history projection. Recovery therefore omits it while live listeners
        // still receive the tool's input-required outcome.
        for (const [index, message] of (entry.model ?? []).entries()) if (message.role === "toolResult" && (message.details as { inputRequired?: boolean } | undefined)?.inputRequired) {
          items.push({ message: structuredClone(message) as AgentMessage, cursor: { entryId: entry.id, index } });
        }
        for (const item of items) agent.queueEvent(() => agent.committedMessage(item));
      }
    } catch (error) { observerFailed(error); } } });
    await agent.reload();
    agent._latestCursor = options.durable.cursor ?? await latestDurableCursor(options.durable.storage, agent.conversation.id);
    return agent;
  }

  /**
   * Tell the host of a compaction: its summary, and how many history messages it keeps. The host has taken in the
   * messages up to the compaction entry and none after it (their events queue behind this one), so the count is of the
   * context as the compaction left it: entries committed since (inputs a boundary placed with the summary, a later
   * turn) are not counted.
   */
  private async adoptCompaction(entry: EntryRecord) {
    const view = await this.conversation.context(context, { at: entry.id });
    const retained = new Set(view.entries.map(entry => entry.id));
    for (const id of this.originalInputs.keys()) if (id < entry.id && !retained.has(id as never)) this.originalInputs.delete(id);
    // Counted as the host's history holds them: never a waiting tool's input-required placeholder (durableEntryMessages).
    const keptMessages = view.contributions.reduce((count, messages, index) => count +
      (view.entries[index].id === view.head?.id ? 0 : messages.filter(message => message.role !== "system" &&
        !(message.role === "toolResult" && (message.details as { inputRequired?: boolean } | undefined)?.inputRequired)).length), 0);
    let summary = (entry.model ?? []).map(message => typeof message.content === "string" ? message.content :
      message.content.filter(part => part.type === "text").map(part => part.text).join("\n")).join("\n");
    if (summary.startsWith(COMPACTION_SUMMARY_PREFIX) && summary.endsWith(COMPACTION_SUMMARY_SUFFIX)) {
      summary = summary.slice(COMPACTION_SUMMARY_PREFIX.length, -COMPACTION_SUMMARY_SUFFIX.length);
    }
    const reason = (entry.data as { reason?: string } | undefined)?.reason === "overflow" ? "overflow" : "threshold";
    await this.options.durable.onCompaction?.({ summary, keptMessages, at: entry.model?.[0]?.timestamp ?? Date.now(), reason });
  }

  get signal() { return this.controller?.signal; }
  /** The host's system message as its configuration makes it (`DurableAgentOptions.durable.leading`). */
  private leading() { return this.options.durable.leading?.() as (AgentMessage & { role: "system" }) | undefined; }

  /**
   * Read Pi's context again: what a run starts from, after the host wrote to the journal (its own messages, a
   * retraction's edit, a system message) or Pi settled an interrupted run.
   */
  async reload() {
    const view = await this.conversation.context(context);
    for (const entry of view.entries) if (entry.kind === "camel.user" && entry.model?.[0]?.role === "user" && !this.originalInputs.has(entry.id)) {
      const original = originalUser(entry);
      if (original) this.originalInputs.set(entry.id, { native: entry.model[0], message: original });
    }
    this.messages = this.originals(view.messages as Message[]);
  }
  get latestCursor() { return this._latestCursor; }
  get conversationId() { return this.conversation.id; }
  subscribe(listener: Listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private async emit(event: AgentEvent & { durable?: DurableCursor }) {
    if (this.closed) return;
    for (const listener of this.listeners) await listener(event, this.signal ?? new AbortController().signal);
  }
  private queueEvent(action: () => Promise<void>) {
    this.events = this.events.then(action).catch(error => { this.eventError = error; this.abort(); });
  }
  private async flushEvents() { await this.events; if (this.eventError) throw this.eventError; }
  private advanceCursor(cursor: DurableCursor) {
    if (!this._latestCursor || cursor.entryId > this._latestCursor.entryId || cursor.entryId === this._latestCursor.entryId && cursor.index > this._latestCursor.index) this._latestCursor = cursor;
  }

  private async committedMessage({ message, cursor }: DurableMessage) {
    this.advanceCursor(cursor);
    this.messages.push(message);
    if (message.role === "assistant") {
      this.lastTurn = message; this.lastTurnResults = [];
      // A later response of the run (one made after an overflow's compaction) answers what an earlier one failed.
      this.errorMessage = message.stopReason === "error" || message.stopReason === "aborted" ? message.errorMessage : undefined;
    }
    if (message.role === "toolResult") {
      this.pending.delete(message.toolCallId); this.lastTurnResults.push(message);
      await this.emit({ type: "tool_execution_end", toolCallId: message.toolCallId, toolName: message.toolName,
        result: { content: message.content, details: message.details, isError: message.isError, usage: message.usage }, isError: message.isError,
        ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }) });
    }
    // The assistant's start/deltas come directly from the provider; other starts
    // accompany their committed message so a failed WAL write exposes no result.
    if (message.role !== "assistant") await this.emit({ type: "message_start", message });
    await this.emit({ type: "message_end", message, durable: cursor });
    this.streamingMessage = undefined;
  }

  private stream(rawOptions: unknown, nativeMessages?: Message[]) {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      await this.flushEvents();
      // The request stops when the run is aborted, and also when Pi ends the generation's invocation itself: an abort
      // mark, a close, or a failed storage (whose Session fails and signals its running tasks).
      const own = this.signal, native = (rawOptions as { signal?: AbortSignal } | undefined)?.signal;
      const signal = own && native ? AbortSignal.any([own, native]) : own ?? native;
      signal?.throwIfAborted();
      await this.emit({ type: "turn_start" });
      // Immutable Pi messages: reuse estimates by identity. The estimator reads string lengths (images have a
      // fixed token estimate); only new assistant tool arguments/system tool schemas need JSON serialization.
      // Do this before originals and hydration so hidden history remains visible to telemetry.
      let held = 0;
      if (this.options.durable.onContextRequest) for (const message of nativeMessages ?? this.messages as Message[]) {
        let tokens = this.heldTokenEstimates.get(message);
        if (tokens === undefined) {
          tokens = estimateMessageTokens(message);
          this.heldTokenEstimates.set(message, tokens);
        }
        held += tokens;
      }
      let messages = this.messages;
      // Preserve Camel's original input metadata (sender, file refs) while Pi
      // supplies its bounded model context, including the persisted summary.
      if (nativeMessages) messages = this.originals(nativeMessages);
      // Pi's working context already excludes archived bodies.
      this.messages = [...messages];
      const prepared = await this.options.prepareRequest?.({ context: { messages, tools: this.tools }, model: this.state.model,
        thinkingLevel: this.state.thinkingLevel }, signal);
      if (prepared?.context) messages = prepared.context.messages;
      if (prepared?.model) this.state.model = prepared.model;
      if (prepared?.thinkingLevel) this.state.thinkingLevel = prepared.thinkingLevel;
      const llm = await (this.options.convertToLlm?.(messages) ?? messages as Message[]);
      const apiKey = await this.options.getApiKey?.(this.state.model.provider);
      const events = await this.options.streamFn(this.state.model, { messages: llm } as never, {
        ...(rawOptions as object), signal, apiKey, reasoning: this.state.thinkingLevel === "off" ? undefined : this.state.thinkingLevel,
        sessionId: this.options.sessionId, onPayload: this.options.onPayload, onResponse: this.options.onResponse,
        onProviderStreamEvent: this.options.onProviderStreamEvent,
      });
      const sent = this.sentTokens = llm.reduce((tokens, message) => tokens + estimateMessageTokens(message), 0);
      this.options.durable.onContextRequest?.(held, sent);
      // An upstream may have dropped an over-native-window Luna prompt. Recover now; require repeat evidence to learn it.
      let inferred = false;
      const overflow = (message: AssistantMessage) => {
        if (message.stopReason === "error" && !isContextOverflow(message) && !byteRefusal(message) && isLuna(this.state.model) && sent > 272_000 && message.usage.output === 0 &&
          /server_error|stream ended before a terminal response event|Network connection lost/i.test(message.errorMessage ?? "")) {
          inferred = true;
          // Pi recognizes explicit context errors. Keep the provider's explanation after that prefix.
          message.errorMessage = `maximum context length exceeded: ${message.errorMessage}`;
        }
        return isContextOverflow(message);
      };
      let overflowEvent: import("@earendil-works/pi-ai").AssistantMessageEvent | undefined;
      for await (const event of events) {
        if (event.type === "start") {
          this.streamingMessage = event.partial;
          await this.emit({ type: "message_start", message: event.partial });
        } else if (event.type !== "done" && event.type !== "error") {
          this.streamingMessage = event.partial;
          await this.emit({ type: "message_update", message: event.partial, assistantMessageEvent: event });
        }
        // Pi may act on the terminal event before result() resolves. Persist its smaller window first.
        if (event.type === "error" && overflow(event.error)) overflowEvent = event;
        else stream.push(event);
      }
      const final = await events.result();
      if (final.stopReason === "error" && overflow(final) && !byteRefusal(final)) {
        const window = Math.max(limitFloor(this.state.model), Math.floor(Math.min(sent, inferred ? 272_000 : Infinity, this.overflowWindow, this.state.model.contextWindow, this.options.durable.contextWindow ?? Infinity) * 0.9));
        if (inferred || window < this.overflowWindow) {
          // Optional learning uses its own session: a failed write must not poison Pi's running session.
          const storage = this.options.durable.storage;
          const learning = createSession(new Proxy(storage, { get(target, key) {
            if (key === "close") return async () => {};
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          } }));
          try {
            await learning.commit(async tx => {
              if (inferred) {
                const evidence = await tx.doc(InferredOverflowDoc, this.conversation.id);
                const now = Date.now();
                const repeated = evidence.provider === this.state.model.provider && evidence.model === this.state.model.id &&
                  evidence.at > 0 && now >= evidence.at && now - evidence.at <= 24 * 60 * 60 * 1_000;
                Object.assign(evidence, { provider: this.state.model.provider, model: this.state.model.id, at: now });
                if (!repeated) return;
              }
              Object.assign(await tx.doc(ContextLimitDoc, this.conversation.id), { provider: this.state.model.provider, model: this.state.model.id, window });
            }, context);
          } catch {
            // Still deliver the provider overflow so Pi can compact it.
          } finally { await learning.close(context); }
          this.overflowWindow = window;
        }
      }
      // Pi commits an aborted response from its last throttled partial (`convertPartial`), which may be stale or
      // missing: the provider's own terminal message, with its usage and billing attempt, replaces it before Pi's
      // abort handler converts it, so the canceled response is in history and billed exactly once.
      // Only for the run's own abort: a request the runtime cut (a stale lease) is classified by Pi and made again.
      if (final.stopReason === "aborted" && own?.aborted) await this.conversation.commit(async tx => {
        const live = await tx.doc(LiveDoc, this.conversation.id);
        if (live.generation) live.generation.message = JSON.parse(JSON.stringify(final));
      }, context).catch(error => console.error(JSON.stringify({ type: "pi_aborted_response_write_failed", error: error instanceof Error ? error.message : String(error) })));
      if (overflowEvent) stream.push(overflowEvent);
      stream.end(final);
    })().catch(error => {
      const message = { role: "assistant", content: [], api: this.state.model.api, provider: this.state.model.provider,
        model: this.state.model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: this.signal?.aborted ? "aborted" : "error",
        errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now() } as AssistantMessage;
      stream.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message }); stream.end(message);
    });
    return stream;
  }

  /** Pi's context with each submitted input replaced by Camel's original message. */
  private originals(nativeMessages: Message[]): AgentMessage[] {
    const originals = new Map<string, AgentMessage[]>();
    for (const item of this.originalInputs.values()) {
      const key = JSON.stringify(item.native), queue = originals.get(key) ?? [];
      queue.push(item.message); originals.set(key, queue);
    }
    return nativeMessages.map(message => message.role === "user" ? originals.get(JSON.stringify(message))?.shift() ?? message : message) as AgentMessage[];
  }

  /**
   * The `camel` extension: the host's tools, and its system sections as native sections. Pi plans the system entries
   * of each request from the sections its extensions render, and sets a shown section none renders to null. Each
   * renders what the context shows for it, or, where the context shows none (the baseline after a compaction), the
   * working set's: the host, not Pi, decides what they say.
   */
  private installTools() {
    const keys = Object.keys(this.sections());
    this.sectionKeys = JSON.stringify(keys);
    this.registry.install({ name: "camel", sections: keys.map(key => section(key, input =>
      Object.keys(input.shown).length ? input.shown[key] : this.sections()[key], { tag: false })), tools: this.tools.map(tool => ({ ...tool, replay: tool.replay === "safe" ? "safe" : "unsafe",
      structuredOutputSchema: tool.outputSchema,
      // Camel already bounds tool output; a second truncation changes persisted replies.
      outputLimits: { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER },
      execute: async (args: any, api: any, callContext: any): Promise<any> => {
        await this.flushEvents();
        const id = api.callId as string;
        this.pending.add(id);
        await this.emit({ type: "tool_execution_start", toolCallId: id, toolName: tool.name, args });
        let result: AgentToolResult;
        try {
          result = await tool.execute(id, args, callContext.abortSignal, partialResult => {
            this.queueEvent(() => this.emit({ type: "tool_execution_update", toolCallId: id, toolName: tool.name, args, partialResult }));
          });
        } catch (error) { result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true }; }
        return { output: result.content, ...(result.details === undefined ? {} : { details: result.details }), isError: result.isError,
          ...(result.structuredContent === undefined || !tool.outputSchema ? {} : { structuredOutput: result.structuredContent }),
          ...(result.usage === undefined ? {} : { usage: result.usage }), ...(result.terminate ? { control: { terminate: true } } : {}) };
      },
    })), hooks: [hook(GenerationTask, {
      beforeRetry: failed => this.options.durable.beforeRetry?.(failed),
      // The end of a tool round: the host decides whether the run ends there (`finishTurn`: a call waiting for input,
      // final_output, a run or spend limit); otherwise the next steer goes in at this boundary.
      // A decision that fails ends the run with its error (Pi would only report a throwing hook).
      afterTools: async () => {
        try {
          await this.flushEvents();
          if (await this.endTurn()) return { end: true };
          await this.submitSteer();
          return undefined;
        } catch (error) {
          this.errorMessage = error instanceof Error ? error.message : String(error);
          return { end: true };
        }
      },
    })] });
  }

  /**
   * The turn that just ended (its response and the round's results, in call order) as the host decides on it
   * (`finishTurn`), then told as `turn_end`: whether the host ends the run.
   */
  private async endTurn() {
    const message = this.lastTurn;
    if (!message) return false;
    this.lastTurn = undefined;
    const calls = message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []);
    const toolResults = [...this.lastTurnResults].sort((a, b) => calls.indexOf(a.toolCallId) - calls.indexOf(b.toolCallId));
    const decision = await this.options.finishTurn?.({ message, toolResults, context: { messages: this.messages, tools: this.tools }, newMessages: this.messages }, this.signal);
    await this.emit({ type: "turn_end", message, toolResults });
    if (decision?.action === "end") this.stoppedByFinishTurn = true;
    return decision?.action === "end";
  }

  async recoverMessages(after?: DurableCursor) { return recoverDurableMessages(this.options.durable.storage, this.conversation.id, after); }

  /** Abort handlers settle unknown work; opening itself never dispatches a task. */
  async discardInterruptedRun() {
    const listeners = [...this.listeners]; this.listeners.clear();
    await this.conversation.abort(context);
    await this.flushEvents();
    this.lastTurn = undefined; this.lastTurnResults = []; this.errorMessage = undefined;
    for (const listener of listeners) this.listeners.add(listener);
    await this.reload();
    return this._latestCursor;
  }

  async syncContext() {
    await this.conversation.configure({ model: { provider: this.state.model.provider, modelId: this.state.model.id },
      thinkingLevel: this.state.thinkingLevel, instructions: null }, context);
    await this.reload();
  }

  /**
   * Replace Pi's context with `messages` from here on (a checkpoint: a head entry with the first message, then one entry
   * per message, so Pi can choose a compaction cut between them): an agent with no history yet whose configuration
   * changes rebuilds its leading system message, the provider's cached prefix.
   */
  async replaceContext(messages: AgentMessage[]) {
    await this.checkpointContext(messages);
    this.messages = [...messages];
  }

  private async checkpointContext(messages: AgentMessage[]) {
    const model = contextMessages(messages);
    await this.conversation.commit(async tx => {
      // Keep message boundaries: Pi cannot select a compaction cut inside one
      // entry containing the whole previous conversation.
      await tx.appendEntry(this.conversation.id, {
        kind: "camel.legacy.context", head: "self", model: structuredClone(model.slice(0, 1)) as never,
      });
      for (const message of model.slice(1)) await tx.appendEntry(this.conversation.id, {
        kind: "camel.context.message", model: [structuredClone(message)] as never,
      });
    }, context);
    this.originalInputs.clear();
  }

  /** Before a run takes input, steers wait for it; while it runs, they go to Pi's inbox, placed at its next boundary. */
  steer(message: AgentMessage, runOnly = false) { if (runOnly) this.runOnly.add(message); this.queued.push(message); }
  /** Drop the steers given only for the run that ended (`steer(message, true)`) that it did not take. */
  dropRunSteers() { this.queued = this.queued.filter(message => !this.runOnly.has(message)); }
  clearSteeringQueue() { this.queued = []; }
  hasQueuedMessages() { return this.queued.length > 0; }
  /** The next steer as Pi input (`whenBusy: "steer"`): placed at the running round's boundary, or starting a run. */
  private async submitSteer() {
    const message = this.queued.shift();
    if (message) await this.submitMessage(message, "steer", (message as { requestId?: string }).requestId);
  }
  abort() { if (this.controller) { this.errorMessage ??= "Agent run aborted"; this.controller.abort(); void this.conversation.abort(context).catch(() => {}); } }
  close(timeoutMs = 5_000): Promise<void> {
    if (this.closing) return this.closing;
    // No abort: a run left running stays Pi's, and the next owner's Pi goes on with it (a close is not a crash: a request it
    // cut is made again, a tool phase runs again from its top).
    this.closed = true;
    // close() seals the native mutation line synchronously. Awaiting idle first
    // lets a tool that ignores cancellation keep that line alive forever.
    let nativeError: unknown;
    const native = this.harness.close(context).catch(error => { nativeError = error; });
    const settling = Promise.allSettled([native, this.running]);
    this.closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([settling.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
        if (!settled) await this.options.durable.storage.close(context);
        if (nativeError) throw nativeError;
      } finally { if (timer) clearTimeout(timer); }
    })();
    return this.closing;
  }

  /**
   * A user message as Pi input (`steer`: placed now, starting a run, or at the busy run's next boundary), or `write`: an
   * entry placed now, for a run's input before its last message. `requestId` only on the first message of a request: Pi
   * takes a request's later submissions for its first.
   */
  private async submitMessage(message: AgentMessage, mode: "steer" | "write", requestId: string | undefined) {
    if (message.role !== "user") {
      await this.conversation.commit(tx => tx.appendEntry(this.conversation.id, { kind: "camel.message", model: [message] as never }), context);
      return undefined;
    }
    const content = message.content;
    const entry = { kind: "camel.user", data: { message } as never };
    return this.conversation.submit({ ...(requestId ? { requestId } : {}), ...mode === "steer" ? { type: "input", content: content as never, whenBusy: "steer", entry }
      : { type: "write", entry: { ...entry, model: [{ role: "user", content, timestamp: Date.now() }] as never } } }, context);
  }

  prompt(message: AgentMessage | AgentMessage[] | string, images: ImageContent[] = []): Promise<void> {
    const messages = typeof message === "string" ? [{ role: "user", content: images.length ? [{ type: "text", text: message }, ...images] : message, timestamp: Date.now() } as AgentMessage] : Array.isArray(message) ? message : [message];
    return this.run(messages);
  }
  async compact(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const task = await this.conversation.compact(undefined, context);
    const abort = () => { void this.conversation.abort(context).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let result;
    try { result = await this.harness.waitForTask(task, context); }
    finally { signal?.removeEventListener("abort", abort); }
    signal?.throwIfAborted();
    if (result.state.outcome.status !== "completed") throw new Error("Context compaction failed");
    await this.flushEvents();
    await this.reload();
  }
  /**
   * Pi checks its threshold only as it prepares a request: messages that land without a turn (`landed`) get the same
   * check here, and past it Pi's own compaction, unless one is listed (then restarted, if a closed host left it). The
   * context is read only once the last measure plus what landed since crosses the threshold, and only if `fits` (the
   * range's size, without reading it). Resolves once the compaction is started, not once it has summarized.
   */
  async compactLanded(landed: AgentMessage[], fits: () => Promise<boolean>) {
    const live = await this.harness.snapshot(LiveDoc, this.conversation.id, context);
    if (live?.compactions) return this.harness.resume();
    if (live?.run !== undefined || Date.now() < this.landedRetryAt) return;
    if (this.landedTokens !== undefined) this.landedTokens += landed.reduce((sum, message) => sum + estimateMessageTokens(message as Message), 0);
    if (this.landedTokens !== undefined && this.landedTokens <= this.compactAt() || !await fits()) return;
    this.landedTokens = estimateContextTokens((await this.conversation.context(context)).messages).tokens;
    if (this.landedTokens <= this.compactAt()) return;
    this.landedTokens = undefined;
    // Its summarizer is the model a run configures, which an agent that has had no run yet lacks.
    await this.syncContext();
    const task = await this.conversation.compact(undefined, context);
    // A summarizer that fails (a bad key, a refused payment) is not asked again on every landing.
    void this.harness.waitForTask(task, context).then(settled => { if (settled.state.outcome.status !== "completed") this.landedRetryAt = Date.now() + 300_000; }, () => {});
  }
  /**
   * A request sent less than Pi's context (older images left out of it): Pi reads its usage as the size of the whole
   * context, so it would not compact what it holds. Pi's compaction starts in the background instead, once a run, unless
   * one is listed; its summary is placed at the next boundary.
   */
  compactSoon() {
    if (this.compactedShort) return;
    this.compactedShort = true;
    void (async () => {
      if ((await this.harness.snapshot(LiveDoc, this.conversation.id, context))?.compactions) return;
      await this.conversation.compact(undefined, context);
    })().catch(error => console.error(JSON.stringify({ type: "compaction_start_failed", error: error instanceof Error ? error.message : String(error) })));
  }
  continue(): Promise<void> { return this.run([]); }
  private run(messages: AgentMessage[]) {
    if (this.closed) return Promise.reject(new Error("Agent is closed"));
    if (this.running) return Promise.reject(new Error("Agent is already processing"));
    this.controller = new AbortController(); this.errorMessage = undefined; this.eventError = undefined; this.stoppedByFinishTurn = false; this.compactedShort = false;
    this.running = this.runInner(messages).finally(() => { this.controller = undefined; this.running = undefined; });
    return this.running;
  }
  private async runInner(messages: AgentMessage[]) {
    await this.emit({ type: "agent_start" });
    // Messages the host wrote into the journal itself since the last run are not this run's.
    const written = this.options.durable.written?.();
    if (written) this.advanceCursor(written);
    let start = this._latestCursor;
    try {
      // A run starts on the summary of a compaction `compactLanded` started, rather than compacting the same context again.
      for (const { taskId } of (await this.harness.snapshot(LiveDoc, this.conversation.id, context))?.compactions ?? []) await this.harness.waitForTask(taskId, context);
      if (this.signal?.aborted) return;
      this.landedTokens = undefined;
      await this.syncContext();
      // Brand-new sessions have no native cursor. Start at the context marker,
      // rather than scanning a potentially huge imported archive at agent_end.
      start ??= await latestDurableCursor(this.options.durable.storage, this.conversation.id);
      // The run's input with the steers that waited for it, in one context before the first model request: each placed now,
      // the last as the input that starts the run.
      const input = [...messages, ...this.queued.splice(0)], requests = new Set<string>();
      for (const [index, message] of input.entries()) {
        const requestId = (message as { requestId?: string }).requestId;
        await this.submitMessage(message, index < input.length - 1 ? "write" : "steer", requestId && !requests.has(requestId) ? requestId : undefined);
        if (requestId) requests.add(requestId);
      }
      if (!input.length) {
        const live = await this.harness.snapshot(LiveDoc, this.conversation.id, context);
        // Idle is `run === undefined`: after a run that ended without an answer `pi.live` is not empty (`runFailure`). A
        // continue runs on the context as it is; one that ends in an answer has nothing to answer (`nothing_to_answer`).
        if (live?.run === undefined) await this.conversation.submit({ type: "continue" }, context);
        this.harness.resume();
      }
      while (true) {
        await this.conversation.waitForIdle(context);
        await this.flushEvents();
        await this.endTurn();
        if (this.signal?.aborted || this.stoppedByFinishTurn || !this.queued.length) break;
        // A steer given as the run answered goes on in a run of its own.
        await this.submitSteer();
      }
    } finally {
      await this.flushEvents();
      const added = await this.recoverMessages(start);
      await this.emit({ type: "agent_end", messages: added.map(item => item.message) });
    }
  }
}

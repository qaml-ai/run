import { createHash } from "node:crypto";
import type { AgentEvent, AgentMessage, AgentOptions, AgentState, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentSystemMessage, getSystemMessageText, type AssistantMessage, type ImageContent, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { convertToLlm as contextMessages, COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "../pi-harness/messages.ts";
import {
  GenerationTask, Harness, LiveDoc, createRegistry,
  type Conversation, type ConversationId, type EntryRecord, type HarnessOptions, type RegistryReader, type RegistrySnapshot, type Storage,
} from "@earendil-works/pi-durable";

export interface DurableCursor { entryId: number; index: number }
export interface DurableMessage { message: AgentMessage; cursor: DurableCursor }
export type DurableAgentOptions = Omit<AgentOptions, "transformContext"> & {
  durable: {
    storage: Storage;
    conversationId?: ConversationId | number;
    cursor?: DurableCursor;
    contextWindow?: number;
    summaryStream?: AgentOptions["streamFn"];
    onSummary?: (message: AssistantMessage) => void | Promise<void>;
    onCompaction?: (state: { summary: string; keptMessages: number; at: number }) => void | Promise<void>;
  };
};
type Listener = (event: AgentEvent & { durable?: DurableCursor }, signal: AbortSignal) => void | Promise<void>;
const context = BACKGROUND_CONTEXT;
const nativeKinds = new Set(["pi.user", "pi.assistant", "pi.tool-result", "camel.user", "camel.message"]);

/** Each message's content digest, kept with the message: a host's working set is mostly the same objects run to run. */
const digests = new WeakMap<object, string>();
const digest = (message: AgentMessage) => {
  let value = digests.get(message);
  if (value === undefined) digests.set(message, value = createHash("sha256").update(JSON.stringify(message)).digest("base64"));
  return value;
};

/**
 * Whether two working contexts hold the same messages: the same objects, or messages whose whole content is equal.
 * Each message is serialized on its own, so the check never holds more than one message's JSON at a time.
 */
function sameMessages(left: readonly AgentMessage[], right: readonly AgentMessage[]) {
  return left.length === right.length && left.every((message, index) => message === right[index] || digest(message) === digest(right[index]));
}

/** The native WAL is authoritative; an old transcript is a cursor-addressed projection. */
export function durableEntryMessages(entry: EntryRecord): DurableMessage[] {
  if (!nativeKinds.has(entry.kind)) return [];
  const original = entry.kind === "camel.user" ? (entry.data as { message?: AgentMessage } | undefined)?.message : undefined;
  const diagnostics = (entry.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics ?? [];
  const uncertain = diagnostics.some(item => item.code === "aborted" || item.code === "interrupted" || item.code === "abandoned");
  return (original ? [original] : entry.model ?? []).map((message, index) => ({
    message: structuredClone(message.role === "toolResult" && uncertain ? { ...message,
      content: [{ type: "text", text: `Tool ${message.toolName} was interrupted; its outcome is unknown and it may or may not have run.` }],
      isError: true } : message) as AgentMessage, cursor: { entryId: entry.id, index },
  })).filter(item => !(item.message.role === "toolResult" && (item.message.details as { inputRequired?: boolean } | undefined)?.inputRequired));
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

/** Retire native work for an explicit rollback without ever dispatching its run phases. */
export async function discardDurableRun(storage: Storage, conversationId: ConversationId | number): Promise<DurableCursor | undefined> {
  const harness = await Harness.open(storage, { registry: createRegistry(),
    models: { getModel: () => undefined } as unknown as HarnessOptions["models"],
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
  }, context);
  try {
    const conversation = await harness.conversation(conversationId as ConversationId, context);
    if (conversation) await conversation.abort(context);
    return await latestDurableCursor(storage, conversationId as ConversationId);
  } finally { await harness.close(context); }
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
  private messages: AgentMessage[];
  private tools: AgentTool[];
  private controller?: AbortController;
  private running?: Promise<void>;
  private events = Promise.resolve();
  private eventError?: unknown;
  private dirty = true;
  private pending = new Set<string>();
  private steering: AgentMessage[] = [];
  private followups: AgentMessage[] = [];
  private inputRefs = new Map<string, AgentMessage[]>();
  private originalInputs = new Map<number, { native: Message; message: AgentMessage }>();
  private _latestCursor?: DurableCursor;
  private streamingMessage?: AgentMessage;
  private errorMessage?: string;
  private lastTurn?: AssistantMessage;
  private lastTurnResults: ToolResultMessage[] = [];
  private stoppedByFinishTurn = false;
  private closed = false;
  private closing?: Promise<void>;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";

  private constructor(options: DurableAgentOptions) {
    this.options = options;
    this.messages = [...options.initialState?.messages ?? []];
    this.tools = [...options.initialState?.tools ?? []];
    this.steeringMode = options.steeringMode ?? "one-at-a-time";
    this.followUpMode = options.followUpMode ?? "one-at-a-time";
    const self = this;
    this.state = {
      model: options.initialState!.model!, thinkingLevel: options.initialState?.thinkingLevel ?? "off",
      get messages() { return self.messages; },
      // Hosts reassign the working set after every run; only a real change is checkpointed into Pi's context.
      set messages(value) { if (!sameMessages(value, self.messages)) self.dirty = true; self.messages = [...value]; },
      get tools() { return self.tools; }, set tools(value) { self.tools = [...value]; self.installTools(); self.dirty = true; },
      get systemPrompt() { const system = self.messages.findLast(message => message.role === "system"); return system ? getSystemMessageText(system) : ""; },
      get isStreaming() { return self.controller !== undefined; },
      get streamingMessage() { return self.streamingMessage; }, get pendingToolCalls() { return self.pending; },
      get errorMessage() { return self.errorMessage; },
    };
  }

  static async create(options: DurableAgentOptions): Promise<DurableAgent> {
    const agent = new DurableAgent(options);
    agent.installTools();
    // The public task definition is pinned to 1.3.0. Its preparation preserves Camel's positional system
    // sections and complete context checkpoints; its post-tools policy
    // boundary ensures Camel's finishTurn runs after every result commits,
    // including rejected and unavailable calls and sequential tool rounds.
    const original = GenerationTask.definition;
    const task = { definition: { ...original, phases: { ...original.phases,
      prepare: async (...args: Parameters<typeof original.phases.prepare>) => {
        const [record, runtime, taskContext] = args;
        const view = await runtime.context(runtime.conversationId, taskContext);
        const sections = getCurrentSystemMessage(view.messages)?.sections ??
          getCurrentSystemMessage(agent.messages)?.sections ?? {};
        // Camel owns these sections. An empty native section registry would
        // remove application instructions and duplicate the checkpoint's tools.
        const prepared = new Proxy(runtime, { get(target, key) {
          if (key === "agent") return async (ctx: typeof taskContext) => ({ ...await target.agent(ctx),
            sections: Object.entries(sections).filter(([, value]) => value !== null).map(([key, value]) =>
              ({ key, tag: false, render: async () => value! })),
          });
          if (key === "context") return async (...params: Parameters<typeof runtime.context>) => {
            const current = await target.context(...params);
            return current.head?.kind === "camel.legacy.context" ? { ...current, head: undefined } : current;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
        return original.phases.prepare(record, prepared, taskContext);
      },
      tools: async (...args: Parameters<typeof original.phases.tools>) => {
        const [record, runtime, taskContext] = args;
        if (!record.state.checkpoint.pending.length) {
          await agent.flushEvents();
          const checkpoint = record.state.checkpoint;
          const entry = await runtime.entry(checkpoint.assistant, taskContext);
          const assistant = entry?.model?.[0] as AssistantMessage;
          const live = await runtime.snapshot(LiveDoc, runtime.conversationId, taskContext);
          const results: ToolResultMessage[] = [];
          for (const slot of live?.tools ?? []) if (slot.entry !== undefined) {
            const result = await runtime.entry(slot.entry, taskContext);
            if (result?.model?.[0]?.role === "toolResult") results.push(result.model[0] as ToolResultMessage);
          }
          const decision = await agent.options.finishTurn?.({ message: assistant, toolResults: results,
            context: { messages: agent.messages, tools: agent.tools }, newMessages: agent.messages }, agent.signal);
          await agent.emit({ type: "turn_end", message: assistant, toolResults: results });
          agent.lastTurn = undefined;
          if (decision?.action === "end") {
            agent.stoppedByFinishTurn = true;
            await runtime.commit(async tx => {
              const live = await tx.doc(LiveDoc, runtime.conversationId);
              if (live.run?.taskId === record.id) {
                for (const id of live.run.inputs) tx.settleSubmission(id, { status: "done", answer: checkpoint.assistant });
                delete live.run;
              }
              delete live.generation; delete live.tools; delete live.nestedTools;
              return { status: "terminal", outcome: { status: "completed", result: { entryId: checkpoint.assistant } } };
            }, taskContext);
            return;
          }
          await agent.submitQueues("steer");
        }
        return original.phases.tools(...args);
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
      getModel: () => options.durable.contextWindow ? { ...agent.state.model, contextWindow: Math.min(agent.state.model.contextWindow, options.durable.contextWindow) } : agent.state.model,
      streamSimple: (_model: unknown, view: { messages: Message[] }, streamOptions: unknown) => agent.stream(streamOptions, view.messages),
      completeSimple: async (_model: unknown, view: { messages: Message[] }, streamOptions: unknown) => {
        await agent.flushEvents();
        const apiKey = await options.getApiKey?.(agent.state.model.provider);
        const events = await (options.durable.summaryStream ?? options.streamFn)(agent.state.model, view as never,
          { ...(streamOptions as object), apiKey } as never);
        const result = await events.result();
        await agent.conversation.commit(tx => tx.appendEntry(agent.conversation.id, {
          kind: "camel.compaction.usage", data: { message: result } as never,
        }), context);
        await options.durable.onSummary?.(result);
        return result;
      },
    };
    const window = () => Math.min(agent.state.model.contextWindow, options.durable.contextWindow ?? Infinity);
    agent.harness = await Harness.open(options.durable.storage, { registry, models: models as unknown as HarnessOptions["models"],
      settings: { compaction: { enabled: true,
        get reserveTokens() { return Math.min(16_384, Math.floor(window() * 0.15)); },
        get keepRecentTokens() { return Math.min(20_000, Math.floor(window() * 0.25)); }, backgroundTokens: 0 },
        // Live answers and tool output stream to the host from the provider and the tool, not from these commits:
        // they only bound what a lost node's run keeps, so each costs a journal write once a second, not every 100 ms.
        progress: { partialIntervalMs: 1_000, outputIntervalMs: 1_000 },
        retry: { enabled: false }, toolExecution: options.toolExecution ?? "parallel",
        steeringMode: agent.steeringMode, followUpMode: agent.followUpMode, contextRetentionMs: 0 },
    }, context);
    agent.conversation = options.durable.conversationId === undefined ? await agent.harness.root(context) :
      (await agent.harness.conversation(options.durable.conversationId as ConversationId, context))!;
    if (!agent.conversation) throw new Error("Pi durable conversation does not exist");
    agent.harness.subscribeCommits(publication => {
      for (const change of publication.changes) if (change.type === "task" && change.value.kind === original.name &&
        change.value.state.status === "terminal" && change.value.state.outcome.status === "failed") {
        agent.errorMessage = change.value.state.outcome.error.message;
      }
      const entries = publication.changes.filter(change => change.type === "entry" && change.value.conversationId === agent.conversation.id)
        .sort((a, b) => (a as { value: EntryRecord }).value.id - (b as { value: EntryRecord }).value.id);
      for (const change of entries) if (change.type === "entry") {
        const entry = change.value;
        if (entry.kind === "camel.user" && entry.model?.[0]?.role === "user") {
          const original = (entry.data as { message?: AgentMessage } | undefined)?.message;
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
    });
    {
      const view = await agent.conversation.context(context);
      for (const entry of view.entries) if (entry.kind === "camel.user" && entry.model?.[0]?.role === "user") {
        const original = (entry.data as { message?: AgentMessage } | undefined)?.message;
        if (original) agent.originalInputs.set(entry.id, { native: entry.model[0], message: original });
      }
      // A reload whose Pi context already is the host's working set writes no checkpoint: rewriting the whole context
      // on every load cost a full copy of it in memory and in the journal. An imported context is still split once
      // into per-message entries, so Pi can choose a compaction cut inside it.
      const whole = view.head?.kind === "camel.legacy.context" && (view.head.model?.length ?? 0) > 1;
      agent.dirty = whole || !sameMessages(agent.originals(view.messages as Message[]) as AgentMessage[], contextMessages(agent.messages) as AgentMessage[]);
    }
    const head = await options.durable.storage.findLatestHeadMarker(agent.conversation.id, undefined, context);
    if (head?.kind === "pi.compaction") {
      await agent.adoptCompaction(head);
      agent.messages = [...(await agent.conversation.context(context)).messages] as AgentMessage[];
    }
    agent._latestCursor = options.durable.cursor ?? await latestDurableCursor(options.durable.storage, agent.conversation.id);
    return agent;
  }

  private async adoptCompaction(entry: EntryRecord) {
    const view = await this.conversation.context(context);
    const retained = new Set(view.entries.map(entry => entry.id));
    for (const id of this.originalInputs.keys()) if (!retained.has(id as never)) this.originalInputs.delete(id);
    const keptMessages = view.contributions.reduce((count, messages, index) => count +
      (view.entries[index].id === view.head?.id ? 0 : messages.filter(message => message.role !== "system").length), 0);
    let summary = (entry.model ?? []).map(message => typeof message.content === "string" ? message.content :
      message.content.filter(part => part.type === "text").map(part => part.text).join("\n")).join("\n");
    if (summary.startsWith(COMPACTION_SUMMARY_PREFIX) && summary.endsWith(COMPACTION_SUMMARY_SUFFIX)) {
      summary = summary.slice(COMPACTION_SUMMARY_PREFIX.length, -COMPACTION_SUMMARY_SUFFIX.length);
    }
    await this.options.durable.onCompaction?.({ summary, keptMessages, at: entry.model?.[0]?.timestamp ?? Date.now() });
  }

  get signal() { return this.controller?.signal; }
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
    if (message.role === "user") {
      const key = JSON.stringify(message), refs = this.inputRefs.get(key);
      const original = refs?.shift();
      if (original) message = original;
      if (refs?.length === 0) this.inputRefs.delete(key);
    }
    this.messages.push(message);
    if (message.role === "assistant") {
      this.lastTurn = message; this.lastTurnResults = [];
      if (message.stopReason === "error" || message.stopReason === "aborted") this.errorMessage = message.errorMessage;
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
      const signal = this.signal;
      signal?.throwIfAborted();
      await this.emit({ type: "turn_start" });
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
      for await (const event of events) {
        if (event.type === "start") {
          this.streamingMessage = event.partial;
          await this.emit({ type: "message_start", message: event.partial });
        } else if (event.type !== "done" && event.type !== "error") {
          this.streamingMessage = event.partial;
          await this.emit({ type: "message_update", message: event.partial, assistantMessageEvent: event });
        }
        stream.push(event);
      }
      stream.end(await events.result());
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

  private installTools() {
    this.registry.install({ name: "camel", tools: this.tools.map(tool => ({ ...tool, replay: tool.replay === "safe" ? "safe" : "unsafe",
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
          ...(result.structuredContent === undefined ? {} : { structuredOutput: result.structuredContent }),
          ...(result.usage === undefined ? {} : { usage: result.usage }), ...(result.terminate ? { control: { terminate: true } } : {}) };
      },
    })) });
  }

  async recoverMessages(after?: DurableCursor) { return recoverDurableMessages(this.options.durable.storage, this.conversation.id, after); }

  /** Abort handlers settle unknown work; opening itself never dispatches a task. */
  async discardInterruptedRun() {
    const before = [...this.messages], cursor = this._latestCursor;
    const listeners = [...this.listeners]; this.listeners.clear();
    await this.conversation.abort(context);
    await this.flushEvents();
    // Settling an interrupted run commits native messages the host's working set does not take: check it in again.
    if (this.messages.length !== before.length || this._latestCursor !== cursor) this.dirty = true;
    this.messages = before; this.lastTurn = undefined; this.lastTurnResults = []; this.errorMessage = undefined;
    for (const listener of listeners) this.listeners.add(listener);
    return this._latestCursor;
  }

  async syncContext() {
    await this.conversation.configure({ model: { provider: this.state.model.provider, modelId: this.state.model.id },
      thinkingLevel: this.state.thinkingLevel, instructions: null }, context);
    if (!this.dirty) return;
    await this.checkpointContext(this.messages);
    this.dirty = false;
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

  steer(message: AgentMessage) { this.steering.push(message); }
  followUp(message: AgentMessage) { this.followups.push(message); }
  clearSteeringQueue() { this.steering = []; }
  clearFollowUpQueue() { this.followups = []; }
  clearAllQueues() { this.clearSteeringQueue(); this.clearFollowUpQueue(); }
  hasQueuedMessages() { return this.steering.length > 0 || this.followups.length > 0; }
  peekQueuedMessages() { return this.steering.length ? this.steering.slice(0, this.steeringMode === "all" ? undefined : 1) : this.followups.slice(0, this.followUpMode === "all" ? undefined : 1); }
  abort() { if (this.controller) { this.errorMessage ??= "Agent run aborted"; this.controller.abort(); void this.conversation.abort(context).catch(() => {}); } }
  async waitForIdle() { await this.running; }
  close(timeoutMs = 5_000): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.abort();
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
  reset() { this.clearAllQueues(); this.state.messages = this.messages.filter(message => message.role === "system"); }

  private async submitMessage(message: AgentMessage, whenBusy: "steer" | "followUp" = "steer") {
    if (message.role !== "user") {
      await this.conversation.commit(tx => tx.appendEntry(this.conversation.id, { kind: "camel.message", model: [message] as never }), context);
      return undefined;
    }
    const key = JSON.stringify(message), refs = this.inputRefs.get(key) ?? [];
    refs.push(message); this.inputRefs.set(key, refs);
    try {
      return await this.conversation.submit({ type: "input", ...((message as { requestId?: string }).requestId ? { requestId: (message as unknown as { requestId: string }).requestId } : {}), content: message.content as never, whenBusy,
        entry: { kind: "camel.user", data: { message } as never } }, context);
    } catch (error) {
      const at = refs.indexOf(message); if (at >= 0) refs.splice(at, 1);
      if (!refs.length) this.inputRefs.delete(key);
      throw error;
    }
  }
  private async submitQueues(which: "steer" | "followUp") {
    const queue = which === "steer" ? this.steering : this.followups;
    const mode = which === "steer" ? this.steeringMode : this.followUpMode;
    const selected = queue.splice(0, mode === "all" ? queue.length : 1);
    for (const message of selected) await this.submitMessage(message, which);
  }

  prompt(message: AgentMessage | AgentMessage[] | string, images: ImageContent[] = []): Promise<void> {
    const messages = typeof message === "string" ? [{ role: "user", content: images.length ? [{ type: "text", text: message }, ...images] : message, timestamp: Date.now() } as AgentMessage] : Array.isArray(message) ? message : [message];
    return this.run(messages);
  }
  continue(): Promise<void> { return this.run([]); }
  private run(messages: AgentMessage[]) {
    if (this.closed) return Promise.reject(new Error("Agent is closed"));
    if (this.running) return Promise.reject(new Error("Agent is already processing"));
    this.controller = new AbortController(); this.errorMessage = undefined; this.eventError = undefined; this.stoppedByFinishTurn = false;
    this.running = this.runInner(messages).finally(() => { this.controller = undefined; this.running = undefined; });
    return this.running;
  }
  private async runInner(messages: AgentMessage[]) {
    await this.emit({ type: "agent_start" });
    let start = this._latestCursor;
    try {
      await this.syncContext();
      // Brand-new sessions have no native cursor. Start at the context marker,
      // rather than scanning a potentially huge imported archive at agent_end.
      start ??= await latestDurableCursor(this.options.durable.storage, this.conversation.id);
      if (messages.length) for (const message of messages) await this.submitMessage(message);
      else {
        const live = await this.harness.snapshot(LiveDoc, this.conversation.id, context);
        if (!live?.run) {
          await this.conversation.commit(async tx => {
            const live = await tx.doc(LiveDoc, this.conversation.id);
            live.run = { taskId: await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId: this.conversation.id }), inputs: [] };
          }, context);
        }
        this.harness.resume();
      }
      while (true) {
        await this.conversation.waitForIdle(context);
        await this.flushEvents();
        if (this.lastTurn) {
          const decision = await this.options.finishTurn?.({ message: this.lastTurn, toolResults: this.lastTurnResults,
            context: { messages: this.messages, tools: this.tools }, newMessages: this.messages }, this.signal);
          await this.emit({ type: "turn_end", message: this.lastTurn, toolResults: this.lastTurnResults });
          this.lastTurn = undefined;
          if (decision?.action === "end") this.stoppedByFinishTurn = true;
        }
        if (this.signal?.aborted || this.stoppedByFinishTurn || !this.hasQueuedMessages()) break;
        await this.submitQueues(this.steering.length ? "steer" : "followUp");
      }
    } finally {
      await this.flushEvents();
      const added = await this.recoverMessages(start);
      await this.emit({ type: "agent_end", messages: added.map(item => item.message) });
    }
  }
}

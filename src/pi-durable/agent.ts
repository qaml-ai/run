import { createHash } from "node:crypto";
import type { AgentEvent, AgentMessage, AgentOptions, AgentState, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentSystemMessage, getSystemMessageText, type AssistantMessage, type ImageContent, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { convertToLlm as contextMessages, COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "../pi-harness/messages.ts";
import {
  GenerationTask, Harness, InboxDoc, LiveDoc, StorageRequestError, createRegistry,
  type Conversation, type ConversationId, type EntryRecord, type HarnessOptions, type RegistryReader, type RegistrySnapshot, type Storage, type TaskId,
} from "@earendil-works/pi-durable";

export interface DurableCursor { entryId: number; index: number }
export interface DurableMessage { message: AgentMessage; cursor: DurableCursor }
export type DurableAgentOptions = Omit<AgentOptions, "transformContext"> & {
  durable: {
    storage: Storage;
    conversationId?: ConversationId | number;
    cursor?: DurableCursor;
    /** The latest journal message the host wrote or recorded itself: a run's new messages are the ones after it. */
    written?: () => DurableCursor | undefined;
    contextWindow?: number;
    summaryStream?: AgentOptions["streamFn"];
    onSummary?: (message: AssistantMessage) => void | Promise<void>;
    onCompaction?: (state: { summary: string; keptMessages: number; at: number; reason: "threshold" | "overflow" }) => void | Promise<void>;
    /**
     * A storage call failed (past the Storage's own retries). Pi's Session is then failed for good, and closes the
     * Storage: the host must be given up and reopened from what was committed.
     */
    onStorageFailure?: (error: unknown) => void;
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

/** Pi 1.3.0's context derivation (harness/context.js, not exported): what it leaves out, and a missing result's text. */
const EXCLUDED_STOP_REASONS = new Set(["aborted", "error", "deferred"]);
const MISSING_RESULT_TEXT = "Tool result unavailable: history ends before this call completed.";

/**
 * A context as Pi derives it from a checkpoint of `messages`: failed, aborted and deferred responses left out, and each
 * assistant's tool results right after it in call order (a missing one given Pi's own placeholder, an unmatched one
 * dropped). Two working sets with the same Pi context need no new checkpoint: an imported legacy context Pi orders
 * differently, or a failed response the host keeps, would otherwise rewrite the whole context on every run.
 */
export function piOrdered(messages: readonly AgentMessage[]): AgentMessage[] {
  const kept = messages.filter(message => message.role !== "assistant" || !EXCLUDED_STOP_REASONS.has(message.stopReason));
  const ordered: AgentMessage[] = [];
  for (let index = 0; index < kept.length; index++) {
    const message = kept[index];
    if (message.role === "toolResult") continue;
    ordered.push(message);
    if (message.role !== "assistant") continue;
    const calls = message.content.filter(part => part.type === "toolCall");
    if (!calls.length) continue;
    const results = new Map<string, AgentMessage>();
    for (let next = index + 1; next < kept.length && kept[next].role !== "assistant"; next++) {
      const candidate = kept[next];
      if (candidate.role === "toolResult" && !results.has(candidate.toolCallId)) results.set(candidate.toolCallId, candidate);
    }
    for (const call of calls) ordered.push(results.get(call.id) ?? { role: "toolResult", toolCallId: call.id, toolName: call.name,
      content: [{ type: "text", text: MISSING_RESULT_TEXT }], isError: true, details: { reason: "missing_result" }, timestamp: message.timestamp } as AgentMessage);
  }
  return ordered;
}

/** Whether two working sets give Pi the same context: the same messages, or the same once Pi orders them (`piOrdered`). */
const samePiContext = (left: readonly AgentMessage[], right: readonly AgentMessage[]) => sameMessages(left, right) || sameMessages(piOrdered(left), piOrdered(right));

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

const summaryOf = (message: AssistantMessage) => {
  const text = message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim();
  return text || undefined;
};

/**
 * Pi's summary request (a system prompt, and a user message holding `<conversation>…</conversation>` and its prompt)
 * split into requests that each fit `window` with `maxTokens` to answer: each takes a part of the conversation, cut
 * between lines, after the summary of the parts before it. Undefined when the request fits as it is (or is not one).
 */
export function summaryChunks(messages: Message[], window: number, maxTokens: number): ((before?: string) => Message[])[] | undefined {
  const [system, user] = messages;
  const text = user?.role === "user" && Array.isArray(user.content) && user.content.length === 1 && user.content[0].type === "text" ? user.content[0].text : undefined;
  const match = text?.match(/^<conversation>\n([\s\S]*)\n<\/conversation>\n\n([\s\S]*)$/);
  if (messages.length !== 2 || !match || !Number.isFinite(window)) return undefined;
  const [, conversation, prompt] = match;
  const tokens = (value: string) => Math.ceil(value.length / 4);
  // Room for a part: the window less the answer, the prompts, and the summary carried in (bounded by the answer's size).
  const fixed = tokens(JSON.stringify(system)) + tokens(prompt) + 200;
  if (fixed + tokens(conversation) + maxTokens <= window) return undefined;
  const room = (window - maxTokens - fixed - Math.max(maxTokens, 1_000)) * 4;
  if (room < 4_000) return undefined;
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
    `${before === undefined ? "" : `<previous-summary>\n${before}\n</previous-summary>\n\nThe summary above covers the conversation before this part. Summarize both together.\n\n`}<conversation>\n${content}\n</conversation>\n\n${prompt}` }] } as Message]);
}

/** Calls whose failure always fails Pi's Session: once a write is sent, whether it landed is unknown. */
const WRITES = new Set<PropertyKey>(["commit", "mintId", "mintIds"]);

/**
 * `storage`, telling `onFailure` of a call that failed Pi's Session, by Pi's own rule: any failed write, and a failed
 * read unless the request was invalid (`StorageRequestError`) or its caller cancelled it. Those fail only that call.
 */
function storageGuard(storage: Storage, onFailure?: (error: unknown) => void): Storage {
  if (!onFailure) return storage;
  return new Proxy(storage, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function" || key === "close") return typeof value === "function" ? value.bind(target) : value;
    return (...args: unknown[]) => {
      const failed = (error: unknown) => {
        const exempt = !WRITES.has(key) && (error instanceof StorageRequestError ||
          args.some(arg => (arg as { abortSignal?: AbortSignal } | undefined)?.abortSignal?.aborted));
        if (!exempt) onFailure(error);
        throw error;
      };
      try {
        const result = value.apply(target, args);
        return result instanceof Promise ? result.catch(failed) : result;
      } catch (error) { return failed(error); }
    };
  } });
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
  /** A run's input beyond its first message: placed with it, before the run's first model request. */
  private batch: AgentMessage[] = [];
  private followups: AgentMessage[] = [];
  private inputRefs = new Map<string, AgentMessage[]>();
  private originalInputs = new Map<number, { native: Message; message: AgentMessage }>();
  private _latestCursor?: DurableCursor;
  private streamingMessage?: AgentMessage;
  /**
   * The context a provider refused as too long (a context overflow), in tokens: the real limit is below it, whatever the
   * model's declared window. Pi's compaction scales its reserve and the recent context it keeps from the window, so
   * after an overflow it compacts against this, as the legacy compactor kept about a fifth of the context.
   */
  private overflowWindow = Infinity;
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
      set messages(value) { if (!samePiContext(value, self.messages)) self.dirty = true; self.messages = [...value]; },
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
        await agent.placeQueued(record.id, runtime, taskContext);
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
      getModel: () => ({ ...agent.state.model, contextWindow: window() }),
      streamSimple: (_model: unknown, view: { messages: Message[] }, streamOptions: unknown) => agent.stream(streamOptions, view.messages),
      completeSimple: async (_model: unknown, view: { messages: Message[] }, streamOptions: unknown) => {
        await agent.flushEvents();
        const apiKey = await options.getApiKey?.(agent.state.model.provider);
        const summarize = async (messages: Message[]) => {
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
    agent.harness = await Harness.open(storageGuard(options.durable.storage, options.durable.onStorageFailure), { registry, models: models as unknown as HarnessOptions["models"],
      // What Pi contains rather than throws (a faulted phase, a throwing hook or section, a dropped progress commit) is
      // otherwise silent.
      onReport: error => console.error(JSON.stringify({ type: "pi_report", error: error instanceof Error ? error.message : String(error) })),
      settings: { compaction: { enabled: true,
        get reserveTokens() { return Math.min(16_384, Math.floor(window() * 0.15)); },
        // The recent context a summary keeps, but never so much that what is fixed (the system prompt) and it fill the
        // window again within a quarter of it: then every turn would be summarized again (the legacy compactor waited
        // for that quarter too).
        get keepRecentTokens() {
          const limit = window(), reserve = Math.min(16_384, Math.floor(limit * 0.15));
          const system = agent.messages.findLast(message => message.role === "system");
          const fixed = system ? Math.ceil(JSON.stringify(system).length / 4) : 0;
          return Math.max(1_000, Math.min(20_000, Math.floor(limit * 0.25), limit - reserve - fixed - Math.floor(limit / 4)));
        }, backgroundTokens: 0 },
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
      agent.dirty = whole || !samePiContext(agent.originals(view.messages as Message[]) as AgentMessage[], contextMessages(agent.messages) as AgentMessage[]);
    }
    const head = await options.durable.storage.findLatestHeadMarker(agent.conversation.id, undefined, context);
    if (head?.kind === "pi.compaction") {
      await agent.adoptCompaction(head, false);
      agent.messages = [...(await agent.conversation.context(context)).messages] as AgentMessage[];
    }
    agent._latestCursor = options.durable.cursor ?? await latestDurableCursor(options.durable.storage, agent.conversation.id);
    return agent;
  }

  /**
   * Tell the host of a compaction: its summary, and how many of the host's messages it keeps. Live, the host has taken
   * in the messages up to the compaction entry and none after it (their events queue behind this one), so the count is
   * of the context as the compaction left it: entries committed since (inputs a boundary placed with the summary, a
   * later turn) are not counted. On load the host already holds every message, and the current context counts them.
   */
  private async adoptCompaction(entry: EntryRecord, live = true) {
    const view = await this.conversation.context(context, live ? { at: entry.id } : undefined);
    const retained = new Set(view.entries.map(entry => entry.id));
    for (const id of this.originalInputs.keys()) if (id < entry.id && !retained.has(id as never)) this.originalInputs.delete(id);
    const keptMessages = view.contributions.reduce((count, messages, index) => count +
      (view.entries[index].id === view.head?.id ? 0 : messages.filter(message => message.role !== "system").length), 0);
    let summary = (entry.model ?? []).map(message => typeof message.content === "string" ? message.content :
      message.content.filter(part => part.type === "text").map(part => part.text).join("\n")).join("\n");
    if (summary.startsWith(COMPACTION_SUMMARY_PREFIX) && summary.endsWith(COMPACTION_SUMMARY_SUFFIX)) {
      summary = summary.slice(COMPACTION_SUMMARY_PREFIX.length, -COMPACTION_SUMMARY_SUFFIX.length);
    }
    const reason = (entry.data as { reason?: string } | undefined)?.reason === "overflow" ? "overflow" : "threshold";
    await this.options.durable.onCompaction?.({ summary, keptMessages, at: entry.model?.[0]?.timestamp ?? Date.now(), reason });
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
      const final = await events.result();
      if (final.stopReason === "error" && isContextOverflow(final)) {
        const sent = Math.ceil(JSON.stringify(llm).length / 4);
        this.overflowWindow = Math.min(this.overflowWindow, Math.max(1_000, Math.floor(sent * 0.9)));
      }
      // Pi commits an aborted response from its last throttled partial (`convertPartial`), which may be stale or
      // missing: the provider's own terminal message, with its usage and billing attempt, replaces it before Pi's
      // abort handler converts it, so the canceled response is in history and billed exactly once.
      // Only for the run's own abort: a request the runtime cut (a stale lease) is classified by Pi and made again.
      if (final.stopReason === "aborted" && own?.aborted) await this.conversation.commit(async tx => {
        const live = await tx.doc(LiveDoc, this.conversation.id);
        if (live.generation) live.generation.message = JSON.parse(JSON.stringify(final));
      }, context).catch(error => console.error(JSON.stringify({ type: "pi_aborted_response_write_failed", error: error instanceof Error ? error.message : String(error) })));
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
    // A host that writes its own messages into the journal (NativeTranscript's dual write) changed Pi's context as it
    // changed its working set: then there is nothing to check in.
    const view = await this.conversation.context(context);
    for (const entry of view.entries) if (entry.kind === "camel.user" && entry.model?.[0]?.role === "user" && !this.originalInputs.has(entry.id)) {
      const original = (entry.data as { message?: AgentMessage } | undefined)?.message;
      if (original) this.originalInputs.set(entry.id, { native: entry.model[0], message: original });
    }
    if (view.head?.kind !== "camel.legacy.context" || (view.head.model?.length ?? 0) <= 1) {
      if (samePiContext(this.originals(view.messages as Message[]) as AgentMessage[], contextMessages(this.messages) as AgentMessage[])) { this.dirty = false; return; }
    }
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
  /**
   * Before a model request, as the legacy loop polls its steering queue: the run's remaining input and the queued steers
   * enter the context now, rather than at Pi's next boundary (after the response). They are submitted as Pi queues busy
   * input, then placed as Pi's boundary places them: an entry each, the submission placed and made one of the run's inputs.
   */
  private async placeQueued(taskId: TaskId, runtime: Parameters<typeof GenerationTask.definition.phases.prepare>[1],
    taskContext: Parameters<typeof GenerationTask.definition.phases.prepare>[2]) {
    const messages = [...this.batch.splice(0), ...this.steering.splice(0, this.steeringMode === "all" ? this.steering.length : 1)];
    if (!messages.length) return;
    const ids = new Set<number>();
    for (const message of messages) {
      const submission = await this.submitMessage(message, "steer");
      if (submission !== undefined) ids.add(submission.id);
    }
    if (!ids.size) return;
    await runtime.commit(async tx => {
      const live = await tx.doc(LiveDoc, runtime.conversationId);
      if (live.run?.taskId !== taskId) return undefined;
      const items = (await tx.doc(InboxDoc, runtime.conversationId)).items;
      for (let index = 0; index < items.length;) {
        const item = items[index];
        if (item.mode !== "steer" || !ids.has(item.id)) { index++; continue; }
        const entry = await tx.appendEntry(runtime.conversationId, { ...(item.entry ?? { kind: "pi.user" }),
          model: [{ role: "user", content: item.content, timestamp: runtime.now() }] } as never);
        tx.placeSubmission(item.id, entry.id);
        live.run.inputs.push(item.id);
        items.splice(index, 1);
      }
      return undefined;
    }, taskContext);
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
    // Messages the host wrote into the journal itself since the last run are not this run's.
    const written = this.options.durable.written?.();
    if (written) this.advanceCursor(written);
    let start = this._latestCursor;
    try {
      await this.syncContext();
      // Brand-new sessions have no native cursor. Start at the context marker,
      // rather than scanning a potentially huge imported archive at agent_end.
      start ??= await latestDurableCursor(this.options.durable.storage, this.conversation.id);
      if (messages.length) {
        // The rest of the input goes in before the first model request (`placeQueued`), as one prompt.
        this.batch = messages.slice(1);
        await this.submitMessage(messages[0]);
      } else {
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
      // Input of a run aborted before its first request is withdrawn, as Pi withdraws queued input on abort.
      this.batch = [];
      await this.flushEvents();
      const added = await this.recoverMessages(start);
      await this.emit({ type: "agent_end", messages: added.map(item => item.message) });
    }
  }
}

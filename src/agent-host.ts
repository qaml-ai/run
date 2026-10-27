import { END_USER_CREDIT, type CreditStop, type ModelAttemptHook } from "./model-attempt.ts";
import { mkdir } from "node:fs/promises";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { COMPACTION_SUMMARY_PREFIX, convertToLlm, createCompactionSummaryMessage } from "./pi-harness/messages.ts";
import {
  getCurrentSystemMessage, getCurrentTools, getToolStateChanges, isContextOverflow, isRetryableAssistantError, toToolDeclaration, validateToolArguments,
  type AssistantMessage, type Message, type SystemMessage, type Tool, type ToolCall, type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { executeCode, presentResult, type CodeExecutor, type CodeResult } from "./codemode.ts";
import type { Outbound } from "./outbound.ts";
import { scriptValue } from "./mcp-results.ts";
import { CONTEXT_LOST, errorText, CONTEXT_RANGE_MAX_BYTES, CONTEXT_TOO_LARGE, contextRangeMessage, IDENTITY_KEY, NOT_MIGRATED, PERSISTENCE_FAILED, SCOPE_KEY, scratchMount, type AgentConfig, type CallContext, type Credentials, type RunStop, type ToolBridge } from "./protocol.ts";
import { APPLICATION, applicationInstructions, ENVIRONMENT, environmentSummary, INSTRUCTIONS, leadingSystemMessage, OUTPUT, OUTPUT_INSTRUCTIONS, OUTPUT_REMINDER, OUTPUT_TOOL } from "./system-prompt.ts";
import { renderMessages, senderInput, stamp, type MessageSource } from "./sender.ts";
import type { SearchHit, SearchQuery } from "./tool-search.ts";
import { closeInterruptedTurn, importedHistory, interruptedTurnRepairs, step, validateInitialMessages, validateUserMessages } from "./history.ts";
import { contextTokens, explicitKeyStream, modelKeyFailure, type ModelGate } from "./compaction.ts";
import { requestImageLimit } from "./request-images.ts";
import { codeRequest, DEFAULT_RETRY, SANDBOX_LIMITS } from "./limits.ts";
import { isStalled, streamTimeouts } from "./model-stream.ts";
import { MODEL_INTERRUPTED, modelFailure, retriesModelError, isImageRejection } from "./model-errors.ts";
import { forcedToolChoice } from "./tool-choice.ts";
import { filesRefused, schemaAccepts } from "./tool-policy.ts";
import { callSettings } from "./pi-catalog.ts";
import { describeFile, documentPayload, FILE_LIMITS, IMAGE_PAST_BUDGET, nativeBlock, unseen, validFileRef, type FileRef } from "./files.ts";
import { CHUNK_BYTES, chunksOf, type HistoryChunk } from "./history-pages.ts";
import { observeContextMetrics, observeTurns, recordCodeExecution, recordContextRange, recordToolResultSize } from "./metrics.ts";
import { fitImage, fits, type Fitted } from "./inspect.ts";
import { imageHeader, imageIntact, IMAGE_DAMAGED } from "./image-header.ts";
import { clock } from "./node-context.ts";
import { usageMissing } from "./platform-pricing.ts";
import type { Storage as PiStorage } from "@earendil-works/pi-durable";
import { DurableAgent, type DurableAgentOptions } from "./pi-durable/agent.ts";
import { contextRangeSize } from "./pi-durable/storage.ts";
import { HostJournal } from "./pi-durable/host-journal.ts";
import type { RetiredRecord } from "./pi-durable/retired-host.ts";
import { seedJournal, SESSION_CONVERSATION_ID } from "./pi-durable/seed.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

/** How long a stopping agent waits to index its settled turns (see `index`). */
export const HISTORY_FLUSH_MS = 5_000;

/** Model requests of one structured run that may force final_output (see `outputChoice`). */
const FORCED_OUTPUT_REQUESTS = 3;

/** Images one agent scales down at once for its requests (`fitImage`). */
const FIT_CONCURRENCY = 2;
/** Files one model request reads at once, newest first, within its image budget (`hydrate`). */
const READ_AHEAD = 8;
/** A direct call's arguments, as Pi checks them; ones naming a file for a tool that takes none are refused saying so. */
const checkedArguments: typeof validateToolArguments = (tool, call) => {
  try { return validateToolArguments(tool, call); } catch (error) {
    const refused = filesRefused(tool.name, tool.parameters, call.arguments);
    throw refused ? new Error(refused) : error;
  }
};
/** A file as requests carry it: its bytes (base64; an image's type if it was scaled down), or why an image is omitted. */
type Hydrated = { data: string; mimeType?: string } | { omitted: string };
const hydratedSize = (value: Hydrated) => "data" in value ? value.data.length : value.omitted.length;
const hydratedImage = (fitted: Fitted): Hydrated => "omitted" in fitted ? { omitted: fitted.omitted } : { data: fitted.data.toString("base64"), mimeType: fitted.mimeType };

/** An agent's legacy log, read only (`HostIO.legacyLog`). */
export interface LegacyLog { read(): Promise<RetiredRecord[]>; empty(): Promise<boolean> }

/** How a host talks to its supervisor: over IPC in its own process, or directly when inline. */
export interface HostIO {
  emit(event: unknown): void;
  /** Dispatch an application tool through the supervisor, which validates and limits it. */
  tool(name: string, args: Record<string, unknown>, call?: CallContext): Promise<any>;
  /** Abort the application tool calls this agent has in flight. */
  cancelTools(): Promise<unknown>;
  /** Why the running turn must end before its next model request (a reached spend cap, the run's own limits, or its node leaving), if so. */
  runLimit(): Promise<RunStop | undefined>;
  /**
   * The agent's legacy log, read only: what the host transcript's first imports could not copy (retired-host.ts), read
   * once, as the session's history before its journal base is indexed. A session holding history only there is refused.
   */
  legacyLog: LegacyLog;
  /** Native Pi storage stays on the supervisor under the session's ownership claim. */
  piStorage?(): Promise<PiStorage | undefined>;
  /** `tools.search`, answered by the supervisor (which holds the rerankers); without it, code searches here. */
  search?(query: SearchQuery): Promise<SearchHit[]>;
  /** A file reference's bytes as base64, read by the supervisor: the agent holds no storage access. */
  file(ref: FileRef): Promise<string>;
  /** An inline image saved to the agent's writable mount by the supervisor, as a file reference (`savesImages`). */
  saveImage?(image: { data: string; mimeType: string }): Promise<FileRef>;
  /** Credentials for one model call of an agent whose key is resolved per call: an identity token the supervisor signs, or its key scope's entry. */
  modelAuth(): Promise<Credentials>;
  modelAttempt?: ModelAttemptHook;
  /** js_exec's `fs`, answered by the supervisor over the agent's mounts. */
  fs(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** Wait for the tenant's turn to run js_exec on the node, until `signal` aborts; resolves with the function that gives it back. */
  codeSlot?(signal: AbortSignal): Promise<() => void>;
  /** Where js_exec runs: this process's v8-exec runner unless given (an inline host's node may give its own). */
  codeExecutor?: CodeExecutor;
  /** The outbound policy model calls to endpoints tenants give go through: its node's (this process's unless given). */
  modelOutbound?: Outbound;
  /** Wait until the node may act for the agent (its lease is fresh), before each model request and js_exec; rejects once it lost the agent. */
  lease?(): Promise<void>;
  /** Tenants whose agents' system sections are native Pi sections (AGENT_NATIVE_SECTIONS_TENANTS; `*`: every tenant). */
  nativeSectionsTenants?: string[];
  /** Tenants whose agents keep inline images as workspace files (AGENT_PI_IMAGE_REFS_TENANTS; `*`: every tenant). */
  imageRefsTenants?: string[];
  /** The agent's history index, which the supervisor writes: how many messages it has (null: it has none yet, or none is kept), and a chunk to add. */
  history?: { indexed(): Promise<number | null>; write(chunk: HistoryChunk): Promise<number> };
}

/** The messages one pass of the history index reads from the journal at most, in bytes (see `index`). */
const INDEX_READ_BYTES = 4 * CHUNK_BYTES;

/** Tools a lost node's open call to is made again on resume, not closed as unknown: each is keyed by its call (multi-agent.ts). */
export const RERUN = ["delegate", "spawn_agent", "wait_agent", "list_agents", "send_message", "interrupt_agent"];

/** The latest assistant message's tool calls that have no result yet. */
export function openCalls(messages: AgentMessage[]): ToolCall[] {
  const open = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role === "assistant") { open.clear(); for (const part of message.content) if (part.type === "toolCall") open.set(part.id, part); }
    else if (message.role === "toolResult") open.delete(message.toolCallId);
    else if (message.role === "user") open.clear();
  }
  return [...open.values()];
}

/**
 * A limit's stop as a run's result carries it: its code (its own, else the kind of stop), and the limit, reason, bucket
 * and end user where it names them.
 */
const sameCursor = (a: { entryId: number; index: number }, b: { entryId: number; index: number } | undefined) => !!b && a.entryId === b.entryId && a.index === b.index;
/** Whether a message of Pi's context is a compaction's summary (as the host imported it, or as Pi wrote it). */
const isSummary = (message: AgentMessage) => message.role === "compactionSummary" || message.role === "user" &&
  (typeof message.content === "string" ? message.content : message.content.find(part => part.type === "text")?.text ?? "").startsWith(COMPACTION_SUMMARY_PREFIX);
/** Whether two messages are the same: one read back from the journal, the other as the agent holds it. */
const sameMessage = (a: AgentMessage | undefined, b: AgentMessage | undefined) => !!a && !!b && (a === b || JSON.stringify(a) === JSON.stringify(b));
const stopFields = (stop: Partial<RunStop>) => ({
  code: stop.code ?? stop.stopped,
  ...(stop.limit ? { limit: stop.limit } : {}), ...(stop.reason ? { reason: stop.reason } : {}),
  ...(stop.bucket ? { bucket: stop.bucket } : {}), ...(stop.endUser ? { endUser: stop.endUser } : {}),
});

/** A fresh turn retains its task and, after compaction, only the latest summary and what follows it. */
export function freshView(messages: AgentMessage[], fresh?: AgentMessage): AgentMessage[] {
  let view = messages;
  if (fresh) {
    const at = messages.findLastIndex(message => message.role === "user" && sameMessage(message, fresh));
    let start = at, tail = messages.slice(at);
    if (at < 0) {
      // A summary made during this turn (not an older one, should `fresh` be missed for another reason).
      const summary = messages.findLastIndex(message => isSummary(message) && (message.timestamp ?? 0) >= fresh.timestamp);
      // Without a summary, a later user message is the only surviving turn marker we can trust. Older turns stay hidden.
      const marker = messages.findLastIndex(message => message.role === "user" && message.timestamp > fresh.timestamp);
      start = summary >= 0 ? summary : marker >= 0 ? marker : messages.length;
      tail = [fresh, ...messages.slice(start)];
    }
    view = [getCurrentSystemMessage(messages.slice(0, start))!, ...tail].filter(Boolean);
  }
  if (!view.some(message => message.role === "user" || isSummary(message))) throw new Error(`${CONTEXT_LOST}: The model request has no user message; the turn's task was lost`);
  return view;
}

/**
 * One agent: its Pi loop, its history and turn in Pi's journal (HostJournal), and retries. It runs in its own process
 * (agent-child.ts) or inline in a worker hosting many agents.
 */
export function createAgentHost(hostIO: HostIO) {
  let agent: DurableAgent | undefined;
  let config: AgentConfig;
  const contextMetrics = observeContextMetrics(() => config?.id);
  let reportContextRange = true;
  // Each turn's outcome, timing and model and tool counts, as metrics (metrics.ts), from what the host emits.
  const turns = observeTurns(() => config?.model && { provider: config.model.provider, id: config.model.id }, Date.now, () => config?.tenant);
  let refused: Parameters<HostIO["emit"]>[0] | undefined;
  const io: HostIO = { ...hostIO, emit: value => {
    // Both Pi's native results and results settled/resumed by the host reach message_end after commit.
    const committed = value as { type: string; message?: ToolResultMessage };
    if (committed.type === "message_end" && committed.message?.role === "toolResult") recordToolResultSize(config.id, committed.message);
    let event = value as { type: string; message?: AssistantMessage; [key: string]: unknown };
    const overflow = event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error" && isContextOverflow(event.message);
    if (overflow) event = { ...event, contextTokens: agent?.contextTokens };
    turns.event(event);
    // A refused response stays private until recovery ends. Its retraction has no client-visible slot to remove.
    if (overflow) { refused = event; return; }
    if (event.type === "message_retracted" && refused) { refused = undefined; return; }
    if (refused && event.type === "message_end") { hostIO.emit(refused); refused = undefined; }
    hostIO.emit(event);
  } };
  /** The agent's history and turn, in its Pi journal. */
  let journal: HostJournal;
  /** How many of its messages the history index has (undefined: none is kept, or it could not be read at start). */
  let indexedTo: number | undefined;
  let busy = false;
  let active: AbortController | undefined;
  /** Why the current run ended early: a spend limit, tool calls waiting on a person's input, or a hand-off (its node is leaving). */
  let stopped: { stopped: RunStop["stopped"] | "input_required"; error?: string; code?: string; limit?: RunStop["limit"]; reason?: string; bucket?: string; endUser?: string } | undefined;
  /**
   * A model call its end user's credit refused (before it was made) or cut (where its hold ran out, as it streamed):
   * the running turn stops there, as at a spend limit, and is not retried.
   */
  const creditStop = (refused: CreditStop) => {
    if (!busy || stopped) return;
    stopped = { stopped: "spend_limit", error: refused.message, code: END_USER_CREDIT, limit: "end_user", reason: refused.reason, bucket: refused.bucket, endUser: refused.endUser };
    io.emit({ type: "spend_limit_reached", message: refused.message });
  };
  /** Files' bytes (base64) by content, as requests carry them, least recently used first, kept between model requests. */
  const hydrated = new Map<string, Hydrated>();
  let hydratedBytes = 0;
  /** Images being scaled down for requests, and those waiting to be (`scaled`). */
  let fitting = 0;
  const waitingToFit: (() => void)[] = [];
  /** Whether the model request being built carries a PDF, whose block the provider payload needs rewritten. */
  let documents = false;
  /** A provider refused an intact image: omit every image for the rest of this turn only. */
  let omitImages = false;
  /** History index writes, one at a time. */
  let indexing = Promise.resolve();
  /** About how much of the history the index lacks, in bytes, as messages end: a pass reads the journal only past a chunk. */
  let unindexed = 0;
  /** The first user message of a running turn that sees no history (a prompt's `history: "none"`): its requests send from there (`freshView`). */
  let fresh: AgentMessage | undefined;
  /** Whether the running turn can still take a steer sent `whileRunning` (see `steer`). */
  let steerable = false;
  /** Steering messages not yet taken, in order; `whileRunning` ones are taken back if the turn ends without them. */
  let steers: { message: AgentMessage; whileRunning: boolean }[] = [];
  /** What the current run's final_output call gave, once the model made one that fit its schema. */
  let output: { value: unknown } | undefined;
  /**
   * Requests of the current run that may still force final_output (`outputChoice`), whether its reminder does, and
   * whether the latest request did.
   */
  let forcing = { left: 0, reminding: false, last: false };
  /** Calls a lost node left open that are safe to make again (`RERUN`): made again before the resumed turn continues. */
  let rerun: ToolCall[] = [];
  /** js_exec, which an agent has unless its codeMode is false; made at init. */
  let jsExec: AgentTool | undefined;
  /** Model requests wait for the node's lease, and are cut (`interrupt`) when it goes stale. */
  const gate: ModelGate = { wait: signal => leased(signal), open: new Set() };

  /** Wait for the node's lease (`HostIO.lease`), or until `signal` aborts. */
  async function leased(signal?: AbortSignal) {
    if (!io.lease) return;
    signal?.throwIfAborted();
    const waiting = io.lease();
    if (!signal) return waiting;
    const aborted = Promise.withResolvers<never>();
    const abort = () => aborted.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    waiting.catch(() => {});
    try { await Promise.race([waiting, aborted.promise]); }
    finally { signal.removeEventListener("abort", abort); }
  }

  /**
   * Add what the history index lacks to it, from the journal, in the background. Chunks are written when what the index
   * lacks has grown past one (all but the latest message, the only one a retry retracts), and when the agent stops
   * (`final`: the settled turns), never per turn; a turn cut off by the stop is settled at the next start, with its
   * repairs. A failed write is tried again with the next. Settled, with every message indexed, the journal's later
   * reads start from there (`HostJournal.rebase`).
   */
  function index(final = false): Promise<void> {
    const history = io.history;
    if (!history || !journal || indexedTo === undefined || (!final && unindexed < CHUNK_BYTES)) return Promise.resolve();
    return indexing = indexing.then(async () => {
      await journal.refresh();
      const kept = journal.history;
      if (indexedTo! < kept.heldFrom) {
        console.error(JSON.stringify({ type: "history_index_behind_journal", agent: config.id, indexed: indexedTo, base: kept.heldFrom }));
        return;
      }
      const upto = final ? (kept.active ? Math.min(kept.turnStart, kept.total) : kept.total) : kept.total - 1;
      const sizes = (from: number, to: number) => kept.sizesFrom(from, to);
      if (upto <= indexedTo! || (!final && sizes(indexedTo!, upto).reduce((sum, size) => sum + size, 0) < CHUNK_BYTES)) return;
      // A pass at a time, each of what fits in INDEX_READ_BYTES.
      while (indexedTo! < upto) {
        const from = indexedTo!, all = sizes(from, upto);
        let count = 0, bytes = 0;
        while (count < all.length && (!count || bytes + all[count] <= INDEX_READ_BYTES)) bytes += all[count++];
        const messages = await kept.messagesFrom(from, from + count);
        if (!messages) throw new Error(`The journal does not hold messages ${from} to ${from + count}`);
        for (const chunk of chunksOf({ from, messages, sizes: all.slice(0, count), turns: kept.turnsFrom(from) })) {
          indexedTo = await history.write(chunk);
          // Another writer, or a gap: the rest waits for the next pass.
          if (indexedTo !== chunk.start + chunk.messages.length) return;
        }
      }
      unindexed = sizes(indexedTo!, kept.total).reduce((sum, size) => sum + size, 0);
      if (final || !kept.active) await journal.rebase(indexedTo!);
    }).catch(error => console.error(JSON.stringify({ type: "history_index_failed", agent: config.id, error: errorText(error) })));
  }

  /** The leading system message the agent's configuration makes: a new agent's Pi context starts with it. */
  function leading(tools: Tool[] = agent!.state.tools.map(toToolDeclaration)): SystemMessage {
    return leadingSystemMessage(config, tools, nativeSections() ? APPLICATION : INSTRUCTIONS);
  }

  /**
   * A continued or resumed turn sees no history when its latest user message says so (`freshView`): that message, and
   * undefined otherwise.
   */
  async function freshTurn(): Promise<AgentMessage | undefined> {
    const first = (await journal.since(message => message.role === "user"))[0];
    return (first as { history?: string } | undefined)?.history === "none" ? first : undefined;
  }

  /**
   * Bring the system messages in line with the configuration. Without history the leading message is rebuilt; with
   * history a change follows as a system message of its own (in Pi's context, never history), so the cached prefix
   * stays byte-identical. `durable` writes the change even without history: a tool the configuration does not hold
   * (final_output) is declared only by the journal, so another node continuing the turn finds it.
   */
  async function declareConfiguration(durable = false): Promise<void> {
    const messages = agent!.state.messages;
    const tools = agent!.state.tools.map(toToolDeclaration);
    if (!durable && !journal.total) {
      const rebuilt = leading(tools);
      if (JSON.stringify(convertToLlm([rebuilt])) !== JSON.stringify(convertToLlm(messages.slice(0, 1)))) await agent!.replaceContext([rebuilt, ...messages.filter(message => message.role !== "system")]);
      return;
    }
    const { toolsAdded, toolsRemoved } = getToolStateChanges(getCurrentTools(messages), tools);
    let current = getCurrentSystemMessage(messages)?.sections ?? {};
    // Native sections take the instructions under `application`; so does a conversation that already has them there.
    const native = nativeSections(), instructions = native || APPLICATION in current ? APPLICATION : INSTRUCTIONS;
    // Sections under the old key are removed and every section declared again in order: a section declared later is
    // placed after the others, so re-keying one alone would move the application's instructions after the environment.
    const cleared: SystemMessage[] = [];
    if (native && INSTRUCTIONS in current) {
      cleared.push({ role: "system", content: "", timestamp: Date.now(), sections: Object.fromEntries(Object.keys(current).map(name => [name, null])) });
      current = {};
    }
    const wanted = {
      [instructions]: applicationInstructions(config.systemPrompt, config.systemPromptAppend), [ENVIRONMENT]: environmentSummary(config),
      [OUTPUT]: tools.some(tool => tool.name === OUTPUT_TOOL) ? OUTPUT_INSTRUCTIONS : null,
    };
    const sections = Object.fromEntries(Object.entries(wanted).filter(([name, text]) => (current[name] ?? null) !== text));
    if (!cleared.length && !Object.keys(sections).length && !toolsAdded.length && !toolsRemoved.length) return;
    const change: SystemMessage = {
      role: "system", content: "", timestamp: Date.now(), ...(Object.keys(sections).length ? { sections } : {}),
      ...(toolsAdded.length ? { toolsAdded } : {}), ...(toolsRemoved.length ? { toolsRemoved } : {}),
    };
    // Pi takes the change once it is written.
    await journal.commit(() => [...cleared, change].map(message => ({ t: "system" as const, message })));
    await agent!.reload();
  }

  /**
   * Make again the calls a lost node left open that are safe to repeat (RERUN: delegate finds the child its call started),
   * all at once as the model made them, and record their results in order.
   */
  async function rerunOpenCalls(signal: AbortSignal) {
    const calls = rerun;
    rerun = [];
    if (!calls.length) return;
    for (const call of calls) io.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
    const results = await Promise.all(calls.map(async (call): Promise<Settled> => {
      const tool = agent!.state.tools.find(entry => entry.name === call.name);
      try {
        if (!tool) throw new Error(`${call.name} is no longer available to this agent`);
        return await tool.execute(call.id, checkedArguments(tool, call), signal) as Settled;
      } catch (error) { return { content: [{ type: "text", text: errorText(error) }], isError: true }; }
    }));
    for (const [index, call] of calls.entries()) {
      const result = results[index];
      io.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError: !!result.isError });
      const message = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, ...(result.details !== undefined ? { details: result.details } : {}), isError: !!result.isError, timestamp: Date.now() } as AgentMessage;
      await journal.push(message);
      io.emit({ type: "message_end", message });
    }
  }

  /** Whether the agent keeps inline images by reference (`savesImages`): its tenant is in AGENT_PI_IMAGE_REFS_TENANTS (or `*`). */
  const imageRefs = () => !!io.imageRefsTenants && (io.imageRefsTenants.includes("*") || io.imageRefsTenants.includes(config.tenant ?? ""));
  /** Whether the agent's system sections are native Pi sections: its tenant is in AGENT_NATIVE_SECTIONS_TENANTS (or `*`). */
  const nativeSections = () => !!io.nativeSectionsTenants && (io.nativeSectionsTenants.includes("*") || io.nativeSectionsTenants.includes(config.tenant ?? ""));

  /** Whether each model call asks the supervisor for its credentials. */
  const perCall = () => config.apiKey === IDENTITY_KEY || config.apiKey === SCOPE_KEY;
  /** Where its model requests go, for `retriesModelError`: its tenant's own endpoint retries for itself. */
  const failureContext = () => ({ ownEndpoint: config.apiKey === IDENTITY_KEY, contextWindow: config.model.contextWindow });

  /**
   * The model as Pi's compaction measures it: its context window lowered to the agent's `runLimits.contextTokens`, if
   * that is lower.
   */
  function compactionModel(): AgentConfig["model"] {
    const limit = config.runLimits?.contextTokens;
    return limit && limit < config.model.contextWindow ? { ...config.model, contextWindow: limit } : config.model;
  }

  /**
   * Where the model made a call: the history index of the assistant message carrying it. With the call's id it names
   * the call for good (providers may number calls per response, so ids repeat across turns), the same on a retry or resume.
   */
  async function made(toolCallId: string): Promise<{ messageIndex?: number }> {
    await journal.refresh();
    const messageIndex = journal.callIndex(toolCallId);
    return messageIndex === undefined ? {} : { messageIndex };
  }

  /**
   * The tool a run that asks for structured output ends with: its parameters are the run's schema, so Pi checks
   * the model's answer against it and hands a call that does not fit back to the model with what is wrong.
   */
  function outputTool(schema: Tool["parameters"]): AgentTool {
    return {
      name: OUTPUT_TOOL, label: "Final output", parameters: schema as AgentTool["parameters"], executionMode: "sequential",
      description: "Give your final answer for this request by calling this tool once, with the answer as its arguments: this request asks for its answer in this form. Do the work first; your turn ends when the call is accepted.",
      execute: async (_id, args) => ({ content: [{ type: "text", text: "Accepted." }], details: { output: args } }),
    };
  }

  /**
   * The tool_choice of a structured run's next model request: final_output, forced from the first request when it is
   * the only tool the model has, and once the model has answered in text (`remindOfOutput`) when it has others, where the
   * provider can force it (`forcedToolChoice`; elsewhere the reminder alone asks for it). At most FORCED_OUTPUT_REQUESTS
   * a run, so a model whose calls never fit the schema still ends its turn.
   */
  function outputChoice(model: AgentConfig["model"]): unknown {
    forcing.last = false;
    const tools = agent!.state.tools;
    if (output || forcing.left <= 0 || !tools.some(tool => tool.name === OUTPUT_TOOL)) return undefined;
    const sole = tools.every(tool => tool.name === OUTPUT_TOOL);
    if (!sole && !forcing.reminding) return undefined;
    const choice = forcedToolChoice(model, OUTPUT_TOOL, { sole, thinking: (config.thinkingLevel ?? "off") !== "off" });
    if (choice !== undefined) { forcing.left--; forcing.last = true; }
    return choice;
  }

  /**
   * A request with final_output forced that the provider refused (one that takes no such tool_choice): taken back, as
   * a failed response is, and asked again without forcing for the rest of the run.
   */
  async function unforced(signal: AbortSignal) {
    const last = agent!.state.messages.at(-1) as AssistantMessage | undefined;
    if (!forcing.last || signal.aborted || stopped || last?.role !== "assistant" || last.stopReason !== "error" || isRetryableAssistantError(last) || isContextOverflow(last, config.model.contextWindow)) return;
    forcing = { left: 0, reminding: false, last: false };
    await journal.retract();
    io.emit({ type: "message_retracted", index: journal.total });
    await agent!.continue();
  }

  /**
   * Declare final_output with a prompt's schema, or take it away from a prompt without one. It stays declared
   * between runs (the tool set changes only when a schema does), and a turn continued or resumed keeps it.
   */
  async function useOutput(schema: Tool["parameters"] | undefined) {
    const declared = agent!.state.tools.find(tool => tool.name === OUTPUT_TOOL);
    if (schema && config.tools.some(tool => tool.name === OUTPUT_TOOL)) throw new Error(`This agent has a tool of its own named ${OUTPUT_TOOL}, so it cannot take an output schema`);
    if (!schema && !declared) return;
    if (!declared || JSON.stringify(declared.parameters) !== JSON.stringify(schema)) {
      agent!.state.tools = [...agent!.state.tools.filter(tool => tool.name !== OUTPUT_TOOL), ...(schema ? [outputTool(schema)] : [])];
    }
    // Also takes back a reminder the last run was given (see finishTurn): a change only where there is one.
    await declareConfiguration(true);
  }

  /** The tools code can call; `toolCallId` is the js_exec call running it, if the model made one. */
  /** One js_exec execution under the tenant's limits, and its metric line. */
  async function runCode(options: Parameters<typeof executeCode>[0]) {
    const started = Date.now();
    let result: CodeResult | undefined, failure: unknown;
    // Code makes tool calls and writes files: it starts only while the node's lease is fresh.
    await leased(options.signal);
    try { return result = await executeCode({ ...options, limits: config.codeLimits, admit: io.codeSlot && (signal => io.codeSlot!(signal)), ...(io.codeExecutor ? { pool: io.codeExecutor } : {}) }); }
    catch (error) { failure = error; throw error; }
    finally {
      const maxTimeoutMs = Math.min(config.codeLimits?.maxTimeoutMs ?? SANDBOX_LIMITS.maxTimeoutMs, SANDBOX_LIMITS.maxTimeoutMs);
      recordCodeExecution({ tenant: config.tenant, ms: Date.now() - started, requestedTimeoutMs: options.timeoutMs, timeoutMs: Math.min(options.timeoutMs ?? SANDBOX_LIMITS.timeoutMs, maxTimeoutMs), cpuMs: result?.cpuMs, error: failure });
    }
  }

  function bridge(signal: AbortSignal, toolCallId?: string): ToolBridge {
    let calls = 0;
    return {
      definitions: config.tools.filter(tool => tool.exposure !== "direct"),
      call: async (name, args) => {
        signal.throwIfAborted();
        const value = await io.tool(name, args, toolCallId ? { toolCallId, innerCallId: `${toolCallId}:${++calls}`, ...await made(toolCallId) } : undefined);
        // MCP tools answer with content; code gets their data.
        return config.tools.find(tool => tool.name === name)?.resultFormat === "content" ? scriptValue(value) : value;
      },
      ...(io.search ? { search: io.search } : {}),
      fs: (op, args) => { signal.throwIfAborted(); return io.fs(op, args); },
    };
  }

  /**
   * A direct tool call's content as the model gets it: text past SANDBOX_LIMITS.outputCharacters is cut, as js_exec's
   * output is, and the whole text saved to the agent's workspace (tool-results/<call>.txt), which the model is told to read in parts.
   */
  async function capped(toolCallId: string, content: any[]): Promise<any[]> {
    const text = content.filter(part => part.type === "text").map(part => part.text as string).join("\n");
    const limit = SANDBOX_LIMITS.outputCharacters;
    if (text.length <= limit) return content;
    // Saved where the agent can read it: with its file tools, or fs in js_exec.
    const readable = config.fileTools !== false || config.codeMode !== false;
    const mount = readable ? scratchMount(config.mounts) : undefined;
    // Named by the message that made the call too: providers may give calls in different turns the same id.
    const at = (await made(toolCallId)).messageIndex;
    const path = mount && `${mount.path}/tool-results/${at !== undefined ? `${at}-` : ""}${toolCallId.replace(/[^A-Za-z0-9_.-]/g, "_")}.txt`;
    const whole = Buffer.from(text, "utf8");
    const saved = path ? await io.fs("writeFile", { path, text: whole.length > FILE_LIMITS.scriptFileBytes ? whole.subarray(0, FILE_LIMITS.scriptFileBytes).toString("utf8") : text }).then(() => true, () => false) : false;
    // Read with what the agent has: its file tools, or, without them (fileTools: false), fs in js_exec.
    const how = config.fileTools === false ? "with fs.readFile in js_exec" : "with read (offset and length)";
    const where = saved ? ` The whole result${whole.length > FILE_LIMITS.scriptFileBytes ? ` (its first ${FILE_LIMITS.scriptFileBytes.toLocaleString("en-US")} bytes)` : ""} is in ${path}: read it in parts ${how}.` : " Ask the tool for less.";
    return [...content.filter(part => part.type !== "text"), { type: "text", text: `${text.slice(0, limit)}\n\n[Result cut at ${limit.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters.${where}]` }];
  }

  /** The tools the model calls directly: those declared direct, or every one without js_exec (codeMode: false). */
  function directAgentTools(tools: AgentConfig["tools"]): AgentTool[] {
    return tools.filter(tool => config.codeMode === false || ["direct", "both"].includes(tool.exposure ?? "codemode")).map(tool => ({
        name: tool.name, label: tool.name, description: tool.description,
        parameters: tool.parameters as AgentTool["parameters"], executionMode: tool.executionMode,
        // Ahead of Pi's own check, whose complaint about a file named for a tool that takes none reads as a wrong path.
        prepareArguments: (args: unknown) => {
          const refused = filesRefused(tool.name, tool.parameters, args);
          if (refused && !schemaAccepts(tool.parameters, args)) throw new Error(refused);
          return args as Record<string, unknown>;
        },
        execute: async (toolCallId, args, signal) => {
          signal?.throwIfAborted();
          const value = await io.tool(tool.name, args as Record<string, unknown>, { toolCallId, ...await made(toolCallId) });
          signal?.throwIfAborted();
          // The call waits on a person (inputs.ts): it stays open, with no result, and the turn suspends after this step.
          if (value?.inputRequired) {
            await journal.await([toolCallId]);
            return { content: value.content, details: { inputRequired: true } };
          }
          if (tool.resultFormat === "content") {
            if (!value || !Array.isArray(value.content) || value.content.some((part: any) => !part || !(part.type === "text" && typeof part.text === "string" || part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string" || validFileRef(part)))) throw new Error("Invalid content tool result");
            // A failed call (an MCP tool's isError, an OpenAPI operation's HTTP error) is an error result that keeps its content and details.
            return { ...value, content: await capped(toolCallId, (await fittedImages([value]))[0].content), isError: value.isError === true };
          }
          return { content: await capped(toolCallId, [{ type: "text", text: JSON.stringify(value) ?? "null" }]), details: value };
        },
      }));
  }

  /** js_exec, with the agent's code limits. */
  function codeTool(): AgentTool {
    const maxTimeoutMs = config.codeLimits?.maxTimeoutMs ?? SANDBOX_LIMITS.maxTimeoutMs;
    return {
      name: "js_exec", label: "JavaScript",
      description: "Run JavaScript or TypeScript in a fresh sandbox. Return what you want to see: it comes back as JSON (a string as its own text), after any console.log lines. In scope: tools (await tools.<name>(args) gives the tool's result as data; tools.search, tools.namespaces and tools.describe find them) and fs for your files (readFile(path, { encoding: \"utf8\" }) gives a string, a Uint8Array without it; writeFile(path, string | Uint8Array); stat, list, remove); no network, imports, Node APIs or timers. Variables are gone after each execution; files persist. An execution gets timeoutMs of wall time (default " + Math.min(SANDBOX_LIMITS.timeoutMs, maxTimeoutMs) + ", at most " + maxTimeoutMs + "), tool calls included: raise it for slow tools." + " For example:\nconst tickets = [];\nfor (let page = 1; page; ) { const result = await tools.helpdesk__list_tickets({ status: \"open\", page }); tickets.push(...result.tickets); page = result.nextPage; }\nawait fs.writeFile(\"" + (scratchMount(config.mounts)?.path ?? "/workspace") + "/tmp/tickets.json\", JSON.stringify(tickets)); // a later execution can read it back\nreturn { open: tickets.length, oldest: tickets[0]?.createdAt };",
      parameters: {
        type: "object", required: ["code"],
        properties: { code: { type: "string" }, description: { type: "string" }, timeoutMs: { type: "number" }, maxOutputCharacters: { type: "number" } },
      } as AgentTool["parameters"],
      executionMode: "sequential",
      execute: async (id, args, signal, onUpdate) => {
        try {
          const request = codeRequest(args);
          const { returned, cpuMs: _cpuMs, ...result } = await runCode({
            ...request, bridge: bridge(signal ?? new AbortController().signal, id), signal,
            onEvent: event => {
              io.emit({ type: "codemode", toolCallId: id, event });
              onUpdate?.({ content: [{ type: "text", text: JSON.stringify(event) }], details: event });
            },
          });
          // details keeps the output as events streamed it, for clients that render it.
          return { content: [{ type: "text", text: presentResult({ ...result, returned }, request.maxOutputCharacters) }], details: result };
        } finally { await io.cancelTools(); }
      },
    };
  }

  /** A referenced file's bytes as the request carries them: an image scaled down if it must be (`fitImage`), or why it is omitted. */
  async function fileData(ref: FileRef): Promise<Hydrated> {
    if (omitImages && ref.media?.kind === "image") return { omitted: IMAGE_DAMAGED };
    const key = ref.chunks.join("");
    let data = hydrated.get(key);
    if (data !== undefined) hydrated.delete(key);
    else {
      const read = await io.file(ref);
      const fitted = ref.media?.kind === "image" ? await scaled(Buffer.from(read, "base64")) : undefined;
      // Kept only when the next request would get the same: one that failed for now tries again then.
      if (fitted && "omitted" in fitted && fitted.transient) return fitted;
      data = fitted ? hydratedImage(fitted) : { data: read };
      hydratedBytes += hydratedSize(data);
      for (const [old, value] of hydrated) {
        if (hydratedBytes <= FILE_LIMITS.hydratedBytes) break;
        hydrated.delete(old);
        hydratedBytes -= hydratedSize(value);
      }
    }
    hydrated.set(key, data);
    return data;
  }

  /** An image scaled down for requests (`fitImage`), a couple at a time: each decodes in a worker of its own. */
  async function scaled(bytes: Buffer): Promise<Fitted> {
    while (fitting >= FIT_CONCURRENCY) await new Promise<void>(resolve => waitingToFit.push(resolve));
    fitting++;
    try { return await fitImage(bytes); }
    finally { fitting--; waitingToFit.shift()?.(); }
  }

  /**
   * An image block as a request may carry it: intact bytes as they are when the header is within `fits`, else scaled down,
   * or a placeholder in its place when it cannot be. The journal is not changed: it heals in the request.
   * Written to the journal (`writing`), an image that failed only for now stays as it is, for requests to try again.
   */
  async function fittedBlock(block: { type: "image"; data: string; mimeType: string }, writing: boolean): Promise<{ type: "image"; data: string; mimeType: string } | { type: "text"; text: string }> {
    if (block.mimeType === "application/pdf") return block;
    if (!writing && omitImages) return { type: "text", text: `[image omitted: ${IMAGE_DAMAGED}]` };
    const bytes = Buffer.from(block.data, "base64");
    const header = imageHeader(bytes);
    if (!imageIntact(bytes, block.mimeType)) return { type: "text", text: `[image omitted: ${IMAGE_DAMAGED}]` };
    if (header && fits(header.width, header.height, bytes.length)) return block;
    const fitted = await scaled(bytes);
    if (writing && "omitted" in fitted && fitted.transient) return block;
    return "omitted" in fitted ? { type: "text", text: `[image omitted: ${fitted.omitted}]` } : { type: "image", data: fitted.data.toString("base64"), mimeType: fitted.mimeType };
  }

  /**
   * Messages with their image blocks as a request may carry them (`fittedBlock`); the same messages when none needs it.
   * Written to the journal by an agent that keeps images by reference (`savesImages`), each fitted image is saved as a file.
   */
  async function fittedImages<T extends object>(messages: T[], writing = true): Promise<T[]> {
    return Promise.all(messages.map(async message => {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content) || !content.some(block => block?.type === "image")) return message;
      const saving = writing && savesImages();
      const fitted = await Promise.all(content.map(async block => {
        if (block?.type !== "image" || typeof block.data !== "string" || typeof block.mimeType !== "string") return block;
        const fit = await fittedBlock(block, writing);
        return saving ? savedImage(fit) : fit;
      }));
      return fitted.every((block, index) => block === content[index]) ? message : { ...message, content: fitted };
    }));
  }

  /**
   * Whether images the journal is written with are kept by reference (AGENT_PI_IMAGE_REFS_TENANTS): Pi's context then holds a
   * few hundred bytes per image instead of up to megabytes of base64, which its token estimate (and so compaction) does
   * not see. Requests load the file (`hydrate`), so the model gets the same image after a line naming its file. An agent
   * without a writable mount keeps its images inline.
   */
  let unsaved = false;
  function savesImages() {
    if (!imageRefs() || !io.saveImage) return false;
    if (scratchMount(config.mounts)) return true;
    if (!unsaved) console.log(JSON.stringify({ type: "image_kept_inline", agent: config.id, reason: "no writable mount" }));
    unsaved = true;
    return false;
  }

  /** A fitted image as the journal keeps it (`savesImages`): a reference to the file it is saved as, or as it is if it does not fit yet or cannot be saved. */
  async function savedImage<T extends { type: string; data?: string; mimeType?: string }>(block: T): Promise<T | FileRef> {
    if (block.type !== "image" || block.mimeType === "application/pdf") return block;
    const bytes = Buffer.from(block.data!, "base64");
    const header = imageHeader(bytes);
    // One that failed to fit only for now stays inline, for requests to try again (`fittedBlock`).
    if (!header || !fits(header.width, header.height, bytes.length)) return block;
    try {
      const ref = await io.saveImage!({ data: block.data!, mimeType: block.mimeType! });
      if (validFileRef(ref)) return ref;
      throw new Error("Invalid file reference");
    } catch (error) {
      console.error(JSON.stringify({ type: "image_save_failed", agent: config.id, error: errorText(error) }));
      return block;
    }
  }

  /**
   * The model request's files: the history keeps references, and each becomes a line naming it
   * plus, where the model can take it, its bytes as a native block. The same references always
   * give the same request, so the provider's cached prefix holds. Every image, referenced or inline,
   * is within what any provider takes in a request of many images (`fitImage`).
   *
   * One budget covers every image the request carries, inline (a prompt's, a tool result's) or from a file, sized as
   * sent (base64, after scaling down): the newest first, at most `requestImages` of at most `requestImageBase64Bytes`
   * in all. Once one is past it, so is every older one: a referenced file is named but not shown, an inline image becomes
   * `IMAGE_PAST_BUDGET`. Otherwise a history full of images is refused on every turn (OpenRouter's 413 past 30 MB of
   * image content). PDFs have their own budget, `requestFileBytes` (as stored), past which older ones are named.
   */
  async function hydrate(messages: Message[]): Promise<Message[]> {
    documents = false;
    const fitted = await fittedImages(messages, false);
    const imageLimit = requestImageLimit(config.model);
    // What each block shown sends: a file's bytes (or why it is not shown), and the inline images within the budget.
    const sent = new Map<FileRef, Hydrated | Error>();
    const keptInline = new Set<string>();
    let images = 0, imageBytes = 0, imagesFull = false, documentBytes = 0;
    const fitsBudget = (bytes: number) => {
      if (!imagesFull && images < imageLimit && imageBytes + bytes <= FILE_LIMITS.requestImageBase64Bytes) {
        images++; imageBytes += bytes;
        return true;
      }
      imagesFull = true;
      return false;
    };
    type Inline = { type: "image"; data: string; mimeType: string };
    const blocks: { block: FileRef | Inline; key: string }[] = [];
    for (let index = fitted.length - 1; index >= 0; index--) {
      const content = fitted[index].content;
      if (!Array.isArray(content)) continue;
      for (let at = content.length - 1; at >= 0; at--) {
        const block = content[at] as unknown as FileRef | Inline;
        if (block.type === "image" || block.type === "file" && nativeBlock(block, config.model)) blocks.push({ block, key: `${index}:${at}` });
      }
    }
    // Files are read newest first, a few ahead at once, from the host's cache when an earlier request read them: past the
    // image budget, older images are not read at all. One read per file's content, however often the request names it.
    const reads = new Map<string, Promise<Hydrated | Error>>();
    const read = (ref: FileRef) => {
      const key = ref.chunks.join("");
      let pending = reads.get(key);
      if (!pending) reads.set(key, pending = fileData(ref).catch(error => error instanceof Error ? error : new Error(errorText(error))));
      return pending;
    };
    for (const [position, { block, key }] of blocks.entries()) {
      if (block.type === "image") {
        if (block.mimeType === "application/pdf" || fitsBudget(block.data.length)) keptInline.add(key);
        continue;
      }
      const kind = nativeBlock(block, config.model);
      if (kind === "document") {
        if (documentBytes + block.size > FILE_LIMITS.requestFileBytes) continue;
        documentBytes += block.size;
      } else if (imagesFull) continue;
      for (const { block: next } of blocks.slice(position + 1, position + READ_AHEAD)) if (next.type === "file") void read(next);
      const data = await read(block);
      if (kind === "image" && !(data instanceof Error) && "data" in data && !fitsBudget(data.data.length)) continue;
      sent.set(block, data);
    }
    return fitted.map((message, index) => {
      const past = (block: { type: string }, at: number) => block.type === "image" && !keptInline.has(`${index}:${at}`);
      if (!Array.isArray(message.content) || !message.content.some((block, at) => (block.type as string) === "file" || past(block, at))) return message;
      const content: unknown[] = [];
      for (const [at, block] of (message.content as unknown as (FileRef | { type: string })[]).entries()) {
        if (past(block, at)) { content.push({ type: "text", text: IMAGE_PAST_BUDGET }); continue; }
        if (block.type !== "file") { content.push(block); continue; }
        const ref = block as FileRef;
        const kind = nativeBlock(ref, config.model);
        const data = sent.get(ref);
        if (!kind || !data) { content.push({ type: "text", text: describeFile(ref, unseen(ref, config.model) ?? (kind ? `not shown, as this request holds too many ${kind === "image" ? "images" : "files"}; read it to view it` : undefined)) }); continue; }
        if (data instanceof Error) { content.push({ type: "text", text: describeFile(ref, `could not be read (${errorText(data)})`) }); continue; }
        if ("omitted" in data) { content.push({ type: "text", text: describeFile(ref, `image omitted: ${data.omitted}`) }); continue; }
        content.push({ type: "text", text: describeFile(ref) }, { type: "image", data: data.data, mimeType: data.mimeType ?? (kind === "image" && ref.media?.kind === "image" ? ref.media.mimeType : "application/pdf") });
        if (kind === "document") documents = true;
      }
      return { ...message, content } as Message;
    });
  }

  /**
   * The user messages a request adds: given whole, or as text and attached files; marked with its sender (if any), request
   * and metadata, and a prompt's `history: "none"` (only the runtime marks it: see `freshTurn`). A sub-agent's notification
   * (`notice`, only the runtime sends one) is marked with its source and the runtime's metadata instead.
   */
  function userMessages(params: Record<string, any>): AgentMessage[] {
    const notice = params.notice as { source: MessageSource; metadata: Record<string, unknown> } | undefined;
    const marks = notice ? { requestId: params.requestId, metadata: notice.metadata, source: notice.source } : { from: senderInput(params.from), requestId: params.requestId, metadata: params.metadata };
    const marked = (messages: AgentMessage[]) => messages.map(message => {
      const { history: _history, ...rest } = message as AgentMessage & { history?: string };
      return (params.history === "none" ? { ...rest, history: "none" } : rest) as AgentMessage;
    });
    if (params.message !== undefined) {
      const messages = (Array.isArray(params.message) ? params.message : [params.message]) as AgentMessage[];
      validateUserMessages(messages);
      return marked(stamp(messages, marks));
    }
    const files = params.files ?? [];
    if (!Array.isArray(files) || files.length > FILE_LIMITS.attachments || !files.every(validFileRef)) throw new Error("Invalid attached files");
    // A voice message may be only its audio: its transcript is the message.
    const text = typeof params.text === "string" && params.text.trim() ? params.text : undefined;
    if (!text && !files.some((file: FileRef) => file.transcript)) throw new Error("Prompt text is required");
    return marked(stamp([{ role: "user", content: [...text ? [{ type: "text", text }] : [], ...files], timestamp: Date.now() } as AgentMessage], marks));
  }

  /**
   * A structured run whose model ended its turn in text, not with final_output: that answer is taken back, as a failed
   * response is, and the model asked again once, with a reminder in the output section (which the next prompt takes
   * back). Asked again rather than answered: after an answer of its own, some providers would only continue it.
   */
  async function remindOfOutput(signal: AbortSignal) {
    const last = agent!.state.messages.at(-1) as AssistantMessage | undefined;
    if (output || stopped || signal.aborted || last?.role !== "assistant" || last.stopReason !== "stop" || !agent!.state.tools.some(tool => tool.name === OUTPUT_TOOL)) return;
    await journal.refresh();
    if (journal.total <= journal.turnStart + 1) return;
    const reminder: SystemMessage = { role: "system", content: "", sections: { [OUTPUT]: `${OUTPUT_INSTRUCTIONS}\n${OUTPUT_REMINDER}` }, timestamp: Date.now() };
    // The answer leaves history and Pi's context, and the reminder follows, in one commit.
    await journal.commit(() => [{ t: "retract" }, { t: "system", message: reminder }]);
    io.emit({ type: "message_retracted", index: journal.total });
    forcing.reminding = true;
    await agent!.continue();
    await unforced(signal);
    await recoverFailedResponses(signal);
  }

  /**
   * Recover failed responses within the same turn: transient provider failures retry with backoff; an image refusal
   * gets one try without images. The failed response is retracted, so it never becomes history.
   */
  async function recoverFailedResponses(signal: AbortSignal) {
    const policy = config.retry ?? DEFAULT_RETRY;
    let overflowRetried = false;
    for (let attempt = 1; ; attempt++) {
      const last = agent!.state.messages.at(-1) as AssistantMessage | undefined;
      if (signal.aborted || !last || last.role !== "assistant" || last.stopReason !== "error") return;
      // Credit or the context bound refused it: asking again would be refused again.
      if (stopped?.code === END_USER_CREDIT || stopped?.code === CONTEXT_TOO_LARGE) return;
      // Pi retries one overflow per generation. A second refusal learned a smaller window: compact once against it.
      if (isContextOverflow(last, config.model.contextWindow)) {
        if (overflowRetried) return;
        overflowRetried = true;
        await journal.retract();
        io.emit({ type: "message_retracted", index: journal.total });
        if (signal.aborted || await handingOff()) return;
        try { await agent!.compact(signal); }
        catch {
          // Keep the provider's original error as the turn's outcome when recovery fails.
          await journal.push(last);
          io.emit({ type: "message_end", message: last });
          return;
        }
        if (signal.aborted || await handingOff()) return;
        await agent!.continue();
        attempt--;
        continue;
      }
      // Cut by this node's stale lease: made again at once, as its gate allows, and not counted as a provider failure.
      const interrupted = last.errorMessage === MODEL_INTERRUPTED;
      // A provider that cannot read an image in the history refuses every request carrying it, whether it calls that
      // retryable or not: asked once more without images, outside the retry budget; what that ask gets is handled as any.
      if (!omitImages && isImageRejection(last.errorMessage)) {
        omitImages = true;
        console.log(JSON.stringify({ type: "image_rejected", agent: config.id }));
        await journal.retract();
        io.emit({ type: "message_retracted", index: journal.total });
        await agent!.continue();
        attempt--;
        continue;
      }
      // What the API reports as `retryable` (model-errors.ts): a tenant's own endpoint has retried already, so its errors
      // (a credit gate's 402, say) end the turn; a stream that went quiet is retried like any.
      if (!retriesModelError(last, failureContext())) return;
      if (!interrupted && attempt > policy.maxAttempts) {
        io.emit({ type: "auto_retry_end", success: false, attempt: attempt - 1, finalError: last.errorMessage, failure: modelFailure(last, failureContext()) });
        return;
      }
      const delayMs = interrupted ? 0 : policy.baseDelayMs * 2 ** (attempt - 1);
      // A node leaving asks again elsewhere: the failed attempt is taken back, and the turn handed off at that boundary.
      if (await handingOff()) {
        await journal.retract();
        io.emit({ type: "message_retracted", index: journal.total });
        return;
      }
      io.emit({ type: "auto_retry_start", attempt, maxAttempts: policy.maxAttempts, delayMs, errorMessage: last.errorMessage ?? "Unknown error", failure: modelFailure(last, failureContext()) });
      // The failed attempt is not history: drop it from the log and the live state, and say so on the stream.
      await journal.retract();
      io.emit({ type: "message_retracted", index: journal.total });
      try { await clock().sleep(delayMs, { signal }); }
      catch { return; }
      await agent!.continue();
      if ((agent!.state.messages.at(-1) as AssistantMessage | undefined)?.stopReason !== "error") {
        io.emit({ type: "auto_retry_end", success: true, attempt });
      }
    }
  }

  /** Write `messages` (the history's from `from`, where `turns` begin) to the history index, as chunks: where it ends then. */
  async function writeIndex(from: number, messages: AgentMessage[], turns: number[]): Promise<number> {
    let indexed = from;
    for (const chunk of chunksOf({ from, messages, sizes: messages.map(message => JSON.stringify(message).length), turns })) {
      indexed = await io.history!.write(chunk);
      if (indexed !== chunk.start + chunk.messages.length) break;
    }
    return indexed;
  }

  /**
   * The session's history in Pi's journal. A session the host transcript wrote has it retired first (its history before
   * the journal's base indexed from it: `HostJournal.retire`). A new agent's journal (no Pi storage yet, nothing in its
   * legacy log) is seeded here: its Pi context starts from the leading system message `tools` make, after the history
   * it was created with (`initialMessages`); a fork's was seeded as it was made. A session whose history is still only
   * in the legacy format (never imported, or rolled back to the legacy engine by an earlier release) is refused,
   * loudly: this release imports nothing, and starting it empty would lose its history.
   */
  async function open(storage: PiStorage, tools: Tool[]): Promise<HostJournal> {
    if (await HostJournal.retire(storage, { ...(io.history && indexedTo !== undefined ? { indexed: indexedTo, index: async (from, messages, turns) => indexedTo = await writeIndex(from, messages, turns) } : {}),
      legacy: () => io.legacyLog.read() })) console.log(JSON.stringify({ type: "host_transcript_retired", agent: config.id, tenant: config.tenant }));
    const opened = await HostJournal.open(storage);
    if (opened) return opened;
    const legacy = await storage.conversation(SESSION_CONVERSATION_ID, BACKGROUND_CONTEXT) ? "not_on_pi"
      : await io.legacyLog.empty() ? undefined : "legacy_log";
    if (legacy) {
      console.error(JSON.stringify({ type: "legacy_session_not_imported", agent: config.id, tenant: config.tenant, reason: legacy }));
      throw new Error(`${NOT_MIGRATED}: this agent's history is in the legacy format (${legacy === "not_on_pi" ? "its Pi host generation is missing or disabled" : "only its legacy transcript holds it"}), which this release no longer imports. This release cannot start it; nothing was changed`);
    }
    const leadingSystem = leadingSystemMessage(config, tools, nativeSections() ? APPLICATION : INSTRUCTIONS);
    // Pi's context starts with the leading system message: before the history it was created with (`initialMessages`), or
    // with that history's summary, at its cut.
    let messages: AgentMessage[] = [], head: AgentMessage[] = [leadingSystem], headAt = 0;
    if (config.initialMessages?.length) {
      validateInitialMessages(config.initialMessages);
      const imported = importedHistory(config.initialMessages);
      messages = imported.messages;
      if (imported.compaction) {
        head = [leadingSystem, createCompactionSummaryMessage(imported.compaction.summary, imported.compaction.tokensBefore, new Date(imported.compaction.at).toISOString()) as AgentMessage];
        headAt = imported.compaction.cut;
      }
    }
    await seedJournal({ storage, sessionId: config.id, model: convertToLlm(head), messages, headAt });
    const seeded = await HostJournal.open(storage);
    if (!seeded) throw new Error("The agent's Pi storage was seeded without its journal history");
    return seeded;
  }

  async function handle(method: string, params: any): Promise<any> {
    if (method === "init") {
      if (agent) throw new Error("Agent already initialized");
      config = params;
      await mkdir(config.directory, { recursive: true, mode: 0o700 });
      // Where the history index ends: the journal's history past it is indexed from here. One whose index cannot be read
      // now (null) is left for the next start.
      indexedTo = (io.history ? await io.history.indexed().catch(() => null) : null) ?? undefined;
      const piStorage = await io.piStorage?.();
      if (!piStorage) throw new Error("The agent's Pi durable storage is not open");
      const contextLimit = config.contextRangeMaxBytes ?? CONTEXT_RANGE_MAX_BYTES;
      const contextError = async () => {
        const range = await contextRangeSize(piStorage, SESSION_CONVERSATION_ID);
        if (reportContextRange) {
          recordContextRange(config.id, range);
          reportContextRange = false;
        }
        const { bytes } = range;
        return bytes > contextLimit ? contextRangeMessage(bytes, contextLimit) : undefined;
      };
      const requireContextSize = async () => {
        const message = await contextError();
        if (message) throw new Error(`${CONTEXT_TOO_LARGE}: ${message}`);
      };
      // Check before even opening the host journal, and before either Pi reload path can scan its range.
      await requireContextSize();
      // Tools first: a new agent's Pi context starts with the leading system message they make.
      jsExec = codeTool();
      const tools = [...config.codeMode === false ? [] : [jsExec], ...directAgentTools(config.tools)];
      journal = await open(piStorage, tools.map(toToolDeclaration));
      if (indexedTo !== undefined) unindexed = journal.history.sizesFrom(Math.max(indexedTo, journal.history.heldFrom)).reduce((sum, size) => sum + size, 0);
      let recovered = false;
      let resume: { continue: true } | { finished: { messages: number; error: string | null; reply?: string; stopped?: string; output?: unknown } } | undefined;
      if (journal.active && journal.awaiting.length) {
        // The turn had suspended for input when its node stopped: its other calls are closed as unknown, and it stays suspended.
        await closeInterruptedTurn(journal);
        if (config.resume) resume = { finished: { messages: journal.total, error: null, stopped: "input_required" } };
        recovered = true;
      } else if (journal.active && config.resume) {
        // A response cut off when its node stopped is not history; the model is asked again.
        for (let last = await journal.last(); last?.role === "assistant" && ["aborted", "error"].includes(last.stopReason) && journal.total > journal.turnStart; last = await journal.last()) await journal.retract();
        // Answer tool calls whose outcome was lost as unknown, never by running them again; but for calls keyed by the call
        // itself (a delegate call finds the child it started, and collects its answer), made again as the turn continues.
        rerun = openCalls(await journal.since(step)).filter(call => RERUN.includes(call.name));
        await journal.append(interruptedTurnRepairs(await journal.since(step), false, rerun.map(call => call.id)));
        const turn = await journal.since(step);
        const last = turn.at(-1);
        if (rerun.length) resume = { continue: true };
        // At a step boundary the model is simply called again; a final answer (final_output's, too) means the turn had ended.
        else if (last?.role === "toolResult" && last.toolName === OUTPUT_TOOL && !last.isError && journal.total > journal.turnStart) {
          const said = turn.findLast(message => message.role === "assistant") as AssistantMessage | undefined;
          resume = { finished: { messages: journal.total, ...await answer(said), output: (last.details as { output?: unknown } | undefined)?.output } };
          await journal.setActive(false);
        } else if (last && (last.role === "user" || last.role === "toolResult")) resume = { continue: true };
        else {
          if (last?.role === "assistant" && journal.total > journal.turnStart) resume = { finished: { messages: journal.total, ...await answer(last as AssistantMessage) } };
          else await journal.append(interruptedTurnRepairs(turn));
          await journal.setActive(false);
        }
        recovered = true;
      } else if (journal.active) {
        // Close the interrupted turn instead of refusing work until an operator intervenes.
        await closeInterruptedTurn(journal);
        recovered = true;
      }
      // A request whose stream goes quiet ends as a retryable error (model-stream.ts), said on the run's stream as it happens.
      const stream = explicitKeyStream(() => perCall() ? io.modelAuth() : undefined, () => config.modelHeaders, gate,
        (model, reasoning) => streamTimeouts(model, reasoning, config.runLimits, config.streamTimeouts),
        stall => io.emit({ type: "model_stream_stalled", phase: stall.phase, ms: stall.ms, provider: config.model.provider, model: config.model.id }), io.modelOutbound, io.modelAttempt, creditStop);
      const summaryAttempt: ModelAttemptHook | undefined = io.modelAttempt && (event => io.modelAttempt!(
        event.type === "begin" ? { ...event, kind: "compaction" } : event));
      const summaries = explicitKeyStream(() => perCall() ? io.modelAuth() : undefined, () => config.modelHeaders, gate,
        (model, reasoning) => streamTimeouts(model, reasoning, config.runLimits, config.streamTimeouts),
        stall => io.emit({ type: "model_stream_stalled", phase: stall.phase, ms: stall.ms, provider: config.model.provider, model: config.model.id }), io.modelOutbound, summaryAttempt, creditStop);
      // A summary reads the conversation as a turn does: the agent's OpenRouter data policy goes on it too.
      const summaryStream: typeof summaries = (model, context, options) =>
        summaries(model, context, { ...options, ...(config.dataCollection ? { dataCollection: config.dataCollection } : {}) } as typeof options);
      const agentOptions: Omit<DurableAgentOptions, "durable"> = {
        initialState: {
          model: config.model,
          tools, messages: [],
          thinkingLevel: config.thinkingLevel ?? "off",
        },
        // SQL returns only two scalars, so every request checks: one step's tool results (up to ~8 MiB a js_exec)
        // can't carry the range far past the bound. It covers hidden range entries too, without reserializing the context.
        prepareRequest: async () => {
          const message = await contextError();
          if (!message) return;
          stopped = { stopped: "turn_limit", code: CONTEXT_TOO_LARGE, error: message };
          io.emit({ type: "turn_limit_reached", message });
          throw new Error(message);
        },
        getApiKey: () => config.apiKey,
        // Only the tenant's explicit key, never provider keys from the process environment. A model on the
        // tenant's own endpoint gets a fresh identity token for each call, and a key scope's agent its scope's current key.
        // A structured run's request may force final_output (`outputChoice`).
        // The agent's maxOutputTokens and temperature go on each of its own calls (not compaction's summaries), as far as the call takes them.
        streamFn: (model, context, options) => {
          const toolChoice = outputChoice(model);
          const settings = callSettings(model, config, options?.reasoning);
          return stream(model, context, { ...options, ...settings, ...(toolChoice === undefined ? {} : { toolChoice }), ...(config.dataCollection ? { dataCollection: config.dataCollection } : {}) } as typeof options);
        },
        // Renders compaction summaries for the model (the default drops non-chat roles), and each message's sender.
        convertToLlm: messages => hydrate(convertToLlm(renderMessages(messages))),
        onPayload: payload => documents ? documentPayload(payload) : undefined,
        // A turn with calls waiting on a person suspends; one past a spend cap or its run's limits (responses, time) stops before the next model request, after this response's tool results.
        finishTurn: async turn => {
          await journal.refresh();
          if (journal.awaiting.length) {
            stopped = { stopped: "input_required" };
            return { action: "end" };
          }
          // An answer in the run's schema ends it.
          const answered = turn.toolResults.findLast(result => result.toolName === OUTPUT_TOOL && !result.isError);
          if (answered) {
            output = { value: (answered.details as { output: unknown }).output };
            return { action: "end" };
          }
          if (!turn.toolResults.length && !agent!.hasQueuedMessages()) return;
          let limit: RunStop | undefined;
          try { limit = await io.runLimit(); }
          catch { return; /* Unknown spend never stops a turn. */ }
          if (!limit) return;
          if (limit.stopped === "handoff") {
            // Messages queued for the turn live only in this process: they go in at the next step, and the turn is handed off after it.
            if (agent!.hasQueuedMessages()) return;
            stopped = { stopped: "handoff" };
            return { action: "end" };
          }
          stopped = { stopped: limit.stopped, error: limit.message, ...stopFields(limit) };
          io.emit({ type: `${limit.stopped}_reached`, message: limit.message });
          return { action: "end" };
        },
        sessionId: config.id,
        toolExecution: "parallel",
      };
      await requireContextSize();
      agent = await DurableAgent.create({ ...agentOptions, durable: {
        storage: piStorage, conversationId: SESSION_CONVERSATION_ID, cursor: journal.history.latest, written: () => journal.written,
        leading: () => leading(agent ? undefined : tools.map(toToolDeclaration)), view: messages => freshView(messages, fresh),
        onContextRequest: (held, sent) => contextMetrics.request(held, sent),
        // Pi's journal failed a write or read: what the host holds is no longer known to be stored, as when one of its own
        // writes fails. The run ends with PERSISTENCE_FAILED and the session gives the agent up.
        onStorageFailure: error => { journal.failed ??= error; },
        // Summaries share credential/network gates but not the run's output
        // schema, temperature or max-output settings.
        summaryStream,
        nativeSections: nativeSections(),
        get contextWindow() { return compactionModel().contextWindow; },
        get maxOutputTokens() { return config.maxOutputTokens ?? undefined; },
        onSummary: message => io.emit({ type: "compaction_usage", provider: message.provider,
          model: message.model, usage: message.usage, timestamp: message.timestamp, durable: true }),
        onCompaction: async ({ keptMessages, reason }) => {
          // Pi compacts after a context overflow with the refused response in its journal: as the legacy loop did, that
          // response is taken back from history, and the stream told so.
          const refused = await journal.last() as AssistantMessage | undefined;
          if (reason === "overflow" && refused?.role === "assistant" && refused.stopReason === "error" && isContextOverflow(refused) && journal.total > journal.turnStart) {
            await journal.retract();
            io.emit({ type: "message_retracted", index: journal.total });
          }
          // The context as the agent held it when Pi compacted it: its history messages less those the summary keeps.
          const before = agent!.state.messages;
          const held = before.filter(message => message.role !== "system" && !isSummary(message)).length;
          console.error(JSON.stringify({ type: "compaction_end", agent: config.id, reason, contextTokens: agent!.contextTokens }));
          io.emit({ type: "compaction_end", contextTokens: agent!.contextTokens, reason, tokensBefore: contextTokens(before), keptMessages, summarizedMessages: Math.max(0, held - keptMessages) });
        },
      } });
      // What Pi settles for a run it was interrupted in is not history: the host closed that turn itself, above.
      await journal.refresh();
      const latest = journal.history.latest, before = agent.latestCursor;
      await requireContextSize();
      const cursor = await agent.discardInterruptedRun();
      if (cursor && !sameCursor(cursor, before)) await journal.skip(cursor, latest);
      agent.subscribe(async event => {
        if ((event.type === "message_start" || event.type === "message_update" || event.type === "message_end") && event.message.role === "system") {
          // Pi declares a tool set that no longer matches the context's; it stays in place like the runtime's own changes.
          if (event.type === "message_end") {
            try { await journal.system(event.message); }
            catch (error) { agent!.abort(); throw error; }
          }
          return;
        }
        // A turn handed off at a step boundary goes on elsewhere: for its subscribers it has not ended.
        if (event.type === "agent_end" && stopped?.stopped === "handoff") return;
        // A call waiting on input has no result yet: the journal keeps it open instead (`awaiting`).
        if (event.type === "message_end" && event.message.role === "user") steers = steers.filter(steer => steer.message !== event.message);
        // Pi's journal holds each finished message as Pi commits it; streaming deltas are never persisted.
        if (event.type === "message_end" && !(event.message.role === "toolResult" && (event.message.details as { inputRequired?: boolean } | undefined)?.inputRequired)) {
          unindexed += JSON.stringify(event.message).length;
          void index();
        }
        // A failed response's event says how it failed, for callers that would otherwise parse its message.
        io.emit(event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error" ? { ...event, failure: modelFailure(event.message, failureContext()) } : event);
      });
      // final_output, declared by a prompt with an output schema, stays until a prompt without one.
      const kept = getCurrentTools(agent.state.messages).find(tool => tool.name === OUTPUT_TOOL);
      if (kept && !config.tools.some(tool => tool.name === OUTPUT_TOOL)) agent.state.tools = [...agent.state.tools, outputTool(kept.parameters)];
      // A configuration changed elsewhere (another node, or while this agent was stopped) applies from here.
      await declareConfiguration();
      void index();
      await journal.refresh();
      return { pid: process.pid, recovered, messages: journal.total, ...(resume ? { resume } : {}), ...(!recovered && config.resume ? await endedTurn() : {}) };
    }
    if (!agent) throw new Error("Agent is not initialized");
    if (method === "status") {
      await journal.refresh();
      return { pid: process.pid, busy, messages: journal.total, contextMessages: agent.state.messages.length, compacted: agent.state.messages.some(isSummary) };
    }
    if (method === "configure") {
      if (busy) throw new Error("Agent is busy");
      if (params.systemPrompt !== undefined) config.systemPrompt = params.systemPrompt ?? undefined;
      if (params.systemPromptAppend !== undefined) config.systemPromptAppend = params.systemPromptAppend;
      if (params.fileTools !== undefined) config.fileTools = params.fileTools;
      if (params.codeMode !== undefined) config.codeMode = params.codeMode;
      if (params.model !== undefined) { config.model = params.model; agent.state.model = params.model; }
      if (params.thinkingLevel !== undefined) { config.thinkingLevel = params.thinkingLevel; agent.state.thinkingLevel = params.thinkingLevel; }
      if (params.apiKey !== undefined) config.apiKey = params.apiKey;
      if (params.modelHeaders !== undefined) config.modelHeaders = params.modelHeaders;
      // Its stream timeouts apply from the next model request.
      if (params.runLimits !== undefined) config.runLimits = params.runLimits;
      if (params.maxOutputTokens !== undefined) config.maxOutputTokens = params.maxOutputTokens;
      if (params.temperature !== undefined) config.temperature = params.temperature;
      if (params.dataCollection !== undefined) config.dataCollection = params.dataCollection;
      if (params.tools !== undefined) config.tools = params.tools;
      if (params.tools !== undefined || params.codeMode !== undefined) agent.state.tools = [...config.codeMode === false ? [] : [jsExec!], ...directAgentTools(config.tools)];
      if (params.systemPrompt !== undefined || params.systemPromptAppend !== undefined || params.tools !== undefined || params.codeMode !== undefined || params.model !== undefined) await declareConfiguration();
      return { configured: true };
    }
    // Before a stop: index the settled turns, so a page of them needs neither the process nor the journal.
    if (method === "historyFlush") { await index(true); return null; }
    // What the history index lacks yet: the running turn, and anything a failed write left. Null when nothing indexes the
    // agent, or the journal does not hold it all.
    if (method === "historyTail") {
      if (indexedTo === undefined) return null;
      await journal.refresh();
      const from = indexedTo, messages = await journal.history.messagesFrom(from);
      return messages ? { from, messages, turns: journal.history.turnsFrom(from) } : null;
    }
    if (method === "steer") {
      const messages = await fittedImages(userMessages(params));
      // A prompt sent `whileRunning: "steer"`: only for the running turn, and only while it can still take it.
      if (params.whileRunning === "steer" && !steerable) return { steered: false };
      // Pi queues the rest whether or not a run is active; an idle queue drains into the next run.
      for (const message of messages) {
        agent.steer(message);
        steers.push({ message, whileRunning: params.whileRunning === "steer" });
      }
      return params.whileRunning === "steer" ? { steered: true } : { queued: true, running: busy };
    }
    // The node's lease went stale: its model requests in flight are cut, and made again once it is fresh (`recoverFailedResponses`).
    if (method === "interrupt") {
      const open = [...gate.open];
      gate.open.clear();
      for (const request of open) request.abort();
      return { interrupted: open.length };
    }
    if (method === "abort") {
      // The runtime's own stop of a run past its time limit: the run ends as that limit's, not as aborted.
      if (busy && (params?.stopped === "turn_limit" || params?.stopped === "spend_limit")) stopped = { stopped: params.stopped, error: String(params.message ?? ""), code: params.stopped };
      // A stop of the agent (not just its turn): messages held for the turn or the next one are dropped too, so nothing runs after it.
      if (params?.clearQueued) {
        steers = [];
        agent.clearAllQueues();
      }
      active?.abort();
      agent.abort();
      return { aborted: true };
    }
    if (method !== "prompt" && method !== "execute" && method !== "continue" && method !== "resume") throw new Error(`Unknown method: ${method}`);
    if (busy) throw new Error("Agent is busy");
    if (journal.failed !== undefined) throw new Error(`${PERSISTENCE_FAILED}: ${String(journal.failed)}`);
    // A prompt a turn took as a steer before the node running it stopped: it is in the history already, compacted or not.
    if (method === "prompt" && params.requestId && await journal.hasRequest(params.requestId)) {
      await journal.refresh();
      return { messages: journal.total, error: null, taken: true };
    }
    const promptMessages = method === "prompt" ? userMessages(params) : undefined;
    busy = true;
    contextMetrics.reset();
    reportContextRange = true;
    stopped = undefined;
    refused = undefined;
    omitImages = false;
    output = undefined;
    forcing = { left: FORCED_OUTPUT_REQUESTS, reminding: false, last: false };
    active = new AbortController();
    try {
      // Aborted before this host had it (its session's `aborted`): a turn resumed from the journal is open here, and is closed.
      if (method === "continue" && params?.aborted) return await abortedBeforeLoop();
      // A notification's turn the runtime refused as it landed (a cap), resumed here: closed without the model.
      if (method === "continue" && params?.landOnly) {
        const { stopped: why, message: said } = params.landOnly as RunStop;
        const done = await abortedBeforeLoop();
        return { ...done, error: said, stopped: why, ...stopFields(params.landOnly) };
      }
      if (method === "prompt") await useOutput(params.output?.schema);
      if (method === "execute") {
        const { returned: _returned, cpuMs: _cpuMs, ...result } = await runCode({ ...codeRequest(params), bridge: bridge(active.signal), signal: active.signal, onEvent: event => io.emit(event) });
        return result;
      }
      if (method === "continue" && journal.awaiting.length) throw new Error("The agent is waiting for input: answer it, or send a new prompt");
      await journal.setActive(true);
      // Where the run's messages start in the agent's history, so a client can line up its stream with history pages.
      io.emit({ type: "turn_opened", index: journal.total });
      steerable = true;
      if (method === "resume") {
        const settled = await settle(params.calls ?? [], active.signal);
        // Closed without the model (expired or cancelled inputs), still waiting, or nothing left to resume.
        if (params.close || journal.awaiting.length || !settled) {
          await journal.setActive(false);
          return { messages: journal.total, error: null, ...(journal.awaiting.length ? { stopped: "input_required" } : {}) };
        }
        fresh = await freshTurn();
        if (active.signal.aborted) return await abortedBeforeLoop();
        // The answered calls were this run's step: a node leaving hands the turn off before the model is asked.
        if (await handingOff()) return handedOff();
        await agent.continue();
      } else if (method === "continue") {
        if (active.signal.aborted) return await abortedBeforeLoop();
        if (rerun.length) {
          await rerunOpenCalls(active.signal);
          if (await handingOff()) return handedOff();
        }
        if (active.signal.aborted) return await abortedBeforeLoop();
        fresh = await freshTurn();
        await agent.continue();
      }
      else {
        // A new message supersedes calls still waiting on input: each is closed first, so the model sees why.
        if (journal.awaiting.length) {
          await settle(journal.awaiting.map(toolCallId => ({ toolCallId, result: { content: [{ type: "text", text: "Not answered: the user sent a new message instead (next)." }], isError: true } })), active.signal);
        }
        if (active.signal.aborted) return await abortedBeforeLoop();
        if (params.landOnly) {
          // The runtime's refusal of a turn its message would start (a cap reached): the message lands in history, and no model is asked.
          const messages = await fittedImages(promptMessages!);
          for (const message of messages) {
            io.emit({ type: "message_start", message });
            await journal.push(message);
            io.emit({ type: "message_end", message });
          }
          await journal.setActive(false);
          const { stopped: why, message: said } = params.landOnly as RunStop;
          return { messages: journal.total, error: said, stopped: why, ...stopFields(params.landOnly) };
        }
        // Images enter the journal as requests carry them: scaled down once here, not on every request after.
        const messages = await fittedImages(promptMessages!);
        if (params.history === "none") fresh = messages[0];
        await agent.prompt(messages);
      }
      await unforced(active.signal);
      await recoverFailedResponses(active.signal);
      await remindOfOutput(active.signal);
      // Stopped at a step boundary for another node to continue (in any of the model calls above): the turn stays open
      // (active) in the journal.
      if (handedOffHere()) {
        if (journal.failed !== undefined) throw journal.failed;
        return handedOff();
      }
      if (journal.failed !== undefined) throw journal.failed;
      await journal.setActive(false);
      // Set by finishTurn as the turn ran.
      const given = output as { value: unknown } | undefined;
      // A suspended turn ends on its open calls, and a structured answer on final_output's result: what the model said as it made them is the reply.
      const last = (journal.awaiting.length || given ? agent.state.messages.findLast(message => message.role === "assistant") : agent.state.messages.at(-1)) as AssistantMessage | undefined;
      // A failed model call fails the run, whether Pi kept its error or only the message does.
      const answered = await answer(last);
      const error = agent.state.errorMessage ?? answered.error;
      // A run that asked for structured output and ended without it, nor stopped for a reason of its own, failed.
      const missing = !given && !error && !stopped && agent.state.tools.some(tool => tool.name === OUTPUT_TOOL);
      // Why it failed, when the remedy is the caller's (a key) or worth telling apart: a model whose stream went quiet past
      // every retry, or a run aborted (stopped by its caller).
      const failure = error ? error.startsWith(`${CONTEXT_LOST}:`) ? { code: CONTEXT_LOST } : modelKeyFailure(error, config.model) ?? (isStalled(error) ? { code: "model_stream_stalled" } : active.signal.aborted || last?.stopReason === "aborted" ? { code: "aborted" } : {}) : {};
      return {
        messages: journal.total, ...answered, error, ...failure, ...(stopped ?? {}), ...(given ? { output: given.value } : {}),
        ...(missing ? { error: `The model ended its turn without calling ${OUTPUT_TOOL}, so the run has no output in its schema`, code: "output_missing" } : {}),
      };
    } finally {
      if (refused) { hostIO.emit(refused); refused = undefined; }
      // Steers sent for this turn that it did not take are taken back: each runs as a turn of its own.
      steerable = false;
      if (steers.some(steer => steer.whileRunning)) {
        agent.clearSteeringQueue();
        steers = steers.filter(steer => !steer.whileRunning);
        for (const steer of steers) agent.steer(steer.message);
      }
      fresh = undefined;
      await io.cancelTools();
      active = undefined;
      busy = false;
      if (method !== "execute") void index();
    }
  }

  /** Whether the current run stopped for a hand-off (a function, so the check is not narrowed away across awaits). */
  const handedOffHere = () => stopped?.stopped === "handoff";

  /** Whether the node is leaving, so the running turn stops at this step boundary (`RunStop` "handoff"). */
  async function handingOff() {
    if ((await io.runLimit().catch(() => undefined))?.stopped !== "handoff") return false;
    stopped = { stopped: "handoff" };
    return true;
  }

  /**
   * A turn stopped at a step boundary for the next owner: left open (active) in the journal, whose last message is a
   * tool result or the user's, so the next owner calls the model again with nothing lost (see `init`'s resume).
   */
  async function handedOff() {
    await journal.refresh();
    return { messages: journal.total, error: null, handedOff: true };
  }

  /**
   * An abort that came after the run began but before Pi's loop did: Pi's own abort found no loop to stop, so the run ends
   * here, checked in the same tick as each loop starts. The turn is settled in the journal before the run is seen to
   * end: a turn resumed from it (a lost node's) may still have calls open, those to make again (`RERUN`) among them, which
   * are closed as unknown, never made; calls waiting on a person stay open.
   */
  async function abortedBeforeLoop() {
    rerun = [];
    const repairs = interruptedTurnRepairs(await journal.since(step), false, journal.awaiting);
    if (repairs.length) await journal.append(repairs);
    if (journal.active) await journal.setActive(false);
    return { messages: journal.total, error: "The run was aborted", code: "aborted", ...(stopped ?? {}) };
  }

  type Settled = { content: unknown[]; isError?: boolean; details?: unknown };
  /**
   * Give calls waiting on input their results, in the order the model made them: a ready result (an
   * answer, or why there is none), or, with `retry`, the call run again now (an approved call, or a
   * tool's own request retried with its answers). A retried call is released first, so a crash while
   * it runs leaves it open to be closed as unknown, never run twice. Returns how many calls it settled.
   */
  async function settle(calls: { toolCallId: string; result?: Settled; retry?: boolean }[], signal: AbortSignal) {
    // The calls waiting, as the model made them: in the assistant messages that made them, in order.
    await journal.refresh();
    const made: ToolCall[] = [];
    for (const at of [...new Set(journal.awaiting.map(id => journal.callIndex(id)).filter((at): at is number => at !== undefined))].sort((a, b) => a - b)) {
      const message = (await journal.history.messagesFrom(at, at + 1))?.[0];
      if (message?.role === "assistant") made.push(...message.content.filter(part => part.type === "toolCall") as ToolCall[]);
    }
    const position = (id: string) => made.findIndex(part => part.id === id);
    const wanted = calls.filter(call => journal.awaiting.includes(call.toolCallId)).sort((a, b) => position(a.toolCallId) - position(b.toolCallId));
    const retried = wanted.filter(call => call.retry).map(call => call.toolCallId);
    if (retried.length) await journal.await(retried, true);
    for (const call of wanted) {
      const toolCall = made.find(part => part.id === call.toolCallId);
      // The call ends now, as any call does on the stream: a start, then its end, then its result's message.
      io.emit({ type: "tool_execution_start", toolCallId: call.toolCallId, toolName: toolCall?.name ?? "", args: toolCall?.arguments ?? {} });
      let result = call.result;
      if (!result) {
        const tool = agent!.state.tools.find(entry => entry.name === toolCall?.name && entry.name !== "js_exec");
        try {
          if (!tool || !toolCall) throw new Error(`${toolCall?.name ?? "This tool"} is no longer available to this agent`);
          // The arguments as Pi gave them the first time: the approval is bound to them (inputs.ts).
          result = await tool.execute(call.toolCallId, checkedArguments(tool, toolCall), signal) as Settled;
        } catch (error) { result = { content: [{ type: "text", text: errorText(error) }], isError: true }; }
        // Asked again (another round of input): the call stays open, as it did the first time.
        if ((result!.details as { inputRequired?: boolean } | undefined)?.inputRequired) {
          io.emit({ type: "tool_execution_end", toolCallId: call.toolCallId, toolName: toolCall?.name ?? "", result, isError: false });
          continue;
        }
      }
      io.emit({ type: "tool_execution_end", toolCallId: call.toolCallId, toolName: toolCall?.name ?? "", result, isError: !!result!.isError });
      const message = { role: "toolResult", toolCallId: call.toolCallId, toolName: toolCall?.name ?? "", content: result!.content, ...(result!.details !== undefined ? { details: result!.details } : {}), isError: !!result!.isError, timestamp: Date.now() } as AgentMessage;
      await journal.push(message);
      io.emit({ type: "message_end", message });
    }
    return wanted.length;
  }

  /**
   * The last turn, when it ended before its node was lost: whose it was (the prompts its user messages carry, the calls whose
   * results it holds) and what it ended with, so a run resumed here that never recorded its end takes that outcome, not an
   * unknown one.
   */
  async function endedTurn() {
    if (journal.active || journal.total <= journal.turnStart) return {};
    const turn = await journal.turnMessages();
    const said = turn.findLast(message => message.role === "assistant") as AssistantMessage | undefined;
    const given = turn.findLast(message => message.role === "toolResult" && message.toolName === OUTPUT_TOOL && !message.isError) as ToolResultMessage | undefined;
    return { ended: {
      requests: turn.flatMap(message => message.role === "user" && (message as { requestId?: string }).requestId ? [(message as { requestId?: string }).requestId!] : []),
      calls: turn.flatMap(message => message.role === "toolResult" ? [message.toolCallId] : []),
      finished: {
        messages: journal.total, ...await answer(said), ...(journal.awaiting.length ? { stopped: "input_required" } : {}),
        ...(given ? { output: (given.details as { output?: unknown } | undefined)?.output } : {}),
      },
    } };
  }

  /**
   * The final answer's text, for callers that relay it (channels), and that message's index in the history; the model
   * that made it (`servedModel`, as `provider/model-id`: retries ask the same one); and when it failed, how (`modelError`).
   */
  async function answer(last: AssistantMessage | undefined) {
    const said = last?.role === "assistant" ? last : undefined;
    const reply = said && said.stopReason !== "error" ? said.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim() : "";
    // Its index in the history: the turn's latest such message, read back from the history's end.
    let at = -1;
    if (reply) {
      await journal.refresh();
      for (let index = journal.total - 1; index >= Math.max(journal.turnStart, journal.history.heldFrom) && at < 0; index--) {
        if (sameMessage((await journal.history.messagesFrom(index, index + 1))?.[0], last)) at = index;
      }
    }
    const failed = said?.stopReason === "error";
    return {
      error: failed ? said.errorMessage ?? "The model returned an error" : null, ...(reply ? { reply } : {}), ...(at >= 0 ? { replyIndex: at } : {}),
      ...(said ? { servedModel: `${said.provider}/${said.model}` } : {}), ...(failed ? { modelError: modelFailure(said, failureContext()) } : {}),
    };
  }

  /**
   * Stop serving: abort the run and close Pi's journal, so nothing more is written. An interrupted turn stays marked
   * active and is recovered on next load.
   */
  async function dispose(flushMs = HISTORY_FLUSH_MS) {
    active?.abort();
    agent?.abort();
    await io.cancelTools();
    // Its settled turns are indexed while the journal is still open.
    if (flushMs > 0 && agent) await Promise.race([index(true), clock().sleep(flushMs)]);
    await agent?.close();
  }

  /** Once a journal write failed, any request it ends says so, for the session to give the agent up (and reload it). */
  async function handled(method: string, params: any): Promise<any> {
    try { return await handle(method, params); }
    catch (error) {
      if (journal?.failed !== undefined && !errorText(error).startsWith(PERSISTENCE_FAILED)) throw new Error(`${PERSISTENCE_FAILED}: ${errorText(error)}`);
      throw error;
    }
  }

  return { handle: turns.wrap(handled), dispose };
}

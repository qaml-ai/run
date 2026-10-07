import { mkdir } from "node:fs/promises";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "./pi-harness/messages.ts";
import {
  getCurrentSystemMessage, getCurrentTools, getSystemMessageText, getToolStateChanges, isContextOverflow, isRetryableAssistantError, toToolDeclaration, validateToolArguments,
  type AssistantMessage, type Message, type SystemMessage, type Tool, type ToolCall,
} from "@earendil-works/pi-ai";
import { executeCode, presentResult, type CodeResult } from "./codemode.ts";
import { scriptValue } from "./mcp-results.ts";
import { errorText, IDENTITY_KEY, SCOPE_KEY, type AgentConfig, type CallContext, type Credentials, type RunStop, type ToolBridge } from "./protocol.ts";
import { applicationInstructions, ENVIRONMENT, environmentSummary, INSTRUCTIONS, leadingSystemMessage, OUTPUT, OUTPUT_INSTRUCTIONS, OUTPUT_REMINDER, OUTPUT_TOOL } from "./system-prompt.ts";
import { renderMessages, senderInput, stamp } from "./sender.ts";
import type { SearchHit, SearchQuery } from "./tool-search.ts";
import type { AppendLog } from "../shared/append-log.ts";
import { Transcript, readTranscriptLog, summaryMessage, type Backlog, type CompactionState, type TranscriptRecord } from "./transcript.ts";
import { boundedContext, importedHistory, interruptedTurnRepairs, validateInitialMessages, validateUserMessages } from "./history.ts";
import { backgroundTokens, compactionNeed, compactionSettings, contextTokens, explicitKeyStream, MODEL_INTERRUPTED, modelKeyFailure, runCompaction, type ModelGate } from "./compaction.ts";
import { codeRequest, DEFAULT_RETRY, SANDBOX_LIMITS } from "./limits.ts";
import { isStalled, streamTimeouts } from "./model-stream.ts";
import { forcedToolChoice } from "./tool-choice.ts";
import { describeFile, documentPayload, FILE_LIMITS, nativeBlock, unseen, validFileRef, type FileRef } from "./files.ts";
import { CHUNK_BYTES, chunksOf, type HistoryChunk } from "./history-pages.ts";
import { observeTurns, recordCodeExecution } from "./metrics.ts";
import { fitImage, fits, type Fitted } from "./inspect.ts";
import { imageHeader } from "./image-header.ts";
import { clock } from "./node-context.ts";

/** How often an agent reads back from its log what its history backlog could not hold (see `index`). */
const LAG_READ_MS = 60_000;
/** How long a stopping agent waits to index its settled turns (see `index`). */
export const HISTORY_FLUSH_MS = 5_000;

/** Model requests of one structured run that may force final_output (see `outputChoice`). */
const FORCED_OUTPUT_REQUESTS = 3;

/** Images one agent scales down at once for its requests (`fitImage`). */
const FIT_CONCURRENCY = 2;
/** A file as requests carry it: its bytes (base64; an image's type if it was scaled down), or why an image is omitted. */
type Hydrated = { data: string; mimeType?: string } | { omitted: string };
const hydratedSize = (value: Hydrated) => "data" in value ? value.data.length : value.omitted.length;
const hydratedImage = (fitted: Fitted): Hydrated => "omitted" in fitted ? { omitted: fitted.omitted } : { data: fitted.data.toString("base64"), mimeType: fitted.mimeType };

/** How a host talks to its supervisor: over IPC in its own process, or directly when inline. */
export interface HostIO {
  emit(event: unknown): void;
  /** Dispatch an application tool through the supervisor, which validates and limits it. */
  tool(name: string, args: Record<string, unknown>, call?: CallContext): Promise<any>;
  /** Abort the application tool calls this agent has in flight. */
  cancelTools(): Promise<unknown>;
  /** Why the running turn must end before its next model request (a reached spend cap, the run's own limits, or its node leaving), if so. */
  runLimit(): Promise<RunStop | undefined>;
  /** The agent's transcript, which its supervisor writes. */
  transcript: AppendLog<TranscriptRecord>;
  /** `tools.search`, answered by the supervisor (which holds the rerankers); without it, code searches here. */
  search?(query: SearchQuery): Promise<SearchHit[]>;
  /** A file reference's bytes as base64, read by the supervisor: the agent holds no storage access. */
  file(ref: FileRef): Promise<string>;
  /** Credentials for one model call of an agent whose key is resolved per call: an identity token the supervisor signs, or its key scope's entry. */
  modelAuth(): Promise<Credentials>;
  /** js_exec's `fs`, answered by the supervisor over the agent's mounts. */
  fs(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** Wait for the tenant's turn to run js_exec on the node, until `signal` aborts; resolves with the function that gives it back. */
  codeSlot?(signal: AbortSignal): Promise<() => void>;
  /** Wait until the node may act for the agent (its lease is fresh), before each model request and js_exec; rejects once it lost the agent. */
  lease?(): Promise<void>;
  /** The agent's history index, which the supervisor writes: how many messages it has (null: it has none yet, or none is kept), and a chunk to add. */
  history?: { indexed(): Promise<number | null>; write(chunk: HistoryChunk): Promise<number>; read(from: number): Promise<Backlog> };
}

/** Tools a lost node's open call to is made again on resume, not closed as unknown: each is keyed by its call (multi-agent.ts). */
export const RERUN = ["delegate"];

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
 * One agent: its Pi loop, working-set transcript, compaction and retries. It runs
 * in its own process (agent-child.ts) or inline in a worker hosting many agents.
 */
export function createAgentHost(hostIO: HostIO) {
  let agent: Agent | undefined;
  let config: AgentConfig;
  // Each turn's outcome, timing and model and tool counts, as metrics (metrics.ts), from what the host emits.
  const turns = observeTurns(() => config?.model && { provider: config.model.provider, id: config.model.id }, Date.now, () => config?.tenant);
  const io: HostIO = { ...hostIO, emit: event => { turns.event(event); hostIO.emit(event); } };
  let transcript: Transcript;
  let busy = false;
  let active: AbortController | undefined;
  /** Why the current run ended early: a spend limit, tool calls waiting on a person's input, or a hand-off (its node is leaving). */
  let stopped: { stopped: RunStop["stopped"] | "input_required"; error?: string; code?: string } | undefined;
  /** Messages a compaction folded into the summary during the current run, still in Pi's live state. */
  let dropped = new WeakSet<AgentMessage>();
  let summary: { state: CompactionState; message: AgentMessage } | undefined;
  /** Files' bytes (base64) by content, as requests carry them, least recently used first, kept between model requests. */
  const hydrated = new Map<string, Hydrated>();
  let hydratedBytes = 0;
  /** Images being scaled down for requests, and those waiting to be (`scaled`). */
  let fitting = 0;
  const waitingToFit: (() => void)[] = [];
  /** Whether the model request being built carries a PDF, whose block the provider payload needs rewritten. */
  let documents = false;
  /** History index writes, one at a time. */
  let indexing = Promise.resolve();
  /** When messages the backlog left to the log were last read back (see `index`). */
  let lagRead = 0;
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
  /** In a run with history: "none", the system message as it stands: its requests lead with it, and carry only the run's own messages (`freshTurn`). */
  let fresh: SystemMessage | undefined;
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
   * Add what the history index lacks to it, in the background. Like the log's own segments, chunks
   * are written when the backlog has grown past one (all but the latest message, the only one a retry
   * retracts) and when the agent stops (`final`: the settled turns), never per turn. A failed write
   * is tried again with the next; what a crash leaves out is indexed at the next start. Messages the
   * backlog left to the log (more than it holds: an index far behind) are read back from the log and
   * indexed first, a chunk at a time, at most once a minute and as the agent stops.
   */
  function index(final = false): Promise<void> {
    const history = io.history;
    if (!history || !transcript) return Promise.resolve();
    /** Add chunks in order; false when the index took less than a chunk (another writer, a gap): the rest waits for the next pass. */
    const write = async (chunks: HistoryChunk[]) => {
      for (const chunk of chunks) {
        const indexed = await history.write(chunk);
        transcript.indexed(indexed);
        if (indexed !== chunk.start + chunk.messages.length) return false;
      }
      return true;
    };
    return indexing = indexing.then(async () => {
      const backlog = transcript.backlog;
      if (backlog && backlog.kept > backlog.from) {
        if (!final && Date.now() - lagRead < LAG_READ_MS) return;
        lagRead = Date.now();
        // Read apart from the transcript's own log, so the running turn's appends do not wait behind it.
        const past = await history.read(backlog.from);
        // A turn cut off by the stop is settled at the next start, with its repairs; while the agent runs, its latest
        // message (which a retry may take back) waits, as it does in memory.
        const upto = final ? (transcript.active ? Math.min(backlog.kept, transcript.turnStart) : backlog.kept) : Math.min(backlog.kept, transcript.total - 1);
        if (!await write(chunksOf(past, Math.max(0, Math.min(upto - backlog.from, past.messages.length)))) || backlog.kept > backlog.from) return;
      }
      if (!backlog?.messages.length || (!final && backlog.bytes < CHUNK_BYTES)) return;
      // A turn cut off by the stop is settled at the next start, with its repairs.
      const count = !final ? backlog.messages.length - 1 : transcript.active ? Math.max(0, transcript.turnStart - backlog.from) : backlog.messages.length;
      await write(chunksOf(backlog, count));
    }).catch(error => console.error(JSON.stringify({ type: "history_index_failed", agent: config.id, error: errorText(error) })));
  }

  function summaryView(): AgentMessage[] {
    const state = transcript.compaction;
    if (!state) return [];
    if (summary?.state !== state) summary = { state, message: summaryMessage(state) };
    return [summary.message];
  }

  /**
   * The context's first system message, the start of the provider's cached prefix. It is built
   * from configuration until the prompt or tools change with history; the transcript then pins
   * it, and each change follows as a system message of its own where the conversation stood.
   */
  function leading(tools: Tool[] = agent!.state.tools.map(toToolDeclaration)): SystemMessage {
    return transcript.system ?? leadingSystemMessage(config, tools);
  }

  /** Pi's messages from the transcript: what a run starts from. */
  function stateMessages(): AgentMessage[] { return [leading(), ...transcript.view()]; }

  /** The model's context: the leading system message, the current summary, and live messages not yet folded into it. A fresh run's: its own system message and messages. */
  function liveView(messages: AgentMessage[]): AgentMessage[] {
    return [fresh ?? leading(), ...fresh ? [] : summaryView(), ...messages.filter((message, index) => !(index === 0 && message.role === "system") && message.role !== "compactionSummary" && !dropped.has(message))];
  }

  /**
   * Begin a run that sees no history (a prompt's history: "none", which its user message records): Pi's state is the
   * system message as it stands (the leading one with every change since), then the run's own messages, from `first` on.
   * Its messages are still history, which later runs see. Continued or resumed, a turn whose last user message says so
   * stays fresh; undefined (the whole history) otherwise.
   */
  function freshTurn(first?: AgentMessage): AgentMessage[] | undefined {
    first ??= transcript.context.findLast(message => message.role === "user");
    if ((first as { history?: string } | undefined)?.history !== "none") return undefined;
    const all = stateMessages();
    const at = all.indexOf(first!);
    fresh = getCurrentSystemMessage(at < 0 ? all : all.slice(0, at))!;
    return [fresh, ...at < 0 ? [] : all.slice(at)];
  }

  /** Record a system message after the leading one, pinning `current` as that first, in one commit (`Transcript.declareSystem`). */
  function declare(message: SystemMessage, current: SystemMessage): Promise<void> {
    return transcript.declareSystem(message, current);
  }

  /**
   * Bring the system messages in line with the configuration. Without history the leading message
   * is rebuilt; with history a change is appended, so the cached prefix stays byte-identical. `durable`
   * appends the change even without history: a tool the configuration does not hold (final_output) is
   * declared only by the transcript, so another node continuing the turn finds it.
   */
  async function declareConfiguration(durable = false): Promise<void> {
    const messages = agent!.state.messages;
    const tools = agent!.state.tools.map(toToolDeclaration);
    if (!durable && !transcript.total && !transcript.compaction) {
      agent!.state.messages = [leadingSystemMessage(config, tools), ...messages.filter(message => message.role !== "system")];
      return;
    }
    const { toolsAdded, toolsRemoved } = getToolStateChanges(getCurrentTools(messages), tools);
    const current = getCurrentSystemMessage(messages)?.sections ?? {};
    const wanted = {
      [INSTRUCTIONS]: applicationInstructions(config.systemPrompt, config.systemPromptAppend), [ENVIRONMENT]: environmentSummary(config),
      [OUTPUT]: tools.some(tool => tool.name === OUTPUT_TOOL) ? OUTPUT_INSTRUCTIONS : null,
    };
    const sections = Object.fromEntries(Object.entries(wanted).filter(([name, text]) => (current[name] ?? null) !== text));
    if (!Object.keys(sections).length && !toolsAdded.length && !toolsRemoved.length) return;
    const change: SystemMessage = {
      role: "system", content: "", timestamp: Date.now(), ...(Object.keys(sections).length ? { sections } : {}),
      ...(toolsAdded.length ? { toolsAdded } : {}), ...(toolsRemoved.length ? { toolsRemoved } : {}),
    };
    // Pi takes the change once it is written.
    await declare(change, messages[0] as SystemMessage);
    agent!.state.messages = [...messages, change];
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
        return await tool.execute(call.id, validateToolArguments(tool, call), signal) as Settled;
      } catch (error) { return { content: [{ type: "text", text: errorText(error) }], isError: true }; }
    }));
    for (const [index, call] of calls.entries()) {
      const result = results[index];
      io.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError: !!result.isError });
      const message = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, ...(result.details !== undefined ? { details: result.details } : {}), isError: !!result.isError, timestamp: Date.now() } as AgentMessage;
      await transcript.push(message);
      io.emit({ type: "message_end", message });
    }
  }

  /** Whether each model call asks the supervisor for its credentials. */
  const perCall = () => config.apiKey === IDENTITY_KEY || config.apiKey === SCOPE_KEY;

  /** The compaction running now, if any: an agent compacts one at a time. */
  let compacting: { done: Promise<boolean>; controller: AbortController; background: boolean } | undefined;

  /** Wait for `promise` to settle, or until `signal` aborts (then throw its reason). */
  function until(promise: Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
    const settled = promise.catch(() => {});
    if (!signal) return settled;
    signal.throwIfAborted();
    return Promise.race([settled, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
  }

  /**
   * Summarize older context into the transcript before the next request: a turn's context that would not fit (or that
   * the provider refused) waits for it. One compaction at a time: one running already (in the background) is waited for first.
   */
  async function compactNow(reason: "threshold" | "overflow", signal?: AbortSignal): Promise<boolean> {
    while (compacting) await until(compacting.done, signal);
    return startCompaction(reason, false, signal).done;
  }

  /**
   * Compact in the background when the context is near its limit (`compactionNeed`) and no compaction runs: turns go on
   * with the whole context meanwhile, and the summary takes over once it is written. `messages` are Pi's live state.
   */
  function compactInBackground(messages = agent?.state.messages) {
    if (compacting || !messages || !config.apiKey || transcript.failed !== undefined || !measure(messages).need) return;
    startCompaction("threshold", true).done.catch(() => {});
  }

  function startCompaction(reason: "threshold" | "overflow", background: boolean, signal?: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal!.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const current = { controller, background, done: compact(reason, background, controller.signal) };
    compacting = current;
    current.done.finally(() => {
      signal?.removeEventListener("abort", abort);
      if (compacting === current) compacting = undefined;
    }).catch(() => {});
    return current;
  }

  /**
   * Summarize the working set as it is now, up to a cut that keeps recent context. Messages appended meanwhile (a turn
   * that went on) follow the cut, so the summary replaces only the prefix it covered. The transcript's write is fenced
   * by the owner's claim like every other: a node that lost the agent cannot write it. Failures leave the context as
   * is; a later request tries again.
   */
  async function compact(reason: "threshold" | "overflow", background: boolean, signal: AbortSignal): Promise<boolean> {
    const apiKey = config.apiKey;
    if (!apiKey) return false;
    // A tenant or agent at its spend cap makes no more model calls, summaries included, until a run needs one.
    if (background && (await io.runLimit().catch(() => undefined))?.stopped === "spend_limit") return false;
    const flag = background ? { background: true } : {};
    io.emit({ type: "compaction_start", reason, ...flag });
    const previous = transcript.compaction;
    try {
      const context = transcript.context.slice();
      const offset = transcript.offset;
      // An overflow means the real limit is lower than assumed: keep about a fifth of the context.
      const keepRecentTokens = reason === "overflow" ? Math.max(1_000, Math.floor(contextTokens([...summaryView(), ...context]) * 0.2)) : undefined;
      const outcome = await runCompaction({
        // The summarizer reads messages as the model does, senders included; rendering keeps their count, so the cut still indexes the context.
        context: renderMessages(context), offset, previous, model: config.model, apiKey: perCall() ? () => io.modelAuth() : apiKey, signal, keepRecentTokens, modelHeaders: config.modelHeaders, gate,
        onResponse: message => io.emit({ type: "compaction_usage", provider: message.provider, model: message.model, usage: message.usage, timestamp: message.timestamp, ...flag }),
      });
      if ("skipped" in outcome) {
        io.emit({ type: "compaction_end", reason, skipped: outcome.skipped, ...flag });
        return false;
      }
      // Only onto the working set it summarized. System messages before the cut fold into the leading one: the summary starts a new prefix anyway.
      const folded = await transcript.compact(outcome.state, previous, changes => getCurrentSystemMessage([leading(), ...changes]));
      if (!folded) {
        io.emit({ type: "compaction_end", reason, skipped: "The working set changed while it was summarized", ...flag });
        return false;
      }
      // A running turn leaves what the summary folded at its next request (liveView); between runs, Pi starts from the summary.
      for (const message of [...context.slice(0, outcome.state.cut - offset), ...folded]) dropped.add(message);
      if (!busy) { agent!.state.messages = stateMessages(); dropped = new WeakSet(); }
      io.emit({ type: "compaction_end", reason, tokensBefore: outcome.state.tokensBefore, summarizedMessages: outcome.state.cut - offset, keptMessages: transcript.context.length, ...flag });
      return true;
    } catch (error) {
      if (signal.aborted) throw error;
      io.emit({ type: "compaction_end", reason, error: error instanceof Error ? error.message : String(error), ...flag });
      return false;
    }
  }

  const systemTokens = (system: SystemMessage) => Math.ceil(getSystemMessageText(system).length / 4);

  /**
   * Before every model request: a context near its limit starts compacting in the background and is sent whole; one
   * that would not fit waits for a compaction running already, else compacts first. Trimming is the last resort.
   */
  /**
   * The model's context for `messages` and whether it needs compacting: `blocking` when it would not fit the window less
   * the reserve, `background` within `backgroundTokens` of that (`compactionNeed`). Measured the way trimming measures it
   * too (its JSON characters), so a context is compacted, not trimmed, wherever compaction can bring it within budget.
   */
  function measure(messages: AgentMessage[]) {
    const [system, ...view] = liveView(messages) as [SystemMessage, ...AgentMessage[]];
    const budget = config.model.contextWindow - compactionSettings(config.model).reserveTokens - systemTokens(system);
    const trims = (tokens: number) => { try { return boundedContext(view, tokens).length !== view.length; } catch { return true; } };
    let need = compactionNeed(view, config.model, systemTokens(system));
    if (need === "blocking" || trims(budget)) need = "blocking";
    else need ??= trims(budget - backgroundTokens(config.model)) ? "background" : undefined;
    return { system, view, budget, need };
  }

  /**
   * Before every model request: a context near its limit starts compacting in the background and is sent whole; one
   * that would not fit waits for a compaction running already, else compacts first. Trimming is the last resort.
   */
  async function contextFor(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
    let measured = measure(messages);
    if (measured.need === "blocking" && compacting) {
      await until(compacting.done, signal);
      measured = measure(messages);
    }
    if (measured.need === "blocking" && await compactNow("threshold", signal)) measured = measure(messages);
    else if (measured.need === "background") compactInBackground(messages);
    const { view, budget } = measured;
    let system = measured.system;
    // Trimming is left for a context compaction could not bring within the budget.
    const bounded = boundedContext(view, budget);
    if (bounded.length !== view.length) {
      io.emit({ type: "context_trimmed", retainedMessages: bounded.length, omittedMessages: view.length - bounded.length });
      // Changes in the trimmed part still apply.
      const trimmed = view.slice(0, view.length - bounded.length).filter(message => message.role === "system");
      if (trimmed.length) system = getCurrentSystemMessage([system, ...trimmed])!;
    }
    return [system, ...bounded];
  }

  /**
   * Where the model made a call: the history index of the assistant message carrying it. With the call's id it names
   * the call for good (providers may number calls per response, so ids repeat across turns), the same on a retry or resume.
   */
  function made(toolCallId: string): { messageIndex?: number } {
    const messageIndex = transcript.calls.get(toolCallId);
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
    if (!forcing.last || signal.aborted || last?.role !== "assistant" || last.stopReason !== "error" || isRetryableAssistantError(last) || isContextOverflow(last, config.model.contextWindow)) return;
    forcing = { left: 0, reminding: false, last: false };
    await transcript.retract();
    io.emit({ type: "message_retracted", index: transcript.total });
    agent!.state.messages = agent!.state.messages.slice(0, -1);
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
    try { return result = await executeCode({ ...options, limits: config.codeLimits, admit: io.codeSlot && (signal => io.codeSlot!(signal)) }); }
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
        const value = await io.tool(name, args, toolCallId ? { toolCallId, innerCallId: `${toolCallId}:${++calls}`, ...made(toolCallId) } : undefined);
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
    const mount = readable ? config.mounts?.find(entry => entry.path === "/workspace" && entry.mode === "rw") ?? config.mounts?.find(entry => entry.mode === "rw") : undefined;
    // Named by the message that made the call too: providers may give calls in different turns the same id.
    const at = made(toolCallId).messageIndex;
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
        execute: async (toolCallId, args, signal) => {
          signal?.throwIfAborted();
          const value = await io.tool(tool.name, args as Record<string, unknown>, { toolCallId, ...made(toolCallId) });
          signal?.throwIfAborted();
          // The call waits on a person (inputs.ts): it stays open, with no result, and the turn suspends after this step.
          if (value?.inputRequired) {
            await transcript.await([toolCallId]);
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

  /** A referenced file's bytes as the request carries them: an image scaled down if it must be (`fitImage`), or why it is omitted. */
  async function fileData(ref: FileRef): Promise<Hydrated> {
    const key = ref.chunks.join("");
    let data = hydrated.get(key);
    if (data !== undefined) hydrated.delete(key);
    else {
      const read = await io.file(ref);
      const media = ref.media;
      const fitted = media?.kind === "image" && !fits(media.width, media.height, ref.size) ? await scaled(Buffer.from(read, "base64")) : undefined;
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
   * An image block as a request may carry it: as it is when its header is within `fits`, else scaled down,
   * or a placeholder in its place when it cannot be. The transcript is not changed: it heals in the request.
   * Written to the transcript (`writing`), an image that failed only for now stays as it is, for requests to try again.
   */
  async function fittedBlock(block: { type: "image"; data: string; mimeType: string }, writing: boolean): Promise<{ type: "image"; data: string; mimeType: string } | { type: "text"; text: string }> {
    if (block.mimeType === "application/pdf") return block;
    // The header is near the start: a JPEG's may follow its metadata, so the whole image is decoded only when the start lacks it.
    const header = imageHeader(Buffer.from(block.data.slice(0, 64 * 1024), "base64")) ?? (block.data.length > 64 * 1024 ? imageHeader(Buffer.from(block.data, "base64")) : undefined);
    if (header && fits(header.width, header.height, Math.floor(block.data.length * 3 / 4))) return block;
    const fitted = await scaled(Buffer.from(block.data, "base64"));
    if (writing && "omitted" in fitted && fitted.transient) return block;
    return "omitted" in fitted ? { type: "text", text: `[image omitted: ${fitted.omitted}]` } : { type: "image", data: fitted.data.toString("base64"), mimeType: fitted.mimeType };
  }

  /** Messages with their image blocks as a request may carry them (`fittedBlock`); the same messages when none needs it. */
  async function fittedImages<T extends object>(messages: T[], writing = true): Promise<T[]> {
    return Promise.all(messages.map(async message => {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content) || !content.some(block => block?.type === "image")) return message;
      const fitted = await Promise.all(content.map(block => block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string" ? fittedBlock(block, writing) : block));
      return fitted.every((block, index) => block === content[index]) ? message : { ...message, content: fitted };
    }));
  }

  /**
   * The model request's files: the transcript keeps references, and each becomes a line naming it
   * plus, where the model can take it, its bytes as a native block. The same references always
   * give the same request, so the provider's cached prefix holds. Past the request's file budget,
   * older files are named but not shown. Every image, referenced or inline, is within what any
   * provider takes in a request of many images (`fitImage`).
   */
  async function hydrate(messages: Message[]): Promise<Message[]> {
    documents = false;
    const shown = new Set<FileRef>();
    let bytes = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
      const content = messages[index].content;
      if (!Array.isArray(content)) continue;
      for (let block = content.length - 1; block >= 0; block--) {
        const ref = content[block] as unknown as FileRef;
        if (ref.type !== "file" || !nativeBlock(ref, config.model) || bytes + ref.size > FILE_LIMITS.requestFileBytes || shown.size >= FILE_LIMITS.requestImages) continue;
        shown.add(ref);
        bytes += ref.size;
      }
    }
    return Promise.all((await fittedImages(messages, false)).map(async message => {
      if (!Array.isArray(message.content) || !message.content.some(block => (block.type as string) === "file")) return message;
      const content: unknown[] = [];
      for (const block of message.content as unknown as (FileRef | { type: string })[]) {
        if (block.type !== "file") { content.push(block); continue; }
        const ref = block as FileRef;
        const kind = shown.has(ref) ? nativeBlock(ref, config.model) : undefined;
        if (!kind) { content.push({ type: "text", text: describeFile(ref, unseen(ref, config.model) ?? (nativeBlock(ref, config.model) ? "not shown, as this request holds too many files; read it to view it" : undefined)) }); continue; }
        try {
          const data = await fileData(ref);
          if ("omitted" in data) { content.push({ type: "text", text: describeFile(ref, `image omitted: ${data.omitted}`) }); continue; }
          content.push({ type: "text", text: describeFile(ref) }, { type: "image", data: data.data, mimeType: data.mimeType ?? (kind === "image" && ref.media?.kind === "image" ? ref.media.mimeType : "application/pdf") });
          if (kind === "document") documents = true;
        } catch (error) { content.push({ type: "text", text: describeFile(ref, `could not be read (${errorText(error)})`) }); }
      }
      return { ...message, content } as Message;
    }));
  }

  /**
   * The user messages a request adds: given whole, or as text and attached files; marked with its sender (if any), request
   * and metadata, and a prompt's `history: "none"` (only the runtime marks it: see `freshTurn`).
   */
  function userMessages(params: Record<string, any>): AgentMessage[] {
    const marks = { from: senderInput(params.from), requestId: params.requestId, metadata: params.metadata };
    const marked = (messages: AgentMessage[]) => messages.map(message => {
      const { history: _history, ...rest } = message as AgentMessage & { history?: string };
      return (params.history === "none" ? { ...rest, history: "none" } : rest) as AgentMessage;
    });
    if (params.message !== undefined) {
      const messages = (Array.isArray(params.message) ? params.message : [params.message]) as AgentMessage[];
      validateUserMessages(messages);
      return marked(stamp(messages, marks));
    }
    if (typeof params.text !== "string" || !params.text.trim()) throw new Error("Prompt text is required");
    const files = params.files ?? [];
    if (!Array.isArray(files) || files.length > FILE_LIMITS.attachments || !files.every(validFileRef)) throw new Error("Invalid attached files");
    return marked(stamp([{ role: "user", content: [{ type: "text", text: params.text }, ...files], timestamp: Date.now() } as AgentMessage], marks));
  }

  /**
   * A structured run whose model ended its turn in text, not with final_output: that answer is taken back, as a failed
   * response is, and the model asked again once, with a reminder in the output section (which the next prompt takes
   * back). Asked again rather than answered: after an answer of its own, some providers would only continue it.
   */
  async function remindOfOutput(signal: AbortSignal) {
    const last = agent!.state.messages.at(-1) as AssistantMessage | undefined;
    if (output || stopped || signal.aborted || last?.role !== "assistant" || last.stopReason !== "stop" || !agent!.state.tools.some(tool => tool.name === OUTPUT_TOOL)) return;
    if (transcript.total <= transcript.turnStart + 1) return;
    await transcript.retract();
    io.emit({ type: "message_retracted", index: transcript.total });
    const reminder: SystemMessage = { role: "system", content: "", sections: { [OUTPUT]: `${OUTPUT_INSTRUCTIONS}\n${OUTPUT_REMINDER}` }, timestamp: Date.now() };
    await declare(reminder, agent!.state.messages[0] as SystemMessage);
    agent!.state.messages = [...agent!.state.messages.slice(0, -1), reminder];
    forcing.reminding = true;
    await agent!.continue();
    await unforced(signal);
    await recoverFailedResponses(signal);
  }

  /**
   * Recover failed responses within the same turn: a context overflow compacts and
   * continues once; transient provider failures retry with backoff. The failed
   * response is retracted either way, so it never becomes history.
   */
  async function recoverFailedResponses(signal: AbortSignal) {
    const policy = config.retry ?? DEFAULT_RETRY;
    let overflowHandled = false;
    for (let attempt = 1; ; attempt++) {
      const last = agent!.state.messages.at(-1) as AssistantMessage | undefined;
      if (signal.aborted || !last || last.role !== "assistant" || last.stopReason !== "error") return;
      if (isContextOverflow(last, config.model.contextWindow)) {
        if (overflowHandled) return;
        overflowHandled = true;
        await transcript.retract();
        const index = transcript.total;
        agent!.state.messages = agent!.state.messages.slice(0, -1);
        if (!await compactNow("overflow", signal)) {
          // Keep the error visible: nothing could be summarized, so a retry would overflow again.
          await transcript.push(last);
          agent!.state.messages = [...agent!.state.messages, last];
          return;
        }
        // Taken back for good: say so on the stream, whose subscribers saw it end.
        io.emit({ type: "message_retracted", index });
        await agent!.continue();
        attempt--;
        continue;
      }
      // Cut by this node's stale lease: made again at once, as its gate allows, and not counted as a provider failure.
      const interrupted = last.errorMessage === MODEL_INTERRUPTED;
      // A tenant's own endpoint has retried already: its errors (a credit gate's 402, say) end the turn. A stream that went
      // quiet is the runtime's own timeout, which no endpoint could have retried: it is retried here like any.
      if (!interrupted && (!isRetryableAssistantError(last) || (config.apiKey === IDENTITY_KEY && !isStalled(last.errorMessage)))) return;
      if (!interrupted && attempt > policy.maxAttempts) {
        io.emit({ type: "auto_retry_end", success: false, attempt: attempt - 1, finalError: last.errorMessage });
        return;
      }
      const delayMs = interrupted ? 0 : policy.baseDelayMs * 2 ** (attempt - 1);
      // A node leaving asks again elsewhere: the failed attempt is taken back, and the turn handed off at that boundary.
      if (await handingOff()) {
        await transcript.retract();
        io.emit({ type: "message_retracted", index: transcript.total });
        agent!.state.messages = agent!.state.messages.slice(0, -1);
        return;
      }
      io.emit({ type: "auto_retry_start", attempt, maxAttempts: policy.maxAttempts, delayMs, errorMessage: last.errorMessage ?? "Unknown error" });
      // The failed attempt is not history: drop it from the log and the live state, and say so on the stream.
      await transcript.retract();
      io.emit({ type: "message_retracted", index: transcript.total });
      agent!.state.messages = agent!.state.messages.slice(0, -1);
      try { await clock().sleep(delayMs, { signal }); }
      catch { return; }
      await agent!.continue();
      if ((agent!.state.messages.at(-1) as AssistantMessage | undefined)?.stopReason !== "error") {
        io.emit({ type: "auto_retry_end", success: true, attempt });
      }
    }
  }

  async function handle(method: string, params: any): Promise<any> {
    if (method === "init") {
      if (agent) throw new Error("Agent already initialized");
      config = params;
      await mkdir(config.directory, { recursive: true, mode: 0o700 });
      // Messages the history index lacks are kept from here, as the log is read: all of them for an agent never indexed.
      // One whose index cannot be read now (null) is left for the next start.
      const indexed = io.history ? await io.history.indexed().catch(() => null) : null;
      transcript = new Transcript(io.transcript, indexed ?? undefined);
      await transcript.load();
      let recovered = false;
      let resume: { continue: true } | { finished: { messages: number; error: string | null; reply?: string; stopped?: string; output?: unknown } } | undefined;
      if (transcript.active && transcript.awaiting.length) {
        // The turn had suspended for input when its node stopped: its other calls are closed as unknown, and it stays suspended.
        await transcript.append(interruptedTurnRepairs(transcript.context, false, transcript.awaiting));
        await transcript.setActive(false);
        if (config.resume) resume = { finished: { messages: transcript.total, error: null, stopped: "input_required" } };
        recovered = true;
      } else if (transcript.active && config.resume) {
        // A response cut off when its node stopped is not history; the model is asked again.
        for (let last = transcript.context.at(-1); last?.role === "assistant" && ["aborted", "error"].includes(last.stopReason) && transcript.total > transcript.turnStart; last = transcript.context.at(-1)) await transcript.retract();
        // Answer tool calls whose outcome was lost as unknown, never by running them again; but for calls keyed by the call
        // itself (a delegate call finds the child it started, and collects its answer), made again as the turn continues.
        rerun = openCalls(transcript.context).filter(call => RERUN.includes(call.name));
        await transcript.append(interruptedTurnRepairs(transcript.context, false, rerun.map(call => call.id)));
        const last = transcript.context.at(-1);
        if (rerun.length) resume = { continue: true };
        // At a step boundary the model is simply called again; a final answer (final_output's, too) means the turn had ended.
        else if (last?.role === "toolResult" && last.toolName === OUTPUT_TOOL && !last.isError && transcript.total > transcript.turnStart) {
          const said = transcript.context.findLast(message => message.role === "assistant") as AssistantMessage | undefined;
          resume = { finished: { messages: transcript.total, ...answer(said), output: (last.details as { output?: unknown } | undefined)?.output } };
          await transcript.setActive(false);
        } else if (last && (last.role === "user" || last.role === "toolResult")) resume = { continue: true };
        else {
          if (last?.role === "assistant" && transcript.total > transcript.turnStart) resume = { finished: { messages: transcript.total, ...answer(last as AssistantMessage) } };
          else await transcript.append(interruptedTurnRepairs(transcript.context));
          await transcript.setActive(false);
        }
        recovered = true;
      } else if (transcript.active) {
        // Close the interrupted turn instead of refusing work until an operator intervenes.
        await transcript.append(interruptedTurnRepairs(transcript.context));
        await transcript.setActive(false);
        recovered = true;
      } else if (transcript.total === 0 && config.initialMessages?.length) {
        validateInitialMessages(config.initialMessages);
        const { messages, compaction } = importedHistory(config.initialMessages);
        await transcript.replace(messages, undefined, compaction);
      }
      const directTools = directAgentTools(config.tools);
      const maxTimeoutMs = config.codeLimits?.maxTimeoutMs ?? SANDBOX_LIMITS.maxTimeoutMs;
      jsExec = {
        name: "js_exec", label: "JavaScript",
        description: "Run JavaScript or TypeScript in a fresh sandbox. Return what you want to see: it comes back as JSON (a string as its own text), after any console.log lines. In scope: tools (await tools.<name>(args) gives the tool's result as data; tools.search, tools.namespaces and tools.describe find them) and fs for your files (readFile(path, { encoding: \"utf8\" }) gives a string, a Uint8Array without it; writeFile(path, string | Uint8Array); stat, list, remove); no network, imports, Node APIs or timers. Variables are gone after each execution; files persist. An execution gets timeoutMs of wall time (default " + Math.min(SANDBOX_LIMITS.timeoutMs, maxTimeoutMs) + ", at most " + maxTimeoutMs + "), tool calls included: raise it for slow tools." + " For example:\nconst tickets = [];\nfor (let page = 1; page; ) { const result = await tools.helpdesk__list_tickets({ status: \"open\", page }); tickets.push(...result.tickets); page = result.nextPage; }\nawait fs.writeFile(\"/workspace/tmp/tickets.json\", JSON.stringify(tickets)); // a later execution can read it back\nreturn { open: tickets.length, oldest: tickets[0]?.createdAt };",
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
      const tools = [...config.codeMode === false ? [] : [jsExec], ...directTools];
      // A request whose stream goes quiet ends as a retryable error (model-stream.ts), said on the run's stream as it happens.
      const stream = explicitKeyStream(() => perCall() ? io.modelAuth() : undefined, () => config.modelHeaders, gate,
        (model, reasoning) => streamTimeouts(model, reasoning, config.runLimits, config.streamTimeouts),
        stall => io.emit({ type: "model_stream_stalled", phase: stall.phase, ms: stall.ms, provider: config.model.provider, model: config.model.id }));
      agent = new Agent({
        initialState: {
          model: config.model,
          tools, messages: [leading(tools.map(toToolDeclaration)), ...transcript.view()],
          thinkingLevel: config.thinkingLevel ?? "off",
        },
        getApiKey: () => config.apiKey,
        // Only the tenant's explicit key, never provider keys from the process environment. A model on the
        // tenant's own endpoint gets a fresh identity token for each call, and a key scope's agent its scope's current key.
        // A structured run's request may force final_output (`outputChoice`).
        streamFn: (model, context, options) => {
          const toolChoice = outputChoice(model);
          return stream(model, context, toolChoice === undefined ? options : { ...options, toolChoice } as typeof options);
        },
        // Renders compaction summaries for the model (the default drops non-chat roles), and each message's sender.
        convertToLlm: messages => hydrate(convertToLlm(renderMessages(messages))),
        onPayload: payload => documents ? documentPayload(payload) : undefined,
        transformContext: (messages, signal) => contextFor(messages, signal),
        // A turn with calls waiting on a person suspends; one past a spend cap or its run's limits (responses, time) stops before the next model request, after this response's tool results.
        finishTurn: async turn => {
          if (transcript.awaiting.length) {
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
          stopped = { stopped: limit.stopped, error: limit.message, code: limit.stopped };
          io.emit({ type: `${limit.stopped}_reached`, message: limit.message });
          return { action: "end" };
        },
        sessionId: config.id,
        toolExecution: "parallel",
      });
      agent.subscribe(async event => {
        if ((event.type === "message_start" || event.type === "message_update" || event.type === "message_end") && event.message.role === "system") {
          // Pi declares a tool set that no longer matches the context's; it stays in place like the runtime's own changes.
          if (event.type === "message_end") {
            try { await declare(event.message, agent!.state.messages[0] as SystemMessage); }
            catch (error) { agent!.abort(); throw error; }
          }
          return;
        }
        // A turn handed off at a step boundary goes on elsewhere: for its subscribers it has not ended.
        if (event.type === "agent_end" && stopped?.stopped === "handoff") return;
        // A call waiting on input has no result yet: the transcript keeps it open instead (`awaiting`).
        if (event.type === "message_end" && event.message.role === "user") steers = steers.filter(steer => steer.message !== event.message);
        if (event.type === "message_end" && !(event.message.role === "toolResult" && (event.message.details as { inputRequired?: boolean } | undefined)?.inputRequired)) {
          // One durable append per finished message. Streaming deltas are never persisted.
          try { await transcript.push(event.message); }
          catch (error) { agent!.abort(); throw error; }
          void index();
        }
        io.emit(event);
      });
      // final_output, declared by a prompt with an output schema, stays until a prompt without one.
      const kept = getCurrentTools(agent.state.messages).find(tool => tool.name === OUTPUT_TOOL);
      if (kept && !config.tools.some(tool => tool.name === OUTPUT_TOOL)) agent.state.tools = [...agent.state.tools, outputTool(kept.parameters)];
      // A configuration changed elsewhere (another node, or while this agent was stopped) applies from here.
      await declareConfiguration();
      void index();
      return { pid: process.pid, recovered, messages: transcript.total, ...(resume ? { resume } : {}) };
    }
    if (!agent) throw new Error("Agent is not initialized");
    if (method === "status") return { pid: process.pid, busy, messages: transcript.total, contextMessages: transcript.context.length, compacted: !!transcript.compaction };
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
      if (params.tools !== undefined) config.tools = params.tools;
      if (params.tools !== undefined || params.codeMode !== undefined) agent.state.tools = [...config.codeMode === false ? [] : [jsExec!], ...directAgentTools(config.tools)];
      if (params.systemPrompt !== undefined || params.systemPromptAppend !== undefined || params.tools !== undefined || params.codeMode !== undefined || params.model !== undefined) await declareConfiguration();
      return { configured: true };
    }
    // Full history comes from the log; memory holds only the working set.
    if (method === "history") return { messages: await readTranscriptLog(transcript.log) };
    // Before a stop: index the settled turns, so a page of them needs neither the process nor the log.
    if (method === "historyFlush") { await index(true); return null; }
    // What the history index lacks yet: the running turn, and anything a failed write left. Null when nothing indexes the agent.
    if (method === "historyTail") {
      const backlog = transcript.backlog;
      // Part of it left to the log: the page reads the log instead.
      return backlog && backlog.kept === backlog.from ? { from: backlog.from, messages: backlog.messages, turns: backlog.turns } : null;
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
    if (transcript.failed !== undefined) throw new Error(`Session persistence failed: ${String(transcript.failed)}`);
    // A prompt a turn took as a steer before the node running it stopped: it is in the history already, compacted or not.
    if (method === "prompt" && params.requestId && transcript.requests.has(params.requestId)) {
      return { messages: transcript.total, error: null, taken: true };
    }
    const promptMessages = method === "prompt" ? userMessages(params) : undefined;
    busy = true;
    stopped = undefined;
    output = undefined;
    forcing = { left: FORCED_OUTPUT_REQUESTS, reminding: false, last: false };
    active = new AbortController();
    try {
      if (method === "prompt") await useOutput(params.output?.schema);
      if (method === "execute") {
        const { returned: _returned, cpuMs: _cpuMs, ...result } = await runCode({ ...codeRequest(params), bridge: bridge(active.signal), signal: active.signal, onEvent: event => io.emit(event) });
        return result;
      }
      if (method === "continue" && transcript.awaiting.length) throw new Error("The agent is waiting for input: answer it, or send a new prompt");
      await transcript.setActive(true);
      // Where the run's messages start in the agent's history, so a client can line up its stream with history pages.
      io.emit({ type: "turn_opened", index: transcript.total });
      steerable = true;
      if (method === "resume") {
        const settled = await settle(params.calls ?? [], active.signal);
        // Closed without the model (expired or cancelled inputs), still waiting, or nothing left to resume.
        if (params.close || transcript.awaiting.length || !settled) {
          await transcript.setActive(false);
          return { messages: transcript.total, error: null, ...(transcript.awaiting.length ? { stopped: "input_required" } : {}) };
        }
        agent.state.messages = freshTurn() ?? stateMessages();
        if (active.signal.aborted) return await abortedBeforeLoop();
        // The answered calls were this run's step: a node leaving hands the turn off before the model is asked.
        if (await handingOff()) return handedOff();
        await agent.continue();
      } else if (method === "continue") {
        if (rerun.length) {
          await rerunOpenCalls(active.signal);
          agent.state.messages = stateMessages();
          if (await handingOff()) return handedOff();
        }
        if (active.signal.aborted) return await abortedBeforeLoop();
        const own = freshTurn();
        if (own) agent.state.messages = own;
        await agent.continue();
      }
      else {
        // A new message supersedes calls still waiting on input: each is closed first, so the model sees why.
        if (transcript.awaiting.length) {
          await settle(transcript.awaiting.map(toolCallId => ({ toolCallId, result: { content: [{ type: "text", text: "Not answered: the user sent a new message instead (next)." }], isError: true } })), active.signal);
          agent.state.messages = stateMessages();
        }
        if (active.signal.aborted) return await abortedBeforeLoop();
        // Images enter the transcript as requests carry them: scaled down once here, not on every request after.
        const messages = await fittedImages(promptMessages!);
        if (params.history === "none") agent.state.messages = freshTurn(messages[0])!;
        await agent.prompt(messages);
      }
      await unforced(active.signal);
      await recoverFailedResponses(active.signal);
      await remindOfOutput(active.signal);
      // Stopped at a step boundary for another node to continue (in any of the model calls above): the turn stays open
      // (active) in the transcript.
      if (handedOffHere()) {
        if (transcript.failed !== undefined) throw transcript.failed;
        return handedOff();
      }
      if (transcript.failed !== undefined) throw transcript.failed;
      await transcript.setActive(false);
      // Set by finishTurn as the turn ran.
      const given = output as { value: unknown } | undefined;
      // A suspended turn ends on its open calls, and a structured answer on final_output's result: what the model said as it made them is the reply.
      const last = (transcript.awaiting.length || given ? agent.state.messages.findLast(message => message.role === "assistant") : agent.state.messages.at(-1)) as AssistantMessage | undefined;
      // A failed model call fails the run, whether Pi kept its error or only the message does.
      const answered = answer(last);
      const error = agent.state.errorMessage ?? answered.error;
      // A run that asked for structured output and ended without it, nor stopped for a reason of its own, failed.
      const missing = !given && !error && !stopped && agent.state.tools.some(tool => tool.name === OUTPUT_TOOL);
      // Why it failed, when the remedy is the caller's (a key) or worth telling apart: a model whose stream went quiet past
      // every retry, or a run aborted (stopped by its caller).
      const failure = error ? modelKeyFailure(error, config.model) ?? (isStalled(error) ? { code: "model_stream_stalled" } : active.signal.aborted || last?.stopReason === "aborted" ? { code: "aborted" } : {}) : {};
      return {
        messages: transcript.total, ...answered, error, ...failure, ...(stopped ?? {}), ...(given ? { output: given.value } : {}),
        ...(missing ? { error: `The model ended its turn without calling ${OUTPUT_TOOL}, so the run has no output in its schema`, code: "output_missing" } : {}),
      };
    } finally {
      // Steers sent for this turn that it did not take are taken back: each runs as a turn of its own.
      steerable = false;
      if (steers.some(steer => steer.whileRunning)) {
        agent.clearSteeringQueue();
        steers = steers.filter(steer => !steer.whileRunning);
        for (const steer of steers) agent.steer(steer.message);
      }
      // Release what compaction folded away: the next run starts from summary + kept messages.
      const wasFresh = !!fresh;
      fresh = undefined;
      if (method !== "execute" && transcript.failed === undefined) {
        agent.state.messages = stateMessages();
        dropped = new WeakSet();
      }
      await io.cancelTools();
      active = undefined;
      busy = false;
      if (method !== "execute") {
        void index();
        // After the turn: the summary is made while the agent waits for its next message; not by one handing its turn off,
        // nor after a run that saw no history (a run that does see it compacts first, if it must).
        if (!handedOffHere() && !wasFresh) compactInBackground();
      }
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
   * A turn stopped at a step boundary for the next owner: left open (active) in the transcript, whose last message is a
   * tool result or the user's, so the next owner calls the model again with nothing lost (see `init`'s resume).
   */
  function handedOff() {
    return { messages: transcript.total, error: null, handedOff: true };
  }

  /**
   * An abort that came after the run began but before Pi's loop did: Pi's own abort found no loop to stop, so the run ends
   * here, checked in the same tick as each loop starts.
   */
  async function abortedBeforeLoop() {
    await transcript.setActive(false);
    return { messages: transcript.total, error: "The run was aborted", code: "aborted", ...(stopped ?? {}) };
  }

  type Settled = { content: unknown[]; isError?: boolean; details?: unknown };
  /**
   * Give calls waiting on input their results, in the order the model made them: a ready result (an
   * answer, or why there is none), or, with `retry`, the call run again now (an approved call, or a
   * tool's own request retried with its answers). A retried call is released first, so a crash while
   * it runs leaves it open to be closed as unknown, never run twice. Returns how many calls it settled.
   */
  async function settle(calls: { toolCallId: string; result?: Settled; retry?: boolean }[], signal: AbortSignal) {
    const made = transcript.context.flatMap(message => message.role === "assistant" ? message.content : []).filter(part => part.type === "toolCall") as ToolCall[];
    const position = (id: string) => made.findIndex(part => part.id === id);
    const wanted = calls.filter(call => transcript.awaiting.includes(call.toolCallId)).sort((a, b) => position(a.toolCallId) - position(b.toolCallId));
    const retried = wanted.filter(call => call.retry).map(call => call.toolCallId);
    if (retried.length) await transcript.await(retried, true);
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
          result = await tool.execute(call.toolCallId, validateToolArguments(tool, toolCall), signal) as Settled;
        } catch (error) { result = { content: [{ type: "text", text: errorText(error) }], isError: true }; }
        // Asked again (another round of input): the call stays open, as it did the first time.
        if ((result!.details as { inputRequired?: boolean } | undefined)?.inputRequired) {
          io.emit({ type: "tool_execution_end", toolCallId: call.toolCallId, toolName: toolCall?.name ?? "", result, isError: false });
          continue;
        }
      }
      io.emit({ type: "tool_execution_end", toolCallId: call.toolCallId, toolName: toolCall?.name ?? "", result, isError: !!result!.isError });
      const message = { role: "toolResult", toolCallId: call.toolCallId, toolName: toolCall?.name ?? "", content: result!.content, ...(result!.details !== undefined ? { details: result!.details } : {}), isError: !!result!.isError, timestamp: Date.now() } as AgentMessage;
      await transcript.push(message);
      io.emit({ type: "message_end", message });
    }
    return wanted.length;
  }

  /** The final answer's text, for callers that relay it (channels), and that message's index in the history. */
  function answer(last: AssistantMessage | undefined) {
    const reply = last?.role === "assistant" && last.stopReason !== "error" ? last.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim() : "";
    const at = reply ? transcript.context.lastIndexOf(last as AgentMessage) : -1;
    return { error: last?.stopReason === "error" ? last.errorMessage ?? "The model returned an error" : null, ...(reply ? { reply } : {}), ...(at >= 0 ? { replyIndex: transcript.offset + at } : {}) };
  }

  /**
   * Stop serving: abort the run and close the transcript, so nothing more is
   * written. An interrupted turn stays marked active and is recovered on next load.
   */
  async function dispose(flushMs = HISTORY_FLUSH_MS) {
    active?.abort();
    agent?.abort();
    compacting?.controller.abort();
    if (flushMs > 0) await Promise.race([index(true), clock().sleep(flushMs)]);
    await transcript?.log.close();
  }

  return { handle: turns.wrap(handle), dispose };
}

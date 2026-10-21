import { createHash } from "node:crypto";
import { END_USER_CREDIT, type CreditStop, type ModelAttemptHook } from "./model-attempt.ts";
import { dualWriting, NativeTranscript } from "./pi-durable/transcript.ts";
import { mkdir } from "node:fs/promises";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "./pi-harness/messages.ts";
import {
  getCurrentSystemMessage, getCurrentTools, getSystemMessageText, getToolStateChanges, isContextOverflow, isRetryableAssistantError, toToolDeclaration, validateToolArguments,
  type AssistantMessage, type Message, type SystemMessage, type Tool, type ToolCall, type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { executeCode, presentResult, type CodeExecutor, type CodeResult } from "./codemode.ts";
import type { Outbound } from "./outbound.ts";
import { scriptValue } from "./mcp-results.ts";
import { errorText, IDENTITY_KEY, PERSISTENCE_FAILED, SCOPE_KEY, scratchMount, type AgentConfig, type CallContext, type Credentials, type RunStop, type ToolBridge } from "./protocol.ts";
import { APPLICATION, applicationInstructions, ENVIRONMENT, environmentSummary, INSTRUCTIONS, leadingSystemMessage, OUTPUT, OUTPUT_INSTRUCTIONS, OUTPUT_REMINDER, OUTPUT_TOOL } from "./system-prompt.ts";
import { renderMessages, senderInput, stamp, type MessageSource } from "./sender.ts";
import type { SearchHit, SearchQuery } from "./tool-search.ts";
import type { AppendLog } from "../shared/append-log.ts";
import { Transcript, readTranscriptLog, type Backlog, type TranscriptRecord, type TranscriptSnapshot } from "./transcript.ts";
import { closeInterruptedTurn, importedHistory, interruptedTurnRepairs, validateInitialMessages, validateUserMessages } from "./history.ts";
import { contextTokens, explicitKeyStream, modelKeyFailure, type ModelGate } from "./compaction.ts";
import { codeRequest, DEFAULT_RETRY, SANDBOX_LIMITS } from "./limits.ts";
import { isStalled, streamTimeouts } from "./model-stream.ts";
import { MODEL_INTERRUPTED, modelFailure, retriesModelError } from "./model-errors.ts";
import { forcedToolChoice } from "./tool-choice.ts";
import { filesRefused, schemaAccepts } from "./tool-policy.ts";
import { callSettings } from "./pi-catalog.ts";
import { describeFile, documentPayload, FILE_LIMITS, IMAGE_PAST_BUDGET, nativeBlock, unseen, validFileRef, type FileRef } from "./files.ts";
import { CHUNK_BYTES, chunksOf, type HistoryChunk } from "./history-pages.ts";
import { observeTurns, recordCodeExecution } from "./metrics.ts";
import { fitImage, fits, type Fitted } from "./inspect.ts";
import { imageHeader } from "./image-header.ts";
import { clock } from "./node-context.ts";
import { usageMissing } from "./platform-pricing.ts";
import type { Storage as PiStorage } from "@earendil-works/pi-durable";
import { DurableAgent, type DurableAgentOptions } from "./pi-durable/agent.ts";
import { checkDualRead } from "./pi-durable/dual-read.ts";
import { JournalHistory } from "./pi-durable/history.ts";
import { metricLine } from "./metrics.ts";
import { always } from "./assert.ts";
import { LEGACY_CONVERSATION_ID, legacyImportShape, LegacyMigrationDeferred, loadLegacyMigration, readMigrationRecords, type LegacyImportShape } from "./pi-durable/migration.ts";
import { reconcilePiTranscript } from "./pi-durable/projection.ts";

/** How often an agent reads back from its log what its history backlog could not hold (see `index`). */
const LAG_READ_MS = 60_000;
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
  /** Process hosting reduces the log on its owner before crossing IPC; inline hosting replays it here. */
  loadTranscript?(indexed: number | null, bound?: number): Promise<TranscriptSnapshot>;
  /** Native Pi storage stays on the supervisor under the session's ownership claim. */
  piStorage?(): Promise<PiStorage | undefined>;
  /** `tools.search`, answered by the supervisor (which holds the rerankers); without it, code searches here. */
  search?(query: SearchQuery): Promise<SearchHit[]>;
  /** A file reference's bytes as base64, read by the supervisor: the agent holds no storage access. */
  file(ref: FileRef): Promise<string>;
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
  /** The history backlog's bound (AGENT_HISTORY_BACKLOG_BYTES; `BACKLOG_BYTES` unless given). */
  historyBacklogBytes?: number;
  /** Wait until the node may act for the agent (its lease is fresh), before each model request and js_exec; rejects once it lost the agent. */
  lease?(): Promise<void>;
  /**
   * Compare the host's records with Pi's journal after each load and run (pi-durable/dual-read.ts, AGENT_PI_DUAL_READ):
   * `log` reports mismatches, `throw` also fails the request on an unexpected one (tests, the simulation).
   */
  piDualRead?: "log" | "throw";
  /**
   * Tenants whose agents read their history from Pi's journal (AGENT_PI_HISTORY_SOURCE_TENANTS; `*`: every tenant), on
   * nodes that dual-write it: plans/host-transcript-removal.md, phase 2. The host transcript is still written, and
   * served wherever the journal disagrees.
   */
  historySourceTenants?: string[];
  /** Tenants whose agents' system sections are native Pi sections (AGENT_NATIVE_SECTIONS_TENANTS; `*`: every tenant). */
  nativeSectionsTenants?: string[];
  /** The agent's history index, which the supervisor writes: how many messages it has (null: it has none yet, or none is kept), and a chunk to add. */
  history?: { indexed(): Promise<number | null>; write(chunk: HistoryChunk): Promise<number>; read(from: number): Promise<Backlog> };
}

/** A history value the journal does not hold (`served`). */
const NOT_HELD = Symbol("not held");

/** The least time between an agent's dual reads in `log` mode, past its load's. */
export const DUAL_READ_INTERVAL_MS = 10 * 60_000;

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
const stopFields = (stop: Partial<RunStop>) => ({
  code: stop.code ?? stop.stopped,
  ...(stop.limit ? { limit: stop.limit } : {}), ...(stop.reason ? { reason: stop.reason } : {}),
  ...(stop.bucket ? { bucket: stop.bucket } : {}), ...(stop.endUser ? { endUser: stop.endUser } : {}),
});

/**
 * One agent: its Pi loop, working-set transcript, compaction and retries. It runs
 * in its own process (agent-child.ts) or inline in a worker hosting many agents.
 */
export function createAgentHost(hostIO: HostIO) {
  let agent: DurableAgent | undefined;
  let config: AgentConfig;
  /** How this start found the session: on Pi already, or imported from its legacy transcript now (and what that import took). */
  let migration: { state: "existing" } | { state: "migrated" | "adopted"; from?: LegacyImportShape; archive?: "legacy-log" } | undefined;
  // Each turn's outcome, timing and model and tool counts, as metrics (metrics.ts), from what the host emits.
  const turns = observeTurns(() => config?.model && { provider: config.model.provider, id: config.model.id }, Date.now, () => config?.tenant);
  const io: HostIO = { ...hostIO, emit: event => { turns.event(event); hostIO.emit(event); } };
  let transcript: Transcript;
  /** The agent's history as its journal gives it, where reads have moved there (`historyFromJournal`). */
  let piHistory: JournalHistory | undefined;
  /** The agent's Pi storage, once loaded: the dual read reads it. */
  let journal: PiStorage | undefined;
  /** When the dual read last ran for this agent (`DUAL_READ_INTERVAL_MS`). */
  let lastDualRead = 0;
  /** The last system prompt hash logged for this agent (`systemPromptHash`). */
  let lastPromptHash: string | undefined;
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

  /**
   * The context's first system message, the start of the provider's cached prefix. It is built
   * from configuration until the prompt or tools change with history; the transcript then pins
   * it, and each change follows as a system message of its own where the conversation stood.
   */
  function leading(tools: Tool[] = agent!.state.tools.map(toToolDeclaration)): SystemMessage {
    return transcript.system ?? leadingSystemMessage(config, tools, nativeSections() ? APPLICATION : INSTRUCTIONS);
  }

  /** Pi's messages from the transcript: what a run starts from. */
  function stateMessages(): AgentMessage[] { return [leading(), ...transcript.view()]; }

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
    return [getCurrentSystemMessage(at < 0 ? all : all.slice(0, at))!, ...at < 0 ? [] : all.slice(at)];
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
      agent!.state.messages = [leadingSystemMessage(config, tools, nativeSections() ? APPLICATION : INSTRUCTIONS), ...messages.filter(message => message.role !== "system")];
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
    for (const message of [...cleared, change]) await declare(message, messages[0] as SystemMessage);
    agent!.state.messages = [...messages, ...cleared, change];
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
      await transcript.push(message);
      io.emit({ type: "message_end", message });
    }
  }

  /**
   * Temporary, for the instructions section's canary (#339): the hash of the system prompt the model is sent, as one
   * leading prompt (what every model in the catalog gets), logged when it differs from this agent's last one here. A
   * change that is not a configuration change shows a release changed the prompt. Hashes only, never the text.
   */
  function systemPromptHash(messages: Message[]) {
    const system = getCurrentSystemMessage(messages);
    const hash = system ? createHash("sha256").update(getSystemMessageText(system)).digest("hex").slice(0, 16) : "none";
    if (hash === lastPromptHash) return;
    console.log(JSON.stringify({ type: "system_prompt_hash", agent: config.id, hash, previous: lastPromptHash ?? null, sections: Object.keys(system?.sections ?? {}) }));
    lastPromptHash = hash;
  }

  /** Whether the agent reads its history from Pi's journal: its tenant is listed, and the journal is dual-written. */
  const historyFromJournal = () => dualWriting() && !!io.historySourceTenants && (io.historySourceTenants.includes("*") || io.historySourceTenants.includes(config.tenant ?? ""));

  /**
   * A history value as the journal gives it, where the agent reads from there: the host transcript's when they differ,
   * which is logged (history_source_mismatch, with values and hashes only) for the cutover to explain.
   */
  async function served<T>(field: string, host: T, journalValue: (history: JournalHistory) => T | typeof NOT_HELD | Promise<T | typeof NOT_HELD>): Promise<T> {
    if (!piHistory || transcript.failed !== undefined) return host;
    await piHistory.refresh();
    const value = await journalValue(piHistory);
    // What the journal does not hold (messages before its base the history index lacks yet): the host's, not a mismatch.
    if (value === NOT_HELD) return host;
    const same = JSON.stringify(value) === JSON.stringify(host);
    const summary = (item: unknown) => typeof item === "number" || typeof item === "boolean" || item === undefined ? item
      : createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 16);
    console.log(metricLine(same ? "history_source" : "history_source_mismatch", {
      dimensions: { Outcome: same ? "match" : "mismatch" }, rollups: [[], ["Outcome"]],
      metrics: { HistorySourceReads: 1, HistorySourceMismatches: same ? 0 : 1 },
      properties: { agent: config.id, field, ...(same ? {} : { host: summary(host), journal: summary(value) }) },
    }));
    // The simulation records each: a value the journal gives otherwise is a violation of the run. Tests (the dual read in
    // `throw`) fail on it.
    always(same, "a history value the journal gives is the host transcript's");
    if (!same && io.piDualRead === "throw") throw new Error(`History from the journal: ${field} is ${JSON.stringify(summary(value))}, the host's ${JSON.stringify(summary(host))}`);
    return same ? value : host;
  }

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
    const messageIndex = await served("callIndex", transcript.calls.get(toolCallId), history => history.callIndex(toolCallId));
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
    await transcript.retract();
    io.emit({ type: "message_retracted", index: await served("total", transcript.total, history => history.total) });
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
    // What each block shown sends: a file's bytes (or why it is not shown), and the inline images within the budget.
    const sent = new Map<FileRef, Hydrated | Error>();
    const keptInline = new Set<string>();
    let images = 0, imageBytes = 0, imagesFull = false, documentBytes = 0;
    const fitsBudget = (bytes: number) => {
      if (!imagesFull && images < FILE_LIMITS.requestImages && imageBytes + bytes <= FILE_LIMITS.requestImageBase64Bytes) {
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
    if (transcript.total <= transcript.turnStart + 1) return;
    await transcript.retract();
    io.emit({ type: "message_retracted", index: await served("total", transcript.total, history => history.total) });
    const reminder: SystemMessage = { role: "system", content: "", sections: { [OUTPUT]: `${OUTPUT_INSTRUCTIONS}\n${OUTPUT_REMINDER}` }, timestamp: Date.now() };
    await declare(reminder, agent!.state.messages[0] as SystemMessage);
    agent!.state.messages = [...agent!.state.messages.slice(0, -1), reminder];
    forcing.reminding = true;
    await agent!.continue();
    await unforced(signal);
    await recoverFailedResponses(signal);
  }

  /**
   * Recover failed responses within the same turn: transient provider failures retry with backoff, and the failed
   * response is retracted, so it never becomes history.
   */
  async function recoverFailedResponses(signal: AbortSignal) {
    const policy = config.retry ?? DEFAULT_RETRY;
    for (let attempt = 1; ; attempt++) {
      const last = agent!.state.messages.at(-1) as AssistantMessage | undefined;
      if (signal.aborted || !last || last.role !== "assistant" || last.stopReason !== "error") return;
      // Its end user's credit refused it: asking again would be refused again.
      if (stopped?.code === END_USER_CREDIT) return;
      // Pi compacts and asks again on an overflow itself: one that reaches here is past what compaction can do.
      if (isContextOverflow(last, config.model.contextWindow)) return;
      // Cut by this node's stale lease: made again at once, as its gate allows, and not counted as a provider failure.
      const interrupted = last.errorMessage === MODEL_INTERRUPTED;
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
        await transcript.retract();
        io.emit({ type: "message_retracted", index: await served("total", transcript.total, history => history.total) });
        agent!.state.messages = agent!.state.messages.slice(0, -1);
        return;
      }
      io.emit({ type: "auto_retry_start", attempt, maxAttempts: policy.maxAttempts, delayMs, errorMessage: last.errorMessage ?? "Unknown error", failure: modelFailure(last, failureContext()) });
      // The failed attempt is not history: drop it from the log and the live state, and say so on the stream.
      await transcript.retract();
      io.emit({ type: "message_retracted", index: await served("total", transcript.total, history => history.total) });
      agent!.state.messages = agent!.state.messages.slice(0, -1);
      try { await clock().sleep(delayMs, { signal }); }
      catch { return; }
      await agent!.continue();
      if ((agent!.state.messages.at(-1) as AssistantMessage | undefined)?.stopReason !== "error") {
        io.emit({ type: "auto_retry_end", success: true, attempt });
      }
    }
  }

  /**
   * The session's host transcript on Pi. A session not on Pi yet is read from its legacy log once and imported as it
   * stands, a turn its old node left running or waiting on a person included: the recovery that follows treats it as it
   * treats any session on Pi, and nothing writes the legacy log after the import. `tools` make the leading system
   * message an import starts Pi's context with.
   */
  async function open(storage: PiStorage, indexed: number | undefined, tools: Tool[]): Promise<Transcript> {
    const native = await NativeTranscript.open(storage, indexed, io.historyBacklogBytes, io.transcript);
    const migrated = await loadLegacyMigration(storage);
    if (native) {
      migration = { state: "existing" };
      // The native journal commits before its host record. Each copied message carries its cursor in that same
      // record, so a torn append is safe to copy again after reopen.
      if (migrated) await reconcilePiTranscript(native, storage, migrated.conversationId);
      return native;
    }
    const legacy = new Transcript(io.transcript, indexed, io.historyBacklogBytes);
    if (io.loadTranscript) legacy.restore(await io.loadTranscript(indexed ?? null, io.historyBacklogBytes));
    else await legacy.load();
    // Imported by a release that started no host generation with it, or rolled back to the legacy engine since
    // (camel.host.disabled): the native messages its log lacks are copied to it first, then the whole log is adopted.
    if (migrated) await reconcilePiTranscript(legacy, storage, migrated.conversationId);
    const leadingSystem = legacy.system ?? leadingSystemMessage(config, tools, nativeSections() ? APPLICATION : INSTRUCTIONS);
    const working = [leadingSystem, ...legacy.view()];
    const from = legacyImportShape(legacy, working);
    if (!migrated) {
      // One commit imports the session and starts the host's generation on it; Pi's context starts as the host's
      // working set, checkpointed once. A log too large to copy is never read whole: it stays the archive.
      const records = await readMigrationRecords(legacy.log).catch(error => { if (error instanceof LegacyMigrationDeferred) return undefined; throw error; });
      const imported = await NativeTranscript.importLegacy(storage, legacy, { sessionId: config.id,
        ...records ? { records } : {}, leadingSystem, working, indexed, bound: io.historyBacklogBytes });
      if (imported.transcript) {
        migration = { state: "migrated", ...from ? { from } : {}, ...records ? {} : { archive: "legacy-log" } };
        return imported.transcript;
      }
    }
    migration = { state: "adopted", ...from ? { from } : {} };
    return NativeTranscript.adopt(storage, legacy, indexed, io.historyBacklogBytes, working);
  }

  async function handle(method: string, params: any): Promise<any> {
    if (method === "init") {
      if (agent) throw new Error("Agent already initialized");
      config = params;
      await mkdir(config.directory, { recursive: true, mode: 0o700 });
      // Messages the history index lacks are kept from here, as the log is read: all of them for an agent never indexed.
      // One whose index cannot be read now (null) is left for the next start.
      const indexed = io.history ? await io.history.indexed().catch(() => null) : null;
      const piStorage = await io.piStorage?.();
      if (!piStorage) throw new Error("The agent's Pi durable storage is not open");
      // Tools first: an import starts Pi's context with the leading system message they make.
      jsExec = codeTool();
      const tools = [...config.codeMode === false ? [] : [jsExec], ...directAgentTools(config.tools)];
      journal = piStorage;
      transcript = await open(piStorage, indexed ?? undefined, tools.map(toToolDeclaration));
      // Each legacy session is imported once, as it is first loaded: what its imports took, for operators to follow.
      if (migration?.state !== "existing") console.log(JSON.stringify({ type: "legacy_session_imported", agent: config.id, tenant: config.tenant, ...migration }));
      // The Pi sweep's start: the import was all it wanted. The next open recovers and configures as for any session on Pi.
      if (config.importOnly) return { pid: process.pid, ...(migration ? { migration } : {}), recovered: false, messages: transcript.total };
      transcript.pin = () => agent ? leading() : undefined;
      let recovered = false;
      let resume: { continue: true } | { finished: { messages: number; error: string | null; reply?: string; stopped?: string; output?: unknown } } | undefined;
      if (transcript.active && transcript.awaiting.length) {
        // The turn had suspended for input when its node stopped: its other calls are closed as unknown, and it stays suspended.
        await closeInterruptedTurn(transcript);
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
        await closeInterruptedTurn(transcript);
        recovered = true;
      } else if (transcript.total === 0 && config.initialMessages?.length) {
        validateInitialMessages(config.initialMessages);
        const { messages, compaction } = importedHistory(config.initialMessages);
        await transcript.replace(messages, undefined, compaction);
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
          tools, messages: [leading(tools.map(toToolDeclaration)), ...transcript.view()],
          thinkingLevel: config.thinkingLevel ?? "off",
        },
        getApiKey: () => config.apiKey,
        // Only the tenant's explicit key, never provider keys from the process environment. A model on the
        // tenant's own endpoint gets a fresh identity token for each call, and a key scope's agent its scope's current key.
        // A structured run's request may force final_output (`outputChoice`).
        // The agent's maxOutputTokens and temperature go on each of its own calls (not compaction's summaries), as far as the call takes them.
        streamFn: (model, context, options) => {
          systemPromptHash(context.messages as Message[]);
          const toolChoice = outputChoice(model);
          const settings = callSettings(model, config, options?.reasoning);
          return stream(model, context, { ...options, ...settings, ...(toolChoice === undefined ? {} : { toolChoice }), ...(config.dataCollection ? { dataCollection: config.dataCollection } : {}) } as typeof options);
        },
        // Renders compaction summaries for the model (the default drops non-chat roles), and each message's sender.
        convertToLlm: messages => hydrate(convertToLlm(renderMessages(messages))),
        onPayload: payload => documents ? documentPayload(payload) : undefined,
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
          stopped = { stopped: limit.stopped, error: limit.message, ...stopFields(limit) };
          io.emit({ type: `${limit.stopped}_reached`, message: limit.message });
          return { action: "end" };
        },
        sessionId: config.id,
        toolExecution: "parallel",
      };
      agent = await DurableAgent.create({ ...agentOptions, durable: {
        storage: piStorage, conversationId: LEGACY_CONVERSATION_ID, cursor: transcript.piCursor, written: () => transcript.piCursor,
        // Pi's journal failed a write or read: what the host holds is no longer known to be stored, as when the
        // transcript fails one. The run ends with PERSISTENCE_FAILED and the session gives the agent up.
        onStorageFailure: error => { transcript.failed ??= error; },
        // Summaries share credential/network gates but not the run's output
        // schema, temperature or max-output settings.
        summaryStream,
        nativeSections: nativeSections(),
        get contextWindow() { return compactionModel().contextWindow; },
        onSummary: message => io.emit({ type: "compaction_usage", provider: message.provider,
          model: message.model, usage: message.usage, timestamp: message.timestamp, durable: true }),
        onCompaction: async ({ summary, keptMessages, at, reason }) => {
          // Pi compacts after a context overflow with the refused response in its journal: as the legacy loop did, that
          // response is taken back from history, and the stream told so.
          const refused = transcript.context.at(-1) as AssistantMessage | undefined;
          if (reason === "overflow" && refused?.role === "assistant" && refused.stopReason === "error" && isContextOverflow(refused) && transcript.total > transcript.turnStart) {
            await transcript.retract();
            io.emit({ type: "message_retracted", index: await served("total", transcript.total, history => history.total) });
          }
          const cut = transcript.total - keptMessages;
          if (cut < transcript.offset || cut > transcript.total) throw new Error("Native compaction is outside the host working set");
          if (transcript.compaction?.cut === cut && transcript.compaction.summary === summary && transcript.compaction.at === at) return;
          const offset = transcript.offset;
          const state = { summary, cut, tokensBefore: contextTokens(transcript.view()), at };
          await transcript.compact(state, transcript.compaction, changes => getCurrentSystemMessage([leading(tools.map(toToolDeclaration)), ...changes]));
          io.emit({ type: "compaction_end", reason, tokensBefore: state.tokensBefore,
            keptMessages, summarizedMessages: cut - offset });
        },
      } });
      const cursor = await agent.discardInterruptedRun();
      // Recorded only when it moved: a start with nothing new writes no host record.
      if (cursor && !sameCursor(cursor, transcript.piCursor)) await transcript.commit(() => [{ t: "pi", cursor }]);
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
          try { await transcript.push(event.message, (event as unknown as { durable?: import("./transcript.ts").PiMessageCursor }).durable); }
          catch (error) { agent!.abort(); throw error; }
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
      // Reads move to the journal from here: its history starts where the host's stands now, once per session.
      if (historyFromJournal() && transcript instanceof NativeTranscript && journal) {
        await transcript.writeBase();
        piHistory = await JournalHistory.open(journal);
        // A session that already had its base: the turn it holds is the host's too.
        await served("turn", { active: transcript.active, turnStart: transcript.turnStart, awaiting: [...transcript.awaiting].sort() },
          history => ({ active: history.active, turnStart: history.turnStart, awaiting: [...history.awaiting].sort() }));
      }
      return { pid: process.pid, ...(migration ? { migration } : {}), recovered, messages: transcript.total, ...(resume ? { resume } : {}), ...(!recovered && config.resume ? endedTurn() : {}) };
    }
    // An import-only host (the Pi sweep's) has no agent: it answers its status and indexes its history as it is stopped.
    if (!agent && config?.importOnly && method === "status") return { pid: process.pid, ...(migration ? { migration } : {}), busy, messages: transcript.total };
    if (!agent && config?.importOnly && method === "historyFlush") { await index(true); return null; }
    if (!agent) throw new Error("Agent is not initialized");
    if (method === "status") return { pid: process.pid, ...(migration ? { migration } : {}), busy, messages: transcript.total, contextMessages: transcript.context.length, compacted: !!transcript.compaction };
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
    // Full history comes from the log; memory holds only the working set.
    if (method === "history") return { messages: await readTranscriptLog(transcript.log) };
    // Before a stop: index the settled turns, so a page of them needs neither the process nor the log.
    if (method === "historyFlush") { await index(true); return null; }
    // What the history index lacks yet: the running turn, and anything a failed write left. Null when nothing indexes the agent.
    if (method === "historyTail") {
      const backlog = transcript.backlog;
      // Part of it left to the log: the page reads the log instead.
      if (!backlog || backlog.kept !== backlog.from) return null;
      const messages = await served("tail", backlog.messages, async history => await history.messagesFrom(backlog.from) ?? NOT_HELD);
      return { from: backlog.from, messages, turns: backlog.turns };
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
    if (transcript.failed !== undefined) throw new Error(`${PERSISTENCE_FAILED}: ${String(transcript.failed)}`);
    // A prompt a turn took as a steer before the node running it stopped: it is in the history already, compacted or not.
    if (method === "prompt" && params.requestId && await transcript.hasRequest(params.requestId)) {
      return { messages: transcript.total, error: null, taken: true };
    }
    const promptMessages = method === "prompt" ? userMessages(params) : undefined;
    busy = true;
    stopped = undefined;
    output = undefined;
    forcing = { left: FORCED_OUTPUT_REQUESTS, reminding: false, last: false };
    active = new AbortController();
    try {
      // Aborted before this host had it (its session's `aborted`): a turn resumed from the transcript is open here, and is closed.
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
      if (method === "continue" && transcript.awaiting.length) throw new Error("The agent is waiting for input: answer it, or send a new prompt");
      await transcript.setActive(true);
      // Where the run's messages start in the agent's history, so a client can line up its stream with history pages.
      io.emit({ type: "turn_opened", index: await served("total", transcript.total, history => history.total) });
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
        if (active.signal.aborted) return await abortedBeforeLoop();
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
        if (params.landOnly) {
          // The runtime's refusal of a turn its message would start (a cap reached): the message lands in history, and no model is asked.
          const messages = await fittedImages(promptMessages!);
          for (const message of messages) {
            io.emit({ type: "message_start", message });
            await transcript.push(message);
            io.emit({ type: "message_end", message });
          }
          await transcript.setActive(false);
          const { stopped: why, message: said } = params.landOnly as RunStop;
          return { messages: transcript.total, error: said, stopped: why, ...stopFields(params.landOnly) };
        }
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
      // The next run starts from the transcript: Pi's summary and the messages it kept.
      if (method !== "execute" && transcript.failed === undefined) agent.state.messages = stateMessages();
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
   * A turn stopped at a step boundary for the next owner: left open (active) in the transcript, whose last message is a
   * tool result or the user's, so the next owner calls the model again with nothing lost (see `init`'s resume).
   */
  function handedOff() {
    return { messages: transcript.total, error: null, handedOff: true };
  }

  /**
   * An abort that came after the run began but before Pi's loop did: Pi's own abort found no loop to stop, so the run ends
   * here, checked in the same tick as each loop starts. The turn is settled in the transcript before the run is seen to
   * end: a turn resumed from it (a lost node's) may still have calls open, those to make again (`RERUN`) among them, which
   * are closed as unknown, never made; calls waiting on a person stay open.
   */
  async function abortedBeforeLoop() {
    rerun = [];
    const repairs = interruptedTurnRepairs(transcript.context, false, transcript.awaiting);
    if (repairs.length) await transcript.append(repairs);
    if (transcript.active) await transcript.setActive(false);
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
      await transcript.push(message);
      io.emit({ type: "message_end", message });
    }
    return wanted.length;
  }

  /**
   * The last turn, when it ended before its node was lost: whose it was (the prompts its user messages carry, the calls whose
   * results it holds) and what it ended with, so a run resumed here that never recorded its end takes that outcome, not an
   * unknown one.
   */
  function endedTurn() {
    if (transcript.active || transcript.total <= transcript.turnStart) return {};
    const turn = transcript.context.slice(Math.max(0, transcript.turnStart - transcript.offset));
    const said = turn.findLast(message => message.role === "assistant") as AssistantMessage | undefined;
    const given = turn.findLast(message => message.role === "toolResult" && message.toolName === OUTPUT_TOOL && !message.isError) as ToolResultMessage | undefined;
    return { ended: {
      requests: turn.flatMap(message => message.role === "user" && (message as { requestId?: string }).requestId ? [(message as { requestId?: string }).requestId!] : []),
      calls: turn.flatMap(message => message.role === "toolResult" ? [message.toolCallId] : []),
      finished: {
        messages: transcript.total, ...answer(said), ...(transcript.awaiting.length ? { stopped: "input_required" } : {}),
        ...(given ? { output: (given.details as { output?: unknown } | undefined)?.output } : {}),
      },
    } };
  }

  /**
   * The final answer's text, for callers that relay it (channels), and that message's index in the history; the model
   * that made it (`servedModel`, as `provider/model-id`: retries ask the same one); and when it failed, how (`modelError`).
   */
  function answer(last: AssistantMessage | undefined) {
    const said = last?.role === "assistant" ? last : undefined;
    const reply = said && said.stopReason !== "error" ? said.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim() : "";
    const at = reply ? transcript.context.lastIndexOf(last as AgentMessage) : -1;
    const failed = said?.stopReason === "error";
    return {
      error: failed ? said.errorMessage ?? "The model returned an error" : null, ...(reply ? { reply } : {}), ...(at >= 0 ? { replyIndex: transcript.offset + at } : {}),
      ...(said ? { servedModel: `${said.provider}/${said.model}` } : {}), ...(failed ? { modelError: modelFailure(said, failureContext()) } : {}),
    };
  }

  /**
   * Stop serving: abort the run and close the transcript, so nothing more is
   * written. An interrupted turn stays marked active and is recovered on next load.
   */
  async function dispose(flushMs = HISTORY_FLUSH_MS) {
    active?.abort();
    agent?.abort();
    await io.cancelTools();
    await agent?.close();
    if (flushMs > 0) await Promise.race([index(true), clock().sleep(flushMs)]);
    await transcript?.log.close();
  }

  /** Once the transcript failed, any request it ends says so, for the session to give the agent up (and reload it). */
  async function handled(method: string, params: any): Promise<any> {
    try {
      const result = await handle(method, params);
      // Each request's history length, as the journal gives it where the agent reads from there.
      if (piHistory && typeof result?.messages === "number") result.messages = await served("total", result.messages, history => history.total);
      // In `log` (production), a check reads the session's journal since its host generation began: at load, then at
      // most every DUAL_READ_INTERVAL_MS per agent. `throw` (tests, the simulation) checks after every run.
      if (io.piDualRead && journal && transcript?.failed === undefined && ["init", "prompt", "execute", "continue", "resume"].includes(method) &&
        (io.piDualRead === "throw" || method === "init" || clock().now() - lastDualRead >= DUAL_READ_INTERVAL_MS)) {
        lastDualRead = clock().now();
        await checkDualRead(io.piDualRead, config.id, journal, transcript.awaiting, transcript.active);
      }
      return result;
    }
    catch (error) {
      if (transcript?.failed !== undefined && !errorText(error).startsWith(PERSISTENCE_FAILED)) throw new Error(`${PERSISTENCE_FAILED}: ${errorText(error)}`);
      throw error;
    }
  }

  return { handle: turns.wrap(handled), dispose };
}

import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, convertToLlm, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  getCurrentSystemMessage, getCurrentTools, getSystemMessageText, getToolStateChanges, isContextOverflow, isRetryableAssistantError, toToolDeclaration,
  type AssistantMessage, type SystemMessage, type Tool,
} from "@earendil-works/pi-ai";
import { executeCode } from "./codemode.ts";
import type { AgentConfig, ToolBridge } from "./protocol.ts";
import { applicationInstructions, INSTRUCTIONS, leadingSystemMessage } from "./system-prompt.ts";
import type { AppendLog } from "../shared/append-log.ts";
import { Transcript, legacySnapshotPath, readTranscriptLog, summaryMessage, type CompactionState, type TranscriptRecord } from "./transcript.ts";
import { boundedContext, interruptedTurnRepairs, validateInitialMessages, validateUserMessages } from "./history.ts";
import { compactionSettings, contextTokens, explicitKeyStream, needsCompaction, runCompaction } from "./compaction.ts";
import { codeRequest, DEFAULT_RETRY } from "./limits.ts";

/** How a host talks to its supervisor: over IPC in its own process, or directly when inline. */
export interface HostIO {
  emit(event: unknown): void;
  /** Dispatch an application tool through the supervisor, which validates and limits it. */
  tool(name: string, args: Record<string, unknown>, toolCallId?: string): Promise<any>;
  /** Abort the application tool calls this agent has in flight. */
  cancelTools(): Promise<unknown>;
  /** Why the tenant may not spend more on models (a reached cap), if so. */
  spendLimit(): Promise<string | undefined>;
  /** The agent's transcript, which its supervisor writes. */
  transcript: AppendLog<TranscriptRecord>;
}

/**
 * One agent: its Pi loop, working-set transcript, compaction and retries. It runs
 * in its own process (agent-child.ts) or inline in a worker hosting many agents.
 */
export function createAgentHost(io: HostIO) {
  let agent: Agent | undefined;
  let config: AgentConfig;
  let transcript: Transcript;
  let busy = false;
  let active: AbortController | undefined;
  let persistenceError: unknown;
  /** Set when a spend limit ended the current run early. */
  let stopped: string | undefined;
  /** Messages a compaction folded into the summary during the current run, still in Pi's live state. */
  let dropped = new WeakSet<AgentMessage>();
  let summary: { state: CompactionState; message: AgentMessage } | undefined;

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
    return transcript.system ?? leadingSystemMessage(config.systemPrompt, tools);
  }

  /** Pi's messages from the transcript: what a run starts from. */
  function stateMessages(): AgentMessage[] { return [leading(), ...transcript.view()]; }

  /** The model's context: the leading system message, the current summary, and live messages not yet folded into it. */
  function liveView(messages: AgentMessage[]): AgentMessage[] {
    return [leading(), ...summaryView(), ...messages.filter((message, index) => !(index === 0 && message.role === "system") && message.role !== "compactionSummary" && !dropped.has(message))];
  }

  /**
   * Record a system message after the leading one, pinning that first so any node rebuilds the same
   * context. Both appends happen before the first await, so a run cannot slip in between.
   */
  function declare(message: SystemMessage, current: SystemMessage): Promise<unknown> {
    const writes = [...(transcript.system ? [] : [transcript.declareSystem(current, true)]), transcript.declareSystem(message)];
    return Promise.all(writes).catch(error => { persistenceError = error; throw error; });
  }

  /**
   * Bring the system messages in line with the configuration. Without history the leading message
   * is rebuilt; with history a change is appended, so the cached prefix stays byte-identical.
   */
  function declareConfiguration(): Promise<unknown> {
    const messages = agent!.state.messages;
    const tools = agent!.state.tools.map(toToolDeclaration);
    if (!transcript.total && !transcript.compaction) {
      agent!.state.messages = [leadingSystemMessage(config.systemPrompt, tools), ...messages.filter(message => message.role !== "system")];
      return Promise.resolve();
    }
    const instructions = applicationInstructions(config.systemPrompt);
    const { toolsAdded, toolsRemoved } = getToolStateChanges(getCurrentTools(messages), tools);
    const promptChanged = getCurrentSystemMessage(messages)?.sections?.[INSTRUCTIONS] !== instructions;
    if (!promptChanged && !toolsAdded.length && !toolsRemoved.length) return Promise.resolve();
    const change: SystemMessage = {
      role: "system", content: "", timestamp: Date.now(), ...(promptChanged ? { sections: { [INSTRUCTIONS]: instructions } } : {}),
      ...(toolsAdded.length ? { toolsAdded } : {}), ...(toolsRemoved.length ? { toolsRemoved } : {}),
    };
    const written = declare(change, messages[0] as SystemMessage);
    agent!.state.messages = [...messages, change];
    return written;
  }

  /** Summarize older context into the transcript. Failures leave the context as is; the next request retries. */
  async function compactNow(reason: "threshold" | "overflow", signal?: AbortSignal): Promise<boolean> {
    if (!config.apiKey) return false;
    io.emit({ type: "compaction_start", reason });
    try {
      const context = transcript.context.slice();
      const offset = transcript.offset;
      // An overflow means the real limit is lower than assumed: keep about a fifth of the context.
      const keepRecentTokens = reason === "overflow" ? Math.max(1_000, Math.floor(contextTokens([...summaryView(), ...context]) * 0.2)) : undefined;
      const outcome = await runCompaction({
        context, offset, previous: transcript.compaction, model: config.model, apiKey: config.apiKey, signal, keepRecentTokens,
        onResponse: message => io.emit({ type: "compaction_usage", provider: message.provider, model: message.model, usage: message.usage, timestamp: message.timestamp }),
      });
      if ("skipped" in outcome) {
        io.emit({ type: "compaction_end", reason, skipped: outcome.skipped });
        return false;
      }
      // System messages before the cut fold into the leading one: the summary starts a new prefix anyway.
      const folded = transcript.updates.filter(update => update.at <= outcome.state.cut).map(update => update.message);
      const system = folded.length ? getCurrentSystemMessage([leading(), ...folded]) : undefined;
      for (const message of [...context.slice(0, outcome.state.cut - offset), ...folded]) dropped.add(message);
      await transcript.compact(outcome.state, system);
      io.emit({ type: "compaction_end", reason, tokensBefore: outcome.state.tokensBefore, summarizedMessages: outcome.state.cut - offset, keptMessages: transcript.context.length });
      return true;
    } catch (error) {
      if (signal?.aborted) throw error;
      io.emit({ type: "compaction_end", reason, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /** Before every model request: compact when the context is too big, trimming only as a last resort. */
  async function contextFor(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
    let [system, ...view] = liveView(messages) as [SystemMessage, ...AgentMessage[]];
    const systemTokens = Math.ceil(getSystemMessageText(system).length / 4);
    if (needsCompaction(view, config.model, systemTokens) && await compactNow("threshold", signal)) [system, ...view] = liveView(messages) as [SystemMessage, ...AgentMessage[]];
    // Same budget as the compaction threshold, so this only trims when compaction could not run.
    const budget = config.model.contextWindow - compactionSettings(config.model).reserveTokens - systemTokens;
    const bounded = boundedContext(view, budget);
    if (bounded.length !== view.length) {
      io.emit({ type: "context_trimmed", retainedMessages: bounded.length, omittedMessages: view.length - bounded.length });
      // Changes in the trimmed part still apply.
      const trimmed = view.slice(0, view.length - bounded.length).filter(message => message.role === "system");
      if (trimmed.length) system = getCurrentSystemMessage([system, ...trimmed])!;
    }
    return [system, ...bounded];
  }

  function bridge(signal: AbortSignal): ToolBridge {
    return {
      definitions: config.tools.filter(tool => tool.exposure !== "direct"),
      call: async (name, args) => {
        signal.throwIfAborted();
        return io.tool(name, args);
      },
    };
  }

  function directAgentTools(tools: AgentConfig["tools"]): AgentTool[] {
    return tools.filter(tool => ["direct", "both"].includes(tool.exposure ?? "codemode")).map(tool => ({
        name: tool.name, label: tool.name, description: tool.description,
        parameters: tool.parameters as AgentTool["parameters"], executionMode: tool.executionMode,
        execute: async (toolCallId, args, signal) => {
          signal?.throwIfAborted();
          const value = await io.tool(tool.name, args as Record<string, unknown>, toolCallId);
          signal?.throwIfAborted();
          if (tool.resultFormat === "content") {
            if (!value || !Array.isArray(value.content) || value.content.some((part: any) => !part || !(part.type === "text" && typeof part.text === "string" || part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string"))) throw new Error("Invalid content tool result");
            if (value.isError === true) throw new Error(value.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") || "Tool execution failed");
            return value;
          }
          return { content: [{ type: "text", text: JSON.stringify(value) ?? "null" }], details: value };
        },
      }));
  }

  function userMessages(value: unknown): AgentMessage[] {
    const messages = (Array.isArray(value) ? value : [value]) as AgentMessage[];
    validateUserMessages(messages);
    return messages;
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
        agent!.state.messages = agent!.state.messages.slice(0, -1);
        if (!await compactNow("overflow", signal)) {
          // Keep the error visible: nothing could be summarized, so a retry would overflow again.
          await transcript.push(last);
          agent!.state.messages = [...agent!.state.messages, last];
          return;
        }
        await agent!.continue();
        attempt--;
        continue;
      }
      if (!isRetryableAssistantError(last)) return;
      if (attempt > policy.maxAttempts) {
        io.emit({ type: "auto_retry_end", success: false, attempt: attempt - 1, finalError: last.errorMessage });
        return;
      }
      const delayMs = policy.baseDelayMs * 2 ** (attempt - 1);
      io.emit({ type: "auto_retry_start", attempt, maxAttempts: policy.maxAttempts, delayMs, errorMessage: last.errorMessage ?? "Unknown error" });
      // The failed attempt is not history: drop it from the log and the live state.
      await transcript.retract();
      agent!.state.messages = agent!.state.messages.slice(0, -1);
      try { await sleep(delayMs, undefined, { signal }); }
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
      transcript = new Transcript(io.transcript);
      await transcript.load(config.localTranscript ? legacySnapshotPath(config.directory) : undefined);
      let recovered = false;
      let resume: { continue: true } | { finished: { messages: number; error: string | null; reply?: string } } | undefined;
      if (transcript.active && config.resume) {
        // A response cut off when its node stopped is not history; the model is asked again.
        for (let last = transcript.context.at(-1); last?.role === "assistant" && ["aborted", "error"].includes(last.stopReason) && transcript.total > transcript.turnStart; last = transcript.context.at(-1)) await transcript.retract();
        // Answer tool calls whose outcome was lost as unknown, never by running them again.
        await transcript.append(interruptedTurnRepairs(transcript.context, false));
        const last = transcript.context.at(-1);
        // At a step boundary the model is simply called again; a final answer means the turn had ended.
        if (last && (last.role === "user" || last.role === "toolResult")) resume = { continue: true };
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
        await transcript.replace(config.initialMessages);
      }
      const directTools = directAgentTools(config.tools);
      const jsExec: AgentTool = {
        name: "js_exec", label: "JavaScript",
        description: "Execute JavaScript or TypeScript in a fresh QuickJS/WebAssembly sandbox. Only approved tools and output helpers are available: no filesystem, network, imports, process, Node/Bun APIs, or timers. Use await tools.search(query), await tools.describe(name), and await tools.<name>(args). Use text(value), console.log(value), or return to emit output. Calls can be composed with Promise.all. State does not survive between invocations.",
        parameters: {
          type: "object", required: ["code"],
          properties: { code: { type: "string" }, description: { type: "string" }, timeoutMs: { type: "number" }, maxOutputCharacters: { type: "number" } },
        } as AgentTool["parameters"],
        executionMode: "sequential",
        execute: async (id, args, signal, onUpdate) => {
          try {
            const result = await executeCode({
              ...codeRequest(args), bridge: bridge(signal ?? new AbortController().signal), signal,
              onEvent: event => {
                io.emit({ type: "codemode", toolCallId: id, event });
                onUpdate?.({ content: [{ type: "text", text: JSON.stringify(event) }], details: event });
              },
            });
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          } finally { await io.cancelTools(); }
        },
      };
      const tools = [jsExec, ...directTools];
      agent = new Agent({
        initialState: {
          model: config.model,
          tools, messages: [leading(tools.map(toToolDeclaration)), ...transcript.view()],
          thinkingLevel: config.thinkingLevel ?? "off",
        },
        getApiKey: () => config.apiKey,
        // Only the tenant's explicit key, never provider keys from the process environment.
        streamFn: explicitKeyStream(),
        // Renders compaction summaries for the model (the default drops non-chat roles).
        convertToLlm,
        transformContext: (messages, signal) => contextFor(messages, signal),
        // A tenant past its spend cap stops before the next model request, after this response's tool results.
        finishTurn: async turn => {
          if (!turn.toolResults.length && !agent!.hasQueuedMessages()) return;
          let reason: string | undefined;
          try { reason = await io.spendLimit(); }
          catch { return; /* Unknown spend never stops a turn. */ }
          if (!reason) return;
          stopped = reason;
          io.emit({ type: "spend_limit_reached", message: reason });
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
        if (event.type === "message_end") {
          // One durable append per finished message. Streaming deltas are never persisted.
          try { await transcript.push(event.message); }
          catch (error) { persistenceError = error; agent!.abort(); throw error; }
        }
        io.emit(event);
      });
      // A configuration changed elsewhere (another node, or while this agent was stopped) applies from here.
      await declareConfiguration();
      return { pid: process.pid, recovered, messages: transcript.total, ...(resume ? { resume } : {}) };
    }
    if (!agent) throw new Error("Agent is not initialized");
    if (method === "status") return { pid: process.pid, busy, messages: transcript.total, contextMessages: transcript.context.length, compacted: !!transcript.compaction };
    if (method === "configure") {
      if (busy) throw new Error("Agent is busy");
      if (params.systemPrompt !== undefined) config.systemPrompt = params.systemPrompt;
      if (params.model !== undefined) { config.model = params.model; agent.state.model = params.model; }
      if (params.thinkingLevel !== undefined) { config.thinkingLevel = params.thinkingLevel; agent.state.thinkingLevel = params.thinkingLevel; }
      if (params.apiKey !== undefined) config.apiKey = params.apiKey;
      if (params.tools !== undefined) { config.tools = params.tools; agent.state.tools = [agent.state.tools.find(tool => tool.name === "js_exec")!, ...directAgentTools(config.tools)]; }
      if (params.systemPrompt !== undefined || params.tools !== undefined) await declareConfiguration();
      return { configured: true };
    }
    // Full history comes from the log; memory holds only the working set.
    if (method === "history") return { messages: await readTranscriptLog(transcript.log) };
    if (method === "steer" || method === "followUp") {
      // Pi queues these whether or not a run is active; an idle queue drains into the next run.
      const messages = params.message !== undefined ? userMessages(params.message) : undefined;
      if (!messages && (typeof params.text !== "string" || !params.text.trim())) throw new Error("Prompt text is required");
      for (const message of messages ?? [{ role: "user", content: params.text, timestamp: Date.now() } as AgentMessage]) agent[method](message);
      return { queued: true, running: busy };
    }
    if (method === "abort") { active?.abort(); agent.abort(); return { aborted: true }; }
    if (method !== "prompt" && method !== "execute" && method !== "continue") throw new Error(`Unknown method: ${method}`);
    if (busy) throw new Error("Agent is busy");
    if (persistenceError) throw new Error(`Session persistence failed: ${String(persistenceError)}`);
    if (method === "prompt" && params.message === undefined && (typeof params.text !== "string" || !params.text.trim())) throw new Error("Prompt text is required");
    const promptMessages = method === "prompt" && params.message !== undefined ? userMessages(params.message) : undefined;
    busy = true;
    stopped = undefined;
    active = new AbortController();
    try {
      if (method === "execute") return await executeCode({ ...codeRequest(params), bridge: bridge(active.signal), signal: active.signal, onEvent: event => io.emit(event) });
      await transcript.setActive(true);
      if (method === "continue") await agent.continue();
      else if (promptMessages) await agent.prompt(promptMessages);
      else await agent.prompt(params.text, params.images);
      await recoverFailedResponses(active.signal);
      if (persistenceError) throw persistenceError;
      await transcript.setActive(false);
      const last = agent.state.messages.at(-1) as AssistantMessage | undefined;
      return { messages: transcript.total, ...answer(last), error: agent.state.errorMessage ?? null, ...(stopped ? { stopped: "spend_limit", error: stopped } : {}) };
    } finally {
      // Release what compaction folded away: the next run starts from summary + kept messages.
      if (method !== "execute" && !persistenceError) {
        agent.state.messages = stateMessages();
        dropped = new WeakSet();
      }
      await io.cancelTools();
      active = undefined;
      busy = false;
    }
  }

  /** The final answer's text, for callers that relay it (channels). */
  function answer(last: AssistantMessage | undefined) {
    const reply = last?.role === "assistant" && last.stopReason !== "error" ? last.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim() : "";
    return { error: last?.stopReason === "error" ? last.errorMessage ?? "The model returned an error" : null, ...(reply ? { reply } : {}) };
  }

  /**
   * Stop serving: abort the run and close the transcript, so nothing more is
   * written. An interrupted turn stays marked active and is recovered on next load.
   */
  async function dispose() {
    active?.abort();
    agent?.abort();
    await transcript?.log.close();
  }

  return { handle, dispose };
}

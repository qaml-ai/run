import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, convertToLlm, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  getCurrentSystemMessage, getCurrentTools, getSystemMessageText, getToolStateChanges, isContextOverflow, isRetryableAssistantError, toToolDeclaration, validateToolArguments,
  type AssistantMessage, type Message, type SystemMessage, type Tool, type ToolCall,
} from "@earendil-works/pi-ai";
import { executeCode } from "./codemode.ts";
import { scriptValue } from "./mcp-results.ts";
import { errorText, IDENTITY_KEY, SCOPE_KEY, type AgentConfig, type CallContext, type Credentials, type ToolBridge } from "./protocol.ts";
import { applicationInstructions, ENVIRONMENT, environmentSummary, INSTRUCTIONS, leadingSystemMessage } from "./system-prompt.ts";
import { renderMessages, senderInput, withSender, type Sender } from "./sender.ts";
import type { SearchHit, SearchQuery } from "./tool-search.ts";
import type { AppendLog } from "../shared/append-log.ts";
import { Transcript, readTranscriptLog, summaryMessage, type CompactionState, type TranscriptRecord } from "./transcript.ts";
import { boundedContext, interruptedTurnRepairs, validateInitialMessages, validateUserMessages } from "./history.ts";
import { compactionSettings, contextTokens, explicitKeyStream, needsCompaction, runCompaction } from "./compaction.ts";
import { codeRequest, DEFAULT_RETRY } from "./limits.ts";
import { describeFile, documentPayload, FILE_LIMITS, nativeBlock, unseen, validFileRef, type FileRef } from "./files.ts";

/** How a host talks to its supervisor: over IPC in its own process, or directly when inline. */
export interface HostIO {
  emit(event: unknown): void;
  /** Dispatch an application tool through the supervisor, which validates and limits it. */
  tool(name: string, args: Record<string, unknown>, call?: CallContext): Promise<any>;
  /** Abort the application tool calls this agent has in flight. */
  cancelTools(): Promise<unknown>;
  /** Why the tenant may not spend more on models (a reached cap), if so. */
  spendLimit(): Promise<string | undefined>;
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
  /** Why the current run ended early: a spend limit, or tool calls waiting on a person's input. */
  let stopped: { stopped: "spend_limit" | "input_required"; error?: string } | undefined;
  /** Messages a compaction folded into the summary during the current run, still in Pi's live state. */
  let dropped = new WeakSet<AgentMessage>();
  let summary: { state: CompactionState; message: AgentMessage } | undefined;
  /** Files' bytes (base64) by content, least recently used first, kept between model requests. */
  const hydrated = new Map<string, string>();
  let hydratedBytes = 0;
  /** Whether the model request being built carries a PDF, whose block the provider payload needs rewritten. */
  let documents = false;

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
      agent!.state.messages = [leadingSystemMessage(config, tools), ...messages.filter(message => message.role !== "system")];
      return Promise.resolve();
    }
    const { toolsAdded, toolsRemoved } = getToolStateChanges(getCurrentTools(messages), tools);
    const current = getCurrentSystemMessage(messages)?.sections ?? {};
    const wanted = { [INSTRUCTIONS]: applicationInstructions(config.systemPrompt, config.systemPromptAppend), [ENVIRONMENT]: environmentSummary(config) };
    const sections = Object.fromEntries(Object.entries(wanted).filter(([name, text]) => current[name] !== text));
    if (!Object.keys(sections).length && !toolsAdded.length && !toolsRemoved.length) return Promise.resolve();
    const change: SystemMessage = {
      role: "system", content: "", timestamp: Date.now(), ...(Object.keys(sections).length ? { sections } : {}),
      ...(toolsAdded.length ? { toolsAdded } : {}), ...(toolsRemoved.length ? { toolsRemoved } : {}),
    };
    const written = declare(change, messages[0] as SystemMessage);
    agent!.state.messages = [...messages, change];
    return written;
  }

  /** Whether each model call asks the supervisor for its credentials. */
  const perCall = () => config.apiKey === IDENTITY_KEY || config.apiKey === SCOPE_KEY;

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
        // The summarizer reads messages as the model does, senders included; rendering keeps their count, so the cut still indexes the context.
        context: renderMessages(context), offset, previous: transcript.compaction, model: config.model, apiKey: perCall() ? () => io.modelAuth() : config.apiKey, signal, keepRecentTokens,
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

  /** The tools code can call; `toolCallId` is the js_exec call running it, if the model made one. */
  function bridge(signal: AbortSignal, toolCallId?: string): ToolBridge {
    let calls = 0;
    return {
      definitions: config.tools.filter(tool => tool.exposure !== "direct"),
      call: async (name, args) => {
        signal.throwIfAborted();
        const value = await io.tool(name, args, toolCallId ? { toolCallId, innerCallId: `${toolCallId}:${++calls}` } : undefined);
        // MCP tools answer with content; code gets their data.
        return config.tools.find(tool => tool.name === name)?.resultFormat === "content" ? scriptValue(value) : value;
      },
      ...(io.search ? { search: io.search } : {}),
      fs: (op, args) => { signal.throwIfAborted(); return io.fs(op, args); },
    };
  }

  function directAgentTools(tools: AgentConfig["tools"]): AgentTool[] {
    return tools.filter(tool => ["direct", "both"].includes(tool.exposure ?? "codemode")).map(tool => ({
        name: tool.name, label: tool.name, description: tool.description,
        parameters: tool.parameters as AgentTool["parameters"], executionMode: tool.executionMode,
        execute: async (toolCallId, args, signal) => {
          signal?.throwIfAborted();
          const value = await io.tool(tool.name, args as Record<string, unknown>, { toolCallId });
          signal?.throwIfAborted();
          // The call waits on a person (inputs.ts): it stays open, with no result, and the turn suspends after this step.
          if (value?.inputRequired) {
            try { await transcript.await([toolCallId]); }
            catch (error) { persistenceError = error; throw error; }
            return { content: value.content, details: { inputRequired: true } };
          }
          if (tool.resultFormat === "content") {
            if (!value || !Array.isArray(value.content) || value.content.some((part: any) => !part || !(part.type === "text" && typeof part.text === "string" || part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string" || validFileRef(part)))) throw new Error("Invalid content tool result");
            if (value.isError === true) throw new Error(value.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") || "Tool execution failed");
            return value;
          }
          return { content: [{ type: "text", text: JSON.stringify(value) ?? "null" }], details: value };
        },
      }));
  }

  async function fileData(ref: FileRef) {
    const key = ref.chunks.join("");
    let data = hydrated.get(key);
    if (data !== undefined) hydrated.delete(key);
    else {
      data = await io.file(ref);
      hydratedBytes += data.length;
      for (const [old, value] of hydrated) {
        if (hydratedBytes <= FILE_LIMITS.hydratedBytes) break;
        hydrated.delete(old);
        hydratedBytes -= value.length;
      }
    }
    hydrated.set(key, data);
    return data;
  }

  /**
   * The model request's files: the transcript keeps references, and each becomes a line naming it
   * plus, where the model can take it, its bytes as a native block. The same references always
   * give the same request, so the provider's cached prefix holds. Past the request's file budget,
   * older files are named but not shown.
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
    return Promise.all(messages.map(async message => {
      if (!Array.isArray(message.content) || !message.content.some(block => (block.type as string) === "file")) return message;
      const content: unknown[] = [];
      for (const block of message.content as unknown as (FileRef | { type: string })[]) {
        if (block.type !== "file") { content.push(block); continue; }
        const ref = block as FileRef;
        const kind = shown.has(ref) ? nativeBlock(ref, config.model) : undefined;
        if (!kind) { content.push({ type: "text", text: describeFile(ref, unseen(ref, config.model) ?? (nativeBlock(ref, config.model) ? "not shown, as this request holds too many files; read it to view it" : undefined)) }); continue; }
        try {
          content.push({ type: "text", text: describeFile(ref) }, { type: "image", data: await fileData(ref), mimeType: kind === "image" && ref.media?.kind === "image" ? ref.media.mimeType : "application/pdf" });
          if (kind === "document") documents = true;
        } catch (error) { content.push({ type: "text", text: describeFile(ref, `could not be read (${errorText(error)})`) }); }
      }
      return { ...message, content } as Message;
    }));
  }

  /** The user messages a request adds: given whole, or as text and attached files; marked with its sender, if any. */
  function userMessages(params: Record<string, any>): AgentMessage[] {
    const from = senderInput(params.from);
    if (params.message !== undefined) {
      const messages = (Array.isArray(params.message) ? params.message : [params.message]) as AgentMessage[];
      validateUserMessages(messages);
      return withSender(messages, from);
    }
    if (typeof params.text !== "string" || !params.text.trim()) throw new Error("Prompt text is required");
    const files = params.files ?? [];
    if (!Array.isArray(files) || files.length > FILE_LIMITS.attachments || !files.every(validFileRef)) throw new Error("Invalid attached files");
    // Images inline in `images` come only from runs queued before attachments were saved as files.
    return [{ role: "user", content: [{ type: "text", text: params.text }, ...files, ...(params.images ?? [])], timestamp: Date.now(), ...(from ? { from } : {}) } as AgentMessage & { from?: Sender }];
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
      // A tenant's own endpoint has retried already: its errors (a credit gate's 402, say) end the turn.
      if (!isRetryableAssistantError(last) || config.apiKey === IDENTITY_KEY) return;
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
      await transcript.load();
      let recovered = false;
      let resume: { continue: true } | { finished: { messages: number; error: string | null; reply?: string; stopped?: string } } | undefined;
      if (transcript.active && transcript.awaiting.length) {
        // The turn had suspended for input when its node stopped: its other calls are closed as unknown, and it stays suspended.
        await transcript.append(interruptedTurnRepairs(transcript.context, false, transcript.awaiting));
        await transcript.setActive(false);
        if (config.resume) resume = { finished: { messages: transcript.total, error: null, stopped: "input_required" } };
        recovered = true;
      } else if (transcript.active && config.resume) {
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
        description: "Run JavaScript or TypeScript in a fresh QuickJS sandbox. What you return, and what you console.log or text(value), comes back. In scope: tools (await tools.<name>(args); tools.search, tools.namespaces and tools.describe find them) and fs for your files (readFile(path, { encoding: \"utf8\" }) gives a string, a Uint8Array without it; writeFile(path, string | Uint8Array); stat, list, remove); no network, imports, Node APIs or timers. Variables are gone after each execution; files persist. For example:\nconst tickets = [];\nfor (let page = 1; page; ) { const result = await tools.helpdesk__list_tickets({ status: \"open\", page }); tickets.push(...result.tickets); page = result.nextPage; }\nawait fs.writeFile(\"/workspace/tmp/tickets.json\", JSON.stringify(tickets)); // a later execution can read it back\nreturn { open: tickets.length, oldest: tickets[0]?.createdAt };",
        parameters: {
          type: "object", required: ["code"],
          properties: { code: { type: "string" }, description: { type: "string" }, timeoutMs: { type: "number" }, maxOutputCharacters: { type: "number" } },
        } as AgentTool["parameters"],
        executionMode: "sequential",
        execute: async (id, args, signal, onUpdate) => {
          try {
            const result = await executeCode({
              ...codeRequest(args), bridge: bridge(signal ?? new AbortController().signal, id), signal,
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
        // Only the tenant's explicit key, never provider keys from the process environment. A model on the
        // tenant's own endpoint gets a fresh identity token for each call, and a key scope's agent its scope's current key.
        streamFn: explicitKeyStream(() => perCall() ? io.modelAuth() : undefined),
        // Renders compaction summaries for the model (the default drops non-chat roles), and each message's sender.
        convertToLlm: messages => hydrate(convertToLlm(renderMessages(messages))),
        onPayload: payload => documents ? documentPayload(payload) : undefined,
        transformContext: (messages, signal) => contextFor(messages, signal),
        // A turn with calls waiting on a person suspends; a tenant past its spend cap stops before the next model request, after this response's tool results.
        finishTurn: async turn => {
          if (transcript.awaiting.length) {
            stopped = { stopped: "input_required" };
            return { action: "end" };
          }
          if (!turn.toolResults.length && !agent!.hasQueuedMessages()) return;
          let reason: string | undefined;
          try { reason = await io.spendLimit(); }
          catch { return; /* Unknown spend never stops a turn. */ }
          if (!reason) return;
          stopped = { stopped: "spend_limit", error: reason };
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
        // A call waiting on input has no result yet: the transcript keeps it open instead (`awaiting`).
        if (event.type === "message_end" && !(event.message.role === "toolResult" && (event.message.details as { inputRequired?: boolean } | undefined)?.inputRequired)) {
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
      if (params.systemPromptAppend !== undefined) config.systemPromptAppend = params.systemPromptAppend;
      if (params.fileTools !== undefined) config.fileTools = params.fileTools;
      if (params.model !== undefined) { config.model = params.model; agent.state.model = params.model; }
      if (params.thinkingLevel !== undefined) { config.thinkingLevel = params.thinkingLevel; agent.state.thinkingLevel = params.thinkingLevel; }
      if (params.apiKey !== undefined) config.apiKey = params.apiKey;
      if (params.tools !== undefined) { config.tools = params.tools; agent.state.tools = [agent.state.tools.find(tool => tool.name === "js_exec")!, ...directAgentTools(config.tools)]; }
      if (params.systemPrompt !== undefined || params.systemPromptAppend !== undefined || params.tools !== undefined || params.model !== undefined) await declareConfiguration();
      return { configured: true };
    }
    // Full history comes from the log; memory holds only the working set.
    if (method === "history") return { messages: await readTranscriptLog(transcript.log) };
    if (method === "steer" || method === "followUp") {
      // Pi queues these whether or not a run is active; an idle queue drains into the next run.
      for (const message of userMessages(params)) agent[method](message);
      return { queued: true, running: busy };
    }
    if (method === "abort") { active?.abort(); agent.abort(); return { aborted: true }; }
    if (method !== "prompt" && method !== "execute" && method !== "continue" && method !== "resume") throw new Error(`Unknown method: ${method}`);
    if (busy) throw new Error("Agent is busy");
    if (persistenceError) throw new Error(`Session persistence failed: ${String(persistenceError)}`);
    const promptMessages = method === "prompt" ? userMessages(params) : undefined;
    busy = true;
    stopped = undefined;
    active = new AbortController();
    try {
      if (method === "execute") return await executeCode({ ...codeRequest(params), bridge: bridge(active.signal), signal: active.signal, onEvent: event => io.emit(event) });
      if (method === "continue" && transcript.awaiting.length) throw new Error("The agent is waiting for input: answer it, or send a new prompt");
      await transcript.setActive(true);
      if (method === "resume") {
        const settled = await settle(params.calls ?? [], active.signal);
        // Closed without the model (expired or cancelled inputs), still waiting, or nothing left to resume.
        if (params.close || transcript.awaiting.length || !settled) {
          await transcript.setActive(false);
          return { messages: transcript.total, error: null, ...(transcript.awaiting.length ? { stopped: "input_required" } : {}) };
        }
        agent.state.messages = stateMessages();
        await agent.continue();
      } else if (method === "continue") await agent.continue();
      else {
        // A new message supersedes calls still waiting on input: each is closed first, so the model sees why.
        if (transcript.awaiting.length) {
          await settle(transcript.awaiting.map(toolCallId => ({ toolCallId, result: { content: [{ type: "text", text: "Not answered: the user sent a new message instead (next)." }], isError: true } })), active.signal);
          agent.state.messages = stateMessages();
        }
        await agent.prompt(promptMessages!);
      }
      await recoverFailedResponses(active.signal);
      if (persistenceError) throw persistenceError;
      await transcript.setActive(false);
      // A suspended turn ends on its open calls: what the model said as it made them is the reply so far.
      const last = (transcript.awaiting.length ? agent.state.messages.findLast(message => message.role === "assistant") : agent.state.messages.at(-1)) as AssistantMessage | undefined;
      return { messages: transcript.total, ...answer(last), error: agent.state.errorMessage ?? null, ...(stopped ?? {}) };
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
      let result = call.result;
      if (!result) {
        const tool = agent!.state.tools.find(entry => entry.name === toolCall?.name && entry.name !== "js_exec");
        try {
          if (!tool || !toolCall) throw new Error(`${toolCall?.name ?? "This tool"} is no longer available to this agent`);
          // The arguments as Pi gave them the first time: the approval is bound to them (inputs.ts).
          result = await tool.execute(call.toolCallId, validateToolArguments(tool, toolCall), signal) as Settled;
        } catch (error) { result = { content: [{ type: "text", text: errorText(error) }], isError: true }; }
        // Asked again (another round of input): the call stays open.
        if ((result!.details as { inputRequired?: boolean } | undefined)?.inputRequired) continue;
      }
      const message = { role: "toolResult", toolCallId: call.toolCallId, toolName: toolCall?.name ?? "", content: result!.content, ...(result!.details !== undefined ? { details: result!.details } : {}), isError: !!result!.isError, timestamp: Date.now() } as AgentMessage;
      try { await transcript.push(message); }
      catch (error) { persistenceError = error; throw error; }
      io.emit({ type: "message_end", message });
    }
    return wanted.length;
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

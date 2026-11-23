import { V1_COMPAT_REQUEST_PREFIX } from "../../../shared/client-protocol.ts";
import { CamelFsClient } from "./camelfs.ts";
import { openSecret, randomId } from "./crypto.ts";
import {
  addModelUsage,
  addVmUsage,
  getModelContextWindow,
  streamModelResponse,
  type ConversationMessage,
} from "./providers.ts";
import { storeToolImages } from "./tool-images.ts";
import { verifyRunFiles } from "./run-files.ts";
import { readLegacyInlineContent } from "./legacy-inline-images.ts";
import { getTenantStub, platformCreditReserve } from "./tenant-do.ts";
import type { ToolApproval } from "./tool-identity.ts";
import {
  buildToolCatalog,
  executeToolCall,
  PauseForInputSignal,
  type BuiltToolCatalog,
  type PausedMcpInput,
  type ToolExecutionContext,
} from "./tools.ts";
import {
  ApiError,
  emptyUsage,
  estimateTokens,
  extractApiError,
  type AgentConfig,
  type Env,
  type PendingInputView,
  type RunRecord,
  type RunFile,
  type RunUsage,
  type StartRunHints,
  type StoredMessage,
  type ToolCallInvocation,
  type ToolCallSummary,
} from "./types.ts";

export interface PausedTurnState {
  stepIndex: number;
  maxSteps: number;
  outputSchema: Record<string, unknown> | null;
  approvedToolCallIds: string[];
  approval?: ToolApproval;
  mcpInput?: PausedMcpInput;
  currentToolCall: ToolCallInvocation;
  remainingToolCalls: ToolCallInvocation[];
  accText: string;
  toolCallsSummary: ToolCallSummary[];
  filesChanged: string[];
  usage: RunUsage;
}

export interface TurnStorageAdapter {
  env: Env;
  getConfig(): AgentConfig;
  getLatestCompaction(): { id: string; upToSeq: number; summary: string } | null;
  insertCompaction(upToSeq: number, summary: string): { id: string; upToSeq: number; summary: string };
  listMessagesAfter(seq: number): StoredMessage[];
  measureMessagesAfter?(seq: number): { count: number; tokensEst: number; lastTokensEst: number };
  listRecentMessagesAfter?(seq: number, limit: number): StoredMessage[];
  appendMessage(
    runId: string | null,
    role: StoredMessage["role"],
    content: StoredMessage["content"],
  ): StoredMessage;
  drainSteers(runId: string): Array<{ id: string; text: string }>;
  emitEvent(runId: string | null, type: string, data: Record<string, unknown>): void;
  createPendingInput(entry: {
    id: string;
    runId: string;
    toolCallId: string;
    kind: "approval" | "question";
    prompt: Record<string, unknown>;
    pendingTurn: PausedTurnState;
    expiresAt: number;
  }): PendingInputView;
  updateRunState(
    runId: string,
    patch: Partial<{
      status: RunRecord["status"];
      text: string;
      output: unknown;
      toolCalls: ToolCallSummary[];
      filesChanged: string[];
      usage: RunUsage;
      error: { code: string; message: string } | null;
      ended: boolean;
    }>,
  ): void;
  getRunRecord(runId: string): RunRecord;
  getRunSpendLimit(runId: string): number | null;
  recordModelUsage(
    runId: string,
    kind: "response" | "compaction",
    input: number,
    output: number,
    cumulative: RunUsage,
    cacheRead?: number,
  ): Promise<void>;
  makeToolContext(
    runId: string,
    approvedToolCallIds: Set<string>,
    onFilesChanged: (files: string[]) => void,
    onVmMs: (ms: number) => void,
    signal?: AbortSignal,
  ): ToolExecutionContext;
}

export function buildConversationMessages(
  compaction: { upToSeq: number; summary: string } | null,
  stored: StoredMessage[],
): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  if (compaction && compaction.summary) {
    out.push({
      role: "system",
      text: `Previous conversation summary (up to message #${compaction.upToSeq}):\n${compaction.summary}`,
    });
  }
  const append = (m: StoredMessage, toolCalls = m.content.toolCalls) => {
    const files = m.content.files;
    const text = files?.length
      ? [m.content.text, ...files.map((file) =>
          `Workspace attachment ${JSON.stringify(file.path)} at commit ${file.commit} (${file.contentType}, ${file.size} bytes).`),
        ].filter(Boolean).join("\n")
      : m.content.text;
    out.push({
      role: m.role,
      text,
      files,
      toolImages: m.content.toolImages,
      legacyInlineContent: readLegacyInlineContent(m.content),
      toolCalls,
      toolCallId: m.content.toolCallId,
      toolName: m.content.toolName,
      isError: m.content.isError,
    });
  };
  for (let i = 0; i < stored.length; i++) {
    const message = stored[i]!;
    if (message.role === "tool") continue;
    const calls = message.role === "assistant" ? message.content.toolCalls : undefined;
    if (!calls?.length) {
      append(message);
      continue;
    }

    // A stopped turn can leave some calls without recorded results. Keep the
    // stored history intact and send only completed pairs to the provider.
    const pending = new Set(calls.map((call) => call.id));
    const results: StoredMessage[] = [];
    while (stored[i + 1]?.role === "tool") {
      const result = stored[++i]!;
      const id = result.content.toolCallId;
      if (result.runId !== message.runId || !id || !pending.delete(id)) continue;
      results.push(result);
    }
    if (results.length || message.content.text || message.content.files?.length) {
      append(message, calls.filter((call) => !pending.has(call.id)));
    }
    for (const result of results) append(result);
  }
  return out;
}

/** Keep tool calls and all their results on the same side of a context boundary. */
export function contextCutoff(messages: readonly Pick<StoredMessage, "role">[], keepLast: number): number {
  let cutoff = messages.length - Math.min(messages.length, Math.max(0, Math.trunc(keepLast) || 0));
  while (cutoff > 0 && messages[cutoff]?.role === "tool") cutoff--;
  return cutoff;
}

function clampMessageForSummary(msg: StoredMessage, perMsgCap: number): StoredMessage {
  const text = typeof msg.content.text === "string" && msg.content.text.length > perMsgCap
    ? `${msg.content.text.slice(0, perMsgCap)}\n...[truncated ${msg.content.text.length - perMsgCap} chars]`
    : msg.content.text;
  const toolCalls = msg.content.toolCalls?.map((tc) => {
    const rawArgs = tc.argumentsJson || JSON.stringify(tc.args ?? {});
    if (rawArgs.length <= 1500) return tc;
    const truncated = { _truncated: rawArgs.slice(0, 1500) };
    return { ...tc, args: truncated, argumentsJson: JSON.stringify(truncated) };
  });
  return {
    ...msg,
    content: {
      ...msg.content,
      ...(text !== undefined ? { text } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      // Drop raw file/image attachments during compaction summarization to keep payload bounded.
      files: undefined,
    },
  };
}

function buildBoundedSummaryMessages(
  prev: { upToSeq: number; summary: string } | null,
  messages: StoredMessage[],
  opts: { maxChars?: number; maxMessages?: number; perMsgCap?: number; hadOlderOmitted?: boolean } = {},
): ConversationMessage[] {
  const maxChars = opts.maxChars ?? 240_000;
  const maxMessages = opts.maxMessages ?? 120;
  const perMsgCap = opts.perMsgCap ?? 4_000;

  const picked: StoredMessage[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0 && picked.length < maxMessages; i--) {
    const clamped = clampMessageForSummary(messages[i]!, perMsgCap);
    const size = (clamped.content.text?.length ?? 0) + (clamped.content.toolCalls ? JSON.stringify(clamped.content.toolCalls).length : 0) + 64;
    if (picked.length > 0 && chars + size > maxChars) break;
    picked.push(clamped);
    chars += size;
  }
  picked.reverse();
  let start = 0;
  while (start < picked.length && picked[start]?.role === "tool") start++;
  const windowMsgs = picked.slice(start);
  const omitted = opts.hadOlderOmitted || windowMsgs.length < messages.length;
  const conv = buildConversationMessages(prev, windowMsgs);
  if (omitted) {
    conv.unshift({
      role: "system",
      text: "Note: Earlier historical messages prior to this window were archived. Summarize the active context below, preserving key decisions, file paths, facts, and open tasks.",
    });
  }
  return conv;
}

function buildFallbackDigestMessages(
  prev: { upToSeq: number; summary: string } | null,
  messages: StoredMessage[],
): ConversationMessage[] {
  const lines: string[] = [];
  if (prev?.summary) lines.push(`Previous summary:\n${prev.summary.slice(0, 4000)}`);
  let chars = lines.join("\n").length;
  const recentLines: string[] = [];
  for (let i = messages.length - 1; i >= 0 && recentLines.length < 30; i--) {
    const m = messages[i]!;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const snippet = (m.content.text ?? "").trim().slice(0, 800);
    if (!snippet) continue;
    const entry = `[${m.role}]: ${snippet}`;
    if (chars + entry.length > 32_000) break;
    recentLines.push(entry);
    chars += entry.length;
  }
  recentLines.reverse();
  lines.push(...recentLines);
  return [
    {
      role: "user",
      text: `Summarize this conversation excerpt concisely, preserving key decisions, file paths, facts, and open tasks:\n\n${lines.join("\n\n") || "(No text messages to summarize.)"}`,
    },
  ];
}

export async function performCompaction(
  adapter: TurnStorageAdapter,
  options?: {
    customSummary?: string;
    keepLast?: number;
    signal?: AbortSignal;
    run?: { id: string; usage: RunUsage };
  },
): Promise<{ summary: string; upToSeq: number; compactedCount: number }> {
  const config = adapter.getConfig();
  const prev = adapter.getLatestCompaction();
  const prevSeq = prev?.upToSeq ?? 0;
  const keepLast = Math.max(0, options?.keepLast ?? 0);
  const fetchLimit = keepLast + 160;
  const totalCount = adapter.measureMessagesAfter ? adapter.measureMessagesAfter(prevSeq).count : undefined;
  const allActive = adapter.listRecentMessagesAfter
    ? adapter.listRecentMessagesAfter(prevSeq, fetchLimit)
    : adapter.listMessagesAfter(prevSeq);
  const hadOlderOmitted = totalCount !== undefined && totalCount > allActive.length;

  const toCompact = allActive.slice(0, contextCutoff(allActive, keepLast));

  if (toCompact.length === 0 && !options?.customSummary) {
    return {
      summary: prev?.summary ?? "",
      upToSeq: prev?.upToSeq ?? 0,
      compactedCount: 0,
    };
  }

  const targetSeq = toCompact.at(-1)?.seq ?? prev?.upToSeq ?? 0;
  const compactedCount = totalCount !== undefined
    ? Math.max(toCompact.length, totalCount - (allActive.length - toCompact.length))
    : toCompact.length;

  let summary = options?.customSummary?.trim() ?? "";
  if (!summary) {
    const runSummary = async (messages: ConversationMessage[]) => {
      let generated = "";
      for await (const chunk of streamModelResponse({
        env: adapter.env,
        tenantId: config.tenantId,
        model: config.model,
        keyScope: config.keyScope ?? null,
        instructions:
          "Summarize the conversation history concisely, preserving key decisions, file paths, facts, and open tasks.",
        messages,
        purpose: "compaction",
        signal: options?.signal,
      })) {
        if (chunk.type === "text_delta") {
          generated += chunk.delta;
        } else if (chunk.type === "done" && options?.run) {
          const { id, usage } = options.run;
          const cacheRead = chunk.cacheReadTokens ?? 0;
          addModelUsage(usage, config.model, chunk.inputTokens, chunk.outputTokens, cacheRead);
          await adapter.recordModelUsage(id, "compaction", chunk.inputTokens, chunk.outputTokens, usage, cacheRead);
        }
      }
      options?.signal?.throwIfAborted();
      return generated.trim();
    };

    const msgs = buildBoundedSummaryMessages(prev, toCompact, { hadOlderOmitted });
    msgs.push({ role: "user", text: "Summarize the conversation above." });
    try {
      summary = await runSummary(msgs);
    } catch (err) {
      if (options?.signal?.aborted) throw err;
      const apiErr = extractApiError(err);
      if (apiErr?.code === "insufficient_credits" || apiErr?.code === "run_spend_limit_exceeded" || apiErr?.code === "spend_limit_exceeded") {
        throw err;
      }
      // Retry once with a compact plain-text digest so oversized or malformed legacy turns never permanently wedge an agent.
      summary = await runSummary(buildFallbackDigestMessages(prev, toCompact));
    }
    if (!summary) throw new ApiError(502, "empty_compaction", "The model returned no conversation summary");
  }

  adapter.insertCompaction(targetSeq, summary);
  adapter.emitEvent(null, "context_compacted", {
    upToSeq: targetSeq,
    compactedCount,
  });

  return {
    summary,
    upToSeq: targetSeq,
    compactedCount,
  };
}

export async function performDreamConsolidation(
  adapter: TurnStorageAdapter,
): Promise<{ ok: boolean; path: string; commit: string; summary: string }> {
  const config = adapter.getConfig();
  const prev = adapter.getLatestCompaction();
  const prevSeq = prev?.upToSeq ?? 0;
  const recent = adapter.listRecentMessagesAfter
    ? adapter.listRecentMessagesAfter(prevSeq, 120)
    : adapter.listMessagesAfter(prevSeq);
  const conv = buildBoundedSummaryMessages(prev, recent, { maxChars: 160_000, maxMessages: 100, perMsgCap: 3_000 });

  // Read existing MEMORY.md if repo exists
  let existingMemory = "";
  const toolCtx = adapter.makeToolContext(
    randomId("dream", 6),
    new Set(),
    () => {},
    () => {},
  );
  const { repoId, lineage, branch } = await toolCtx.ensureAgentRepo();
  const cfs = new CamelFsClient(adapter.env, config.tenantId);

  try {
    const readRes = await cfs.read(lineage, { at: branch, path: "MEMORY.md" });
    if (readRes.content) {
      existingMemory = readRes.content;
    }
  } catch {
    // MEMORY.md doesn't exist yet
  }

  let consolidated = "";
  for await (const chunk of streamModelResponse({
    env: adapter.env,
    tenantId: config.tenantId,
    model: config.model,
    keyScope: config.keyScope ?? null,
    instructions: [
      "Consolidate durable lessons, user preferences, and repository architecture notes into clean Markdown for /workspace/MEMORY.md.",
      existingMemory ? `Existing MEMORY.md:\n${existingMemory}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    messages:
      conv.length > 0
        ? conv
        : [{ role: "user", text: "Consolidate agent memory." }],
    purpose: "dreaming",
  })) {
    if (chunk.type === "text_delta") {
      consolidated += chunk.delta;
    }
  }

  const finalDoc = consolidated.trim() || "# Consolidated Agent Memory\n";
  const writeOut = await cfs.write(lineage, {
    ref: branch,
    holder: config.id,
    author: `agent:${config.id}`,
    message: "dream: consolidate MEMORY.md",
    puts: [{ path: "MEMORY.md", content: finalDoc + "\n", mode: 0o644 }],
  });

  void getTenantStub(adapter.env, config.tenantId)
    .updateRepoCommit(repoId, writeOut.commit)
    .catch(() => {});

  adapter.emitEvent(null, "dream_completed", {
    path: "MEMORY.md",
    commit: writeOut.commit,
  });

  return {
    ok: true,
    path: "MEMORY.md",
    commit: writeOut.commit,
    summary: finalDoc,
  };
}

function validateAgainstJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
): string | null {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `Value must be one of ${JSON.stringify(schema.enum)}`;
  }
  const rawType = schema.type;
  const expectedType = Array.isArray(rawType) ? rawType[0] : rawType;

  if (expectedType === "object" || (!expectedType && schema.properties)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return "Expected JSON object";
    }
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const reqKey of required) {
      if (!(reqKey in obj)) {
        return `Missing required property '${reqKey}'`;
      }
    }
    const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [k, propSchema] of Object.entries(props)) {
      if (k in obj && obj[k] !== undefined) {
        const subErr = validateAgainstJsonSchema(obj[k], propSchema);
        if (subErr) return `${k}: ${subErr}`;
      }
    }
    return null;
  }
  if (expectedType === "array") {
    if (!Array.isArray(value)) return "Expected JSON array";
    if (schema.items && typeof schema.items === "object") {
      for (let i = 0; i < value.length; i++) {
        const subErr = validateAgainstJsonSchema(value[i], schema.items as Record<string, unknown>);
        if (subErr) return `[${i}]: ${subErr}`;
      }
    }
    return null;
  }
  if (expectedType === "string" && typeof value !== "string") return "Expected string";
  if ((expectedType === "number" || expectedType === "integer") && typeof value !== "number") {
    return "Expected number";
  }
  if (expectedType === "boolean" && typeof value !== "boolean") return "Expected boolean";
  return null;
}

export function getAutoCompactThreshold(model: string): number {
  return Math.min(64_000, Math.floor(getModelContextWindow(model) * 0.6));
}

/** Check whether active history after `prevSeq` exceeds the auto-compaction threshold. */
export function needsAutoCompaction(
  adapter: Pick<TurnStorageAdapter, "measureMessagesAfter" | "listMessagesAfter">,
  prevSeq: number,
  threshold: number,
  opts: { excludeLast?: boolean; observedInputTokens?: number } = {},
): boolean {
  const observed = opts.observedInputTokens ?? 0;
  if (adapter.measureMessagesAfter) {
    const measured = adapter.measureMessagesAfter(prevSeq);
    if (measured.count <= 7) return false;
    const estTokens = opts.excludeLast
      ? Math.max(0, measured.tokensEst - measured.lastTokensEst)
      : measured.tokensEst;
    return estTokens > threshold || observed > threshold || measured.count > 200;
  }
  const existingMsgs = adapter.listMessagesAfter(prevSeq);
  if (existingMsgs.length <= 7) return false;
  const slice = opts.excludeLast ? existingMsgs.slice(0, -1) : existingMsgs;
  const estTotal = slice.reduce((acc, m) => acc + m.tokensEst, 0);
  return estTotal > threshold || observed > threshold;
}

export async function runAgentTurn(
  adapter: TurnStorageAdapter,
  params: {
    runId: string;
    prompt: string;
    actor?: string;
    files: Array<{ lineage: string; file: RunFile }>;
    outputSchema: Record<string, unknown> | null;
    maxSteps: number;
    signal: AbortSignal;
    prefetchedProvider?: StartRunHints["prefetchedProvider"];
    prefetchedBalanceUsd?: number;
  },
): Promise<RunRecord> {
  const config = adapter.getConfig();
  const spendLimit = adapter.getRunSpendLimit(params.runId);
  const usage = spendLimit === null ? emptyUsage() : adapter.getRunRecord(params.runId).usage;
  if (spendLimit !== null && usage.costUsd >= spendLimit) throw runSpendLimitError(spendLimit);

  // Platform apps authorize each caller themselves. Their shared reserve meters usage.
  if (!config.model.startsWith("mock") && !platformCreditReserve(adapter.env, config.tenantId)) {
    const balanceUsd =
      params.prefetchedBalanceUsd !== undefined
        ? params.prefetchedBalanceUsd
        : (await getTenantStub(adapter.env, config.tenantId).getProfile())?.balanceUsd;
    if (balanceUsd !== undefined && balanceUsd <= 0) {
      const err = { code: "insufficient_credits", message: "Tenant credit balance is exhausted" };
      adapter.updateRunState(params.runId, { status: "failed", error: err, ended: true });
      adapter.emitEvent(params.runId, "run_failed", err);
      return adapter.getRunRecord(params.runId);
    }
  }

  const files = params.files.length
    ? await verifyRunFiles(new CamelFsClient(adapter.env, config.tenantId), params.files, {
        env: adapter.env,
        tenantId: config.tenantId,
      })
    : undefined;

  adapter.appendMessage(params.runId, "user", {
    text: params.prompt,
    files,
    ...(params.actor ? { meta: { actor: params.actor, requestId: adapter.getRunRecord(params.runId).idempotencyKey } } : {}),
  });
  adapter.updateRunState(params.runId, { status: "running" });
  adapter.emitEvent(params.runId, "run_started", { runId: params.runId, prompt: params.prompt, ...(params.actor ? { actor: params.actor } : {}) });

  // Count only prior messages and keep the new prompt along with the recent history.
  const autoCompactThreshold = getAutoCompactThreshold(config.model);
  const prevCompaction = adapter.getLatestCompaction();
  const prevSeq = prevCompaction?.upToSeq ?? 0;
  if (needsAutoCompaction(adapter, prevSeq, autoCompactThreshold, { excludeLast: true })) {
    try {
      await performCompaction(adapter, {
        keepLast: 5,
        signal: params.signal,
        run: spendLimit !== null || params.actor ? { id: params.runId, usage } : undefined,
      });
    } finally {
      if (spendLimit !== null) adapter.updateRunState(params.runId, { usage });
    }
  }

  return continueTurnLoop(adapter, {
    runId: params.runId,
    startStep: 0,
    maxSteps: params.maxSteps,
    outputSchema: params.outputSchema,
    approvedToolCallIds: new Set<string>(),
    pendingToolQueue: [],
    accText: "",
    toolCallsSummary: [],
    filesChangedSet: new Set<string>(),
    usage,
    signal: params.signal,
    prefetchedProvider: params.prefetchedProvider,
  });
}

export async function resumePausedTurn(
  adapter: TurnStorageAdapter,
  params: {
    runId: string;
    paused: PausedTurnState;
    decision: {
      input: string;
      at: number;
      kind: "approval" | "question";
      approved: boolean;
      answer: unknown;
    };
    signal: AbortSignal;
  },
): Promise<RunRecord> {
  const { paused, decision, runId } = params;
  const approvedSet = new Set(paused.approvedToolCallIds);
  const filesChangedSet = new Set(paused.filesChanged);
  const usage: RunUsage = { ...paused.usage };
  const spendLimit = adapter.getRunSpendLimit(runId);
  if (spendLimit !== null && usage.costUsd >= spendLimit) throw runSpendLimitError(spendLimit);
  const toolCallsSummary = [...paused.toolCallsSummary];

  adapter.updateRunState(runId, { status: "running" });
  adapter.emitEvent(runId, "run_resumed", {
    runId,
    toolCallId: paused.currentToolCall.id,
    approved: decision.approved,
  });

  const config = adapter.getConfig();
  const catalog = await buildToolCatalog(config, adapter.env, params.signal);
  const toolCtx = adapter.makeToolContext(
    runId,
    approvedSet,
    (files) => {
      for (const f of files) filesChangedSet.add(f);
    },
    (ms) => {
      addVmUsage(usage, config.model, ms);
    },
    params.signal,
  );

  const tc = paused.currentToolCall;
  if ((paused.mcpInput && decision.kind === "question") || (decision.kind === "approval" && decision.approved)) {
    if (decision.kind === "approval") {
      approvedSet.add(tc.id);
    }
    if (paused.mcpInput) {
      toolCtx.mcpBinding = paused.mcpInput;
      if (paused.mcpInput.mode === "approval") {
        toolCtx.approval = { input: decision.input, at: decision.at, by: { id: paused.mcpInput.subject } };
      } else {
        const { key, sealedState, mode } = paused.mcpInput;
        toolCtx.approval = paused.approval;
        toolCtx.mcpInput = {
          key,
          requestState: sealedState === undefined ? undefined : await openSecret(sealedState, adapter.env.VAULT_SECRET),
          response: decision.approved
            ? { action: "accept", ...(mode === "form" ? { content: decision.answer } : {}) }
            : { action: "decline" },
        };
      }
    }
    const pausedAgain = await runSingleToolAndRecord({
      adapter,
      runId,
      tc,
      remainingAfterThis: paused.remainingToolCalls,
      catalog,
      toolCtx,
      approvedSet,
      stepIndex: paused.stepIndex,
      maxSteps: paused.maxSteps,
      outputSchema: paused.outputSchema,
      accText: paused.accText,
      toolCallsSummary,
      filesChangedSet,
      usage,
    });
    if (pausedAgain) return adapter.getRunRecord(runId);
  } else if (decision.kind === "question") {
    if (!decision.approved) {
      toolCallsSummary.push({ id: tc.id, name: tc.name, ok: false });
      adapter.appendMessage(runId, "tool", {
        toolCallId: tc.id,
        toolName: tc.name,
        isError: true,
        text: JSON.stringify({ error: "Human declined to answer", answer: decision.answer ?? null }),
      });
    } else {
      toolCallsSummary.push({ id: tc.id, name: tc.name, ok: true });
      adapter.appendMessage(runId, "tool", {
        toolCallId: tc.id,
        toolName: tc.name,
        isError: false,
        text:
          typeof decision.answer === "string"
            ? decision.answer
            : JSON.stringify(decision.answer ?? { ok: true }),
      });
    }
  } else {
    toolCallsSummary.push({ id: tc.id, name: tc.name, ok: false });
    adapter.appendMessage(runId, "tool", {
      toolCallId: tc.id,
      toolName: tc.name,
      isError: true,
      text: JSON.stringify({ error: `The user declined tool '${tc.name}'`, reason: decision.answer ?? null }),
    });
    adapter.emitEvent(runId, "tool_call_end", { callId: tc.id, name: tc.name, ok: false, denied: true });
  }

  return continueTurnLoop(adapter, {
    runId,
    startStep: paused.stepIndex + 1,
    maxSteps: paused.maxSteps,
    outputSchema: paused.outputSchema,
    approvedToolCallIds: approvedSet,
    pendingToolQueue: paused.remainingToolCalls,
    accText: paused.accText,
    toolCallsSummary,
    filesChangedSet,
    usage,
    signal: params.signal,
  });
}

async function runSingleToolAndRecord(opts: {
  adapter: TurnStorageAdapter;
  runId: string;
  tc: ToolCallInvocation;
  remainingAfterThis: ToolCallInvocation[];
  catalog: BuiltToolCatalog;
  toolCtx: ToolExecutionContext;
  approvedSet: Set<string>;
  stepIndex: number;
  maxSteps: number;
  outputSchema: Record<string, unknown> | null;
  accText: string;
  toolCallsSummary: ToolCallSummary[];
  filesChangedSet: Set<string>;
  usage: RunUsage;
}): Promise<boolean> {
  const { adapter, runId, tc, catalog, toolCtx } = opts;
  adapter.emitEvent(runId, "tool_call_start", {
    callId: tc.id,
    name: tc.name,
    args: tc.args,
  });

  try {
    const out = await executeToolCall(toolCtx, catalog, tc.id, tc.name, tc.args);
    const { result, images } = await storeToolImages(toolCtx.env, toolCtx.config.tenantId, out);
    const serialized = typeof result === "string" ? result : JSON.stringify(result ?? null);
    opts.toolCallsSummary.push({ id: tc.id, name: tc.name, ok: true });
    adapter.appendMessage(runId, "tool", {
      toolCallId: tc.id,
      toolName: tc.name,
      isError: false,
      text: serialized,
      ...(images && { toolImages: images }),
    });
    adapter.emitEvent(runId, "tool_call_end", {
      callId: tc.id,
      name: tc.name,
      ok: true,
      result,
    });
    return false;
  } catch (err) {
    if (err instanceof PauseForInputSignal) {
      const inputId = randomId("inp", 8);
      const expiresAt = Date.now() + 3600_000;
      const pausedState: PausedTurnState = {
        stepIndex: opts.stepIndex,
        maxSteps: opts.maxSteps,
        outputSchema: opts.outputSchema,
        approvedToolCallIds: [...opts.approvedSet],
        approval: toolCtx.approval,
        mcpInput: err.mcpInput,
        currentToolCall: tc,
        remainingToolCalls: opts.remainingAfterThis,
        accText: opts.accText,
        toolCallsSummary: [...opts.toolCallsSummary],
        filesChanged: [...opts.filesChangedSet],
        usage: { ...opts.usage },
      };
      const inputView = adapter.createPendingInput({
        id: inputId,
        runId,
        toolCallId: tc.id,
        kind: err.kind,
        prompt: err.promptPayload,
        pendingTurn: pausedState,
        expiresAt,
      });
      adapter.updateRunState(runId, {
        status: "input_required",
        text: opts.accText,
        toolCalls: opts.toolCallsSummary,
        filesChanged: [...opts.filesChangedSet],
        usage: opts.usage,
      });
      adapter.emitEvent(runId, "input_required", {
        runId,
        input: inputView,
      });
      return true;
    }

    const message = err instanceof Error ? err.message : String(err);
    opts.toolCallsSummary.push({ id: tc.id, name: tc.name, ok: false });
    adapter.appendMessage(runId, "tool", {
      toolCallId: tc.id,
      toolName: tc.name,
      isError: true,
      text: JSON.stringify({ error: message }),
    });
    adapter.emitEvent(runId, "tool_call_end", {
      callId: tc.id,
      name: tc.name,
      ok: false,
      error: message,
    });
    return false;
  }
}

function runSpendLimitError(limit: number): ApiError {
  return new ApiError(402, "spend_limit_exceeded", `Run reached its spend limit ($${limit})`);
}

async function continueTurnLoop(
  adapter: TurnStorageAdapter,
  state: {
    runId: string;
    startStep: number;
    maxSteps: number;
    outputSchema: Record<string, unknown> | null;
    approvedToolCallIds: Set<string>;
    pendingToolQueue: ToolCallInvocation[];
    accText: string;
    toolCallsSummary: ToolCallSummary[];
    filesChangedSet: Set<string>;
    usage: RunUsage;
    signal: AbortSignal;
    prefetchedProvider?: StartRunHints["prefetchedProvider"];
  },
): Promise<RunRecord> {
  const { runId, maxSteps, outputSchema, approvedToolCallIds, filesChangedSet, usage } = state;
  let { accText } = state;
  const toolCallsSummary = state.toolCallsSummary;
  let schemaRepairRetried = false;

  try {
    const config = adapter.getConfig();
    const spendLimit = adapter.getRunSpendLimit(runId);
    const checkRunSpend = () => {
      if (spendLimit === null) return;
      adapter.updateRunState(runId, { usage });
      if (usage.costUsd >= spendLimit) throw runSpendLimitError(spendLimit);
    };
    checkRunSpend();
    const catalog = await buildToolCatalog(config, adapter.env, state.signal);
    const toolCtx = adapter.makeToolContext(
      runId,
      approvedToolCallIds,
      (files) => {
        for (const f of files) filesChangedSet.add(f);
      },
      (ms) => {
        addVmUsage(usage, config.model, ms);
      },
      state.signal,
    );

    // Finish any remaining tool calls from a resumed turn before calling the model again
    if (state.pendingToolQueue.length > 0) {
      for (let i = 0; i < state.pendingToolQueue.length; i++) {
        if (state.signal.aborted) {
          throw new ApiError(499, "cancelled", "Run aborted");
        }
        const tc = state.pendingToolQueue[i]!;
        const remaining = state.pendingToolQueue.slice(i + 1);
        const paused = await runSingleToolAndRecord({
          adapter,
          runId,
          tc,
          remainingAfterThis: remaining,
          catalog,
          toolCtx,
          approvedSet: approvedToolCallIds,
          stepIndex: Math.max(0, state.startStep - 1),
          maxSteps,
          outputSchema,
          accText,
          toolCallsSummary,
          filesChangedSet,
          usage,
        });
        if (paused) {
          return adapter.getRunRecord(runId);
        }
        checkRunSpend();
      }
    }

    const legacyEvents = adapter.getRunRecord(runId).idempotencyKey?.startsWith(V1_COMPAT_REQUEST_PREFIX);
    const autoCompactThreshold = getAutoCompactThreshold(config.model);
    let lastStepInputTokens = 0;
    let lastMidRunCompactStep = -100;
    for (let step = state.startStep; step < maxSteps; step++) {
      if (state.signal.aborted) {
        throw new ApiError(499, "cancelled", "Run aborted");
      }

      // Check agent spendLimitUsd budget
      if (config.spendLimitUsd > 0 && usage.costUsd > config.spendLimitUsd) {
        throw new ApiError(
          402,
          "spend_limit_exceeded",
          `Run exceeded agent spend limit ($${config.spendLimitUsd})`,
        );
      }

      // Drain any mid-turn steer messages injected via whileRunning: "steer"
      const steers = adapter.drainSteers(runId);
      for (const st of steers) {
        adapter.appendMessage(runId, "user", {
          text: st.text,
          meta: { steered: true, steerId: st.id },
        });
        adapter.emitEvent(runId, "steer_applied", {
          runId,
          steerId: st.id,
          text: st.text,
        });
      }

      // Mid-run compaction: prevent long tool-call chains from accumulating unbounded context
      // while guarding with a 4-step cooldown so prompt caching never thrashes on a single large recent result.
      if (step > state.startStep && step - lastMidRunCompactStep >= 4) {
        const currentCompaction = adapter.getLatestCompaction();
        const currentPrevSeq = currentCompaction?.upToSeq ?? 0;
        if (
          needsAutoCompaction(adapter, currentPrevSeq, autoCompactThreshold, {
            observedInputTokens: lastStepInputTokens,
          })
        ) {
          try {
            const compacted = await performCompaction(adapter, {
              keepLast: 4,
              signal: state.signal,
              run: { id: runId, usage },
            });
            if (compacted.compactedCount > 0) {
              lastStepInputTokens = 0;
              lastMidRunCompactStep = step;
            }
          } catch (err) {
            if (state.signal.aborted) throw err;
            const apiErr = extractApiError(err);
            if (
              apiErr?.code === "insufficient_credits" ||
              apiErr?.code === "run_spend_limit_exceeded" ||
              apiErr?.code === "spend_limit_exceeded"
            ) {
              throw err;
            }
            // Non-fatal compaction failure mid-run: avoid retrying immediately and continue the turn.
            lastMidRunCompactStep = step;
          } finally {
            checkRunSpend();
          }
        }
      }

      const compaction = adapter.getLatestCompaction();
      const historyRows = adapter.listRecentMessagesAfter
        ? adapter.listRecentMessagesAfter(compaction?.upToSeq ?? 0, 200)
        : adapter.listMessagesAfter(compaction?.upToSeq ?? 0);
      const convMessages = buildConversationMessages(compaction, historyRows);

      let stepText = "";
      const stepToolCalls: ToolCallInvocation[] = [];
      const timestamp = Date.now();
      const assistant = { role: "assistant", timestamp, model: config.model };
      if (legacyEvents) adapter.emitEvent(runId, "message_start", { step, message: { ...assistant, content: [] } });

      const effectiveScope = state.prefetchedProvider?.keyScope !== undefined
        ? (state.prefetchedProvider.keyScope ?? null)
        : (config.keyScope ?? null);
      for await (const chunk of streamModelResponse({
        env: adapter.env,
        tenantId: config.tenantId,
        model: config.model,
        keyScope: effectiveScope,
        instructions: config.instructions,
        messages: convMessages,
        tools: catalog.schemas,
        outputSchema,
        signal: state.signal,
        purpose: "turn",
        promptCacheKey: config.id,
        prefetchedProvider: state.prefetchedProvider?.model === config.model && (state.prefetchedProvider.keyScope ?? null) === effectiveScope
          ? state.prefetchedProvider
          : undefined,
      })) {
        if (state.signal.aborted && chunk.type !== "done") {
          throw new ApiError(499, "cancelled", "Run aborted");
        }
        if (chunk.type === "text_delta") {
          stepText += chunk.delta;
          adapter.emitEvent(runId, "text_delta", { delta: chunk.delta, step });
        } else if (chunk.type === "tool_call") {
          stepToolCalls.push({
            id: chunk.id,
            name: chunk.name,
            argumentsJson: chunk.argumentsJson,
            args: chunk.args,
          });
        } else if (chunk.type === "done") {
          lastStepInputTokens = chunk.inputTokens;
          const cacheRead = chunk.cacheReadTokens ?? 0;
          addModelUsage(usage, config.model, chunk.inputTokens, chunk.outputTokens, cacheRead);
          await adapter.recordModelUsage(runId, "response", chunk.inputTokens, chunk.outputTokens, usage, cacheRead);
        }
      }
      state.signal.throwIfAborted();

      if (stepText) {
        accText = stepText;
      }
      checkRunSpend();

      adapter.appendMessage(runId, "assistant", {
        text: stepText,
        toolCalls: stepToolCalls.length > 0 ? stepToolCalls : undefined,
      });
      if (legacyEvents) adapter.emitEvent(runId, "message_end", {
        step,
        message: {
          ...assistant,
          content: [
            ...(stepText ? [{ type: "text", text: stepText }] : []),
            ...stepToolCalls.map(({ id, name, args }) => ({ type: "toolCall", id, name, arguments: args })),
          ],
        },
      });

      // If no tool calls were requested, validate outputSchema (if any) and complete!
      if (stepToolCalls.length === 0) {
        let structuredOutput: unknown = null;
        if (outputSchema) {
          let parsedJson: unknown;
          let schemaErr: string | null = null;
          try {
            parsedJson = JSON.parse(stepText.trim());
            schemaErr = validateAgainstJsonSchema(parsedJson, outputSchema);
          } catch (parseErr) {
            schemaErr =
              parseErr instanceof Error ? parseErr.message : "Response is not valid JSON";
          }

          if (schemaErr) {
            if (!schemaRepairRetried && step + 1 < maxSteps) {
              schemaRepairRetried = true;
              adapter.appendMessage(runId, "user", {
                text: `Your JSON output failed schema validation (${schemaErr}). Reply ONLY with valid JSON matching ${JSON.stringify(outputSchema)}.`,
              });
              continue;
            }
            throw new ApiError(422, "output_schema_invalid", `Output schema validation failed: ${schemaErr}`);
          }
          structuredOutput = parsedJson;
        }

        // Check if steers arrived right during the final generation step!
        const lateSteers = adapter.drainSteers(runId);
        if (lateSteers.length > 0 && step + 1 < maxSteps) {
          for (const st of lateSteers) {
            adapter.appendMessage(runId, "user", {
              text: st.text,
              meta: { steered: true, steerId: st.id },
            });
            adapter.emitEvent(runId, "steer_applied", {
              runId,
              steerId: st.id,
              text: st.text,
            });
          }
          continue;
        }

        adapter.updateRunState(runId, {
          status: "completed",
          text: accText,
          output: structuredOutput,
          toolCalls: toolCallsSummary,
          filesChanged: [...filesChangedSet],
          usage,
          error: null,
          ended: true,
        });
        adapter.emitEvent(runId, "run_completed", {
          runId,
          text: accText,
          output: structuredOutput,
          usage,
          filesChanged: [...filesChangedSet],
        });
        return adapter.getRunRecord(runId);
      }

      // Execute tool calls sequentially so pauses capture exact remainingToolCalls
      for (let i = 0; i < stepToolCalls.length; i++) {
        if (state.signal.aborted) {
          throw new ApiError(499, "cancelled", "Run aborted");
        }
        const tc = stepToolCalls[i]!;
        const remaining = stepToolCalls.slice(i + 1);
        const paused = await runSingleToolAndRecord({
          adapter,
          runId,
          tc,
          remainingAfterThis: remaining,
          catalog,
          toolCtx,
          approvedSet: approvedToolCallIds,
          stepIndex: step,
          maxSteps,
          outputSchema,
          accText,
          toolCallsSummary,
          filesChangedSet,
          usage,
        });
        if (paused) {
          return adapter.getRunRecord(runId);
        }
        checkRunSpend();
      }
    }

    // Reached maxSteps limit
    adapter.updateRunState(runId, {
      status: "completed",
      text: accText,
      output: null,
      toolCalls: toolCallsSummary,
      filesChanged: [...filesChangedSet],
      usage,
      error: null,
      ended: true,
    });
    adapter.emitEvent(runId, "run_completed", {
      runId,
      text: accText,
      usage,
      maxStepsReached: true,
    });
    return adapter.getRunRecord(runId);
  } catch (err) {
    const apiErr = extractApiError(err);
    if (state.signal.aborted || apiErr?.code === "cancelled") {
      const cancelErr = { code: "cancelled", message: "Run cancelled" };
      adapter.updateRunState(runId, {
        status: "cancelled",
        text: accText,
        toolCalls: toolCallsSummary,
        filesChanged: [...filesChangedSet],
        usage,
        error: cancelErr,
        ended: true,
      });
      adapter.emitEvent(runId, "run_cancelled", { runId });
      return adapter.getRunRecord(runId);
    }

    const code = apiErr?.code ?? "run_failed";
    const message = apiErr?.message ?? (err instanceof Error ? err.message : String(err));
    adapter.updateRunState(runId, {
      status: "failed",
      text: accText,
      toolCalls: toolCallsSummary,
      filesChanged: [...filesChangedSet],
      usage,
      error: { code, message },
      ended: true,
    });
    adapter.emitEvent(runId, "run_failed", { runId, error: { code, message } });
    return adapter.getRunRecord(runId);
  }
}

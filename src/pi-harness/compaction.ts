/**
 * Vendored from @earendil-works/pi-agent-core 0.87.1, src/harness/compaction/compaction.ts and utils.ts,
 * with the parts of session/context.ts, types.ts and utils/usage.ts they use
 * (https://github.com/earendil-works/pi, tag v0.87.1), MIT License, Copyright (c) 2025 Mario Zechner.
 * Pi 1.0 removed its harness, compaction included. Changes from 0.87.1: a summary request is a plain
 * function (`Complete`) taking an AbortSignal instead of a `Models` collection, a retry policy and a
 * chord context with telemetry (the runtime made one attempt and recorded no pi telemetry); entries are
 * only message and compaction entries; branch summarization and bash/custom messages are left out.
 */
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { contentText, uuidv7, type Api, type AssistantMessage, type Context, type Message, type Model, type SimpleStreamOptions, type Usage } from "@earendil-works/pi-ai";
import { convertToLlm, createCompactionSummaryMessage } from "./messages.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** One model request a summary makes: the runtime binds the tenant's credentials and billing. */
export type Complete = (model: Model<Api>, context: Context, options: SimpleStreamOptions) => Promise<AssistantMessage>;

interface EntryBase {
  id: string;
  parentId: string | null;
  seq: number;
  timestamp: number;
}
export interface MessageEntry extends EntryBase {
  type: "message";
  message: AgentMessage;
}
export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  retainedTail: AgentMessage[];
  tokensBefore: number;
  details?: JsonValue;
  usage?: Usage;
  fromHook: boolean;
}
export type Entry = MessageEntry | CompactionEntry;

export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };
const ok = <TValue, TError>(value: TValue): Result<TValue, TError> => ({ ok: true, value });
const err = <TValue, TError>(error: TError): Result<TValue, TError> => ({ ok: false, error });

export type CompactionErrorCode = "aborted" | "summarization_failed";

/** Error returned by compaction helpers. */
export class CompactionError extends Error {
  public code: CompactionErrorCode;
  constructor(code: CompactionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CompactionError";
    this.code = code;
  }
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined ? {} : { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }),
    ...(left.reasoning === undefined && right.reasoning === undefined ? {} : { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

// ---- utils.ts ----

/** File paths touched by a compaction range. */
export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

function createFileOps(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

/** Add file operations from assistant tool calls to an accumulator. */
function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
  if (message.role !== "assistant") return;
  if (!("content" in message) || !Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (typeof block !== "object" || block === null) continue;
    if (!("type" in block) || block.type !== "toolCall") continue;
    if (!("arguments" in block) || !("name" in block)) continue;
    const args = block.arguments as Record<string, unknown> | undefined;
    if (!args) continue;
    const path = typeof args.path === "string" ? args.path : undefined;
    if (!path) continue;
    switch (block.name) {
      case "read": fileOps.read.add(path); break;
      case "write": fileOps.written.add(path); break;
      case "edit": fileOps.edited.add(path); break;
    }
  }
}

function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter(f => !modified.has(f)).sort();
  return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

const TOOL_RESULT_MAX_CHARS = 2000;

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

/** Serialize LLM messages to plain text for summarization prompts. */
export function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const content = contentText(msg.content, "");
      if (content) parts.push(`[User]: ${content}`);
    } else if (msg.role === "assistant") {
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];
      for (const block of msg.content) {
        if (block.type === "thinking") thinkingParts.push(block.thinking);
        else if (block.type === "toolCall") {
          const args = block.arguments as Record<string, unknown>;
          toolCalls.push(`${block.name}(${Object.entries(args).map(([k, v]) => `${k}=${safeJsonStringify(v)}`).join(", ")})`);
        }
      }
      if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
      if (msg.content.some(block => block.type === "text")) parts.push(`[Assistant]: ${contentText(msg.content)}`);
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
    } else if (msg.role === "toolResult") {
      const content = contentText(msg.content, "");
      if (content) parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
    }
  }
  return parts.join("\n\n");
}

// ---- session/context.ts ----

function buildContextEntries(pathEntries: readonly Entry[]): Entry[] {
  for (let index = pathEntries.length - 1; index >= 0; index--) {
    if (pathEntries[index].type === "compaction") return [pathEntries[index], ...pathEntries.slice(index + 1)];
  }
  return [...pathEntries];
}

function isContextMessage(message: AgentMessage): boolean {
  return message.role !== "assistant" || (message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "deferred");
}

function sessionEntryToContextMessages(entry: Entry): AgentMessage[] {
  if (entry.type === "message") return isContextMessage(entry.message) ? [entry.message] : [];
  return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp), ...entry.retainedTail.filter(isContextMessage)];
}

// ---- compaction.ts ----

/** File-operation details stored on generated compaction entries. */
export interface CompactionDetails extends Record<string, JsonValue> {
  readFiles: string[];
  modifiedFiles: string[];
}

function extractFileOperations(messages: AgentMessage[], entries: Entry[], prevCompactionIndex: number): FileOperations {
  const fileOps = createFileOps();
  if (prevCompactionIndex >= 0) {
    const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
    if (typeof prevCompaction.details === "object" && prevCompaction.details !== null && !Array.isArray(prevCompaction.details)) {
      if (Array.isArray(prevCompaction.details.readFiles)) {
        for (const path of prevCompaction.details.readFiles) if (typeof path === "string") fileOps.read.add(path);
      }
      if (Array.isArray(prevCompaction.details.modifiedFiles)) {
        for (const path of prevCompaction.details.modifiedFiles) if (typeof path === "string") fileOps.edited.add(path);
      }
    }
  }
  for (const msg of messages) extractFileOpsFromMessage(msg, fileOps);
  return fileOps;
}

function getMessageFromEntryForCompaction(entry: Entry): AgentMessage | undefined {
  return entry.type === "message" ? entry.message : undefined;
}

/** Generated compaction data ready to be persisted as a compaction entry. */
export interface CompactResult<T = JsonValue> {
  /** Summary text that replaces compacted history in future context. */
  summary: string;
  /** Estimated context tokens before compaction. */
  tokensBefore: number;
  /** Usage from the LLM call(s) that generated this summary, if available. */
  usage?: Usage;
  /** Retained recent messages stored directly on the compaction entry. */
  retainedTail: AgentMessage[];
  details?: T;
}

/** Summaries are standalone requests, so isolate routing and avoid cache writes that cannot be reused. */
function createSummaryRequestOptions(options: SimpleStreamOptions, signal: AbortSignal | undefined): SimpleStreamOptions {
  return { ...options, signal, cacheRetention: "none", sessionId: options.sessionId ?? uuidv7() };
}

/** Compaction thresholds and retention settings. */
export interface CompactionSettings {
  /** Enable automatic compaction decisions. */
  enabled: boolean;
  /** Tokens reserved for summary prompt and output. */
  reserveTokens: number;
  /** Approximate recent-context tokens to keep after compaction. */
  keepRecentTokens: number;
}

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function getAssistantUsage(msg: AgentMessage): Usage | undefined {
  if (msg.role === "assistant" && "usage" in msg) {
    const assistantMsg = msg as AssistantMessage;
    if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage && calculateContextTokens(assistantMsg.usage) > 0) return assistantMsg.usage;
  }
  return undefined;
}

/** Estimated context-token usage for a message list. */
export interface ContextUsageEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  /** Index of the message that provided usage, or null when none exists. */
  lastUsageIndex: number | null;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
  let usageInfo: { usage: Usage; index: number } | undefined;
  for (let i = messages.length - 1; i >= 0 && !usageInfo; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (usage) usageInfo = { usage, index: i };
  }
  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) estimated += estimateTokens(message);
    return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
  }
  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) trailingTokens += estimateTokens(messages[i]);
  return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
}

/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === "text" && block.text) chars += block.text.length;
    else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
  let chars = 0;
  switch (message.role) {
    case "user":
      return Math.ceil(estimateTextAndImageContentChars((message as { content: string | Array<{ type: string; text?: string }> }).content) / 4);
    case "assistant": {
      for (const block of (message as AssistantMessage).content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else if (block.type === "toolCall") chars += block.name.length + safeJsonStringify(block.arguments).length;
      }
      return Math.ceil(chars / 4);
    }
    case "toolResult":
      return Math.ceil(estimateTextAndImageContentChars(message.content) / 4);
    case "compactionSummary":
      return Math.ceil(message.summary.length / 4);
  }
  return 0;
}

function findValidCutPoints(entries: Entry[], startIndex: number, endIndex: number): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    // Never cut between a tool call and its result.
    if (entry.type === "message" && entry.message.role !== "toolResult" && entry.message.role !== "system") cutPoints.push(i);
  }
  return cutPoints;
}

/** Find the user-visible message that starts the turn containing an entry. */
function findTurnStartIndex(entries: Entry[], entryIndex: number, startIndex: number): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message.role === "user") return i;
  }
  return -1;
}

/** Cut point selected for compaction. */
interface CutPointResult {
  /** Index of the first entry retained after compaction. */
  firstKeptEntryIndex: number;
  /** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
  turnStartIndex: number;
  /** Whether the selected cut point splits an in-progress turn. */
  isSplitTurn: boolean;
}

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
function findCutPoint(entries: Entry[], startIndex: number, endIndex: number, keepRecentTokens: number): CutPointResult {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
  if (cutPoints.length === 0) return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0];
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    accumulatedTokens += estimateTokens(entry.message);
    if (accumulatedTokens >= keepRecentTokens) {
      for (let c = 0; c < cutPoints.length; c++) {
        if (cutPoints[c] >= i) {
          cutIndex = cutPoints[c];
          break;
        }
      }
      break;
    }
  }
  while (cutIndex > startIndex) {
    const prevEntry = entries[cutIndex - 1];
    if (prevEntry.type === "compaction" || prevEntry.type === "message") break;
    cutIndex--;
  }
  const cutEntry = entries[cutIndex];
  const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
  const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
  return { firstKeptEntryIndex: cutIndex, turnStartIndex, isSplitTurn: !isUserMessage && turnStartIndex !== -1 };
}

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export interface SummaryGenerationOptions {
  model: Model<Api>;
  reserveTokens: number;
  customInstructions?: string;
  previousSummary?: string;
  thinkingLevel?: ThinkingLevel;
}

/** Generate or update a conversation summary for compaction. */
export async function generateSummary(
  currentMessages: AgentMessage[], complete: Complete, options: SummaryGenerationOptions, signal?: AbortSignal,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
  const { model, reserveTokens, customInstructions, previousSummary, thinkingLevel } = options;
  const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  const conversationText = serializeConversation(convertToLlm(currentMessages));
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  promptText += basePrompt;
  const summarizationMessages = [{ role: "user" as const, content: [{ type: "text" as const, text: promptText }], timestamp: Date.now() }];
  const completionOptions = model.reasoning && thinkingLevel && thinkingLevel !== "off" ? { maxTokens, reasoning: thinkingLevel } : { maxTokens };
  const response = await complete(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, createSummaryRequestOptions(completionOptions as SimpleStreamOptions, signal));
  if (response.stopReason === "aborted") return err(new CompactionError("aborted", response.errorMessage || "Summarization aborted"));
  if (response.stopReason === "error") return err(new CompactionError("summarization_failed", `Summarization failed: ${response.errorMessage || "Unknown error"}`));
  return ok({ text: contentText(response.content), usage: response.usage });
}

/** Prepared inputs for a compaction run. */
export interface CompactionPreparation {
  /** Messages summarized into the history summary. */
  messagesToSummarize: AgentMessage[];
  /** Prefix messages summarized separately when compaction splits a turn. */
  turnPrefixMessages: AgentMessage[];
  /** Recent messages retained after compaction. */
  retainedTail: AgentMessage[];
  isSplitTurn: boolean;
  /** Estimated context tokens before compaction. */
  tokensBefore: number;
  /** Previous compaction summary used for iterative updates. */
  previousSummary?: string;
  fileOps: FileOperations;
  settings: CompactionSettings;
}

/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(pathEntries: Entry[], settings: CompactionSettings): Result<CompactionPreparation | undefined, CompactionError> {
  if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1].type === "compaction") return ok(undefined);
  let prevCompactionIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    if (pathEntries[i].type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }
  let previousSummary: string | undefined;
  let compactableEntries = pathEntries;
  if (prevCompactionIndex >= 0) {
    const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
    previousSummary = prevCompaction.summary;
    const virtualRetainedEntries: Entry[] = prevCompaction.retainedTail.map((message, index) => ({
      type: "message",
      id: `${prevCompaction.id}:retained:${index}`,
      parentId: index === 0 ? prevCompaction.id : `${prevCompaction.id}:retained:${index - 1}`,
      seq: prevCompaction.seq,
      timestamp: message.timestamp,
      message,
    }));
    compactableEntries = [...virtualRetainedEntries, ...pathEntries.slice(prevCompactionIndex + 1)];
  }
  const boundaryEnd = compactableEntries.length;
  const tokensBefore = estimateContextTokens(buildContextEntries(pathEntries).flatMap(sessionEntryToContextMessages)).tokens;
  const cutPoint = findCutPoint(compactableEntries, 0, boundaryEnd, settings.keepRecentTokens);
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const messagesToSummarize: AgentMessage[] = [];
  for (let i = 0; i < historyEnd; i++) {
    const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
    if (msg) messagesToSummarize.push(msg);
  }
  const turnPrefixMessages: AgentMessage[] = [];
  if (cutPoint.isSplitTurn) {
    for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
      const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
      if (msg) turnPrefixMessages.push(msg);
    }
  }
  const retainedTail: AgentMessage[] = [];
  for (let i = cutPoint.firstKeptEntryIndex; i < boundaryEnd; i++) {
    const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
    if (msg) retainedTail.push(msg);
  }
  const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
  if (cutPoint.isSplitTurn) for (const msg of turnPrefixMessages) extractFileOpsFromMessage(msg, fileOps);
  return ok({ messagesToSummarize, turnPrefixMessages, retainedTail, isSplitTurn: cutPoint.isSplitTurn, tokensBefore, previousSummary, fileOps, settings });
}

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export interface CompactGenerationOptions {
  model: Model<Api>;
  customInstructions?: string;
  thinkingLevel?: ThinkingLevel;
}

/** Generate compaction summary data from prepared history. */
export async function compact(
  preparation: CompactionPreparation, complete: Complete, options: CompactGenerationOptions, signal?: AbortSignal,
): Promise<Result<CompactResult, CompactionError>> {
  const { model, customInstructions, thinkingLevel } = options;
  const { messagesToSummarize, turnPrefixMessages, retainedTail, isSplitTurn, tokensBefore, previousSummary, fileOps, settings } = preparation;
  let summary: string;
  let summaryUsage: Usage;
  if (isSplitTurn && turnPrefixMessages.length > 0) {
    let historyText = "No prior history.";
    let historyUsage: Usage | undefined;
    if (messagesToSummarize.length > 0) {
      const historyResult = await generateSummary(messagesToSummarize, complete, { model, reserveTokens: settings.reserveTokens, customInstructions, previousSummary, thinkingLevel }, signal);
      if (!historyResult.ok) return err(historyResult.error);
      historyText = historyResult.value.text;
      historyUsage = historyResult.value.usage;
    }
    const turnPrefixResult = await generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, thinkingLevel, complete, signal);
    if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
    summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value.text}`;
    summaryUsage = historyUsage ? addUsage(historyUsage, turnPrefixResult.value.usage) : turnPrefixResult.value.usage;
  } else {
    const summaryResult = await generateSummary(messagesToSummarize, complete, { model, reserveTokens: settings.reserveTokens, customInstructions, previousSummary, thinkingLevel }, signal);
    if (!summaryResult.ok) return err(summaryResult.error);
    summary = summaryResult.value.text;
    summaryUsage = summaryResult.value.usage;
  }
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);
  const details: CompactionDetails = { readFiles, modifiedFiles };
  return ok({ summary, tokensBefore, usage: summaryUsage, retainedTail, details });
}

async function generateTurnPrefixSummary(
  messages: AgentMessage[], model: Model<Api>, reserveTokens: number, thinkingLevel: ThinkingLevel | undefined, complete: Complete, signal: AbortSignal | undefined,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
  const maxTokens = Math.min(Math.floor(0.5 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
  const conversationText = serializeConversation(convertToLlm(messages));
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  const summarizationMessages = [{ role: "user" as const, content: [{ type: "text" as const, text: promptText }], timestamp: Date.now() }];
  const completionOptions = model.reasoning && thinkingLevel && thinkingLevel !== "off" ? { maxTokens, reasoning: thinkingLevel } : { maxTokens };
  const response = await complete(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, createSummaryRequestOptions(completionOptions as SimpleStreamOptions, signal));
  if (response.stopReason === "aborted") return err(new CompactionError("aborted", response.errorMessage || "Turn prefix summarization aborted"));
  if (response.stopReason === "error") return err(new CompactionError("summarization_failed", `Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`));
  return ok({ text: contentText(response.content), usage: response.usage });
}

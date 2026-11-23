import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord/json";
import {
  AssistantEntry,
  CompactionEntry,
  ResetEntry,
  SystemEntry,
  ToolResultEntry,
  UserEntry,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type JsonObject,
  type ModelRef,
  type Tx,
} from "@earendil-works/pi-durable";
import { readLegacyInlineContent } from "../legacy-inline-images.ts";
import { estimateTokens, type StoredMessage, type ToolCallInvocation } from "../types.ts";

export interface LegacyCompactionRow {
  id: string;
  upToSeq: number;
  summary: string;
  createdAt: number;
}

const COMPACTION_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUFFIX = "\n</summary>";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function wrapCompactionSummary(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.startsWith(COMPACTION_PREFIX) && trimmed.endsWith(COMPACTION_SUFFIX)) {
    return trimmed;
  }
  return `${COMPACTION_PREFIX}${trimmed}${COMPACTION_SUFFIX}`;
}

export function unwrapCompactionSummary(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith(COMPACTION_PREFIX) && trimmed.endsWith(COMPACTION_SUFFIX)) {
    return trimmed.slice(COMPACTION_PREFIX.length, trimmed.length - COMPACTION_SUFFIX.length).trim();
  }
  const match = trimmed.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/);
  if (match?.[1] !== undefined) {
    return match[1].trim();
  }
  return trimmed;
}

function safeParseToolArgs(tc: ToolCallInvocation): JsonObject {
  if (tc.args && typeof tc.args === "object" && !Array.isArray(tc.args)) {
    return JSON.parse(JSON.stringify(tc.args)) as JsonObject;
  }
  if (tc.argumentsJson) {
    try {
      const parsed = JSON.parse(tc.argumentsJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as JsonObject;
      }
    } catch {
      // fall through
    }
  }
  return {};
}

function formatUserMessageContent(msg: StoredMessage): string | (TextContent | ImageContent)[] {
  const files = msg.content.files;
  const textParts: string[] = [];
  if (msg.content.text) textParts.push(msg.content.text);
  if (files?.length) {
    for (const file of files) {
      textParts.push(
        `Workspace attachment ${JSON.stringify(file.path)} at commit ${file.commit} (${file.contentType}, ${file.size} bytes).`,
      );
    }
  }
  const combinedText = textParts.join("\n");

  const legacyInline = readLegacyInlineContent(msg.content);
  if (legacyInline && legacyInline.length > 0) {
    const blocks: (TextContent | ImageContent)[] = [];
    for (const part of legacyInline) {
      if (part.type === "text") {
        blocks.push({ type: "text", text: part.text });
      } else if (part.type === "image") {
        blocks.push({ type: "image", mimeType: part.mimeType, data: part.data });
      }
    }
    if (files?.length) {
      for (const file of files) {
        blocks.push({
          type: "text",
          text: `Workspace attachment ${JSON.stringify(file.path)} at commit ${file.commit} (${file.contentType}, ${file.size} bytes).`,
        });
      }
    }
    if (blocks.length > 0) return blocks;
  }

  return combinedText;
}

/**
 * Atomically imports legacy CamelRun SQLite `compactions` + `messages` into a newly
 * created `pi-durable` conversation inside its `init(tx)` commit.
 *
 * Preserves exact tool-call / tool-result pairing (dropping orphaned unpaired tool calls
 * or dangling tool results so provider transcripts remain 100% valid).
 * Legacy tables are never modified or deleted, enabling instant safe rollback.
 */
export async function importLegacyTranscriptToPi(
  tx: Tx,
  conversationId: ConversationId,
  legacyCompaction: LegacyCompactionRow | null,
  legacyMessages: readonly StoredMessage[],
  modelRef: ModelRef,
): Promise<{ importedEntries: number; maxLegacySeq: number }> {
  let importedEntries = 0;
  let maxLegacySeq = legacyCompaction?.upToSeq ?? 0;

  // 1. Import latest legacy compaction marker if present
  if (legacyCompaction) {
    const trimmedSummary = legacyCompaction.summary.trim();
    if (trimmedSummary) {
      const summaryMsg: UserMessage = {
        role: "user",
        content: wrapCompactionSummary(trimmedSummary),
        timestamp: legacyCompaction.createdAt || Date.now(),
      };
      await tx.appendEntry(CompactionEntry, conversationId, {
        head: "self",
        model: [summaryMsg],
        data: { reason: "manual" },
      });
      importedEntries++;
    } else {
      await tx.appendEntry(ResetEntry, conversationId, {
        head: "self",
      });
      importedEntries++;
    }
  }

  // 2. Import subsequent legacy messages with exact assistant-toolCall / tool-result pairing
  for (let i = 0; i < legacyMessages.length; i++) {
    const msg = legacyMessages[i]!;
    if (msg.seq > maxLegacySeq) maxLegacySeq = msg.seq;

    if (msg.role === "tool") {
      // Orphaned tool result without preceding assistant tool call — skip to keep transcript valid
      continue;
    }

    if (msg.role === "user" || msg.role === "system") {
      const userMsg: UserMessage = {
        role: "user",
        content: formatUserMessageContent(msg),
        timestamp: msg.createdAt || Date.now(),
      };
      await tx.appendEntry(UserEntry, conversationId, {
        model: [userMsg],
      });
      importedEntries++;
      continue;
    }

    if (msg.role === "assistant") {
      const rawCalls = msg.content.toolCalls ?? [];
      if (rawCalls.length === 0) {
        const text = msg.content.text ?? "";
        const assistantMsg: AssistantMessage = {
          role: "assistant",
          content: text ? [{ type: "text", text }] : [{ type: "text", text: "" }],
          api: "openai-responses",
          provider: modelRef.provider,
          model: modelRef.modelId,
          usage: ZERO_USAGE,
          stopReason: "stop",
          timestamp: msg.createdAt || Date.now(),
        };
        await tx.appendEntry(AssistantEntry, conversationId, {
          model: [assistantMsg],
        });
        importedEntries++;
        continue;
      }

      // Collect matching tool result rows immediately following this assistant message
      const pendingCallIds = new Set(rawCalls.map((c) => c.id));
      const pairedResults: StoredMessage[] = [];
      while (legacyMessages[i + 1]?.role === "tool") {
        const resMsg = legacyMessages[++i]!;
        if (resMsg.seq > maxLegacySeq) maxLegacySeq = resMsg.seq;
        const callId = resMsg.content.toolCallId;
        if (resMsg.runId !== msg.runId || !callId || !pendingCallIds.delete(callId)) {
          continue;
        }
        pairedResults.push(resMsg);
      }

      const pairedCalls = rawCalls.filter((c) => !pendingCallIds.has(c.id));
      const contentBlocks: (TextContent | ToolCall)[] = [];
      if (msg.content.text) {
        contentBlocks.push({ type: "text", text: msg.content.text });
      }
      for (const tc of pairedCalls) {
        contentBlocks.push({
          type: "toolCall",
          id: tc.id,
          name: tc.name,
          arguments: safeParseToolArgs(tc),
        });
      }

      if (contentBlocks.length > 0) {
        const assistantMsg: AssistantMessage = {
          role: "assistant",
          content: contentBlocks,
          api: "openai-responses",
          provider: modelRef.provider,
          model: modelRef.modelId,
          usage: ZERO_USAGE,
          stopReason: pairedCalls.length > 0 ? "toolUse" : "stop",
          timestamp: msg.createdAt || Date.now(),
        };
        await tx.appendEntry(AssistantEntry, conversationId, {
          model: [assistantMsg],
        });
        importedEntries++;
      }

      for (const resMsg of pairedResults) {
        const textParts: string[] = [];
        if (resMsg.content.text) textParts.push(resMsg.content.text);
        if (resMsg.content.toolImages?.length) {
          for (const img of resMsg.content.toolImages) {
            textParts.push(
              `[Tool image ${img.contentType} (${img.width}x${img.height}, digest=${img.digest})]`,
            );
          }
        }
        const toolResultMsg: ToolResultMessage = {
          role: "toolResult",
          toolCallId: resMsg.content.toolCallId!,
          toolName: resMsg.content.toolName || "tool",
          content: [{ type: "text", text: textParts.join("\n") }],
          isError: Boolean(resMsg.content.isError),
          timestamp: resMsg.createdAt || Date.now(),
        };
        await tx.appendEntry(ToolResultEntry, conversationId, {
          model: [toolResultMsg],
          data: { diagnostics: [] },
        });
        importedEntries++;
      }
    }
  }

  return { importedEntries, maxLegacySeq };
}

/**
 * Copies `pi-durable` entries from a source AgentDO into a newly forked AgentDO's
 * root conversation inside `harness.root({ agent, init })`.
 */
export async function copyPiEntriesToConversation(
  tx: Tx,
  conversationId: ConversationId,
  entries: readonly EntryRecord[],
): Promise<void> {
  const idMap = new Map<number, EntryId>();
  for (const entry of entries) {
    let head: EntryId | "self" | undefined;
    if (entry.head !== undefined) {
      if (Number(entry.head) === Number(entry.id)) {
        head = "self";
      } else {
        head = idMap.get(Number(entry.head)) ?? "self";
      }
    }
    const appended = await tx.appendEntry(conversationId, {
      kind: entry.kind,
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.data !== undefined ? { data: entry.data as JsonValue } : {}),
      ...(head !== undefined ? { head } : {}),
      ...(entry.edits !== undefined ? { edits: entry.edits } : {}),
    });
    idMap.set(Number(entry.id), appended.id);
  }
}

function extractTextFromUserContent(
  content: string | readonly (TextContent | ImageContent)[],
): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function extractTextFromToolContent(
  content: readonly (TextContent | ImageContent)[],
): string {
  return content
    .filter((b): b is TextContent => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

export interface MappedHistoryMessage {
  seq: number;
  runId: string | null;
  role: StoredMessage["role"];
  content: Record<string, unknown>;
  tokensEst: number;
  createdAt: number;
}

export interface MappedHistoryResult {
  messages: MappedHistoryMessage[];
  compaction: { id: string; upToSeq: number; summary: string } | null;
  nextAfter: number;
  nextBefore?: number | null;
}

/**
 * Maps `pi-durable` `EntryRecord[]` (ascending by EntryId) into CamelRun v2's
 * `GET /v2/agents/:idOrKey/history` response shape (`StoredMessage[]` + `compaction`).
 */
export function mapPiEntriesToHistory(
  entries: readonly EntryRecord[],
  opts?: { after?: number; before?: number; limit?: number },
): MappedHistoryResult {
  const allMessages: MappedHistoryMessage[] = [];
  let latestCompaction: { id: string; upToSeq: number; summary: string } | null = null;

  for (const entry of entries) {
    const seq = Number(entry.id);
    if (SystemEntry.is(entry)) continue;

    if (CompactionEntry.is(entry)) {
      const msg = entry.model?.[0];
      const rawText =
        msg && msg.role === "user" ? extractTextFromUserContent(msg.content) : "";
      latestCompaction = {
        id: `cmp_${seq}`,
        upToSeq: entry.head !== undefined ? Number(entry.head) : seq,
        summary: unwrapCompactionSummary(rawText),
      };
      continue;
    }

    if (ResetEntry.is(entry)) {
      const msg = entry.model?.[0];
      const handoff =
        msg && msg.role === "user" ? extractTextFromUserContent(msg.content).trim() : "";
      if (handoff) {
        latestCompaction = {
          id: `rst_${seq}`,
          upToSeq: seq,
          summary: handoff,
        };
      } else {
        latestCompaction = null;
      }
      continue;
    }

    if (UserEntry.is(entry) || (entry.model?.[0]?.role === "user" && !CompactionEntry.is(entry))) {
      const msg = entry.model?.[0];
      if (!msg || msg.role !== "user") continue;
      const text = extractTextFromUserContent(msg.content);
      allMessages.push({
        seq,
        runId: null,
        role: "user",
        content: { text },
        tokensEst: estimateTokens(text),
        createdAt: msg.timestamp || 0,
      });
      continue;
    }

    if (AssistantEntry.is(entry)) {
      const msg = entry.model?.[0];
      if (!msg || msg.role !== "assistant") continue;
      const textParts: string[] = [];
      const toolCalls: ToolCallInvocation[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "toolCall") {
          const args =
            block.arguments && typeof block.arguments === "object"
              ? (block.arguments as Record<string, unknown>)
              : {};
          toolCalls.push({
            id: block.id,
            name: block.name,
            argumentsJson: JSON.stringify(args),
            args,
          });
        }
      }
      const text = textParts.join("");
      const content: Record<string, unknown> = {};
      if (text) content.text = text;
      if (toolCalls.length > 0) content.toolCalls = toolCalls;
      allMessages.push({
        seq,
        runId: null,
        role: "assistant",
        content,
        tokensEst: estimateTokens(text || JSON.stringify(content)),
        createdAt: msg.timestamp || 0,
      });
      continue;
    }

    if (ToolResultEntry.is(entry)) {
      const msg = entry.model?.[0];
      if (!msg || msg.role !== "toolResult") continue;
      const text = extractTextFromToolContent(msg.content);
      allMessages.push({
        seq,
        runId: null,
        role: "tool",
        content: {
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          text,
          ...(msg.isError ? { isError: true } : {}),
        },
        tokensEst: estimateTokens(text),
        createdAt: msg.timestamp || 0,
      });
    }
  }

  const after = Math.max(0, Number(opts?.after ?? 0));
  const limit = Math.max(1, Math.min(500, Number(opts?.limit ?? 50)));
  const before = opts?.before;
  const newest = before !== undefined;

  let paged: MappedHistoryMessage[];
  let hasOlder = false;

  if (newest) {
    const filtered = allMessages.filter((m) => m.seq < before);
    hasOlder = filtered.length > limit;
    paged = filtered.slice(-limit);
  } else {
    paged = allMessages.filter((m) => m.seq > after).slice(0, limit);
  }

  const nextAfter = paged.at(-1)?.seq ?? after;
  return {
    messages: paged,
    compaction: latestCompaction,
    nextAfter,
    ...(newest ? { nextBefore: hasOlder ? paged[0]!.seq : null } : {}),
  };
}

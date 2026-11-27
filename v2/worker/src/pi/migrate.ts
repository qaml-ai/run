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
  defineEntry,
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
import {
  estimateTokens,
  type StoredMessage,
  type StoredRunFile,
  type ToolCallInvocation,
} from "../types.ts";

/**
 * Custom Pi user entry carrying CamelRun per-turn metadata directly inside Pi's
 * transcript (submitted via `PiSubmitOptions.entry` instead of a sidecar table).
 */
export interface CamelRunUserEntryData {
  runId?: string | null;
  actor?: string;
  requestId?: string | null;
  files?: StoredRunFile[];
  meta?: Record<string, unknown>;
}

export const CamelRunUserEntry = defineEntry<JsonObject>("camelrun.user");

export function isUserContentEntry(entry: EntryRecord): boolean {
  return (
    UserEntry.is(entry) ||
    CamelRunUserEntry.is(entry) ||
    (entry.model?.[0]?.role === "user" && !CompactionEntry.is(entry) && !ResetEntry.is(entry))
  );
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

export interface LegacyCompactionRow {
  id: string;
  upToSeq: number;
  summary: string;
  createdAt: number;
}

export interface ImportedEntryMeta {
  entryId: number;
  runId: string | null;
  meta?: Record<string, unknown>;
}

const MAX_TOOL_CALL_ARGS_JSON_LENGTH = 512 * 1024;
const TRUNCATED_TOOL_CALL_PREVIEW_LENGTH = 4_000;

function sanitizeLoneSurrogates(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i]! + text[i + 1]!;
        i++;
      } else {
        out += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\ufffd";
    } else {
      out += text[i]!;
    }
  }
  return out;
}

function safeParseToolArgs(tc: ToolCallInvocation): JsonObject {
  const rawJson =
    typeof tc.argumentsJson === "string" && tc.argumentsJson.length > 0
      ? tc.argumentsJson
      : tc.args && typeof tc.args === "object"
        ? JSON.stringify(tc.args)
        : "";
  if (rawJson.length > MAX_TOOL_CALL_ARGS_JSON_LENGTH) {
    return {
      _truncated: true,
      originalLength: rawJson.length,
      preview: sanitizeLoneSurrogates(rawJson.slice(0, TRUNCATED_TOOL_CALL_PREVIEW_LENGTH)),
    };
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
  if (tc.args && typeof tc.args === "object" && !Array.isArray(tc.args)) {
    return JSON.parse(JSON.stringify(tc.args)) as JsonObject;
  }
  return {};
}

function formatUserMessageContent(msg: StoredMessage): string {
  const files = msg.content.files;
  const textParts: string[] = [];
  if (msg.content.text) textParts.push(sanitizeLoneSurrogates(msg.content.text));
  if (files?.length) {
    for (const file of files) {
      textParts.push(
        `Workspace attachment ${JSON.stringify(file.path)} at commit ${file.commit} (${file.contentType}, ${file.size} bytes).`,
      );
    }
  }
  return textParts.join("\n");
}

/**
 * Imports legacy or previously exported messages into a `pi-durable` conversation
 * with strict assistant toolCall / toolResult pairing so provider transcripts stay valid.
 */
export async function importLegacyTranscriptToPi(
  tx: Tx,
  conversationId: ConversationId,
  legacyCompaction: LegacyCompactionRow | null,
  legacyMessages: readonly StoredMessage[],
  modelRef: ModelRef,
): Promise<{ importedEntries: number; maxLegacySeq: number; importedMeta: ImportedEntryMeta[] }> {
  let importedEntries = 0;
  let maxLegacySeq = legacyCompaction?.upToSeq ?? 0;
  const importedMeta: ImportedEntryMeta[] = [];

  const recordMeta = (entryId: EntryId, msg: StoredMessage) => {
    const meta =
      msg.content.meta && typeof msg.content.meta === "object"
        ? (msg.content.meta as Record<string, unknown>)
        : undefined;
    if (msg.runId || meta) {
      importedMeta.push({ entryId: Number(entryId), runId: msg.runId, ...(meta ? { meta } : {}) });
    }
  };

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

  for (let i = 0; i < legacyMessages.length; i++) {
    const msg = legacyMessages[i]!;
    if (msg.seq > maxLegacySeq) maxLegacySeq = msg.seq;

    if (msg.role === "tool") {
      continue;
    }

    if (msg.role === "user" || msg.role === "system") {
      const userMsg: UserMessage = {
        role: "user",
        content: formatUserMessageContent(msg),
        timestamp: msg.createdAt || Date.now(),
      };
      const entryData: JsonObject = {};
      if (msg.runId) entryData.runId = msg.runId;
      if (msg.content.files?.length) {
        entryData.files = JSON.parse(JSON.stringify(msg.content.files)) as JsonValue;
      }
      if (msg.content.meta && typeof msg.content.meta === "object") {
        entryData.meta = JSON.parse(JSON.stringify(msg.content.meta)) as JsonValue;
      }
      if (Object.keys(entryData).length > 0) {
        await tx.appendEntry(CamelRunUserEntry, conversationId, {
          model: [userMsg],
          data: entryData,
        });
      } else {
        await tx.appendEntry(UserEntry, conversationId, {
          model: [userMsg],
        });
      }
      importedEntries++;
      continue;
    }

    if (msg.role === "assistant") {
      const rawCalls = msg.content.toolCalls ?? [];
      if (rawCalls.length === 0) {
        const text = sanitizeLoneSurrogates(msg.content.text ?? "");
        const assistantMsg: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text }],
          api: "openai-responses",
          provider: modelRef.provider,
          model: modelRef.modelId,
          usage: ZERO_USAGE,
          stopReason: "stop",
          timestamp: msg.createdAt || Date.now(),
        };
        const appended = await tx.appendEntry(AssistantEntry, conversationId, {
          model: [assistantMsg],
        });
        recordMeta(appended.id, msg);
        importedEntries++;
        continue;
      }

      const pendingCallIds = new Set(rawCalls.map((c) => c.id));
      const pairedResults: StoredMessage[] = [];
      while (legacyMessages[i + 1]?.role === "tool") {
        const resMsg = legacyMessages[++i]!;
        if (resMsg.seq > maxLegacySeq) maxLegacySeq = resMsg.seq;
        const callId = resMsg.content.toolCallId;
        const runMismatch =
          msg.runId !== null && resMsg.runId !== null && resMsg.runId !== msg.runId;
        if (runMismatch || !callId || !pendingCallIds.delete(callId)) {
          continue;
        }
        pairedResults.push(resMsg);
      }

      const pairedCalls = rawCalls.filter((c) => !pendingCallIds.has(c.id));
      const contentBlocks: (TextContent | ToolCall)[] = [];
      if (msg.content.text) {
        contentBlocks.push({ type: "text", text: sanitizeLoneSurrogates(msg.content.text) });
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
        const appended = await tx.appendEntry(AssistantEntry, conversationId, {
          model: [assistantMsg],
        });
        recordMeta(appended.id, msg);
        importedEntries++;
      }

      for (const resMsg of pairedResults) {
        const textParts: string[] = [];
        if (resMsg.content.text) textParts.push(sanitizeLoneSurrogates(resMsg.content.text));
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
        const appended = await tx.appendEntry(ToolResultEntry, conversationId, {
          model: [toolResultMsg],
          data: { diagnostics: [] },
        });
        recordMeta(appended.id, resMsg);
        importedEntries++;
      }
    }
  }

  return { importedEntries, maxLegacySeq, importedMeta };
}

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

/**
 * Copies `pi-durable` entries from a source AgentDO into a newly forked AgentDO's
 * root conversation inside `harness.root({ agent, init })`.
 */
export async function copyPiEntriesToConversation(
  tx: Tx,
  conversationId: ConversationId,
  entries: readonly EntryRecord[],
): Promise<Map<number, number>> {
  const idMap = new Map<number, EntryId>();
  const numIdMap = new Map<number, number>();
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
    numIdMap.set(Number(entry.id), Number(appended.id));
  }
  return numIdMap;
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

export interface PiEntryMetadata {
  runId: string | null;
  meta?: Record<string, unknown>;
  repoCommit?: string | null;
}

/**
 * Maps `pi-durable` `EntryRecord[]` (ascending by EntryId) into CamelRun v2's
 * `GET /v2/agents/:idOrKey/history` response shape (`StoredMessage[]` + `compaction`).
 */
export function mapPiEntriesToHistory(
  entries: readonly EntryRecord[],
  opts?: { after?: number; before?: number; limit?: number },
  entryMeta?: ReadonlyMap<number, PiEntryMetadata>,
): MappedHistoryResult {
  const allMessages: MappedHistoryMessage[] = [];
  let latestCompaction: { id: string; upToSeq: number; summary: string } | null = null;
  let currentRunId: string | null = null;

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
      currentRunId = null;
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
      currentRunId = null;
      continue;
    }

    if (isUserContentEntry(entry)) {
      const msg = entry.model?.[0];
      if (!msg || msg.role !== "user") continue;
      const text = extractTextFromUserContent(msg.content);
      const em = entryMeta?.get(seq);
      const nativeData = CamelRunUserEntry.is(entry)
        ? (entry.data as CamelRunUserEntryData | undefined)
        : undefined;
      const runId = nativeData?.runId !== undefined ? nativeData.runId : (em?.runId ?? null);
      currentRunId = runId;

      const rawMeta: Record<string, unknown> = {
        ...(em?.meta ?? {}),
        ...(nativeData?.meta ?? {}),
      };
      if (nativeData?.actor) {
        rawMeta.actor = nativeData.actor;
        rawMeta.requestId = nativeData.requestId ?? null;
      }
      const attachedFiles =
        nativeData?.files && nativeData.files.length > 0
          ? nativeData.files
          : Array.isArray(rawMeta._files)
            ? rawMeta._files
            : undefined;
      if ("_files" in rawMeta) delete rawMeta._files;
      const hasMeta = Object.keys(rawMeta).length > 0;
      allMessages.push({
        seq,
        runId,
        role: "user",
        content: {
          text,
          ...(attachedFiles ? { files: attachedFiles } : {}),
          ...(hasMeta ? { meta: rawMeta } : {}),
        },
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
      const em = entryMeta?.get(seq);
      if (em?.meta && Object.keys(em.meta).length > 0) {
        content.meta = em.meta;
      }
      allMessages.push({
        seq,
        runId: em?.runId ?? currentRunId,
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
      const em = entryMeta?.get(seq);
      const hasMeta = Boolean(em?.meta && Object.keys(em.meta).length > 0);
      const text = extractTextFromToolContent(msg.content);
      const imageBlocks = msg.content.filter(
        (b): b is ImageContent => b.type === "image" && typeof b.mimeType === "string",
      );
      allMessages.push({
        seq,
        runId: em?.runId ?? currentRunId,
        role: "tool",
        content: {
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          text,
          ...(imageBlocks.length > 0
            ? {
                toolImages: imageBlocks.map((img) => ({
                  contentType: img.mimeType,
                })),
              }
            : {}),
          ...(msg.isError ? { isError: true } : {}),
          ...(hasMeta ? { meta: em!.meta } : {}),
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

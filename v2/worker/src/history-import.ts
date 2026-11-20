import { z } from "zod";
import { parseRunFiles } from "./run-files.ts";
import { validateLegacyInlineContent } from "./legacy-inline-images.ts";
import { FILE_LIMITS } from "../../../src/limits.ts";
import { ApiError, type ChatRole, type RunFile, type StoredMessageContent, type ToolCallInvocation } from "./types.ts";

const text = z.object({ type: z.literal("text"), text: z.string() });
const image = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() });
const file = z.looseObject({
  type: z.literal("file"),
  path: z.string().startsWith("/workspace/"),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
});
const workspaceContent = z.array(z.discriminatedUnion("type", [text, file]));
const userContent = z.array(z.discriminatedUnion("type", [text, file, image]));
const toolCall = z.object({ type: z.literal("toolCall"), id: z.string().min(1), name: z.string().min(1), arguments: z.record(z.string(), z.unknown()) });
const thinking = z.object({ type: z.literal("thinking"), thinking: z.string() });
const timestamp = z.number().int().nonnegative();
const messageSchema = z.discriminatedUnion("role", [
  z.looseObject({ role: z.literal("system"), content: z.union([z.string(), z.array(text)]), timestamp }),
  z.looseObject({ role: z.literal("user"), content: z.union([z.string(), userContent]), timestamp }),
  z.looseObject({ role: z.literal("assistant"), content: z.array(z.discriminatedUnion("type", [text, toolCall, thinking])), timestamp }),
  z.looseObject({ role: z.literal("toolResult"), content: workspaceContent, toolCallId: z.string().min(1), toolName: z.string().min(1), isError: z.boolean().optional(), timestamp }),
]);

const importSchema = z.object({
  source: z.string().min(1),
  previous: z.string().optional(),
  appendAfter: z.number().int().nonnegative().optional(),
  messages: z.array(z.unknown()),
  attachments: z.array(z.object({ messageIndex: z.number().int().nonnegative(), files: z.array(z.unknown()).min(1) })).optional(),
  repair: z.boolean().optional(),
});

const repairMessageSchema = z.discriminatedUnion("role", [
  z.looseObject({ role: z.literal("system"), content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]), timestamp: timestamp.optional() }),
  z.looseObject({ role: z.literal("user"), content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]), timestamp: timestamp.optional() }),
  z.looseObject({ role: z.literal("assistant"), content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]), timestamp: timestamp.optional() }),
  z.looseObject({ role: z.literal("toolResult"), content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]), toolCallId: z.string().min(1), toolName: z.string().min(1), isError: z.boolean().optional(), timestamp: timestamp.optional() }),
]);

function stripOversizedInlineData(original: unknown): unknown {
  if (!original || typeof original !== "object") return original;
  const record = original as { content?: unknown };
  if (!Array.isArray(record.content)) return original;
  return {
    ...record,
    content: record.content.map((block: any) =>
      block?.type === "image" && typeof block.data === "string" && block.data.length > 500_000
        ? { ...block, data: "", omittedBytes: block.data.length }
        : block),
  };
}

type ImportedMessage = {
  role: ChatRole;
  content: StoredMessageContent;
  createdAt: number;
  attachments?: RunFile[];
  sourceFileSizes?: Map<string, number>;
};

export function parseV1History(body: unknown) {
  const input = importSchema.safeParse(body);
  if (!input.success) throw new ApiError(400, "invalid_history", "Expected a v1 source identifier and its messages");
  const { source, previous, appendAfter, messages, repair } = input.data;
  if (appendAfter !== undefined && (messages.length === 0 || !Number.isSafeInteger(appendAfter + messages.length))) {
    throw new ApiError(422, "invalid_history", "An appended history chunk must contain messages at valid sequence numbers");
  }
  const attachments = new Map<number, RunFile[]>();
  for (const { messageIndex, files } of input.data.attachments ?? []) {
    if (messageIndex >= messages.length || attachments.has(messageIndex)) {
      throw new ApiError(422, "invalid_history", `Invalid attachment index ${messageIndex}`);
    }
    attachments.set(messageIndex, parseRunFiles(files));
  }
  const pending = new Map<string, string>();
  const imported = messages.map((original, index): ImportedMessage => {
    const parsed = (repair ? repairMessageSchema : messageSchema).safeParse(original);
    if (!parsed.success) {
      throw new ApiError(422, "unsupported_history", `V1 message ${index} contains an unsupported role, attachment, or content block`);
    }
    const message = parsed.data;
    const messageTimestamp = message.timestamp ?? 0;
    const mappedFiles = attachments.get(index);
    const files = mappedFiles && [...new Map(mappedFiles.map(file => [JSON.stringify(file), file])).values()];
    const sourceFileSizes = new Map<string, number>();
    const unpinnedFileNotes: string[] = [];
    if ((message.role === "user" || message.role === "toolResult") && Array.isArray(message.content)) {
      const seen = new Map<string, string>();
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type !== "file") continue;
        const rawPath = typeof block.path === "string" ? block.path : "";
        const path = rawPath.startsWith("/workspace/") ? rawPath.slice("/workspace/".length) : rawPath;
        const identity = JSON.stringify(block);
        const earlier = seen.get(path);
        const matched = rawPath.startsWith("/workspace/") && typeof block.contentType === "string" &&
          files?.filter(file => file.path === path && file.contentType === block.contentType).length === 1;
        if ((earlier !== undefined && earlier !== identity) || !matched) {
          if (!repair) {
            throw new ApiError(422, "invalid_history", `V1 message ${index} has a workspace file without a matching pinned attachment`);
          }
          unpinnedFileNotes.push(`[Historical workspace file: ${rawPath || "unknown"} (${String(block.contentType ?? "application/octet-stream")}, ${Number(block.size ?? 0)} bytes)]`);
          continue;
        }
        seen.set(path, identity);
        if (typeof block.size === "number") sourceFileSizes.set(path, block.size);
      }
    }
    if (!repair && files && message.role !== "user" && sourceFileSizes.size !== files.length) {
      throw new ApiError(422, "invalid_history", `V1 message ${index} has extra workspace attachments`);
    }
    const workspaceFiles = {
      ...(files ? { attachments: files } : {}),
      ...(sourceFileSizes.size ? { sourceFileSizes } : {}),
    };
    let storedOriginal = original;
    if (repair && new TextEncoder().encode(JSON.stringify(storedOriginal)).byteLength >= 7_500_000) {
      storedOriginal = stripOversizedInlineData(storedOriginal);
    }
    const content: StoredMessageContent = { meta: { v1: storedOriginal } };
    if (message.role === "user" && Array.isArray(message.content) && message.content.some(block => block.type === "image")) {
      if (files?.length) {
        if (!repair) throw new ApiError(422, "unsupported_history", "Inline images and workspace files cannot share an imported message");
      } else if (repair) {
        try {
          if (appendAfter === undefined) {
            validateLegacyInlineContent(message.content);
            content.legacyInlineImages = true;
          }
        } catch { /* Preserve raw meta.v1 without flagging legacyInlineImages when raster validation fails in repair mode. */ }
      } else {
        validateLegacyInlineContent(message.content);
        content.legacyInlineImages = true;
      }
    }
    const baseText = typeof message.content === "string"
      ? message.content
      : (message.content as Array<Record<string, unknown>>).flatMap(block => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
    content.text = unpinnedFileNotes.length ? [baseText, ...unpinnedFileNotes].filter(Boolean).join("\n") : baseText;
    if (message.role === "toolResult") {
      if (pending.get(message.toolCallId) !== message.toolName) {
        if (!repair) throw new ApiError(422, "invalid_history", `V1 tool result at message ${index} has no matching call`);
      } else {
        pending.delete(message.toolCallId);
      }
      return { role: "tool", content: { ...content, toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError },
        createdAt: messageTimestamp, ...workspaceFiles };
    }
    if (pending.size) {
      if (!repair) throw new ApiError(422, "invalid_history", `V1 tool results are missing before message ${index}`);
      pending.clear();
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const calls: ToolCallInvocation[] = [];
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type !== "toolCall") continue;
        if (typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !block.name) {
          if (!repair) throw new ApiError(422, "unsupported_history", `V1 message ${index} contains an invalid toolCall block`);
          continue;
        }
        if (pending.has(block.id)) {
          if (!repair) throw new ApiError(422, "invalid_history", `V1 message ${index} repeats a tool call ID`);
          continue;
        }
        const args = block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
          ? block.arguments as Record<string, unknown> : {};
        pending.set(block.id, block.name);
        calls.push({ id: block.id, name: block.name, argumentsJson: JSON.stringify(args), args });
      }
      if (calls.length) content.toolCalls = calls;
    }
    return { role: message.role, content, createdAt: messageTimestamp, ...workspaceFiles };
  });
  if (pending.size && !repair) throw new ApiError(422, "invalid_history", "V1 history ends with unanswered tool calls");
  if (imported.some(message => message.content.legacyInlineImages)) {
    const clearInlineFlags = () => {
      for (const message of imported) delete message.content.legacyInlineImages;
    };
    if (appendAfter !== undefined) {
      if (repair) clearInlineFlags();
      else throw new ApiError(422, "unsupported_history", "Inline images require a single history import");
    }
    // V1 compacts when images exceed this budget. Keep that separate from this
    // byte-preserving import, and do not mix its FileRef hydration policy yet.
    if (imported.some(message => message.content.legacyInlineImages) && imported.some(message => message.attachments?.length)) {
      if (repair) clearInlineFlags();
      else throw new ApiError(422, "unsupported_history", "Inline history cannot yet combine workspace attachments");
    }
    let imageCount = 0, imageBytes = 0;
    for (const message of imported) {
      if (!message.content.legacyInlineImages) continue;
      // A SQLite-backed Durable Object row is limited to 8 MB. The storage
      // transaction remains authoritative for the small record-header overhead.
      if (new TextEncoder().encode(JSON.stringify(message.content)).byteLength >= 8_000_000) {
        if (repair) { delete message.content.legacyInlineImages; continue; }
        throw new ApiError(422, "unsupported_history", "Inline history exceeds the Durable Object row size");
      }
      const original = message.content.meta!.v1 as { content: Array<{ type: string; data?: string }> };
      for (const block of original.content) if (block.type === "image") {
        imageCount++;
        imageBytes += block.data!.length;
      }
    }
    if (imported.some(message => message.content.legacyInlineImages) &&
        (imageCount > FILE_LIMITS.requestImages || imageBytes > FILE_LIMITS.requestImageBase64Bytes)) {
      if (repair) clearInlineFlags();
      else throw new ApiError(422, "unsupported_history", "Inline history requires legacy image-budget compaction");
    }
  }
  return { source, previous, appendAfter, messages: imported };
}

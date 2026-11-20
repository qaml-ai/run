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
  messages: z.array(z.unknown()),
  attachments: z.array(z.object({ messageIndex: z.number().int().nonnegative(), files: z.array(z.unknown()).min(1) })).optional(),
});

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
  const { source, previous, messages } = input.data;
  const attachments = new Map<number, RunFile[]>();
  for (const { messageIndex, files } of input.data.attachments ?? []) {
    if (messageIndex >= messages.length || attachments.has(messageIndex)) {
      throw new ApiError(422, "invalid_history", `Invalid attachment index ${messageIndex}`);
    }
    attachments.set(messageIndex, parseRunFiles(files));
  }
  const pending = new Map<string, string>();
  const imported = messages.map((original, index): ImportedMessage => {
    const parsed = messageSchema.safeParse(original);
    if (!parsed.success) {
      throw new ApiError(422, "unsupported_history", `V1 message ${index} contains an unsupported role, attachment, or content block`);
    }
    const message = parsed.data;
    const mappedFiles = attachments.get(index);
    const files = mappedFiles && [...new Map(mappedFiles.map(file => [JSON.stringify(file), file])).values()];
    const sourceFileSizes = new Map<string, number>();
    if ((message.role === "user" || message.role === "toolResult") && Array.isArray(message.content)) {
      const seen = new Map<string, string>();
      for (const block of message.content) {
        if (block.type !== "file") continue;
        const path = block.path.slice("/workspace/".length);
        const identity = JSON.stringify(block);
        const earlier = seen.get(path);
        if ((earlier !== undefined && earlier !== identity) ||
            files?.filter(file => file.path === path && file.contentType === block.contentType).length !== 1) {
          throw new ApiError(422, "invalid_history", `V1 message ${index} has a workspace file without a matching pinned attachment`);
        }
        seen.set(path, identity);
        sourceFileSizes.set(path, block.size);
      }
    }
    if (files && message.role !== "user" && sourceFileSizes.size !== files.length) {
      throw new ApiError(422, "invalid_history", `V1 message ${index} has extra workspace attachments`);
    }
    const workspaceFiles = {
      ...(files ? { attachments: files } : {}),
      ...(sourceFileSizes.size ? { sourceFileSizes } : {}),
    };
    const content: StoredMessageContent = { meta: { v1: original } };
    if (message.role === "user" && Array.isArray(message.content) && message.content.some(block => block.type === "image")) {
      if (files?.length) throw new ApiError(422, "unsupported_history", "Inline images and workspace files cannot share an imported message");
      validateLegacyInlineContent(message.content);
      content.legacyInlineImages = true;
    }
    content.text = typeof message.content === "string" ? message.content : message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    if (message.role === "toolResult") {
      if (pending.get(message.toolCallId) !== message.toolName) throw new ApiError(422, "invalid_history", `V1 tool result at message ${index} has no matching call`);
      pending.delete(message.toolCallId);
      return { role: "tool", content: { ...content, toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError },
        createdAt: message.timestamp, ...workspaceFiles };
    }
    if (pending.size) throw new ApiError(422, "invalid_history", `V1 tool results are missing before message ${index}`);
    if (message.role === "assistant") {
      const calls: ToolCallInvocation[] = [];
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        if (pending.has(block.id)) throw new ApiError(422, "invalid_history", `V1 message ${index} repeats a tool call ID`);
        pending.set(block.id, block.name);
        calls.push({ id: block.id, name: block.name, argumentsJson: JSON.stringify(block.arguments), args: block.arguments });
      }
      if (calls.length) content.toolCalls = calls;
    }
    return { role: message.role, content, createdAt: message.timestamp, ...workspaceFiles };
  });
  if (pending.size) throw new ApiError(422, "invalid_history", "V1 history ends with unanswered tool calls");
  if (imported.some(message => message.content.legacyInlineImages)) {
    // V1 compacts when images exceed this budget. Keep that separate from this
    // byte-preserving import, and do not mix its FileRef hydration policy yet.
    if (imported.some(message => message.attachments?.length)) {
      throw new ApiError(422, "unsupported_history", "Inline history cannot yet combine workspace attachments");
    }
    let imageCount = 0, imageBytes = 0;
    for (const message of imported) {
      if (!message.content.legacyInlineImages) continue;
      // A SQLite-backed Durable Object row is limited to 8 MB. The storage
      // transaction remains authoritative for the small record-header overhead.
      if (new TextEncoder().encode(JSON.stringify(message.content)).byteLength >= 8_000_000) {
        throw new ApiError(422, "unsupported_history", "Inline history exceeds the Durable Object row size");
      }
      const original = message.content.meta!.v1 as { content: Array<{ type: string; data?: string }> };
      for (const block of original.content) if (block.type === "image") {
        imageCount++;
        imageBytes += block.data!.length;
      }
    }
    if (imageCount > FILE_LIMITS.requestImages || imageBytes > FILE_LIMITS.requestImageBase64Bytes) {
      throw new ApiError(422, "unsupported_history", "Inline history requires legacy image-budget compaction");
    }
  }
  return { source, previous, messages: imported };
}

import { z } from "zod";
import { parseRunFiles } from "./run-files.ts";
import { ApiError, type ChatRole, type RunFile, type StoredMessageContent, type ToolCallInvocation } from "./types.ts";

const text = z.object({ type: z.literal("text"), text: z.string() });
const toolCall = z.object({ type: z.literal("toolCall"), id: z.string().min(1), name: z.string().min(1), arguments: z.record(z.string(), z.unknown()) });
const thinking = z.object({ type: z.literal("thinking"), thinking: z.string() });
const timestamp = z.number().int().nonnegative();
const messageSchema = z.discriminatedUnion("role", [
  z.looseObject({ role: z.literal("system"), content: z.union([z.string(), z.array(text)]), timestamp }),
  z.looseObject({ role: z.literal("user"), content: z.union([z.string(), z.array(text)]), timestamp }),
  z.looseObject({ role: z.literal("assistant"), content: z.array(z.discriminatedUnion("type", [text, toolCall, thinking])), timestamp }),
  z.looseObject({ role: z.literal("toolResult"), content: z.array(text), toolCallId: z.string().min(1), toolName: z.string().min(1), isError: z.boolean().optional(), timestamp }),
]);

const importSchema = z.object({
  source: z.string().min(1),
  previous: z.string().optional(),
  messages: z.array(z.unknown()),
  attachments: z.array(z.object({ messageIndex: z.number().int().nonnegative(), files: z.array(z.unknown()).min(1) })).optional(),
});

type ImportedMessage = { role: ChatRole; content: StoredMessageContent; createdAt: number; attachments?: RunFile[] };

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
    const files = attachments.get(index);
    if (files && message.role !== "user") throw new ApiError(422, "invalid_history", `V1 message ${index} cannot have workspace attachments`);
    const content: StoredMessageContent = { meta: { v1: original } };
    content.text = typeof message.content === "string" ? message.content : message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    if (message.role === "toolResult") {
      if (pending.get(message.toolCallId) !== message.toolName) throw new ApiError(422, "invalid_history", `V1 tool result at message ${index} has no matching call`);
      pending.delete(message.toolCallId);
      return { role: "tool", content: { ...content, toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError }, createdAt: message.timestamp };
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
    return { role: message.role, content, createdAt: message.timestamp, ...(files ? { attachments: files } : {}) };
  });
  if (pending.size) throw new ApiError(422, "invalid_history", "V1 history ends with unanswered tool calls");
  return { source, previous, messages: imported };
}

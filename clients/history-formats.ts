/**
 * Conversations from other APIs as Pi messages, the history an agent begins with (`initialMessages`): Anthropic's
 * Messages API, and OpenAI's Responses and Chat Completions APIs, with their tool calls and results. The runtime
 * converts `importMessages` with this when an agent is made; call it yourself to see what an agent will begin with.
 *
 * Reasoning is kept as thinking, marked with the model that wrote it (`model`, when you give it): Pi then sends it
 * back as it came to that same model (signed thinking, encrypted reasoning), and to any other model as text, or not
 * at all when it has no text, as for any conversation that changes model. System and developer messages are left
 * out: the agent's own system prompt replaces them.
 */
import type { Message } from "./types.ts";

export type HistoryFormat = "anthropic" | "openai-responses" | "openai-chat";
export interface ImportMessages {
  format: HistoryFormat;
  messages: unknown[];
  /** The model that wrote the assistant turns, as `provider/model-id` (e.g. `anthropic/claude-sonnet-5`). */
  model?: string;
}

/** A conversation that cannot be converted: `index` is the message (or input item) at fault. */
export class HistoryFormatError extends Error {
  readonly index: number;
  constructor(index: number, message: string) {
    super(`INVALID_HISTORY: importMessages.messages[${index}]: ${message}`);
    this.index = index;
  }
}

type Block = Record<string, any>;
type Source = { api: string; provider: string; model: string };
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const API: Record<HistoryFormat, { api: string; provider: string }> = {
  anthropic: { api: "anthropic-messages", provider: "anthropic" },
  "openai-responses": { api: "openai-responses", provider: "openai" },
  "openai-chat": { api: "openai-completions", provider: "openai" },
};

/** An image from a `data:` URL; images by any other URL are refused (the runtime fetches nothing for an import). */
function dataImage(url: unknown, at: number): Block {
  const match = typeof url === "string" ? /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(url) : null;
  if (!match) throw new HistoryFormatError(at, "an image must be a base64 data: URL (images by URL are not fetched)");
  return { type: "image", mimeType: match[1], data: match[2].replace(/\s+/g, "") };
}
/** Tool output as Pi's tool result content: text, or text and images. */
function outputBlocks(output: unknown, at: number, image: (part: Block) => Block | undefined): Block[] {
  if (typeof output === "string") return [{ type: "text", text: output }];
  if (!Array.isArray(output)) return [{ type: "text", text: JSON.stringify(output ?? null) }];
  return output.map(part => {
    if (!isObject(part)) throw new HistoryFormatError(at, "a tool result's content is text or a list of text and image parts");
    if (typeof part.text === "string") return { type: "text", text: part.text };
    const converted = image(part);
    if (converted) return converted;
    throw new HistoryFormatError(at, `a tool result part of type ${JSON.stringify(part.type)} cannot be imported`);
  });
}
const parseArguments = (text: unknown, at: number) => {
  if (isObject(text)) return text;
  if (typeof text !== "string") throw new HistoryFormatError(at, "a function call's arguments are a JSON object or its text");
  if (!text.trim()) return {};
  try { const value = JSON.parse(text); if (isObject(value)) return value; } catch { /* below */ }
  throw new HistoryFormatError(at, "a function call's arguments are not a JSON object");
};

/** Builds the Pi messages: assistant blocks gather into one message until a user message or a tool result. */
class Builder {
  readonly messages: Message[] = [];
  private assistant: Block[] | null = null;
  private readonly names = new Map<string, string>();
  private readonly source: Source;
  private time: number;
  constructor(source: Source, start: number) { this.source = source; this.time = start; }
  private stamp() { return this.time++; }
  private flush() {
    if (!this.assistant) return;
    const content = this.assistant;
    this.assistant = null;
    if (!content.length) return;
    this.messages.push({ role: "assistant", content, ...this.source, usage: NO_USAGE, stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop", timestamp: this.stamp() } as never);
  }
  user(content: Block[] | string) {
    this.flush();
    if (typeof content === "string" ? !content : !content.length) return;
    this.messages.push({ role: "user", content, timestamp: this.stamp() } as never);
  }
  blocks(...blocks: Block[]) { (this.assistant ??= []).push(...blocks); }
  call(id: unknown, name: unknown, args: Record<string, unknown>, at: number) {
    if (typeof id !== "string" || !id || typeof name !== "string" || !name) throw new HistoryFormatError(at, "a tool call needs an id and a name");
    this.names.set(id, name);
    this.blocks({ type: "toolCall", id, name, arguments: args });
  }
  result(id: unknown, content: Block[], isError: boolean, at: number) {
    this.flush();
    const name = typeof id === "string" ? this.names.get(id) : undefined;
    if (!name) throw new HistoryFormatError(at, `a tool result for ${JSON.stringify(id)}, which no earlier tool call has`);
    this.messages.push({ role: "toolResult", toolCallId: id, toolName: name, content, isError, timestamp: this.stamp() } as never);
  }
  /** Close the assistant message being gathered. */
  end() { this.flush(); }
  done() { this.flush(); return this.messages; }
}

/** An Anthropic image block (base64, or a data: URL) as Pi's. */
const anthropicImage = (at: number) => (part: Block): Block | undefined => {
  if (part.type !== "image" || !isObject(part.source)) return undefined;
  if (part.source.type === "base64" && typeof part.source.data === "string" && typeof part.source.media_type === "string") return { type: "image", mimeType: part.source.media_type, data: part.source.data };
  return dataImage(part.source.url, at);
};

function anthropic(messages: unknown[], builder: Builder) {
  messages.forEach((message, at) => {
    const image = anthropicImage(at);
    if (!isObject(message) || !["user", "assistant", "system"].includes(message.role)) throw new HistoryFormatError(at, "a message is { role: user | assistant, content }");
    if (message.role === "system") return;
    const content: Block[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
    if (!Array.isArray(message.content) && typeof message.content !== "string") throw new HistoryFormatError(at, "content is a string or a list of blocks");
    if (message.role === "assistant") {
      for (const block of content) {
        if (block?.type === "text") builder.blocks({ type: "text", text: String(block.text ?? "") });
        else if (block?.type === "thinking") builder.blocks({ type: "thinking", thinking: String(block.thinking ?? ""), ...(block.signature ? { thinkingSignature: block.signature } : {}) });
        else if (block?.type === "redacted_thinking") builder.blocks({ type: "thinking", thinking: "", thinkingSignature: block.data, redacted: true });
        else if (block?.type === "tool_use") builder.call(block.id, block.name, isObject(block.input) ? block.input : {}, at);
        else throw new HistoryFormatError(at, `an assistant block of type ${JSON.stringify(block?.type)} cannot be imported`);
      }
      return;
    }
    // A user message: its tool results first (each its own Pi message), then what the user wrote.
    const said: Block[] = [];
    for (const block of content) {
      if (block?.type === "tool_result") builder.result(block.tool_use_id, outputBlocks(block.content ?? "", at, image), block.is_error === true, at);
      else if (block?.type === "text") said.push({ type: "text", text: String(block.text ?? "") });
      else if (block?.type === "image") said.push(image(block)!);
      else throw new HistoryFormatError(at, `a user block of type ${JSON.stringify(block?.type)} cannot be imported`);
    }
    builder.user(said);
  });
}

function openaiParts(content: unknown, at: number): Block[] | string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new HistoryFormatError(at, "content is a string or a list of parts");
  return content.flatMap((part: any): Block[] => {
    if (!isObject(part)) throw new HistoryFormatError(at, "a content part is an object");
    if (["input_text", "output_text", "text"].includes(part.type)) return [{ type: "text", text: String(part.text ?? "") }];
    if (part.type === "refusal") return [{ type: "text", text: String(part.refusal ?? "") }];
    if (part.type === "input_image") return [dataImage(part.image_url, at)];
    if (part.type === "image_url") return [dataImage(isObject(part.image_url) ? part.image_url.url : part.image_url, at)];
    throw new HistoryFormatError(at, `a content part of type ${JSON.stringify(part.type)} cannot be imported`);
  });
}
const outputImage = (at: number) => (part: Block) => part.type === "input_image" ? dataImage(part.image_url, at) : part.type === "image_url" ? dataImage(isObject(part.image_url) ? part.image_url.url : part.image_url, at) : undefined;

function responses(items: unknown[], builder: Builder) {
  items.forEach((item, at) => {
    if (!isObject(item)) throw new HistoryFormatError(at, "an input item is an object");
    const type = item.type ?? (item.role ? "message" : undefined);
    if (type === "message") {
      if (item.role === "system" || item.role === "developer") return;
      const parts = openaiParts(item.content, at);
      if (item.role === "user") builder.user(parts);
      else if (item.role === "assistant") builder.blocks(...(typeof parts === "string" ? [{ type: "text", text: parts }] : parts));
      else throw new HistoryFormatError(at, `a message's role is user, assistant, system or developer, not ${JSON.stringify(item.role)}`);
    } else if (type === "reasoning") {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].map((part: any) => part?.text ?? "").filter(Boolean).join("\n\n");
      builder.blocks({ type: "thinking", thinking: text, thinkingSignature: JSON.stringify(item) });
    } else if (type === "function_call") builder.call(item.call_id, item.name, parseArguments(item.arguments, at), at);
    else if (type === "function_call_output") builder.result(item.call_id, outputBlocks(item.output, at, outputImage(at)), false, at);
    else throw new HistoryFormatError(at, `an input item of type ${JSON.stringify(type)} cannot be imported`);
  });
}

function chat(messages: unknown[], builder: Builder) {
  messages.forEach((message, at) => {
    if (!isObject(message)) throw new HistoryFormatError(at, "a message is an object");
    if (message.role === "system" || message.role === "developer") return;
    if (message.role === "user") return builder.user(openaiParts(message.content, at));
    if (message.role === "tool") return builder.result(message.tool_call_id, outputBlocks(message.content, at, outputImage(at)), false, at);
    if (message.role !== "assistant") throw new HistoryFormatError(at, `a message's role is user, assistant, tool, system or developer, not ${JSON.stringify(message.role)}`);
    if (typeof message.reasoning_content === "string" && message.reasoning_content) builder.blocks({ type: "thinking", thinking: message.reasoning_content });
    if (message.content !== null && message.content !== undefined) {
      const parts = openaiParts(message.content, at);
      builder.blocks(...(typeof parts === "string" ? (parts ? [{ type: "text", text: parts }] : []) : parts));
    }
    for (const call of message.tool_calls ?? []) {
      if (!isObject(call) || !isObject(call.function)) throw new HistoryFormatError(at, "a tool call is { id, type: function, function: { name, arguments } }");
      builder.call(call.id, call.function.name, parseArguments(call.function.arguments, at), at);
    }
    // Each assistant message stays its own, as Chat Completions sent it.
    builder.end();
  });
}

/**
 * Pi messages from another API's conversation (`importMessages`). `now` dates the messages (they keep their order);
 * throws `HistoryFormatError`, naming the message at fault, for one that cannot be converted.
 */
export function toPiMessages(input: ImportMessages, now = Date.now()): Message[] {
  if (!isObject(input) || !Object.hasOwn(API, input.format as string)) throw new HistoryFormatError(0, `format is ${Object.keys(API).join(", ")}`);
  if (!Array.isArray(input.messages)) throw new HistoryFormatError(0, "messages must be a list");
  const named = typeof input.model === "string" ? /^([^/]+)\/(.+)$/.exec(input.model) : null;
  if (input.model !== undefined && !named) throw new HistoryFormatError(0, 'model is "provider/model-id"');
  const source = { ...API[input.format], ...(named ? { provider: named[1], model: named[2] } : { model: "unknown" }) };
  const builder = new Builder(source, now - input.messages.length);
  if (input.format === "anthropic") anthropic(input.messages, builder);
  else if (input.format === "openai-responses") responses(input.messages, builder);
  else chat(input.messages, builder);
  return builder.done();
}

import { createHash } from "node:crypto";
import type { Api } from "@earendil-works/pi-ai";
import { openAIIdlePayload } from "./model-idle-compaction-openai.ts";
import { otherIdlePayload } from "./model-idle-compaction-other.ts";

type Body = Record<string, unknown>;
type Ttl = "5m" | "1h";

export type IdleCompactionCache = {
  digest: string;
  ttlMs: number;
  messageIndex: number;
  blockIndex: number;
  ttl?: Ttl;
};

const CACHEABLE_BLOCKS = new Set(["text", "image", "document", "tool_result", "tool_addition", "tool_removal"]);

function record(value: unknown): value is Body {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function request(value: unknown): { body: Body; messages: Body[] } | undefined {
  if (!record(value) || typeof value.model !== "string" || value.cache_control !== undefined) return;
  const { messages, tool_choice: choice, output_config: output, fallbacks } = value;
  if (!Array.isArray(messages) || !messages.every(record)) return;
  if (choice !== undefined && (!record(choice) || (choice.type !== "auto" && choice.type !== "none"))) return;
  if ((record(output) && output.format !== undefined) || (Array.isArray(fallbacks) && fallbacks.length)) return;
  return { body: value, messages };
}

function blocks(message: Body): Body[] | undefined {
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) && content.every(record) ? content : undefined;
}

/** Pi's managed-effort provider adds this setting after the latest message, without a cacheable content block. */
function effortMarker(message: Body | undefined): boolean {
  const output = message?.output_config;
  return message?.role === "system" && Array.isArray(message.content) && message.content.length === 0 &&
    Object.keys(message).length === 3 && record(output) && typeof output.effort === "string" && Object.keys(output).length === 1;
}

function breakpoint(block: Body): { ttl?: Ttl; ttlMs: number } | undefined {
  const marker = block.cache_control;
  if (!CACHEABLE_BLOCKS.has(String(block.type)) || !record(marker) || marker.type !== "ephemeral") return;
  if (Object.keys(marker).some(key => key !== "type" && key !== "ttl")) return;
  const { ttl } = marker;
  if (ttl === undefined) return { ttlMs: 300_000 };
  if (ttl === "5m" || ttl === "1h") return { ttl, ttlMs: ttl === "1h" ? 3_600_000 : 300_000 };
}

/** Hash the serialized request up to the summary instruction. Keep field order inside tools and messages. */
function fingerprint(body: Body, messages: Body[], messageIndex: number, blockIndex: number, content: Body[]): string {
  const { cache_control: _marker, ...block } = content[blockIndex]!;
  const prefix = messages.slice();
  prefix[messageIndex] = { ...messages[messageIndex], content: content.with(blockIndex, block) };
  // The summary can ask for a different answer length. Pi still sends the same thinking and tool settings.
  const { max_tokens: _length, stream: _stream, ...settings } = body;
  const fields = { ...settings, messages: prefix };
  const ordered = Object.entries(fields).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/** Read the TTL actually sent on conversation input. A system- or tool-only cache cannot save the old history. */
export function readIdleCompactionCache(payload: unknown): IdleCompactionCache | undefined {
  const parsed = request(payload);
  if (!parsed) return;
  const { body, messages } = parsed;
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const content = blocks(messages[messageIndex]!);
    const blockIndex = content?.findLastIndex(block => block.cache_control !== undefined) ?? -1;
    if (!content || blockIndex < 0) continue;
    const marker = breakpoint(content[blockIndex]!);
    if (!marker) return;
    return { ...marker, messageIndex, blockIndex, digest: fingerprint(body, messages, messageIndex, blockIndex, content) };
  }
}

/** Keep the old breakpoint and leave the summary instruction beyond it, where it will not be written to cache. */
export function idleCompactionPayload(payload: unknown, cache: IdleCompactionCache, prompt: string): Body | undefined {
  const parsed = request(payload);
  if (!parsed) return;
  const lastMessage = parsed.messages.at(-1);
  const effort = effortMarker(lastMessage) ? lastMessage : undefined;
  const lastInput = parsed.messages.length - (effort ? 2 : 1);
  const trailing = parsed.messages[lastInput];
  // Pi may defer a pending system update until after two adjacent user inputs, putting the old breakpoint after the instruction.
  const deferredSystem = trailing?.role === "system" && blocks(trailing)?.some(block => breakpoint(block)) ? trailing : undefined;
  const summaryIndex = lastInput - (deferredSystem ? 1 : 0);
  const summary = parsed.messages[summaryIndex];
  if (summary?.role !== "user") return;
  const content = blocks(summary);
  const instruction = content?.at(-1);
  if (!content || instruction?.type !== "text" || instruction.text !== prompt ||
    Object.keys(instruction).some(key => key !== "type" && key !== "text" && key !== "cache_control")) return;

  // Remove only the summary instruction to reconstruct the prior wire request.
  const prefix = parsed.messages.slice(0, summaryIndex);
  if (content.length > 1) prefix.push({ ...summary, content: content.slice(0, -1) });
  if (deferredSystem) prefix.push(deferredSystem);
  const insertAt = prefix.length;
  if (effort) prefix.push(effort);
  const prior = prefix[cache.messageIndex];
  const priorContent = prior && blocks(prior);
  const priorBlock = priorContent?.[cache.blockIndex];
  if (!priorContent || !priorBlock || !CACHEABLE_BLOCKS.has(String(priorBlock.type))) return;
  if (fingerprint(parsed.body, prefix, cache.messageIndex, cache.blockIndex, priorContent) !== cache.digest) return;

  const cacheControl = { type: "ephemeral", ...(cache.ttl === undefined ? {} : { ttl: cache.ttl }) };
  prefix[cache.messageIndex] = { ...prior, content: priorContent.with(cache.blockIndex, { ...priorBlock, cache_control: cacheControl }) };
  const suffix = { type: "text", text: prompt };
  const last = prefix[insertAt - 1];
  const lastContent = last?.role === "user" && blocks(last);
  if (lastContent) prefix[insertAt - 1] = { ...last, content: [...lastContent, suffix] };
  else prefix.splice(insertAt, 0, { role: "user", content: [suffix] });
  return { ...parsed.body, messages: prefix };
}

export type ModelIdleCache = IdleCompactionCache | { api: Api; digest: string; ttlMs: number };

function modelPrefixDigest(prefix: unknown): string {
  const ordered = record(prefix) ? Object.entries(prefix).filter(([, value]) => value !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0) : prefix;
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export function readModelIdleCache(api: Api, payload: unknown): ModelIdleCache | undefined {
  if (!record(payload) || payload.models !== undefined || payload.route !== undefined ||
      (Array.isArray(payload.fallbacks) && payload.fallbacks.length)) return;
  if (api === "anthropic-messages") return readIdleCompactionCache(payload);
  const candidate = openAIIdlePayload(api, payload) ?? otherIdlePayload(api, payload);
  if (candidate) return { api, digest: modelPrefixDigest(candidate.prefix), ttlMs: candidate.ttlMs };
}

export function modelIdlePayload(api: Api, payload: unknown, cache: ModelIdleCache, prompt: string): Body | undefined {
  if (api === "anthropic-messages") return "api" in cache ? undefined : idleCompactionPayload(payload, cache, prompt);
  if (!("api" in cache) || api !== cache.api) return;
  const replay = openAIIdlePayload(api, payload, prompt) ?? otherIdlePayload(api, payload, prompt);
  if (replay && modelPrefixDigest(replay.prefix) === cache.digest) return replay.payload;
}

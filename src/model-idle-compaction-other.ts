import type { Api } from "@earendil-works/pi-ai";

type Body = Record<string, unknown>;
type IdlePayload = { prefix: unknown; ttlMs: number; payload?: Body };
const SHORT_CACHE_MS = 5 * 60_000;
const LONG_CACHE_MS = 60 * 60_000;

function record(value: unknown): value is Body {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function records(value: unknown): value is Body[] {
  return Array.isArray(value) && value.every(record);
}

function textInstruction(message: Body | undefined, block: Body, prompt: string): boolean {
  return message?.role === "user" && Object.keys(message).length === 2 &&
    block.text === prompt && Object.keys(block).length === 1;
}

function googlePayload(body: Body, prompt?: string): IdlePayload | undefined {
  const { model, contents, config } = body;
  if (typeof model !== "string" || !records(contents) || !record(config)) return;
  const { abortSignal: _signal, maxOutputTokens: _limit, ...generation } = config;
  const { responseMimeType, responseSchema, responseJsonSchema, toolConfig } = generation;
  const calling = record(toolConfig) && toolConfig.functionCallingConfig;
  if ((responseMimeType !== undefined && responseMimeType !== "text/plain") ||
    responseSchema !== undefined || responseJsonSchema !== undefined ||
    (record(calling) && calling.mode === "ANY")) return;
  const last = contents.at(-1);
  const parts = last?.parts;
  if (prompt !== undefined && (!records(parts) || parts.length !== 1 || !textInstruction(last, parts[0]!, prompt))) return;

  // The generate request contains no cache expiry, including when it references cachedContent.
  const history = prompt === undefined ? contents : contents.slice(0, -1);
  if (!history.length) return;
  return {
    prefix: { ...body, config: generation, contents: history },
    ttlMs: SHORT_CACHE_MS,
    ...(prompt !== undefined && { payload: body }),
  };
}

function cachePointTtl(block: Body): number | undefined {
  const { cachePoint } = block;
  if (Object.keys(block).length !== 1 || !record(cachePoint) || cachePoint.type !== "default" ||
    Object.keys(cachePoint).some(key => key !== "type" && key !== "ttl")) return;
  if (cachePoint.ttl === "1h") return LONG_CACHE_MS;
  if (cachePoint.ttl === undefined || cachePoint.ttl === "5m") return SHORT_CACHE_MS;
}

function bedrockPayload(body: Body, prompt?: string): IdlePayload | undefined {
  const { modelId, messages, inferenceConfig, system, toolConfig, outputConfig } = body;
  if (typeof modelId !== "string" || !records(messages) || !record(inferenceConfig) || outputConfig !== undefined) return;
  const choice = record(toolConfig) && toolConfig.toolChoice;
  if (record(choice) && (choice.any !== undefined || choice.tool !== undefined)) return;

  const last = messages.at(-1);
  const content = last?.content;
  if (!records(content) || !content.length) return;
  const point = content.at(-1)!;
  const hasPoint = point.cachePoint !== undefined;
  const ttlMs = hasPoint ? cachePointTtl(point) : SHORT_CACHE_MS;
  if (!ttlMs || (hasPoint && (last?.role !== "user" || content.length < 2))) return;
  // A system-only checkpoint leaves the entire conversation outside its explicit cache.
  if (!hasPoint && records(system) && system.some(block => block.cachePoint !== undefined)) return;

  const { maxTokens: _limit, ...inference } = inferenceConfig;
  if (prompt === undefined) {
    return { ttlMs, prefix: { ...body, inferenceConfig: inference } };
  }
  if (content.length !== (hasPoint ? 2 : 1) || !textInstruction(last, content[0]!, prompt)) return;
  const history = messages.slice(0, -1);
  const previous = history.at(-1);
  if (!previous) return;

  if (hasPoint) {
    // Pi puts the marker at the end of the latest user input. Move it back to the
    // matching position on the preceding user input and leave the summary uncached.
    const previousContent = previous.content;
    if (previous.role !== "user" || !records(previousContent) || !previousContent.length ||
      previousContent.some(block => block.cachePoint !== undefined)) return;
    history[history.length - 1] = { ...previous, content: [...previousContent, point] };
  }
  return {
    ttlMs,
    prefix: { ...body, messages: history, inferenceConfig: inference },
    payload: hasPoint ? { ...body, messages: [...history, { ...last, content: [content[0]!] }] } : body,
  };
}

function mistralPayload(body: Body, prompt?: string): IdlePayload | undefined {
  const { messages, toolChoice, responseFormat, maxTokens: _limit, stream: _stream, ...settings } = body;
  if (typeof body.model !== "string" || !records(messages) || !messages.length ||
    (toolChoice !== undefined && toolChoice !== "auto" && toolChoice !== "none") ||
    (responseFormat !== undefined && (!record(responseFormat) || responseFormat.type !== "text"))) return;
  const last = messages.at(-1);
  const content = last?.content;
  if (prompt !== undefined && (last?.role !== "user" ||
    !(content === prompt || records(content) && content.length === 1 && content[0]!.type === "text" && content[0]!.text === prompt))) return;
  const history = prompt === undefined ? messages : messages.slice(0, -1);
  if (!history.length) return;
  return { prefix: { ...settings, messages: history, toolChoice, responseFormat }, ttlMs: SHORT_CACHE_MS,
    ...(prompt !== undefined && { payload: body }) };
}

function piPayload(body: Body, prompt?: string): IdlePayload | undefined {
  const { context, options } = body;
  if (typeof body.model !== "string" || !record(context) || !records(context.messages) || !record(options) ||
    (options.toolChoice !== undefined && options.toolChoice !== "auto" && options.toolChoice !== "none")) return;
  const messages = context.messages;
  const last = messages.at(-1);
  const content = last?.content;
  if (prompt !== undefined && (last?.role !== "user" ||
    !(content === prompt || records(content) && content.length === 1 && content[0]!.type === "text" && content[0]!.text === prompt))) return;
  const history = prompt === undefined ? messages : messages.slice(0, -1);
  if (!history.length) return;
  const { maxTokens: _limit, ...settings } = options;
  return { prefix: { ...body, context: { ...context, messages: history }, options: settings }, ttlMs: SHORT_CACHE_MS,
    ...(prompt !== undefined && { payload: body }) };
}

/** Use the SDK request shapes passed by Pi to onPayload, before serialization. */
export function otherIdlePayload(api: Api, payload: unknown, prompt?: string): IdlePayload | undefined {
  if (!record(payload)) return;
  switch (api) {
    case "google-generative-ai":
    case "google-vertex":
      return googlePayload(payload, prompt);
    case "bedrock-converse-stream":
      return bedrockPayload(payload, prompt);
    case "mistral-conversations":
      return mistralPayload(payload, prompt);
    case "pi-messages":
      return piPayload(payload, prompt);
  }
}

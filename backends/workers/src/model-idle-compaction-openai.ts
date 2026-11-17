import type { Api } from "@earendil-works/pi-ai";

type Body = Record<string, unknown>;

const SHORT_CACHE_MS = 5 * 60_000;
const OPENAI_DEFAULT_CACHE_MS = 30 * 60_000;

function record(value: unknown): value is Body {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function openAITtl(value: unknown, responses: boolean): number | undefined {
  if (value === "30m") return OPENAI_DEFAULT_CACHE_MS;
  // A read of a 12-hour entry refreshes it to at least 30 minutes.
  if (responses && value === "12h") return OPENAI_DEFAULT_CACHE_MS;
}

function anthropicBlockTtl(marker: unknown): number | undefined {
  if (!record(marker) || marker.type !== "ephemeral" || Object.keys(marker).some(key => key !== "type" && key !== "ttl"))
    return;
  if (marker.ttl === undefined || marker.ttl === "5m") return SHORT_CACHE_MS;
  if (marker.ttl === "1h") return 60 * 60_000;
}

function cacheTtl(body: Body, items: Body[], responses: boolean): number | undefined {
  const lifetimes: number[] = [];
  if (body.prompt_cache_retention !== undefined) {
    if (body.prompt_cache_retention !== "in_memory" && body.prompt_cache_retention !== "24h") return;
    // Legacy extended retention has a ceiling of 24 hours, with no minimum.
    lifetimes.push(SHORT_CACHE_MS);
  }
  const options = body.prompt_cache_options;
  let defaultTtl: number | undefined;
  let mode: unknown;
  if (options !== undefined) {
    if (!record(options) || Object.keys(options).some(key => key !== "ttl" && key !== "mode" && key !== "prewarm")) return;
    mode = options.mode;
    if ((mode !== undefined && mode !== "implicit" && mode !== "explicit") ||
      (options.prewarm !== undefined && options.prewarm !== false)) return;
    defaultTtl = options.ttl === undefined ? OPENAI_DEFAULT_CACHE_MS : openAITtl(options.ttl, responses);
    if (defaultTtl === undefined) return;
    if (mode !== "explicit") lifetimes.push(defaultTtl);
  }
  const marked = [
    ...items,
    ...items.flatMap(item => Array.isArray(item.content) ? item.content.filter(record) : []),
    ...items.flatMap(item => Array.isArray(item.output) ? item.output.filter(record) : []),
    ...(Array.isArray(body.tools) ? body.tools.filter(record) : []),
  ];
  let explicit = false;
  for (const item of marked) {
    if (item.cache_control !== undefined) {
      const ttl = anthropicBlockTtl(item.cache_control);
      if (ttl === undefined || responses) return;
      lifetimes.push(ttl);
    }
    const breakpoint = item.prompt_cache_breakpoint;
    if (breakpoint !== undefined && breakpoint !== null) {
      if (!record(breakpoint) || (breakpoint.mode !== undefined && breakpoint.mode !== "explicit") ||
        Object.keys(breakpoint).some(key => key !== "mode" && key !== "ttl")) return;
      const ttl = breakpoint.ttl === undefined ? defaultTtl ?? OPENAI_DEFAULT_CACHE_MS : openAITtl(breakpoint.ttl, responses);
      if (ttl === undefined) return;
      explicit = true;
      lifetimes.push(ttl);
    }
  }
  if (mode === "explicit" && !explicit) return;
  if (explicit && options === undefined) lifetimes.push(OPENAI_DEFAULT_CACHE_MS);
  return lifetimes.length ? Math.min(...lifetimes) : SHORT_CACHE_MS;
}

/** Pi's Responses serializer repeats the current reasoning effort after the last emitted message. */
function configurationUpdate(item: Body | undefined): boolean {
  const reasoning = item?.reasoning;
  return item?.type === "configuration_update" && Object.keys(item).length === 2 &&
    record(reasoning) && typeof reasoning.effort === "string" && Object.keys(reasoning).length === 1;
}

function promptItem(item: Body | undefined, prompt: string, responses: boolean): { marker?: unknown } | undefined {
  if (item?.role !== "user" || Object.keys(item).some(key => key !== "role" && key !== "content")) return;
  if (item.content === prompt && !responses) return {};
  if (!Array.isArray(item.content) || item.content.length !== 1) return;
  const part = item.content[0];
  if (!record(part) || part.type !== (responses ? "input_text" : "text") || part.text !== prompt ||
      Object.keys(part).some(key => key !== "type" && key !== "text" && key !== "cache_control")) return;
  if (part.cache_control !== undefined && (responses || anthropicBlockTtl(part.cache_control) === undefined)) return;
  return { marker: part.cache_control };
}

/** OpenRouter Chat Completions moves a block marker onto the new final user item. Restore its old position. */
function restoreChatMarker(messages: Body[], marker: unknown): Body[] | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "tool") continue;
    const { content } = message;
    if (typeof content === "string" && content.length > 0) {
      return messages.with(index, { ...message, content: [{ type: "text", text: content, cache_control: marker }] });
    }
    if (!Array.isArray(content)) continue;
    const blockIndex = content.findLastIndex(part => record(part) && part.type === "text");
    if (blockIndex >= 0 && content[blockIndex].cache_control === undefined) {
      const blocks = content.with(blockIndex, { ...content[blockIndex], cache_control: marker });
      return messages.with(index, { ...message, content: blocks });
    }
  }
}

export function openAIIdlePayload(api: Api, payload: unknown, prompt?: string): {
  prefix: unknown;
  ttlMs: number;
  payload?: Body;
} | undefined {
  const responses = api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses";
  const binding = api === "cloudflare-ai";
  if (!responses && !binding && api !== "openai-completions") return;
  // The Cloudflare binding passes its model outside the request object.
  if (!record(payload) || (typeof payload.model !== "string" && !(binding && payload.model === undefined)) ||
    payload.previous_response_id !== undefined || payload.conversation !== undefined ||
    payload.context_management !== undefined || payload.background === true ||
    (payload.store !== undefined && payload.store !== false) ||
    // An automatic request-level breakpoint would move to the summary when we add it.
    payload.cache_control !== undefined) return;
  const { text, response_format: format, tool_choice: choice } = payload;
  if (payload.text !== undefined && (!record(text) || (text.format !== undefined && (!record(text.format) || text.format.type !== "text")))) return;
  if (format !== undefined && (!record(format) || format.type !== "text")) return;
  if (choice !== undefined && choice !== "auto" && choice !== "none") return;
  const field = responses ? "input" : "messages";
  const items = payload[field];
  if (!Array.isArray(items) || !items.length || !items.every(record) || items.some(item => item.type === "item_reference")) return;
  const ttl = cacheTtl(payload, items, responses);
  if (ttl === undefined) return;

  let original = items;
  let replay: Body | undefined;
  if (prompt !== undefined) {
    const trailingUpdate = responses && configurationUpdate(items.at(-1)) ? items.at(-1) : undefined;
    const index = items.length - (trailingUpdate ? 2 : 1);
    const summary = promptItem(items[index], prompt, responses);
    if (!summary || index < 1) return;
    original = items.slice(0, index);
    if (trailingUpdate) original.push(trailingUpdate);
    if (summary.marker !== undefined) {
      const restored = restoreChatMarker(original, summary.marker);
      if (!restored) return;
      original = restored;
      replay = { ...payload, [field]: [...original, { role: "user", content: [{ type: "text", text: prompt }] }] };
    } else {
      replay = trailingUpdate ? { ...payload, [field]: [...original, items[index]] } : payload;
    }
  }
  const prefix = { ...payload, [field]: original };
  delete prefix.stream;
  delete prefix.store;
  if (responses) delete prefix.max_output_tokens;
  else {
    delete prefix.max_tokens;
    delete prefix.max_completion_tokens;
  }
  return { prefix, ttlMs: ttl, ...(replay ? { payload: replay } : {}) };
}

import type { ToolDefinition } from "./protocol.ts";
import type { Outbound } from "./outbound.ts";
import { scheduleInput, type Scheduler } from "./scheduler.ts";
import type { Claim } from "./ownership.ts";
import { FRESHNESS, SEARCH, type WebSearch } from "./web-search.ts";
import { readableText } from "./html-text.ts";

export { readableText };

/**
 * Built-in tools a definition can enable (`builtins`), answered by the runtime:
 * `web_fetch` reads a public page through the outbound guard, `web_search` asks a
 * web search API (see web-search.ts), and `schedule` lets an agent set, list and
 * cancel its own wake-ups in the shared scheduler.
 */
export const BUILTINS = {
  web_fetch: ["web_fetch"],
  web_search: ["web_search"],
  schedule: ["schedule", "list_schedules", "cancel_schedule"],
} as const;
export type Builtin = keyof typeof BUILTINS;
export const builtinNames = (builtins: string[] = []) => builtins.flatMap(builtin => (BUILTINS as Record<string, readonly string[]>)[builtin] ?? []);

const FETCH = { timeoutMs: 20_000, maxBytes: 5 * 1024 * 1024, maxRedirects: 5, characters: 20_000, maxCharacters: 100_000, htmlBytes: 2 * 1024 * 1024 };

const DEFINITIONS: Record<string, ToolDefinition> = {
  web_fetch: {
    name: "web_fetch", exposure: "both",
    description: `Fetch a public web page or file over HTTPS and return its readable text (HTML is reduced to text). Up to ${FETCH.characters} characters by default; pass maxCharacters (at most ${FETCH.maxCharacters}) for more. Private and internal addresses cannot be reached.`,
    parameters: { type: "object", additionalProperties: false, required: ["url"], properties: {
      url: { type: "string", description: "An https:// URL" },
      maxCharacters: { type: "integer", minimum: 100, maximum: FETCH.maxCharacters },
    } },
  },
  web_search: {
    name: "web_search", exposure: "both",
    description: `Search the web. Returns up to ${SEARCH.count} results by default (count: at most ${SEARCH.maxCount}), each with title, url, a short snippet and, when known, the page's date. Snippets are brief: to answer from a page, read it with web_fetch.`,
    parameters: { type: "object", additionalProperties: false, required: ["query"], properties: {
      query: { type: "string", minLength: 1, maxLength: SEARCH.query, description: "What to search for, as you would type it into a search engine" },
      count: { type: "integer", minimum: 1, maximum: SEARCH.maxCount },
      freshness: { type: "string", enum: [...FRESHNESS], description: "Only pages from the past day, week, month or year" },
    } },
  },
  schedule: {
    name: "schedule", exposure: "both",
    description: "Schedule a wake-up for yourself: at the time given, you receive `text` as a new message and can act on it. Give inSeconds or at (an ISO time); everySeconds (at least 60) repeats it. Returns its id.",
    parameters: { type: "object", additionalProperties: false, required: ["text"], properties: {
      text: { type: "string", minLength: 1, maxLength: 32_000, description: "The message you will receive" },
      inSeconds: { type: "number", minimum: 0 }, at: { type: "string", description: "ISO 8601 time" }, everySeconds: { type: "integer", minimum: 60 },
    } },
  },
  list_schedules: {
    name: "list_schedules", exposure: "both", description: "List your scheduled wake-ups.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
  },
  cancel_schedule: {
    name: "cancel_schedule", exposure: "both", description: "Cancel one of your scheduled wake-ups by id.",
    parameters: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
  },
};

/** The built-ins' tools; with web_fetch not enabled, web_search does not point the model at it. */
export const builtinDefinitions = (builtins: string[] = []) => builtinNames(builtins).map(name => name === "web_search" && !builtins.includes("web_fetch")
  ? { ...DEFINITIONS[name], description: DEFINITIONS[name].description.replace(" Snippets are brief: to answer from a page, read it with web_fetch.", " Snippets are brief summaries of each page.") }
  : DEFINITIONS[name]);

export type BuiltinContext = { tenant: string; agent: string; claim?: Claim };

export async function runBuiltin(services: { outbound: Outbound; scheduler?: Scheduler; search?: WebSearch }, context: BuiltinContext, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  if (name === "web_fetch") return webFetch(services.outbound, String(args.url), (args.maxCharacters as number | undefined) ?? FETCH.characters, signal);
  if (name === "web_search") {
    if (!services.search) throw new Error("Web search is not enabled on this runtime");
    return services.search.search(context, args, signal);
  }
  const scheduler = services.scheduler;
  if (!scheduler) throw new Error("Schedules are not enabled on this runtime");
  if (name === "schedule") {
    const input = scheduleInput({ text: args.text, ...(args.at !== undefined ? { at: args.at } : {}), ...(args.inSeconds !== undefined ? { inSeconds: args.inSeconds } : {}), ...(args.everySeconds !== undefined ? { everySeconds: args.everySeconds } : {}) });
    // Under the agent's claim: a node that lost the agent mid-turn schedules nothing for it.
    const created = await scheduler.create({ agent: context.agent, tenant: context.tenant, ...input }, context.claim);
    return view(created);
  }
  if (name === "list_schedules") return { schedules: (await scheduler.list(context.agent)).map(view) };
  if (name === "cancel_schedule") return { cancelled: await scheduler.remove(context.agent, String(args.id), context.claim) };
  throw new Error(`Unknown tool ${name}`);
}

const view = (schedule: { id: string; text?: string; code?: string; dueAt: number; everySeconds?: number }) => ({
  id: schedule.id, ...(schedule.text !== undefined ? { text: schedule.text } : { code: schedule.code }), dueAt: new Date(schedule.dueAt).toISOString(),
  ...(schedule.everySeconds ? { everySeconds: schedule.everySeconds } : {}),
});

async function webFetch(outbound: Outbound, url: string, maxCharacters: number, signal: AbortSignal) {
  // An http:// link is tried over https unless the operator allows plain http.
  if (/^http:\/\//i.test(url) && !outbound.allowHttp) url = `https://${url.slice(7)}`;
  const response = await outbound.fetch(url, {
    signal, timeoutMs: FETCH.timeoutMs, maxBytes: FETCH.maxBytes, maxRedirects: FETCH.maxRedirects,
    headers: { Accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.5", "User-Agent": "agent-runtime web_fetch" },
  });
  const type = response.headers.get("content-type") ?? "";
  if (type && !/^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|javascript))|\+json|\+xml/i.test(type)) {
    await response.body?.cancel();
    throw new Error(`${response.url || url} is ${type.split(";")[0]}, not text`);
  }
  const charset = /charset=([^;\s]+)/i.exec(type)?.[1];
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset ?? "utf-8"); } catch { decoder = new TextDecoder("utf-8"); }
  const raw = decoder.decode(await response.arrayBuffer());
  const page = /html/i.test(type) || (!type && /^\s*<(!doctype html|html)/i.test(raw)) ? readableText(raw.slice(0, FETCH.htmlBytes)) : { text: raw };
  const text = page.text.length > maxCharacters ? page.text.slice(0, maxCharacters) : page.text;
  return { url: response.url || url, status: response.status, contentType: type.split(";")[0] || undefined, ...(page.title ? { title: page.title } : {}), text, ...(text.length < page.text.length ? { truncated: true, totalCharacters: page.text.length } : {}) };
}

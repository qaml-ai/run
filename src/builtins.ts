import type { ToolDefinition } from "./protocol.ts";
import type { Outbound } from "./outbound.ts";
import { scheduleInput, type Scheduler } from "./scheduler.ts";
import type { Claim } from "./ownership.ts";

/**
 * Built-in tools a definition can enable (`builtins`), answered by the runtime:
 * `web_fetch` reads a public page through the outbound guard, and `schedule`
 * lets an agent set, list and cancel its own wake-ups in the shared scheduler.
 */
export const BUILTINS = {
  web_fetch: ["web_fetch"],
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

export const builtinDefinitions = (builtins: string[] = []) => builtinNames(builtins).map(name => DEFINITIONS[name]);

export type BuiltinContext = { tenant: string; agent: string; claim?: Claim };

export async function runBuiltin(services: { outbound: Outbound; scheduler?: Scheduler }, context: BuiltinContext, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  if (name === "web_fetch") return webFetch(services.outbound, String(args.url), (args.maxCharacters as number | undefined) ?? FETCH.characters, signal);
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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•" };
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
  if (code[0] === "#") {
    const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  }
  return ENTITIES[code.toLowerCase()] ?? entity;
});

/** The text a reader sees on an HTML page: no scripts, styles or markup, with block breaks kept. */
export function readableText(html: string): { title?: string; text: string } {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|head|iframe|canvas|object)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?(p|div|section|article|header|footer|main|nav|aside|h[1-6]|ul|ol|table|tr|blockquote|pre|form|figure|figcaption|dl|dt|dd)\b[^>]*>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "");
  const lines = decode(text).split("\n").map(line => line.replace(/[ \t\f\v ]+/g, " ").trim());
  return { ...(title ? { title: decode(title).replace(/\s+/g, " ").trim() } : {}), text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

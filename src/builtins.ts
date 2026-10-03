import type { ToolDefinition } from "./protocol.ts";
import type { Outbound } from "./outbound.ts";
import { scheduleInput, type Scheduler } from "./scheduler.ts";
import type { Claim } from "./ownership.ts";
import { FRESHNESS, SEARCH, webSearchUnavailable, type WebSearch } from "./web-search.ts";
import { isShell, type WebRender } from "./web-render.ts";
import { readableText } from "./html-text.ts";
import type { McpResult } from "./mcp-results.ts";
import { jsonResult } from "./tool-servers.ts";
import { readCapped, type ToolFiles } from "./tool-files.ts";
import { HttpError } from "./http.ts";
import { textual } from "./files.ts";
import { TOOL_FILE_LIMITS } from "./limits.ts";
import { questionsInput } from "./inputs.ts";

export { readableText };

/**
 * Built-in tools a definition can enable (`builtins`), answered by the runtime:
 * `web_fetch` reads a public page through the outbound guard (rendering a page that is
 * only a JavaScript shell through Firecrawl, see web-render.ts) and saves any other file it
 * fetches (a PDF, an image) to the agent's workspace (tool-files.ts), `web_search` asks web
 * search APIs in turn (see web-search.ts), `schedule` lets an agent set, list and
 * cancel its own wake-ups in the shared scheduler, and `ask_user` asks the user questions,
 * suspending the turn until they answer (inputs.ts). `delegate` and `handoff` (multi-agent.ts) are the sessions' own:
 * no tool source answers them here.
 */
export const BUILTINS = {
  web_fetch: ["web_fetch"],
  web_search: ["web_search"],
  schedule: ["schedule", "list_schedules", "cancel_schedule"],
  ask_user: ["ask_user"],
  delegate: [],
  handoff: [],
} as const;
export type Builtin = keyof typeof BUILTINS;
/**
 * Builtins that start runs of their own: on a shared server (the managed Discord bot) any member could
 * have the agent wake itself up, outside the server's per-sender and daily limits.
 */
export const SELF_STARTING_BUILTINS: readonly Builtin[] = ["schedule"];
/** Why a definition with these builtins cannot serve a managed server, or undefined if it can. */
export function managedBuiltinsRefusal(builtins: readonly string[] | undefined) {
  const refused = (builtins ?? []).filter(name => (SELF_STARTING_BUILTINS as readonly string[]).includes(name));
  return refused.length ? `Camel Discord servers cannot use the ${refused.join(", ")} builtin: any member could start runs outside the server's limits. Remove it from the definition, or use a separate one for the server` : undefined;
}
/**
 * What builtins a definition or agent enables cannot do for its tenant, as warnings for its save: web_search
 * without a key (the tenant's, an admin's or the platform's) for any provider it would try, `order` unless
 * the definition pins its own. web_fetch works without its renderer's key, so it is never warned about.
 */
export async function builtinWarnings(sources: { builtins?: readonly string[]; webSearch?: { providers: readonly string[] } } | undefined, order: readonly string[], keyed: () => Promise<(provider: string) => boolean>): Promise<string[]> {
  if (!sources?.builtins?.includes("web_search")) return [];
  const providers = sources.webSearch?.providers ?? order;
  return providers.some(await keyed()) ? [] : [webSearchUnavailable(providers)];
}
/** `builtins` as a definition or an agent gives them: distinct names of BUILTINS. */
export function builtinsInput(value: unknown): Builtin[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(name => typeof name !== "string" || !Object.hasOwn(BUILTINS, name))) {
    throw new HttpError(400, `builtins is a list of: ${Object.keys(BUILTINS).join(", ")}`);
  }
  return value as Builtin[];
}
export const builtinNames = (builtins: string[] = []) => builtins.flatMap(builtin => (BUILTINS as Record<string, readonly string[]>)[builtin] ?? []);

const FETCH = { timeoutMs: 20_000, maxBytes: 5 * 1024 * 1024, maxRedirects: 5, characters: 20_000, maxCharacters: 100_000, htmlBytes: 2 * 1024 * 1024 };

const DEFINITIONS: Record<string, ToolDefinition> = {
  web_fetch: {
    name: "web_fetch", exposure: "both",
    description: `Fetch a public web page or file over HTTPS and return its readable text (HTML is reduced to text). Up to ${FETCH.characters} characters by default; pass maxCharacters (at most ${FETCH.maxCharacters}) for more. Any other file (a PDF, an image) is saved to your workspace and its path returned; you are shown images and PDFs. Private and internal addresses cannot be reached.`,
    parameters: { type: "object", additionalProperties: false, required: ["url"], properties: {
      url: { type: "string", description: "An https:// URL" },
      maxCharacters: { type: "integer", minimum: 100, maximum: FETCH.maxCharacters },
    } },
  },
  web_search: {
    name: "web_search", exposure: "both",
    description: `Search the web. Returns up to ${SEARCH.count} results by default (count: at most ${SEARCH.maxCount}), each with title, url, the page's date when known, and either \`content\`: excerpts of the page relevant to the query (up to ${SEARCH.content.toLocaleString("en-US")} characters), or a short \`snippet\`. The excerpts often hold the answer, so you may not need to open the page; when they don't, or a result has only a snippet, read the page with web_fetch.`,
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
  // AskUserQuestion's shape, which models already use well. Direct only: code cannot wait for an answer.
  ask_user: {
    name: "ask_user", exposure: "direct",
    description: "Ask the user 1-4 questions, each with 2-4 options, when you are blocked on a choice only they can make. Your turn pauses until they answer, which may take days; the answers come back as this call's result. Don't ask about what you can find out yourself.",
    parameters: { type: "object", additionalProperties: false, required: ["questions"], properties: {
      questions: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", additionalProperties: false, required: ["question", "header", "options"], properties: {
        question: { type: "string", minLength: 1, maxLength: 1000, description: "The full question, ending with a question mark" },
        header: { type: "string", minLength: 1, maxLength: 12, description: "A short label, like \"Auth method\"" },
        options: { type: "array", minItems: 2, maxItems: 4, items: { type: "object", additionalProperties: false, required: ["label"], properties: {
          label: { type: "string", minLength: 1, maxLength: 200 }, description: { type: "string", maxLength: 1000, description: "What choosing it means" },
        } } },
        multiSelect: { type: "boolean", description: "Let the user choose several options" },
        allowOther: { type: "boolean", description: "Let the user answer in their own words instead" },
      } } },
    } },
  },
  cancel_schedule: {
    name: "cancel_schedule", exposure: "both", description: "Cancel one of your scheduled wake-ups by id.",
    parameters: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
  },
};

/** The built-ins' tools; with web_fetch not enabled, web_search does not point the model at it. */
export const builtinDefinitions = (builtins: string[] = []) => builtinNames(builtins).map(name => name === "web_search" && !builtins.includes("web_fetch")
  ? { ...DEFINITIONS[name], description: DEFINITIONS[name].description.replace(" The excerpts often hold the answer, so you may not need to open the page; when they don't, or a result has only a snippet, read the page with web_fetch.", " Answer from the excerpts and snippets: pages cannot be opened.") }
  : DEFINITIONS[name]);

/** `searchProviders`: the order the agent's definition gives web_search, instead of the runtime's; `files`, where web_fetch saves files. */
export type BuiltinContext = { tenant: string; agent: string; claim?: Claim; searchProviders?: string[]; files?: ToolFiles };
export type BuiltinServices = { outbound: Outbound; scheduler?: Scheduler; search?: WebSearch; render?: WebRender };

export async function runBuiltin(services: BuiltinServices, context: BuiltinContext, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpResult> {
  if (name === "web_fetch") return webFetch(services, context, String(args.url), (args.maxCharacters as number | undefined) ?? FETCH.characters, signal);
  // The questions go to the user as an input; the answers become this call's result.
  if (name === "ask_user") return { resultType: "input_required", inputRequests: { questions: { method: "agent-runtime/question", params: { questions: questionsInput(args.questions) } } } };
  return jsonResult(await builtinValue(services, context, name, args, signal));
}

async function builtinValue(services: BuiltinServices, context: BuiltinContext, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  if (name === "web_search") {
    if (!services.search) throw new Error("Web search is not enabled on this runtime");
    return services.search.search({ tenant: context.tenant, agent: context.agent, ...(context.searchProviders ? { providers: context.searchProviders } : {}) }, args, signal);
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

async function webFetch({ outbound, render }: BuiltinServices, context: BuiltinContext, url: string, maxCharacters: number, signal: AbortSignal): Promise<McpResult> {
  // An http:// link is tried over https unless the operator allows plain http.
  if (/^http:\/\//i.test(url) && !outbound.allowHttp) url = `https://${url.slice(7)}`;
  const response = await outbound.fetch(url, {
    // Text is capped lower as it is read.
    signal, timeoutMs: FETCH.timeoutMs, maxBytes: TOOL_FILE_LIMITS.responseBytes, maxRedirects: FETCH.maxRedirects,
    headers: { Accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.5", "User-Agent": "agent-runtime web_fetch" },
  });
  const type = response.headers.get("content-type") ?? "";
  if (type && !textual(type)) {
    const finalUrl = response.url || url;
    if (!context.files || !response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`${finalUrl} is ${type.split(";")[0]}, not text${response.ok ? ", and this agent has no workspace to save it to" : ` (HTTP ${response.status})`}`);
    }
    let name = "download";
    try { name = decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() || name); } catch { /* the default name */ }
    const saved = await context.files.save(name, response.body as unknown as AsyncIterable<Uint8Array>, type).catch(async error => {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${finalUrl} is ${type.split(";")[0]}, and it was not saved: ${(error as Error).message}`);
    });
    const value = { url: finalUrl, status: response.status, contentType: saved.contentType, path: saved.path, size: saved.size };
    return { content: [{ type: "text", text: JSON.stringify(value) }, saved], structuredContent: value };
  }
  const charset = /charset=([^;\s]+)/i.exec(type)?.[1];
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset ?? "utf-8"); } catch { decoder = new TextDecoder("utf-8"); }
  const raw = decoder.decode(await readCapped(response, FETCH.maxBytes));
  const html = /html/i.test(type) || (!type && /^\s*<(!doctype html|html)/i.test(raw));
  const page = html ? readableText(raw.slice(0, FETCH.htmlBytes)) : { text: raw };
  const finalUrl = response.url || url;
  // A page whose content a script draws reads as next to nothing: have Firecrawl render it, if a key for it resolves.
  if (html && response.ok && render && isShell(raw, page.text)) {
    const rendered = await render.render(context, finalUrl, signal);
    if (rendered) {
      const text = rendered.markdown.length > maxCharacters ? rendered.markdown.slice(0, maxCharacters) : rendered.markdown;
      const title = rendered.title ?? page.title;
      return jsonResult({ url: finalUrl, status: response.status, contentType: "text/markdown", ...(title ? { title } : {}), text, rendered: true, ...(text.length < rendered.markdown.length ? { truncated: true, totalCharacters: rendered.markdown.length } : {}) });
    }
  }
  const text = page.text.length > maxCharacters ? page.text.slice(0, maxCharacters) : page.text;
  return jsonResult({ url: finalUrl, status: response.status, contentType: type.split(";")[0] || undefined, ...(page.title ? { title: page.title } : {}), text, ...(text.length < page.text.length ? { truncated: true, totalCharacters: page.text.length } : {}) });
}

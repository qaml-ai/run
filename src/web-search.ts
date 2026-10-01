import type { Outbound } from "./outbound.ts";
import type { UsageRecord } from "./client-sessions.ts";
import { MICROS } from "./pricing.ts";
import { readableText } from "./html-text.ts";

/**
 * The `web_search` built-in: a query to a web search API, answered with a few results
 * (title, url, snippet, date) for the model to read further with web_fetch. Each API sits
 * behind `SearchProvider`; a search tries them in order (Exa, Brave, Parallel by default;
 * see bench/search/REPORT.md for why), each with the tenant's key for it, falling through
 * to the next when one is down, slow or out of quota. A key is a provider key like a
 * model's (the tenant's own, else an admin's, else the platform's, which a prepaid tenant
 * pays for at that provider's price per search). `content` is the page's text when the API
 * returns it with the results (Exa's highlights, Parallel's excerpts, Firecrawl's scraped
 * markdown): the model gets it in place of the snippet, within SEARCH.content per result and
 * SEARCH.contentTotal per search, as those query-focused excerpts are much of what Exa is chosen for.
 */
export type SearchResult = { title: string; url: string; snippet: string; date?: string; content?: string };
export type SearchQuery = { query: string; count: number; freshness?: Freshness };
export const FRESHNESS = ["day", "week", "month", "year"] as const;
export type Freshness = typeof FRESHNESS[number];

export interface SearchProvider {
  /** The provider key it uses: PUT /v1/providers/<id>/key, or `platformKeys.<id>` in the tenants file. */
  id: string;
  /** The request for a query (a GET unless it has a body, which is POSTed); `secrets` are headers sent to the API's origin only. */
  request(query: SearchQuery, key: string): SearchRequest;
  /** The results in the API's answer, best first. */
  results(body: unknown): SearchResult[];
}

export type SearchRequest = { url: string; body?: string; headers: Record<string, string>; secrets: Record<string, string> };

/**
 * `timeoutMs` is each provider's: a slower one is given up on for the next. `content` is the excerpt
 * asked for and returned per result, `contentTotal` all of a search's excerpts together: in the benchmark
 * (bench/search/REPORT.md), Exa's results graded as well at 1,000 characters each as at 1,500, and better
 * than at 300.
 */
export const SEARCH = { count: 5, maxCount: 10, timeoutMs: 5_000, maxBytes: 2 * 1024 * 1024, snippet: 500, content: 1_000, contentTotal: 6_000, title: 300, query: 400 };
/** Below this much of the search's excerpt budget left, a result gets its snippet instead of a cut-short excerpt. */
const MIN_EXCERPT = 200;

/** A result as the model gets it: its excerpt or its snippet. */
export type SearchHit = Omit<SearchResult, "snippet" | "content"> & ({ snippet: string } | { content: string });

/**
 * Results as the model gets them: each result's excerpt (`content`) in place of its snippet while the
 * search's budget lasts, else its snippet; results without an excerpt keep their snippet.
 */
export function withinBudget(results: SearchResult[], perResult = SEARCH.content, total = SEARCH.contentTotal): SearchHit[] {
  let left = total;
  return results.map(({ content, snippet, ...result }) => {
    const take = Math.min(perResult, left);
    if (!content || take < MIN_EXCERPT) return { ...result, snippet };
    const excerpt = content.slice(0, take);
    left -= excerpt.length;
    return { ...result, content: excerpt };
  });
}
/** Search providers, by the provider key they use, in the order `web_search` tries them unless the operator or a definition picks another. */
export const SEARCH_PROVIDERS = ["exa", "brave", "parallel"] as const;
export type SearchProviderId = typeof SEARCH_PROVIDERS[number];

/** Markdown links and images reduced to their text: a snippet's link targets are noise to the model. */
const unlink = (value: string) => value.replace(/!?\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "$1");
const text = (value: unknown, max: number) => typeof value === "string" ? readableText(`<p>${unlink(value)}</p>`).text.replace(/\s+/g, " ").slice(0, max) : "";
/** Page text an API returned (markdown or plain), its line breaks kept and its links reduced to their text. */
const pageText = (value: unknown, max = SEARCH.content) => typeof value === "string" ? unlink(value).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max) : "";
/** A date as YYYY-MM-DD, if it parses. */
const day = (value: unknown) => typeof value === "string" && value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString().slice(0, 10) : undefined;
const PERIOD_DAYS = { day: 1, week: 7, month: 31, year: 366 } satisfies Record<Freshness, number>;
/** The start of a freshness window, as an ISO time. */
const since = (freshness: Freshness, now = Date.now()) => new Date(now - PERIOD_DAYS[freshness] * 86_400_000).toISOString();
const json = (body: unknown) => ({ body: JSON.stringify(body), headers: { Accept: "application/json", "Content-Type": "application/json" } });

/**
 * Brave Search's web search API: its own index of the web, a plain GET with the key in a header,
 * snippets and page dates in the answer, and a low price per query.
 */
export function braveSearch(endpoint = "https://api.search.brave.com/res/v1/web/search"): SearchProvider {
  const since = { day: "pd", week: "pw", month: "pm", year: "py" } satisfies Record<Freshness, string>;
  return {
    id: "brave",
    request({ query, count, freshness }, key) {
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));
      url.searchParams.set("text_decorations", "false");
      if (freshness) url.searchParams.set("freshness", since[freshness]);
      return { url: url.toString(), headers: { Accept: "application/json" }, secrets: { "X-Subscription-Token": key } };
    },
    results(body) {
      const results = (body as { web?: { results?: unknown } } | undefined)?.web?.results;
      if (!Array.isArray(results)) return [];
      return results.map((result: Record<string, unknown>) => {
        const date = typeof result.page_age === "string" && !Number.isNaN(Date.parse(result.page_age)) ? new Date(result.page_age).toISOString().slice(0, 10) : typeof result.age === "string" ? result.age : undefined;
        return { title: text(result.title, SEARCH.title), url: typeof result.url === "string" ? result.url : "", snippet: text(result.description, SEARCH.snippet), ...(date ? { date } : {}) };
      });
    },
  };
}

/**
 * Exa's search API: its own neural index, answered with query-relevant highlights of each page
 * and its published date. `type` trades latency for quality: `instant` and `fast` answer in well
 * under a second, `auto` (Exa's default) blends its retrievers; each is one price per request.
 */
export function exaSearch(options: { endpoint?: string; type?: "auto" | "fast" | "instant" } = {}): SearchProvider {
  const { endpoint = "https://api.exa.ai/search", type = "auto" } = options;
  return {
    id: "exa",
    request({ query, count, freshness }, key) {
      return { url: endpoint, ...json({
        query, type, numResults: count,
        contents: { highlights: { maxCharacters: SEARCH.content } },
        ...(freshness ? { startPublishedDate: since(freshness) } : {}),
      }), secrets: { "x-api-key": key } };
    },
    results(body) {
      const results = (body as { results?: unknown } | undefined)?.results;
      if (!Array.isArray(results)) return [];
      return results.map((result: Record<string, unknown>): SearchResult => {
        const highlights = Array.isArray(result.highlights) ? result.highlights.filter((part): part is string => typeof part === "string") : [];
        const content = pageText(highlights.length ? highlights.join("\n…\n") : result.text);
        const date = day(result.publishedDate);
        return { title: text(result.title, SEARCH.title), url: typeof result.url === "string" ? result.url : "", snippet: text(content, SEARCH.snippet), ...(date ? { date } : {}), ...(content ? { content } : {}) };
      });
    },
  };
}

/**
 * Parallel's search API: built for agents, it answers an objective with the pages' most relevant
 * excerpts, compressed to a character budget. `mode` trades latency for quality: `advanced` (its
 * default, a few seconds), `basic`, `fast` (about a second) and `turbo`; the fast two cost less.
 */
export function parallelSearch(options: { endpoint?: string; mode?: "advanced" | "basic" | "fast" | "turbo" } = {}): SearchProvider {
  const { endpoint = "https://api.parallel.ai/v1/search", mode = "advanced" } = options;
  return {
    id: "parallel",
    request({ query, count, freshness }, key) {
      return { url: endpoint, ...json({
        objective: query, search_queries: [query], mode, max_chars_total: count * SEARCH.content,
        advanced_settings: {
          max_results: count, excerpt_settings: { max_chars_per_result: SEARCH.content },
          ...(freshness ? { source_policy: { after_date: since(freshness).slice(0, 10) } } : {}),
        },
      }), secrets: { "x-api-key": key } };
    },
    results(body) {
      const results = (body as { results?: unknown } | undefined)?.results;
      if (!Array.isArray(results)) return [];
      return results.map((result: Record<string, unknown>): SearchResult => {
        const excerpts = Array.isArray(result.excerpts) ? result.excerpts.filter((part): part is string => typeof part === "string") : [];
        const content = pageText(excerpts.join("\n…\n"));
        const date = day(result.publish_date);
        return { title: text(result.title, SEARCH.title), url: typeof result.url === "string" ? result.url : "", snippet: text(content, SEARCH.snippet), ...(date ? { date } : {}), ...(content ? { content } : {}) };
      });
    },
  };
}

/**
 * Firecrawl's search API: web results with query-relevant highlights as their descriptions.
 * With `scrape`, each result's page is also scraped and returned as markdown (one more
 * credit per page, and the page's published date when its metadata has one).
 */
export function firecrawlSearch(options: { endpoint?: string; scrape?: boolean } = {}): SearchProvider {
  const { endpoint = "https://api.firecrawl.dev/v2/search", scrape = false } = options;
  const since = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" } satisfies Record<Freshness, string>;
  return {
    id: "firecrawl",
    request({ query, count, freshness }, key) {
      return { url: endpoint, ...json({
        query, limit: count, sources: ["web"], timeout: SEARCH.timeoutMs,
        ...(freshness ? { tbs: since[freshness] } : {}),
        ...(scrape ? { scrapeOptions: { formats: ["markdown"], onlyMainContent: true } } : {}),
      }), secrets: { Authorization: `Bearer ${key}` } };
    },
    results(body) {
      const results = (body as { data?: { web?: unknown } } | undefined)?.data?.web;
      if (!Array.isArray(results)) return [];
      return results.map((result: Record<string, unknown>): SearchResult => {
        const metadata = (result.metadata ?? {}) as Record<string, unknown>;
        const content = pageText(result.markdown);
        const date = day(result.date) ?? day(metadata.publishedTime) ?? day(metadata["article:published_time"]);
        return { title: text(result.title ?? metadata.title, SEARCH.title), url: typeof result.url === "string" ? result.url : "", snippet: text(result.description, SEARCH.snippet), ...(date ? { date } : {}), ...(content ? { content } : {}) };
      });
    },
  };
}

/**
 * The search providers, by id, at their endpoints (AGENT_EXA_SEARCH_URL, AGENT_BRAVE_SEARCH_URL,
 * AGENT_PARALLEL_SEARCH_URL, for tests), and the order searches try them in: AGENT_WEB_SEARCH_PROVIDERS,
 * comma-separated (default exa,brave,parallel). Exa answers in its fast `instant` mode and Parallel in `fast`.
 */
export function searchProvidersFromEnvironment(env = process.env): { providers: Record<SearchProviderId, SearchProvider>; order: SearchProviderId[] } {
  const providers: Record<SearchProviderId, SearchProvider> = {
    exa: exaSearch({ type: "instant", ...(env.AGENT_EXA_SEARCH_URL ? { endpoint: env.AGENT_EXA_SEARCH_URL } : {}) }),
    brave: braveSearch(env.AGENT_BRAVE_SEARCH_URL),
    parallel: parallelSearch({ mode: "fast", ...(env.AGENT_PARALLEL_SEARCH_URL ? { endpoint: env.AGENT_PARALLEL_SEARCH_URL } : {}) }),
  };
  const order = searchOrder((env.AGENT_WEB_SEARCH_PROVIDERS ?? SEARCH_PROVIDERS.join(",")).split(",").map(id => id.trim()).filter(Boolean), "AGENT_WEB_SEARCH_PROVIDERS");
  return { providers, order };
}

const SEARCH_NAMES: Record<string, string> = { exa: "Exa", brave: "Brave", parallel: "Parallel" };

/** Why web_search cannot search for a tenant without a key for any of `providers`, and how to give it one: the console's way, then the API's. */
export function webSearchUnavailable(providers: readonly string[]) {
  const names = providers.map(id => SEARCH_NAMES[id] ?? id);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0];
  const put = providers.length === 1 ? `PUT /v1/providers/${providers[0]}/key` : "PUT /v1/providers/<provider>/key";
  return `Web search isn't available for this account: add ${/^[aeiou]/i.test(list) ? "an" : "a"} ${list} key under Models & keys (${put})`;
}

/** A list of search provider ids, checked: known ones, each once, at least one. */
export function searchOrder(ids: unknown, name: string): SearchProviderId[] {
  const known = (id: unknown): id is SearchProviderId => SEARCH_PROVIDERS.includes(id as SearchProviderId);
  if (!Array.isArray(ids) || !ids.length || ids.length > SEARCH_PROVIDERS.length || !ids.every(known) || new Set(ids).size !== ids.length) {
    throw new Error(`${name} must list one or more of ${SEARCH_PROVIDERS.join(", ")}, each once`);
  }
  return ids;
}

export interface WebSearchOptions {
  outbound: Outbound;
  providers: Record<SearchProviderId, SearchProvider>;
  /** The order a search tries providers in, unless the agent's definition gives its own. */
  order: SearchProviderId[];
  /** The key a tenant's searches with `provider` use, and whether it is the platform's rather than the tenant's own. */
  key(tenant: string, provider: string): Promise<{ key: string; platform: boolean } | undefined>;
  /** Micro-USD per search with `provider`, reported as the search's cost. */
  price(provider: SearchProviderId): number;
  /** Called with each completed search's usage: its cost is charged to credit when it ran on the platform's key. */
  onSearch?(tenant: string, agent: string, usage: UsageRecord): void;
  /** Each provider's deadline (default SEARCH.timeoutMs). */
  timeoutMs?: number;
}

/** Why a provider did not answer, and whether the next one should be tried. */
class Attempt extends Error {
  readonly next: boolean;
  constructor(message: string, next: boolean) { super(message); this.next = next; }
}

export class WebSearch {
  readonly options: WebSearchOptions;
  constructor(options: WebSearchOptions) { this.options = options; }

  /**
   * Search with the first provider in order that has a key and answers. A timeout, a network error,
   * a 429 or 5xx, a key the provider refuses (401, 402, 403) or an answer that is not JSON moves on to
   * the next; any other 4xx is the request's fault, which another provider would not fix, and ends the search.
   */
  async search(context: { tenant: string; agent: string; providers?: string[] }, args: Record<string, unknown>, signal: AbortSignal) {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) throw new Error("web_search needs a query");
    const count = Math.min(SEARCH.maxCount, Math.max(1, Math.trunc(Number(args.count ?? SEARCH.count)) || SEARCH.count));
    const freshness = FRESHNESS.find(value => value === args.freshness);
    const order = context.providers ? searchOrder(context.providers, "webSearch.providers") : this.options.order;
    const failures: string[] = [];
    const unkeyed: string[] = [];
    for (const id of order) {
      const key = await this.options.key(context.tenant, id);
      if (!key) { unkeyed.push(id); continue; }
      try {
        const results = await this.attempt(this.options.providers[id], { query: query.slice(0, SEARCH.query), count, ...(freshness ? { freshness } : {}) }, key.key, signal);
        // Only a search the API answered is charged, at its provider's price; its links are the web's, fetched (if at all) through web_fetch's guard.
        this.options.onSearch?.(context.tenant, context.agent, { provider: id, model: "web_search", usage: { cost: { total: this.options.price(id) / MICROS } }, platform: key.platform, searches: 1 });
        if (failures.length) console.error(JSON.stringify({ type: "web_search_fallback", tenant: context.tenant, agent: context.agent, answered: id, failed: failures }));
        return { query, provider: id, results: withinBudget(results.slice(0, count)) };
      } catch (error) {
        if (signal.aborted) throw error;
        if (!(error instanceof Attempt)) throw error;
        failures.push(error.message);
        if (!error.next) break;
      }
    }
    if (failures.length) throw new Error(`Web search failed: ${failures.join("; ")}`);
    throw new Error(webSearchUnavailable(unkeyed));
  }

  private async attempt(provider: SearchProvider, query: SearchQuery, key: string, signal: AbortSignal): Promise<SearchResult[]> {
    const timeoutMs = this.options.timeoutMs ?? SEARCH.timeoutMs;
    const { url, body: request, headers, secrets } = provider.request(query, key);
    let response: Response;
    try {
      response = await this.options.outbound.fetch(url, { signal, headers, secrets, ...(request !== undefined ? { method: "POST", body: request } : {}), timeoutMs, maxBytes: SEARCH.maxBytes });
    } catch (error) {
      if (signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Attempt(/No response within/.test(message) ? `${provider.id} did not answer within ${timeoutMs} ms` : `${provider.id} could not be reached (${message.slice(0, 200)})`, true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status;
      if (status === 401 || status === 403) throw new Attempt(`${provider.id} rejected the search API key (HTTP ${status})`, true);
      if (status === 402) throw new Attempt(`${provider.id} refused the search for payment (HTTP 402)`, true);
      if (status === 429) throw new Attempt(`${provider.id} is rate limiting searches (HTTP 429)`, true);
      if (status === 408 || status >= 500) throw new Attempt(`${provider.id} search failed (HTTP ${status})`, true);
      throw new Attempt(`${provider.id} refused the search request (HTTP ${status})`, false);
    }
    let body: unknown;
    try { body = await response.json(); } catch (error) {
      if (signal.aborted) throw error;
      throw new Attempt(`${provider.id} answered with something other than JSON`, true);
    }
    return provider.results(body).filter(result => /^https?:\/\//i.test(result.url));
  }
}

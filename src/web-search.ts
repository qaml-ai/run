import type { Outbound } from "./outbound.ts";
import type { UsageRecord } from "./client-sessions.ts";
import { MICROS } from "./pricing.ts";
import { readableText } from "./html-text.ts";

/**
 * The `web_search` built-in: a query to a web search API, answered with a few results
 * (title, url, snippet, date) for the model to read further with web_fetch. The API sits
 * behind `SearchProvider`, so another can be added; its key is a provider key like a
 * model's (the tenant's own, else for a prepaid tenant the platform's, billed per search).
 * `content` is the page's text when the API returns it with the results (Exa's highlights,
 * Parallel's excerpts, Firecrawl's scraped markdown), so the model may not need web_fetch.
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

export const SEARCH = { count: 5, maxCount: 10, timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024, snippet: 500, content: 3_000, title: 300, query: 400 };
/** Search providers, by the provider key they use; the first is the one `web_search` uses unless the operator picks another. */
export const SEARCH_PROVIDERS = ["brave"] as const;

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

/** The search provider named by AGENT_WEB_SEARCH_PROVIDER (default brave), at its endpoint (AGENT_BRAVE_SEARCH_URL). */
export function searchProviderFromEnvironment(env = process.env): SearchProvider {
  const id = env.AGENT_WEB_SEARCH_PROVIDER ?? "brave";
  if (id === "brave") return braveSearch(env.AGENT_BRAVE_SEARCH_URL);
  throw new Error(`AGENT_WEB_SEARCH_PROVIDER must be one of: ${SEARCH_PROVIDERS.join(", ")}`);
}

export interface WebSearchOptions {
  outbound: Outbound;
  provider: SearchProvider;
  /** The key a tenant's searches use, and whether it is the platform's rather than the tenant's own. */
  key(tenant: string, provider: string): Promise<{ key: string; platform: boolean } | undefined>;
  /** Micro-USD per search, reported as the search's cost. */
  price: number;
  /** Called with each completed search's usage: its cost is charged to credit when it ran on the platform's key. */
  onSearch?(tenant: string, agent: string, usage: UsageRecord): void;
}

export class WebSearch {
  readonly options: WebSearchOptions;
  constructor(options: WebSearchOptions) { this.options = options; }
  get provider() { return this.options.provider.id; }

  async search(context: { tenant: string; agent: string }, args: Record<string, unknown>, signal: AbortSignal) {
    const { outbound, provider } = this.options;
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) throw new Error("web_search needs a query");
    const count = Math.min(SEARCH.maxCount, Math.max(1, Math.trunc(Number(args.count ?? SEARCH.count)) || SEARCH.count));
    const freshness = FRESHNESS.find(value => value === args.freshness);
    const key = await this.options.key(context.tenant, provider.id);
    if (!key) throw new Error(`Web search is not set up for this tenant: it needs a ${provider.id} API key (PUT /v1/providers/${provider.id}/key)`);
    const { url, body: request, headers, secrets } = provider.request({ query: query.slice(0, SEARCH.query), count, ...(freshness ? { freshness } : {}) }, key.key);
    const response = await outbound.fetch(url, { signal, headers, secrets, ...(request !== undefined ? { method: "POST", body: request } : {}), timeoutMs: SEARCH.timeoutMs, maxBytes: SEARCH.maxBytes });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new Error(`${provider.id} rejected the search API key (HTTP ${response.status})`);
      if (response.status === 429) throw new Error(`${provider.id} is rate limiting searches (HTTP 429); try again shortly`);
      throw new Error(`${provider.id} search failed (HTTP ${response.status})`);
    }
    const body = await response.json().catch(() => { throw new Error(`${provider.id} answered with something other than JSON`); });
    // Only a search the API answered is charged; its links are the web's, fetched (if at all) through web_fetch's guard.
    this.options.onSearch?.(context.tenant, context.agent, { provider: provider.id, model: "web_search", usage: { cost: { total: this.options.price / MICROS } }, platform: key.platform });
    const results = provider.results(body).filter(result => /^https?:\/\//i.test(result.url)).slice(0, count);
    return { query, results };
  }
}

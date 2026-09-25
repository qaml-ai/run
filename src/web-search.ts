import type { Outbound } from "./outbound.ts";
import type { UsageRecord } from "./client-sessions.ts";
import { MICROS } from "./pricing.ts";
import { readableText } from "./html-text.ts";

/**
 * The `web_search` built-in: a query to a web search API, answered with a few results
 * (title, url, snippet, date) for the model to read further with web_fetch. The API sits
 * behind `SearchProvider`, so another can be added; its key is a provider key like a
 * model's (the tenant's own, else for a prepaid tenant the platform's, billed per search).
 */
export type SearchResult = { title: string; url: string; snippet: string; date?: string };
export type SearchQuery = { query: string; count: number; freshness?: Freshness };
export const FRESHNESS = ["day", "week", "month", "year"] as const;
export type Freshness = typeof FRESHNESS[number];

export interface SearchProvider {
  /** The provider key it uses: PUT /v1/providers/<id>/key, or `platformKeys.<id>` in the tenants file. */
  id: string;
  /** The request for a query; `secrets` are headers sent to the API's origin only. */
  request(query: SearchQuery, key: string): { url: string; headers: Record<string, string>; secrets: Record<string, string> };
  /** The results in the API's answer, best first. */
  results(body: unknown): SearchResult[];
}

export const SEARCH = { count: 5, maxCount: 10, timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024, snippet: 500, title: 300, query: 400 };
/** Search providers, by the provider key they use; the first is the one `web_search` uses unless the operator picks another. */
export const SEARCH_PROVIDERS = ["brave"] as const;

const text = (value: unknown, max: number) => typeof value === "string" ? readableText(`<p>${value}</p>`).text.replace(/\s+/g, " ").slice(0, max) : "";

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
    const { url, headers, secrets } = provider.request({ query: query.slice(0, SEARCH.query), count, ...(freshness ? { freshness } : {}) }, key.key);
    const response = await outbound.fetch(url, { signal, headers, secrets, timeoutMs: SEARCH.timeoutMs, maxBytes: SEARCH.maxBytes });
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

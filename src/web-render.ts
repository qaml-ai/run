import type { Outbound } from "./outbound.ts";
import type { UsageRecord } from "./client-sessions.ts";
import { MICROS } from "./pricing.ts";
import { safeError } from "./metrics.ts";

/**
 * web_fetch's fallback for pages that are only a JavaScript shell: Firecrawl's scrape endpoint
 * loads the page in a browser, runs its scripts and answers its main content as markdown. Its key
 * is the provider key `firecrawl`, resolved like a search provider's; a render on the platform's
 * key is charged at `price` (one credit, with the basic proxy).
 */
export const RENDER = { timeoutMs: 25_000, maxBytes: 5 * 1024 * 1024 };

/**
 * Whether a fetched HTML page is a shell whose content a script draws: a sizeable page with almost
 * no readable text, or little text beside a telltale empty mount point or a "needs JavaScript" notice.
 */
export function isShell(html: string, text: string) {
  const readable = text.replace(/\s+/g, " ").trim().length;
  if (readable < 200 && html.length > 5_000) return true;
  return readable < 1_000 && (/<div\s+id=["'](?:root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(html) || /<noscript\b[^>]*>[^<]*(?:enable|requires?|need)[^<]*javascript/i.test(html));
}

export interface WebRenderOptions {
  outbound: Outbound;
  /** Firecrawl's scrape endpoint (AGENT_FIRECRAWL_SCRAPE_URL overrides it, for tests). */
  endpoint?: string;
  /** The tenant's key for Firecrawl, and whether it is the platform's rather than the tenant's own; it throws when that key may not be used now (spent credit). */
  key(tenant: string, provider: string): Promise<{ key: string; platform: boolean } | undefined>;
  /** Micro-USD per render, reported as its cost. */
  price: number;
  onRender?(tenant: string, agent: string, usage: UsageRecord): void;
}

export class WebRender {
  readonly options: WebRenderOptions;
  constructor(options: WebRenderOptions) { this.options = options; }

  /**
   * The page at `url` rendered as markdown, or undefined when it cannot be: no Firecrawl key, an address
   * the outbound guard refuses, or Firecrawl failing. The URL is checked with the guard first (scheme,
   * and every address its host resolves to), so Firecrawl is never asked for a page the runtime could not fetch.
   */
  async render(context: { tenant: string; agent: string }, url: string, signal: AbortSignal): Promise<{ title?: string; markdown: string } | undefined> {
    const { outbound } = this.options;
    try { await outbound.reachable(url); } catch { return undefined; }
    // A key refused (spent credit) leaves the page unrendered, as having none does.
    const key = await this.options.key(context.tenant, "firecrawl").catch(() => undefined);
    if (!key) return undefined;
    try {
      const response = await outbound.fetch(this.options.endpoint ?? "https://api.firecrawl.dev/v2/scrape", {
        method: "POST", signal, timeoutMs: RENDER.timeoutMs, maxBytes: RENDER.maxBytes,
        headers: { Accept: "application/json", "Content-Type": "application/json" }, secrets: { Authorization: `Bearer ${key.key}` },
        body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, proxy: "basic", timeout: RENDER.timeoutMs - 5_000 }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        console.error(JSON.stringify({ type: "web_render_failed", tenant: context.tenant, agent: context.agent, status: response.status }));
        return undefined;
      }
      const body = await response.json() as { data?: { markdown?: unknown; metadata?: { title?: unknown } } };
      const markdown = typeof body?.data?.markdown === "string" ? body.data.markdown.trim() : "";
      if (!markdown) return undefined;
      this.options.onRender?.(context.tenant, context.agent, { provider: "firecrawl", model: "web_fetch", usage: { cost: { total: this.options.price / MICROS } }, platform: key.platform, renders: 1 });
      const title = body.data?.metadata?.title;
      return { ...(typeof title === "string" && title ? { title } : {}), markdown };
    } catch (error) {
      if (signal.aborted) throw error;
      console.error(JSON.stringify({ type: "web_render_failed", tenant: context.tenant, agent: context.agent, error: safeError(error) }));
      return undefined;
    }
  }
}

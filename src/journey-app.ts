import { Hono, type Context } from "hono";
import type { Journey } from "./core/journey.ts";

/** Pages a browser may report a minute: the console sends one a page, so this is far past a person and well short of a flood. */
export const JOURNEY_PAGES_PER_MINUTE = 120;

/**
 * `POST /api/journey/events`: the console's own pages, from its own origin (`auth` is the console's sign-in: a
 * request a page of ours made, and whose session it carries, if any). Mounted only where journey events are on.
 * Each source (`source`: the caller's address as the rate limits know it) may report JOURNEY_PAGES_PER_MINUTE pages
 * a minute, counted on this node and in memory: past it the answer is 429, and nothing is written.
 */
export function journeyApp(journey: Journey, auth: { allowsMutation(request: Request): boolean; principal(request: Request): Promise<{ tenant: string } | undefined> }, source: (c: Context) => string | undefined = () => undefined, now: () => number = Date.now) {
  const app = new Hono();
  const counts = new Map<string, { pages: number; until: number }>();
  app.post("/api/journey/events", async c => {
    c.header("Cache-Control", "no-store");
    if (!auth.allowsMutation(c.req.raw)) return c.json({ error: "Forbidden" }, 403);
    let body: unknown;
    try { body = JSON.parse(await journey.readText(c.req.raw.body, 32 * 1024)); }
    catch { return c.json({ error: "invalid_json" }, 400); }
    const events = (body as { events?: unknown } | null)?.events;
    const key = source(c) ?? "unknown", at = now();
    if (counts.size > 50_000) for (const [name, count] of counts) if (count.until <= at) counts.delete(name);
    let count = counts.get(key);
    if (!count || count.until <= at) counts.set(key, count = { pages: 0, until: at + 60_000 });
    count.pages += Array.isArray(events) ? Math.max(1, events.length) : 1;
    if (count.pages > JOURNEY_PAGES_PER_MINUTE) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((count.until - at) / 1000))));
      return c.json({ error: "rate_limited" }, 429);
    }
    const result = await journey.pagesViewed(c.req.raw, (await auth.principal(c.req.raw))?.tenant, body);
    return c.json(result.body, result.status);
  });
  return app;
}

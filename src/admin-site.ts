import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { ADMIN_REPORT_PATH, ADMIN_REPORT_REQUEST_BYTES, adminReport, adminReportRequest, boundedText, type AdminReportSource } from "./admin-report.ts";
import { ADMIN_TIME_ZONE, ADMIN_TREND_DAYS, AdminRangeError, adminSignals, adminToday, adminTrend } from "./admin-signals.ts";
import { adminStats } from "./admin-stats.ts";
import type { Db } from "./db.ts";

/**
 * The team's admin site (platform stats), on a hostname of its own behind Cloudflare Access. Cloudflare Access's policy for
 * the application is who may use the site; the runtime verifies every request's Access token (team and AUD): its signature,
 * issuer, audience and expiry, so a request that reaches the load balancer some other way gets nothing. Requests for that
 * hostname are answered here and never reach the rest of the runtime; other hostnames never reach the site.
 *
 * Besides the stats (GET /api/stats, src/admin-stats.ts) it answers sign-ups, first runs and purchases by calendar day
 * (GET /api/product-signals, src/admin-signals.ts), sign-ups and returning active accounts by UTC day for its chart
 * (GET /api/activity-trend) and, where the operator's journey store answers reports, what accounts did on the way
 * to them and how the website's pages about the runtime did (POST /api/report, src/admin-report.ts).
 */
export interface AdminSiteOptions {
  /** The site's hostname, e.g. admin.camelai.dev. */
  host: string;
  /** The Access team's origin, e.g. https://qaml.cloudflareaccess.com: the tokens' issuer, whose /cdn-cgi/access/certs has their keys. */
  team: string;
  /** The Access application's audience (AUD) tag. */
  audience: string;
  db: Db;
  /** The console's build, which holds the site's page (admin.html) and the assets it shares with the console. */
  consoleDir: string;
  /** The keys tokens are checked with; by default the team's, fetched and cached. */
  keys?: JWTVerifyGetKey;
  /** Whether journey events are on (src/journey.ts), which is what records an account's first run. */
  tracking?: boolean;
  /** The journey store's reports; unset, POST /api/report says they are not configured. */
  report?: AdminReportSource;
  /** How the store is reached; by default the global fetch. */
  fetch?: typeof fetch;
}

/** What the server knows that the site's settings rest on: journey events' store and secret, where they are on, and the secret reports are asked with. */
export interface AdminSiteContext extends Pick<AdminSiteOptions, "db" | "consoleDir"> {
  journey?: { url: string; secret: string };
  reportSecret?: string;
}

/**
 * The admin site from AGENT_ADMIN_HOST, AGENT_ADMIN_ACCESS_TEAM and AGENT_ADMIN_ACCESS_AUD: all three, or none for no site.
 * Whoever the Access application's policy admits may use it. The journey store's reports are asked of AGENT_JOURNEY_URL
 * with a secret of their own (AGENT_JOURNEY_REPORT_SECRET, `context.reportSecret`).
 */
export function adminSiteFromEnvironment(env: NodeJS.ProcessEnv, context: AdminSiteContext): AdminSiteOptions | undefined {
  const host = env.AGENT_ADMIN_HOST?.trim().toLowerCase(), team = env.AGENT_ADMIN_ACCESS_TEAM?.trim(), audience = env.AGENT_ADMIN_ACCESS_AUD?.trim();
  const { journey, reportSecret, ...rest } = context;
  if (reportSecret && !journey) throw new Error("AGENT_JOURNEY_REPORT_SECRET is set without AGENT_JOURNEY_URL");
  if (reportSecret && (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(reportSecret) || Buffer.from(reportSecret.slice(6), "base64").length < 16)) throw new Error("AGENT_JOURNEY_REPORT_SECRET (or AGENT_JOURNEY_REPORT_SECRET_ARN) must be a Standard Webhooks secret, whsec_<base64 of 16 bytes or more>");
  // The store refuses a report asked with the key events are signed with: whoever may read reports must not be able to write events.
  if (reportSecret && reportSecret === journey!.secret) throw new Error("AGENT_JOURNEY_REPORT_SECRET must not be AGENT_JOURNEY_SECRET");
  if (!host && !team && !audience) return undefined;
  if (!host || !team || !audience) throw new Error("Set AGENT_ADMIN_HOST, AGENT_ADMIN_ACCESS_TEAM and AGENT_ADMIN_ACCESS_AUD together, or none of them");
  let origin: URL;
  try { origin = new URL(team); } catch { throw new Error("AGENT_ADMIN_ACCESS_TEAM must be the Access team's origin, e.g. https://<team>.cloudflareaccess.com"); }
  // Plain HTTP only on this host, for tests.
  if (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) throw new Error("AGENT_ADMIN_ACCESS_TEAM must be https");
  return {
    host, team: origin.origin, audience, ...rest, tracking: !!journey,
    ...(journey && reportSecret ? { report: { url: new URL(ADMIN_REPORT_PATH, journey.url).toString(), secret: reportSecret } } : {}),
  };
}

const CONTENT_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
};

export function adminSite(options: AdminSiteOptions): MiddlewareHandler {
  const keys = options.keys ?? createRemoteJWKSet(new URL("/cdn-cgi/access/certs", options.team));
  const viewer = async (c: Context) => {
    const token = c.req.header("cf-access-jwt-assertion");
    if (!token) return undefined;
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: options.team, audience: options.audience, algorithms: ["RS256"] });
      return typeof payload.email === "string" ? payload.email : undefined;
    } catch { return undefined; }
  };
  return async (c, next) => {
    // Cloudflare connects to the load balancer with the site's name as Host.
    const host = c.req.header("host")?.split(":")[0].toLowerCase();
    if (host !== options.host) return next();
    const email = await viewer(c);
    if (!email) return c.text("Sign in through Cloudflare Access", 401, { "Cache-Control": "no-store" });
    if (c.req.method === "POST" && c.req.path === "/api/report") return report(c, options, email);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Not found", 404);
    if (c.req.path === "/api/stats") {
      const days = Number(c.req.query("days") ?? 30);
      if (!Number.isInteger(days) || days < 1 || days > 365) return c.json({ error: "days must be a whole number from 1 to 365" }, 400);
      console.log(JSON.stringify({ type: "admin_stats_viewed", viewer: email, days }));
      return c.json({ viewer: email, ...await adminStats(options.db, { days, recent: 50 }) }, 200, { "Cache-Control": "no-store" });
    }
    if (c.req.path === "/api/product-signals") {
      try {
        const zone = c.req.query("time_zone") ?? ADMIN_TIME_ZONE, start = c.req.query("start_date"), end = c.req.query("end_date");
        // No dates: today, in the zone. One without the other is not a range.
        if ((start === undefined) !== (end === undefined)) throw new AdminRangeError(400, "invalid_date");
        const today = start === undefined ? adminToday(zone) : "";
        const signals = await adminSignals(options.db, { range: { start_date: start ?? today, end_date: end ?? today, time_zone: zone }, tracking: !!options.tracking });
        console.log(JSON.stringify({ type: "admin_signals_viewed", viewer: email, ...signals.range }));
        return c.json(signals, 200, { "Cache-Control": "no-store" });
      } catch (error) {
        if (!(error instanceof AdminRangeError)) throw error;
        return c.json({ error: error.message }, error.status, { "Cache-Control": "no-store" });
      }
    }
    if (c.req.path === "/api/activity-trend") {
      try {
        const trend = await adminTrend(options.db, { days: Number(c.req.query("days") ?? ADMIN_TREND_DAYS), end_date: c.req.query("end_date") });
        console.log(JSON.stringify({ type: "admin_trend_viewed", viewer: email, ...trend.range }));
        return c.json(trend, 200, { "Cache-Control": "no-store" });
      } catch (error) {
        if (!(error instanceof AdminRangeError)) throw error;
        return c.json({ error: error.message }, error.status, { "Cache-Control": "no-store" });
      }
    }
    if (c.req.path.startsWith("/api/")) return c.json({ error: "Not found" }, 404);
    return serve(c, options.consoleDir);
  };
}

/** POST /api/report: one of the journey store's reports (src/admin-report.ts), for the site's own page only. */
async function report(c: Context, options: AdminSiteOptions, email: string) {
  const reply = (body: unknown, status: number) => c.json(body as object, status as 200, { "Cache-Control": "no-store" });
  // A browser says where a request was made from: never another site's page, which the viewer's Access session would otherwise answer.
  const origin = c.req.header("origin");
  if (origin !== undefined && URL.parse(origin)?.hostname !== options.host) return reply({ error: "invalid_origin" }, 403);
  if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return reply({ error: "invalid_request" }, 400);
  let request;
  try { request = adminReportRequest(JSON.parse(await boundedText(c.req.raw, ADMIN_REPORT_REQUEST_BYTES))); } catch { /* not a request */ }
  if (!request) return reply({ error: "invalid_request" }, 400);
  const answer = await adminReport(request, options.report, options.fetch);
  if (answer.reason) console.error(JSON.stringify({ type: "admin_report_failed", kind: request.kind, error: answer.reason }));
  else if (answer.status === 200) console.log(JSON.stringify({ type: "admin_report_viewed", viewer: email, kind: request.kind, start_date: request.start_date, end_date: request.end_date, ...(request.account_ref ? { account_ref: request.account_ref } : {}) }));
  return reply(answer.body, answer.status);
}

/** The console build's assets (the page is built with the console, under /console/), else the site's page for any other path. */
async function serve(c: Context, consoleDir: string) {
  const path = c.req.path;
  const relative = path.startsWith("/console/assets/") ? normalize(decodeURIComponent(path.slice("/console/".length))).replace(/^(\.\.(\/|\\|$))+/, "") : "";
  const file = relative ? join(consoleDir, relative) : "";
  let body: Buffer | undefined;
  if (file.startsWith(consoleDir + sep)) {
    try { body = await readFile(file); } catch { /* the page, below */ }
  }
  if (body) return c.body(new Uint8Array(body), 200, { ...HEADERS, "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" });
  try { body = await readFile(join(consoleDir, "admin.html")); }
  catch { return c.text("The admin site is not built on this host", 404); }
  return c.body(new Uint8Array(body), 200, { ...HEADERS, "Content-Type": CONTENT_TYPES[".html"], "Cache-Control": "no-store" });
}

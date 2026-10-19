import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AdminWindowError } from "./admin-accounts.ts";
import { adminAcquisition } from "./admin-acquisition.ts";
import { adminGrowth } from "./admin-growth.ts";
import { adminHealth } from "./admin-health.ts";
import { ADMIN_REPORT_PATH, ADMIN_REPORT_REQUEST_BYTES, adminReport, adminReportRequest, boundedText, type AdminReportSource } from "./admin-report.ts";
import { adminRevenue } from "./admin-revenue.ts";
import { ADMIN_TIME_ZONE, ADMIN_TREND_DAYS, AdminRangeError, adminSignals, adminToday, adminTrend } from "./admin-signals.ts";
import { adminStats } from "./admin-stats.ts";
import { adminAccount, adminUsage } from "./admin-usage.ts";
import type { Db } from "./db.ts";
import { safeError } from "./metrics.ts";

/**
 * The team's admin site (the ops dashboard), behind Cloudflare Access: a path of the runtime's own hostname
 * (run.camelai.com/ops), or a hostname of its own (admin.camelai.dev). Cloudflare Access's policy for the application is who
 * may use the site; the runtime verifies every request's Access token (team and AUD): its signature, issuer, audience and
 * expiry, so a request that reaches the load balancer some other way, or that Access let through for anything else, gets
 * nothing. Requests for the site are answered here and never reach the rest of the runtime; nothing else reaches the site.
 *
 * Its tabs read (all GET, `?days=` UTC days): growth (src/admin-growth.ts), where sign-ups came from (src/admin-acquisition.ts,
 * from the journey store), usage and one account (src/admin-usage.ts), revenue and free credit (src/admin-revenue.ts), and
 * health and spend (src/admin-health.ts). Besides those: the lifetime stats (GET /api/stats, src/admin-stats.ts), sign-ups,
 * first runs and purchases by calendar day (GET /api/product-signals, src/admin-signals.ts), sign-ups and returning active
 * accounts by UTC day (GET /api/activity-trend) and, where the operator's journey store answers reports, what accounts did
 * on the way to them and how the website's pages about the runtime did (POST /api/report, src/admin-report.ts). Every
 * answer is logged with who asked.
 */
export interface AdminSiteOptions {
  /** The site's hostname, e.g. run.camelai.com. */
  host: string;
  /** The path it is served under on that hostname, e.g. /ops; none: the whole hostname is the site's. */
  path?: string;
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
  /** The operator's own email domains (lower case): accounts that sign in at them are staff, not counted. */
  internalDomains?: string[];
  /**
   * The admins' addresses (lower case), checked against each Access token's email as well as the Access policy, so a
   * policy widened by mistake, or a token issued under an older one, still opens nothing for anyone else. None: whoever
   * the policy admits.
   */
  admins?: string[];
}

/** What the server knows that the site's settings rest on: journey events' store and secret, where they are on, and the secret reports are asked with. */
export interface AdminSiteContext extends Pick<AdminSiteOptions, "db" | "consoleDir" | "internalDomains"> {
  journey?: { url: string; secret: string };
  reportSecret?: string;
  /** The runtime's own hostnames (AGENT_PUBLIC_URL's and its aliases'): the site may be a path of one, never all of it. */
  runtimeHosts?: string[];
}

/** The paths the site may take on the runtime's hostname: names the runtime never uses for its own routes. */
export const ADMIN_PATHS = ["/ops", "/admin"];
/** How many of the site's database reads a node runs at once: the pool is shared with the runtime's own requests. */
const CONCURRENT_READS = 2;

/**
 * The admin site from AGENT_ADMIN_URL (or, for a hostname of its own, the older AGENT_ADMIN_HOST), AGENT_ADMIN_ACCESS_TEAM
 * and AGENT_ADMIN_ACCESS_AUD: all of them, or none for no site. AGENT_ADMIN_URL is where the site is, e.g.
 * https://run.camelai.com/ops: under a path, its hostname may be the runtime's own; without one, the hostname is the site's
 * alone, and so must not be the runtime's. A path is never given as AGENT_ADMIN_HOST: a runtime from before paths, given
 * the runtime's hostname that way, would make the whole hostname the site. Given AGENT_ADMIN_URL it refuses to start
 * instead. Whoever the Access application's policy admits may use the site and, where AGENT_ADMIN_EMAILS lists them
 * (comma-separated), only those addresses: a second lock beside the policy, kept in the deployment's settings. The
 * journey store's reports are asked of AGENT_JOURNEY_URL with a secret of their own (AGENT_JOURNEY_REPORT_SECRET,
 * `context.reportSecret`).
 */
export function adminSiteFromEnvironment(env: NodeJS.ProcessEnv, context: AdminSiteContext): AdminSiteOptions | undefined {
  const url = env.AGENT_ADMIN_URL?.trim(), legacyHost = env.AGENT_ADMIN_HOST?.trim().toLowerCase();
  const team = env.AGENT_ADMIN_ACCESS_TEAM?.trim(), audience = env.AGENT_ADMIN_ACCESS_AUD?.trim();
  const { journey, reportSecret, runtimeHosts = [], internalDomains, ...rest } = context;
  // Journey events' staff domains, or where they are off, the same setting read alone.
  const domains = internalDomains ?? (env.AGENT_JOURNEY_INTERNAL_EMAIL_DOMAINS ?? "").split(",").map(domain => domain.trim().toLowerCase()).filter(Boolean);
  if (reportSecret && !journey) throw new Error("AGENT_JOURNEY_REPORT_SECRET is set without AGENT_JOURNEY_URL");
  if (reportSecret && (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(reportSecret) || Buffer.from(reportSecret.slice(6), "base64").length < 16)) throw new Error("AGENT_JOURNEY_REPORT_SECRET (or AGENT_JOURNEY_REPORT_SECRET_ARN) must be a Standard Webhooks secret, whsec_<base64 of 16 bytes or more>");
  // The store refuses a report asked with the key events are signed with: whoever may read reports must not be able to write events.
  if (reportSecret && reportSecret === journey!.secret) throw new Error("AGENT_JOURNEY_REPORT_SECRET must not be AGENT_JOURNEY_SECRET");
  if (!url && !legacyHost && !team && !audience) return undefined;
  if (url && legacyHost) throw new Error("Set AGENT_ADMIN_URL or AGENT_ADMIN_HOST, not both");
  if (!(url || legacyHost) || !team || !audience) throw new Error("Set AGENT_ADMIN_URL, AGENT_ADMIN_ACCESS_TEAM and AGENT_ADMIN_ACCESS_AUD together, or none of them");
  let origin: URL;
  try { origin = new URL(team); } catch { throw new Error("AGENT_ADMIN_ACCESS_TEAM must be the Access team's origin, e.g. https://<team>.cloudflareaccess.com"); }
  // Plain HTTP only on this host, for tests.
  if (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) throw new Error("AGENT_ADMIN_ACCESS_TEAM must be https");
  let host = legacyHost!, path = "";
  if (url) {
    const site = URL.parse(url);
    const shape = `AGENT_ADMIN_URL must be the site's https address: a hostname, and no path or one of ${ADMIN_PATHS.join(" and ")}, such as https://run.camelai.com/ops`;
    if (!site || site.protocol !== "https:" || site.username || site.password || site.port || site.search || site.hash || url.endsWith("/") && site.pathname !== "/") throw new Error(shape);
    path = site.pathname === "/" ? "" : site.pathname;
    // A name the runtime never routes, written as Access protects it and the site answers it.
    if (path && !ADMIN_PATHS.includes(path)) throw new Error(shape);
    host = site.hostname;
  }
  if (!path && runtimeHosts.includes(host)) throw new Error("The admin site's hostname is one of the runtime's own: give AGENT_ADMIN_URL a path (e.g. https://run.camelai.com/ops) to serve the site under it");
  const admins = (env.AGENT_ADMIN_EMAILS ?? "").split(",").map(email => email.trim().toLowerCase()).filter(Boolean);
  if (admins.some(email => !/^[^\s@,]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email))) throw new Error("AGENT_ADMIN_EMAILS must be email addresses separated by commas");
  return {
    host, ...(path ? { path } : {}), team: origin.origin, audience, ...rest, ...(domains.length ? { internalDomains: domains } : {}), ...(admins.length ? { admins } : {}), tracking: !!journey,
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
  const base = options.path ?? "";
  const viewer = async (c: Context) => {
    const token = c.req.header("cf-access-jwt-assertion");
    if (!token) return undefined;
    try {
      // Access always sets an expiry; a token without one is not Access's.
      const { payload } = await jwtVerify(token, keys, { issuer: options.team, audience: options.audience, algorithms: ["RS256"], requiredClaims: ["exp"] });
      return typeof payload.email === "string" && payload.email ? payload.email : undefined;
    } catch { return undefined; }
  };
  // A node's reads for the site wait their turn, so a few long ones cannot take the pool from the runtime's own requests.
  let reading = 0;
  const waiting: (() => void)[] = [];
  const read = async <T>(work: () => Promise<T>) => {
    if (reading >= CONCURRENT_READS) await new Promise<void>(resolve => waiting.push(resolve));
    else reading++;
    try { return await work(); }
    finally {
      const next = waiting.shift();
      if (next) next(); else reading--;
    }
  };
  const tab = { internalDomains: options.internalDomains ?? [] };
  // A tab's figures for `?days=`, logged with who asked.
  const figures = async (c: Context, email: string, type: string, work: (days: string) => Promise<object>) => {
    const days = c.req.query("days") ?? "30";
    try {
      const body = await read(() => work(days));
      console.log(JSON.stringify({ type, viewer: email, days: Number(days) }));
      return c.json(body, 200);
    } catch (error) {
      if (!(error instanceof AdminWindowError)) throw error;
      return c.json({ error: error.message }, 400);
    }
  };
  const answer = async (c: Context, email: string, path: string) => {
    // The page is at the path with its slash, so the addresses it asks for resolve under it.
    if (base && path === "/" && c.req.path === base && (c.req.method === "GET" || c.req.method === "HEAD")) return c.redirect(`${base}/${new URL(c.req.url).search}`, 308);
    // The figures are for the site's own page: a browser says when another site's page asks (Access's cookie would answer it).
    const site = c.req.header("sec-fetch-site");
    if (path.startsWith("/api/") && site !== undefined && site !== "same-origin" && site !== "none") return c.json({ error: "cross_site" }, 403);
    if (c.req.method === "POST" && path === "/api/report") return report(c, options, email);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Not found", 404);
    if (path === "/api/me") return c.json({ viewer: email }, 200);
    if (path === "/api/growth") return figures(c, email, "admin_growth_viewed", days => adminGrowth(options.db, { days, ...tab }));
    if (path === "/api/acquisition") return figures(c, email, "admin_acquisition_viewed", days => adminAcquisition(options.report, { days, ...(options.fetch ? { fetch: options.fetch } : {}) }));
    if (path === "/api/usage") return figures(c, email, "admin_usage_viewed", days => adminUsage(options.db, { days, ...tab }));
    if (path === "/api/revenue") return figures(c, email, "admin_revenue_viewed", days => adminRevenue(options.db, { days, ...tab }));
    if (path === "/api/health") return figures(c, email, "admin_health_viewed", days => adminHealth(options.db, { days, ...tab }));
    if (path === "/api/account") {
      const tenant = c.req.query("tenant") ?? "";
      if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(tenant)) return c.json({ error: "tenant must be an account id" }, 400);
      let detail;
      try { detail = await read(() => adminAccount(options.db, tenant, { days: c.req.query("days") ?? "30", ...tab })); }
      catch (error) {
        if (!(error instanceof AdminWindowError)) throw error;
        return c.json({ error: error.message }, 400);
      }
      if (!detail) return c.json({ error: "account_not_found" }, 404);
      // An account's agents and the start of their prompts: who looked, at which account, is logged.
      console.log(JSON.stringify({ type: "admin_account_viewed", viewer: email, tenant, days: detail.range.days }));
      return c.json(detail, 200);
    }
    if (path === "/api/stats") {
      const days = Number(c.req.query("days") ?? 30);
      if (!Number.isInteger(days) || days < 1 || days > 365) return c.json({ error: "days must be a whole number from 1 to 365" }, 400);
      console.log(JSON.stringify({ type: "admin_stats_viewed", viewer: email, days }));
      return c.json({ viewer: email, ...await read(() => adminStats(options.db, { days, recent: 50 })) }, 200);
    }
    if (path === "/api/product-signals") {
      try {
        const zone = c.req.query("time_zone") ?? ADMIN_TIME_ZONE, start = c.req.query("start_date"), end = c.req.query("end_date");
        // No dates: today, in the zone. One without the other is not a range.
        if ((start === undefined) !== (end === undefined)) throw new AdminRangeError(400, "invalid_date");
        const today = start === undefined ? adminToday(zone) : "";
        const signals = await read(() => adminSignals(options.db, { range: { start_date: start ?? today, end_date: end ?? today, time_zone: zone }, tracking: !!options.tracking }));
        console.log(JSON.stringify({ type: "admin_signals_viewed", viewer: email, ...signals.range }));
        return c.json(signals, 200);
      } catch (error) {
        if (!(error instanceof AdminRangeError)) throw error;
        return c.json({ error: error.message }, error.status);
      }
    }
    if (path === "/api/activity-trend") {
      try {
        const trend = await read(() => adminTrend(options.db, { days: Number(c.req.query("days") ?? ADMIN_TREND_DAYS), end_date: c.req.query("end_date") }));
        console.log(JSON.stringify({ type: "admin_trend_viewed", viewer: email, ...trend.range }));
        return c.json(trend, 200);
      } catch (error) {
        if (!(error instanceof AdminRangeError)) throw error;
        return c.json({ error: error.message }, error.status);
      }
    }
    if (path.startsWith("/api/")) return c.json({ error: "Not found" }, 404);
    return serve(c, options.consoleDir, path, base);
  };
  return async (c, next) => {
    // Cloudflare connects to the load balancer with the site's name as Host.
    const host = c.req.header("host")?.split(":")[0].toLowerCase();
    if (host !== options.host) return next();
    // On a path of the runtime's hostname, everything else there is the runtime's.
    const full = c.req.path;
    if (base && full !== base && !full.startsWith(`${base}/`)) return next();
    const email = await viewer(c);
    if (!email) return c.text("Sign in through Cloudflare Access", 401, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    // Access signed this person in, but they are not one of the admins the deployment names: nothing, and it is logged.
    if (options.admins && !options.admins.includes(email.toLowerCase())) {
      console.error(JSON.stringify({ type: "admin_site_refused", viewer: email }));
      return c.text("This page is for camelRun's admins", 403, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    }
    let response: Response;
    try { response = await answer(c, email, full.slice(base.length) || "/"); }
    catch (error) {
      // What failed is in the log, not in the answer.
      console.error(JSON.stringify({ type: "admin_site_failed", error: safeError(error) }));
      response = c.json({ error: "unavailable" }, 500);
    }
    // Nothing the site answers is kept by Cloudflare or the browser but its build's assets, which say so themselves.
    if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
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

/**
 * The site's page (the console build's admin.html), with the path it is served under for the addresses it asks for, and its
 * icon. On a hostname of its own the site also serves the console build's assets the page loads (the console serves them
 * on the runtime's).
 */
async function serve(c: Context, consoleDir: string, path: string, base: string) {
  if (path === "/favicon.svg" || (!base && path === `/console/${OPS_ICON}`)) return await file(c, join(consoleDir, OPS_ICON), "public, max-age=3600") ?? c.text("Not found", 404);
  const relative = !base && path.startsWith("/console/assets/") ? normalize(decodeURIComponent(path.slice("/console/".length))).replace(/^(\.\.(\/|\\|$))+/, "") : "";
  const asset = relative ? join(consoleDir, relative) : "";
  if (asset.startsWith(consoleDir + sep)) {
    const answered = await file(c, asset, "public, max-age=31536000, immutable");
    if (answered) return answered;
  }
  let body: string;
  try { body = await readFile(join(consoleDir, "admin.html"), "utf8"); }
  catch { return c.text("The admin site is not built on this host", 404); }
  // The path is one checked segment (adminSiteFromEnvironment), so it needs no escaping in the attribute.
  body = body.replace("</head>", `<meta name="admin-base" content="${base}"></head>`);
  return c.body(body, 200, { ...HEADERS, "Content-Type": CONTENT_TYPES[".html"], "Cache-Control": "no-store" });
}

/** The site's icon in the console build: the camel on red, apart from the console's own. */
export const OPS_ICON = "ops-favicon.svg";

async function file(c: Context, path: string, cache: string) {
  let body: Buffer;
  try { body = await readFile(path); } catch { return undefined; }
  return c.body(new Uint8Array(body), 200, { ...HEADERS, "Content-Type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream", "Cache-Control": cache });
}

import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { adminStats } from "./admin-stats.ts";
import type { Sql } from "./db.ts";

/**
 * The team's admin site (platform stats), on a hostname of its own behind Cloudflare Access. Access signs in the team and
 * adds its token (`Cf-Access-Jwt-Assertion`) to each request; the runtime checks that token itself (signature, issuer,
 * audience, expiry), so a request that reaches the load balancer some other way gets nothing. Requests for that
 * hostname are answered here and never reach the rest of the runtime; other hostnames never reach the site.
 */
export interface AdminSiteOptions {
  /** The site's hostname, e.g. admin.camelai.dev. */
  host: string;
  /** The Access team's origin, e.g. https://qaml.cloudflareaccess.com: the tokens' issuer, whose /cdn-cgi/access/certs has their keys. */
  team: string;
  /** The Access application's audience (AUD) tag. */
  audience: string;
  db: Sql;
  /** The console's build, which holds the site's page (admin.html) and the assets it shares with the console. */
  consoleDir: string;
  /** The keys tokens are checked with; by default the team's, fetched and cached. */
  keys?: JWTVerifyGetKey;
}

/** The admin site from AGENT_ADMIN_HOST, AGENT_ADMIN_ACCESS_TEAM and AGENT_ADMIN_ACCESS_AUD: all three, or none for no site. */
export function adminSiteFromEnvironment(env: NodeJS.ProcessEnv, rest: Pick<AdminSiteOptions, "db" | "consoleDir">): AdminSiteOptions | undefined {
  const host = env.AGENT_ADMIN_HOST?.trim().toLowerCase(), team = env.AGENT_ADMIN_ACCESS_TEAM?.trim(), audience = env.AGENT_ADMIN_ACCESS_AUD?.trim();
  if (!host && !team && !audience) return undefined;
  if (!host || !team || !audience) throw new Error("Set AGENT_ADMIN_HOST, AGENT_ADMIN_ACCESS_TEAM and AGENT_ADMIN_ACCESS_AUD together, or none of them");
  let origin: URL;
  try { origin = new URL(team); } catch { throw new Error("AGENT_ADMIN_ACCESS_TEAM must be the Access team's origin, e.g. https://<team>.cloudflareaccess.com"); }
  // Plain HTTP only on this host, for tests.
  if (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) throw new Error("AGENT_ADMIN_ACCESS_TEAM must be https");
  return { host, team: origin.origin, audience, ...rest };
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
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Not found", 404);
    if (c.req.path === "/api/stats") {
      const days = Number(c.req.query("days") ?? 30);
      if (!Number.isInteger(days) || days < 1 || days > 365) return c.json({ error: "days must be a whole number from 1 to 365" }, 400);
      console.log(JSON.stringify({ type: "admin_stats_viewed", viewer: email, days }));
      return c.json({ viewer: email, ...await adminStats(options.db, { days, recent: 50 }) }, 200, { "Cache-Control": "no-store" });
    }
    if (c.req.path.startsWith("/api/")) return c.json({ error: "Not found" }, 404);
    return serve(c, options.consoleDir);
  };
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

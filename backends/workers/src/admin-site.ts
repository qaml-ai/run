import { createRemoteJWKSet, jwtVerify } from "jose";
import { handleAdminRequest, type AdminEnv } from "./admin-api.ts";

export type AdminSiteEnv = AdminEnv & {
  AGENT_ADMIN_URL?: string;
  AGENT_ADMIN_HOST?: string;
  AGENT_ADMIN_ACCESS_TEAM?: string;
  AGENT_ADMIN_ACCESS_AUD?: string;
  AGENT_ADMIN_EMAILS?: string;
  AGENT_JOURNEY_INTERNAL_EMAIL_DOMAINS?: string;
};
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const text = (message: string, status: number) => new Response(message, { status, headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

/** The source Access boundary runs before any runtime route or bearer authentication. */
export async function publicAdminSite(request: Request, env: AdminSiteEnv): Promise<Response | null> {
  const configured = env.AGENT_ADMIN_URL?.trim(), legacy = env.AGENT_ADMIN_HOST?.trim().toLowerCase();
  const team = env.AGENT_ADMIN_ACCESS_TEAM?.trim(), audience = env.AGENT_ADMIN_ACCESS_AUD?.trim();
  if (!configured && !legacy && !team && !audience) return null;
  if ((!configured && !legacy) || !team || !audience || (configured && legacy)) throw new Error("Set AGENT_ADMIN_URL, AGENT_ADMIN_ACCESS_TEAM and AGENT_ADMIN_ACCESS_AUD together");
  const site = configured ? new URL(configured) : undefined;
  const base = site && site.pathname !== "/" ? site.pathname : "";
  if (site && (site.protocol !== "https:" || site.username || site.password || site.port || site.search || site.hash || !["", "/ops", "/admin"].includes(base))) throw new Error("Invalid AGENT_ADMIN_URL");
  const host = site?.hostname ?? legacy;
  const url = new URL(request.url);
  if (request.headers.get("host")?.split(":")[0].toLowerCase() !== host || (base && url.pathname !== base && !url.pathname.startsWith(base + "/"))) return null;
  const issuer = new URL(team);
  if (issuer.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(issuer.hostname)) throw new Error("AGENT_ADMIN_ACCESS_TEAM must be https");
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return text("Sign in through Cloudflare Access", 401);
  let email: string | undefined;
  try {
    let key = keys.get(issuer.origin);
    if (!key) keys.set(issuer.origin, key = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer)));
    const { payload } = await jwtVerify(token, key, { issuer: issuer.origin, audience, algorithms: ["RS256"], requiredClaims: ["exp"] });
    if (typeof payload.email === "string" && payload.email) email = payload.email;
  } catch { /* Invalid credentials never reach the runtime on this hostname. */ }
  if (!email) return text("Sign in through Cloudflare Access", 401);
  const admins = (env.AGENT_ADMIN_EMAILS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (admins.length && !admins.includes(email.toLowerCase())) return text("This page is for camelRun's admins", 403);
  if (base && url.pathname === base && ["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 308, headers: { Location: `${base}/${url.search}`, "Cache-Control": "no-store" } });
  const path = url.pathname.slice(base.length) || "/";
  if (!path.startsWith("/api/")) return text("The admin site is not built on this host", 404);
  url.pathname = "/admin" + path;
  return handleAdminRequest(new Request(url, request), {
    ...env, ADMIN_SITE_PATH: "/admin", ADMIN_TENANTS: email,
    ADMIN_INTERNAL_DOMAINS: env.AGENT_JOURNEY_INTERNAL_EMAIL_DOMAINS ?? env.ADMIN_INTERNAL_DOMAINS,
  }, { tenantId: email, kind: "console", scopes: ["*"] });
}

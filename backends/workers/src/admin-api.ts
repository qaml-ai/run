import { AdminWindowError } from "./admin/admin-accounts.ts";
import { adminAcquisition } from "./admin/admin-acquisition.ts";
import { adminGrowth } from "./admin/admin-growth.ts";
import { adminHealth } from "./admin/admin-health.ts";
import { adminMcp } from "./admin/admin-mcp.ts";
import { adminRevenue } from "./admin/admin-revenue.ts";
import { ADMIN_TIME_ZONE, ADMIN_TREND_DAYS, AdminRangeError, adminSignals, adminToday, adminTrend } from "./admin/admin-signals.ts";
import { adminStats } from "./admin/admin-stats.ts";
import { adminAccount, adminUsage } from "./admin/admin-usage.ts";
import type { AuthContext } from "./control.ts";
import { database, type Db, type PostgresEnv } from "./postgres.ts";

export type AdminEnv = PostgresEnv & {
  /** Disabled unless the authenticated account is explicitly listed. */
  ADMIN_TENANTS?: string;
  ADMIN_SITE_PATH?: string;
  ADMIN_INTERNAL_DOMAINS?: string;
  ADMIN_JOURNEY_TRACKING?: string;
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const CHANNELS = new Set(["discord-managed", "discord", "slack", "telegram", "email", "github", "webhook", "voice"]);

/** Reuse the Node dashboard's SQL. Its channel/voice and ECS-node diagnostics
 * are deliberately excluded; a Workers deployment has no ECS actor leases. */
function platformOnly(path: string, result: any) {
  if (path === "/api/usage") return { ...result,
    features: result.features.filter((row: { key: string }) => row.key !== "channel"),
    integrations: result.integrations.filter((row: { key: string }) => !CHANNELS.has(row.key)),
  };
  if (path === "/api/account") {
    const { channels: _channels, ...rest } = result;
    return { ...rest, agents: rest.agents.map(({ channel: _channel, ...agent }: any) => agent) };
  }
  if (path === "/api/health") return { ...result,
    checks: result.checks.filter((row: { key: string }) => !["channels", "nodes", "agents", "running", "schedules", "schedule_failures"].includes(row.key)),
    nodes: [],
  };
  return result;
}

/** Read-only experimental admin API. Authentication is an account key plus a
 * deployment allowlist; the Node dashboard's Access/cookie UI is not exposed. */
export async function handleAdminRequest(request: Request, env: AdminEnv, auth: AuthContext, db: Db = database(env)): Promise<Response | null> {
  const url = new URL(request.url), base = env.ADMIN_SITE_PATH ?? "/admin";
  if (!["/admin", "/ops"].includes(base)) return null;
  if (url.pathname !== base && !url.pathname.startsWith(base + "/")) return null;
  const allowed = (env.ADMIN_TENANTS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!allowed.includes(auth.tenantId) || !auth.scopes.includes("*")) return json({ error: "Admin account required", code: "FORBIDDEN" }, 403);
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return json({ error: "cross_site" }, 403);
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Not found" }, 404);
  const path = url.pathname.slice(base.length);
  const days = url.searchParams.get("days") ?? "30";
  const internalDomains = (env.ADMIN_INTERNAL_DOMAINS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  const options = { days, internalDomains };
  try {
    let result: unknown;
    switch (path) {
      case "/api/me": result = { viewer: auth.tenantId }; break;
      case "/api/growth": result = await adminGrowth(db, options); break;
      case "/api/acquisition": result = await adminAcquisition({ db, ...options }); break;
      case "/api/mcp": result = await adminMcp(db, options); break;
      case "/api/usage": result = await adminUsage(db, options); break;
      case "/api/revenue": result = await adminRevenue(db, options); break;
      case "/api/health": result = await adminHealth(db, options); break;
      case "/api/account": {
        const tenant = url.searchParams.get("tenant") ?? "";
        if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(tenant)) return json({ error: "tenant must be an account id" }, 400);
        result = await adminAccount(db, tenant, options);
        if (!result) return json({ error: "account_not_found" }, 404);
        break;
      }
      case "/api/stats": {
        const count = Number(days);
        if (!Number.isInteger(count) || count < 1 || count > 365) return json({ error: "days must be a whole number from 1 to 365" }, 400);
        result = { viewer: auth.tenantId, ...await adminStats(db, { days: count, recent: 50 }) };
        break;
      }
      case "/api/product-signals": {
        const zone = url.searchParams.get("time_zone") ?? ADMIN_TIME_ZONE;
        const start = url.searchParams.get("start_date"), end = url.searchParams.get("end_date");
        if ((start === null) !== (end === null)) throw new AdminRangeError(400, "invalid_date");
        const today = start === null ? adminToday(zone) : "";
        result = await adminSignals(db, { range: { start_date: start ?? today, end_date: end ?? today, time_zone: zone }, tracking: env.ADMIN_JOURNEY_TRACKING === "1" });
        break;
      }
      case "/api/activity-trend": result = await adminTrend(db, { days: Number(url.searchParams.get("days") ?? ADMIN_TREND_DAYS), end_date: url.searchParams.get("end_date") ?? undefined }); break;
      default: return json({ error: "Not found" }, 404);
    }
    console.log(JSON.stringify({ type: "admin_viewed", viewer: auth.tenantId, path }));
    const response = json(platformOnly(path, result));
    return request.method === "HEAD" ? new Response(null, response) : response;
  } catch (error) {
    if (error instanceof AdminWindowError) return json({ error: error.message }, 400);
    if (error instanceof AdminRangeError) return json({ error: error.message }, error.status);
    throw error;
  }
}

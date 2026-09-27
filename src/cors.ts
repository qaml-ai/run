import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";

/** A tenant lists at most this many origins. */
const MAX_ORIGINS = 32;
/** How long a node keeps a tenant's origins, and an agent's tenant, before reading them again. */
const CACHE_MS = 30_000;
/** The routes a browser token reads: the only ones a tenant's origins may call. */
export const BROWSER_READS = /^\/v1\/agents\/(client_[a-f0-9]{40})\/(?:events|state|history|inputs)$/;

/**
 * An origin as a tenant lists it: `https://host[:port]`, `http://localhost[:port]` (or 127.0.0.1)
 * for development, or `https://*.host` for any subdomain of host. Never a path.
 */
export function corsOrigin(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "An origin is a string");
  const match = /^(https:\/\/(?:\*\.)?[a-z0-9.-]+|http:\/\/(?:localhost|127\.0\.0\.1))(?::(\d{1,5}))?$/.exec(value);
  if (!match || match[1].endsWith(".") || match[1].includes("..")) throw new HttpError(400, `${value} is not an origin: https://host[:port], https://*.host, or http://localhost[:port]`);
  return value;
}

/** Whether `origin` (as a browser sends it) is one of `allowed`: exactly, or as a subdomain of a wildcard. */
export function originAllowed(allowed: string[], origin: string) {
  return allowed.some(entry => {
    if (!entry.includes("*")) return entry === origin;
    const [scheme, rest] = entry.split("://*");
    return origin.startsWith(`${scheme}://`) && origin.endsWith(rest) && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(origin.slice(scheme.length + 3, origin.length - rest.length));
  });
}

/**
 * The origins each tenant's browsers may read its agents from with browser tokens (`/v1/cors-origins`).
 * Only the browser-token read routes answer them; every other route keeps refusing cross-origin use.
 */
export class CorsOrigins {
  private readonly db: Db;
  private readonly tenants = new Map<string, { origins: Promise<string[]>; until: number }>();
  private readonly agents = new Map<string, { tenant: Promise<string | undefined>; until: number }>();
  constructor(db: Db) { this.db = db; }

  async get(tenant: string): Promise<string[]> {
    const cached = this.tenants.get(tenant);
    if (cached && cached.until > Date.now()) return cached.origins;
    const origins = this.db.query("select origins from tenant_cors_origins where tenant = $1", [tenant]).then(({ rows }) => (rows[0]?.origins ?? []) as string[]);
    this.tenants.set(tenant, { origins, until: Date.now() + CACHE_MS });
    origins.catch(() => this.tenants.delete(tenant));
    return origins;
  }

  /** Replace a tenant's origins (every node takes them within CACHE_MS). */
  async set(tenant: string, input: unknown): Promise<string[]> {
    const listed = (input as { origins?: unknown } | undefined)?.origins;
    if (!Array.isArray(listed) || listed.length > MAX_ORIGINS) throw new HttpError(400, `Send { origins: [...] }, at most ${MAX_ORIGINS}`);
    const origins = [...new Set(listed.map(corsOrigin))];
    await this.db.query(`insert into tenant_cors_origins (tenant, origins, updated_at) values ($1, $2, $3)
      on conflict (tenant) do update set origins = excluded.origins, updated_at = excluded.updated_at`, [tenant, JSON.stringify(origins), Date.now()]);
    this.tenants.delete(tenant);
    return origins;
  }

  /** Whether a browser at `origin` may read `agent`: its tenant lists the origin. */
  async allows(agent: string, origin: string) {
    let cached = this.agents.get(agent);
    if (!cached || cached.until <= Date.now()) {
      if (this.agents.size >= 10_000) for (const [key, entry] of this.agents) if (entry.until <= Date.now()) this.agents.delete(key);
      const tenant = this.db.query("select tenant from agents where id = $1", [agent]).then(({ rows }) => rows[0]?.tenant as string | undefined);
      cached = { tenant, until: Date.now() + CACHE_MS };
      this.agents.set(agent, cached);
      tenant.catch(() => this.agents.delete(agent));
    }
    const tenant = await cached.tenant;
    return !!tenant && originAllowed(await this.get(tenant), origin);
  }
}

import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { Db, Sql } from "./db.ts";
import { safeError } from "./metrics.ts";
import { HttpError } from "./http.ts";

const MINUTE = 60_000;
const DAY = 86_400_000;
/** The window failed password sign-ins are counted in. */
export const PASSWORD_WINDOW_SECONDS = 900;
/** Distinct clients one node keeps API buckets for; past it, idle and then the oldest are dropped. */
const MAX_BUCKETS = 100_000;
/** The address Cloudflare gives requests Workers make: every Worker's, so they are told apart by CF-Worker, their zone. */
const WORKERS_ADDRESS = "2a06:98c0:3600::103";

export interface RateLimit {
  /** Which limit: `api_requests`, `auth_requests`, `signups`, `password_failures`, `email_requests`, `emails`, `agent_creates` or `runs`. */
  name: string;
  scope: "ip" | "tenant" | "email";
  max: number;
  windowSeconds: number;
}

/**
 * Where a tenant stands in a per-tenant window (agent creates, runs), as the X-RateLimit-* headers say it: the limit,
 * what is left of it, and the seconds until the window resets. Windows are fixed and align to the clock minute (UTC).
 */
export interface RateLimitState {
  limit: number;
  remaining: number;
  /** Seconds until the window resets, at least 1. */
  reset: number;
}

/** The X-RateLimit-* headers for a tenant's window. */
export function rateLimitHeaders(state: RateLimitState | undefined): Record<string, string> {
  return state ? { "X-RateLimit-Limit": String(state.limit), "X-RateLimit-Remaining": String(state.remaining), "X-RateLimit-Reset": String(state.reset) } : {};
}

/** A request a rate limit refused: 429 RATE_LIMITED, with Retry-After and the limit in the body. */
export class RateLimited extends HttpError {
  readonly retryAfter: number;
  readonly limit: RateLimit;
  /** A per-tenant limit's window, for its X-RateLimit-* headers. */
  readonly state?: RateLimitState;
  constructor(limit: RateLimit, retryAfterSeconds: number, message: string) {
    super(429, message, "RATE_LIMITED");
    this.limit = limit;
    this.retryAfter = Math.max(1, Math.ceil(retryAfterSeconds));
    if (limit.scope === "tenant") this.state = { limit: limit.max, remaining: 0, reset: this.retryAfter };
  }
}

export interface RateLimitConfig {
  /**
   * Take the client's address from CF-Connecting-IP. Only for a runtime nothing but Cloudflare can reach (the ALB
   * admits only Cloudflare's addresses): anyone else could send the header. Otherwise the load balancer's last
   * X-Forwarded-For entry, else the socket's.
   */
  cloudflare: boolean;
  /** Requests a minute per client address to /v1/*. */
  apiPerIp: number;
  /** Requests a minute per client address to /console/auth/* and /oauth/* (sign-in, sign-up callbacks, OAuth). */
  authPerIp: number;
  /** New accounts (sign-ups) per client address per UTC day. */
  signupsPerIp: number;
  /** Failed password sign-ins per client address, and per email address, in PASSWORD_WINDOW_SECONDS. */
  passwordFailuresPerIp: number;
  passwordFailuresPerEmail: number;
  /** Requests that mail a link (sign-up, a password reset, adding an address) per client address an hour, and mails per email address a day. */
  emailRequestsPerIp: number;
  emailsPerAddress: number;
  /** Agents a tenant may create a minute (POST /v1/agents), and on free credit: an anti-abuse guard, not a product limit. */
  agentCreates: number;
  freeAgentCreates: number;
  /** Runs (prompt, continue, execute) a tenant may start a minute, and on free credit. */
  runs: number;
  freeRuns: number;
  /** Client keys (an address, an IPv6 /64 as `a:b:c:d::/64`, or `worker:<zone>`) no per-address limit applies to. */
  exempt: Set<string>;
}

/**
 * The limits from the environment; each is a whole number, 0 for none. Per-address limits are on by default only behind
 * Cloudflare: without it the address is a load balancer's view, which may be a shared proxy's (Cloudflare's edge, when its
 * proxy reaches the runtime without AGENT_TRUST_CF_CONNECTING_IP), so a self-hosted runtime sets them itself.
 */
export function rateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  const count = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer (0: no limit)`);
    return value;
  };
  const trust = env.AGENT_TRUST_CF_CONNECTING_IP ?? "false";
  if (trust !== "true" && trust !== "false") throw new Error("AGENT_TRUST_CF_CONNECTING_IP must be true or false");
  const perAddress = trust === "true";
  return {
    cloudflare: trust === "true",
    apiPerIp: count("AGENT_RATE_LIMIT_API_PER_IP", perAddress ? 600 : 0),
    authPerIp: count("AGENT_RATE_LIMIT_AUTH_PER_IP", perAddress ? 20 : 0),
    signupsPerIp: count("AGENT_RATE_LIMIT_SIGNUPS_PER_IP", perAddress ? 5 : 0),
    passwordFailuresPerIp: count("AGENT_RATE_LIMIT_PASSWORD_FAILURES_PER_IP", perAddress ? 20 : 0),
    // An email address is no network's, so this one is on everywhere.
    passwordFailuresPerEmail: count("AGENT_RATE_LIMIT_PASSWORD_FAILURES_PER_EMAIL", 10),
    emailRequestsPerIp: count("AGENT_RATE_LIMIT_EMAIL_REQUESTS_PER_IP", perAddress ? 10 : 0),
    emailsPerAddress: count("AGENT_RATE_LIMIT_EMAILS_PER_ADDRESS", 5),
    // Making an agent costs almost nothing: creates are limited only against abuse, the same for every account. Busy
    // agents (usage tiers), spend and storage are what an account designs around.
    agentCreates: count("AGENT_RATE_LIMIT_AGENT_CREATES", 600),
    freeAgentCreates: count("AGENT_RATE_LIMIT_FREE_AGENT_CREATES", 600),
    runs: count("AGENT_RATE_LIMIT_RUNS", 600),
    freeRuns: count("AGENT_RATE_LIMIT_FREE_RUNS", 240),
    exempt: new Set((env.AGENT_RATE_LIMIT_EXEMPT ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean)),
  };
}

type Header = (name: string) => string | undefined;

/**
 * The caller's address. Behind Cloudflare (`cloudflare`), CF-Connecting-IP, which Cloudflare sets. Otherwise, or without
 * it, the load balancer's last X-Forwarded-For entry (earlier ones are the client's to write), else the socket's.
 */
export function clientAddress(header: Header, socket: string | undefined, cloudflare: boolean): string | undefined {
  if (cloudflare) {
    const connecting = header("cf-connecting-ip")?.trim();
    if (connecting && isIP(connecting)) return connecting;
  }
  return header("x-forwarded-for")?.split(",").map(value => value.trim()).filter(Boolean).at(-1) ?? socket;
}

/** Whether an address is this host's own: the runtime calling itself (hosted MCP tools call the REST API over loopback). */
export function loopback(address: string) {
  return /^(?:::ffff:)?127\./i.test(address) || address === "::1";
}

/**
 * Who a per-address limit counts: the address, an IPv6 address's /64 (one subscriber usually holds all of it), or,
 * for a Worker's request behind Cloudflare, `worker:<its zone>`.
 */
export function clientKey(header: Header, address: string, cloudflare: boolean) {
  if (cloudflare && address === WORKERS_ADDRESS) {
    const zone = header("cf-worker")?.trim().toLowerCase();
    if (zone) return `worker:${zone}`;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return mapped;
  if (isIP(address) !== 6) return address.toLowerCase();
  const [head, tail] = address.toLowerCase().split("::");
  const groups = (part: string | undefined) => part ? part.split(":").flatMap(group => group.includes(".") ? ["0", "0"] : [group]) : [];
  const front = groups(head), back = groups(tail);
  const all = [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${all.slice(0, 4).map(group => parseInt(group, 16).toString(16)).join(":")}::/64`;
}

export interface RateLimitOptions {
  db: Db;
  config: RateLimitConfig;
  /** Keys the hash client addresses are stored under in Postgres: never the addresses themselves. */
  hashKey: string;
  /** Nodes sharing the per-address API budget, each allowing its share (the load balancer spreads a client's requests). */
  nodes: () => number;
  /** Whether a tenant is on free credit, with the lower per-tenant limits. */
  free: (tenant: string) => Promise<boolean>;
  /** The per-minute limit set for the tenant (an admin tenant's entry, or a self-serve tenant's `tenants.limits`), over the default. */
  override?: (tenant: string, limit: "agentCreates" | "runs") => number | undefined | Promise<number | undefined>;
  /**
   * Whether a tenant is exempt from the per-tenant limits unless an override sets one: admin tenants (the tenants file's,
   * such as the operator's own applications), whose traffic is trusted and must never be throttled by default.
   */
  exempt?: (tenant: string) => boolean;
  now?: () => number;
}

/**
 * Rate limits. Per client address, /v1/* (the busiest traffic) is counted on each node in memory, as token buckets
 * holding the node's share of the limit; the rest are rare enough to count exactly in Postgres, in fixed windows: one
 * upsert per sign-in request, agent create or run. Addresses are stored as keyed hashes, and swept within an hour of
 * their window ending.
 */
export class RateLimits {
  readonly config: RateLimitConfig;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  /** Refusals since the last report, by limit: logged once a minute rather than per request. */
  private refused = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly options: RateLimitOptions;

  constructor(options: RateLimitOptions) {
    this.options = options;
    this.config = options.config;
    this.now = options.now ?? Date.now;
  }

  /** Who sent a request, for per-address limits and Get Help: its address, and the key the limits count it under. */
  client(header: Header, socket: string | undefined) {
    const address = clientAddress(header, socket, this.config.cloudflare);
    return { address, key: address && !loopback(address) ? clientKey(header, address, this.config.cloudflare) : undefined };
  }

  /**
   * The per-address limit for a request to `path`, from `key` (none for the runtime's own calls). `trusted` says whether
   * the request is authenticated as an exempt tenant: /v1 traffic of those is never counted per address, since an
   * operator's servers (Workers, containers) share a few egress addresses. Sign-in and OAuth are always counted.
   */
  async request(path: string, key: string | undefined, trusted: () => Promise<boolean> = async () => false) {
    if (!key || this.config.exempt.has(key)) return;
    if (path.startsWith("/v1/") && this.config.apiPerIp) {
      if (await trusted()) return;
      const share = Math.max(1, Math.ceil(this.config.apiPerIp / Math.max(1, this.options.nodes())));
      const wait = this.take(key, share);
      if (wait) this.refuse({ name: "api_requests", scope: "ip", max: this.config.apiPerIp, windowSeconds: 60 }, wait,
        `Too many requests from this address: at most ${this.config.apiPerIp} a minute to /v1. Retry after Retry-After`);
    } else if ((path.startsWith("/console/auth/") || path.startsWith("/oauth/")) && this.config.authPerIp) {
      await this.counted(this.options.db, `auth:${this.hashed(key)}`, { name: "auth_requests", scope: "ip", max: this.config.authPerIp, windowSeconds: 60 },
        `Too many sign-in requests from this address: at most ${this.config.authPerIp} a minute`);
    }
  }

  /** Count a new account from `key`, in the transaction that creates it (so a sign-up that fails counts nothing). */
  async signup(sql: Sql, key: string | undefined) {
    if (!key || this.config.exempt.has(key) || !this.config.signupsPerIp) return;
    await this.counted(sql, `signup:${this.hashed(key)}`, { name: "signups", scope: "ip", max: this.config.signupsPerIp, windowSeconds: DAY / 1000 },
      `Too many new accounts from this network today (at most ${this.config.signupsPerIp} a day); try again tomorrow, or contact support`);
  }

  /**
   * Refuse a password sign-in for `email` from `key` while either has used up its failures for the window, before the
   * password is checked. Only failures count (`passwordFailed`), an unknown address's as a wrong password's.
   */
  async passwordAllowed(key: string | undefined, email: string) {
    for (const limit of this.passwordLimits(key, email)) {
      const windowMs = limit.windowSeconds * 1000, now = this.now();
      const row = (await this.options.db.query("select count, window_start from rate_limits where key = $1 and window_start = $2", [limit.key, Math.floor(now / windowMs) * windowMs])).rows[0];
      if (row && row.count >= limit.max) this.refuse(limit, (Number(row.window_start) + windowMs - now) / 1000, "Too many failed sign-ins; try again later");
    }
  }

  /** Count a failed password sign-in for `email` from `key`. */
  async passwordFailed(key: string | undefined, email: string) {
    for (const limit of this.passwordLimits(key, email)) await this.increment(this.options.db, limit.key, limit.windowSeconds);
  }

  private passwordLimits(key: string | undefined, email: string) {
    const limits: (RateLimit & { key: string })[] = [];
    if (key && !this.config.exempt.has(key) && this.config.passwordFailuresPerIp) {
      limits.push({ key: `password-ip:${this.hashed(key)}`, name: "password_failures", scope: "ip", max: this.config.passwordFailuresPerIp, windowSeconds: PASSWORD_WINDOW_SECONDS });
    }
    if (this.config.passwordFailuresPerEmail) {
      limits.push({ key: `password-email:${this.hashed(`email:${email}`)}`, name: "password_failures", scope: "email", max: this.config.passwordFailuresPerEmail, windowSeconds: PASSWORD_WINDOW_SECONDS });
    }
    return limits;
  }

  /**
   * Count a request that mails a link to `email` from `key` (sign-up, password reset, adding an address), refused past
   * the source's hourly limit or the address's daily one. Every such request counts, whether or not the address has an
   * account, so a refusal says nothing about one.
   */
  async emailRequest(key: string | undefined, email: string) {
    if (key && !this.config.exempt.has(key) && this.config.emailRequestsPerIp) {
      await this.counted(this.options.db, `email-ip:${this.hashed(key)}`, { name: "email_requests", scope: "ip", max: this.config.emailRequestsPerIp, windowSeconds: 3600 },
        `Too many requests from this address: at most ${this.config.emailRequestsPerIp} an hour; try again later`);
    }
    if (this.config.emailsPerAddress) {
      await this.counted(this.options.db, `email-to:${this.hashed(`email:${email}`)}`, { name: "emails", scope: "email", max: this.config.emailsPerAddress, windowSeconds: DAY / 1000 },
        `Too many emails to this address today (at most ${this.config.emailsPerAddress}); try again tomorrow`);
    }
  }

  /**
   * Count an agent create by `tenant` (POST /v1/agents, a fork): where it stands in its window after this one, for
   * the X-RateLimit-* headers; undefined when no limit applies. `counted: false` only reads where it stands (an upsert
   * that changes nothing).
   */
  agentCreate(tenant: string, counted = true) {
    return this.perTenant(tenant, "agentCreates", "agent_creates", "agents created", counted);
  }

  /** Count a run (prompt, continue, execute) started for `tenant`: where it stands in its window after this one. */
  run(tenant: string) {
    return this.perTenant(tenant, "runs", "runs", "runs started", true);
  }

  /**
   * A tenant's per-minute limit of `limit` (none: undefined), whether it is free credit's, and what buying credit would
   * raise it to (`paid`, when that is more).
   */
  async tenantLimit(tenant: string, limit: "agentCreates" | "runs"): Promise<{ max: number; free: boolean; paid?: number } | undefined> {
    const own = await this.options.override?.(tenant, limit);
    if (own === undefined && this.options.exempt?.(tenant)) return;
    const free = own === undefined && await this.options.free(tenant);
    const max = own ?? (free ? this.config[limit === "runs" ? "freeRuns" : "freeAgentCreates"] : this.config[limit]);
    if (!max) return;
    const paid = this.config[limit];
    return { max, free, ...(free && (!paid || paid > max) ? { paid } : {}) };
  }

  private async perTenant(tenant: string, limit: "agentCreates" | "runs", name: string, what: string, counted: boolean): Promise<RateLimitState | undefined> {
    const applies = await this.tenantLimit(tenant, limit);
    if (!applies) return;
    const { max, free, paid } = applies;
    // On free credit, what buying credit unlocks; a create limit is only against abuse.
    const upgrade = paid !== undefined ? `; buying credit raises it to ${paid ? `${paid} a minute` : "no limit"}` : "";
    const message = limit === "runs" ? `Too many ${what}: at most ${max} a minute for this account${free ? ` on free credit${upgrade}` : ""}`
      : `Too many ${what}: at most ${max} a minute for this account (a limit against abuse${free ? `, on free credit${upgrade}` : ""}). Upsert an agent you have instead of making new ones`;
    const key = `${name}:${tenant}`, windowMs = 60_000, now = this.now();
    // Only this tenant's own counter is read: its key is the tenant's, never another's.
    const row = counted ? await this.counted(this.options.db, key, { name, scope: "tenant", max, windowSeconds: 60 }, message)
      : (await this.options.db.query("select count, window_start from rate_limits where key = $1 and window_start = $2", [key, Math.floor(now / windowMs) * windowMs])).rows[0] as { count: number; window_start: string | number } | undefined;
    const start = row ? Number(row.window_start) : Math.floor(now / windowMs) * windowMs;
    return { limit: max, remaining: Math.max(0, max - (row?.count ?? 0)), reset: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
  }

  private hashed(key: string) {
    return createHmac("sha256", this.options.hashKey).update(`rate-limit:${key}`).digest("hex").slice(0, 32);
  }

  /** One more for `key` in its current window; refused past the limit. The window's count and start. */
  private async counted(sql: Sql, key: string, limit: RateLimit, message: string) {
    const row = await this.increment(sql, key, limit.windowSeconds);
    if (row.count > limit.max) this.refuse(limit, (Number(row.window_start) + limit.windowSeconds * 1000 - this.now()) / 1000, message);
    return row;
  }

  /** One more for `key` in its current window of `windowSeconds`: the window's count and start. */
  private async increment(sql: Sql, key: string, windowSeconds: number) {
    const windowMs = windowSeconds * 1000, now = this.now();
    const start = Math.floor(now / windowMs) * windowMs;
    // A row from an earlier window starts over; one a node with a slower clock reaches keeps its newer window.
    const { rows: [row] } = await sql.query(`
      insert into rate_limits as r (key, window_start, count, expires_at) values ($1, $2, 1, $3)
      on conflict (key) do update set
        count = case when excluded.window_start > r.window_start then 1 else r.count + 1 end,
        window_start = greatest(r.window_start, excluded.window_start),
        expires_at = greatest(r.expires_at, excluded.expires_at)
      returning count, window_start`, [key, start, start + windowMs]);
    return row as { count: number; window_start: string | number };
  }

  /** Take a token from `key`'s bucket of `capacity`, refilled over a minute: 0 if taken, else the seconds until one is. */
  private take(key: string, capacity: number) {
    const now = this.now(), rate = capacity / MINUTE;
    let bucket = this.buckets.get(key);
    if (bucket) {
      bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.at) * rate);
      bucket.at = now;
    } else {
      if (this.buckets.size >= MAX_BUCKETS) this.sweepBuckets(now);
      bucket = { tokens: capacity, at: now };
      this.buckets.set(key, bucket);
    }
    if (bucket.tokens >= 1) { bucket.tokens -= 1; return 0; }
    return (1 - bucket.tokens) / rate / 1000;
  }

  /** Drop buckets idle a minute (full again, so the same as none), then, while too many remain, the oldest. */
  private sweepBuckets(now = this.now()) {
    for (const [key, bucket] of this.buckets) if (now - bucket.at >= MINUTE) this.buckets.delete(key);
    for (const key of this.buckets.keys()) {
      if (this.buckets.size < MAX_BUCKETS) break;
      this.buckets.delete(key);
    }
  }

  private refuse(limit: RateLimit, retryAfterSeconds: number, message: string): never {
    this.refused.set(limit.name, (this.refused.get(limit.name) ?? 0) + 1);
    throw new RateLimited(limit, retryAfterSeconds, message);
  }

  /** Delete counters whose window has ended, and drop idle buckets. */
  async sweep() {
    this.sweepBuckets();
    await this.options.db.query("delete from rate_limits where expires_at < $1", [this.now()]);
  }

  /** Report refusals each minute and sweep each hour. */
  start() {
    let minutes = 0;
    this.timer ??= setInterval(() => {
      if (this.refused.size) {
        console.log(JSON.stringify({ type: "rate_limited", refused: Object.fromEntries(this.refused) }));
        this.refused = new Map();
      }
      if (++minutes % 60 === 0) void this.sweep().catch(error => console.error(JSON.stringify({ type: "rate_limit_sweep_failed", error: safeError(error) })));
    }, MINUTE);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

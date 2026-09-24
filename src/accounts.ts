import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import type { Tenants } from "./tenants.ts";
import type { UsageRecord } from "./client-sessions.ts";

/**
 * Tenant state that tenants manage themselves: provider keys (encrypted at rest),
 * API tokens, usage, and tenants created by console sign-in. Admin-defined tenants
 * and their operator tokens stay in the Tenants file; both kinds live side by side.
 * Everything is in Postgres (`tenants`, `provider_keys`, `api_tokens`, `usage`), so
 * any node can serve any tenant.
 */
export interface Principal { tenant: string; via: "operator" | "token" | "console"; tokenId?: string }
export interface KeyStatus { provider: string; source: "tenant" | "admin"; last4?: string; setAt?: number }
export interface ApiToken { id: string; name: string; sha256: string; prefix: string; createdAt: number }
export type Sealed = { iv: string; tag: string; ciphertext: string };
type Totals = { responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const validTenant = (id: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);
const zero = (): Totals => ({ responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const add = (target: Totals, source: Totals) => {
  target.responses += source.responses; target.input += source.input; target.output += source.output;
  target.cacheRead += source.cacheRead; target.cacheWrite += source.cacheWrite; target.cost += source.cost;
};
const COMPACTION = "compaction:";
/** Revocations reach other nodes within this long. */
const TOKEN_CACHE_MS = 10_000;

export class Accounts {
  readonly tenants: Tenants;
  readonly db: Db;
  private readonly secretsKey?: Buffer;
  private readonly tokenCache = new Map<string, { principal: Principal; until: number }>();
  /** Usage not yet written: JSON [tenant, day, model] → totals. */
  private pendingUsage = new Map<string, Totals>();
  private usageTimer?: ReturnType<typeof setTimeout>;

  constructor(options: { tenants: Tenants; db: Db; secretsKey?: string }) {
    this.tenants = options.tenants;
    this.db = options.db;
    if (options.secretsKey !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(options.secretsKey)) throw new Error("AGENT_SECRETS_KEY must be 64 hex characters (32 bytes)");
      this.secretsKey = Buffer.from(options.secretsKey, "hex");
    }
  }

  /** Admin-defined tenants and tenants created by console sign-in. */
  async exists(tenant: string) {
    return this.tenants.has(tenant) || (validTenant(tenant) && !!(await this.db.query("select 1 from tenants where id = $1", [tenant])).rowCount);
  }

  /** Resolve a bearer operator token or tenant API token. */
  async authenticate(authorization: string | undefined): Promise<Principal | undefined> {
    const operator = this.tenants.authenticate(authorization);
    if (operator) return { tenant: operator.id, via: "operator" };
    if (!authorization?.startsWith("Bearer art_")) return undefined;
    const hash = sha256(authorization.slice(7));
    const cached = this.tokenCache.get(hash);
    if (cached && cached.until > Date.now()) return cached.principal;
    const entry = (await this.db.query("select tenant, id from api_tokens where sha256 = $1", [hash])).rows[0];
    if (!entry || !await this.exists(entry.tenant)) return undefined;
    const principal: Principal = { tenant: entry.tenant, via: "token", tokenId: entry.id };
    this.tokenCache.set(hash, { principal, until: Date.now() + TOKEN_CACHE_MS });
    return principal;
  }

  /**
   * The tenant a GitHub user signs in as: an admin tenant linked to that login,
   * otherwise a tenant named after the login, created on first sign-in.
   */
  async tenantForGithub(login: string): Promise<string> {
    const linked = this.tenants.byGithub(login);
    if (linked) return linked;
    const id = login.toLowerCase();
    if (!validTenant(id)) throw new Error(`GitHub login ${login} cannot be used as a tenant id`);
    if (this.tenants.has(id)) throw new Error(`Tenant ${id} exists but is not linked to GitHub user ${login}; ask an admin to add "github": "${login}" to it`);
    await this.db.query("insert into tenants (id, github, created_at) values ($1, $2, $3) on conflict (id) do nothing", [id, login, Date.now()]);
    const existing = (await this.db.query("select github from tenants where id = $1", [id])).rows[0];
    if (existing.github?.toLowerCase() !== login.toLowerCase()) throw new Error(`Tenant ${id} belongs to another account`);
    return id;
  }

  // Provider keys -------------------------------------------------------------

  private async storedKeys(tenant: string) {
    if (!validTenant(tenant)) throw new Error(`Invalid tenant id: ${tenant}`);
    return (await this.db.query("select provider, sealed, last4, set_at from provider_keys where tenant = $1", [tenant])).rows as { provider: string; sealed: Sealed; last4: string; set_at: number }[];
  }

  /** The key an agent uses: the tenant's own key, else one an admin configured. */
  async apiKey(tenant: string, provider: string): Promise<string | undefined> {
    const stored = this.secretsKey && validTenant(tenant) ? (await this.db.query("select sealed from provider_keys where tenant = $1 and provider = $2", [tenant, provider])).rows[0] : undefined;
    if (stored) return this.unseal(`${tenant}:${provider}`, stored.sealed);
    return this.tenants.apiKey(tenant, provider);
  }

  async keyStatus(tenant: string): Promise<KeyStatus[]> {
    const statuses = new Map<string, KeyStatus>();
    for (const provider of this.tenants.providers(tenant)) statuses.set(provider, { provider, source: "admin" });
    for (const key of await this.storedKeys(tenant)) statuses.set(key.provider, { provider: key.provider, source: "tenant", last4: key.last4, setAt: key.set_at });
    return [...statuses.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  }

  /** Providers an agent of `tenant` can call (its own key, an admin key, or an admin `*` key). */
  async keyedProviders(tenant: string): Promise<(provider: string) => boolean> {
    const own = this.canStoreKeys && validTenant(tenant) ? new Set((await this.storedKeys(tenant)).map(key => key.provider)) : new Set<string>();
    return provider => own.has(provider) || !!this.tenants.apiKey(tenant, provider);
  }

  async hasKey(tenant: string, provider: string) { return (await this.keyedProviders(tenant))(provider); }

  get canStoreKeys() { return !!this.secretsKey; }

  async setKey(tenant: string, provider: string, key: string) {
    if (!this.secretsKey) throw new Error("This runtime has no AGENT_SECRETS_KEY, so it cannot store provider keys");
    if (!validTenant(tenant)) throw new Error(`Invalid tenant id: ${tenant}`);
    // Binding tenant and provider stops a stored ciphertext being replayed under another name.
    await this.db.query(`
      insert into provider_keys (tenant, provider, sealed, last4, set_at) values ($1, $2, $3, $4, $5)
      on conflict (tenant, provider) do update set sealed = excluded.sealed, last4 = excluded.last4, set_at = excluded.set_at`,
    [tenant, provider, this.seal(`${tenant}:${provider}`, key), key.slice(-4), Date.now()]);
  }
  /** Encrypt a secret with AGENT_SECRETS_KEY; `aad` names what it belongs to, so it cannot be moved. */
  seal(aad: string, plaintext: string): Sealed {
    if (!this.secretsKey) throw new Error("This runtime has no AGENT_SECRETS_KEY, so it cannot store secrets");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.secretsKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }

  unseal(aad: string, sealed: Sealed): string {
    if (!this.secretsKey) throw new Error("This runtime has no AGENT_SECRETS_KEY, so it cannot read stored secrets");
    const decipher = createDecipheriv("aes-256-gcm", this.secretsKey, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }

  async deleteKey(tenant: string, provider: string) {
    return !!(await this.db.query("delete from provider_keys where tenant = $1 and provider = $2", [tenant, provider])).rowCount;
  }

  // API tokens ----------------------------------------------------------------

  async listTokens(tenant: string): Promise<Omit<ApiToken, "sha256">[]> {
    const { rows } = await this.db.query("select id, name, prefix, created_at from api_tokens where tenant = $1 order by created_at, id", [tenant]);
    return rows.map(row => ({ id: row.id, name: row.name, prefix: row.prefix, createdAt: row.created_at }));
  }

  /** Mint a token. The secret is returned once and only its hash is kept. */
  async createToken(tenant: string, name: string) {
    if (typeof name !== "string" || !name.trim() || name.length > 80) throw new Error("Token name must contain 1–80 characters");
    if ((await this.db.query("select count(*) as count from api_tokens where tenant = $1", [tenant])).rows[0].count >= 50) throw new Error("A tenant can have at most 50 API tokens");
    const secret = `art_${randomBytes(32).toString("hex")}`;
    const token: ApiToken = { id: randomUUID(), name: name.trim(), sha256: sha256(secret), prefix: secret.slice(0, 8), createdAt: Date.now() };
    await this.db.query("insert into api_tokens (sha256, id, tenant, name, prefix, created_at) values ($1, $2, $3, $4, $5, $6)", [token.sha256, token.id, tenant, token.name, token.prefix, token.createdAt]);
    const { sha256: _hash, ...visible } = token;
    return { token: secret, ...visible };
  }

  async revokeToken(tenant: string, id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return false;
    const { rows } = await this.db.query("delete from api_tokens where tenant = $1 and id = $2 returning sha256", [tenant, id]);
    if (!rows[0]) return false;
    this.tokenCache.delete(rows[0].sha256);
    return true;
  }

  // Usage ---------------------------------------------------------------------

  /**
   * Count a model response. Totals are added to the database in batches, a few seconds later.
   * Compaction summaries are rows of their own, their model prefixed with `compaction:`
   * (provider ids never contain a colon), so the table's key stays as older nodes write it.
   */
  recordUsage(tenant: string, _agent: string, message: UsageRecord) {
    const usage = message.usage ?? {};
    const day = new Date(message.timestamp ?? Date.now()).toISOString().slice(0, 10);
    const model = `${message.provider ?? "unknown"}/${message.model ?? "unknown"}`;
    const key = JSON.stringify([tenant, day, message.kind === "compaction" ? `${COMPACTION}${model}` : model]);
    const totals = this.pendingUsage.get(key) ?? zero();
    add(totals, { responses: 1, input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, cost: usage.cost?.total ?? 0 });
    this.pendingUsage.set(key, totals);
    this.usageTimer ??= setTimeout(() => void this.flushUsage().catch(error => console.error(JSON.stringify({ type: "usage_flush_failed", error: String(error) }))), 5_000);
    this.usageTimer.unref?.();
  }

  /** Add pending usage to the per-tenant daily totals, in one statement. */
  async flushUsage() {
    if (this.usageTimer) { clearTimeout(this.usageTimer); this.usageTimer = undefined; }
    const pending = this.pendingUsage;
    if (!pending.size) return;
    this.pendingUsage = new Map();
    const rows = [...pending].map(([key, totals]) => {
      const [tenant, day, model] = JSON.parse(key);
      return { tenant, day, model, ...totals };
    });
    try {
      await this.db.query(`
        insert into usage (tenant, day, model, responses, input, output, cache_read, cache_write, cost)
        select tenant, day::date, model, responses, input, output, "cacheRead", "cacheWrite", cost
        from jsonb_to_recordset($1::jsonb) as t(tenant text, day text, model text, responses bigint, input bigint, output bigint, "cacheRead" bigint, "cacheWrite" bigint, cost double precision)
        on conflict (tenant, day, model) do update set
          responses = usage.responses + excluded.responses, input = usage.input + excluded.input, output = usage.output + excluded.output,
          cache_read = usage.cache_read + excluded.cache_read, cache_write = usage.cache_write + excluded.cache_write, cost = usage.cost + excluded.cost`,
      [JSON.stringify(rows)]);
    } catch (error) {
      // Keep the counts for the next flush rather than losing them.
      for (const [key, totals] of pending) {
        const merged = this.pendingUsage.get(key) ?? zero();
        add(merged, totals);
        this.pendingUsage.set(key, merged);
      }
      throw error;
    }
  }

  /** Usage since `since`, summed per UTC day and model. */
  async usage(tenant: string, since: number) {
    await this.flushUsage();
    const { rows } = await this.db.query(`
      select to_char(day, 'YYYY-MM-DD') as day, model, responses, input, output, cache_read, cache_write, cost
      from usage where tenant = $1 and day >= $2::date order by day, model`, [tenant, new Date(since).toISOString().slice(0, 10)]);
    const totals = zero();
    const days = rows.map(row => {
      const value = { responses: row.responses, input: row.input, output: row.output, cacheRead: row.cache_read, cacheWrite: row.cache_write, cost: row.cost };
      add(totals, value);
      const compaction = row.model.startsWith(COMPACTION);
      return { day: row.day, model: compaction ? row.model.slice(COMPACTION.length) : row.model, kind: compaction ? "compaction" : "turn", ...value };
    });
    return { since, totals, days };
  }
}

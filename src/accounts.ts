import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { transaction, type Db } from "./db.ts";
import type { Tenants } from "./tenants.ts";
import type { UsageRecord } from "./client-sessions.ts";
import { accrueUsage, Billing, type UsageCharge } from "./billing.ts";
import { activeCharge, MICROS, type Pricing } from "./pricing.ts";
import type { Stripe } from "./stripe.ts";
import type { HttpError } from "./http.ts";

/**
 * Tenant state that tenants manage themselves: provider keys (encrypted at rest),
 * API tokens, usage, and tenants created by console sign-in. Admin-defined tenants
 * and their operator tokens stay in the Tenants file; both kinds live side by side.
 * Everything is in Postgres (`tenants`, `provider_keys`, `api_tokens`, `usage`), so
 * any node can serve any tenant.
 */
export interface Principal { tenant: string; via: "operator" | "token" | "console"; tokenId?: string }
/** Whose key an agent calls a provider with: the tenant's own, one an admin set for the tenant, or the platform's (billed to prepaid credit). */
export type KeySource = "tenant" | "admin" | "platform";
export interface KeyStatus { provider: string; source: KeySource; last4?: string; setAt?: number }
export interface ApiToken { id: string; name: string; sha256: string; prefix: string; createdAt: number }
export type Sealed = { iv: string; tag: string; ciphertext: string };
/** A GitHub account at sign-in: its login, numeric id and creation time (ms). */
export interface GithubUser { login: string; id?: number; createdAt?: number }
type Totals = { responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; platformResponses: number; platformCost: number };
/**
 * What a tenant owes from a batch: model tokens, and web searches and renders, on the platform's keys
 * (USD, with their counts), tool searches ranked by meaning (a platform fee, with their count), and
 * active agent time.
 */
type Charge = { platformCost: number; activeMs: number; toolCost: number; searches: number; renders: number; toolSearchCost: number; toolSearches: number };
/**
 * Usage recorded and not yet written, applied as one transaction under `id` (a row in
 * `usage_flushes`), so a batch retried after a lost commit acknowledgement is skipped.
 * `charges` is what prepaid tenants pay for it (`Charge`).
 */
type Batch = { id: string; usage: Map<string, Totals>; charges: Map<string, Charge> };
const batch = (): Batch => ({ id: randomUUID(), usage: new Map(), charges: new Map() });

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const validTenant = (id: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);
const zero = (): Totals => ({ responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, platformResponses: 0, platformCost: 0 });
const add = (target: Totals, source: Totals) => {
  target.responses += source.responses; target.input += source.input; target.output += source.output;
  target.cacheRead += source.cacheRead; target.cacheWrite += source.cacheWrite; target.cost += source.cost;
  target.platformResponses += source.platformResponses; target.platformCost += source.platformCost;
};
const COMPACTION = "compaction:";
/** Revocations reach other nodes within this long. */
const TOKEN_CACHE_MS = 10_000;
/** Spend on other nodes counts toward a tenant's cap within this long. */
const SPEND_CACHE_MS = 5_000;

export class Accounts {
  readonly tenants: Tenants;
  readonly db: Db;
  private readonly secretsKey?: Buffer;
  private readonly tokenCache = new Map<string, { principal: Principal; until: number }>();
  /** Usage not yet written, by JSON [tenant, day, model]; batches taken for writing stay in `unflushed` until they commit. */
  private pending = batch();
  private unflushed: Batch[] = [];
  private flushes: Promise<void> = Promise.resolve();
  private usageTimer?: ReturnType<typeof setTimeout>;
  readonly billing: Billing;
  /** This UTC month's spend per tenant, as last read plus what this node recorded since. */
  private readonly spend = new Map<string, { month: string; cost: number; until: number }>();
  private readonly spendReads = new Map<string, Promise<number>>();

  constructor(options: { tenants: Tenants; db: Db; secretsKey?: string; pricing?: Pricing; publicUrl?: string; stripe?: Stripe }) {
    this.tenants = options.tenants;
    this.db = options.db;
    this.billing = new Billing({ db: this.db, tenants: this.tenants, pricing: options.pricing, publicUrl: options.publicUrl, stripe: options.stripe, pending: tenant => this.pendingCharges(tenant), flush: () => this.flushUsage() });
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
   * The tenant a GitHub user signs in as: an admin tenant linked to that login, else the
   * tenant made for that GitHub account (found by its numeric id, so a renamed login keeps
   * it), else a new tenant named after the login (or, when another account has that name,
   * the login and the id). New self-serve tenants pay from prepaid credit and start with
   * `startingGrant`, once per GitHub account, and only for accounts at least
   * `minAccountAgeMs` old.
   */
  async tenantForGithub(user: GithubUser | string, options: { minAccountAgeMs?: number } = {}): Promise<string> {
    const { login, id: githubId, createdAt } = typeof user === "string" ? { login: user } as GithubUser : user;
    const linked = this.tenants.byGithub(login);
    if (linked) return linked;
    let row: { id: string; github: string | null; github_id: number | null; billing: string } | undefined;
    const columns = "id, github, github_id, billing";
    if (githubId !== undefined) {
      row = (await this.db.query(`select ${columns} from tenants where github_id = $1`, [githubId])).rows[0];
      // A tenant from before ids were recorded is claimed by the account that has its login now.
      row ??= (await this.db.query(`update tenants set github_id = $2 where lower(github) = lower($1) and github_id is null returning ${columns}`, [login, githubId])).rows[0];
    } else {
      row = (await this.db.query(`select ${columns} from tenants where lower(github) = lower($1)`, [login])).rows[0];
    }
    if (!row) {
      const name = login.toLowerCase();
      const candidates = githubId === undefined ? [name] : [name, `${name.slice(0, 39 - String(githubId).length)}-${githubId}`];
      for (const candidate of candidates) {
        if (!validTenant(candidate) || this.tenants.has(candidate)) continue;
        try {
          row = (await this.db.query(`insert into tenants (id, github, github_id, created_at) values ($1, $2, $3, $4) on conflict (id) do nothing returning ${columns}`, [candidate, login, githubId ?? null, Date.now()])).rows[0];
        } catch (error) {
          // A concurrent first sign-in of the same account made its tenant.
          if ((error as { code?: string }).code !== "23505") throw error;
          row = (await this.db.query(`select ${columns} from tenants where github_id = $1`, [githubId])).rows[0];
        }
        if (row) break;
      }
      if (!row) {
        if (this.tenants.has(name)) throw new Error(`Tenant ${name} exists but is not linked to GitHub user ${login}; ask an admin to add "github": "${login}" to it`);
        throw new Error(`GitHub login ${login} cannot be used as a tenant id`);
      }
    }
    if (githubId === undefined && row.github?.toLowerCase() !== login.toLowerCase()) throw new Error(`Tenant ${row.id} belongs to another account`);
    if (row.github !== login) await this.db.query("update tenants set github = $2 where id = $1", [row.id, login]);
    const oldEnough = createdAt !== undefined && Date.now() - createdAt >= (options.minAccountAgeMs ?? 0);
    // The key makes a repeat (a later sign-in, a retry after a failure here, a second tenant for the account) a no-op.
    if (row.billing === "prepaid" && githubId !== undefined && oldEnough && this.billing.pricing.startingGrant > 0) {
      await this.billing.post([{ tenant: row.id, kind: "grant", amount: this.billing.pricing.startingGrant, key: `grant:github:${githubId}`, metadata: { reason: "Starting credit", github: login } }]);
    }
    return row.id;
  }

  // Provider keys -------------------------------------------------------------

  private async storedKeys(tenant: string) {
    if (!validTenant(tenant)) throw new Error(`Invalid tenant id: ${tenant}`);
    return (await this.db.query("select provider, sealed, last4, set_at from provider_keys where tenant = $1", [tenant])).rows as { provider: string; sealed: Sealed; last4: string; set_at: number }[];
  }

  /**
   * The key an agent uses: the tenant's own key, else one an admin configured, else, for a prepaid tenant,
   * the platform's. Without `wildcard`, `*` keys (model keys) do not count: a search provider's key is its own.
   */
  async providerKey(tenant: string, provider: string, wildcard = true): Promise<{ key: string; source: KeySource } | undefined> {
    const stored = this.secretsKey && validTenant(tenant) ? (await this.db.query("select sealed from provider_keys where tenant = $1 and provider = $2", [tenant, provider])).rows[0] : undefined;
    if (stored) return { key: this.unseal(`${tenant}:${provider}`, stored.sealed), source: "tenant" };
    const admin = this.tenants.apiKey(tenant, provider, wildcard);
    if (admin) return { key: admin, source: "admin" };
    const platform = this.tenants.platformKey(provider, wildcard);
    if (platform && await this.billing.mode(tenant) === "prepaid") return { key: platform, source: "platform" };
    return undefined;
  }

  async apiKey(tenant: string, provider: string) { return (await this.providerKey(tenant, provider))?.key; }

  async keyStatus(tenant: string): Promise<KeyStatus[]> {
    const statuses = new Map<string, KeyStatus>();
    if (await this.billing.mode(tenant) === "prepaid") for (const provider of this.tenants.platformProviders()) statuses.set(provider, { provider, source: "platform" });
    for (const provider of this.tenants.providers(tenant)) statuses.set(provider, { provider, source: "admin" });
    for (const key of await this.storedKeys(tenant)) statuses.set(key.provider, { provider: key.provider, source: "tenant", last4: key.last4, setAt: key.set_at });
    return [...statuses.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  }

  /** Providers an agent of `tenant` can call (its own key, an admin key or `*` key, or for a prepaid tenant the platform's). */
  async keyedProviders(tenant: string): Promise<(provider: string) => boolean> {
    const own = this.canStoreKeys && validTenant(tenant) ? new Set((await this.storedKeys(tenant)).map(key => key.provider)) : new Set<string>();
    const platform = await this.billing.mode(tenant) === "prepaid";
    return provider => own.has(provider) || !!this.tenants.apiKey(tenant, provider) || (platform && !!this.tenants.platformKey(provider));
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
   * `platform` responses ran on a key that is not the tenant's own; a prepaid tenant pays for them.
   */
  recordUsage(tenant: string, _agent: string, message: UsageRecord) {
    const usage = message.usage ?? {};
    const day = new Date(message.timestamp ?? Date.now()).toISOString().slice(0, 10);
    const model = `${message.provider ?? "unknown"}/${message.model ?? "unknown"}`;
    const key = JSON.stringify([tenant, day, message.kind === "compaction" ? `${COMPACTION}${model}` : model]);
    const totals = this.pending.usage.get(key) ?? zero();
    const cost = usage.cost?.total ?? 0;
    add(totals, {
      responses: 1, input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, cost,
      platformResponses: message.platform ? 1 : 0, platformCost: message.platform ? cost : 0,
    });
    this.pending.usage.set(key, totals);
    if (message.platform) {
      const charge = this.charge(tenant);
      // Web searches, renders and tool searches are counted apart from model tokens, so the hour's ledger entry shows each.
      if (message.toolSearches) {
        charge.toolSearchCost += cost;
        charge.toolSearches += message.toolSearches;
      } else if (message.searches || message.renders) {
        charge.toolCost += cost;
        charge.searches += message.searches ?? 0;
        charge.renders += message.renders ?? 0;
      } else charge.platformCost += cost;
    }
    const spent = this.spend.get(tenant);
    if (spent?.month === day.slice(0, 7)) spent.cost += cost;
    this.scheduleFlush();
  }

  /** Count `ms` an agent of `tenant` spent in a turn: model calls and tool execution. */
  recordActive(tenant: string, _agent: string, ms: number) {
    if (!(ms > 0)) return;
    this.charge(tenant).activeMs += ms;
    this.scheduleFlush();
  }

  private charge(tenant: string) {
    let charge = this.pending.charges.get(tenant);
    if (!charge) this.pending.charges.set(tenant, charge = { platformCost: 0, activeMs: 0, toolCost: 0, searches: 0, renders: 0, toolSearchCost: 0, toolSearches: 0 });
    return charge;
  }

  private scheduleFlush() {
    this.usageTimer ??= setTimeout(() => void this.flushUsage().catch(error => console.error(JSON.stringify({ type: "usage_flush_failed", error: String(error) }))), 5_000);
    this.usageTimer.unref?.();
  }

  /** What `charges` come to in micro-USD. */
  private amount(charge: Charge) {
    return Math.round(charge.platformCost * MICROS) + Math.round(charge.toolCost * MICROS) + Math.round(charge.toolSearchCost * MICROS) + activeCharge(this.billing.pricing, charge.activeMs);
  }

  /** What this node has recorded for `tenant` and not yet written, in micro-USD, as if the tenant were prepaid. */
  pendingCharges(tenant: string) {
    let total = 0;
    for (const { charges } of [this.pending, ...this.unflushed]) {
      const charge = charges.get(tenant);
      if (charge) total += this.amount(charge);
    }
    return total;
  }

  /**
   * Write pending usage: add it to the per-tenant daily totals, and debit prepaid tenants
   * into their usage entries for the hour (`accrueUsage`), in one transaction per batch.
   * Flushes run one at a time; a batch that fails stays queued, under the same id, for
   * the next flush.
   */
  flushUsage(): Promise<void> {
    const run = this.flushes.then(() => this.flushPending());
    this.flushes = run.catch(() => {});
    return run;
  }

  private async flushPending() {
    if (this.usageTimer) { clearTimeout(this.usageTimer); this.usageTimer = undefined; }
    if (this.pending.usage.size || this.pending.charges.size) {
      this.unflushed.push(this.pending);
      this.pending = batch();
    }
    try {
      while (this.unflushed.length) {
        await this.apply(this.unflushed[0]);
        this.unflushed.shift();
      }
    } catch (error) {
      // Retry later even if nothing new is recorded.
      this.scheduleFlush();
      throw error;
    }
  }

  private async apply({ id, usage, charges }: Batch) {
    const rows = [...usage].map(([key, totals]) => {
      const [tenant, day, model] = JSON.parse(key);
      return { tenant, day, model, ...totals };
    });
    const billed: UsageCharge[] = [];
    for (const [tenant, charge] of charges) {
      const amount = this.amount(charge);
      if (amount > 0 && await this.billing.mode(tenant) === "prepaid") {
        billed.push({ tenant, amount, metadata: {
          tokens: Math.round(charge.platformCost * MICROS), activeMs: Math.round(charge.activeMs),
          ...(charge.searches || charge.renders ? { web: Math.round(charge.toolCost * MICROS), searches: charge.searches, renders: charge.renders } : {}),
          ...(charge.toolSearches ? { toolSearch: Math.round(charge.toolSearchCost * MICROS), toolSearches: charge.toolSearches } : {}),
        } });
      }
    }
    await transaction(this.db, async sql => {
      if (!(await sql.query("insert into usage_flushes (id) values ($1) on conflict (id) do nothing returning id", [id])).rowCount) return;
      if (rows.length) await sql.query(`
        insert into usage (tenant, day, model, responses, input, output, cache_read, cache_write, cost, platform_responses, platform_cost)
        select tenant, day::date, model, responses, input, output, "cacheRead", "cacheWrite", cost, "platformResponses", "platformCost"
        from jsonb_to_recordset($1::jsonb) as t(tenant text, day text, model text, responses bigint, input bigint, output bigint, "cacheRead" bigint, "cacheWrite" bigint, cost double precision, "platformResponses" bigint, "platformCost" double precision)
        on conflict (tenant, day, model) do update set
          responses = usage.responses + excluded.responses, input = usage.input + excluded.input, output = usage.output + excluded.output,
          cache_read = usage.cache_read + excluded.cache_read, cache_write = usage.cache_write + excluded.cache_write, cost = usage.cost + excluded.cost,
          platform_responses = usage.platform_responses + excluded.platform_responses, platform_cost = usage.platform_cost + excluded.platform_cost`,
      [JSON.stringify(rows)]);
      await accrueUsage(sql, billed);
    });
    this.billing.invalidate(charges.keys());
  }

  /** The tenant's model spend this UTC month, turns and compaction, read from the database at most every few seconds. */
  async monthSpend(tenant: string): Promise<number> {
    const month = new Date().toISOString().slice(0, 7);
    const cached = this.spend.get(tenant);
    if (cached?.month === month && cached.until > Date.now()) return cached.cost;
    let reading = this.spendReads.get(tenant);
    if (!reading) {
      reading = (async () => {
        await this.flushUsage();
        const { rows } = await this.db.query("select coalesce(sum(cost), 0) as cost from usage where tenant = $1 and day >= $2::date", [tenant, `${month}-01`]);
        const cost = Number(rows[0].cost);
        this.spend.set(tenant, { month, cost, until: Date.now() + SPEND_CACHE_MS });
        return cost;
      })().finally(() => this.spendReads.delete(tenant));
      this.spendReads.set(tenant, reading);
    }
    return reading;
  }

  /** Why the tenant may not start or continue model work, when it has reached its monthly cap. */
  async spendLimit(tenant: string): Promise<string | undefined> {
    const cap = this.tenants.maxMonthlyCost(tenant);
    if (cap === undefined) return undefined;
    const spent = await this.monthSpend(tenant);
    if (spent < cap) return undefined;
    return `This tenant has reached its monthly spend limit of $${cap.toFixed(2)} ($${spent.toFixed(2)} spent this UTC month); ask the runtime operator to raise it`;
  }

  /** Why the tenant may not start or continue model work: a reached monthly cap (a message, for 402), or spent or rate-limited prepaid credit. */
  async runLimit(tenant: string): Promise<string | HttpError | undefined> {
    return await this.spendLimit(tenant) ?? await this.billing.creditLimit(tenant);
  }

  /** Usage since `since`, summed per UTC day and model. */
  async usage(tenant: string, since: number) {
    await this.flushUsage();
    const { rows } = await this.db.query(`
      select to_char(day, 'YYYY-MM-DD') as day, model, responses, input, output, cache_read, cache_write, cost, platform_responses, platform_cost
      from usage where tenant = $1 and day >= $2::date order by day, model`, [tenant, new Date(since).toISOString().slice(0, 10)]);
    const totals = zero();
    const days = rows.map(row => {
      const value = { responses: row.responses, input: row.input, output: row.output, cacheRead: row.cache_read, cacheWrite: row.cache_write, cost: row.cost, platformResponses: row.platform_responses, platformCost: row.platform_cost };
      add(totals, value);
      const compaction = row.model.startsWith(COMPACTION);
      return { day: row.day, model: compaction ? row.model.slice(COMPACTION.length) : row.model, kind: compaction ? "compaction" : "turn", ...value };
    });
    return { since, totals, days };
  }
}

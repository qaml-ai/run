import type { Accounts, Sealed } from "./accounts.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import { providerInfo } from "./catalog.ts";
import { OutboundBlocked, type Outbound } from "./outbound.ts";

/**
 * Key scopes: named sets of provider credentials within a tenant, such as one per customer org
 * of an application that serves many. An agent created with `keyScope` calls each model with its
 * scope's entry for that provider, else the tenant's own keys, else (prepaid) the platform's. An
 * entry is a key, and optionally an endpoint in front of the provider (an AI gateway) with extra
 * headers for it, or Bedrock's region. An entry for a gateway that holds the provider's key itself
 * has no key: its calls carry only the extra headers. Keys and headers are sealed like provider keys.
 */
export type ScopeEntry = { apiKey?: string; baseUrl?: string; headers?: Record<string, string>; region?: string };
export type ScopeStatus = { provider: string; last4?: string; baseUrl?: string; region?: string; headers?: string[]; setAt: number };

/** A scope's entries reach other nodes' model calls within this long; the writing node's at once. */
const CACHE_MS = 5_000;
const validScope = (scope: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(scope);
const aad = (tenant: string, scope: string, provider: string) => `key-scope:${tenant}:${scope}:${provider}`;
const invalid = (message: string): never => { throw new HttpError(400, message); };
/** Bedrock's own regional endpoint, which names the region. */
const BEDROCK = /^https:\/\/bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com\/?$/;

export function checkScope(scope: unknown): string {
  if (typeof scope !== "string" || !validScope(scope)) invalid("keyScope must be 1–100 letters, digits, '_', '.' or '-', starting with a letter or digit");
  return scope as string;
}

/** A tenant-configured endpoint's URL, without credentials, query or fragment; whether the runtime may call it is `KeyScopes.set`'s check. */
export function endpoint(value: unknown): string {
  let url: URL | undefined;
  try { url = new URL(String(value)); } catch { /* invalid below */ }
  if (typeof value !== "string" || !url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid("baseUrl must be an https:// URL without credentials, query or fragment");
  return (value as string).replace(/\/+$/, "");
}

/** An endpoint the runtime may call now: through the outbound guard, as it will be at each call (a public https address, unless the operator allows others). */
export async function reachableEndpoint(outbound: Outbound, baseUrl: string) {
  try { await outbound.reachable(baseUrl); }
  catch (error) {
    if (error instanceof OutboundBlocked) invalid(`baseUrl ${baseUrl} cannot be called: ${error.message}`);
    if (["ENOTFOUND", "EAI_AGAIN", "ENODATA"].includes((error as NodeJS.ErrnoException).code ?? "")) invalid(`baseUrl ${baseUrl} cannot be called: its host does not resolve`);
    throw error;
  }
}

/** A scope's entry for `provider`: a built-in model provider, or (`custom`) one of the tenant's own. */
export function scopeEntry(provider: string, input: any, custom = false): ScopeEntry {
  const info = providerInfo(provider);
  if (!custom && (!info || info.kind !== "model" || !(info.apiKey || provider === "amazon-bedrock"))) invalid(`${provider} is not a model provider that takes an API key, nor one of yours; see GET /v1/providers`);
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Body must be {apiKey?, baseUrl?, headers?, region?}");
  for (const key of Object.keys(input)) if (!["apiKey", "baseUrl", "headers", "region"].includes(key)) invalid(`Unknown field ${key}`);
  const { apiKey, baseUrl, headers } = input;
  let { region } = input;
  const bedrock = provider === "amazon-bedrock";
  if (apiKey !== undefined && (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 4096)) invalid("apiKey must be a non-empty string");
  // Without a key, a gateway in front of the provider holds it: only the gateway's headers go.
  if (apiKey === undefined && !custom && (baseUrl === undefined || bedrock || !["openrouter", "anthropic", "openai"].includes(provider))) invalid("apiKey may be left out only for openrouter, anthropic or openai behind a baseUrl (a gateway that holds the key)");
  if (headers !== undefined) {
    if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.keys(headers).length > 20) invalid("headers must be an object of at most 20 header names and string values");
    for (const [name, value] of Object.entries(headers)) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(name) || typeof value !== "string" || value.length > 4096 || /[\r\n]/.test(value)) invalid(`Invalid header ${name}`);
    }
  }
  // Bedrock's region is given, or read from its regional endpoint as baseUrl.
  const hosted = typeof baseUrl === "string" ? BEDROCK.exec(baseUrl)?.[1] : undefined;
  if (bedrock && hosted && region !== undefined && region !== hosted) invalid(`region ${region} does not match the baseUrl's ${hosted}`);
  if (bedrock) region ??= hosted;
  if (region !== undefined && (!bedrock || typeof region !== "string" || !/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region))) invalid("region is only for amazon-bedrock, and must be an AWS region like us-west-2");
  if (bedrock && region === undefined) invalid("amazon-bedrock needs its region: region, or baseUrl https://bedrock-runtime.<region>.amazonaws.com");
  return { ...(apiKey !== undefined ? { apiKey } : {}), ...(baseUrl !== undefined ? { baseUrl: endpoint(baseUrl) } : {}), ...(headers && Object.keys(headers).length ? { headers } : {}), ...(region ? { region } : {}) };
}

export class KeyScopes {
  private readonly db: Db;
  private readonly accounts: Accounts;
  private readonly outbound: Outbound;
  private readonly cache = new Map<string, { entry?: ScopeEntry; until: number }>();

  constructor(options: { db: Db; accounts: Accounts; outbound: Outbound }) {
    this.db = options.db;
    this.accounts = options.accounts;
    this.outbound = options.outbound;
  }

  async set(tenant: string, scope: string, provider: string, entry: ScopeEntry) {
    checkScope(scope);
    if (!this.accounts.canStoreKeys) throw new HttpError(503, "This runtime is not configured to store provider keys");
    // A gateway's address is the tenant's to give, and checked; Bedrock's own regional endpoint is AWS's.
    if (entry.baseUrl !== undefined && !BEDROCK.test(entry.baseUrl)) await reachableEndpoint(this.outbound, entry.baseUrl);
    const { apiKey, headers, ...settings } = entry;
    await this.db.query(`
      insert into key_scope_providers (tenant, scope, provider, sealed, last4, settings, set_at) values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (tenant, scope, provider) do update set sealed = excluded.sealed, last4 = excluded.last4, settings = excluded.settings, set_at = excluded.set_at`,
    [tenant, scope, provider, this.accounts.seal(aad(tenant, scope, provider), JSON.stringify({ ...(apiKey ? { apiKey } : {}), ...(headers ? { headers } : {}) })), apiKey?.slice(-4) ?? "",
      { ...settings, ...(headers ? { headers: Object.keys(headers) } : {}) }, Date.now()]);
    this.forget(tenant, scope);
    return this.status(tenant, scope);
  }

  async delete(tenant: string, scope: string, provider?: string) {
    checkScope(scope);
    const { rowCount } = await this.db.query(`delete from key_scope_providers where tenant = $1 and scope = $2${provider ? " and provider = $3" : ""}`, provider ? [tenant, scope, provider] : [tenant, scope]);
    this.forget(tenant, scope);
    return !!rowCount;
  }

  /** Which providers a scope has entries for; never their secrets. */
  async status(tenant: string, scope: string): Promise<{ scope: string; providers: ScopeStatus[] }> {
    checkScope(scope);
    const { rows } = await this.db.query("select provider, last4, settings, set_at from key_scope_providers where tenant = $1 and scope = $2 order by provider", [tenant, scope]);
    return { scope, providers: rows.map(row => ({ provider: row.provider, ...(row.last4 ? { last4: row.last4 } : {}), ...row.settings, setAt: Number(row.set_at) })) };
  }

  /** The scope's entry for `provider`, cached for a few seconds. */
  async entry(tenant: string, scope: string, provider: string): Promise<ScopeEntry | undefined> {
    const key = JSON.stringify([tenant, scope, provider]);
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return cached.entry;
    const row = this.accounts.canStoreKeys ? (await this.db.query("select sealed, settings from key_scope_providers where tenant = $1 and scope = $2 and provider = $3", [tenant, scope, provider])).rows[0] : undefined;
    let entry: ScopeEntry | undefined;
    if (row) {
      const { headers: _names, ...settings } = row.settings;
      entry = { ...settings, ...JSON.parse(this.accounts.unseal(aad(tenant, scope, provider), row.sealed as Sealed)) };
    }
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(key, { entry, until: Date.now() + CACHE_MS });
    return entry;
  }

  private forget(tenant: string, scope: string) {
    for (const key of this.cache.keys()) {
      const [t, s] = JSON.parse(key);
      if (t === tenant && s === scope) this.cache.delete(key);
    }
  }
}

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { getProviders } from "@earendil-works/pi-ai/compat";
import { secretReader } from "./secrets.ts";
import { UPSTREAMS, type ModelEndpoint } from "./session-config.ts";
import { SANDBOX_LIMITS } from "./limits.ts";

/**
 * A tenant owns its operator token, its agents and its model provider keys.
 * Tenants cannot list, inspect or drive each other's agents, and an agent's
 * model calls are billed to its own tenant's key.
 */
export interface Tenant {
  id: string;
  /** SHA-256 (hex) of the operator token; the token itself is never stored. */
  tokenSha256: string;
  /** Provider name (Pi's `model.provider`, e.g. "anthropic") → API key. */
  apiKeys: Record<string, string>;
  /**
   * GitHub login that signs in to the console as this tenant. A login can be renamed or freed and taken by
   * someone else, so the first account to sign in with it is bound to the tenant by its numeric id and only that
   * account signs in from then on (Accounts.tenantForGithub); `githubId` names the account up front instead.
   */
  github?: string;
  /** The numeric id of the GitHub account that signs in as this tenant (https://api.github.com/users/<login> shows it); overrides `github`. */
  githubId?: number;
  /** Agents this tenant may have busy at once across the fleet (and hosted on any one node); overrides its usage tier and AGENT_MAX_AGENTS_PER_TENANT. */
  maxAgents?: number;
  /** Read-only event-stream subscribers (browser tabs) its agents may have at once on a node; default 1024. */
  maxWatchers?: number;
  /** Discord servers this tenant may connect to the managed Camel bot; overrides the plan's default. */
  maxDiscordServers?: number;
  /** Agents this tenant may create a minute; overrides AGENT_RATE_LIMIT_AGENT_CREATES (src/rate-limits.ts). */
  maxAgentCreatesPerMinute?: number;
  /** Runs (prompt, continue, execute) this tenant may start a minute; overrides AGENT_RATE_LIMIT_RUNS. */
  maxRunsPerMinute?: number;
  /** The most one run of its agents may take, in model responses and seconds; absent: no limit, as for every admin tenant (self-serve tenants get the runtime's). */
  maxRunResponses?: number;
  maxRunSeconds?: number;
  /**
   * js_exec: CPU milliseconds per execution, the longest timeoutMs it may ask for, and executions at once on
   * one node (src/limits.ts CODE_LIMITS). Absent: the default CPU, and no limit on the others below the runtime's own.
   */
  codeCpuMs?: number;
  codeMaxTimeoutMs?: number;
  codeConcurrency?: number;
  /** Removed with QuickJS: js_exec runs on V8 only. "v8" is ignored; anything else is an error. */
  codeEngine?: unknown;
  /** Model spend (USD, list prices) this tenant may reach per UTC month; absent means unlimited. */
  maxMonthlyCost?: number;
  /** GB (10^9 bytes) it may store in all, as the storage charge counts them; absent: the plan's for a prepaid tenant, else unlimited. */
  maxStorageGb?: number;
  /** "prepaid": pays from credit (src/billing.ts) for what runs on the platform's keys. Admin tenants default to "none", unbilled. */
  billing?: "prepaid" | "none";
  /** false: an unbilled tenant's agents never fall back to the platform's keys (the file's `platformKeys`), only its own and its apiKeys. */
  platformKeys?: boolean;
  /** The tenant's own pass-through model endpoints, by the provider name its models are named under (`<name>/<provider>/<model id>`). */
  modelEndpoints?: Record<string, ModelEndpoint>;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const validTenantId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);

export class Tenants {
  private byId = new Map<string, Tenant>();
  /** The platform's own provider keys (the file's `platformKeys`): tenants without a key of their own use them (`usesPlatformKeys`). */
  private platform: Record<string, string> = {};
  private readonly file?: string;
  private readonly read?: () => Promise<string>;

  private readonly from: "file" | "secret" | "env";

  /** `read` returns the tenants file's JSON from elsewhere (a secret, or the environment: `env`); the tenants are empty until `reload`. */
  constructor(options: { file?: string; read?: () => Promise<string>; env?: boolean }) {
    if (options.file && options.read) throw new Error("Set AGENT_TENANTS_FILE or AGENT_TENANTS_SECRET_ARN, not both");
    if (!options.file && !options.read) throw new Error("Set AGENT_TENANTS_FILE or AGENT_TENANTS_SECRET_ARN to the tenants file");
    this.file = options.file;
    this.read = options.read;
    this.from = options.file ? "file" : options.env ? "env" : "secret";
    if (options.file) this.parse(readFileSync(options.file, "utf8"));
  }

  get source() { return this.from; }

  /** Re-read the tenants file or secret (on SIGHUP after adding a tenant). Invalid contents are rejected whole, keeping the tenants loaded before. */
  async reload() {
    if (this.file) this.parse(readFileSync(this.file, "utf8"));
    else if (this.read) this.parse(await this.read());
  }

  private parse(text: string) {
    const parsed = JSON.parse(text) as { tenants?: Record<string, Omit<Tenant, "id">>; platformKeys?: Record<string, string> };
    if (!parsed?.tenants || typeof parsed.tenants !== "object") throw new Error("Tenants file must contain a `tenants` object");
    const platform = parsed.platformKeys ?? {};
    if (typeof platform !== "object" || Array.isArray(platform) || Object.values(platform).some(key => typeof key !== "string" || !key)) throw new Error("platformKeys must map provider names to API keys");
    if ("*" in platform) throw new Error("platformKeys cannot have a `*` key: name each provider");
    this.set(Object.entries(parsed.tenants).map(([id, tenant]) => ({ id, ...tenant })));
    this.platform = { ...platform };
  }

  private set(tenants: Tenant[]) {
    const next = new Map<string, Tenant>();
    const hashes = new Set<string>();
    for (const tenant of tenants) {
      if (!validTenantId(tenant.id)) throw new Error(`Invalid tenant id: ${tenant.id}`);
      if (typeof tenant.tokenSha256 !== "string" || !/^[a-f0-9]{64}$/.test(tenant.tokenSha256)) throw new Error(`Tenant ${tenant.id} needs a hex tokenSha256`);
      if (hashes.has(tenant.tokenSha256)) throw new Error(`Tenant ${tenant.id} reuses another tenant's token`);
      // Optional: a tenant without keys of its own sets them itself, or pays for the platform's.
      if (tenant.apiKeys !== undefined && (!tenant.apiKeys || typeof tenant.apiKeys !== "object" || Array.isArray(tenant.apiKeys) || Object.values(tenant.apiKeys).some(key => typeof key !== "string" || !key))) throw new Error(`Tenant ${tenant.id} has invalid apiKeys`);
      if (tenant.apiKeys && "*" in tenant.apiKeys) throw new Error(`Tenant ${tenant.id} has a \`*\` API key: name each provider`);
      hashes.add(tenant.tokenSha256);
      if (tenant.github !== undefined && (typeof tenant.github !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(tenant.github))) throw new Error(`Tenant ${tenant.id} has an invalid github login`);
      if (tenant.githubId !== undefined && (!Number.isSafeInteger(tenant.githubId) || tenant.githubId < 1)) throw new Error(`Tenant ${tenant.id} has an invalid githubId: the GitHub account's numeric id`);
      if (tenant.githubId !== undefined && tenants.some(other => other !== tenant && other.githubId === tenant.githubId)) throw new Error(`Tenant ${tenant.id} has another tenant's githubId`);
      if (tenant.maxAgents !== undefined && (!Number.isSafeInteger(tenant.maxAgents) || tenant.maxAgents < 1)) throw new Error(`Tenant ${tenant.id} has an invalid maxAgents: a positive integer, or absent for the default`);
      if (tenant.maxWatchers !== undefined && (!Number.isSafeInteger(tenant.maxWatchers) || tenant.maxWatchers < 1)) throw new Error(`Tenant ${tenant.id} has an invalid maxWatchers: a positive integer, or absent for the default`);
      if (tenant.maxDiscordServers !== undefined && (!Number.isSafeInteger(tenant.maxDiscordServers) || tenant.maxDiscordServers < 0)) throw new Error(`Tenant ${tenant.id} has an invalid maxDiscordServers: a non-negative integer, or absent for the default`);
      for (const field of ["maxRunResponses", "maxRunSeconds"] as const) {
        if (tenant[field] !== undefined && (!Number.isSafeInteger(tenant[field]) || tenant[field]! < 1)) throw new Error(`Tenant ${tenant.id} has an invalid ${field}: a positive integer, or absent for no limit`);
      }
      for (const field of ["maxAgentCreatesPerMinute", "maxRunsPerMinute", "codeConcurrency"] as const) {
        if (tenant[field] !== undefined && (!Number.isSafeInteger(tenant[field]) || tenant[field]! < 1)) throw new Error(`Tenant ${tenant.id} has an invalid ${field}: a positive integer, or absent for the default`);
      }
      for (const [field, most] of [["codeCpuMs", SANDBOX_LIMITS.maxCpuMs], ["codeMaxTimeoutMs", SANDBOX_LIMITS.maxTimeoutMs]] as const) {
        if (tenant[field] !== undefined && (!Number.isSafeInteger(tenant[field]) || tenant[field]! < 1 || tenant[field]! > most)) throw new Error(`Tenant ${tenant.id} has an invalid ${field}: an integer from 1 to ${most}, or absent for the default`);
      }
      if (tenant.codeEngine !== undefined && tenant.codeEngine !== "v8") throw new Error(`Tenant ${tenant.id} has codeEngine ${JSON.stringify(tenant.codeEngine)}, but QuickJS was removed and js_exec runs on V8 only: remove codeEngine from its entry (infra/tenant.sh clear-engine ${tenant.id})`);
      if (tenant.maxMonthlyCost !== undefined && (typeof tenant.maxMonthlyCost !== "number" || !Number.isFinite(tenant.maxMonthlyCost) || tenant.maxMonthlyCost < 0)) throw new Error(`Tenant ${tenant.id} has an invalid maxMonthlyCost: a non-negative number of USD, or absent for no limit`);
      if (tenant.maxStorageGb !== undefined && (typeof tenant.maxStorageGb !== "number" || !Number.isFinite(tenant.maxStorageGb) || tenant.maxStorageGb < 0)) throw new Error(`Tenant ${tenant.id} has an invalid maxStorageGb: a non-negative number of GB, or absent for the default`);
      if (tenant.billing !== undefined && tenant.billing !== "prepaid" && tenant.billing !== "none") throw new Error(`Tenant ${tenant.id} has an invalid billing: "prepaid", "none", or absent for none`);
      if (tenant.platformKeys !== undefined && typeof tenant.platformKeys !== "boolean") throw new Error(`Tenant ${tenant.id} has an invalid platformKeys: false, or absent to use the platform's keys`);
      if (tenant.platformKeys === false && tenant.billing === "prepaid") throw new Error(`Tenant ${tenant.id} is prepaid, so it pays for the platform's keys: platformKeys: false is for unbilled tenants`);
      if (tenant.modelEndpoints !== undefined) validEndpoints(tenant.id, tenant.modelEndpoints);
      next.set(tenant.id, {
        id: tenant.id, tokenSha256: tenant.tokenSha256, apiKeys: { ...(tenant.apiKeys ?? {}) }, ...(tenant.github ? { github: tenant.github } : {}), ...(tenant.githubId !== undefined ? { githubId: tenant.githubId } : {}),
        ...(tenant.maxAgents !== undefined ? { maxAgents: tenant.maxAgents } : {}), ...(tenant.maxWatchers !== undefined ? { maxWatchers: tenant.maxWatchers } : {}), ...(tenant.maxMonthlyCost !== undefined ? { maxMonthlyCost: tenant.maxMonthlyCost } : {}),
        ...(tenant.maxDiscordServers !== undefined ? { maxDiscordServers: tenant.maxDiscordServers } : {}), ...(tenant.maxStorageGb !== undefined ? { maxStorageGb: tenant.maxStorageGb } : {}),
        ...(tenant.maxAgentCreatesPerMinute !== undefined ? { maxAgentCreatesPerMinute: tenant.maxAgentCreatesPerMinute } : {}),
        ...(tenant.maxRunsPerMinute !== undefined ? { maxRunsPerMinute: tenant.maxRunsPerMinute } : {}),
        ...(tenant.maxRunResponses !== undefined ? { maxRunResponses: tenant.maxRunResponses } : {}), ...(tenant.maxRunSeconds !== undefined ? { maxRunSeconds: tenant.maxRunSeconds } : {}),
        ...(tenant.codeCpuMs !== undefined ? { codeCpuMs: tenant.codeCpuMs } : {}), ...(tenant.codeMaxTimeoutMs !== undefined ? { codeMaxTimeoutMs: tenant.codeMaxTimeoutMs } : {}),
        ...(tenant.codeConcurrency !== undefined ? { codeConcurrency: tenant.codeConcurrency } : {}),
        ...(tenant.billing ? { billing: tenant.billing } : {}), ...(tenant.platformKeys === false ? { platformKeys: false } : {}), ...(tenant.modelEndpoints ? { modelEndpoints: tenant.modelEndpoints } : {}),
      });
    }
    this.byId = next;
  }

  /** Resolve an `Authorization: Bearer <operator token>` header. Compares every tenant in constant time. */
  authenticate(authorization: string | undefined): Tenant | undefined {
    if (!authorization?.startsWith("Bearer ")) return undefined;
    const digest = Buffer.from(sha256(authorization.slice(7)), "hex");
    let match: Tenant | undefined;
    for (const tenant of this.byId.values()) if (timingSafeEqual(digest, Buffer.from(tenant.tokenSha256, "hex"))) match = tenant;
    return match;
  }

  has(id: string) { return this.byId.has(id); }

  /** The GitHub login an admin linked to `tenant`, if any. */
  github(tenant: string) { return this.byId.get(tenant)?.github; }

  /** Whether `tenant`'s entry is linked by login only (no `githubId`) to `login` (case-insensitive). */
  linkedByLogin(tenant: string, login: string) {
    const entry = this.byId.get(tenant);
    return !!entry && entry.githubId === undefined && entry.github?.toLowerCase() === login.toLowerCase();
  }

  /** The admin-defined tenant whose entry names the GitHub account `id` (`githubId`), if any. */
  byGithubId(id: number) {
    for (const tenant of this.byId.values()) if (tenant.githubId === id) return tenant.id;
    return undefined;
  }

  /** The admin-defined tenants linked only by login (case-insensitive), without a `githubId`: a sign-in binds them to an account (Accounts.tenantForGithub). */
  byGithubLogin(login: string) {
    return [...this.byId.values()].filter(tenant => tenant.githubId === undefined && tenant.github?.toLowerCase() === login.toLowerCase()).map(tenant => tenant.id);
  }

  /** The tenant's own busy-agent limit across the fleet (busy-agents.ts), if its entry sets one. */
  maxAgents(id: string) { return this.byId.get(id)?.maxAgents; }
  maxWatchers(id: string) { return this.byId.get(id)?.maxWatchers; }
  maxDiscordServers(id: string) { return this.byId.get(id)?.maxDiscordServers; }
  /** The tenant's own rate limit (a minute) for agent creates or runs, if its entry sets one. */
  /** The most one run of an admin tenant's agents may take, as its entry sets it (absent: no limit). */
  runLimits(id: string) { const tenant = this.byId.get(id); return { maxResponses: tenant?.maxRunResponses, maxSeconds: tenant?.maxRunSeconds }; }

  /** An admin tenant's js_exec limits, as its entry sets them. */
  codeLimits(id: string) { const tenant = this.byId.get(id); return { cpuMs: tenant?.codeCpuMs, maxTimeoutMs: tenant?.codeMaxTimeoutMs, concurrent: tenant?.codeConcurrency }; }

  rateLimit(id: string, limit: "agentCreates" | "runs") { const tenant = this.byId.get(id); return limit === "runs" ? tenant?.maxRunsPerMinute : tenant?.maxAgentCreatesPerMinute; }

  /** The tenant's monthly spend cap in USD, if its entry sets one. */
  maxMonthlyCost(id: string) { return this.byId.get(id)?.maxMonthlyCost; }

  /** The tenant's storage limit in bytes, if its entry sets one. */
  maxStorageBytes(id: string) { const gb = this.byId.get(id)?.maxStorageGb; return gb === undefined ? undefined : Math.round(gb * 1e9); }

  /** How an admin tenant is billed; undefined for tenants not in the file. */
  billing(id: string) { const tenant = this.byId.get(id); return tenant && (tenant.billing ?? "none"); }

  /**
   * Whether an admin tenant's agents fall back to the platform's keys when they have no key of their own: a
   * prepaid one pays for them from credit; an unbilled one (an operator's) uses them unbilled, its usage still
   * recorded as the platform's, unless its entry says `platformKeys: false`. Undefined for tenants not in the file.
   */
  usesPlatformKeys(id: string) { const tenant = this.byId.get(id); return tenant && (tenant.billing === "prepaid" || tenant.platformKeys !== false); }

  /** The tenant's own model endpoints, if its entry has any. */
  modelEndpoints(id: string) { return this.byId.get(id)?.modelEndpoints; }

  /** The platform's key for `provider`. */
  platformKey(provider: string): string | undefined { return this.platform[provider]; }

  /** Providers the platform has keys for. Names only. */
  platformProviders() { return Object.keys(this.platform); }

  /** Providers an admin configured keys for. Names only. */
  providers(id: string) { return Object.keys(this.byId.get(id)?.apiKeys ?? {}); }

  /** The key an admin configured for agents of `tenantId` to use for `provider`. */
  apiKey(tenantId: string, provider: string): string | undefined { return this.byId.get(tenantId)?.apiKeys[provider]; }
}

function validEndpoints(tenant: string, endpoints: unknown) {
  const bad = (message: string) => new Error(`Tenant ${tenant}: ${message}`);
  if (!endpoints || typeof endpoints !== "object" || Array.isArray(endpoints)) throw bad("modelEndpoints must map provider names to endpoints");
  for (const [name, endpoint] of Object.entries(endpoints) as [string, ModelEndpoint][]) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || getProviders().includes(name as never)) throw bad(`model endpoint ${name} needs a name of its own (lowercase letters, digits and dashes), not one of Pi's providers`);
    let url: URL | undefined;
    try { url = new URL(endpoint?.baseUrl); } catch { /* reported below */ }
    // Plain HTTP only to this host, for development: identity tokens are bearer credentials.
    const loopback = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!url || !(url.protocol === "https:" || url.protocol === "http:" && loopback) || url.username || url.password || url.search || url.hash) throw bad(`model endpoint ${name} needs an HTTPS baseUrl without credentials or query`);
    if (endpoint.models !== undefined && (!endpoint.models || typeof endpoint.models !== "object" || Array.isArray(endpoint.models))) throw bad(`model endpoint ${name}'s models must map "<provider>/<model id>" to { contextWindow, maxTokens, reasoning?, input? }`);
    for (const [id, model] of Object.entries(endpoint.models ?? {})) {
      if (!Object.hasOwn(UPSTREAMS, id.slice(0, Math.max(0, id.indexOf("/"))))) throw bad(`model ${name}/${id} must be "<provider>/<model id>" with a provider among ${Object.keys(UPSTREAMS).join(", ")}`);
      if (!model || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 ||
          (model.reasoning !== undefined && typeof model.reasoning !== "boolean") || (model.input !== undefined && (!Array.isArray(model.input) || !model.input.every(kind => kind === "text" || kind === "image")))) {
        throw bad(`model ${name}/${id} is { contextWindow, maxTokens, reasoning?, input?: ["text", "image"] }`);
      }
    }
  }
}

/**
 * Tenants from one of: AGENT_TENANTS_FILE (the tenants file), AGENT_TENANTS_SECRET_ARN (its JSON in Secrets
 * Manager), AGENT_TENANTS_JSON (its JSON inline), or AGENT_TENANT with AGENT_OPERATOR_TOKEN (one tenant and its
 * operator token, with AGENT_TENANT_API_KEYS its provider keys as {provider: key}: a self-hosted runtime's).
 */
export async function tenantsFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const given = ["AGENT_TENANTS_FILE", "AGENT_TENANTS_SECRET_ARN", "AGENT_TENANTS_JSON", "AGENT_TENANT"].filter(name => env[name]);
  if (given.length > 1) throw new Error(`Set only one of ${given.join(", ")}`);
  if (!given.length) throw new Error("Set AGENT_TENANT and AGENT_OPERATOR_TOKEN, or AGENT_TENANTS_FILE, AGENT_TENANTS_JSON or AGENT_TENANTS_SECRET_ARN to the tenants file");
  const inline = env.AGENT_TENANT ? JSON.stringify(singleTenant(env)) : env.AGENT_TENANTS_JSON;
  const tenants = new Tenants(inline !== undefined
    ? { read: async () => inline, env: true }
    : { file: env.AGENT_TENANTS_FILE || undefined, read: env.AGENT_TENANTS_SECRET_ARN ? await secretReader(env.AGENT_TENANTS_SECRET_ARN, env) : undefined });
  await tenants.reload();
  return tenants;
}

function singleTenant(env: NodeJS.ProcessEnv) {
  const token = env.AGENT_OPERATOR_TOKEN;
  if (!token) throw new Error("AGENT_TENANT needs AGENT_OPERATOR_TOKEN, the tenant's operator token");
  if (token.length < 24) throw new Error("AGENT_OPERATOR_TOKEN must be at least 24 characters");
  let apiKeys: unknown = {};
  if (env.AGENT_TENANT_API_KEYS) {
    try { apiKeys = JSON.parse(env.AGENT_TENANT_API_KEYS); } catch { apiKeys = undefined; }
    if (!apiKeys || typeof apiKeys !== "object" || Array.isArray(apiKeys) || Object.values(apiKeys).some(key => typeof key !== "string" || !key)) {
      throw new Error("AGENT_TENANT_API_KEYS must be a JSON object of provider keys, {\"anthropic\": \"sk-...\"}");
    }
  }
  return { tenants: { [env.AGENT_TENANT!]: { tokenSha256: sha256(token), apiKeys } } };
}

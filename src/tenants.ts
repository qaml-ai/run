import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { getProviders } from "@earendil-works/pi-ai/compat";
import { secretReader } from "./secrets.ts";
import { UPSTREAMS, type ModelEndpoint } from "./session-config.ts";

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
  /** GitHub login that signs in to the console as this tenant. */
  github?: string;
  /** Agents this tenant may have hosted at once on each node; overrides AGENT_MAX_AGENTS_PER_TENANT. */
  maxAgents?: number;
  /** Read-only event-stream subscribers (browser tabs) its agents may have at once on a node; default 1024. */
  maxWatchers?: number;
  /** Model spend (USD, list prices) this tenant may reach per UTC month; absent means unlimited. */
  maxMonthlyCost?: number;
  /** "prepaid": pays from credit (src/billing.ts), and may use the platform's keys. Admin tenants default to "none", unbilled. */
  billing?: "prepaid" | "none";
  /** The tenant's own pass-through model endpoints, by the provider name its models are named under (`<name>/<provider>/<model id>`). */
  modelEndpoints?: Record<string, ModelEndpoint>;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const validTenantId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);

export class Tenants {
  private byId = new Map<string, Tenant>();
  /** The platform's own provider keys (the file's `platformKeys`): prepaid tenants without a key of their own use them. */
  private platform: Record<string, string> = {};
  private readonly file?: string;
  private readonly read?: () => Promise<string>;

  /** `read` returns the tenants file's JSON from elsewhere (a secret); the tenants are empty until `reload`. */
  constructor(options: { file?: string; read?: () => Promise<string> }) {
    if (options.file && options.read) throw new Error("Set AGENT_TENANTS_FILE or AGENT_TENANTS_SECRET_ARN, not both");
    if (!options.file && !options.read) throw new Error("Set AGENT_TENANTS_FILE or AGENT_TENANTS_SECRET_ARN to the tenants file");
    this.file = options.file;
    this.read = options.read;
    if (options.file) this.parse(readFileSync(options.file, "utf8"));
  }

  get source() { return this.file ? "file" : "secret"; }

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
      if (tenant.maxAgents !== undefined && (!Number.isSafeInteger(tenant.maxAgents) || tenant.maxAgents < 1)) throw new Error(`Tenant ${tenant.id} has an invalid maxAgents: a positive integer, or absent for the default`);
      if (tenant.maxWatchers !== undefined && (!Number.isSafeInteger(tenant.maxWatchers) || tenant.maxWatchers < 1)) throw new Error(`Tenant ${tenant.id} has an invalid maxWatchers: a positive integer, or absent for the default`);
      if (tenant.maxMonthlyCost !== undefined && (typeof tenant.maxMonthlyCost !== "number" || !Number.isFinite(tenant.maxMonthlyCost) || tenant.maxMonthlyCost < 0)) throw new Error(`Tenant ${tenant.id} has an invalid maxMonthlyCost: a non-negative number of USD, or absent for no limit`);
      if (tenant.billing !== undefined && tenant.billing !== "prepaid" && tenant.billing !== "none") throw new Error(`Tenant ${tenant.id} has an invalid billing: "prepaid", "none", or absent for none`);
      if (tenant.modelEndpoints !== undefined) validEndpoints(tenant.id, tenant.modelEndpoints);
      next.set(tenant.id, {
        id: tenant.id, tokenSha256: tenant.tokenSha256, apiKeys: { ...(tenant.apiKeys ?? {}) }, ...(tenant.github ? { github: tenant.github } : {}),
        ...(tenant.maxAgents !== undefined ? { maxAgents: tenant.maxAgents } : {}), ...(tenant.maxWatchers !== undefined ? { maxWatchers: tenant.maxWatchers } : {}), ...(tenant.maxMonthlyCost !== undefined ? { maxMonthlyCost: tenant.maxMonthlyCost } : {}),
        ...(tenant.billing ? { billing: tenant.billing } : {}), ...(tenant.modelEndpoints ? { modelEndpoints: tenant.modelEndpoints } : {}),
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

  /** The admin-defined tenant a GitHub login signs in as, if any (case-insensitive). */
  byGithub(login: string) {
    for (const tenant of this.byId.values()) if (tenant.github?.toLowerCase() === login.toLowerCase()) return tenant.id;
    return undefined;
  }

  /** The tenant's own hosted-agent limit per node, if its entry sets one. */
  maxAgents(id: string) { return this.byId.get(id)?.maxAgents; }
  maxWatchers(id: string) { return this.byId.get(id)?.maxWatchers; }

  /** The tenant's monthly spend cap in USD, if its entry sets one. */
  maxMonthlyCost(id: string) { return this.byId.get(id)?.maxMonthlyCost; }

  /** How an admin tenant is billed; undefined for tenants not in the file. */
  billing(id: string) { const tenant = this.byId.get(id); return tenant && (tenant.billing ?? "none"); }

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

/** Tenants from AGENT_TENANTS_SECRET_ARN (the tenants file's JSON in Secrets Manager) or AGENT_TENANTS_FILE. */
export async function tenantsFromEnvironment(env = process.env) {
  const tenants = new Tenants({
    file: env.AGENT_TENANTS_FILE, read: env.AGENT_TENANTS_SECRET_ARN ? await secretReader(env.AGENT_TENANTS_SECRET_ARN, env) : undefined,
  });
  await tenants.reload();
  return tenants;
}

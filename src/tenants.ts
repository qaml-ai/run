import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { secretReader } from "./secrets.ts";

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
  /** Model spend (USD, list prices) this tenant may reach per UTC month; absent means unlimited. */
  maxMonthlyCost?: number;
  /** "prepaid": pays from credit (src/billing.ts), and may use the platform's keys. Admin tenants default to "none", unbilled. */
  billing?: "prepaid" | "none";
}

/** The single-token mode used before tenants existed; its agents keep their original IDs. */
export const DEFAULT_TENANT = "default";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const validTenantId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);

export class Tenants {
  private byId = new Map<string, Tenant>();
  /** The platform's own provider keys (the file's `platformKeys`): prepaid tenants without a key of their own use them. */
  private platform: Record<string, string> = {};
  /** Legacy mode: one operator token from AGENT_RUNTIME_TOKEN, no tenants file or secret. */
  readonly legacy: boolean;
  private readonly file?: string;
  private readonly read?: () => Promise<string>;

  /** `read` returns the tenants file's JSON from elsewhere (a secret); the tenants are empty until `reload`. */
  constructor(options: { file?: string; read?: () => Promise<string>; legacyToken?: string; legacyApiKey?: string }) {
    if (options.file && options.read) throw new Error("Set AGENT_TENANTS_FILE or AGENT_TENANTS_SECRET_ARN, not both");
    this.file = options.file;
    this.read = options.read;
    this.legacy = !options.file && !options.read;
    if (options.file) this.parse(readFileSync(options.file, "utf8"));
    else if (this.legacy) {
      if (!options.legacyToken || options.legacyToken.length < 24) throw new Error("Set AGENT_TENANTS_FILE or AGENT_TENANTS_SECRET_ARN, or AGENT_RUNTIME_TOKEN to at least 24 random characters");
      this.set([{ id: DEFAULT_TENANT, tokenSha256: sha256(options.legacyToken), apiKeys: options.legacyApiKey ? { "*": options.legacyApiKey } : {} }]);
    }
  }

  get source() { return this.file ? "file" : this.read ? "secret" : "single"; }

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
      if (!tenant.apiKeys || typeof tenant.apiKeys !== "object" || Object.values(tenant.apiKeys).some(key => typeof key !== "string" || !key)) throw new Error(`Tenant ${tenant.id} has invalid apiKeys`);
      hashes.add(tenant.tokenSha256);
      if (tenant.github !== undefined && (typeof tenant.github !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(tenant.github))) throw new Error(`Tenant ${tenant.id} has an invalid github login`);
      if (tenant.maxAgents !== undefined && (!Number.isSafeInteger(tenant.maxAgents) || tenant.maxAgents < 1)) throw new Error(`Tenant ${tenant.id} has an invalid maxAgents: a positive integer, or absent for the default`);
      if (tenant.maxMonthlyCost !== undefined && (typeof tenant.maxMonthlyCost !== "number" || !Number.isFinite(tenant.maxMonthlyCost) || tenant.maxMonthlyCost < 0)) throw new Error(`Tenant ${tenant.id} has an invalid maxMonthlyCost: a non-negative number of USD, or absent for no limit`);
      if (tenant.billing !== undefined && tenant.billing !== "prepaid" && tenant.billing !== "none") throw new Error(`Tenant ${tenant.id} has an invalid billing: "prepaid", "none", or absent for none`);
      next.set(tenant.id, {
        id: tenant.id, tokenSha256: tenant.tokenSha256, apiKeys: { ...tenant.apiKeys }, ...(tenant.github ? { github: tenant.github } : {}),
        ...(tenant.maxAgents !== undefined ? { maxAgents: tenant.maxAgents } : {}), ...(tenant.maxMonthlyCost !== undefined ? { maxMonthlyCost: tenant.maxMonthlyCost } : {}),
        ...(tenant.billing ? { billing: tenant.billing } : {}),
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

  /** The tenant's monthly spend cap in USD, if its entry sets one. */
  maxMonthlyCost(id: string) { return this.byId.get(id)?.maxMonthlyCost; }

  /** How an admin tenant is billed; undefined for tenants not in the file. */
  billing(id: string) { const tenant = this.byId.get(id); return tenant && (tenant.billing ?? "none"); }

  /** The platform's key for `provider` (`*` covers any provider). */
  platformKey(provider: string): string | undefined { return this.platform[provider] ?? this.platform["*"]; }

  /** Providers the platform has keys for. Names only. */
  platformProviders() { return Object.keys(this.platform); }

  /** Providers an admin configured keys for (`*` covers any provider). Names only. */
  providers(id: string) { return Object.keys(this.byId.get(id)?.apiKeys ?? {}); }

  /** The key an agent of `tenantId` uses for `provider`; `*` is a tenant-wide fallback. */
  apiKey(tenantId: string, provider: string): string | undefined {
    const keys = this.byId.get(tenantId)?.apiKeys;
    return keys?.[provider] ?? keys?.["*"];
  }
}

/** Tenants from AGENT_TENANTS_SECRET_ARN (the tenants file's JSON in Secrets Manager), AGENT_TENANTS_FILE, or the single-token mode. */
export async function tenantsFromEnvironment(env = process.env) {
  const tenants = new Tenants({
    file: env.AGENT_TENANTS_FILE, read: env.AGENT_TENANTS_SECRET_ARN ? await secretReader(env.AGENT_TENANTS_SECRET_ARN, env) : undefined,
    legacyToken: env.AGENT_RUNTIME_TOKEN, legacyApiKey: env.AGENT_API_KEY,
  });
  await tenants.reload();
  return tenants;
}

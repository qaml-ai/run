import { Accounts } from "./accounts.ts";
import { Tenants } from "./tenants.ts";
import { KeyScopes } from "./key-scopes.ts";
import { ModelProviders } from "./model-providers.ts";
import { Outbound } from "./security-outbound.ts";
import { createStripe, type BillingEnv } from "./billing-routes.ts";
import { database } from "./postgres.ts";
import { pricingFromEnvironment } from "../../../src/pricing.ts";
import { modelAzure, type ModelAzureEnv } from "./model-azure.ts";
import { federationFor, type FederationEnv } from "./anthropic-federation.ts";

export type PricingEnv = Partial<Record<
  | `AGENT_PRICE_${string}`
  | "AGENT_OPENROUTER_CREDIT_MULTIPLIER" | "AGENT_CREDIT_FEE_PERCENT"
  | "AGENT_CREDIT_MIN_PURCHASE_USD" | "AGENT_CREDIT_MAX_PURCHASE_USD"
  | "AGENT_CREDIT_GRANT_USD" | "AGENT_CARD_CREDIT_USD"
  | "AGENT_MAX_STORAGE_GB" | "AGENT_FREE_MAX_STORAGE_GB"
  | "AGENT_FREE_HOURLY_SPEND_USD" | "AGENT_FREE_MAX_AGENTS" | "AGENT_USAGE_TIERS"
  | "AGENT_MAX_AGENTS" | "AGENT_MAX_AGENTS_PER_TENANT", string>>;

export type SecurityEnv = BillingEnv & PricingEnv & ModelAzureEnv & FederationEnv & {
  AGENT_SECRETS_KEY?: string;
  AGENT_TENANTS_JSON?: string;
  AGENT_PUBLIC_URL?: string;
  AGENT_BILLING_ADMINS?: string;
  AGENT_OUTBOUND_ALLOW_HTTP?: string;
  AGENT_OUTBOUND_ALLOW_CIDRS?: string;
  AGENT_OUTBOUND_BLOCK_CIDRS?: string;
};
export type KeyEnv = SecurityEnv;
/** Operator configuration is a Worker secret, never a local file or an AWS lookup. */
export async function createTenants(env: Pick<SecurityEnv, "AGENT_TENANTS_JSON">) {
  const tenants = new Tenants({ read: async () => env.AGENT_TENANTS_JSON ?? '{"tenants":{}}', env: true });
  await tenants.reload();
  return tenants;
}
/** Request-scoped services keep connections and cached credentials out of global isolate state. */
export async function keyServices(env: SecurityEnv) {
  const tenants = await createTenants(env), db = database(env);
  const positive = (name: "AGENT_MAX_AGENTS" | "AGENT_MAX_AGENTS_PER_TENANT", fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const maxAgents = positive("AGENT_MAX_AGENTS", 8);
  const accounts = new Accounts({ tenants, db, secretsKey: env.AGENT_SECRETS_KEY, stripe: createStripe(env), azureOpenAI: modelAzure(env), anthropicFederation: federationFor(env),
    publicUrl: env.AGENT_PUBLIC_URL ?? env.PUBLIC_URL, pricing: pricingFromEnvironment(env as unknown as NodeJS.ProcessEnv),
    maxAgentsPerTenant: positive("AGENT_MAX_AGENTS_PER_TENANT", Math.max(1, Math.ceil(maxAgents / 2))) });
  const split = (value?: string) => value?.split(",").map(s => s.trim()).filter(Boolean);
  const outbound = new Outbound({
    allowHttp: env.TEST_MODE === "1" && env.AGENT_OUTBOUND_ALLOW_HTTP === "true",
    allow: env.TEST_MODE === "1" ? split(env.AGENT_OUTBOUND_ALLOW_CIDRS) : undefined,
    block: split(env.AGENT_OUTBOUND_BLOCK_CIDRS),
  });
  const keyScopes = new KeyScopes({ accounts, db, outbound });
  const modelProviders = new ModelProviders({ accounts, db, outbound });
  modelProviders.onDelete = (tenant, provider) => keyScopes.forgetProvider(tenant, provider);
  return { accounts, tenants, keyScopes, modelProviders, outbound };
}
export type KeyServices = Awaited<ReturnType<typeof keyServices>>;

/** Resolve at each model call: scope override, custom provider, tenant/admin key, then permitted platform key. */
export type ResolvedProviderCredentials = {
  apiKey?: string; baseUrl?: string; headers?: Record<string, string>; region?: string; bearer?: true;
  source: "tenant" | "admin" | "platform"; platform: boolean;
};
export async function providerCredentials(services: KeyServices, tenant: string, provider: string, scope?: string | null): Promise<ResolvedProviderCredentials | undefined> {
  const custom = await services.modelProviders.credentials(tenant, provider, scope);
  const scoped = scope ? await services.keyScopes.entry(tenant, scope, provider) : undefined;
  if (scoped) return { ...custom, ...scoped, source: "tenant" as const, platform: false };
  if (custom) return { ...custom, source: "tenant" as const, platform: false };
  const key = await services.accounts.providerKey(tenant, provider);
  return key && { apiKey: key.key, source: key.source, platform: key.source === "platform", ...(key.region ? { region: key.region } : {}), ...(key.bearer ? { bearer: key.bearer } : {}) };
}

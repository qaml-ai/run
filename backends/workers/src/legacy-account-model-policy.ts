import { z } from "zod";
import type { Accounts } from "./accounts.ts";
import { defaultModels } from "./default-model-policy.ts";
import { modelReference, resolveModel } from "./model-policy.ts";

const tenantPolicy = z.object({
  ownProviders: z.array(z.string().min(1)),
  platform: z.boolean(),
  github: z.string().min(1).optional(),
}).strict();

const policySchema = z.object({
  model: z.string().min(1),
  fallbacks: z.string().optional(),
  canStoreKeys: z.boolean(),
  platformProviders: z.array(z.string().min(1)),
  azureModels: z.array(z.string().min(1)),
  tenants: z.record(z.string(), tenantPolicy),
}).strict();

async function legacyModelPolicy(snapshot: string, accounts: Accounts, tenantId: string) {
  const policy = policySchema.parse(JSON.parse(snapshot));
  const tenant = Object.hasOwn(policy.tenants, tenantId) ? policy.tenants[tenantId] : undefined;
  const own = new Set(tenant?.ownProviders);
  if (policy.canStoreKeys) {
    const { rows } = await accounts.db.query<{ provider: string }>("select provider from provider_keys where tenant = $1", [tenantId]);
    for (const { provider } of rows) own.add(provider);
  }
  return { policy, tenant, own };
}

/** The snapshot carries availability without granting access to provider credentials. */
export async function legacyKeyedProviders(snapshot: string, accounts: Accounts, tenantId: string) {
  const { policy, tenant, own } = await legacyModelPolicy(snapshot, accounts, tenantId);
  const platform = tenant?.platform ?? (await accounts.billing.readTenant(tenantId)).mode === "prepaid";
  return (provider: string, model: string) => provider === "azure"
    ? platform && policy.azureModels.includes(model)
    : own.has(provider) || (platform && policy.platformProviders.includes(provider));
}

/** This snapshot carries provider availability, without provider credentials or permission to call a model. */
export async function legacyAccountModelPolicy(snapshot: string, accounts: Accounts, tenantId: string) {
  const { policy, tenant, own } = await legacyModelPolicy(snapshot, accounts, tenantId);
  const candidates = defaultModels(resolveModel(policy.model), policy.fallbacks);
  const firstOwned = candidates.find(model => model.provider !== "azure" && own.has(model.provider));
  const platform = firstOwned ? false : (tenant?.platform ?? (await accounts.billing.readTenant(tenantId)).mode === "prepaid");
  const firstPlatform = platform && candidates.find(model => model.provider === "azure"
    ? policy.azureModels.includes(model.id)
    : policy.platformProviders.includes(model.provider));
  return { configuredGithub: tenant?.github, canStoreKeys: policy.canStoreKeys,
    defaultModel: modelReference(firstOwned || firstPlatform || candidates[0]) };
}

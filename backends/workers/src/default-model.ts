import { defaultModels } from "./default-model-policy.ts";
import { modelReference, resolveModel } from "./model-policy.ts";
import { keyServices, type KeyEnv } from "./security-services.ts";

export type DefaultModelEnv = KeyEnv & { MODEL: string; AGENT_MODEL_FALLBACKS?: string };

/** Prefer a tenant's own credentials before borrowing any platform model key. */
export async function defaultModelFor(env: DefaultModelEnv, tenant: string, keyScope?: string) {
  if (env.MODEL.startsWith("test/") || env.MODEL.startsWith("camel-test/") || env.MODEL.startsWith("cloudflare/") || env.MODEL.startsWith("@cf/")) return env.MODEL;
  const { accounts, keyScopes } = await keyServices(env);
  const candidates = defaultModels(resolveModel(env.MODEL), env.AGENT_MODEL_FALLBACKS);
  const own = await accounts.ownProviders(tenant);
  for (const model of candidates) {
    if (own(model.provider) || (keyScope && await keyScopes.entry(tenant, keyScope, model.provider))) return modelReference(model);
  }
  const keyed = await accounts.keyedProviders(tenant);
  for (const model of candidates) if (keyed(model.provider, model.id)) return modelReference(model);
  return modelReference(candidates[0]);
}

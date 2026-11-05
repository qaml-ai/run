import { defaultModels } from "./default-model-policy.ts";
import { modelReference, resolveModel, modelSettingsRefusal } from "./model-policy.ts";
import { keyServices, type KeyEnv } from "./security-services.ts";
import type { AgentConfiguration } from "./api-contract.ts";
import { ApiError } from "./api-contract.ts";

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

/** Refuse invalid declarations before creating agent rows or private volumes. */
export async function validateAgentModel(env: DefaultModelEnv, tenant: string, config: AgentConfiguration) {
  const reference = config.model ?? env.MODEL;
  if (reference.startsWith("test/") || reference.startsWith("camel-test/") || reference.startsWith("cloudflare/") || reference.startsWith("@cf/")) return;
  const services = await keyServices(env);
  try {
    const model = resolveModel(reference, services.tenants.modelEndpoints(tenant), await services.modelProviders.resolvable(tenant, config.keyScope));
    const refusal = modelSettingsRefusal(model, config);
    if (refusal) throw new Error(refusal);
  } catch (error) { throw new ApiError(400, (error as Error).message); }
}

import { defaultModels } from "./default-model-policy.ts";
import { modelReference, resolveModel, modelSettingsRefusal } from "./model-policy.ts";
import { keyServices, type KeyEnv } from "./security-services.ts";
import type { AgentConfiguration } from "./api-contract.ts";
import { ApiError } from "./api-contract.ts";
import { withOpenRouterDetails } from "./openrouter-details.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

export type DefaultModelEnv = KeyEnv & { MODEL: string; AGENT_MODEL_FALLBACKS?: string; AGENT_OPENROUTER_API_URL?: string };

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

/** A reconfiguration needs a usable key, but must not exchange a short-lived token. */
export async function configurationModelError(env: DefaultModelEnv, tenant: string, config: AgentConfiguration): Promise<string | undefined> {
  const reference = config.model ?? env.MODEL;
  if (/^(?:test|camel-test|cloudflare)\//.test(reference) || reference.startsWith("@cf/")) return;
  const { accounts, keyScopes, modelProviders, tenants } = await keyServices(env);
  const custom = await modelProviders.resolvable(tenant, config.keyScope);
  const endpoints = tenants.modelEndpoints(tenant);
  const model = resolveModel(reference, endpoints, custom);
  if (endpoints?.[model.provider] || Object.hasOwn(custom, model.provider) ||
      config.keyScope && await keyScopes.entry(tenant, config.keyScope, model.provider) ||
      await accounts.hasKey(tenant, model.provider, model.id)) return;
  return model.provider === "azure"
    ? `No azure deployment is configured for azure/${model.id} on this runtime for this tenant; choose a model from GET /v1/models?available=true`
    : `No ${model.provider} API key is configured for this tenant; set one with PUT /v1/providers/${model.provider}/key`;
}

/** Refuse invalid declarations before creating agent rows or private volumes. */
export async function validateAgentModel(env: DefaultModelEnv, tenant: string, config: AgentConfiguration, previous?: { reference?: string; model?: Model<Api> }): Promise<Model<Api> | undefined> {
  const reference = config.model ?? env.MODEL;
  if (reference.startsWith("test/") || reference.startsWith("camel-test/") || reference.startsWith("cloudflare/") || reference.startsWith("@cf/")) return;
  const services = await keyServices(env);
  try {
    const resolved = resolveModel(reference, services.tenants.modelEndpoints(tenant), await services.modelProviders.resolvable(tenant, config.keyScope));
    const model = (resolved as { passthrough?: true }).passthrough && previous?.reference === reference && previous.model
      ? previous.model
      : await withOpenRouterDetails(resolved, env.AGENT_OPENROUTER_API_URL, (input, init) => services.outbound.fetch(String(input), { ...init, timeoutMs: 5000, maxBytes: 1024 * 1024 }));
    const refusal = modelSettingsRefusal(model, config);
    if (refusal) throw new Error(refusal);
    return model;
  } catch (error) { throw new ApiError(400, (error as Error).message); }
}

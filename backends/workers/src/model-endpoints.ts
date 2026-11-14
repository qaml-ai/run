import type { AgentInvocation } from "./agent-invocation.ts";
import { keyServices, providerCredentials, type KeyEnv } from "./security-services.ts";
import { signRuntimeIdentity, type RuntimeIdentity } from "./tool-identity.ts";
import { azureChatCredentials } from "./azure-policy.ts";

/** Tenant endpoints receive a fresh signed identity for each provider request. */
export async function resolveModelCredentials(
  env: KeyEnv,
  tenant: string,
  provider: string,
  identity: { issuer: string; claims: RuntimeIdentity },
  keyScope?: string,
  invocation?: AgentInvocation,
) {
  const services = await keyServices(env);
  const endpoint = services.tenants.modelEndpoints(tenant)?.[provider];
  if (endpoint) return {
    apiKey: await signRuntimeIdentity(env, identity.issuer, endpoint.baseUrl, identity.claims),
    identity: true as const,
  };
  const credential = await providerCredentials(services, tenant, provider, keyScope, invocation?.tenant(services.accounts.billing, tenant));
  return provider === "azure" && credential && services.accounts.azureChat
    ? { ...credential, ...azureChatCredentials(services.accounts.azureChat) }
    : credential;
}

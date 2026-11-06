import { anthropicFederationFromEnvironment, type AnthropicFederation } from "./anthropic-federation-policy.ts";

export type FederationEnv = Partial<Record<
  | "AGENT_ANTHROPIC_FEDERATION_RULE_ID" | "AGENT_ANTHROPIC_ORGANIZATION_ID"
  | "AGENT_ANTHROPIC_SERVICE_ACCOUNT_ID" | "AGENT_ANTHROPIC_WORKSPACE_ID"
  | "AGENT_ANTHROPIC_FEDERATION_STS_REGION" | "AWS_REGION"
  | "TEST_ANTHROPIC_FEDERATION_ENDPOINT" | "TEST_MODE", string>> & {
  /** An operator-owned signer returns { WebIdentityToken } for the STS command body. */
  ANTHROPIC_FEDERATION_STS?: Fetcher;
};

const publicCache = new Map<string, AnthropicFederation>();
const signerCaches = new WeakMap<Fetcher, Map<string, AnthropicFederation>>();

/** Cache only short-lived federation tokens; tenant and scope keys bypass this service. */
export function federationFor(env: FederationEnv): AnthropicFederation | undefined {
  const config = Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("AGENT_ANTHROPIC_") || name === "AWS_REGION")) as Record<string, string | undefined>;
  if (!Object.values(config).some(Boolean)) return undefined;
  let endpoint: URL | undefined;
  if (env.TEST_MODE === "1" && env.TEST_ANTHROPIC_FEDERATION_ENDPOINT) {
    endpoint = new URL(env.TEST_ANTHROPIC_FEDERATION_ENDPOINT);
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))
      throw new Error("Federation test endpoint must be loopback HTTP");
  }
  const signer = env.ANTHROPIC_FEDERATION_STS;
  const cache = signer ? signerCaches.get(signer) ?? new Map<string, AnthropicFederation>() : publicCache;
  if (signer) signerCaches.set(signer, cache);
  const key = JSON.stringify([config, endpoint?.href]);
  const found = cache.get(key);
  if (found) return found;
  const send = endpoint || signer ? async (command: { input: unknown }, options: { abortSignal: AbortSignal }) => {
    const url = endpoint ? new URL("/sts", endpoint) : "https://sts.anthropic-federation.internal/";
    const request = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command.input), signal: options.abortSignal });
    const response = signer ? await signer.fetch(request) : await fetch(request);
    if (!response.ok) { await response.body?.cancel(); throw new Error("STS request failed"); }
    return await response.json() as { WebIdentityToken?: string };
  } : undefined;
  // The policy refuses redirects itself (fetchWithoutRedirects), so the one-use assertion is never forwarded.
  const tokenFetch: typeof fetch = (input, init) => fetch(endpoint ? new URL("/v1/oauth/token", endpoint) : input, init);
  const federation = anthropicFederationFromEnvironment(config, { ...(send ? { sts: { send } } : {}), fetch: tokenFetch });
  if (federation) {
    if (cache.size >= 16) cache.delete(cache.keys().next().value!);
    cache.set(key, federation);
  }
  return federation;
}

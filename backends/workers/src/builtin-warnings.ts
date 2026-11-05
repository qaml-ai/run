import { keyServices, type KeyEnv } from "./security-services.ts";
import { searchProvidersFromEnvironment, webSearchUnavailable } from "./web-search-policy.ts";
import { xSearchUnavailable } from "./x-search-policy.ts";

/** Save-time warnings describe enabled capabilities whose provider keys cannot resolve. */
export async function builtinWarnings(env: KeyEnv & { AGENT_WEB_SEARCH_PROVIDERS?: string }, tenant: string,
  sources: { builtins?: readonly string[]; webSearch?: { providers: readonly string[] } }) {
  const { builtins = [] } = sources;
  if (!["web_search", "x_search", "generate_image", "decide"].some(name => builtins.includes(name))) return {};
  const { accounts } = await keyServices(env);
  const has = await accounts.keyedProviders(tenant);
  const providers = sources.webSearch?.providers ?? searchProvidersFromEnvironment({ AGENT_WEB_SEARCH_PROVIDERS: env.AGENT_WEB_SEARCH_PROVIDERS }).order;
  const warnings = [
    ...builtins.includes("web_search") && !providers.some(provider => has(provider)) ? [webSearchUnavailable(providers)] : [],
    ...builtins.includes("x_search") && !has("xai") ? [xSearchUnavailable()] : [],
    ...builtins.includes("generate_image") && !has("openai") ? ["generate_image can't make images for this account: add an OpenAI key under Models & keys (PUT /v1/providers/openai/key)"] : [],
    ...builtins.includes("decide") && !has("openrouter") ? ["decide can't answer for this account: add an OpenRouter key under Models & keys (PUT /v1/providers/openrouter/key)"] : [],
  ];
  return warnings.length ? { warnings } : {};
}

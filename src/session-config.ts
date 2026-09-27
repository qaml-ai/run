import { getModel } from '@earendil-works/pi-ai/compat';
import type { AgentConfig } from './protocol.ts';
import { validateDefinitions } from './tool-policy.ts';
import { validateInitialMessages } from './history.ts';
import { attachedTools } from './mcp-results.ts';
import { checkScope } from './key-scopes.ts';
import { openRouterApi } from './catalog.ts';
import { HttpError } from './http.ts';

type SessionConfig = Omit<AgentConfig, 'id' | 'directory' | 'tools' | 'apiKey'>;

const endpoint = (value: string) => { const url = new URL(value); return `${url.origin}${url.pathname.replace(/\/+$/, '')}`; };

/**
 * The host's provider key is sent to whatever endpoint the model names, so an
 * agent may only use an endpoint the host already trusts: the default model's,
 * Pi's published endpoint for that provider and model, or an operator allowlist.
 */
export function assertTrustedEndpoint(model: AgentConfig['model'], defaultModel: AgentConfig['model'], allowedBaseUrls: string[] = []) {
  const target = endpoint(model.baseUrl);
  const published = (getModel as (provider: string, id: string) => AgentConfig['model'] | undefined)(model.provider, model.id)?.baseUrl;
  const trusted = [defaultModel.baseUrl, ...(published ? [published] : []), ...allowedBaseUrls].map(endpoint);
  if (!trusted.includes(target)) throw new Error(`Model endpoint ${target} is not trusted by this runtime; add it to AGENT_ALLOWED_BASE_URLS`);
}

/** What a model on a tenant's own endpoint can do, for a model the catalog lacks. */
export type EndpointModel = { contextWindow: number; maxTokens: number; reasoning?: boolean; input?: ('text' | 'image')[] };
/**
 * A tenant's own model endpoint, named as a provider in the tenants file: a pass-through
 * gateway where `<baseUrl>/<provider>` stands for that provider's API (`UPSTREAMS`). Pi speaks the
 * provider's own protocol to it with the runtime's identity token as the key; the endpoint swaps in
 * the real credential and meters, so calls cost the runtime nothing. `models` declares models Pi's
 * catalog lacks, by the model reference after `<name>/`.
 */
export type ModelEndpoint = { baseUrl: string; models?: Record<string, EndpointModel> };
/** A tenant's model endpoints by provider name. */
export type ModelEndpoints = Record<string, ModelEndpoint> | undefined;

/**
 * The providers an endpoint forwards to: the API root `<endpoint>/<provider>` maps onto, and the API
 * Pi speaks to it. OpenRouter's models use its Responses API (stateless), except Anthropic's, which
 * keep its Messages API: Responses gets them no prompt caching. Bedrock's root is regional: its
 * models are named with their region (`amazon-bedrock/<region>/<model id>`), which ends up in the path.
 * `openai-codex` is ChatGPT's Codex backend, for a ChatGPT subscription.
 */
export const UPSTREAMS: Record<string, { root: string; api: string; path?: string }> = {
  anthropic: { root: 'https://api.anthropic.com', api: 'anthropic-messages' },
  openai: { root: 'https://api.openai.com/v1', api: 'openai-responses' },
  openrouter: { root: 'https://openrouter.ai/api', api: 'openai-responses', path: '/v1' },
  google: { root: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai' },
  'amazon-bedrock': { root: 'https://bedrock-runtime.<region>.amazonaws.com', api: 'bedrock-converse-stream' },
  'openai-codex': { root: 'https://chatgpt.com/backend-api', api: 'openai-codex-responses' },
};

const lookup = getModel as (provider: string, id: string) => AgentConfig['model'] | undefined;


/**
 * `<name>/<provider>/<model id>` on a tenant's endpoint: the catalog's (or the endpoint's declared)
 * model, called at `<endpoint>/<provider>`, at no cost. Its id keeps the provider (and Bedrock's
 * region), which Pi's calls take back out (`compaction.ts`). A routing variant (`…:nitro`) is
 * looked up without it and sent with it.
 */
function endpointModel(name: string, id: string, endpoint: ModelEndpoint): AgentConfig['model'] {
  const [provider, ...rest] = id.split('/');
  const region = provider === 'amazon-bedrock' ? rest.shift() : undefined;
  const modelId = rest.join('/');
  if (!Object.hasOwn(UPSTREAMS, provider) || !modelId) throw new Error(`Model "${name}/${id}" must be "${name}/<provider>/<model id>" with a provider among ${Object.keys(UPSTREAMS).join(', ')}`);
  if (region !== undefined && !/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) throw new Error(`Model "${name}/${id}" must be "${name}/amazon-bedrock/<region>/<model id>"`);
  const known = lookup(provider, modelId) ?? lookup(provider, modelId.replace(/:[a-z]+$/, ''));
  const declared = endpoint.models?.[id];
  if (!known && !declared) throw new Error(`Unknown model "${name}/${id}": declare it in the ${name} endpoint's models, or name a model in GET /v1/models`);
  const upstream = UPSTREAMS[provider];
  const api = provider === 'openrouter' ? openRouterApi(known?.api ?? upstream.api) : known?.api === 'anthropic-messages' ? 'anthropic-messages' : upstream.api;
  const path = region ? `/${region}` : api === 'anthropic-messages' ? '' : upstream.path ?? '';
  return {
    reasoning: false, input: ['text'], ...known, name: known?.name ?? id, ...declared, id, provider: name, api,
    baseUrl: `${endpoint.baseUrl}/${provider}${path}`, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as AgentConfig['model'];
}

/**
 * Resolve a model reference like `anthropic/claude-sonnet-5` or
 * `openrouter/anthropic/claude-opus-4.8` (provider, then model id) from Pi's catalog, or from
 * the tenant's own `endpoints`. Catalog models use their provider's published endpoint, and
 * endpoints are the operator's, so both are trusted.
 */
export function resolveModel(reference: string, endpoints?: ModelEndpoints): AgentConfig['model'] {
  if (typeof reference !== 'string') throw new Error('model must be a "provider/model-id" string');
  const slash = reference.indexOf('/');
  if (slash <= 0 || slash === reference.length - 1) throw new Error(`Model "${reference}" must be written as "provider/model-id"; see GET /v1/models`);
  const provider = reference.slice(0, slash);
  if (endpoints && Object.hasOwn(endpoints, provider)) return endpointModel(provider, reference.slice(slash + 1), endpoints[provider]);
  const model = lookup(provider, reference.slice(slash + 1));
  if (!model) throw new Error(`Unknown model "${reference}"; see GET /v1/models`);
  return provider === 'openrouter' ? { ...model, api: openRouterApi(model.api) } as AgentConfig['model'] : model;
}

/** Headers only the runtime sets on a model call: credentials, identity, and AWS signing. */
const RESERVED_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key', 'cf-aig-authorization', 'chatgpt-account-id', 'x-agent-runtime-identity', 'host', 'content-length', 'content-type', 'transfer-encoding', 'connection'];

/**
 * An agent's own `modelHeaders`, sent on each of its model calls: at most 20, 8 KB in all, and none
 * that carries a credential or identity (`RESERVED_HEADERS`, `x-amz-*`). Null when there are none.
 */
export function modelHeadersInput(value: unknown): Record<string, string> | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 20) throw new HttpError(400, 'modelHeaders must be an object of at most 20 header names and string values, or null');
  let bytes = 0;
  for (const [name, text] of Object.entries(value)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(name) || typeof text !== 'string' || /[\r\n\0]/.test(text)) throw new HttpError(400, `Invalid model header ${name}`);
    if (RESERVED_HEADERS.includes(name.toLowerCase()) || name.toLowerCase().startsWith('x-amz-')) throw new HttpError(400, `modelHeaders cannot set ${name}: the runtime sets credentials and identity`);
    bytes += name.length + text.length;
  }
  if (bytes > 8192) throw new HttpError(400, 'modelHeaders must be at most 8 KB in all');
  return Object.keys(value).length ? value as Record<string, string> : null;
}

/** Only operator-authenticated provisioning may choose a model, and only among trusted endpoints. */
export function sessionConfig(input: any, defaultModel: AgentConfig['model'], defaultPrompt?: string, allowedBaseUrls: string[] = [], endpoints?: ModelEndpoints): SessionConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid session configuration');
  if ('apiKey' in input) throw new Error('Configure credentials on the runtime host, not in agent configuration');
  const named = typeof input.model === 'string';
  const model = named ? resolveModel(input.model, endpoints) : input.model ?? defaultModel;
  if (!model || typeof model !== 'object' || Array.isArray(model) ||
      ['id', 'name', 'api', 'provider', 'baseUrl'].some(key => typeof model[key] !== 'string' || !model[key]) ||
      typeof model.reasoning !== 'boolean' || !Array.isArray(model.input) || !model.input.every((value: unknown) => value === 'text' || value === 'image') ||
      !Number.isFinite(model.contextWindow) || model.contextWindow <= 0 || !Number.isFinite(model.maxTokens) || model.maxTokens <= 0 ||
      !model.cost || ['input', 'output', 'cacheRead', 'cacheWrite'].some(key => !Number.isFinite(model.cost[key]) || model.cost[key] < 0)) throw new Error('Invalid model configuration');
  const url = new URL(model.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Model baseUrl must be an HTTP(S) endpoint without credentials or query parameters');
  if (model.headers || model.apiKey || model.token) throw new Error('Model credentials and custom headers must be configured on the runtime host');
  // A named model's endpoint is the catalog's or the tenant's own; an endpoint's models can only be named.
  if (!named && endpoints && Object.hasOwn(endpoints, model.provider)) throw new Error(`Name ${model.provider}'s models as "${model.provider}/<provider>/<model id>"`);
  if (!named) assertTrustedEndpoint(model, defaultModel, allowedBaseUrls);
  const updates = configurationUpdate({
    ...(input.systemPrompt !== undefined || defaultPrompt !== undefined ? { systemPrompt: input.systemPrompt !== undefined ? input.systemPrompt : defaultPrompt } : {}),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.systemPromptAppend !== undefined ? { systemPromptAppend: input.systemPromptAppend } : {}),
  });
  if (input.initialMessages !== undefined) validateInitialMessages(input.initialMessages);
  if (input.fileTools !== undefined && typeof input.fileTools !== 'boolean') throw new Error('fileTools must be true or false');
  return { model, ...updates, ...(input.fileTools === false ? { fileTools: false } : {}), ...(input.initialMessages !== undefined ? { initialMessages: input.initialMessages } : {}) };
}

/**
 * Scoped credentials can change behavior, tools and the model, but never a model
 * endpoint or credentials: a model can only be named from Pi's catalog.
 */
export function configurationUpdate(input: any, endpoints?: ModelEndpoints): Pick<AgentConfig, 'systemPrompt' | 'systemPromptAppend' | 'thinkingLevel' | 'modelHeaders'> & { tools?: AgentConfig['tools']; model?: AgentConfig['model']; keyScope?: string | null } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid configuration');
  for (const key of Object.keys(input)) if (!['systemPrompt', 'systemPromptAppend', 'thinkingLevel', 'mcp', 'model', 'keyScope', 'modelHeaders'].includes(key)) throw new Error(`Unsupported scoped configuration field: ${key}`);
  if (input.keyScope !== undefined && input.keyScope !== null) checkScope(input.keyScope);
  // Replaced whole; null or {} removes them.
  if (input.modelHeaders !== undefined) input = { ...input, modelHeaders: modelHeadersInput(input.modelHeaders) };
  // The application's attached MCP server's tools/list replaces its tools.
  if (input.mcp !== undefined) {
    const { mcp, ...rest } = input;
    input = { ...rest, tools: attachedTools(mcp?.tools) };
  }
  if (input.model !== undefined && typeof input.model !== 'string') throw new Error('model must be a "provider/model-id" string');
  if (input.systemPrompt !== undefined && (typeof input.systemPrompt !== 'string' || !input.systemPrompt.trim() || input.systemPrompt.length > 32000)) throw new Error('systemPrompt must contain 1–32000 characters');
  if (input.systemPromptAppend !== undefined && (typeof input.systemPromptAppend !== 'string' || input.systemPromptAppend.length > 32000)) throw new Error('systemPromptAppend must be at most 32000 characters; empty removes it');
  if (input.thinkingLevel !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.thinkingLevel)) throw new Error('Invalid thinkingLevel');
  if (input.tools !== undefined) validateDefinitions(input.tools);
  return { ...input, ...(input.model !== undefined ? { model: resolveModel(input.model, endpoints) } : {}) };
}

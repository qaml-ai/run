import { getModel, temperatureRefusal } from './pi-catalog.ts';
import type { AgentConfig, RunLimits } from './protocol.ts';
import { validateDefinitions } from './tool-policy.ts';
import { validateInitialMessages } from './history.ts';
import { attachedTools } from './mcp-results.ts';
import { checkScope } from './key-scopes.ts';
import { openRouterApi } from './catalog.ts';
import { HttpError } from './http.ts';

type SessionConfig = Omit<AgentConfig, 'id' | 'directory' | 'tools' | 'apiKey'>;

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
 * A model a tenant declares on its own OpenAI-compatible provider (model-providers.ts): its context window, the most
 * it writes in a reply, what it takes in, whether it reasons, its pricing in USD per million tokens (none: free), and
 * `compat`, Pi's switches for servers that differ from OpenAI's.
 */
export type CustomModel = {
  id: string; contextWindow: number; maxOutputTokens?: number; input?: ('text' | 'image')[]; reasoning?: boolean;
  pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }; compat?: Record<string, unknown>;
};
/** The APIs a custom provider may speak, as Pi names them. */
export const CUSTOM_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
/** A tenant's or key scope's own provider, as models are resolved from it: its API, where it is, and its models. */
export type CustomProvider = { type: typeof CUSTOM_APIS[number]; baseUrl: string; models: CustomModel[] };
/** A tenant's custom providers by name. */
export type CustomProviders = Record<string, CustomProvider> | undefined;
/** What a model replies at most when its provider declares no maximum: 8,192 tokens, or half a small context. */
export const DEFAULT_MAX_OUTPUT = 8192;

/** Whose catalog model a custom provider's model of the same id behaves as, by the API it speaks. */
const CATALOG_FOR: Record<CustomProvider['type'], string> = { 'anthropic-messages': 'anthropic', 'openai-responses': 'openai', 'openai-completions': 'openai' };

/**
 * `<name>/<model id>` on a custom provider: Pi's model for its API, as declared. A model the catalog knows by
 * that id (Anthropic's for Anthropic Messages, OpenAI's for OpenAI's APIs: a gateway in front of them) keeps
 * how it is called there, such as which thinking it takes; what is declared wins, and its price is the declared one.
 */
function customModel(name: string, id: string, provider: CustomProvider): AgentConfig['model'] {
  const declared = provider.models.find(model => model.id === id);
  if (!declared) throw new Error(`Unknown model "${name}/${id}": ${name} declares ${provider.models.map(model => model.id).join(', ')}; add it to the provider where it is set (PUT /v1/providers/${name}, or a key scope's /model-providers/${name})`);
  const { pricing, compat } = declared;
  // Providers stored before there were three APIs say openai-compatible: Chat Completions.
  const api = (provider.type as string) === 'openai-compatible' ? 'openai-completions' : provider.type;
  const known = lookup(CATALOG_FOR[api], id);
  const behaviour = known?.api === api ? known : undefined;
  return {
    ...behaviour,
    id, name: id, provider: name, api, baseUrl: provider.baseUrl,
    contextWindow: declared.contextWindow, maxTokens: declared.maxOutputTokens ?? behaviour?.maxTokens ?? Math.min(DEFAULT_MAX_OUTPUT, Math.floor(declared.contextWindow / 2)),
    reasoning: declared.reasoning ?? behaviour?.reasoning ?? false, input: declared.input ?? behaviour?.input ?? ['text'],
    cost: { input: pricing?.input ?? 0, output: pricing?.output ?? 0, cacheRead: pricing?.cacheRead ?? 0, cacheWrite: pricing?.cacheWrite ?? 0 },
    ...(compat || behaviour?.compat ? { compat: { ...behaviour?.compat, ...compat } } : {}),
  } as AgentConfig['model'];
}


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
 * `openrouter/anthropic/claude-opus-4.8` (provider, then model id) from Pi's catalog, from
 * the tenant's own `endpoints`, or from its `custom` providers. Catalog models use their provider's
 * published endpoint, and endpoints are the operator's, so both are trusted; a custom provider's
 * endpoint is the tenant's, called only through the outbound guard (compaction.ts).
 */
export function resolveModel(reference: string, endpoints?: ModelEndpoints, custom?: CustomProviders): AgentConfig['model'] {
  if (typeof reference !== 'string') throw new Error('model must be a "provider/model-id" string');
  const slash = reference.indexOf('/');
  if (slash <= 0 || slash === reference.length - 1) throw new Error(`Model "${reference}" must be written as "provider/model-id"; see GET /v1/models`);
  const provider = reference.slice(0, slash);
  if (endpoints && Object.hasOwn(endpoints, provider)) return endpointModel(provider, reference.slice(slash + 1), endpoints[provider]);
  if (custom && Object.hasOwn(custom, provider)) return customModel(provider, reference.slice(slash + 1), custom[provider]);
  const id = reference.slice(slash + 1);
  // A routing variant (`…:nitro`) is looked up without it and sent with it; exact ids (`…:batch`) win.
  const known = lookup(provider, id);
  const base = known ?? lookup(provider, id.replace(/:[a-z]+$/, ''));
  if (!base) throw new Error(`Unknown model "${reference}"; see GET /v1/models`);
  const model = known ? base : { ...base, id } as AgentConfig['model'];
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

/**
 * An agent's or definition's `runLimits`: `{maxResponses?, maxSeconds?, firstTokenSeconds?, idleSeconds?}`, positive integers
 * (the stream timeouts at most an hour). Null (or `{}`) for none.
 */
export function runLimitsInput(value: unknown): RunLimits | null {
  if (value === null) return null;
  const valid = (key: string, max: number) => (value as Record<string, unknown>)[key] === undefined || (Number.isSafeInteger((value as Record<string, unknown>)[key]) && ((value as Record<string, number>)[key]) >= 1 && ((value as Record<string, number>)[key]) <= max);
  const keys = ['maxResponses', 'maxSeconds', 'firstTokenSeconds', 'idleSeconds'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || !valid('maxResponses', 1_000_000) || !valid('maxSeconds', 31_536_000) || !valid('firstTokenSeconds', 3_600) || !valid('idleSeconds', 3_600)) {
    throw new HttpError(400, 'runLimits must be {maxResponses?, maxSeconds?, firstTokenSeconds?, idleSeconds?} with positive integers (the last two at most 3600), or null');
  }
  return Object.keys(value).length ? value as RunLimits : null;
}

/** An agent's `maxOutputTokens`: a positive integer, or null for the model's maximum. */
export function maxOutputTokensInput(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new HttpError(400, 'maxOutputTokens must be a positive integer, or null');
  return value as number;
}

/** An agent's `temperature`: a number from 0 to 2, or null for the provider's default. */
export function temperatureInput(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) throw new HttpError(400, 'temperature must be a number from 0 to 2, or null');
  return value;
}

/**
 * Why `model` cannot take an agent's `maxOutputTokens` or `temperature` at its thinking level (a 400's message), or
 * undefined when it can: more output than the model writes in a response, or a temperature it would refuse (`temperatureRefusal`).
 */
export function modelSettingsRefusal(model: AgentConfig['model'], settings: Pick<AgentConfig, 'maxOutputTokens' | 'temperature' | 'thinkingLevel'>): string | undefined {
  const name = `${model.provider}/${model.id}`;
  if (settings.maxOutputTokens != null && settings.maxOutputTokens > model.maxTokens) return `maxOutputTokens must be at most ${model.maxTokens} for ${name}, the most it writes in a response`;
  const why = settings.temperature != null ? temperatureRefusal(model, settings.thinkingLevel ?? 'off') : undefined;
  return why && `${name} takes no temperature ${why}. Remove it with temperature: null`;
}

/** Why an agent's configuration with `update` applied would ask its model for settings it cannot take (`modelSettingsRefusal`). */
export function configurationRefusal(config: Pick<AgentConfig, 'model' | 'thinkingLevel' | 'maxOutputTokens' | 'temperature'>, update: Partial<Pick<AgentConfig, 'model' | 'thinkingLevel' | 'maxOutputTokens' | 'temperature'>>): string | undefined {
  const keys = ['model', 'thinkingLevel', 'maxOutputTokens', 'temperature'];
  const after = { ...config, ...Object.fromEntries(Object.entries(update).filter(([key, value]) => keys.includes(key) && value !== undefined)) } as typeof config;
  return modelSettingsRefusal(after.model, after);
}

/**
 * An agent's configuration as provisioning gives it. Its model is named ("provider/model-id") and resolved here, from
 * the catalog or the tenant's own endpoints and providers: a model object's prices, endpoint and compat switches are
 * the runtime's to say (`defaultModel`), never a caller's.
 */
export function sessionConfig(input: any, defaultModel: AgentConfig['model'], defaultPrompt?: string, endpoints?: ModelEndpoints, custom?: CustomProviders): SessionConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid session configuration');
  if ('apiKey' in input) throw new Error('Configure credentials on the runtime host, not in agent configuration');
  if (input.model !== undefined && typeof input.model !== 'string') throw new HttpError(400, 'model must be a "provider/model-id" string; see GET /v1/models');
  const model: any = input.model !== undefined ? resolveModel(input.model, endpoints, custom) : defaultModel;
  if (!model || typeof model !== 'object' || Array.isArray(model) ||
      ['id', 'name', 'api', 'provider', 'baseUrl'].some(key => typeof model[key] !== 'string' || !model[key]) ||
      typeof model.reasoning !== 'boolean' || !Array.isArray(model.input) || !model.input.every((value: unknown) => value === 'text' || value === 'image') ||
      !Number.isFinite(model.contextWindow) || model.contextWindow <= 0 || !Number.isFinite(model.maxTokens) || model.maxTokens <= 0 ||
      !model.cost || ['input', 'output', 'cacheRead', 'cacheWrite'].some(key => !Number.isFinite(model.cost[key]) || model.cost[key] < 0)) throw new Error('Invalid model configuration');
  const url = new URL(model.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Model baseUrl must be an HTTP(S) endpoint without credentials or query parameters');
  if (model.headers || model.apiKey || model.token) throw new Error('Model credentials and custom headers must be configured on the runtime host');
  if (input.systemPrompt === null) throw new Error('systemPrompt must contain 1–32000 characters');
  const updates = configurationUpdate({
    ...(input.systemPrompt !== undefined || defaultPrompt !== undefined ? { systemPrompt: input.systemPrompt !== undefined ? input.systemPrompt : defaultPrompt } : {}),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.systemPromptAppend !== undefined ? { systemPromptAppend: input.systemPromptAppend } : {}),
    ...(input.runLimits !== undefined ? { runLimits: input.runLimits } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  });
  const refusal = modelSettingsRefusal(model, updates);
  if (refusal) throw new HttpError(400, refusal);
  if (input.initialMessages !== undefined) validateInitialMessages(input.initialMessages);
  if (input.fileTools !== undefined && typeof input.fileTools !== 'boolean') throw new Error('fileTools must be true or false');
  if (input.codeMode !== undefined && typeof input.codeMode !== 'boolean') throw new Error('codeMode must be true or false');
  return { model, ...updates, ...(input.fileTools === false ? { fileTools: false } : {}), ...(input.codeMode === false ? { codeMode: false } : {}), ...(input.initialMessages !== undefined ? { initialMessages: input.initialMessages } : {}) };
}

/**
 * Scoped credentials can change behavior, tools and the model, but never a model
 * endpoint or credentials: a model can only be named from Pi's catalog.
 */
export function configurationUpdate(input: any, endpoints?: ModelEndpoints, custom?: CustomProviders): Pick<AgentConfig, 'systemPrompt' | 'systemPromptAppend' | 'thinkingLevel' | 'modelHeaders' | 'runLimits' | 'maxOutputTokens' | 'temperature'> & { tools?: AgentConfig['tools']; model?: AgentConfig['model']; keyScope?: string | null } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid configuration');
  for (const key of Object.keys(input)) if (!['systemPrompt', 'systemPromptAppend', 'thinkingLevel', 'mcp', 'model', 'keyScope', 'modelHeaders', 'tools', 'fileTools', 'codeMode', 'runLimits', 'maxOutputTokens', 'temperature'].includes(key)) throw new Error(`Unsupported scoped configuration field: ${key}`);
  if (input.fileTools !== undefined && typeof input.fileTools !== 'boolean') throw new Error('fileTools must be true or false');
  if (input.codeMode !== undefined && typeof input.codeMode !== 'boolean') throw new Error('codeMode must be true or false');
  if (input.keyScope !== undefined && input.keyScope !== null) checkScope(input.keyScope);
  // Replaced whole; null or {} removes them.
  if (input.modelHeaders !== undefined) input = { ...input, modelHeaders: modelHeadersInput(input.modelHeaders) };
  if (input.runLimits !== undefined) input = { ...input, runLimits: runLimitsInput(input.runLimits) };
  if (input.maxOutputTokens !== undefined) input = { ...input, maxOutputTokens: maxOutputTokensInput(input.maxOutputTokens) };
  if (input.temperature !== undefined) input = { ...input, temperature: temperatureInput(input.temperature) };
  // The application's attached MCP server's tools/list replaces its tools.
  if (input.mcp !== undefined) {
    const { mcp, ...rest } = input;
    input = { ...rest, tools: attachedTools(mcp?.tools) };
  }
  if (input.model !== undefined && typeof input.model !== 'string') throw new Error('model must be a "provider/model-id" string');
  // null returns to the runtime's default prompt.
  if (input.systemPrompt !== undefined && input.systemPrompt !== null && (typeof input.systemPrompt !== 'string' || !input.systemPrompt.trim() || input.systemPrompt.length > 32000)) throw new Error('systemPrompt must contain 1–32000 characters');
  if (input.systemPromptAppend !== undefined && (typeof input.systemPromptAppend !== 'string' || input.systemPromptAppend.length > 32000)) throw new Error('systemPromptAppend must be at most 32000 characters; empty removes it');
  if (input.thinkingLevel !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.thinkingLevel)) throw new Error('Invalid thinkingLevel');
  if (input.tools !== undefined) validateDefinitions(input.tools);
  return { ...input, ...(input.model !== undefined ? { model: resolveModel(input.model, endpoints, custom) } : {}) };
}

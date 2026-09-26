import { getModel, getProviders } from '@earendil-works/pi-ai/compat';
import type { AgentConfig } from './protocol.ts';
import { validateDefinitions } from './tool-policy.ts';
import { validateInitialMessages } from './history.ts';
import { attachedTools } from './mcp-results.ts';

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

/** What a model on a tenant's own endpoint can do, as the operator declares it. */
export type EndpointModel = { contextWindow: number; maxTokens: number; reasoning?: boolean; input?: ('text' | 'image')[] };
/**
 * A tenant's own OpenAI-compatible endpoint (chat completions), named as a provider in the tenants
 * file. Calls carry the runtime's identity token for the agent instead of a key, and cost the
 * runtime nothing. `models` declares models Pi's catalog does not know; `compat` tunes Pi's request format.
 */
export type ModelEndpoint = { baseUrl: string; models?: Record<string, EndpointModel>; compat?: Record<string, unknown> };
/** A tenant's model endpoints by provider name. */
export type ModelEndpoints = Record<string, ModelEndpoint> | undefined;

const lookup = getModel as (provider: string, id: string) => AgentConfig['model'] | undefined;

/**
 * A model on a tenant's endpoint. Its id goes to the endpoint as it is; what it can do comes from
 * the endpoint's `models`, else from the catalog model it names (`anthropic/claude-opus-5` as a
 * provider and model, an OpenRouter id, or a bare `claude-opus-5`), and it costs nothing.
 */
function endpointModel(provider: string, id: string, endpoint: ModelEndpoint): AgentConfig['model'] {
  const slash = id.indexOf('/');
  const known = endpoint.models?.[id] ?? (slash > 0 ? lookup(id.slice(0, slash), id.slice(slash + 1)) : undefined) ?? lookup('openrouter', id) ??
    getProviders().map(other => lookup(other, id)).find(Boolean);
  if (!known) throw new Error(`Unknown model "${provider}/${id}": declare it in the ${provider} endpoint's models, or name a model in GET /v1/models`);
  return {
    id, name: id, api: 'openai-completions', provider, baseUrl: endpoint.baseUrl, reasoning: known.reasoning ?? false, input: known.input ?? ['text'],
    contextWindow: known.contextWindow, maxTokens: known.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(endpoint.compat ? { compat: endpoint.compat } : {}),
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
  return model;
}

/** Only operator-authenticated provisioning may choose a model, and only among trusted endpoints. */
export function sessionConfig(input: any, defaultModel: AgentConfig['model'], defaultPrompt?: string, allowedBaseUrls: string[] = [], endpoints?: ModelEndpoints): SessionConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid session configuration');
  if ('apiKey' in input) throw new Error('Configure credentials on the runtime host, not in agent configuration');
  const model = typeof input.model === 'string' ? resolveModel(input.model, endpoints) : input.model ?? defaultModel;
  if (!model || typeof model !== 'object' || Array.isArray(model) ||
      ['id', 'name', 'api', 'provider', 'baseUrl'].some(key => typeof model[key] !== 'string' || !model[key]) ||
      typeof model.reasoning !== 'boolean' || !Array.isArray(model.input) || !model.input.every((value: unknown) => value === 'text' || value === 'image') ||
      !Number.isFinite(model.contextWindow) || model.contextWindow <= 0 || !Number.isFinite(model.maxTokens) || model.maxTokens <= 0 ||
      !model.cost || ['input', 'output', 'cacheRead', 'cacheWrite'].some(key => !Number.isFinite(model.cost[key]) || model.cost[key] < 0)) throw new Error('Invalid model configuration');
  const url = new URL(model.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Model baseUrl must be an HTTP(S) endpoint without credentials or query parameters');
  if (model.headers || model.apiKey || model.token) throw new Error('Model credentials and custom headers must be configured on the runtime host');
  assertTrustedEndpoint(model, defaultModel, [...allowedBaseUrls, ...Object.values(endpoints ?? {}).map(endpoint => endpoint.baseUrl)]);
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
export function configurationUpdate(input: any, endpoints?: ModelEndpoints): Pick<AgentConfig, 'systemPrompt' | 'systemPromptAppend' | 'thinkingLevel'> & { tools?: AgentConfig['tools']; model?: AgentConfig['model'] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid configuration');
  for (const key of Object.keys(input)) if (!['systemPrompt', 'systemPromptAppend', 'thinkingLevel', 'mcp', 'model'].includes(key)) throw new Error(`Unsupported scoped configuration field: ${key}`);
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

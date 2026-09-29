import { getProviders } from "@earendil-works/pi-ai/compat";
import type { Accounts, Sealed } from "./accounts.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import { FETCH_PROVIDERS } from "./catalog.ts";
import { SEARCH_PROVIDERS } from "./web-search.ts";
import { endpoint, reachableEndpoint, RESERVED_HEADERS as RESERVED } from "./key-scopes.ts";
import type { Outbound } from "./outbound.ts";
import { CUSTOM_APIS, type CustomModel, type CustomProvider, type CustomProviders } from "./session-config.ts";

/**
 * Model providers of a tenant's own, or of one of its key scopes: any server that speaks OpenAI Chat
 * Completions, OpenAI Responses or Anthropic Messages (a hosted API the catalog lacks, a model the catalog
 * has not caught up with, a gateway, vLLM or Ollama), named by the tenant, with the models it declares.
 * Agents and definitions name its models `<name>/<model id>`; a key scope's provider serves only that
 * scope's agents, before the tenant's of the same name, so each organization in a scope can have its own
 * "custom". Its key and headers are sealed like provider keys, and resolved at every model call, so a
 * changed key or address applies at once; the address is called only through the outbound guard. Calls
 * are the tenant's own (never the platform's credit), costing what the models' declared pricing says.
 */
export type ProviderInput = { type: CustomProvider["type"]; baseUrl: string; apiKey?: string | null; headers?: Record<string, string> | null; auth?: ProviderAuth; models: CustomModel[] };
/** How the key goes: `x-api-key` (Anthropic's own way), or `Authorization: Bearer` (OpenAI's, and some Anthropic gateways'). */
export type ProviderAuth = "x-api-key" | "bearer";

/** A tenant's providers reach other nodes within this long; the writing node's at once. */
const CACHE_MS = 5_000;
/** Providers of the tenant's own, and of each key scope. */
const MAX_PROVIDERS = 20;
const MAX_MODELS = 200;
const aad = (tenant: string, name: string, scope = "") => scope ? `model-provider:${tenant}:scope:${scope}:${name}` : `model-provider:${tenant}:${name}`;
const invalid = (message: string): never => { throw new HttpError(400, message); };
/** Pi's switches for servers that differ from OpenAI's, which a model may set. */
const COMPAT: Record<string, (value: unknown) => boolean> = {
  supportsDeveloperRole: value => typeof value === "boolean",
  supportsUsageInStreaming: value => typeof value === "boolean",
  supportsFinishReason: value => typeof value === "boolean",
  supportsReasoningEffort: value => typeof value === "boolean",
  maxTokensField: value => value === "max_tokens" || value === "max_completion_tokens",
  thinkingFormat: value => typeof value === "string" && ["openai", "openrouter", "deepseek", "together", "zai", "qwen", "qwen-chat-template"].includes(value),
};

/** A provider's name: lowercase letters, digits and dashes, and none a built-in provider or the tenant's endpoint has. */
export function providerName(name: string, endpoints: string[] = []): string {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) invalid("A provider's name is 1–40 lowercase letters, digits and '-', starting with a letter or digit");
  if ([...getProviders(), ...SEARCH_PROVIDERS, ...FETCH_PROVIDERS, ...endpoints].includes(name as never)) invalid(`${name} is already a provider; name yours something else`);
  return name;
}

function model(value: any, index: number): CustomModel {
  const at = `models[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${at} must be {id, contextWindow, maxOutputTokens?, input?, reasoning?, pricing?, compat?}`);
  for (const key of Object.keys(value)) if (!["id", "contextWindow", "maxOutputTokens", "input", "reasoning", "pricing", "compat"].includes(key)) invalid(`Unknown field ${at}.${key}`);
  const { id, contextWindow, maxOutputTokens, input, reasoning, pricing, compat } = value;
  if (typeof id !== "string" || !/^\S{1,200}$/.test(id)) invalid(`${at}.id must be the model's id on the server, 1–200 characters without spaces`);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 10_000_000) invalid(`${at}.contextWindow must be the model's context window in tokens (1024 to 10,000,000)`);
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > contextWindow)) invalid(`${at}.maxOutputTokens must be at most its context window`);
  if (input !== undefined && (!Array.isArray(input) || !input.includes("text") || input.some((kind: unknown) => kind !== "text" && kind !== "image") || new Set(input).size !== input.length)) invalid(`${at}.input must be ["text"] or ["text", "image"]`);
  if (reasoning !== undefined && typeof reasoning !== "boolean") invalid(`${at}.reasoning must be true or false`);
  if (pricing !== undefined) {
    if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) invalid(`${at}.pricing must be {input, output, cacheRead?, cacheWrite?} in USD per million tokens`);
    for (const key of Object.keys(pricing)) if (!["input", "output", "cacheRead", "cacheWrite"].includes(key)) invalid(`Unknown field ${at}.pricing.${key}`);
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
      const price = pricing[key];
      if ((price !== undefined || key === "input" || key === "output") && (typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > 10_000)) invalid(`${at}.pricing.${key} must be USD per million tokens, 0 to 10,000`);
    }
  }
  if (compat !== undefined) {
    if (!compat || typeof compat !== "object" || Array.isArray(compat)) invalid(`${at}.compat must be an object`);
    for (const [key, setting] of Object.entries(compat)) if (!COMPAT[key]?.(setting)) invalid(`${at}.compat.${key} is not one of ${Object.keys(COMPAT).join(", ")}, or not a valid value`);
  }
  return {
    id, contextWindow, ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}), ...(input ? { input } : {}), ...(reasoning !== undefined ? { reasoning } : {}),
    ...(pricing ? { pricing: { input: pricing.input, output: pricing.output, ...(pricing.cacheRead !== undefined ? { cacheRead: pricing.cacheRead } : {}), ...(pricing.cacheWrite !== undefined ? { cacheWrite: pricing.cacheWrite } : {}) } } : {}),
    ...(compat && Object.keys(compat).length ? { compat } : {}),
  };
}

/** A provider as a tenant sends it, checked: `apiKey` and `headers` left out keep what is stored, null removes them. */
export function providerInput(value: any): ProviderInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`Body must be {type: ${CUSTOM_APIS.join(" | ")}, baseUrl, apiKey?, headers?, models}`);
  for (const key of Object.keys(value)) if (!["type", "baseUrl", "apiKey", "headers", "auth", "models"].includes(key)) invalid(`Unknown field ${key}`);
  const { baseUrl, apiKey, headers, auth, models } = value;
  // openai-compatible, the one type there was, is Chat Completions.
  const type = value.type === "openai-compatible" ? "openai-completions" : value.type;
  if (!CUSTOM_APIS.includes(type)) invalid(`type must be one of ${CUSTOM_APIS.join(", ")}: the API the server speaks`);
  if (auth !== undefined && auth !== "x-api-key" && auth !== "bearer") invalid('auth must be "x-api-key" or "bearer": how the key is sent');
  if (auth === "x-api-key" && type !== "anthropic-messages") invalid('auth "x-api-key" is for anthropic-messages; OpenAI\'s APIs take the key as a bearer token');
  if (apiKey !== undefined && apiKey !== null && (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 4096 || /\s/.test(apiKey))) invalid("apiKey must be a non-empty string without spaces, or null for a server that takes none");
  if (headers !== undefined && headers !== null) {
    if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.keys(headers).length > 20) invalid("headers must be an object of at most 20 header names and string values");
    for (const [name, text] of Object.entries(headers)) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(name) || typeof text !== "string" || text.length > 4096 || /[\r\n\0]/.test(text)) invalid(`Invalid header ${name}`);
      if (RESERVED.has(name.toLowerCase())) invalid(`headers cannot set ${name}: give the key as apiKey`);
    }
  }
  if (!Array.isArray(models) || !models.length || models.length > MAX_MODELS) invalid(`models must list the provider's models: 1 to ${MAX_MODELS}`);
  const checked: CustomModel[] = models.map(model);
  const twice = checked.find((entry, index) => checked.findIndex(other => other.id === entry.id) !== index);
  if (twice) invalid(`models lists ${twice.id} twice`);
  return { type, baseUrl: endpoint(baseUrl), ...(apiKey !== undefined ? { apiKey } : {}), ...(headers !== undefined ? { headers } : {}), ...(auth === "bearer" && type === "anthropic-messages" ? { auth } : {}), models: checked };
}

/** A declared model as listings show it, its defaults filled in. */
const shownModel = (entry: CustomModel) => ({
  id: entry.id, contextWindow: entry.contextWindow, ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
  input: entry.input ?? ["text"], reasoning: entry.reasoning ?? false,
  pricing: { input: entry.pricing?.input ?? 0, output: entry.pricing?.output ?? 0, cacheRead: entry.pricing?.cacheRead ?? 0, cacheWrite: entry.pricing?.cacheWrite ?? 0 },
  ...(entry.compat ? { compat: entry.compat } : {}),
});

type Row = { scope: string; name: string; config: CustomProvider & { headers?: string[]; auth?: ProviderAuth }; sealed: Sealed; last4: string; set_at: string | number };
export type ProviderCredentials = { apiKey?: string; baseUrl: string; headers?: Record<string, string>; bearer?: true };
/** How a provider's key goes: bearer for OpenAI's APIs; for Anthropic Messages, x-api-key unless it says bearer. */
const authOf = (config: Row["config"]): ProviderAuth => typeOf(config) === "anthropic-messages" && config.auth !== "bearer" ? "x-api-key" : "bearer";
/** Rows stored before there were three APIs say openai-compatible: Chat Completions. */
const typeOf = (config: Row["config"]) => (config.type as string) === "openai-compatible" ? "openai-completions" : config.type;

export class ModelProviders {
  private readonly db: Db;
  private readonly accounts: Accounts;
  private readonly outbound: Outbound;
  private readonly cache = new Map<string, { rows: Row[]; until: number }>();

  constructor(options: { db: Db; accounts: Accounts; outbound: Outbound }) {
    this.db = options.db;
    this.accounts = options.accounts;
    this.outbound = options.outbound;
  }

  /** Store `name`'s provider for `tenant` (or its key scope `scope`), replacing what it was but for a key or headers left out. */
  async set(tenant: string, name: string, input: ProviderInput, endpoints: string[] = [], scope = "") {
    providerName(name, endpoints);
    if (!this.accounts.canStoreKeys) throw new HttpError(503, "This runtime is not configured to store provider keys");
    await reachableEndpoint(this.outbound, input.baseUrl);
    const own = (await this.rows(tenant, scope, true)).filter(row => row.scope === scope);
    const current = own.find(row => row.name === name);
    if (!current && own.length >= MAX_PROVIDERS) invalid(scope ? `A key scope can have at most ${MAX_PROVIDERS} providers` : `A tenant can have at most ${MAX_PROVIDERS} providers`);
    const kept = current ? JSON.parse(this.accounts.unseal(aad(tenant, name, scope), current.sealed)) as { apiKey?: string; headers?: Record<string, string> } : {};
    const apiKey = input.apiKey === undefined ? kept.apiKey : input.apiKey ?? undefined;
    const headers = input.headers === undefined ? kept.headers : input.headers && Object.keys(input.headers).length ? input.headers : undefined;
    const config = { type: input.type, baseUrl: input.baseUrl, models: input.models, ...(headers ? { headers: Object.keys(headers) } : {}), ...(input.auth ? { auth: input.auth } : {}) };
    await this.db.query(`
      insert into model_providers (tenant, scope, name, config, sealed, last4, set_at) values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (tenant, scope, name) do update set config = excluded.config, sealed = excluded.sealed, last4 = excluded.last4, set_at = excluded.set_at`,
    [tenant, scope, name, config, this.accounts.seal(aad(tenant, name, scope), JSON.stringify({ ...(apiKey ? { apiKey } : {}), ...(headers ? { headers } : {}) })), apiKey?.slice(-4) ?? "", Date.now()]);
    this.forget(tenant);
    return (await this.list(tenant, scope)).find(entry => entry.id === name)!;
  }

  /**
   * Delete `name` (of the tenant, or of its key scope `scope`). The tenant's takes every key scope's
   * entry for it too: nothing of it is left to call.
   */
  async delete(tenant: string, name: string, scope = "") {
    const { rowCount } = await this.db.query("delete from model_providers where tenant = $1 and scope = $2 and name = $3", [tenant, scope, name]);
    if (rowCount && !scope) await this.db.query("delete from key_scope_providers where tenant = $1 and provider = $2", [tenant, name]);
    this.forget(tenant);
    if (rowCount && !scope) this.onDelete?.(tenant, name);
    return !!rowCount;
  }
  /** Told of a deleted provider, to drop cached copies of what it deleted (key scopes' entries). */
  onDelete?: (tenant: string, name: string) => void;

  /** Delete every provider of a key scope (the scope is deleted). */
  async deleteScope(tenant: string, scope: string) {
    await this.db.query("delete from model_providers where tenant = $1 and scope = $2", [tenant, scope]);
    this.forget(tenant);
  }

  /** The providers of the tenant's own (or of its key scope `scope`) as GET lists them: never their key or header values. */
  async list(tenant: string, scope = "") {
    return (await this.rows(tenant, scope, true)).filter(row => row.scope === scope).map(row => ({
      id: row.name, kind: "model" as const, models: row.config.models.length, apiKey: true,
      key: row.last4 ? { provider: row.name, source: "tenant" as const, last4: row.last4, setAt: Number(row.set_at) } : null,
      custom: { type: typeOf(row.config), baseUrl: row.config.baseUrl, auth: authOf(row.config), ...(row.config.headers?.length ? { headers: row.config.headers } : {}), models: row.config.models.map(shownModel) },
    }));
  }

  /** The providers an agent of `tenant` in key scope `scope` resolves models from: the scope's before the tenant's. */
  async resolvable(tenant: string, scope?: string | null): Promise<CustomProviders> {
    const rows = this.visible(await this.rows(tenant, scope ?? ""), scope);
    return rows.length ? Object.fromEntries(rows.map(row => [row.name, { type: typeOf(row.config), baseUrl: row.config.baseUrl, models: row.config.models }])) : undefined;
  }

  async has(tenant: string, name: string, scope?: string | null) { return this.visible(await this.rows(tenant, scope ?? ""), scope).some(row => row.name === name); }

  /** What a call to `name`'s models from key scope `scope` authenticates with now: its key (if any), address and headers. */
  async credentials(tenant: string, name: string, scope?: string | null): Promise<ProviderCredentials | undefined> {
    const row = this.visible(await this.rows(tenant, scope ?? ""), scope).find(entry => entry.name === name);
    if (!row) return undefined;
    const { apiKey, headers } = JSON.parse(this.accounts.unseal(aad(tenant, name, row.scope), row.sealed)) as { apiKey?: string; headers?: Record<string, string> };
    // Anthropic Messages sends x-api-key; a provider that says bearer takes it as Authorization instead.
    return { baseUrl: row.config.baseUrl, ...(apiKey ? { apiKey } : {}), ...(headers ? { headers } : {}), ...(typeOf(row.config) === "anthropic-messages" && authOf(row.config) === "bearer" ? { bearer: true as const } : {}) };
  }

  /** The providers a scope sees, by name: its own, then the tenant's it has none of that name for. */
  private visible(rows: Row[], scope?: string | null): Row[] {
    const own = scope ? rows.filter(row => row.scope === scope) : [];
    return [...own, ...rows.filter(row => row.scope === "" && !own.some(entry => entry.name === row.name))];
  }

  private forget(tenant: string) {
    for (const key of this.cache.keys()) if (key.startsWith(`${tenant}\0`)) this.cache.delete(key);
  }

  /** The tenant's providers and key scope `scope`'s, cached for a few seconds unless `fresh`. */
  private async rows(tenant: string, scope: string, fresh = false): Promise<Row[]> {
    const key = `${tenant}\0${scope}`;
    const cached = this.cache.get(key);
    if (!fresh && cached && cached.until > Date.now()) return cached.rows;
    const rows = (await this.db.query("select scope, name, config, sealed, last4, set_at from model_providers where tenant = $1 and scope in ('', $2) order by scope, name", [tenant, scope])).rows as Row[];
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(key, { rows, until: Date.now() + CACHE_MS });
    return rows;
  }
}

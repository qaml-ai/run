import { getProviders } from "@earendil-works/pi-ai/compat";
import type { Accounts, Sealed } from "./accounts.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import { FETCH_PROVIDERS } from "./catalog.ts";
import { SEARCH_PROVIDERS } from "./web-search.ts";
import { endpoint, reachableEndpoint } from "./key-scopes.ts";
import type { Outbound } from "./outbound.ts";
import type { CustomModel, CustomProvider, CustomProviders } from "./session-config.ts";

/**
 * A tenant's own model providers: any server that speaks OpenAI Chat Completions (a hosted API the
 * catalog lacks, a model the catalog has not caught up with, vLLM or Ollama on a public address), named
 * by the tenant, with the models it declares. Agents and definitions name its models `<name>/<model id>`.
 * Its key and headers are sealed like provider keys, and resolved at every model call, so a changed key
 * or address applies at once; the address is called only through the outbound guard. Calls are the
 * tenant's own (never the platform's credit), costing what the models' declared pricing says.
 */
export type ProviderInput = { type: "openai-compatible"; baseUrl: string; apiKey?: string | null; headers?: Record<string, string> | null; models: CustomModel[] };

/** A tenant's providers reach other nodes within this long; the writing node's at once. */
const CACHE_MS = 5_000;
const MAX_PROVIDERS = 20;
const MAX_MODELS = 200;
const aad = (tenant: string, name: string) => `model-provider:${tenant}:${name}`;
const invalid = (message: string): never => { throw new HttpError(400, message); };
/** Headers only the runtime sets on a model call, besides the key (`apiKey`, sent as Authorization). */
const RESERVED = new Set(["authorization", "host", "content-length", "content-type", "transfer-encoding", "connection", "x-agent-runtime-identity"]);
/** Pi's switches for servers that differ from OpenAI's, which a model may set. */
const COMPAT: Record<string, (value: unknown) => boolean> = {
  supportsDeveloperRole: value => typeof value === "boolean",
  supportsUsageInStreaming: value => typeof value === "boolean",
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
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Body must be {type: \"openai-compatible\", baseUrl, apiKey?, headers?, models}");
  for (const key of Object.keys(value)) if (!["type", "baseUrl", "apiKey", "headers", "models"].includes(key)) invalid(`Unknown field ${key}`);
  const { type, baseUrl, apiKey, headers, models } = value;
  if (type !== "openai-compatible") invalid("type must be \"openai-compatible\": a server that speaks OpenAI Chat Completions");
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
  return { type, baseUrl: endpoint(baseUrl), ...(apiKey !== undefined ? { apiKey } : {}), ...(headers !== undefined ? { headers } : {}), models: checked };
}

/** A declared model as listings show it, its defaults filled in. */
const shownModel = (entry: CustomModel) => ({
  id: entry.id, contextWindow: entry.contextWindow, ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
  input: entry.input ?? ["text"], reasoning: entry.reasoning ?? false,
  pricing: { input: entry.pricing?.input ?? 0, output: entry.pricing?.output ?? 0, cacheRead: entry.pricing?.cacheRead ?? 0, cacheWrite: entry.pricing?.cacheWrite ?? 0 },
  ...(entry.compat ? { compat: entry.compat } : {}),
});

type Row = { name: string; config: CustomProvider & { headers?: string[] }; sealed: Sealed; last4: string; set_at: string | number };
export type ProviderCredentials = { apiKey?: string; baseUrl: string; headers?: Record<string, string> };

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

  /** Store `name`'s provider for `tenant`, replacing what it was but for a key or headers left out. */
  async set(tenant: string, name: string, input: ProviderInput, endpoints: string[] = []) {
    providerName(name, endpoints);
    if (!this.accounts.canStoreKeys) throw new HttpError(503, "This runtime is not configured to store provider keys");
    await reachableEndpoint(this.outbound, input.baseUrl);
    const current = (await this.rows(tenant, true)).find(row => row.name === name);
    if (!current && (await this.rows(tenant)).length >= MAX_PROVIDERS) invalid(`A tenant can have at most ${MAX_PROVIDERS} providers`);
    const kept = current ? JSON.parse(this.accounts.unseal(aad(tenant, name), current.sealed)) as { apiKey?: string; headers?: Record<string, string> } : {};
    const apiKey = input.apiKey === undefined ? kept.apiKey : input.apiKey ?? undefined;
    const headers = input.headers === undefined ? kept.headers : input.headers && Object.keys(input.headers).length ? input.headers : undefined;
    const config = { type: input.type, baseUrl: input.baseUrl, models: input.models, ...(headers ? { headers: Object.keys(headers) } : {}) };
    await this.db.query(`
      insert into model_providers (tenant, name, config, sealed, last4, set_at) values ($1, $2, $3, $4, $5, $6)
      on conflict (tenant, name) do update set config = excluded.config, sealed = excluded.sealed, last4 = excluded.last4, set_at = excluded.set_at`,
    [tenant, name, config, this.accounts.seal(aad(tenant, name), JSON.stringify({ ...(apiKey ? { apiKey } : {}), ...(headers ? { headers } : {}) })), apiKey?.slice(-4) ?? "", Date.now()]);
    this.cache.delete(tenant);
    return (await this.list(tenant)).find(entry => entry.id === name)!;
  }

  async delete(tenant: string, name: string) {
    const { rowCount } = await this.db.query("delete from model_providers where tenant = $1 and name = $2", [tenant, name]);
    this.cache.delete(tenant);
    return !!rowCount;
  }

  /** The tenant's providers as GET /v1/providers lists them: never their key or header values. */
  async list(tenant: string) {
    return (await this.rows(tenant, true)).map(row => ({
      id: row.name, kind: "model" as const, models: row.config.models.length, apiKey: true,
      key: row.last4 ? { provider: row.name, source: "tenant" as const, last4: row.last4, setAt: Number(row.set_at) } : null,
      custom: { type: row.config.type, baseUrl: row.config.baseUrl, ...(row.config.headers?.length ? { headers: row.config.headers } : {}), models: row.config.models.map(shownModel) },
    }));
  }

  /** The tenant's providers as models are resolved from them (session-config.ts). */
  async resolvable(tenant: string): Promise<CustomProviders> {
    const rows = await this.rows(tenant);
    return rows.length ? Object.fromEntries(rows.map(row => [row.name, { type: row.config.type, baseUrl: row.config.baseUrl, models: row.config.models }])) : undefined;
  }

  async has(tenant: string, name: string) { return (await this.rows(tenant)).some(row => row.name === name); }

  /** What a call to `name`'s models authenticates with now: its key (if any), address and headers. */
  async credentials(tenant: string, name: string): Promise<ProviderCredentials | undefined> {
    const row = (await this.rows(tenant)).find(entry => entry.name === name);
    if (!row) return undefined;
    const { apiKey, headers } = JSON.parse(this.accounts.unseal(aad(tenant, name), row.sealed)) as { apiKey?: string; headers?: Record<string, string> };
    return { baseUrl: row.config.baseUrl, ...(apiKey ? { apiKey } : {}), ...(headers ? { headers } : {}) };
  }

  /** The tenant's rows, cached for a few seconds unless `fresh`. */
  private async rows(tenant: string, fresh = false): Promise<Row[]> {
    const cached = this.cache.get(tenant);
    if (!fresh && cached && cached.until > Date.now()) return cached.rows;
    const rows = (await this.db.query("select name, config, sealed, last4, set_at from model_providers where tenant = $1 order by name", [tenant])).rows as Row[];
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(tenant, { rows, until: Date.now() + CACHE_MS });
    return rows;
  }
}

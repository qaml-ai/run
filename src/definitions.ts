import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.ts";
import type { RunLimits, ToolDefinition } from "./protocol.ts";
import type { RequestRecord } from "../shared/client-protocol.ts";
import { errorText } from "./protocol.ts";
import { configurationUpdate, modelSettingsRefusal, resolveModel, runLimitsInput, type CustomProviders } from "./session-config.ts";
import { HttpError } from "./http.ts";
import { jsonWithinLimit } from "./limits.ts";
import type { Accounts } from "./accounts.ts";
import type { Outbound } from "./outbound.ts";
import { builtinsInput, managedBuiltinsRefusal } from "./builtins.ts";
import { delegateSettings, type DelegateSettings } from "./multi-agent.ts";
import { searchOrder } from "./web-search.ts";
import { canonical } from "../shared/durable-json.ts";
import { humanInputSettings, type HumanInputSettings } from "./inputs.ts";
import { mcpServersInput, mcpServerView, openApiInput, openApiView, type McpServerSpec, type OpenApiSpec, type Sources } from "./tool-sources.ts";
import type { ToolSourceView } from "./tool-servers.ts";

/**
 * Agent definitions: reusable, tenant-level agent configurations (`definitions`).
 * An agent made from one copies the revision it came from, so editing a definition
 * changes new agents only, until it is applied to existing ones, which reconfigures
 * each through its `configure` request.
 */
export interface DefinitionSpec {
  /** What its agents are for: the description of each one's MCP tool (agent-mcp.ts). */
  description?: string;
  model?: string;
  systemPrompt?: string;
  thinkingLevel?: string;
  /** The most its agents' model writes in one response; the model's maximum when absent. */
  maxOutputTokens?: number;
  /** Its agents' sampling temperature, for a model and thinking level that take one (session-config.ts `modelSettingsRefusal`). */
  temperature?: number;
  limits?: { ttlSeconds?: number | null };
  /** The most one run of its agents may take (model responses, seconds), within the runtime's maximums. */
  runLimits?: RunLimits;
  mounts?: unknown[];
  /** Remote MCP servers whose tools the runtime calls; credentials sealed. */
  mcpServers?: McpServerSpec[];
  /** OpenAPI specs whose operations the runtime calls; credentials sealed. */
  openApi?: OpenApiSpec[];
  /** false: agents get no file tools but present_file; their mounts stay open to fs in js_exec. */
  fileTools?: boolean;
  /** false: agents get no js_exec, and call every tool directly (AgentConfig.codeMode). */
  codeMode?: boolean;
  /** Built-in tools to enable: web_fetch, web_search, schedule, ask_user, delegate. */
  builtins?: string[];
  /** The search providers web_search tries, in order, instead of the runtime's (AGENT_WEB_SEARCH_PROVIDERS). */
  webSearch?: { providers: string[] };
  /** Human input: how long inputs wait (expiresInSeconds), what happens when they expire (onExpire), who else may answer (approvers). */
  humanInput?: HumanInputSettings;
  /** With the delegate builtin: the agents its agents may start or message, and how deep and wide (multi-agent.ts). */
  delegate?: DelegateSettings;
  /** Made for this channel, and deleted with it. */
  channel?: string;
  /** true: a save that makes a new revision also applies it to every live agent made from it, as `apply: "all"` does. */
  applyOnUpdate?: boolean;
}
export interface Definition { id: string; tenant: string; name: string; revision: number; spec: DefinitionSpec; createdAt: number; updatedAt: number;
  /** When it was saved with MCP servers: what each listed, or why it could not be. */
  toolSources?: ToolSourceView[];
  /** On a save that wrote a new revision over an earlier one: true. */
  revised?: boolean }
/** Top-level fields replace the stored ones; null removes one. Secrets go in as plain values and are sealed. */
export type DefinitionInput = { name?: string; revision?: number } & { [K in keyof DefinitionSpec]?: unknown };
/** What an agent records about the definition it was made from. */
export interface DefinitionRef { id: string; revision: number }
/** What applying a definition's revision did to one agent. */
export interface ApplyResult { agent: string; requestId: string; status: "updated" | "queued" | "failed"; error?: string }
/** Agent parameters from a definition, as `createAgent` takes them. */
export type AgentParams = Record<string, unknown> & { tools?: ToolDefinition[] };

const FIELDS = ["description", "model", "systemPrompt", "thinkingLevel", "maxOutputTokens", "temperature", "fileTools", "codeMode", "limits", "runLimits", "mounts", "builtins", "webSearch", "mcpServers", "openApi", "humanInput", "delegate", "applyOnUpdate"] as const;
/** Configuration an agent made from a definition may set as its own, which applying the definition leaves. */
export const OVERRIDES = ["model", "thinkingLevel", "maxOutputTokens", "temperature", "fileTools", "codeMode", "runLimits"] as const;
const PROVISION_FIELDS = ["name", "type", "ttlSeconds", "mounts", "tools", "initialMessages", "systemPromptAppend"];
const MAX_DEFINITIONS = 200;
const validId = (id: string) => /^def_[a-f0-9]{20}$/.test(id);
/** The server-side tool sources an agent takes from a definition, if it has any. */
export function sources(spec: DefinitionSpec): Sources | undefined {
  const found: Sources = {
    ...(spec.builtins?.length ? { builtins: spec.builtins } : {}), ...(spec.webSearch && spec.builtins?.includes("web_search") ? { webSearch: spec.webSearch } : {}), ...(spec.mcpServers?.length ? { mcpServers: spec.mcpServers } : {}),
    ...(spec.openApi?.length ? { openApi: spec.openApi } : {}), ...(spec.humanInput ? { humanInput: spec.humanInput } : {}),
    ...(spec.delegate && spec.builtins?.includes("delegate") ? { delegate: spec.delegate } : {}),
  };
  return Object.keys(found).length ? found : undefined;
}

export function validTtl(ttl: unknown) {
  if (ttl !== undefined && ttl !== null && (!Number.isInteger(ttl) || (ttl as number) < 60 || (ttl as number) > 366 * 86_400)) throw new HttpError(400, "ttlSeconds must be null (never expires) or an integer from 60 to 31622400");
}

export class Definitions {
  readonly db: Db;
  private readonly accounts?: Accounts;
  private readonly outbound?: Outbound;
  /** The tenant's own model providers, whose models a definition may name. */
  private readonly customProviders?: (tenant: string) => Promise<CustomProviders>;
  /** Lists MCP servers as a definition is saved (ToolSources.listed). */
  listMcp?: (tenant: string, definition: string, servers: McpServerSpec[]) => Promise<ToolSourceView[]>;
  /** Builtins of a saved spec the tenant cannot use (no key for them), as warnings for the save's answer. */
  builtinWarnings?: (tenant: string, spec: DefinitionSpec) => Promise<string[]>;
  constructor(options: { db: Db; accounts?: Accounts; outbound?: Outbound; customProviders?: (tenant: string) => Promise<CustomProviders> }) {
    this.db = options.db;
    this.accounts = options.accounts;
    this.outbound = options.outbound;
    this.customProviders = options.customProviders;
  }

  private row(row: any): Definition {
    return { id: row.id, tenant: row.tenant, name: row.name, revision: row.revision, spec: row.spec, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  async read(tenant: string, id: string): Promise<Definition> {
    const row = validId(id) ? (await this.db.query("select * from definitions where id = $1 and tenant = $2", [id, tenant])).rows[0] : undefined;
    if (!row) throw new HttpError(404, `Unknown definition ${id}`);
    return this.row(row);
  }

  /** What callers see: the spec's fields, with secrets left out. */
  view({ tenant: _tenant, spec, revised: _revised, ...definition }: Definition) {
    const { channel: _channel, mcpServers, openApi, ...visible } = spec;
    return { ...definition, ...visible, ...(mcpServers ? { mcpServers: mcpServers.map(mcpServerView) } : {}), ...(openApi ? { openApi: openApi.map(openApiView) } : {}) };
  }

  /** What a save answers: the definition as callers see it, with `warnings` about builtins its tenant cannot use. */
  async saved(definition: Definition) {
    const warnings = await this.builtinWarnings?.(definition.tenant, definition.spec) ?? [];
    return { ...this.view(definition), ...(warnings.length ? { warnings } : {}) };
  }

  async list(tenant: string) {
    const { rows } = await this.db.query("select * from definitions where tenant = $1 order by created_at, id", [tenant]);
    return rows.map(row => this.view(this.row(row)));
  }
  async get(tenant: string, id: string) { return this.view(await this.read(tenant, id)); }

  /**
   * The definition for the tenant's `key`, set to `input` (POST /v1/definitions with an Idempotency-Key): made at
   * revision 1 if there is none, else given `input` whole (fields left out are cleared) as a new revision, unless that
   * changes nothing. The same key is the same definition.
   */
  async upsert(tenant: string, key: string, input: DefinitionInput): Promise<Definition> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(key)) throw new HttpError(400, "An Idempotency-Key is 1 to 80 letters, digits, _ and -");
    const id = `def_${createHash("sha256").update(`${tenant}:${key}`).digest("hex").slice(0, 20)}`;
    const current = await this.read(tenant, id).catch(error => { if ((error as HttpError).status === 404) return undefined; throw error; });
    if (!current) return this.create(tenant, input, {}, id).catch(async error => {
      // A concurrent upsert of the key made it first: this one updates it.
      if ((error as { code?: string }).code === "23505") return this.upsert(tenant, key, input);
      throw error;
    });
    if (input?.revision !== undefined) throw new HttpError(400, "An upsert sets the definition whatever its revision; use PATCH /v1/definitions/<id> for a conditional change");
    const name = this.name(input?.name);
    if (!name) throw new HttpError(400, "A definition needs a name");
    const spec = await this.merge(tenant, id, current.spec, { ...Object.fromEntries(FIELDS.map(field => [field, null])), ...input });
    if (name === current.name && canonical(spec) === canonical(current.spec)) return current;
    const toolSources = await this.listing(tenant, id, spec, input);
    return { ...await this.write(current, name, spec), ...(toolSources ? { toolSources } : {}) };
  }

  /** A new definition, at revision 1. */
  async create(tenant: string, input: DefinitionInput, internal: Pick<DefinitionSpec, "channel"> = {}, id = `def_${randomBytes(10).toString("hex")}`): Promise<Definition> {
    const name = this.name(input.name);
    if (!name) throw new HttpError(400, "A definition needs a name");
    if ((await this.db.query("select count(*) as count from definitions where tenant = $1", [tenant])).rows[0].count >= MAX_DEFINITIONS) throw new HttpError(400, `A tenant can have at most ${MAX_DEFINITIONS} definitions`);
    const spec: DefinitionSpec = { ...await this.merge(tenant, id, {}, input), ...internal };
    const toolSources = await this.listing(tenant, id, spec, input);
    const now = Date.now();
    const definition: Definition = { id, tenant, name, revision: 1, spec, createdAt: now, updatedAt: now };
    await this.db.query("insert into definitions (id, tenant, name, revision, spec, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7)",
      [definition.id, tenant, name, 1, JSON.stringify(spec), now, now]);
    return { ...definition, ...(toolSources ? { toolSources } : {}) };
  }

  /** The MCP servers a save sent, listed now (see `listMcp`). */
  private async listing(tenant: string, id: string, spec: DefinitionSpec, input: DefinitionInput) {
    return input.mcpServers !== undefined && spec.mcpServers?.length && this.listMcp ? this.listMcp(tenant, id, spec.mcpServers) : undefined;
  }

  /** Replace the given fields; with `revision`, only if the definition is still at that revision. */
  async update(tenant: string, id: string, input: DefinitionInput): Promise<Definition> {
    const current = await this.read(tenant, id);
    if (input.revision !== undefined && input.revision !== current.revision) throw new HttpError(409, `The definition is at revision ${current.revision}, not ${input.revision}`);
    if (input.name === undefined && FIELDS.every(key => input[key] === undefined)) return current;
    const spec = await this.merge(tenant, id, current.spec, input);
    const toolSources = await this.listing(tenant, id, spec, input);
    return { ...await this.write(current, this.name(input.name) ?? current.name, spec), ...(toolSources ? { toolSources } : {}) };
  }

  private async write(current: Definition, name: string, spec: DefinitionSpec) {
    // Only a save that adds a self-starting builtin pays for the lookup.
    const refusal = managedBuiltinsRefusal(spec.builtins);
    if (refusal && (await this.db.query("select 1 from channels where tenant = $1 and channel->>'definition' = $2 and channel->>'type' = 'discord-managed' limit 1", [current.tenant, current.id])).rowCount) throw new HttpError(400, refusal);
    const next: Definition = { ...current, name, spec, revision: current.revision + 1, updatedAt: Date.now(), revised: true };
    const { rowCount } = await this.db.query("update definitions set name = $3, spec = $4, revision = $5, updated_at = $6 where id = $1 and tenant = $2 and revision = $7",
      [current.id, current.tenant, name, JSON.stringify(spec), next.revision, next.updatedAt, current.revision]);
    if (!rowCount) throw new HttpError(409, "The definition changed meanwhile; retry");
    return next;
  }

  async remove(tenant: string, id: string) {
    await this.read(tenant, id);
    const used = await this.channelsUsing(tenant, id);
    if (used) throw new HttpError(409, `Channel ${used} uses this definition; point it at another first`);
    await this.db.query("delete from definitions where id = $1 and tenant = $2", [id, tenant]);
  }

  async channelsUsing(tenant: string, id: string): Promise<string | undefined> {
    return (await this.db.query("select id from channels where tenant = $1 and channel->>'definition' = $2 limit 1", [tenant, id])).rows[0]?.id;
  }

  /** The tenant's live agents made from a definition, and the revision each has. */
  async agents(tenant: string, id: string): Promise<{ id: string; revision: number }[]> {
    const { rows } = await this.db.query(`
      select id, (header->'definition'->>'revision')::bigint as revision from agents
      where tenant = $1 and header->'definition'->>'id' = $2 and not revoked and purged_at is null
        and (expires_at is null or expires_at > $3) order by id`, [tenant, id, Date.now()]);
    return rows.map(row => ({ id: row.id, revision: row.revision }));
  }

  /**
   * Reconfigure every live agent made from a definition to its current revision,
   * through each agent's `configure` request (idempotent per revision). Each agent's
   * result says whether it took the revision already, has it queued between its
   * turns, or failed.
   */
  async apply(definition: Definition, submit: (agent: string, request: { id: string; method: string; params: Record<string, unknown> }) => Promise<RequestRecord>) {
    const requestId = `apply_${definition.id}_${definition.revision}`;
    const results: ApplyResult[] = [];
    const queue = (await this.agents(definition.tenant, definition.id)).map(agent => agent.id);
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let agent; (agent = queue.shift());) {
        try {
          const record = await submit(agent, { id: requestId, method: "configure", params: { definition: { id: definition.id, revision: definition.revision } } });
          if (record.outcome?.error !== undefined) throw new Error(record.outcome.error);
          results.push({ agent, requestId, status: record.state === "completed" ? "updated" : "queued" });
        } catch (error) { results.push({ agent, requestId, status: "failed", error: errorText(error) }); }
      }
    }));
    return results.sort((a, b) => a.agent.localeCompare(b.agent));
  }

  /**
   * The parameters to create an agent from `params.definition`: the definition's, with
   * the per-agent fields given alongside it (name, type, ttlSeconds, mounts, its attached
   * server's tools, initialMessages). `model`, `thinkingLevel`, `maxOutputTokens`, `temperature`, `fileTools`, `codeMode`
   * and `runLimits` given here are the agent's own (`overrides`): applying the definition later leaves them. `systemPromptAppend` follows
   * the definition's prompt, whatever revision it takes. `provision` identifies the request for
   * idempotency, whatever the definition's revision.
   */
  async provision(tenant: string, params: any): Promise<{ params: AgentParams; ref: DefinitionRef; provision: unknown; overrides: string[]; sources?: Sources }> {
    if (typeof params.definition !== "string") throw new HttpError(400, "definition must be a definition id");
    if (params.systemPrompt !== undefined) throw new HttpError(400, "systemPrompt comes from the definition; add to it with systemPromptAppend, or change the definition");
    const definition = await this.read(tenant, params.definition);
    const { spec } = definition;
    validTtl(params.ttlSeconds);
    const ttlSeconds = params.ttlSeconds !== undefined ? params.ttlSeconds : spec.limits?.ttlSeconds;
    const mounts = params.mounts !== undefined ? params.mounts : spec.mounts;
    const overrides = OVERRIDES.filter(key => params[key] !== undefined);
    const own = (key: typeof OVERRIDES[number] | "systemPrompt") => params[key] ?? spec[key];
    return {
      params: {
        ...Object.fromEntries(([...OVERRIDES, "systemPrompt"] as const).filter(key => own(key) !== undefined).map(key => [key, own(key)])),
        tools: params.tools ?? [], name: params.name ?? definition.name, ...(params.type !== undefined ? { type: params.type } : {}),
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}), ...(mounts !== undefined ? { mounts } : {}),
        ...Object.fromEntries(["initialMessages", "systemPromptAppend"].filter(key => params[key] !== undefined).map(key => [key, params[key]])),
      },
      ref: { id: definition.id, revision: definition.revision }, overrides,
      ...(sources(spec) ? { sources: sources(spec) } : {}),
      provision: { definition: definition.id, ...Object.fromEntries([...PROVISION_FIELDS, ...OVERRIDES].filter(key => params[key] !== undefined).map(key => [key, params[key]])) },
    };
  }

  private name(value: unknown) {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim() || value.trim().length > 120) throw new HttpError(400, "name must contain 1–120 characters");
    return value.trim();
  }

  /** `current` with `input`'s fields applied, checked as agent configuration is. */
  private async merge(tenant: string, id: string, current: DefinitionSpec, input: DefinitionInput): Promise<DefinitionSpec> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Send a definition object");
    for (const key of Object.keys(input)) if (![...FIELDS, "name", "revision", "apply"].includes(key)) throw new HttpError(400, `Unknown definition field: ${key}`);
    const spec: DefinitionSpec = { ...current };
    for (const key of FIELDS) {
      if (input[key] === null) delete spec[key];
      else if (key === "mcpServers" && input[key] !== undefined) spec.mcpServers = mcpServersInput(input[key], current.mcpServers, id, { accounts: this.accounts, outbound: this.outbound! });
      // Saving fetches the specs again: that is how a definition takes a spec's changes.
      else if (key === "openApi" && input[key] !== undefined) spec.openApi = await openApiInput(input[key], current.openApi, id, { accounts: this.accounts, outbound: this.outbound! });
      else if (input[key] !== undefined) (spec as Record<string, unknown>)[key] = input[key];
    }
    try {
      const model = spec.model !== undefined ? resolveModel(spec.model, this.accounts?.tenants.modelEndpoints(tenant), await this.customProviders?.(tenant)) : undefined;
      const settings = configurationUpdate(Object.fromEntries((["systemPrompt", "thinkingLevel", "maxOutputTokens", "temperature"] as const).filter(key => spec[key] !== undefined).map(key => [key, spec[key]])));
      // Without a model of its own, its agents' model (the runtime's default, or their own) is checked as each is made.
      const refusal = model && modelSettingsRefusal(model, settings);
      if (refusal) throw new Error(refusal);
    } catch (error) { throw new HttpError(400, errorText(error)); }
    if (spec.limits !== undefined) {
      if (!spec.limits || typeof spec.limits !== "object" || Object.keys(spec.limits).some(key => key !== "ttlSeconds")) throw new HttpError(400, "limits is { ttlSeconds }");
      validTtl(spec.limits.ttlSeconds);
    }
    if (spec.description !== undefined && (typeof spec.description !== "string" || !spec.description.trim() || spec.description.length > 1000)) throw new HttpError(400, "description must contain 1–1000 characters");
    if (spec.fileTools !== undefined && typeof spec.fileTools !== "boolean") throw new HttpError(400, "fileTools must be true or false");
    if (spec.codeMode !== undefined && typeof spec.codeMode !== "boolean") throw new HttpError(400, "codeMode must be true or false");
    if (spec.applyOnUpdate !== undefined && typeof spec.applyOnUpdate !== "boolean") throw new HttpError(400, "applyOnUpdate must be true or false");
    if (spec.applyOnUpdate === false) delete spec.applyOnUpdate;
    if (spec.runLimits !== undefined && !runLimitsInput(spec.runLimits)) delete spec.runLimits;
    if (spec.mounts !== undefined && (!Array.isArray(spec.mounts) || spec.mounts.length > 16)) throw new HttpError(400, "mounts must be an array of at most 16");
    if (spec.builtins !== undefined) builtinsInput(spec.builtins);
    if (spec.webSearch !== undefined) {
      const webSearch = spec.webSearch as unknown;
      if (!webSearch || typeof webSearch !== "object" || Array.isArray(webSearch) || Object.keys(webSearch).some(key => key !== "providers")) throw new HttpError(400, "webSearch is { providers }");
      try { searchOrder((webSearch as { providers?: unknown }).providers, "webSearch.providers"); } catch (error) { throw new HttpError(400, errorText(error)); }
    }
    if (spec.humanInput !== undefined) humanInputSettings(spec.humanInput);
    const delegate = delegateSettings(spec.builtins, spec.delegate);
    if (delegate) spec.delegate = delegate;
    const prefixes = [...spec.mcpServers ?? [], ...spec.openApi ?? []].map(source => source.name);
    const twice = prefixes.find((name, index) => prefixes.indexOf(name) !== index);
    if (twice) throw new HttpError(400, `${twice} names both an MCP server and an OpenAPI source; their tools would share ${twice}__`);
    try { jsonWithinLimit(spec, 512 * 1024, "Definition"); } catch (error) { throw new HttpError(413, errorText(error)); }
    return spec;
  }
}

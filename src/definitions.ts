import { randomBytes } from "node:crypto";
import type { Db } from "./db.ts";
import type { ToolDefinition } from "./protocol.ts";
import type { RequestRecord } from "../shared/client-protocol.ts";
import { errorText } from "./protocol.ts";
import { configurationUpdate, resolveModel } from "./session-config.ts";
import { HttpError } from "./http.ts";
import { jsonWithinLimit } from "./limits.ts";
import type { Accounts } from "./accounts.ts";
import type { Outbound } from "./outbound.ts";
import { BUILTINS } from "./builtins.ts";
import { searchOrder } from "./web-search.ts";
import { mcpServersInput, mcpServerView, openApiInput, openApiView, type McpServerSpec, type OpenApiSpec, type Sources } from "./tool-sources.ts";

/**
 * Agent definitions: reusable, tenant-level agent configurations (`definitions`).
 * An agent made from one copies the revision it came from, so editing a definition
 * changes new agents only, until it is applied to existing ones, which reconfigures
 * each through its `configure` request.
 */
export interface DefinitionSpec {
  model?: string;
  systemPrompt?: string;
  thinkingLevel?: string;
  limits?: { ttlSeconds?: number | null };
  mounts?: unknown[];
  /** Remote MCP servers whose tools the runtime calls; credentials sealed. */
  mcpServers?: McpServerSpec[];
  /** OpenAPI specs whose operations the runtime calls; credentials sealed. */
  openApi?: OpenApiSpec[];
  /** false: agents get no file tools but present_file; their mounts stay open to fs in js_exec. */
  fileTools?: boolean;
  /** Built-in tools to enable: web_fetch, web_search, schedule. */
  builtins?: string[];
  /** The search providers web_search tries, in order, instead of the runtime's (AGENT_WEB_SEARCH_PROVIDERS). */
  webSearch?: { providers: string[] };
  /** Made for this channel, and deleted with it. */
  channel?: string;
}
export interface Definition { id: string; tenant: string; name: string; revision: number; spec: DefinitionSpec; createdAt: number; updatedAt: number }
/** Top-level fields replace the stored ones; null removes one. Secrets go in as plain values and are sealed. */
export type DefinitionInput = { name?: string; revision?: number } & { [K in keyof DefinitionSpec]?: unknown };
/** What an agent records about the definition it was made from. */
export interface DefinitionRef { id: string; revision: number }
/** What applying a definition's revision did to one agent. */
export interface ApplyResult { agent: string; requestId: string; status: "updated" | "queued" | "failed"; error?: string }
/** Agent parameters from a definition, as `createAgent` takes them. */
export type AgentParams = Record<string, unknown> & { tools?: ToolDefinition[] };

const FIELDS = ["model", "systemPrompt", "thinkingLevel", "fileTools", "limits", "mounts", "builtins", "webSearch", "mcpServers", "openApi"] as const;
/** Configuration an agent made from a definition may set as its own, which applying the definition leaves. */
export const OVERRIDES = ["model", "thinkingLevel", "fileTools"] as const;
const PROVISION_FIELDS = ["name", "type", "ttlSeconds", "mounts", "tools", "initialMessages", "systemPromptAppend"];
const MAX_DEFINITIONS = 200;
const validId = (id: string) => /^def_[a-f0-9]{20}$/.test(id);
/** The server-side tool sources an agent takes from a definition, if it has any. */
export function sources(spec: DefinitionSpec): Sources | undefined {
  const found: Sources = {
    ...(spec.builtins?.length ? { builtins: spec.builtins } : {}), ...(spec.webSearch && spec.builtins?.includes("web_search") ? { webSearch: spec.webSearch } : {}), ...(spec.mcpServers?.length ? { mcpServers: spec.mcpServers } : {}),
    ...(spec.openApi?.length ? { openApi: spec.openApi } : {}),
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
  constructor(options: { db: Db; accounts?: Accounts; outbound?: Outbound }) {
    this.db = options.db;
    this.accounts = options.accounts;
    this.outbound = options.outbound;
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
  view({ tenant: _tenant, spec, ...definition }: Definition) {
    const { channel: _channel, mcpServers, openApi, ...visible } = spec;
    return { ...definition, ...visible, ...(mcpServers ? { mcpServers: mcpServers.map(mcpServerView) } : {}), ...(openApi ? { openApi: openApi.map(openApiView) } : {}) };
  }

  async list(tenant: string) {
    const { rows } = await this.db.query("select * from definitions where tenant = $1 order by created_at, id", [tenant]);
    return rows.map(row => this.view(this.row(row)));
  }
  async get(tenant: string, id: string) { return this.view(await this.read(tenant, id)); }

  /** A new definition, at revision 1. */
  async create(tenant: string, input: DefinitionInput, internal: Pick<DefinitionSpec, "channel"> = {}): Promise<Definition> {
    const name = this.name(input.name);
    if (!name) throw new HttpError(400, "A definition needs a name");
    if ((await this.db.query("select count(*) as count from definitions where tenant = $1", [tenant])).rows[0].count >= MAX_DEFINITIONS) throw new HttpError(400, `A tenant can have at most ${MAX_DEFINITIONS} definitions`);
    const id = `def_${randomBytes(10).toString("hex")}`;
    const spec: DefinitionSpec = { ...await this.merge(tenant, id, {}, input), ...internal };
    const now = Date.now();
    const definition: Definition = { id, tenant, name, revision: 1, spec, createdAt: now, updatedAt: now };
    await this.db.query("insert into definitions (id, tenant, name, revision, spec, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7)",
      [definition.id, tenant, name, 1, JSON.stringify(spec), now, now]);
    return definition;
  }

  /** Replace the given fields; with `revision`, only if the definition is still at that revision. */
  async update(tenant: string, id: string, input: DefinitionInput): Promise<Definition> {
    const current = await this.read(tenant, id);
    if (input.revision !== undefined && input.revision !== current.revision) throw new HttpError(409, `The definition is at revision ${current.revision}, not ${input.revision}`);
    if (input.name === undefined && FIELDS.every(key => input[key] === undefined)) return current;
    const spec = await this.merge(tenant, id, current.spec, input);
    return this.write(current, this.name(input.name) ?? current.name, spec);
  }

  private async write(current: Definition, name: string, spec: DefinitionSpec) {
    const next: Definition = { ...current, name, spec, revision: current.revision + 1, updatedAt: Date.now() };
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
   * server's tools, initialMessages). `model` and `thinkingLevel` given here are the agent's
   * own (`overrides`): applying the definition later leaves them. `systemPromptAppend` follows
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
    const own = (key: "model" | "systemPrompt" | "thinkingLevel" | "fileTools") => params[key] ?? spec[key];
    return {
      params: {
        ...Object.fromEntries((["model", "systemPrompt", "thinkingLevel", "fileTools"] as const).filter(key => own(key) !== undefined).map(key => [key, own(key)])),
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
      if (spec.model !== undefined) resolveModel(spec.model, this.accounts?.tenants.modelEndpoints(tenant));
      configurationUpdate({ ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt } : {}), ...(spec.thinkingLevel !== undefined ? { thinkingLevel: spec.thinkingLevel } : {}) });
    } catch (error) { throw new HttpError(400, errorText(error)); }
    if (spec.limits !== undefined) {
      if (!spec.limits || typeof spec.limits !== "object" || Object.keys(spec.limits).some(key => key !== "ttlSeconds")) throw new HttpError(400, "limits is { ttlSeconds }");
      validTtl(spec.limits.ttlSeconds);
    }
    if (spec.fileTools !== undefined && typeof spec.fileTools !== "boolean") throw new HttpError(400, "fileTools must be true or false");
    if (spec.mounts !== undefined && (!Array.isArray(spec.mounts) || spec.mounts.length > 16)) throw new HttpError(400, "mounts must be an array of at most 16");
    if (spec.builtins !== undefined && (!Array.isArray(spec.builtins) || new Set(spec.builtins).size !== spec.builtins.length || spec.builtins.some(name => !Object.hasOwn(BUILTINS, name)))) {
      throw new HttpError(400, `builtins is a list of: ${Object.keys(BUILTINS).join(", ")}`);
    }
    if (spec.webSearch !== undefined) {
      const webSearch = spec.webSearch as unknown;
      if (!webSearch || typeof webSearch !== "object" || Array.isArray(webSearch) || Object.keys(webSearch).some(key => key !== "providers")) throw new HttpError(400, "webSearch is { providers }");
      try { searchOrder((webSearch as { providers?: unknown }).providers, "webSearch.providers"); } catch (error) { throw new HttpError(400, errorText(error)); }
    }
    const prefixes = [...spec.mcpServers ?? [], ...spec.openApi ?? []].map(source => source.name);
    const twice = prefixes.find((name, index) => prefixes.indexOf(name) !== index);
    if (twice) throw new HttpError(400, `${twice} names both an MCP server and an OpenAPI source; their tools would share ${twice}__`);
    try { jsonWithinLimit(spec, 512 * 1024, "Definition"); } catch (error) { throw new HttpError(413, errorText(error)); }
    return spec;
  }
}

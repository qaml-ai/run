import { randomBytes } from "node:crypto";
import type { Db } from "./db.ts";
import type { ToolDefinition } from "./protocol.ts";
import type { RequestRecord } from "../shared/client-protocol.ts";
import { errorText } from "./protocol.ts";
import { configurationUpdate, resolveModel } from "./session-config.ts";
import { HttpError } from "./http.ts";
import { jsonWithinLimit } from "./limits.ts";

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
  /** Client tools, answered by an application connected to the agent. */
  tools?: ToolDefinition[];
  limits?: { ttlSeconds?: number | null };
  mounts?: unknown[];
  /** Made from this channel's inline template, so that channel may rewrite it. */
  channel?: string;
}
export interface Definition { id: string; tenant: string; name: string; revision: number; spec: DefinitionSpec; createdAt: number; updatedAt: number }
/** Top-level fields replace the stored ones; null removes one. */
export type DefinitionInput = { name?: string; revision?: number } & { [K in keyof DefinitionSpec]?: DefinitionSpec[K] | null };
/** What an agent records about the definition it was made from. `extraTools` were added at creation and survive an apply. */
export interface DefinitionRef { id: string; revision: number; extraTools?: string[] }
/** Agent parameters from a definition, as `createAgent` takes them. */
export type AgentParams = Record<string, unknown> & { tools: ToolDefinition[] };

const FIELDS = ["model", "systemPrompt", "thinkingLevel", "tools", "limits", "mounts"] as const;
const MAX_DEFINITIONS = 200;
const validId = (id: string) => /^def_[a-f0-9]{20}$/.test(id);

export function validTtl(ttl: unknown) {
  if (ttl !== undefined && ttl !== null && (!Number.isInteger(ttl) || (ttl as number) < 60 || (ttl as number) > 366 * 86_400)) throw new HttpError(400, "ttlSeconds must be null (never expires) or an integer from 60 to 31622400");
}

export class Definitions {
  readonly db: Db;
  constructor(options: { db: Db }) { this.db = options.db; }

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
    const { channel: _channel, ...visible } = spec;
    return { ...definition, ...visible };
  }

  async list(tenant: string) {
    const { rows } = await this.db.query("select * from definitions where tenant = $1 order by created_at, id", [tenant]);
    return rows.map(row => this.view(this.row(row)));
  }
  async get(tenant: string, id: string) { return this.view(await this.read(tenant, id)); }

  async create(tenant: string, input: DefinitionInput, internal: Pick<DefinitionSpec, "channel"> = {}) {
    const name = this.name(input.name);
    if (!name) throw new HttpError(400, "A definition needs a name");
    if ((await this.db.query("select count(*) as count from definitions where tenant = $1", [tenant])).rows[0].count >= MAX_DEFINITIONS) throw new HttpError(400, `A tenant can have at most ${MAX_DEFINITIONS} definitions`);
    const spec = { ...this.merge({}, input), ...internal };
    const now = Date.now();
    const definition: Definition = { id: `def_${randomBytes(10).toString("hex")}`, tenant, name, revision: 1, spec, createdAt: now, updatedAt: now };
    await this.db.query("insert into definitions (id, tenant, name, revision, spec, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7)",
      [definition.id, tenant, name, 1, JSON.stringify(spec), now, now]);
    return definition;
  }

  /** Replace the given fields; with `revision`, only if the definition is still at that revision. */
  async update(tenant: string, id: string, input: DefinitionInput) {
    const current = await this.read(tenant, id);
    if (input.revision !== undefined && input.revision !== current.revision) throw new HttpError(409, `The definition is at revision ${current.revision}, not ${input.revision}`);
    if (input.name === undefined && FIELDS.every(key => input[key] === undefined)) return current;
    const spec = this.merge(current.spec, input);
    if (spec.tools?.some(tool => tool.name === "send_message") && await this.channelsUsing(tenant, id)) throw new HttpError(400, "send_message is the channel's own tool; a definition a channel uses cannot declare it");
    const next: Definition = { ...current, name: this.name(input.name) ?? current.name, spec, revision: current.revision + 1, updatedAt: Date.now() };
    const { rowCount } = await this.db.query("update definitions set name = $3, spec = $4, revision = $5, updated_at = $6 where id = $1 and tenant = $2 and revision = $7",
      [id, tenant, next.name, JSON.stringify(spec), next.revision, next.updatedAt, current.revision]);
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
   * through each agent's `configure` request (idempotent per revision).
   */
  async apply(definition: Definition, submit: (agent: string, request: { id: string; method: string; params: Record<string, unknown> }) => Promise<RequestRecord>) {
    const agents = (await this.agents(definition.tenant, definition.id)).map(agent => agent.id);
    const accepted: string[] = [], failed: { agent: string; error: string }[] = [];
    const queue = [...agents];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let agent; (agent = queue.shift());) {
        try {
          await submit(agent, { id: `apply_${definition.id}_${definition.revision}`, method: "configure", params: { definition: { id: definition.id, revision: definition.revision } } });
          accepted.push(agent);
        } catch (error) { failed.push({ agent, error: errorText(error) }); }
      }
    }));
    return { accepted: accepted.sort(), failed };
  }

  /**
   * The parameters to create an agent from `params.definition`: the definition's, with
   * the per-agent fields given alongside it (name, type, ttlSeconds, mounts, tools to add,
   * initialMessages). `provision` identifies the request for idempotency, whatever the
   * definition's revision.
   */
  async provision(tenant: string, params: any): Promise<{ params: AgentParams; ref: DefinitionRef; provision: unknown }> {
    if (typeof params.definition !== "string") throw new HttpError(400, "definition must be a definition id");
    for (const key of ["model", "systemPrompt", "thinkingLevel"]) if (params[key] !== undefined) throw new HttpError(400, `${key} comes from the definition; change the definition instead`);
    const definition = await this.read(tenant, params.definition);
    const { spec } = definition;
    if (params.tools !== undefined && !Array.isArray(params.tools)) throw new HttpError(400, "tools must be an array");
    // An application answering the definition's own tools declares them too; only the others are added.
    const extra: ToolDefinition[] = (params.tools ?? []).filter((tool: ToolDefinition) => !spec.tools?.some(own => own.name === tool?.name));
    validTtl(params.ttlSeconds);
    const ttlSeconds = params.ttlSeconds !== undefined ? params.ttlSeconds : spec.limits?.ttlSeconds;
    const mounts = params.mounts !== undefined ? params.mounts : spec.mounts;
    return {
      params: {
        ...(spec.model !== undefined ? { model: spec.model } : {}), ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt } : {}),
        ...(spec.thinkingLevel !== undefined ? { thinkingLevel: spec.thinkingLevel } : {}), tools: [...spec.tools ?? [], ...extra],
        name: params.name ?? definition.name, ...(params.type !== undefined ? { type: params.type } : {}),
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}), ...(mounts !== undefined ? { mounts } : {}),
        ...(params.initialMessages !== undefined ? { initialMessages: params.initialMessages } : {}),
      },
      ref: { id: definition.id, revision: definition.revision, ...(extra.length ? { extraTools: extra.map(tool => tool.name) } : {}) },
      provision: { definition: definition.id, ...Object.fromEntries(["name", "type", "ttlSeconds", "mounts", "tools", "initialMessages"].filter(key => params[key] !== undefined).map(key => [key, params[key]])) },
    };
  }

  private name(value: unknown) {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim() || value.trim().length > 120) throw new HttpError(400, "name must contain 1–120 characters");
    return value.trim();
  }

  /** `current` with `input`'s fields applied, checked as agent configuration is. */
  private merge(current: DefinitionSpec, input: DefinitionInput): DefinitionSpec {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Send a definition object");
    for (const key of Object.keys(input)) if (![...FIELDS, "name", "revision", "apply"].includes(key)) throw new HttpError(400, `Unknown definition field: ${key}`);
    const spec: DefinitionSpec = { ...current };
    for (const key of FIELDS) {
      if (input[key] === null) delete spec[key];
      else if (input[key] !== undefined) (spec as Record<string, unknown>)[key] = input[key];
    }
    try {
      if (spec.model !== undefined) resolveModel(spec.model);
      configurationUpdate({ ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt } : {}), ...(spec.thinkingLevel !== undefined ? { thinkingLevel: spec.thinkingLevel } : {}), ...(spec.tools !== undefined ? { tools: spec.tools } : {}) });
    } catch (error) { throw new HttpError(400, errorText(error)); }
    if (spec.limits !== undefined) {
      if (!spec.limits || typeof spec.limits !== "object" || Object.keys(spec.limits).some(key => key !== "ttlSeconds")) throw new HttpError(400, "limits is { ttlSeconds }");
      validTtl(spec.limits.ttlSeconds);
    }
    if (spec.mounts !== undefined && (!Array.isArray(spec.mounts) || spec.mounts.length > 16)) throw new HttpError(400, "mounts must be an array of at most 16");
    try { jsonWithinLimit(spec, 512 * 1024, "Definition"); } catch (error) { throw new HttpError(413, errorText(error)); }
    return spec;
  }
}

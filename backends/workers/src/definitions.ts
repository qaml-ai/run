import { prepareApply } from "../../../shared/apply-scope.ts";
import { ApiError, configuration, digest, type AgentConfiguration } from "./api-contract.ts";
import { body, object } from "./validation.ts";
import { Directory, type ControlEnv, type AuthContext, type DirectoryEntry } from "./control.ts";
import { withSql, transaction } from "./postgres.ts";
import { canonical } from "../../../shared/durable-json.ts";
import { discoverSources, sourceDefinitionViews, prepareSources, sourceView, type RemoteSource } from "./tool-sources.ts";
import { keyServices } from "./security-services.ts";
import { modelSettingsRefusal, resolveModel } from "./model-policy.ts";
import { HttpError } from "./errors.ts";
import { builtinWarnings } from "./builtin-warnings.ts";
import { rejectWorkflow } from "./workflow-refusal.ts";
import { computerSettingsInput } from "./computers/egress.ts";
import { sourceUrl } from "./tool-sources.ts";

export type Definition = { id: string; tenant: string; name: string; revision: number; spec: AgentConfiguration & { description?: string; applyOnUpdate?: boolean; limits?: { ttlSeconds?: number | null; idleTtlSeconds?: number | null }; webSearch?: { providers: string[] }; /** The channel this definition was made for (deleted with it). */ channel?: string }; createdAt: number; updatedAt: number };
const OVERRIDES = ["model", "thinkingLevel", "maxOutputTokens", "temperature", "dataCollection", "language", "fileTools", "codeMode", "computerLimit", "runLimits", "queue", "networking"] as const;
const DEFINED = ["systemPrompt", "thinkingLevel", "maxOutputTokens", "temperature", "dataCollection", "language", "fileTools", "codeMode", "computerLimit", "runLimits", "queue", "builtins", "webSearch", "mcpServers", "openApi", "humanInput", "delegate", "decide", "computer", "networking"] as const;
/** A later agent configuration becomes its own choice when a new definition revision is applied. */
export function configurationOverrides(config: AgentConfiguration, params: object): AgentConfiguration {
  return { ...config, ...params, ...(config.definition ? { definitionOverrides:[...new Set([...(config.definitionOverrides ?? []), ...OVERRIDES.filter(field=>Object.hasOwn(params,field))])] } : {}) } as AgentConfiguration;
}
/** Agent source updates are checked like creation; credentials can only be introduced by a definition. */
export async function configurationPatch(env: ControlEnv, tenant: string, config: AgentConfiguration, params: object): Promise<AgentConfiguration> {
  const fields=params as Record<string,unknown>, checked = { ...fields };
  if (config.definition) {
    if (fields.mcpServers !== undefined || fields.openApi !== undefined) throw new ApiError(400, "This agent's MCP servers come from its definition; change them there");
    if (["builtins", "delegate", "decide"].some(field => fields[field] !== undefined)) throw new ApiError(400, "This agent's builtins come from its definition; change them there");
  }
  if (fields.computer !== undefined) throw new ApiError(400, "computer is set in a definition; change it there");
  for (const field of ["mcpServers", "openApi"] as const) if (Object.hasOwn(fields,field)) {
    checked[field] = await prepareSources(env,tenant,undefined,field,fields[field],config[field] as RemoteSource[] | undefined);
  }
  const updated=configurationOverrides(config,checked);
  // A patch removes the scope before the resulting configuration is provisioned.
  if (fields.keyScope === null) delete updated.keyScope;
  const duplicate=updated.mcpServers?.find(source=>updated.openApi?.some(other=>other.name===source.name));
  if(duplicate) throw new ApiError(400,`${duplicate.name} names both an MCP server and an OpenAPI source`);
  return updated;
}
/** A definition revision as an apply request carries it to each agent. */
export type DefinitionTarget = { id: string; revision: number; spec: Definition["spec"] };
/**
 * The configuration an agent takes from a definition revision: the revision's settings over the agent's, except those
 * the agent set itself (definitionOverrides). `config` is the agent's configuration as the request applies, so a change
 * queued before it is kept. A revision older than the agent's leaves the agent as it is.
 */
export async function definitionApplication(env: ControlEnv, tenant: string, config: AgentConfiguration, target: DefinitionTarget): Promise<AgentConfiguration> {
  if (config.definition !== target.id) throw new ApiError(409, "This agent was not made from that definition");
  if ((config.definitionRevision ?? 0) > target.revision) return config;
  const { description, applyOnUpdate, limits, ...updates } = target.spec;
  const own = Object.fromEntries((config.definitionOverrides ?? []).map(field => [field, config[field as keyof AgentConfiguration]]));
  const cleared = { ...config };
  for (const field of DEFINED) delete cleared[field];
  const merged = { ...cleared, ...updates, ...own, language: Object.hasOwn(own, "language") ? own.language : updates.language ?? null, definition: target.id, definitionRevision: target.revision } as AgentConfiguration;
  if (merged.temperature != null && merged.model) {
    const services = await keyServices(env);
    const model = resolveModel(merged.model, services.tenants.modelEndpoints(tenant), await services.modelProviders.resolvable(tenant, merged.keyScope));
    if (modelSettingsRefusal(model, { ...merged, maxOutputTokens: undefined })) delete merged.temperature;
  }
  return merged;
}
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const fromRow = (row: Record<string, any>): Definition => ({ id: row.id, tenant: row.tenant, name: row.name, revision: Number(row.revision), spec: withoutOnExpire(withoutWorkflow(row.spec)), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });
/** A stored `humanInput.onExpire`, from before every expired input resumed the turn, is ignored; new input refuses it. */
export function withoutOnExpire<T extends { humanInput?: object }>(spec: T): T {
  const humanInput = spec.humanInput as { onExpire?: unknown } | undefined;
  if (!humanInput || !("onExpire" in humanInput)) return spec;
  const { onExpire: _onExpire, ...rest } = humanInput;
  return { ...spec, humanInput: rest };
}
/** Stored workflow settings are ignored; only new API input is refused (workflow-refusal.ts). */
export function withoutWorkflow<T extends { builtins?: string[] }>(spec: T): T {
  const { workflow: _workflow, ...rest } = spec as T & { workflow?: unknown };
  return { ...rest, ...(rest.builtins ? { builtins: rest.builtins.filter(name => name !== "workflow") } : {}) } as T;
}
// `channel` marks a definition a channel made for itself (src/definitions.ts): internal, never shown.
const view = ({ tenant, spec: { channel: _channel, ...spec }, ...definition }: Definition) => ({ ...definition, ...spec, toolSources: sourceDefinitionViews(spec as never), ...(spec.mcpServers ? { mcpServers: spec.mcpServers.map(x => sourceView(x as RemoteSource)) } : {}), ...(spec.openApi ? { openApi: spec.openApi.map(x => sourceView(x as RemoteSource)) } : {}) });
export function visibleConfiguration(config: AgentConfiguration) {
  const { definitionOverrides, definitionRevision, ...visible } = withoutOnExpire(withoutWorkflow(config));
  return { ...visible, keyScope: config.keyScope ?? null, modelHeaders: config.modelHeaders ?? null, decide: config.decide ?? null, language: config.language ?? null, runLimits: config.runLimits ?? null, queue: config.queue ?? null, tools: config.mcp?.tools ?? [], mcp: config.mcp ?? { tools: [] }, mcpServers: (config.mcpServers ?? []).map(source => sourceView(source as RemoteSource)), openApi: (config.openApi ?? []).map(source => sourceView(source as RemoteSource)) };
}
export const definitionId = async (tenant: string, key: string) => `def_${(await digest(`${tenant}:${key}`)).slice(0, 20)}`;
export async function resolveDefinition(env: ControlEnv, tenant: string, ref: string): Promise<Definition> {
  const id = /^def_[a-f0-9]{20}$/.test(ref) ? ref : await definitionId(tenant, ref);
  const row = (await withSql(env, sql => sql.query("select * from definitions where tenant=$1 and id=$2", [tenant, id]))).rows[0];
  if (!row) throw new ApiError(404, `Unknown definition ${ref}`, "NOT_FOUND");
  return fromRow(row);
}
export async function provisionDefinition(env: ControlEnv, tenant: string, input: Record<string, unknown>) {
  if (input.computer !== undefined) throw new ApiError(400, "computer is set in a definition; make the agent from one");
  if (typeof input.definition !== "string") {
    const result = { ...input };
    for (const field of ["mcpServers", "openApi"] as const) if (input[field] !== undefined) result[field] = await prepareApply(`agent-sources:${JSON.stringify([tenant, field, input[field]])}`, () => prepareSources(env, tenant, undefined, field, input[field]));
    return result;
  }
  if (input.systemPrompt !== undefined) throw new ApiError(400, "Use systemPromptAppend with a definition");
  if (input.decide !== undefined) throw new ApiError(400, "decide is set by the definition");
  if (["builtins", "delegate"].some(field => input[field] !== undefined)) throw new ApiError(400, "builtins come from the definition; change them there");
  if (input.mcpServers !== undefined || input.openApi !== undefined) throw new ApiError(400, "MCP servers come from the definition; change them there");
  const definition = await resolveDefinition(env, tenant, input.definition);
  const { description, applyOnUpdate, limits, channel: _channel, ...spec } = definition.spec;
  const lifetime = input.ttlSeconds !== undefined || input.idleTtlSeconds !== undefined;
  return { ...(lifetime ? {} : limits), ...spec, name: definition.name, ...input, definition: definition.id, definitionRevision: definition.revision, definitionOverrides: OVERRIDES.filter(field => Object.hasOwn(input, field)) };
}
/** Upserting a definition's agent changes its own settings; only apply advances the definition. */
export function definitionUpsert(config: Record<string, unknown>, previous?: AgentConfiguration) {
  if (!previous) return config;
  if (previous.definition !== config.definition)
    throw new ApiError(409, "An existing agent's definition cannot change");
  const kept = { ...config };
  for (const field of ["systemPrompt", "builtins", "webSearch", "mcpServers", "openApi", "humanInput", "delegate", "decide", "computer", "networking", "definitionRevision", "mcp"] as const) {
    if (previous[field] === undefined) delete kept[field];
    else kept[field] = previous[field];
  }
  return kept;
}

export async function definitionRoutes(request: Request, env: ControlEnv, auth: AuthContext): Promise<Response | undefined> {
  const url = new URL(request.url), match = /^\/v1\/definitions(?:\/([^/]+)(\/agents)?)?$/.exec(url.pathname);
  if (!match) return;
  const ref = match[1] && decodeURIComponent(match[1]);
  const directory = new Directory(env, auth.tenantId);
  if (request.method === "GET") {
    if (ref) {
      const definition = await resolveDefinition(env, auth.tenantId, ref);
      if (match[2]) return reply((await directory.list()).filter(agent => agent.config.definition === definition.id).map(agent => ({ id: agent.id, revision: (agent as DirectoryEntry & { definitionRevision?: number }).definitionRevision ?? agent.config.definitionRevision ?? definition.revision })));
      return reply(view(definition));
    }
    const rows = (await withSql(env, sql => sql.query("select * from definitions where tenant=$1 order by created_at,id", [auth.tenantId]))).rows;
    // Unused: no live agent and no channel is made from it, as src/definitions.ts lists them.
    const used = url.searchParams.get("unused") === "true" ? new Set([...(await directory.list()).map(agent => agent.config.definition),
      ...(await withSql(env, sql => sql.query("select channel->>'definition' as definition from channels where tenant=$1", [auth.tenantId]))).rows.map(row => row.definition as string)]) : undefined;
    return reply(rows.map(fromRow).filter(def => !used?.has(def.id)).map(view));
  }
  if (request.method === "DELETE" && ref) {
    const definition = await resolveDefinition(env, auth.tenantId, ref);
    // As src/definitions.ts: a channel's agents are made from it, so it stays until the channel points elsewhere.
    const used = (await withSql(env, sql => sql.query("select id from channels where tenant=$1 and channel->>'definition'=$2 limit 1", [auth.tenantId, definition.id]))).rows[0];
    if (used) throw new ApiError(409, `Channel ${used.id} uses this definition; point it at another first`, "CONFLICT");
    await withSql(env, sql => sql.query("delete from definitions where tenant=$1 and id=$2", [auth.tenantId, definition.id]));
    return reply({ deleted: true });
  }
  if ((request.method !== "POST" || ref) && (request.method !== "PATCH" || !ref)) throw new ApiError(405, "Method not allowed");
  const given = await body(request, 1024 * 1024);
  rejectWorkflow(given);
  const input = object(given, ["name", "revision", "description", "model", "systemPrompt", "thinkingLevel", "maxOutputTokens", "temperature", "dataCollection", "language", "fileTools", "codeMode", "computerLimit", "limits", "runLimits", "queue", "mounts", "builtins", "webSearch", "mcpServers", "openApi", "humanInput", "delegate", "decide", "computer", "applyOnUpdate", "apply", "networking"]);
  if (input.apply !== undefined && input.apply !== "all") throw new ApiError(400, "apply must be all");
  const key = request.headers.get("Idempotency-Key");
  if (key !== null && !/^[A-Za-z0-9_-]{1,80}$/.test(key)) throw new ApiError(400, "Invalid Idempotency-Key");
  const id = ref ? (await resolveDefinition(env, auth.tenantId, ref)).id : key === null ? `def_${(await digest(crypto.randomUUID())).slice(0, 20)}` : await definitionId(auth.tenantId, key);
  let existing: Definition | undefined;
  try { existing = await resolveDefinition(env, auth.tenantId, id); } catch (error) { if ((error as ApiError).status !== 404) throw error; }
  if (input.revision !== undefined && (request.method === "POST" || input.revision !== existing?.revision)) throw new ApiError(409, "Definition revision changed", "CONFLICT");
  const givenName = input.name === undefined && request.method === "PATCH" ? existing?.name : input.name;
  if (typeof givenName !== "string" || !givenName.trim() || givenName.trim().length > 120) throw new ApiError(400, "name must contain 1–120 characters");
  const name = givenName.trim();
  const changes = Object.fromEntries(Object.entries(input).filter(([key]) => !["name", "revision", "apply", "applyOnUpdate", "description", "limits"].includes(key)));
  const raw = request.method === "PATCH" ? { ...existing?.spec, ...changes } : changes;
  for (const [field, value] of Object.entries(raw)) if (value === null) delete raw[field];
  const services = await keyServices(env);
  const spec = await prepareApply(`definition-spec:${JSON.stringify([auth.tenantId, id, raw, input, existing?.spec, request.method])}`, async () => {
  const { mcpServers, openApi, description: _description, applyOnUpdate: _applyOnUpdate, limits: _limits, computer, channel: madeFor, ...rest } = raw as Record<string, unknown>;
  const spec = configuration(rest, env.MODEL).config as Definition["spec"];
  if (computer !== undefined) spec.computer = computerSettingsInput(computer, value => sourceUrl(value, env), auth.tenantId);
  if (raw.model === undefined) delete spec.model;
  if (spec.model !== undefined) {
    try {
      const model = resolveModel(spec.model, services.tenants.modelEndpoints(auth.tenantId), await services.modelProviders.resolvable(auth.tenantId));
      const refusal = modelSettingsRefusal(model, spec);
      if (refusal) throw new Error(refusal);
    } catch (error) { throw new ApiError(400, (error as Error).message); }
  }
  for (const field of ["mcpServers", "openApi"] as const) {
    const given = raw[field];
    if (given !== undefined) {
      if (request.method === "PATCH" && !Object.hasOwn(changes, field)) spec[field] = existing?.spec[field];
      else {
        const prepared = await prepareSources(env, auth.tenantId, id, field, given, existing?.spec[field] as RemoteSource[] | undefined);
        spec[field] = field === "mcpServers" ? await discoverSources(env, auth.tenantId, id, prepared, new URL(request.url).origin) : prepared;
      }
    }
  }
  if (input.limits !== undefined && input.limits !== null) {
    const limits = object(input.limits, ["ttlSeconds", "idleTtlSeconds"]);
    for (const value of Object.values(limits)) if (value !== null && (!Number.isInteger(value) || Number(value) < 60 || Number(value) > 366 * 86400)) throw new ApiError(400, "Definition lifetimes must be 60 to 31622400 or null");
    if (limits.ttlSeconds != null && limits.idleTtlSeconds != null) throw new ApiError(400, "limits takes ttlSeconds or idleTtlSeconds, not both");
    spec.limits = limits;
  } else if (input.limits === undefined && request.method === "PATCH" && existing?.spec.limits) spec.limits = existing.spec.limits;
  const duplicate = spec.mcpServers?.find(source => spec.openApi?.some(other => other.name === source.name));
  if (duplicate) throw new ApiError(400, `${duplicate.name} names both an MCP server and an OpenAPI source`);
  if (input.description !== undefined && input.description !== null) { if (typeof input.description !== "string" || !input.description.trim() || input.description.length > 1000) throw new ApiError(400, "description must contain 1–1000 characters"); spec.description = input.description; }
  else if (request.method === "PATCH" && existing?.spec.description) spec.description = existing.spec.description;
  if (input.description === null) delete spec.description;
  // A channel's own definition stays its own across edits.
  if (typeof madeFor === "string") (spec as Record<string, unknown>).channel = madeFor;
  if (input.applyOnUpdate !== undefined && input.applyOnUpdate !== null) { if (typeof input.applyOnUpdate !== "boolean") throw new ApiError(400, "applyOnUpdate must be boolean"); if (input.applyOnUpdate) spec.applyOnUpdate = true; }
  else if (request.method === "PATCH" && existing?.spec.applyOnUpdate) spec.applyOnUpdate = true;
  if (input.applyOnUpdate === null || input.applyOnUpdate === false) delete spec.applyOnUpdate;
  return spec;
  });
  const unchanged = existing && name === existing.name && canonical(spec) === canonical(existing.spec);
  const saved = unchanged ? existing! : await transaction(env, async sql => {
    const configuredLimit = Number((env as { AGENT_MAX_DEFINITIONS_PER_TENANT?: string }).AGENT_MAX_DEFINITIONS_PER_TENANT ?? 5000);
    if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1) throw new Error("AGENT_MAX_DEFINITIONS_PER_TENANT must be a positive integer");
    const limit = services.tenants.maxDefinitions(auth.tenantId) ?? (services.tenants.has(auth.tenantId) ? configuredLimit : 200);
    if (!existing && Number((await sql.query("select count(*) as count from definitions where tenant=$1", [auth.tenantId])).rows[0].count) >= limit) throw new HttpError(409, `A tenant can have at most ${limit} definitions: delete ones no agent uses (GET /v1/definitions?unused=true lists them), or ask for a higher limit`, "DEFINITIONS_LIMIT", { limit });
    const now = Date.now(), next: Definition = { id, tenant: auth.tenantId, name, spec, revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now };
    if (existing) {
      const result = await sql.query("update definitions set name=$3,spec=$4,revision=$5,updated_at=$6 where tenant=$1 and id=$2 and revision=$7", [auth.tenantId, id, name, JSON.stringify(spec), next.revision, now, existing.revision]);
      if (!result.rowCount) throw new ApiError(409, "Definition changed; retry", "CONFLICT");
    } else await sql.query("insert into definitions(id,tenant,name,spec,revision,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$6)", [id, auth.tenantId, name, JSON.stringify(spec), next.revision, now]);
    return next;
  });
  const applied: { agent: string; requestId: string; status: string; error?: string }[] = [];
  if (input.apply === "all" || saved.spec.applyOnUpdate && existing && !unchanged) for (const agent of (await directory.list()).filter(x => x.config.definition === saved.id)) {
    // The agent merges the revision with its own settings when this request reaches the head of its queue, after the
    // configuration queued before it. Merging here, from the listing, would overwrite a change still in that queue.
    const target: DefinitionTarget = { id: saved.id, revision: saved.revision, spec: saved.spec };
    const requestId = `apply_${saved.id}_${saved.revision}`;
    const response = await env.AGENTS.getByName(agent.id).fetch(new Request("https://agent/configuration-target", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: requestId, definition: target, origin: url.origin }),
    }));
    const result = await response.json() as { state?: string; outcome?: { error?: string }; error?: string };
    const error = result.error ?? result.outcome?.error;
    applied.push({ agent: agent.id, requestId, status: !response.ok || error ? "failed" : result.state === "completed" ? "updated" : "queued", ...(error ? { error } : {}) });
  }
  return reply({ ...view(saved), ...await prepareApply(`definition-warnings:${JSON.stringify([auth.tenantId, saved.spec])}`, () => builtinWarnings(env, auth.tenantId, saved.spec)), ...(applied.length || input.apply === "all" ? { applied } : {}) }, request.method === "POST" ? 201 : 200);
}

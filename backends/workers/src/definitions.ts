import { ApiError, configuration, digest, type AgentConfiguration } from "./api-contract.ts";
import { body, object } from "./validation.ts";
import { Directory, type ControlEnv, type AuthContext, type DirectoryEntry } from "./control.ts";
import { withSql, transaction } from "./postgres.ts";
import { canonical } from "../../../shared/durable-json.ts";
import { prepareSources, sourceView, type RemoteSource } from "./tool-sources.ts";

export type Definition = { id: string; tenant: string; name: string; revision: number; spec: AgentConfiguration & { description?: string; applyOnUpdate?: boolean; limits?: { ttlSeconds?: number | null; idleTtlSeconds?: number | null }; webSearch?: { providers: string[] } }; createdAt: number; updatedAt: number };
const OVERRIDES = ["model", "thinkingLevel", "maxOutputTokens", "temperature", "dataCollection", "language", "fileTools", "codeMode", "runLimits"] as const;
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const fromRow = (row: Record<string, any>): Definition => ({ id: row.id, tenant: row.tenant, name: row.name, revision: Number(row.revision), spec: row.spec, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });
const view = ({ tenant, spec, ...definition }: Definition) => ({ ...definition, ...spec, ...(spec.mcpServers ? { mcpServers: spec.mcpServers.map(x => sourceView(x as RemoteSource)) } : {}), ...(spec.openApi ? { openApi: spec.openApi.map(x => sourceView(x as RemoteSource)) } : {}) });
export function visibleConfiguration(config: AgentConfiguration) {
  const { definitionOverrides, definitionRevision, ...visible } = config;
  return { ...visible, ...(config.mcpServers ? { mcpServers: config.mcpServers.map(source => sourceView(source as RemoteSource)) } : {}), ...(config.openApi ? { openApi: config.openApi.map(source => sourceView(source as RemoteSource)) } : {}) };
}
export async function resolveDefinition(env: ControlEnv, tenant: string, ref: string): Promise<Definition> {
  const id = /^def_[a-f0-9]{20}$/.test(ref) ? ref : `def_${(await digest(`${tenant}:${ref}`)).slice(0, 20)}`;
  const row = (await withSql(env, sql => sql.query("select * from definitions where tenant=$1 and id=$2", [tenant, id]))).rows[0];
  if (!row) throw new ApiError(404, `Unknown definition ${ref}`, "NOT_FOUND");
  return fromRow(row);
}
export async function provisionDefinition(env: ControlEnv, tenant: string, input: Record<string, unknown>) {
  if (typeof input.definition !== "string") {
    const result = { ...input };
    for (const field of ["mcpServers", "openApi"] as const) if (input[field] !== undefined) result[field] = await prepareSources(env, tenant, undefined, field, input[field]);
    return result;
  }
  if (input.systemPrompt !== undefined) throw new ApiError(400, "Use systemPromptAppend with a definition");
  const definition = await resolveDefinition(env, tenant, input.definition);
  const { description, applyOnUpdate, limits, webSearch, ...spec } = definition.spec;
  return { ...limits, ...spec, ...input, definition: definition.id, definitionRevision: definition.revision, definitionOverrides: OVERRIDES.filter(field => Object.hasOwn(input, field)) };
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
    const used = url.searchParams.get("unused") === "true" ? new Set((await directory.list()).map(agent => agent.config.definition)) : undefined;
    return reply(rows.map(fromRow).filter(def => !used?.has(def.id)).map(view));
  }
  if (request.method === "DELETE" && ref) {
    const definition = await resolveDefinition(env, auth.tenantId, ref);
    await withSql(env, sql => sql.query("delete from definitions where tenant=$1 and id=$2", [auth.tenantId, definition.id]));
    return reply({ deleted: true });
  }
  if ((request.method !== "POST" || ref) && (request.method !== "PATCH" || !ref)) throw new ApiError(405, "Method not allowed");
  const input = object(await body(request, 1024 * 1024), ["name", "revision", "description", "model", "systemPrompt", "thinkingLevel", "maxOutputTokens", "temperature", "dataCollection", "language", "fileTools", "codeMode", "limits", "runLimits", "mounts", "builtins", "webSearch", "mcpServers", "openApi", "humanInput", "delegate", "workflow", "decide", "applyOnUpdate", "apply"]);
  if (input.apply !== undefined && input.apply !== "all") throw new ApiError(400, "apply must be all");
  const key = request.headers.get("Idempotency-Key");
  if (key !== null && !/^[A-Za-z0-9_-]{1,80}$/.test(key)) throw new ApiError(400, "Invalid Idempotency-Key");
  const id = ref ? (await resolveDefinition(env, auth.tenantId, ref)).id : `def_${(await digest(key === null ? crypto.randomUUID() : `${auth.tenantId}:${key}`)).slice(0, 20)}`;
  let existing: Definition | undefined;
  try { existing = await resolveDefinition(env, auth.tenantId, id); } catch (error) { if ((error as ApiError).status !== 404) throw error; }
  if (input.revision !== undefined && (request.method === "POST" || input.revision !== existing?.revision)) throw new ApiError(409, "Definition revision changed", "CONFLICT");
  const name = input.name ?? existing?.name;
  if (typeof name !== "string" || !name.trim() || name.length > 200) throw new ApiError(400, "A definition needs a name");
  const changes = Object.fromEntries(Object.entries(input).filter(([key]) => !["name", "revision", "apply", "applyOnUpdate", "description", "limits", "webSearch"].includes(key)));
  const raw = request.method === "PATCH" ? { ...existing?.spec, ...changes } : changes;
  for (const [field, value] of Object.entries(raw)) if (value === null) delete raw[field];
  const { mcpServers, openApi, description: _description, applyOnUpdate: _applyOnUpdate, limits: _limits, webSearch: _webSearch, ...rest } = raw;
  const spec = configuration(rest, env.MODEL).config as Definition["spec"];
  if (raw.model === undefined) delete spec.model;
  for (const field of ["mcpServers", "openApi"] as const) {
    const given = raw[field];
    if (given !== undefined) spec[field] = await prepareSources(env, auth.tenantId, id, field, given, existing?.spec[field] as RemoteSource[] | undefined);
  }
  if (input.limits !== undefined && input.limits !== null) {
    const limits = object(input.limits, ["ttlSeconds", "idleTtlSeconds"]);
    for (const value of Object.values(limits)) if (value !== null && (!Number.isInteger(value) || Number(value) < 60 || Number(value) > 366 * 86400)) throw new ApiError(400, "Definition lifetimes must be 60 to 31622400 or null");
    spec.limits = limits;
  } else if (input.limits === undefined && request.method === "PATCH" && existing?.spec.limits) spec.limits = existing.spec.limits;
  const duplicate = spec.mcpServers?.find(source => spec.openApi?.some(other => other.name === source.name));
  if (duplicate) throw new ApiError(400, `${duplicate.name} names both an MCP server and an OpenAPI source`);
  if (input.description !== undefined) { if (typeof input.description !== "string") throw new ApiError(400, "description must be text"); spec.description = input.description; }
  else if (request.method === "PATCH" && existing?.spec.description) spec.description = existing.spec.description;
  if (input.applyOnUpdate !== undefined) { if (typeof input.applyOnUpdate !== "boolean") throw new ApiError(400, "applyOnUpdate must be boolean"); spec.applyOnUpdate = input.applyOnUpdate; }
  else if (request.method === "PATCH" && existing?.spec.applyOnUpdate) spec.applyOnUpdate = true;
  const unchanged = existing && name === existing.name && canonical(spec) === canonical(existing.spec);
  const saved = unchanged ? existing! : await transaction(env, async sql => {
    if (!existing && Number((await sql.query("select count(*) as count from definitions where tenant=$1", [auth.tenantId])).rows[0].count) >= 200) throw new ApiError(409, "A tenant can have at most 200 definitions", "DEFINITIONS_LIMIT");
    const now = Date.now(), next: Definition = { id, tenant: auth.tenantId, name, spec, revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now };
    if (existing) {
      const result = await sql.query("update definitions set name=$3,spec=$4,revision=$5,updated_at=$6 where tenant=$1 and id=$2 and revision=$7", [auth.tenantId, id, name, JSON.stringify(spec), next.revision, now, existing.revision]);
      if (!result.rowCount) throw new ApiError(409, "Definition changed; retry", "CONFLICT");
    } else await sql.query("insert into definitions(id,tenant,name,spec,revision,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$6)", [id, auth.tenantId, name, JSON.stringify(spec), next.revision, now]);
    return next;
  });
  const applied: { agent: string; status: string; error?: string }[] = [];
  if (input.apply === "all" || saved.spec.applyOnUpdate && existing && !unchanged) for (const agent of (await directory.list()).filter(x => x.config.definition === saved.id)) {
    const { description, applyOnUpdate, limits, webSearch, ...updates } = saved.spec;
    const own = Object.fromEntries((agent.config.definitionOverrides ?? []).map(field => [field, agent.config[field as keyof AgentConfiguration]]));
    const result = await directory.upsert({ ...agent.config, ...updates, ...own, definition: saved.id, definitionRevision: saved.revision }, agent.key ?? agent.id);
    applied.push({ agent: agent.id, status: typeof result === "object" && "failed" in result ? "failed" : "updated", ...(typeof result === "object" && "failed" in result ? { error: result.error } : {}) });
  }
  return reply({ ...view(saved), ...(applied.length || input.apply === "all" ? { applied } : {}) }, request.method === "POST" ? 201 : 200);
}

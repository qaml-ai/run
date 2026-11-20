import type { Sql } from "./db.ts";
import { HttpError } from "./core/http-error.ts";

type McpServer = { name: string; sealed?: unknown };
type OpenApiSource = McpServer & { operations: { name: string }[] };
type ReadSpec = {
  channel?: string; builtins?: string[]; humanInput?: object;
  mcpServers?: McpServer[]; openApi?: OpenApiSource[];
};
type DefinitionRow<Spec extends ReadSpec> = {
  id: string; tenant: string; name: string; revision: number; spec: Spec;
  created_at: number; updated_at: number;
};
type DefinitionRead = {
  id: string; tenant: string; name: string; revision: number; spec: ReadSpec;
  createdAt: number; updatedAt: number; revised?: boolean;
};

/** The original API only accepts these routes for definition reads. */
export function legacyDefinitionRead(request: Request) {
  if (request.method !== "GET" || !request.headers.has("authorization")) return;
  const url = new URL(request.url);
  if (url.pathname === "/v1/definitions") return { unused: url.searchParams.get("unused") === "true" };
  const match = /^\/v1\/definitions\/([^/]+)(\/agents)?$/.exec(url.pathname);
  if (!match) return;
  try {
    return { id: decodeURIComponent(match[1]), agents: !!match[2] };
  } catch {
    // Let the original router handle malformed percent escapes.
  }
}

/** The public view exposes OpenAPI tool names without either source's sealed credentials. */
export const mcpServerView = <Server extends McpServer>({ sealed: _sealed, ...server }: Server) => server;
export const openApiView = <Source extends OpenApiSource>({ sealed: _sealed, operations, ...source }: Source) => ({ ...source, tools: operations.map(operation => operation.name) });

function definitionRow<Spec extends ReadSpec>(row: DefinitionRow<Spec>) {
  // Legacy workflow and input expiry settings were retired.
  const { workflow: _workflow, ...stored } = row.spec as Spec & { workflow?: unknown };
  const spec: Spec = { ...stored, ...(stored.builtins ? { builtins: stored.builtins.filter(name => name !== "workflow") } : {}) } as Spec;
  if (spec.humanInput && "onExpire" in spec.humanInput) {
    const { onExpire: _onExpire, ...humanInput } = spec.humanInput;
    spec.humanInput = humanInput;
  }
  return { id: row.id, tenant: row.tenant, name: row.name, revision: row.revision, spec, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function definitionView<Definition extends DefinitionRead>({ tenant: _tenant, spec, revised: _revised, ...definition }: Definition) {
  const { channel: _channel, mcpServers, openApi, ...visible } = spec as Definition["spec"];
  return { ...definition, ...visible, ...(mcpServers ? { mcpServers: mcpServers.map(mcpServerView) } : {}), ...(openApi ? { openApi: openApi.map(openApiView) } : {}) };
}

export async function readDefinition<Spec extends ReadSpec = ReadSpec>(db: Sql, tenant: string, id: string, revision?: number) {
  const row = /^def_[a-f0-9]{20}$/.test(id) ? (await db.query<DefinitionRow<Spec>>(
    revision === undefined ? "select * from definitions where id = $1 and tenant = $2" : "select * from definition_revisions where id = $1 and tenant = $2 and revision = $3",
    revision === undefined ? [id, tenant] : [id, tenant, revision],
  )).rows[0] : undefined;
  if (!row) throw new HttpError(404, `Unknown definition ${id}`);
  return definitionRow(row);
}

export async function listDefinitions<Spec extends ReadSpec = ReadSpec>(db: Sql, tenant: string, unused: boolean) {
  const { rows } = await db.query<DefinitionRow<Spec>>(`select * from definitions d where tenant = $1 ${unused ? `
    and not exists (select 1 from agents a where a.tenant = d.tenant and a.header->'definition'->>'id' = d.id and not a.revoked and a.purged_at is null and (a.expires_at is null or a.expires_at > $2))
    and not exists (select 1 from channels c where c.tenant = d.tenant and c.channel->>'definition' = d.id)` : "and $2::bigint is not null"}
    order by created_at, id`, [tenant, Date.now()]);
  return rows.map(row => definitionView(definitionRow(row)));
}

export async function definitionAgents(db: Sql, tenant: string, id: string) {
  const { rows } = await db.query<{ id: string; revision: number }>(`
    select id, (header->'definition'->>'revision')::bigint as revision from agents
    where tenant = $1 and header->'definition'->>'id' = $2 and not revoked and purged_at is null
      and (expires_at is null or expires_at > $3) order by id`, [tenant, id, Date.now()]);
  return rows;
}

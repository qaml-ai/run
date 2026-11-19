import { Buffer } from "node:buffer";
import { metadataFilters } from "../shared/agent-metadata.ts";
import { HttpError } from "./core/http-error.ts";

/** GET /v1/agents' filters and page. Without `limit` the whole (filtered) list, as callers have always had it. */
export type AgentListQuery = {
  limit?: number;
  /** The previous page's `next`: agents after it, by id. */
  cursor?: string;
  /** A workspace id, or "unassigned" for agents in none. */
  workspaceId?: string;
  /** running: served by a node now; failed: a run failed in the last 24 hours; expiring: has an expiry. */
  status?: "running" | "failed" | "expiring";
  /** Only sub-agents (a delegate or spawn_agent call made them), or none of them. */
  subAgents?: "only" | "exclude";
  /** Part of its name, key or id, ignoring case. */
  q?: string;
  metadata?: Record<string, string>;
  /** Just this agent (GET /v1/agents/{id}'s summary). */
  id?: string;
};
export const AGENT_PAGE_MAX = 200;
const FAILED_WINDOW_MS = 24 * 3600_000;
const encodeCursor = (id: string) => Buffer.from(id).toString("base64url");
function decodeCursor(cursor: string) {
  const id = Buffer.from(cursor, "base64url").toString();
  if (!id || id.length > 200 || encodeCursor(id) !== cursor) throw new HttpError(400, "cursor must be a previous page's next");
  return id;
}
const like = (value: string) => `%${value.replace(/[\\%_]/g, match => `\\${match}`)}%`;

type DirectoryRow = {
  id: string;
  key: string | null;
  name: string;
  type: string;
  model: string;
  config_hash: string;
  parent: string | null;
  application_metadata: Record<string, unknown>;
  expires_at: number | null;
  resume_failures: number;
  resume_after: number | null;
  last_active_at: number | null;
  last_error_at: number | null;
  last_error_class: string;
  workspace: string | null;
  served: boolean;
};
type Queryable = { query<Row>(text: string, values: unknown[]): Promise<{ rows: Row[] }> };
type Presence = (id: string, served: boolean) => { running: boolean; connected: boolean; configHash?: string };

/** A tenant's live agents (excluding stateless runs), filtered and ordered by id. */
export async function listAgentPage(db: Queryable, tenant: string, query: AgentListQuery = {}, presence?: Presence) {
  const now = Date.now();
  const params: unknown[] = [tenant, now];
  const where = ["a.tenant = $1", "not a.revoked", "(a.expires_at is null or a.expires_at > $2)", "a.header->'run' is null"];
  const param = (value: unknown) => { params.push(value); return `$${params.length}`; };
  if (query.metadata && Object.keys(query.metadata).length) where.push(`coalesce(a.header::jsonb->'metadata'->'application', a.header::jsonb->'config'->'metadata', '{}'::jsonb) @> ${param(JSON.stringify(query.metadata))}::jsonb`);
  if (query.id !== undefined) where.push(`a.id = ${param(query.id)}`);
  if (query.cursor !== undefined) where.push(`a.id > ${param(decodeCursor(query.cursor))}`);
  if (query.workspaceId === "unassigned") where.push("w.workspace is null");
  else if (query.workspaceId !== undefined) where.push(`w.workspace = ${param(query.workspaceId)}`);
  if (query.status === "running") where.push("n.node is not null");
  if (query.status === "failed") where.push(`a.last_error_at > ${param(now - FAILED_WINDOW_MS)}`);
  if (query.status === "expiring") where.push("a.expires_at is not null");
  if (query.subAgents === "only") where.push("a.header->'parent'->>'agentId' is not null");
  if (query.subAgents === "exclude") where.push("a.header->'parent'->>'agentId' is null");
  if (query.q?.trim()) {
    const pattern = param(like(query.q.trim()));
    where.push(`(a.name ilike ${pattern} or a.header->>'key' ilike ${pattern} or a.id ilike ${pattern})`);
  }
  const limit = query.limit === undefined ? undefined : Math.min(Math.max(1, query.limit), AGENT_PAGE_MAX);
  const { rows } = await db.query<DirectoryRow>(`
    select coalesce(a.header::jsonb->'metadata'->'application', '{}'::jsonb) as application_metadata, a.id, a.header->>'key' as key, a.name, a.type, a.model, a.expires_at, a.resume_failures, a.resume_after, a.header->'parent'->>'agentId' as parent, a.header->>'provisionHash' as config_hash,
      a.last_active_at, a.last_error_at, a.last_error_class, w.workspace, n.node is not null as served
    from agents a
    left join actor_owners o on o.actor = a.id
    left join runtime_nodes n on n.node = o.node and n.session = o.session and n.expires_at > now()
    left join lateral (select workspace from workspace_assignments wa where wa.tenant = a.tenant and wa.kind = 'agent' and wa.resource = a.id order by wa.assigned_at desc, wa.sequence desc limit 1) w on true
    where ${where.join(" and ")} order by a.id${limit === undefined ? "" : ` limit ${limit + 1}`}`, params);
  const more = limit !== undefined && rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const agents = page.map(row => {
    const { running, connected, configHash } = presence?.(row.id, row.served) ?? { running: row.served, connected: false };
    return { metadata: row.application_metadata, id: row.id, key: row.key, name: row.name, type: row.type, model: row.model, configHash: configHash ?? row.config_hash, connected, running, expiresAt: row.expires_at,
      resume: row.resume_failures ? { failures: row.resume_failures, after: Number(row.resume_after) } : null, ...(row.parent ? { parentAgentId: row.parent } : {}),
      workspaceId: row.workspace ?? null,
      lastActiveAt: row.last_active_at === null ? null : Number(row.last_active_at),
      lastError: row.last_error_at === null ? null : { at: Number(row.last_error_at), class: row.last_error_class } };
  });
  // Served by a node but not loaded there is not running: the page can come out shorter, never wrong.
  return { agents: query.status === "running" ? agents.filter(agent => agent.running) : agents, next: more ? encodeCursor(page.at(-1)!.id) : undefined };
}

export function agentListQuery(params: URLSearchParams): AgentListQuery {
  const query: Record<string, string | undefined> = Object.create(null);
  for (const [name, value] of params) query[name] ??= value;
  const limit = query.limit === undefined ? undefined : Number(query.limit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_PAGE_MAX)) throw new HttpError(400, `limit must be an integer from 1 to ${AGENT_PAGE_MAX}`);
  const oneOf = <T extends string>(name: string, values: readonly T[]) => {
    const value = query[name];
    if (value !== undefined && !values.includes(value as T)) throw new HttpError(400, `${name} must be one of ${values.join(", ")}`);
    return value as T | undefined;
  };
  if (query.q !== undefined && query.q.length > 200) throw new HttpError(400, "q must be at most 200 characters");
  let metadata: Record<string, string>;
  try { metadata = metadataFilters(params); } catch (error) { throw new HttpError(400, (error as Error).message); }
  return { metadata,
    // A cursor without a limit pages at the largest size.
    limit: limit ?? (query.cursor !== undefined ? AGENT_PAGE_MAX : undefined), cursor: query.cursor, workspaceId: query.workspaceId || undefined, q: query.q,
    status: oneOf("status", ["running", "failed", "expiring"] as const), subAgents: oneOf("subAgents", ["only", "exclude"] as const),
  };
}

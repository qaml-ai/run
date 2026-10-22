import { randomBytes } from "node:crypto";
import { transaction, type Db, type Sql } from "./db.ts";
import { HttpError } from "./http.ts";
import type { Totals } from "./accounts.ts";

export type WorkspaceKind = "agent" | "definition";
export interface Workspace { id: string; name: string; archived: boolean; createdAt: number; updatedAt: number }
const view = (row: any): Workspace => ({ id: row.id, name: row.name, archived: row.archived, createdAt: row.created_at, updatedAt: row.updated_at });

/** Account-level organization, separate from the /workspace filesystem each agent owns. */
export class Workspaces {
  readonly db: Db;
  constructor(db: Db) { this.db = db; }
  async list(tenant: string) {
    return (await this.db.query("select * from workspaces where tenant = $1 order by created_at, id", [tenant])).rows.map(view);
  }
  async get(tenant: string, id: string, sql: Sql = this.db) {
    const row = (await sql.query("select * from workspaces where tenant = $1 and id = $2", [tenant, id])).rows[0];
    if (!row) throw new HttpError(404, "Unknown workspace");
    return view(row);
  }
  async create(tenant: string, name: string) {
    const now = Date.now();
    const row = (await this.db.query("insert into workspaces (id, tenant, name, created_at, updated_at) values ($1,$2,$3,$4,$4) returning *", [`ws_${randomBytes(10).toString("hex")}`, tenant, name, now])).rows[0];
    return view(row);
  }
  async update(tenant: string, id: string, input: { name?: string; archived?: boolean }) {
    await this.get(tenant, id);
    return view((await this.db.query("update workspaces set name = coalesce($3, name), archived = coalesce($4, archived), updated_at = $5 where tenant = $1 and id = $2 returning *", [tenant, id, input.name ?? null, input.archived ?? null, Date.now()])).rows[0]);
  }
  async current(tenant: string, kind: WorkspaceKind, resource: string, sql: Sql = this.db) {
    return (await sql.query("select workspace from workspace_assignments where tenant = $1 and kind = $2 and resource = $3 order by assigned_at desc, sequence desc limit 1", [tenant, kind, resource])).rows[0] as { workspace: string | null } | undefined;
  }
  async validate(tenant: string, workspace: unknown) {
    if (workspace === null) return;
    if (typeof workspace !== "string") throw new HttpError(400, "workspaceId must be a workspace id or null");
    if ((await this.get(tenant, workspace)).archived) throw new HttpError(409, "This workspace is archived; restore it before assigning agents");
  }
  async assign(tenant: string, kind: WorkspaceKind, resource: string, workspace: string | null, onlyIfAbsent = false, allowArchived = false) {
    return transaction(this.db, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["workspace", tenant, kind, resource])]);
      const previous = await this.current(tenant, kind, resource, sql);
      if (onlyIfAbsent && previous || previous?.workspace === workspace) return previous!;
      if (!allowArchived && workspace !== null && (await this.get(tenant, workspace, sql)).archived) throw new HttpError(409, "This workspace is archived; restore it before assigning agents");
      await sql.query("insert into workspace_assignments (tenant, kind, resource, workspace, assigned_at) values ($1,$2,$3,$4,$5)", [tenant, kind, resource, workspace, Date.now()]);
      return { workspace };
    });
  }
  async memberships(tenant: string) {
    return (await this.db.query(`select kind, resource as id, workspace as "workspaceId" from (
      select distinct on (kind, resource) kind, resource, workspace from workspace_assignments
      where tenant = $1 order by kind, resource, assigned_at desc, sequence desc
    ) a`, [tenant])).rows;
  }
  async members(tenant: string, workspace: string) {
    await this.get(tenant, workspace);
    return (await this.db.query(`select kind, resource as id from (
      select distinct on (kind, resource) kind, resource, workspace from workspace_assignments
      where tenant = $1 order by kind, resource, assigned_at desc, sequence desc
    ) a where workspace = $2 order by kind, resource`, [tenant, workspace])).rows;
  }
}

export type AttributedUsage = Totals & { tenant: string; agent: string; timestamp: number; day: string; model: string };
/** In the same transaction as account totals. Signed reconciliation deltas use the original call's timestamp. */
export async function applyWorkspaceUsage(sql: Sql, rows: AttributedUsage[]) {
  if (!rows.length) return;
  await sql.query(`insert into workspace_usage (tenant, workspace, day, model, responses, input, output, cache_read, cache_write, cost, platform_responses, platform_cost)
    select t.tenant, a.workspace, t.day::date, t.model, sum(t.responses), sum(t.input), sum(t.output), sum(t."cacheRead"), sum(t."cacheWrite"), sum(t.cost), sum(t."platformResponses"), sum(t."platformCost")
    from jsonb_to_recordset($1::jsonb) as t(tenant text, agent text, timestamp bigint, day text, model text, responses bigint, input bigint, output bigint, "cacheRead" bigint, "cacheWrite" bigint, cost double precision, "platformResponses" bigint, "platformCost" double precision)
    cross join lateral (select workspace from workspace_assignments where tenant = t.tenant and kind = 'agent' and resource = t.agent and assigned_at <= t.timestamp order by assigned_at desc, sequence desc limit 1) a
    where a.workspace is not null group by t.tenant, a.workspace, t.day, t.model
    on conflict (tenant, workspace, day, model) do update set responses = workspace_usage.responses + excluded.responses,
      input = workspace_usage.input + excluded.input, output = workspace_usage.output + excluded.output,
      cache_read = workspace_usage.cache_read + excluded.cache_read, cache_write = workspace_usage.cache_write + excluded.cache_write,
      cost = workspace_usage.cost + excluded.cost, platform_responses = workspace_usage.platform_responses + excluded.platform_responses, platform_cost = workspace_usage.platform_cost + excluded.platform_cost`, [JSON.stringify(rows)]);
}

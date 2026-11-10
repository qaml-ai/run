/** Accounting attribution shared by both hosts. Amounts are USD, retained for 400 UTC days. */
type Sql = { query(text: string, values?: any[]): Promise<{ rows: any[] }> };
export const USAGE_RETENTION_DAYS = 400;
export const usageDimensions = ["agent", "definition", "endUser", "bucket", "model", "day"] as const;
const fields = ["responses", "input", "output", "cacheRead", "cacheWrite", "cost", "platformResponses", "platformCost"];
export class UsageQueryError extends Error { status = 400; code = "INVALID_REQUEST"; }
export function usageDays(query: { get(name: string): string | null }) {
  const days = Number(query.get("days") ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new UsageQueryError("days must be an integer from 1 to 365");
  return days;
}
export function usageOptions(query: { get(name: string): string | null }) {
  const dimensions = (query.get("groupBy") ?? "agent").split(",");
  if (dimensions.some(d => !(usageDimensions as readonly string[]).includes(d)) || new Set(dimensions).size !== dimensions.length)
    throw new UsageQueryError("groupBy must contain unique agent, definition, endUser, bucket, model or day dimensions");
  const rollup = query.get("rollup") ?? "false";
  if (rollup !== "true" && rollup !== "false") throw new UsageQueryError("rollup must be true or false");
  const limit = Number(query.get("limit") ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new UsageQueryError("limit must be an integer from 1 to 500");
  return { dimensions, rollup: rollup === "true", limit, cursor: query.get("cursor") ?? undefined };
}
type Attribution = { root: string | null; definition: string | null; workspace: string | null };
/** Indexed metadata reads only. Never reads usage_details from an accounting transaction. */
const attributionRows = `select t,
  case when t ? 'attribution' then t->'attribution'->>'root' else
    coalesce(child.root, a.header->'parent'->'chain'->>0, a.header->'parentPlace'->'chain'->>0,
      a.header->'parent'->>'agentId', a.header->>'parentAgentId', nullif(t->>'agent','')) end as root_agent,
  case when t ? 'attribution' then t->'attribution'->>'definition' else
    coalesce(a.header->'definition'->>'id', a.header->'config'->>'definition') end as definition,
  case when t ? 'attribution' then t->'attribution'->>'workspace' else w.workspace end as workspace
  from jsonb_array_elements($1::jsonb) t
  left join agent_children child on child.tenant=t->>'tenant' and child.child=t->>'agent' and child.request_id=t->>'requestId'
  left join agents a on a.tenant=t->>'tenant' and a.id=t->>'agent'
  left join lateral (select workspace from workspace_assignments where tenant=t->>'tenant' and kind='agent'
    and resource=t->>'agent' and assigned_at <= (t->>'timestamp')::bigint order by assigned_at desc, sequence desc limit 1) w on true`;
export async function resolveUsageAttribution(sql: Sql, row: { tenant: string; agent: string; timestamp: number; requestId?: string }): Promise<Attribution> {
  const value = (await sql.query(attributionRows, [JSON.stringify([row])])).rows[0];
  return { root: value.root_agent, definition: value.definition, workspace: value.workspace };
}
export async function recordUsageDetails(sql: Sql, rows: any[]) {
  if (!rows.length) return;
  const sums = fields.map(f => `'${f}', sum(coalesce((t->>'${f}')::double precision,0))`).join(",");
  // Keep the original aggregate and conflict key usable by older servers during a rolling deployment.
  // A single statement resolves attribution once and commits both aggregates atomically.
  const writes = ["usage_details", "usage_bucket_details"].map(table => {
    const bucket = table === "usage_bucket_details";
    const bucketColumn = bucket ? ", bucket" : "";
    const bucketValue = bucket ? ", nullif(t->>'bucket','')" : "";
    const additions = fields.map(f => `'${f}', (${table}.totals->>'${f}')::double precision + (excluded.totals->>'${f}')::double precision`).join(",");
    return `insert into ${table} (tenant, day, agent, root_agent, definition, end_user, model, workspace${bucketColumn}, totals)
      select t->>'tenant', (t->>'day')::date, nullif(t->>'agent',''), root_agent, definition, t->>'endUser', t->>'model', workspace${bucketValue},
        jsonb_build_object(${sums}) from attributed
      where (t->>'day')::date >= (now() at time zone 'UTC')::date - 399
        ${bucket ? "and nullif(t->>'bucket','') is not null" : ""}
      group by t->>'tenant', t->>'day', nullif(t->>'agent',''), root_agent, definition, t->>'endUser', t->>'model', workspace${bucketValue}
      order by 1,2,3,4,5,6,7,8${bucket ? ",9" : ""}
      on conflict (tenant, day, agent, root_agent, definition, end_user, model, workspace${bucketColumn})
      do update set totals=jsonb_build_object(${additions})`;
  });
  await sql.query(`with attributed as materialized (${attributionRows}),
    overall as (${writes[0]} returning 1) ${writes[1]}`, [JSON.stringify(rows)]);
}
/** Bounded maintenance, run by both hosts; reads also exclude expired rows. */
export async function pruneUsageDetails(sql: Sql) {
  for (const table of ["usage_details", "usage_bucket_details"]) {
    await sql.query(`delete from ${table} where ctid in (select ctid from ${table} where day < (now() at time zone 'UTC')::date - 399 order by day limit 10000)`);
  }
}
export async function ownsUsageAgent(sql: Sql, tenant: string, agent: string) {
  return (await sql.query(`select 1 from agents where tenant=$1 and id=$2
    union all select 1 from usage_details where tenant=$1 and (agent=$2 or root_agent=$2)
      and day >= (now() at time zone 'UTC')::date - 399 limit 1`, [tenant, agent])).rows.length > 0;
}
export async function groupedUsage(sql: Sql, tenant: string, since: number,
  options: { dimensions: string[]; rollup: boolean; limit?: number; cursor?: string }, agent?: string, workspace?: string) {
  const columns: Record<string,string> = { agent: options.rollup ? "root_agent" : "agent", definition: "definition", endUser: "end_user", bucket: "bucket", model: "model", day: "to_char(day, 'YYYY-MM-DD')" };
  const day = new Date(since).toISOString().slice(0,10), limit = options.limit ?? 100;
  const scope = JSON.stringify([tenant, day, options.dimensions, options.rollup, agent ?? null, workspace ?? null]);
  let after = null;
  if (options.cursor) {
    try {
      if (options.cursor.length > 16384) throw new Error();
      const cursor = JSON.parse(decodeURIComponent(options.cursor));
      if (cursor.scope !== scope || !Array.isArray(cursor.key) || cursor.key.length !== options.dimensions.length ||
        cursor.key.some((v: unknown) => v !== null && typeof v !== "string")) throw new Error();
      after = JSON.stringify(cursor.key);
    } catch { throw new UsageQueryError("Invalid cursor for this usage query"); }
  }
  const select = options.dimensions.map(d => `${columns[d]} as "${d}"`);
  const sums = fields.map(f => `coalesce(sum((totals->>'${f}')::double precision),0) as "${f}"`);
  const key = `jsonb_build_array(${options.dimensions.map(d => columns[d]).join(",")})`;
  const allTotals = fields.map(f => `'${f}', coalesce(sum("${f}"),0)`).join(",");
  const byBucket = options.dimensions.includes("bucket");
  const identity = "tenant, day, agent, root_agent, definition, end_user, model, workspace";
  const negative = fields.map(f => `'${f}', -(totals->>'${f}')::double precision`).join(",");
  // Unknown attribution is the original total minus its known-bucket subset. This includes
  // historical usage and writes from servers that have not upgraded yet.
  const source = byBucket ? `(
    select ${identity}, null::text as bucket, totals from usage_details
    union all select ${identity}, bucket, totals from usage_bucket_details
    union all select ${identity}, null::text as bucket, jsonb_build_object(${negative}) from usage_bucket_details
  ) attributed` : "usage_details";
  // Floating-point cancellation can leave a sub-picodollar residual in the unknown group.
  const nonzero = fields.map(f => `abs(sum((totals->>'${f}')::double precision)) > 1e-12`).join(" or ");
  const result = (await sql.query(`with grouped as (
    select ${key} as key, ${[...select,...sums].join(",")} from ${source}
    where tenant=$1 and day >= greatest($2::date, (now() at time zone 'UTC')::date - 399)
      and ($3::text is null or ${options.rollup ? "root_agent" : "agent"}=$3)
      and ($4::text is null or workspace is not distinct from nullif($4,'unassigned'))
    group by ${options.dimensions.map(d => columns[d]).join(",")}
    ${byBucket ? `having ${nonzero}` : ""}
  ) select (select jsonb_build_object(${allTotals}) from grouped) as totals,
    coalesce((select jsonb_agg(p order by key) from
      (select * from grouped where $5::jsonb is null or key > $5::jsonb order by key limit $6) p), '[]'::jsonb) as rows`,
    [tenant, day, agent ?? null, workspace ?? null, after, limit + 1])).rows[0];
  const page = result.rows.slice(0, limit), last = page.at(-1);
  return { since, groupBy: options.dimensions, rollup: options.rollup, totals: result.totals,
    groups: page.map(({ key: _key, ...row }: any) => row),
    ...(result.rows.length > limit ? { next: encodeURIComponent(JSON.stringify({ scope, key: last.key })) } : {}) };
}

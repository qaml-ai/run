/** Accounting attribution shared by both hosts. No agent history or webhook subscription is required. */
type Sql = { query(text: string, values?: any[]): Promise<{ rows: any[] }> };
export const usageDimensions = ["agent", "definition", "endUser", "model", "day"] as const;
export function usageOptions(query: { get(name: string): string | null }) {
  const groupBy = query.get("groupBy") ?? "agent";
  const dimensions = groupBy.split(",");
  if (!dimensions.length || dimensions.some(d => !(usageDimensions as readonly string[]).includes(d)) || new Set(dimensions).size !== dimensions.length)
    throw new Error("groupBy must contain unique agent, definition, endUser, model or day dimensions");
  const rollup = query.get("rollup") ?? "false";
  if (rollup !== "true" && rollup !== "false") throw new Error("rollup must be true or false");
  return { dimensions, rollup: rollup === "true" };
}
export async function recordUsageDetails(sql: Sql, rows: any[]) {
  if (!rows.length) return;
  await sql.query(`insert into usage_details (tenant, agent, root_agent, definition, end_user, workspace, occurred_at, day, model, totals)
    select t->>'tenant', nullif(t->>'agent',''),
      coalesce(prior.root_agent, child.root, a.header->'parent'->'chain'->>0, a.header->'parentPlace'->'chain'->>0, a.header->'parent'->>'agentId', a.header->>'parentAgentId', nullif(t->>'agent','')),
      case when prior.occurred_at is not null then prior.definition else coalesce(a.header->'definition'->>'id', a.header->'config'->>'definition') end, t->>'endUser', w.workspace, (t->>'timestamp')::bigint, (t->>'day')::date, t->>'model',
      t - 'requestId' - 'tenant' - 'agent' - 'timestamp' - 'day' - 'model' - 'endUser'
    from jsonb_array_elements($1::jsonb) t
    left join lateral (select root_agent, definition, occurred_at from usage_details
      where tenant=t->>'tenant' and agent=t->>'agent' and occurred_at=(t->>'timestamp')::bigint and model=t->>'model' limit 1) prior on true
    left join agent_children child on child.tenant=t->>'tenant' and child.child=t->>'agent' and child.request_id=t->>'requestId'
    left join agents a on a.tenant=t->>'tenant' and a.id=t->>'agent'
    left join lateral (select workspace from workspace_assignments where tenant=t->>'tenant' and kind='agent'
      and resource=t->>'agent' and assigned_at <= (t->>'timestamp')::bigint order by assigned_at desc, sequence desc limit 1) w on true`, [JSON.stringify(rows)]);
}
export async function groupedUsage(sql: Sql, tenant: string, since: number, options: { dimensions: string[]; rollup: boolean }, agent?: string, workspace?: string) {
  const columns: Record<string,string> = { agent: options.rollup ? "root_agent" : "agent", definition: "definition", endUser: "end_user", model: "model", day: "to_char(day, 'YYYY-MM-DD')" };
  const select = options.dimensions.map(d => `${columns[d]} as "${d}"`);
  const fields = ["responses", "input", "output", "cacheRead", "cacheWrite", "cost", "platformResponses", "platformCost"];
  const sums = fields.map(f => `coalesce(sum((totals->>'${f}')::double precision),0) as "${f}"`);
  const rows = (await sql.query(`select ${[...select,...sums].join(",")} from usage_details
    where tenant=$1 and day >= $2::date and ($3::text is null or ${options.rollup ? "root_agent" : "agent"}=$3)
      and ($4::text is null or coalesce(workspace,'unassigned')=$4)
    group by ${options.dimensions.map(d => columns[d]).join(",")} order by ${options.dimensions.map((_,i) => i+1).join(",")}`,
    [tenant, new Date(since).toISOString().slice(0,10), agent ?? null, workspace ?? null])).rows;
  const totals = Object.fromEntries(fields.map(f => [f, rows.reduce((sum,r) => sum + Number(r[f]), 0)]));
  return { since, groupBy: options.dimensions, rollup: options.rollup, totals, groups: rows };
}

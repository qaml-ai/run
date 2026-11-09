/** Shared SQL projection of scheduled requests. Reading deliveries never loads an agent. */
type Sql = { query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount?: number | null }> };
export type ScheduleRunSource = { tenant: string; agent: string; schedule: string; createdAt: number };
export const SCHEDULE_RUN_RETENTION_MS = 30 * 86_400_000;
export const FRESH_RUN_TTL_MS = 7 * 86_400_000;
export const MAX_FRESH_RUN_AGENTS = 200;
export const FRESH_CAP_ERROR = 'This schedule already has 200 live run agents; delete or wait for a run agent to expire';

export function scheduleRunMetadata(source: ScheduleRunSource) {
  return { scheduleAgent: source.agent, scheduleId: source.schedule };
}
export function scheduleRunSource(tenant: string, record: any): ScheduleRunSource | undefined {
  const metadata = record.metadata ?? record.params?.metadata;
  if (!record.id?.startsWith('schedule-') || typeof metadata?.scheduleAgent !== 'string' || typeof metadata?.scheduleId !== 'string') return;
  return {tenant,agent:metadata.scheduleAgent,schedule:metadata.scheduleId,createdAt:Number(metadata.scheduleCreatedAt) || record.startedAt || Date.now()};
}
export function scheduleRunOutcome(record: any) {
  const result = record.outcome?.result;
  const error = record.outcome?.error ?? result?.error ?? (result?.stopped && result.stopped !== 'input_required' ? result.stopped : null);
  const state = record.state !== 'completed' ? record.state ?? 'queued' : error ? 'failed' : result?.stopped === 'input_required' ? 'input_required' : 'completed';
  const usage = result?.usage;
  const cost = ['costUsd','subagentCostUsd','imageCostUsd','decisionCostUsd'].reduce((sum,key) => sum + (typeof usage?.[key] === 'number' ? usage[key] : 0), 0);
  return {state,error:error == null ? null : String(error).slice(0,1000),cost,endedAt:record.endedAt ?? null};
}
export async function recordScheduleRun(sql: Sql, source: ScheduleRunSource, agent: string | null, record: any) {
  const outcome = scheduleRunOutcome(record);
  await sql.query(`insert into schedule_runs(id,tenant,agent,schedule,run_agent,created_at,state,error,cost,ended_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    on conflict(id) do update set run_agent=coalesce(excluded.run_agent,schedule_runs.run_agent),
      state=excluded.state,error=excluded.error,cost=excluded.cost,ended_at=excluded.ended_at,
      expires_at=case when excluded.run_agent is null and excluded.ended_at is not null and schedule_runs.run_agent is null then null else schedule_runs.expires_at end
    where schedule_runs.tenant=excluded.tenant and (schedule_runs.ended_at is null or excluded.ended_at is not null)`,
    [record.id,source.tenant,source.agent,source.schedule,agent,source.createdAt,outcome.state,outcome.error,outcome.cost,outcome.endedAt]);
}
/** Call in a transaction. Reservations count until provisioned, so concurrent fires cannot overrun the cap. */
export async function reserveFreshScheduleRun(sql: Sql, source: ScheduleRunSource, id: string, now = Date.now()) {
  await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`schedule-runs:${source.tenant}:${source.schedule}`]);
  const prior = (await sql.query('select run_agent,expires_at from schedule_runs where id=$1 and tenant=$2', [id,source.tenant])).rows[0];
  if (prior?.expires_at && Number(prior.expires_at) > now) return prior.run_agent as string | null;
  const live = (await sql.query(`select count(*)::int as count from schedule_runs r where tenant=$1 and schedule=$2 and expires_at>$3
    and (run_agent is null or exists(select 1 from agents a where a.id=r.run_agent and not a.revoked
      and (a.expires_at is null or a.expires_at>$3)))`, [source.tenant,source.schedule,now])).rows[0].count;
  if (Number(live) >= MAX_FRESH_RUN_AGENTS) throw Object.assign(new Error(FRESH_CAP_ERROR), {status:429});
  await sql.query(`insert into schedule_runs(id,tenant,agent,schedule,created_at,expires_at,state) values($1,$2,$3,$4,$5,$6,'queued')
    on conflict(id) do update set expires_at=excluded.expires_at,state='queued',error=null,ended_at=null`,
    [id,source.tenant,source.agent,source.schedule,source.createdAt,now+FRESH_RUN_TTL_MS]);
  return null;
}
/** One short transaction per maintenance tick, with locked rows skipped rather than waited on. */
export async function pruneScheduleRuns(sql: Sql, now = Date.now()) {
  return sql.query(`delete from schedule_runs where id in (select id from schedule_runs where created_at<$1
    order by created_at,id limit 500 for update skip locked)`, [now-SCHEDULE_RUN_RETENTION_MS]);
}
export async function readScheduleRuns(sql: Sql, tenant: string, agent: string) {
  return (await sql.query(`select r.id,r.id as "runId",r.schedule,r.run_agent as agent,r.created_at as "createdAt",r.ended_at as "endedAt",r.state,r.error,r.cost,
    d.state as "emailState",d.error as "emailError",d.email,d.sent_at as "sentAt",d.message_id as "messageId"
    from schedule_runs r left join schedule_deliveries d on d.id=r.id where r.tenant=$1 and r.agent=$2 order by r.created_at desc,r.id limit 100`, [tenant,agent])).rows;
}

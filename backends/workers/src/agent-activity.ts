import { withSql } from './postgres.ts';
import type { ControlEnv } from './control.ts';

/** Retain only a safe failure classification in the account-wide directory. */
export async function recordAgentActivity(env: ControlEnv, tenant: string, agent: string, record: { endedAt?: number; outcome?: { result?: unknown; error?: string; uncertain?: boolean } }) {
  const result = record.outcome?.result as { error?: string; code?: string; stopped?: string } | undefined;
  const failure = result?.error ? (/^[a-z][a-z0-9_]*$/.test(result.code ?? '') ? result.code : 'model_error')
    : record.outcome?.error ? record.outcome.uncertain ? 'runtime_restart' : 'runtime_error' : null;
  await withSql(env, sql => sql.query(`update agents set last_active_at=$3,
    last_error_at=case when $4::text is null then null else $3 end, last_error_class=$4
    where id=$1 and tenant=$2`, [agent, tenant, record.endedAt ?? Date.now(), failure]));
}

export async function agentActivity(env: ControlEnv, tenant: string, agent: string) {
  const { rows } = await withSql(env, sql => sql.query(`select a.last_active_at, a.last_error_at, a.last_error_class,
    (select workspace from workspace_assignments where tenant=a.tenant and kind='agent' and resource=a.id order by assigned_at desc, sequence desc limit 1) workspace
    from agents a where a.tenant=$1 and a.id=$2`, [tenant, agent]));
  const row = rows[0];
  return { workspaceId: row?.workspace ?? null, lastActiveAt: row?.last_active_at == null ? null : Number(row.last_active_at),
    lastError: row?.last_error_class ? { at: Number(row.last_error_at), class: row.last_error_class } : null };
}

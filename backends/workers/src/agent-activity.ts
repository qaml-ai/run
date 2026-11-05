import { outcomeEnding, type Outcome } from '../../../shared/client-protocol.ts';
import { withSql } from './postgres.ts';
import type { ControlEnv } from './control.ts';

/** Retain only a safe failure classification in the account-wide directory. */
export async function recordAgentActivity(env: ControlEnv, tenant: string, agent: string, record: { endedAt?: number; outcome?: { result?: unknown; error?: string; uncertain?: boolean } }) {
  const ending = outcomeEnding(record.outcome as Outcome | undefined);
  const code = (record.outcome?.result as { code?: unknown } | undefined)?.code;
  const failure = ending.stopped && ending.stopped !== 'input_required' ? ending.stopped
    : ending.error === undefined ? undefined
      : typeof code === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(code) ? code
        : record.outcome?.error !== undefined ? record.outcome.uncertain ? 'runtime_restart' : 'runtime_error' : 'model_error';
  const at = record.endedAt ?? Date.now();
  try {
    await withSql(env, sql => sql.query(failure
      ? `update agents set last_active_at=greatest(coalesce(last_active_at,0),$3),
          last_error_at=greatest(coalesce(last_error_at,0),$3),
          last_error_class=case when coalesce(last_error_at,0)<=$3 then $4 else last_error_class end where id=$1 and tenant=$2`
      : 'update agents set last_active_at=greatest(coalesce(last_active_at,0),$3) where id=$1 and tenant=$2',
      failure ? [agent, tenant, at, failure] : [agent, tenant, at]));
  } catch { console.error(JSON.stringify({ type: 'agent_activity_failed', agent })); }
}

export async function agentActivity(env: ControlEnv, tenant: string, agent: string) {
  const { rows } = await withSql(env, sql => sql.query(`select a.last_active_at, a.last_error_at, a.last_error_class,
    (select workspace from workspace_assignments where tenant=a.tenant and kind='agent' and resource=a.id order by assigned_at desc, sequence desc limit 1) workspace
    from agents a where a.tenant=$1 and a.id=$2`, [tenant, agent]));
  const row = rows[0];
  return { workspaceId: row?.workspace ?? null, lastActiveAt: row?.last_active_at == null ? null : Number(row.last_active_at),
    lastError: row?.last_error_class ? { at: Number(row.last_error_at), class: row.last_error_class } : null };
}

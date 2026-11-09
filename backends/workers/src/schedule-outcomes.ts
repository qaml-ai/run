import { recordScheduleRun, scheduleRunSource } from '../../../src/core/schedule-runs.ts';
import { withSql } from './postgres.ts';
import { failure } from './observability.ts';
import type { AgentRuntime } from './agent-runtime.ts';

export async function stageScheduleOutcome(tx: DurableObjectTransaction, tenant: string, agent: string, record: any) {
 const source=scheduleRunSource(tenant,record);
 if(!source)return;
 const result=record.outcome?.result;
 await tx.put(`schedule-outcome:${record.id}`, {source,agent,record:{id:record.id,state:record.state,endedAt:record.endedAt,outcome:{error:record.outcome?.error,result:{error:result?.error,stopped:result?.stopped,usage:result?.usage}}}});
}
/** Durable outbox: SQL outages cannot block a run or lose its terminal outcome. */
export async function flushScheduleOutcomes(runtime: AgentRuntime) {
 for(const [key,pending] of await runtime.ctx.storage.list<any>({prefix:'schedule-outcome:',limit:100})) {
  try {
   await withSql(runtime.env,sql=>recordScheduleRun(sql,pending.source,pending.agent,pending.record));
   await runtime.ctx.storage.delete(key);
  } catch(error) { failure(runtime.env,'schedule_outcome_failed',error); break; }
 }
}

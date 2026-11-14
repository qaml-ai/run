import { Dreaming as SharedDreaming, DreamError, type DreamConfig } from '../../../shared/dreaming.ts';
import { calendarInput, nextCalendar } from '../../../src/core/calendar.ts';
import { transcriptAgents } from '../../../shared/session-transcripts.ts';
export { DreamError };
/** Keep the HTTP volumeId field; the Workers value is a repo id. */
export function dreamConfig(value: unknown): DreamConfig {
  const c = value as DreamConfig;
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(key=>!['enabled','volumeId','schedule','analyzerModel','organizerModel','budgetUsd','instructions','endUser','acrossUsers'].includes(key)) || typeof c.enabled !== 'boolean' || typeof c.volumeId !== 'string' || !/^repo_[a-f0-9]{24}$/.test(c.volumeId) || (c.analyzerModel !== undefined && (typeof c.analyzerModel !== 'string' || !c.analyzerModel)) || (c.organizerModel !== undefined && (typeof c.organizerModel !== 'string' || !c.organizerModel)) || !Number.isFinite(c.budgetUsd) || c.budgetUsd <= 0 || typeof c.instructions !== 'string' || c.instructions.length > 16000) throw new DreamError('Invalid dreaming configuration');
  if (c.endUser !== undefined && (typeof c.endUser !== 'string' || !c.endUser || c.endUser.length > 256) || c.acrossUsers !== undefined && typeof c.acrossUsers !== 'boolean') throw new DreamError('Invalid dreaming user scope');
  if (!c.schedule || Object.keys(c.schedule).some(key=>!['time','timeZone'].includes(key))) throw new DreamError('Invalid dreaming schedule');
  try { calendarInput(c.schedule); } catch { throw new DreamError("Invalid dreaming schedule"); }
  return {enabled: c.enabled, volumeId: c.volumeId, schedule: c.schedule, analyzerModel: c.analyzerModel ?? 'camelrun/default', organizerModel: c.organizerModel ?? 'camelrun/default', budgetUsd: c.budgetUsd, instructions: c.instructions, ...(c.endUser === undefined ? {} : {endUser:c.endUser}), ...(c.acrossUsers === undefined ? {} : {acrossUsers:c.acrossUsers})};
}

export class Dreaming extends SharedDreaming {
  async configure(tenant: string, agent: string, input: unknown) {
    const config=dreamConfig(input);
    await this.host.verify(tenant,agent,config.volumeId);
    const store={query:this.host.db,page:this.host.page,descendants:this.host.descendants,scope:this.host.scope};
    const scopes=await Promise.all((await transcriptAgents(store,tenant,agent)).map(id=>this.host.scope?.(id)));
    const users=new Set(scopes.flatMap(scope=>scope?[...(scope.subject?[scope.subject]:[]),...scope.requests.map(r=>r.endUser??(r.params as {endUser?:string}|undefined)?.endUser??scope.subject)]:[]));
    if(config.enabled&&config.endUser===undefined&&!config.acrossUsers&&users.size>1)throw new DreamError('This agent has multiple end users; set endUser or explicitly set acrossUsers: true',409);
    const previous=(await this.host.db('select config from agent_dreaming where tenant=$1 and agent=$2',[tenant,agent])).rows[0]?.config;
    const scopeChanged=previous && (previous.endUser !== config.endUser || !!previous.acrossUsers !== !!config.acrossUsers);
    if(scopeChanged && previous.volumeId===config.volumeId && Object.keys(await this.host.memory(tenant,config.volumeId)).length)
      throw new DreamError('Choose an empty memory volume when changing the user scope',409);
    const now=Date.now();
    const result=await this.host.db(`insert into agent_dreaming(agent,tenant,volume,config,since,due_at) values($1,$2,$3,$4,$5,$6)
      on conflict(agent) do update set config=excluded.config,volume=excluded.volume,due_at=excluded.due_at,
        since=case when agent_dreaming.volume<>excluded.volume then excluded.since else agent_dreaming.since end,
        progress=case when agent_dreaming.volume<>excluded.volume then null else agent_dreaming.progress end,
        allowed_urls=case when agent_dreaming.volume<>excluded.volume then '[]'::jsonb else agent_dreaming.allowed_urls end where agent_dreaming.tenant=$2 and agent_dreaming.active is null and agent_dreaming.lease_until<$5 returning agent`,[agent,tenant,config.volumeId,JSON.stringify(config),now,nextCalendar(config.schedule,now)]).catch(error=>{if(error.code==='23505') throw new DreamError('A memory volume already has a dreaming job',409);throw error;});
    if(!result.rows.length) throw new DreamError('A dream is already running',409);
    return this.get(tenant,agent);
  }
}

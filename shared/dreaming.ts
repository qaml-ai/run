import { calendarInput, nextCalendar } from '../src/core/calendar.ts';
import { dreamingWorkflow, dreamFiles, type DreamInput } from './dreaming-workflow.ts';
import { sessionTranscripts, type TranscriptStore } from './session-transcripts.ts';

export interface DreamConfig {
  enabled: boolean;
  volumeId: string;
  schedule: { time: string; timeZone: string };
  analyzerModel: string;
  organizerModel: string;
  budgetUsd: number;
  instructions: string;
}
export interface DreamHost {
  db: TranscriptStore['query'];
  page: TranscriptStore['page'];
  descendants?: TranscriptStore['descendants'];
  verify(tenant: string, agent: string, volume: string): Promise<void>;
  memory(tenant: string, volume: string): Promise<Record<string, string>>;
  start(tenant: string, key: string, config: DreamConfig, code: string): Promise<{agent: string; request: string}>;
  result(tenant: string, agent: string, request: string): Promise<{done: boolean; output?: unknown; error?: string}>;
  publish(tenant: string, volume: string, files: Record<string, string>, key: string): Promise<void>;
}
export class DreamError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status=status; } }
export function dreamConfig(value: unknown): DreamConfig {
  const c = value as DreamConfig;
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(key=>!['enabled','volumeId','schedule','analyzerModel','organizerModel','budgetUsd','instructions'].includes(key)) || typeof c.enabled !== 'boolean' || typeof c.volumeId !== 'string' || !c.volumeId.startsWith('vol_') || typeof c.analyzerModel !== 'string' || !c.analyzerModel || typeof c.organizerModel !== 'string' || !c.organizerModel || !Number.isFinite(c.budgetUsd) || c.budgetUsd <= 0 || typeof c.instructions !== 'string' || c.instructions.length > 16000) throw new DreamError('Invalid dreaming configuration');
  if (!c.schedule || Object.keys(c.schedule).some(key=>!['time','timeZone'].includes(key))) throw new DreamError('Invalid dreaming schedule');
  try { calendarInput(c.schedule); } catch { throw new DreamError("Invalid dreaming schedule"); }
  return {enabled: c.enabled, volumeId: c.volumeId, schedule: c.schedule, analyzerModel: c.analyzerModel, organizerModel: c.organizerModel, budgetUsd: c.budgetUsd, instructions: c.instructions};
}
/** Remove credential-bearing fields and recognizable secret forms before either model input or publication. */
export function redactDream(value: unknown): any {
  if (Array.isArray(value)) return value.map(redactDream);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /password|secret|token|authorization|api.?key|credential/i.test(k) ? '[redacted]' : redactDream(v)]));
  if (typeof value !== 'string') return value;
  if (/^client_[a-f0-9]{40}$/.test(value)) return value;
  return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted]')
    .replace(/\b(?:sk[-_]|xai-|AIza|ya29\.|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_.-]{8,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_+\/-]{32,}={0,2}\b/g, token => /^client_[a-f0-9]{40}$/.test(token) ? token : '[redacted]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b([\w-]*(?:password|secret|token|authorization|api[ _-]?key|credential)[\w-]*)["']?\s*[:=][^\r\n]*/gi, '$1=[redacted]')
    .replace(/\b(password|secret|token)\s+(?:is|was)\s+[^\r\n]*/gi, '$1 is [redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
}

export class Dreaming {
  readonly host: DreamHost;
  constructor(host: DreamHost) { this.host=host; }
  async get(tenant: string, agent: string) {
    const row = (await this.host.db('select config, since, due_at, active is not null as running, last_result from agent_dreaming where tenant=$1 and agent=$2', [tenant, agent])).rows[0];
    if (!row) return null;
    const results=(await this.host.db('select result from agent_dreaming_runs where tenant=$1 and agent=$2 order by created_at desc limit 20',[tenant,agent])).rows.map(row=>row.result);
    return {config: row.config, since: Number(row.since), dueAt: Number(row.due_at), running: row.running, lastResult: row.last_result, results};
  }
  async configure(tenant: string, agent: string, input: unknown) {
    const config = dreamConfig(input);
    await this.host.verify(tenant, agent, config.volumeId);
    const now = Date.now();
    const result = await this.host.db(`insert into agent_dreaming(agent,tenant,volume,config,since,due_at) values($1,$2,$3,$4,$5,$6)
      on conflict(agent) do update set config=excluded.config,volume=excluded.volume,due_at=excluded.due_at where agent_dreaming.tenant=$2 and agent_dreaming.active is null and agent_dreaming.lease_until < $5 returning agent`, [agent,tenant,config.volumeId,JSON.stringify(config),now,nextCalendar(config.schedule,now)]).catch(error=>{if(error.code==='23505') throw new DreamError('A memory volume already has a dreaming job',409); throw error;});
    if (!result.rows.length) throw new DreamError('A dream is already running',409);
    return this.get(tenant,agent);
  }
  async now(tenant: string, agent: string) {
    const rows = (await this.host.db(`update agent_dreaming set due_at=$3,active=jsonb_build_object('from',since,'to',$3::bigint,'key','dream-'||agent||'-'||$3::text) where tenant=$1 and agent=$2 and active is null and lease_until < (extract(epoch from clock_timestamp())*1000)::bigint returning agent`,[tenant,agent,Date.now()])).rows;
    if (!rows.length) throw new DreamError('No idle dreaming configuration',409);
    return {queued:true};
  }
  /** One bounded state transition per claimed job. Model execution is polled on later scans. */
  async scan() {
    const now = Number((await this.host.db('select (extract(epoch from clock_timestamp())*1000)::bigint as now',[])).rows[0].now), lease = now + 300000;
    const rows = (await this.host.db(`update agent_dreaming set lease_until=$2 where agent in
      (select agent from agent_dreaming where lease_until < $1 and (active is not null or (due_at <= $1 and config->>'enabled'='true')) order by due_at limit 4 for update skip locked) returning *`,[now,lease])).rows;
    await Promise.all(rows.map(async row => {
      const c = row.config as DreamConfig;
      let held = lease;
      const renew = async () => {
        const changed = await this.host.db('update agent_dreaming set lease_until=(extract(epoch from clock_timestamp())*1000)::bigint+300000 where tenant=$1 and agent=$2 and lease_until=$3 returning lease_until',[row.tenant,row.agent,held]);
        if (!changed.rows.length) throw new Error('Dream claim was lost');
        held=Number(changed.rows[0].lease_until);
      };
      const save = async (active: unknown, result?: unknown, since?: number) => this.host.db(`with saved as (
        update agent_dreaming set active=$4,last_result=coalesce($5,last_result),since=coalesce($6,since),due_at=$7,lease_until=0 where agent=$1 and tenant=$2 and lease_until=$3 returning *
      ), audit as (insert into agent_dreaming_runs(id,agent,tenant,created_at,result) select $8,agent,tenant,$9,last_result from saved where $5::jsonb is not null on conflict(id) do update set result=excluded.result returning id)
      select agent from saved`, [row.agent,row.tenant,held,active === null ? null : JSON.stringify(active),result === undefined ? null : JSON.stringify(result),since ?? null,nextCalendar(c.schedule,Date.now()),row.active?.key ?? `dream-${row.agent}-${now}`,Date.now()]);
      try {
        await this.host.verify(row.tenant,row.agent,c.volumeId);
        if (!row.active) {
          const active = {from:Number(row.since),to:now,key:`dream-${row.agent}-${now}`};
          await save(active);
          return;
        }
        const active = row.active;
        if (!active.agent) {
          if (active.from === active.to) { await save(null,{status:'completed',from:active.from,to:active.to,summary:'No new messages'},active.to); return; }
          const inputs: DreamInput[] = [];
          let cursor: string | undefined;
          do {
            await renew();
            const page = await sessionTranscripts({query:this.host.db,page:this.host.page,descendants:this.host.descendants},row.tenant,row.agent,{from:active.from,to:active.to,cursor,limit:100});
            if (page.entries.length) inputs.push(redactDream({agentId:page.agentId,entries:page.entries}));
            if (inputs.length > 200) throw new Error('Dream window exceeds 200 input pages');
            cursor = page.next ?? undefined;
          } while (cursor);
          if (!inputs.length) { await save(null,{status:'completed',from:active.from,to:active.to,summary:'No new messages'},active.to); return; }
          const memory = redactDream(await this.host.memory(row.tenant,c.volumeId));
          const code = dreamingWorkflow({analyzer:'analyzer',organizer:'organizer',inputs,memory,instructions:redactDream(c.instructions)});
          await renew();
          const run = await this.host.start(row.tenant,active.key,c,code);
          await save({...active,...run}); return;
        }
        const result = await this.host.result(row.tenant,active.agent,active.request);
        if (!result.done) { await save(active); return; }
        if (result.error) throw new Error(result.error);
        if ((result.output as any)?.status === 'failed') throw Object.assign(new Error(/budget|spend.limit/i.test(JSON.stringify((result.output as any).failures)) ? 'Dream budget reached' : 'Dream inputs failed'),{failures:(result.output as any).failures});
        const output = dreamFiles(redactDream(result.output));
        // Publication is idempotent for this key; success advances the watermark only after it finishes.
        await renew();
        await this.host.publish(row.tenant,c.volumeId,output.files,active.key);
        await save(null,{status:'completed',from:active.from,to:active.to,summary:output.summary},active.to);
      } catch (error) {
        await save(null,{status:/spend|budget/i.test(String((error as Error).message)) ? 'budget_reached' : 'failed',failures:redactDream((error as any).failures),from:row.active?.from ?? Number(row.since),to:row.active?.to ?? now,error:redactDream(String((error as Error).message)).slice(0,500)});
      }
    }));
  }
}

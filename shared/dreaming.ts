import { calendarInput, nextCalendar } from '../src/core/calendar.ts';
import { dreamingWorkflow, dreamFiles, dropUnquotedUrls, sourceUrls, indexNotice, DREAM_MEMORY_CAP, type DreamInput } from './dreaming-workflow.ts';
import { sessionTranscripts, transcriptAgents, type TranscriptStore } from './session-transcripts.ts';

import { removeDreamSecrets } from './dreaming-secrets.ts';

export interface DreamConfig {
  enabled: boolean;
  volumeId: string;
  schedule: { time: string; timeZone: string };
  analyzerModel: string;
  organizerModel: string;
  budgetUsd: number;
  instructions: string;
  endUser?: string;
  acrossUsers?: boolean;
}
export interface DreamHost {
  db: TranscriptStore['query'];
  page: TranscriptStore['page'];
  descendants?: TranscriptStore['descendants'];
  scope?: TranscriptStore['scope'];
  secrets?(tenant: string): Promise<string[]>;
  verify(tenant: string, agent: string, volume: string): Promise<void>;
  memory(tenant: string, volume: string): Promise<Record<string, string>>;
  start(tenant: string, key: string, config: DreamConfig, code: string, requestKey?: string): Promise<{agent: string; request: string}>;
  result(tenant: string, agent: string, request: string): Promise<{done: boolean; output?: unknown; error?: string}>;
  publish(tenant: string, volume: string, files: Record<string, string>, key: string): Promise<void>;
}
/**
 * Forget an agent's dreaming job and its runs' results as its purge removes it (`query`: the purge's transaction). The
 * agent's row stays as a tombstone, so the foreign key's cascade never fires; left alone, the job would fail on every
 * scheduled night forever. The memory volume and its snapshots are the tenant's, and stay.
 */
export async function forgetAgentDreaming(query: (sql: string, values?: unknown[]) => Promise<unknown>, agent: string) {
  await query('delete from agent_dreaming where agent=$1', [agent]);
}
export class DreamError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status=status; } }
export function dreamConfig(value: unknown): DreamConfig {
  const c = value as DreamConfig;
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(key=>!['enabled','volumeId','schedule','analyzerModel','organizerModel','budgetUsd','instructions','endUser','acrossUsers'].includes(key)) || typeof c.enabled !== 'boolean' || typeof c.volumeId !== 'string' || !c.volumeId.startsWith('vol_') || (c.analyzerModel !== undefined && (typeof c.analyzerModel !== 'string' || !c.analyzerModel)) || (c.organizerModel !== undefined && (typeof c.organizerModel !== 'string' || !c.organizerModel)) || !Number.isFinite(c.budgetUsd) || c.budgetUsd <= 0 || typeof c.instructions !== 'string' || c.instructions.length > 16000) throw new DreamError('Invalid dreaming configuration');
  if (c.endUser !== undefined && (typeof c.endUser !== 'string' || !c.endUser || c.endUser.length > 256) || c.acrossUsers !== undefined && typeof c.acrossUsers !== 'boolean') throw new DreamError('Invalid dreaming user scope');
  if (!c.schedule || Object.keys(c.schedule).some(key=>!['time','timeZone'].includes(key))) throw new DreamError('Invalid dreaming schedule');
  try { calendarInput(c.schedule); } catch { throw new DreamError("Invalid dreaming schedule"); }
  return {enabled: c.enabled, volumeId: c.volumeId, schedule: c.schedule, analyzerModel: c.analyzerModel ?? 'camelrun/default', organizerModel: c.organizerModel ?? 'camelrun/default', budgetUsd: c.budgetUsd, instructions: c.instructions, ...(c.endUser === undefined ? {} : {endUser:c.endUser}), ...(c.acrossUsers === undefined ? {} : {acrossUsers:c.acrossUsers})};
}
/** Remove credential-bearing fields and recognizable secret forms before either model input or publication. */
export function redactDream(value: unknown): any {
  if (Array.isArray(value)) return value.map(redactDream);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /password|secret|token|authorization|api.?key|credential/i.test(k) ? '[redacted]' : redactDream(v)]));
  if (typeof value !== 'string') return value;
  if (/^client_[a-f0-9]{40}$/.test(value)) return value;
  return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted]')
    .replace(/\b(?:sk[-_]|xai-|AIza|ya29\.|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_.-]{8,}\b/g, '[redacted]')
    .replace(/(?<![\w/.-])[A-Za-z0-9_+-]{32,}={0,2}(?![\w/.-])/g, token => opaqueSecret(token) ? '[redacted]' : token)
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b([\w-]*(?:password|secret|token|authorization|api[ _-]?key|credential)[\w-]*)["']?\s*[:=][^\r\n]*/gi, '$1=[redacted]')
    .replace(/\b(password|secret|token)\s+(?:is|was)\s+[^\r\n]*/gi, '$1 is [redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1[redacted]@');
}

function opaqueSecret(token: string) {
  if (/^client_[a-f0-9]{40}$/.test(token)) return false;
  const classes = [/[a-z]/,/[A-Z]/,/[0-9]/,/[_+\-=]/].filter(pattern=>pattern.test(token)).length;
  const counts = new Map<string,number>();
  for (const char of token) counts.set(char,(counts.get(char) ?? 0)+1);
  const entropy = [...counts.values()].reduce((sum,n)=>sum-(n/token.length)*Math.log2(n/token.length),0);
  return classes >= 3 && entropy >= 4;
}

type Checkpoint = {from: number; to: number; target: number; cursor?: string; offset?: number; fragment?: number; sequence?: number};
type Active = Checkpoint & {key: string; chunk?: string; agent?: string; request?: string; next?: Checkpoint | null; urls?: string[]};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
/** A byte-bounded page, down to fragments of a single message when necessary. */
export async function dreamChunk(store: TranscriptStore, tenant: string, agent: string, initial: Checkpoint, endUser?: string) {
  let point = {...initial};
  for (;;) {
    const inputs: DreamInput[] = [];
    let cursor=point.cursor, offset=point.offset ?? 0, fragment=point.fragment ?? 0;
    let next: Checkpoint | null = null;
    outer: for (;;) {
      const page = await sessionTranscripts(store,tenant,agent,{from:point.from,to:point.to,cursor,limit:100,endUser});
      for (let i=offset;i<page.entries.length;i++) {
        const entry=page.entries[i], raw=JSON.stringify(entry.message);
        // Fragment JSON as data, keeping source indexes. Bound by UTF-8, including escaping.
        const pieces: string[]=[];
        for(let j=0;j<raw.length;j+=3000) pieces.push(raw.slice(j,j+3000));
        for(let part=i===offset?fragment:0;part<pieces.length;part++) {
          const item = {index:entry.index,message:pieces.length===1?entry.message:{fragment:part,fragments:pieces.length,data:pieces[part]}};
          let input=inputs.at(-1);
          if (!input || input.agentId!==page.agentId || bytes({...input,entries:[...input.entries,item]})>24000) {
            if(inputs.length===4) { next={...point,cursor,offset:i,fragment:part}; break outer; }
            input={agentId:page.agentId!,entries:[]};inputs.push(input);
          }
          input.entries.push(item);
        }
      }
      if (!page.next) break;
      cursor=page.next;offset=0;fragment=0;
    }
    // Prefer chronological chunks. Same-millisecond input uses a durable intra-page checkpoint.
    if(next && !point.cursor && !point.offset && !point.fragment && point.to-point.from>1) {
      point={...point,to:point.from+Math.max(1,Math.floor((point.to-point.from)/2))};continue;
    }
    if (!next && point.to<point.target) next={from:point.to,to:point.target,target:point.target};
    return {inputs,point,next};
  }
}

export class Dreaming {
  readonly host: DreamHost;
  constructor(host: DreamHost) { this.host=host; }
  private store(): TranscriptStore { return {query:this.host.db,page:this.host.page,descendants:this.host.descendants,scope:this.host.scope}; }
  private async scopeCheck(tenant: string, agent: string, config: DreamConfig) {
    const scopes = await Promise.all((await transcriptAgents(this.store(),tenant,agent)).map(id=>this.host.scope?.(id)));
    const users = new Set(scopes.flatMap(scope=>scope ? [...(scope.subject ? [scope.subject] : []),...scope.requests.map(r=>r.endUser ?? (r.params as {endUser?: string} | undefined)?.endUser ?? scope.subject)] : []));
    if (config.enabled && config.endUser === undefined && !config.acrossUsers && users.size>1) throw new DreamError('This agent has multiple end users; set endUser or explicitly set acrossUsers: true',409);
    return scopes;
  }
  async get(tenant: string, agent: string) {
    const row=(await this.host.db('select config,since,due_at,active is not null as running,last_result,progress,failed_nights from agent_dreaming where tenant=$1 and agent=$2',[tenant,agent])).rows[0];
    if(!row) return null;
    const results=(await this.host.db('select result from agent_dreaming_runs where tenant=$1 and agent=$2 order by created_at desc limit 20',[tenant,agent])).rows.map(row=>row.result);
    const secrets=await this.host.secrets?.(tenant) ?? [];
    return removeDreamSecrets({config:row.config,since:Number(row.since),dueAt:Number(row.due_at),running:row.running,lastResult:row.last_result,checkpoint:row.progress,failedNights:row.failed_nights,results},secrets);
  }
  async configure(tenant: string, agent: string, input: unknown) {
    const config=dreamConfig(input);
    await this.host.verify(tenant,agent,config.volumeId);
    await this.scopeCheck(tenant,agent,config);
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
  async now(tenant: string, agent: string) {
    const rows=(await this.host.db(`update agent_dreaming set due_at=$3,active=coalesce(progress,jsonb_build_object('from',since,'to',$3::bigint,'target',$3::bigint)) || jsonb_build_object('key','dream-'||agent||'-'||$3::text) where tenant=$1 and agent=$2 and active is null and lease_until<(extract(epoch from clock_timestamp())*1000)::bigint returning agent`,[tenant,agent,Date.now()])).rows;
    if(!rows.length) throw new DreamError('No idle dreaming configuration',409);
    return {queued:true};
  }
  async scan() {
    const now=Number((await this.host.db('select (extract(epoch from clock_timestamp())*1000)::bigint as now',[])).rows[0].now),lease=now+300000;
    const rows=(await this.host.db(`update agent_dreaming set lease_until=$2 where agent in
      (select agent from agent_dreaming where lease_until<$1 and (active is not null or (due_at<=$1 and config->>'enabled'='true')) order by due_at limit 4 for update skip locked) returning *`,[now,lease])).rows;
    await Promise.all(rows.map(async row=>{
      const c=row.config as DreamConfig;
      let held=lease;
      const renew=async()=>{
        const changed=await this.host.db('update agent_dreaming set lease_until=(extract(epoch from clock_timestamp())*1000)::bigint+300000 where tenant=$1 and agent=$2 and lease_until=$3 returning lease_until',[row.tenant,row.agent,held]);
        if(!changed.rows.length) throw new Error('Dream claim was lost');held=Number(changed.rows[0].lease_until);
      };
      let secrets:string[]=[];
      const clean=(value:unknown)=>removeDreamSecrets(value,secrets);
      const save=async(active:unknown,result?:any,since?:number,progress:unknown=row.progress,urls?:string[])=>{
        const failure=result && ['failed','budget_reached'].includes(result.status);
        const parts=new Intl.DateTimeFormat('en-CA',{timeZone:c.schedule.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
        const calendar=Object.fromEntries(parts.map(part=>[part.type,part.value]));
        const prior=new Date(Date.UTC(Number(calendar.year),Number(calendar.month)-1,Number(calendar.day)-1)).toISOString().slice(0,10);
        const reset=result?.status==='completed' && active===null;
        const date=new Intl.DateTimeFormat('en-CA',{timeZone:c.schedule.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
        const safe=clean(result);
        const saved=await this.host.db(`with saved as (
          update agent_dreaming set active=$4,last_result=coalesce($5,last_result),since=coalesce($6,since),due_at=$7,lease_until=0,progress=$10,allowed_urls=coalesce($15,allowed_urls),
            failed_nights=case when $11 then case when failed_date=$12 then failed_nights when failed_date=$16 then failed_nights+1 else 1 end when $14 then 0 else failed_nights end,
            failed_date=case when $11 then $12 when $14 then null else failed_date end
          where agent=$1 and tenant=$2 and lease_until=$3 returning *
        ), audit as (insert into agent_dreaming_runs(id,agent,tenant,created_at,result) select $8,agent,tenant,$9,last_result from saved where $5::jsonb is not null on conflict(id) do update set result=excluded.result returning id),
        notice as (select billing_emit_event(tenant,'dreaming.failed',jsonb_build_object('agent',agent,'notice','dreaming','reason',last_result->>'error','failedNights',failed_nights),agent||':'||$12,'problems') from saved where $11 and failed_nights=3 and coalesce($13,'')<>$12)
        select agent,(select count(*) from notice) as notices from saved`,[row.agent,row.tenant,held,active===null?null:JSON.stringify(active),safe===undefined?null:JSON.stringify(safe),since ?? null,nextCalendar(c.schedule,Date.now()),(row.active?.chunk ?? row.active?.key) ?? `dream-${row.agent}-${now}`,Date.now(),progress===null?null:JSON.stringify(progress),!!failure,date,row.failed_date,reset,urls===undefined?null:JSON.stringify(urls),prior]);
        return saved.rows.length>0;
      };
      try {
        secrets=await this.host.secrets?.(row.tenant) ?? [];
        await this.host.verify(row.tenant,row.agent,c.volumeId);
        const scopes=await this.scopeCheck(row.tenant,row.agent,{...c,enabled:true});
        if(!row.active) {await save({...row.progress ?? {from:Number(row.since),to:now,target:now},key:`dream-${row.agent}-${now}`});return;}
        const active=row.active as Active;
        if(!active.agent) {
          // Do not consolidate an unfinished turn. Earlier complete turns remain eligible.
          const busy=scopes.flatMap(scope=>scope?.requests.filter(r=>r.state!=='completed' && ['prompt','continue','resume'].includes(r.method ?? 'prompt')).map(r=>r.began ?? r.startedAt ?? active.from) ?? []);
          const cutoff=Math.min(...busy);
          const to=Math.max(active.from,Math.min(active.to,cutoff));
          if(to===active.from) {
            if(busy.length) await save(null,{status:'deferred',from:active.from,to,error:'The newest source turn is still running'});
            else await save(null,{status:'completed',from:active.from,to,summary:'No new messages'},to,null);
            return;
          }
          await renew();
          const chunk=await dreamChunk(this.store(),row.tenant,row.agent,{...active,to,target:Math.min(active.target,cutoff)},c.endUser);
          if(!chunk.inputs.length) {
            if(chunk.next) await save({...chunk.next,key:active.key},undefined,chunk.next.from,chunk.next);
            else await save(null,{status:'completed',from:active.from,to:chunk.point.to,summary:'No new messages'},chunk.point.to,null);
            return;
          }
          const memory=await this.host.memory(row.tenant,c.volumeId);
          if(bytes(memory)>DREAM_MEMORY_CAP) throw new Error('Existing dream memory exceeds 50000 characters');
          const inputs=clean(redactDream(chunk.inputs));
          const code=dreamingWorkflow({analyzer:'analyzer',organizer:'organizer',inputs,memory:Object.fromEntries(Object.entries(memory).map(([path,text])=>[path,clean(redactDream(text))])),instructions:clean(redactDream(c.instructions))});
          const chunkKey=`${active.key}-${active.sequence ?? 0}`;
          await renew();
          const run=await this.host.start(row.tenant,active.key,c,code,chunkKey);
          await save({...chunk.point,key:active.key,chunk:chunkKey,...run,next:chunk.next,urls:[...new Set([...(row.allowed_urls ?? []),...sourceUrls(inputs)])]});return;
        }
        const result=await this.host.result(row.tenant,active.agent!,active.request!);
        if(!result.done) {await save(active);return;}
        if(result.error) throw new Error(result.error);
        if((result.output as any)?.status==='failed') throw Object.assign(new Error(/budget|spend.limit/i.test(JSON.stringify((result.output as any).failures))?'Dream budget reached':'Dream inputs failed'),{failures:(result.output as any).failures});
        const memory=await this.host.memory(row.tenant,c.volumeId);
        // Validate unmodified paths and structure first. Redact file text only, never path keys.
        const output=dreamFiles(result.output,memory);
        if(Object.keys(output.files).some(path=>secrets.some(secret=>path.includes(secret)))) throw new Error('Memory path contains a known credential');
        const files=Object.fromEntries(Object.entries(output.files).map(([path,text])=>[path,clean(dropUnquotedUrls(text,active.urls ?? []))]));
        files['_index.md']=indexNotice(files['_index.md']);
        dreamFiles({status:'completed',files:Object.entries(files).map(([path,text])=>({path,text})),summary:clean(output.summary)});
        await renew();await this.host.publish(row.tenant,c.volumeId,files,active.chunk!);
        const next=active.next ? {...active.next,sequence:(active.sequence ?? 0)+1} : null;
        await save(next?{...next,key:active.key}:null,{status:'completed',from:active.from,to:active.to,summary:clean(dropUnquotedUrls(output.summary,active.urls ?? []))},next?.from ?? active.to,next ?? null,sourceUrls(files));
      } catch(error) {
        const reason=String((error as Error).message);
        await save(null,{status:/spend|budget/i.test(reason)?'budget_reached':'failed',failures:clean((error as any).failures),from:row.active?.from ?? Number(row.since),to:row.active?.to ?? now,error:clean(reason).slice(0,500)});
      }
    }));
  }
}

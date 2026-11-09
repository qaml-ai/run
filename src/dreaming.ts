import { Dreaming, DreamError } from '../shared/dreaming.ts';
import { DREAM_ANALYZER_PROMPT, DREAM_ORGANIZER_PROMPT } from '../shared/dreaming-workflow.ts';
import type { Db } from './db.ts';
import type { ClientSessions } from './client-sessions.ts';
import type { Definitions } from './definitions.ts';
import { snapshotContents, type VolumeService } from './volumes.ts';
import type { RequestRecord } from '../shared/client-protocol.ts';

export function nodeDreaming(options: {
  db: Db; clients: ClientSessions; definitions: Definitions; volumes: VolumeService;
  create(tenant: string, params: any, key: string): Promise<any>;
  submit(agent: string, tenant: string, request: {id: string; method: string; params: Record<string, unknown>}): Promise<RequestRecord>;
  request(agent: string, tenant: string, id: string, wait: number): Promise<RequestRecord | undefined>;
}) {
  const {db,clients,definitions,volumes} = options;
  return new Dreaming({
    db: (sql, values) => db.query(sql,values),
    async page(agent,after,limit) {
      const header = (await db.query('select tenant from agents where id=$1',[agent])).rows[0];
      if ((await clients.stateFor(agent,header.tenant)).busy) throw new DreamError('A source conversation is still running',409);
      return clients.historyPageFor(agent,header.tenant,{after:String(after),limit:String(limit),maxBytes:'64000'});
    },
    async verify(tenant,agent,volume) {
      if (!await clients.owns(agent,tenant)) throw new DreamError('Unknown agent',404);
      const row = (await db.query('select header from agents where id=$1 and tenant=$2',[agent,tenant])).rows[0];
      const mounts = row?.header?.mounts ?? [];
      if (!mounts.some((m: any) => m.volumeId === volume && m.mode === 'ro') || mounts.some((m: any) => m.volumeId === volume && m.mode !== 'ro')) throw new DreamError('Mount the memory volume read-only before enabling dreaming');
      const writable = await db.query(`select id from agents where tenant=$1 and not revoked and purged_at is null and exists (
        select 1 from jsonb_array_elements(coalesce(header::jsonb->'mounts',header::jsonb->'config'->'mounts','[]'::jsonb)) m where m->>'volumeId'=$2 and m->>'mode'='rw'
      )`,[tenant,volume]);
      if (writable.rows.length) throw new DreamError('Remove writable agent mounts before enabling dream memory');
      await volumes.handle(volume,tenant,'info');
    },
    async memory(tenant,volume) {
      const read = await volumes.handle(volume,tenant,'readAll',{path:'/'});
      return Object.fromEntries(read.files.map((f: any) => { if (typeof f.text !== 'string') throw new DreamError('Memory must contain only text files'); return [f.path.replace(/^\//,''),f.text]; }));
    },
    async start(tenant,key,config,code) {
      const targets = [];
      for (const [name,model,systemPrompt] of [['analyzer',config.analyzerModel,DREAM_ANALYZER_PROMPT],['organizer',config.organizerModel,DREAM_ORGANIZER_PROMPT]]) {
        const definition = await definitions.upsert(tenant,`${key.slice(0,key.lastIndexOf("-"))}-${name}`,{name:`dream-${name}`,model,systemPrompt,builtins:[],fileTools:false,codeMode:false,decide:false,mounts:[{workspace:false}]});
        targets.push({name,definition:definition.id});
      }
      const existing = clients.agentId(tenant,key);
      const agent = await clients.owns(existing,tenant) ? {id:existing} : await options.create(tenant,{ttlSeconds:86400,model:config.organizerModel,builtins:['delegate'],delegate:{agents:targets,maxParallel:4,maxDepth:1},fileTools:false,decide:false,mounts:[{workspace:false}],spendLimit:{usd:config.budgetUsd}},key);
      const request = `${key}-execute`;
      await options.submit(agent.id,tenant,{id:request,method:'execute',params:{code,maxOutputCharacters:128000,allowDisconnected:true}});
      return {agent:agent.id,request};
    },
    async result(tenant,agent,id) {
      const record = await options.request(agent,tenant,id,0);
      if (!record) throw new Error('Dream request is missing');
      if (record.state !== 'completed') return {done:false};
      const result = record.outcome?.result as any;
      const error = record.outcome?.error ?? result?.error ?? (result?.stopped ? String(result.stopped) : undefined);
      if (error) return {done:true,error:typeof error === 'string' ? error : JSON.stringify(error)};
      return {done:true,output:JSON.parse(result.output[0])};
    },
    async publish(tenant,volume,files,key) {
      const old = (await volumes.handle(volume,tenant,'snapshots')).find((s: any) => s.labels?.dream === key);
      const snapshot = old ?? await volumes.handle(volume,tenant,'snapshot',{name:key,pinned:true,labels:{dream:key},given:(await snapshotContents(volumes,tenant,files)).given});
      await volumes.handle(volume,tenant,'restore',{snapshot:snapshot.id});
    },
  });
}

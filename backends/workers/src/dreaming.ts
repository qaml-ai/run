import {readDreamMemory,publishDreamMemory} from './repos/dream-memory.ts';
import { repoContext, type RepoEnv } from "./repos/registry.ts";
import { branch, setRefToVersion, commitChanges } from "./repos/write.ts";
import { tenantDreamSecrets } from '../../../shared/dreaming-secrets.ts';
import { keyServices } from './security-services.ts';
import { transcriptDescendants, transcriptScope } from "./session-transcripts.ts";
import { Dreaming, DreamError } from './dreaming-policy.ts';
import { DREAM_ANALYZER_PROMPT, DREAM_ORGANIZER_PROMPT } from '../../../shared/dreaming-workflow.ts';
import { Directory, type ControlEnv } from './control.ts';
import { database } from './postgres.ts';
import { handleFileRequest, type FileBindings } from './files.ts';
import { definitionRoutes } from './definitions.ts';

export function workerDreaming(env: ControlEnv & FileBindings) {
  const db = database(env);
  const json = async (response: Response | undefined | null) => {
    if (!response) throw new Error('Missing dream operation');
    const value = await response.json() as any;
    if (!response.ok) throw new DreamError(value.error ?? 'Dream operation failed',response.status);
    return value;
  };
  const agentCall = (id: string,path: string,input?: unknown) => env.AGENTS.getByName(id).fetch(new Request(`https://agent${path}`,input === undefined ? undefined : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).then(json);
  return new Dreaming({
    db:(sql,values)=>db.query(sql,values),
    secrets:async tenant=>tenantDreamSecrets((sql,values)=>db.query(sql,values),(await keyServices(env)).accounts,tenant),
    scope:agent=>transcriptScope(env,agent),
    descendants:(tenant,root)=>transcriptDescendants(env,tenant,root),
    async page(agent,after,limit) {
      return agentCall(agent,`/history?after=${after}&limit=${limit}&maxBytes=64000`);
    },
    async verify(tenant,agent,volume) {
      const entry = await new Directory(env,tenant).get(agent);
      if (!entry || entry.deleted) throw new DreamError('Unknown agent',404);
      const mounts = entry.config.mounts ?? [];
      if (!mounts.some((m: any)=>m.repo===volume && m.mode==='ro') || mounts.some((m: any)=>m.repo===volume && m.mode!=='ro')) throw new DreamError('Mount the memory volume read-only before enabling dreaming');
      const writable = await db.query(`select id from agents where tenant=$1 and not revoked and purged_at is null and exists (
        select 1 from jsonb_array_elements(coalesce(header::jsonb->'mounts',header::jsonb->'config'->'mounts','[]'::jsonb)) m where m->>'repo'=$2 and m->>'mode'='rw'
      )`,[tenant,volume]);
      if (writable.rows.length) throw new DreamError('Remove writable agent mounts before enabling dream memory');
      await repoContext(env as RepoEnv,tenant,volume);
    },
    memory:(tenant,repo)=>readDreamMemory(env as RepoEnv,tenant,repo),
    async start(tenant,key,config,code,requestKey) {
      const targets=[];
      for(const [name,model,systemPrompt] of [['analyzer',config.analyzerModel,DREAM_ANALYZER_PROMPT],['organizer',config.organizerModel,DREAM_ORGANIZER_PROMPT]]) {
        const request = new Request('https://runtime/v1/definitions',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':`${key.slice(0,key.lastIndexOf('-'))}-${name}`},body:JSON.stringify({name:`dream-${name}`,model,systemPrompt,builtins:[],fileTools:false,codeMode:false,decide:false,mounts:[{workspace:false}]})});
        const definition = await json(await definitionRoutes(request,env,{tenantId:tenant,kind:'operator',scopes:[]}));
        targets.push({name,definition:definition.id});
      }
      const directory=new Directory(env,tenant);
      const old=await directory.get(key);
      const made=old ?? await directory.upsert({model:config.organizerModel,builtins:['delegate'],delegate:{agents:targets,maxParallel:4,maxDepth:1},fileTools:false,decide:false,mounts:[{workspace:false}],ttlSeconds:86400,spendLimit:{usd:config.budgetUsd}} as any,key,'https://runtime');
      if ('failed' in made) throw new DreamError(made.error,made.status);
      const request=`${requestKey ?? key}-execute`;
      await agentCall(made.id,'/requests',{id:request,method:'execute',params:{code,maxOutputCharacters:128000,allowDisconnected:true}});
      return {agent:made.id,request};
    },
    async result(_tenant,agent,id) {
      const record=await agentCall(agent,`/requests/${id}`);
      if(record.state!=='completed') return {done:false};
      const result=record.outcome?.result;
      const error=record.outcome?.error ?? result?.error ?? (result?.stopped ? String(result.stopped) : undefined);
      if(error) return {done:true,error:typeof error === 'string' ? error : JSON.stringify(error)};
      return {done:true,output:JSON.parse(result.output[0])};
    },
    publish:(tenant,repo,files,key)=>publishDreamMemory(env as RepoEnv,tenant,repo,files,key),
  });
}

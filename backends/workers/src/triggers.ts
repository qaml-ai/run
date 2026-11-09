import { Triggers } from '../../../src/triggers.ts';
import { database, transaction } from './postgres.ts';
import { keyServices } from './security-services.ts';
import { workerChannels } from './channels.ts';
import { Directory } from './control.ts';
import { provisionDefinition } from './definitions.ts';
import { upsertAgent } from './agent-upsert.ts';
import { HttpError } from './errors.ts';
import type { Env } from './agent-types.ts';
export async function workerTriggers(env:Env) {
 const {accounts}=await keyServices(env);
 return new Triggers({db:database(env), transaction:work=>transaction(env,work),keys:accounts,
  async fresh(tenant,agent,key) {
   const source=await new Directory(env,tenant).get(agent);
   if(!source?.config.definition)throw new HttpError(400,'Fresh triggers require an agent definition');
   const input=await provisionDefinition(env,tenant,{definition:source.config.definition,ttlSeconds:604800});
   const {entry}=await upsertAgent(env,tenant,input,key,env.AGENT_PUBLIC_URL||'https://localhost');
   if('failed' in entry)throw new HttpError(entry.status,entry.error);
   return entry.id;
  },
  upload:async(agent,tenant,id,text)=>(await workerChannels(env)).uploadTrigger(agent,tenant,id,text),
  async submit(agent,tenant,request){
   if(!await new Directory(env,tenant).get(agent))throw new HttpError(404,'Unknown agent');
   const response=await env.AGENTS.getByName(agent).fetch(new Request('https://agent/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)}));
   if(!response.ok)throw new HttpError(response.status,'Trigger submission failed');
   return response.json();
  }
 });
}
export async function triggerRoutes(request:Request,env:Env,tenant:string) {
 const url=new URL(request.url),m=/^\/v1\/agents\/([^/]+)\/triggers(?:\/([^/]+)(?:\/(rotate|deliveries))?)?$/.exec(url.pathname);
 if(!m)return;
 const [,agent,id,action]=m;
 if(!await new Directory(env,tenant).get(agent))throw new HttpError(404,'Unknown agent');
 const service=await workerTriggers(env);
 const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
 if(!id&&request.method==='GET')return reply(await service.list(tenant,agent));
 if(!id&&request.method==='POST') {
  const text=await request.text();if(text.length>64000)throw new HttpError(413,'Request too large');
  let input;try{input=JSON.parse(text);}catch{throw new HttpError(400,'Invalid JSON');}
  return reply(await service.create(tenant,agent,input,env.AGENT_PUBLIC_URL||url.origin),201);
 }
 if(id&&!action&&request.method==='DELETE')return reply(await service.remove(tenant,agent,id));
 if(id&&action==='rotate'&&request.method==='POST')return reply(await service.rotate(tenant,agent,id,env.AGENT_PUBLIC_URL||url.origin));
 if(id&&action==='deliveries'&&request.method==='GET')return reply(await service.deliveries(tenant,agent,id));
 throw new HttpError(404,'Unknown trigger route');
}

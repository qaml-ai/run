import { DurableObject } from 'cloudflare:workers';
import { readBounded } from '../src/computers/provider.ts';
type Size='basic'|'standard-2';
interface Env{API_TOKEN:string;NATIVE:DurableObjectNamespace<Native>}
interface Input{op:'exec'|'snapshot'|'restore'|'stop'|'status'|'cleanup';size:Size;argv?:string[];name?:string;timeoutMs?:number}
class Native extends DurableObject<Env>{
 private queue:Promise<unknown>=Promise.resolve();
 private get container(){if(!this.ctx.container)throw new Error('Missing container');return this.ctx.container;}
 async alarm(){await this.container.destroy();}
 operate(input:Input){const next=this.queue.then(()=>this.perform(input));this.queue=next.catch(()=>{});return next;}
 async perform(input:Input){
  const start=performance.now(),wasRunning=this.container.running;
  if(input.op==='status')return {running:wasRunning,info:await this.container.inspect(),snapshots:Object.fromEntries(await this.ctx.storage.list({prefix:'snapshot:'}))};
  if(input.op==='stop'){await this.container.destroy();return {stopped:true,elapsedMs:performance.now()-start};}
  if(input.op==='cleanup'){await this.container.destroy();const snapshots=Object.fromEntries(await this.ctx.storage.list({prefix:'snapshot:'}));await this.ctx.storage.deleteAll();return {stopped:true,snapshots};}
  const deadline=await this.ctx.storage.get<number>('deadline')??Date.now()+45*60000;
  if(Date.now()>=deadline)throw new Error('Hard experiment lifetime reached');await this.ctx.storage.put('deadline',deadline);await this.ctx.storage.setAlarm(deadline);
  if(input.op==='restore'){
   const stored=await this.ctx.storage.get<{snapshot:ContainerSnapshot;capturedAt:string;lastRestoredAt?:string}>('snapshot:'+input.name);if(!stored)throw new Error('Unknown snapshot');
   await this.container.destroy();
   this.container.start({containerSnapshot:stored.snapshot,instance:input.size,enableInternet:true});
   await this.container.setInactivityTimeout(60000);await this.exec(['true'],120000);
   stored.lastRestoredAt=new Date().toISOString();await this.ctx.storage.put('snapshot:'+input.name,stored);
   return {restored:true,elapsedMs:performance.now()-start,...stored};
  }
  if(!this.container.running){this.container.start({image:this.container.images.workspace,instance:input.size,enableInternet:true});await this.container.setInactivityTimeout(60000);await this.exec(['mkdir','-p','/workspace'],120000);}
  await this.container.setInactivityTimeout(60000);
  if(input.op==='snapshot'){
   if(!input.name||!/^camelrun-proto-[a-z0-9-]{1,70}$/.test(input.name))throw new Error('Invalid snapshot name');
   const snapshot=await this.container.snapshotContainer({name:input.name});const stored={snapshot,capturedAt:new Date().toISOString()};await this.ctx.storage.put('snapshot:'+input.name,stored);
   return {elapsedMs:performance.now()-start,wasRunning,...stored};
  }
  if(input.op!=='exec'||!input.argv||input.argv.length<1||input.argv.length>30||input.argv.some(a=>typeof a!=='string'||a.length>16384||a.includes('\0')))throw new Error('Invalid exec');
  const timeout=input.timeoutMs??120000;if(timeout<1000||timeout>1000000)throw new Error('Invalid timeout');
  return {...await this.exec(input.argv,timeout),elapsedMs:performance.now()-start,wasRunning};
 }
 private async exec(argv:string[],timeout:number){
  const controller=new AbortController();let finished=false;
  const timer=setTimeout(()=>{if(!finished)controller.abort(new Error('Execution timeout'));},timeout);
  try{const process=await this.container.exec(argv,{stdout:'pipe',stderr:'pipe',signal:controller.signal,cwd:'/'});
   const exit=process.exitCode.finally(()=>{finished=true;clearTimeout(timer);});
   const [stdout,stderr,exitCode]=await Promise.all([readBounded(process.stdout,65536),readBounded(process.stderr,65536),exit]);return {stdout,stderr,exitCode};
  }finally{finished=true;clearTimeout(timer);}
 }
}
export {Native as 'camelrun-proto-r2-native'};
export default{async fetch(request:Request,env:Env){
 if(!env.API_TOKEN||env.API_TOKEN.length<32||request.headers.get('authorization')!==`Bearer ${env.API_TOKEN}`)return Response.json({error:'Unauthorized'},{status:401});
 const match=/^\/v1\/(basic|standard-2)\/(main|extra)$/.exec(new URL(request.url).pathname);if(!match||request.method!=='POST')return Response.json({error:'Unknown route'},{status:404});
 try{const input=JSON.parse(await readBounded(request.body,65536)) as Input;input.size=match[1] as Size;return Response.json(await env.NATIVE.getByName('camelrun-proto-'+match[1]+'-'+match[2]).operate(input));}
 catch(e){return Response.json({error:e instanceof Error?e.message:'Failed'},{status:500});}
}} satisfies ExportedHandler<Env>;

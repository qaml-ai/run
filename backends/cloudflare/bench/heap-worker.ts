import { CamelAgent, type Env } from "../src/agent.ts";
import { authorized } from "../src/validation.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiHarness } from "agents/harness/pi";

let isolate:string|undefined;
const objects=new Map<string,WeakRef<HeapAgent>>();
class HeapAgent extends CamelAgent {
 private readonly heapInstance=crypto.randomUUID();
 private retained:any;
 private allocation:number[][]=[];
 private seeded=0;
 private initialized=false;
 constructor(ctx:DurableObjectState,env:Env) {super(ctx,{...env,TEST_MODEL:"1",MODEL:"test/echo"});isolate??=crypto.randomUUID();objects.set(ctx.id.toString(),new WeakRef(this));}
 private get piHarness() { return (this as any).harness as PiHarness; }
 async prepare() {
  if(!this.initialized) {
   const configured=await super.fetch(new Request("https://agent/configuration",{method:"PUT",body:JSON.stringify({id:this.ctx.id.toString(),revision:1,expiresAt:null,config:{codeMode:true,fileTools:true}})}));
   if(!configured.ok)throw Error(`configure ${configured.status}`);
   const result=await this.piHarness.prompt('code:return 7;');
   if(result.status!=="done")throw Error(`codemode initialization ${result.status}`);
   this.initialized=true;
  }
  return this.status();
 }
 async seed(count:number,bytes:number) {
  await this.prepare();
  const start=performance.now(), pi=await this.piHarness.pi(), root=await pi.root(BACKGROUND_CONTEXT);
  await root.commit(async tx=>{
   for(let i=0;i<count;i++) {
    const seq=this.seeded+i;
    const text=JSON.parse(JSON.stringify(`${seq}: `+'The agent reads source files, reasons about implementation, calls tools and records results. '.repeat(Math.ceil(bytes/90)))).slice(0,bytes);
    const message:any=seq%2===0?{role:'user',content:text,timestamp:Date.now()}:{role:'assistant',content:[{type:'text',text}],timestamp:Date.now(),api:'openai-completions',provider:'camel-test',model:'deterministic',stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    await tx.appendEntry(root.id,{kind:seq%2===0?'pi.user':'pi.assistant',model:[message]});
   }
  },BACKGROUND_CONTEXT);
  this.seeded+=count;
  return {...this.status(),seedMs:performance.now()-start};
 }
 async load() {
  const start=performance.now(), pi=await this.piHarness.pi(), root=await pi.root(BACKGROUND_CONTEXT);
  this.retained=await root.context(BACKGROUND_CONTEXT);
  return {...this.status(),loadMs:performance.now()-start,messageCount:this.retained.messages.length,textBytes:this.retained.messages.reduce((sum:number,m:any)=>sum+(typeof m.content==='string'?m.content.length:m.content.filter((x:any)=>x.type==='text').reduce((s:number,x:any)=>s+x.text.length,0)),0)};
 }
 async allocate(mib:number) {
  // JS FixedDoubleArray backing stores stay on the V8 heap. ArrayBuffers use
  // external memory and are not a valid calibration of the JS heap limit.
  for(let i=0;i<mib;i++) {const a=new Array(131072).fill(this.allocation.length+0.123456789); this.allocation.push(a);}
  return this.status();
 }
 async hold(ms:number) {await new Promise(resolve=>setTimeout(resolve,ms));return this.status();}
 async loadAndHold(ms:number) {
  const loaded=await this.load();
  // Keep the same RPC alive so periodic metrics can sample a large context
  // before a subsequent request triggers an over-limit isolate replacement.
  await new Promise(resolve=>setTimeout(resolve,ms));
  return {loaded,after:this.status(),holdMs:ms};
 }
 async clear() {this.retained=undefined;this.allocation=[];return this.status();}
 async runScript() {
  await this.prepare();
  const began=Date.now();
  const reply=await this.piHarness.prompt('code:await tools.write({path:"/workspace/codemode-probe.txt",content:"probe"}); let n=0; for(let i=0;i<20;i++){await tools.read({path:"/workspace/codemode-probe.txt"});n++;} return n;');
  return {began,endedAt:Date.now(),instance:this.heapInstance,status:reply.status,text:reply.text,operationId:reply.operationId};
 }
 status(){return {isolate,instance:this.heapInstance,seeded:this.seeded,allocationMiB:this.allocation.length,loadedMessages:this.retained?.messages.length??0,liveObjects:[...objects.values()].filter(v=>v.deref()).length,at:Date.now(),databaseBytes:this.ctx.storage.sql.databaseSize};}
}
export {HeapAgent as "camelrun-proto-r2-heap"};
interface HeapEnv extends Env {HEAP:DurableObjectNamespace<HeapAgent>}
export default {async fetch(request:Request,env:HeapEnv) {
 if(!await authorized(request,env.API_TOKEN))return Response.json({error:'Unauthorized'},{status:401});
 const match=/^\/agent\/([a-zA-Z0-9_-]+)\/(prepare|seed|load|loadAndHold|allocate|status|hold|clear|runScript)$/.exec(new URL(request.url).pathname);
 if(!match)return Response.json({error:'Not found'},{status:404});
 const stub=env.HEAP.getByName(match[1]),input=request.method==='POST'?await request.json() as any:{};
 try {
  if(match[2]==='seed') {if(!Number.isInteger(input.count)||input.count<1||input.count>1000||![512,1024].includes(input.bytes))throw Error('Invalid seed');return Response.json(await stub.seed(input.count,input.bytes));}
  if(match[2]==='allocate') {if(!Number.isInteger(input.mib)||input.mib<1||input.mib>16)throw Error('Invalid allocation');return Response.json(await stub.allocate(input.mib));}
  if(match[2]==='hold')return Response.json(await stub.hold(Math.min(60000,input.ms??30000)));
  if(match[2]==='loadAndHold') {if(!Number.isInteger(input.ms)||input.ms<1||input.ms>60000)throw Error('Invalid hold duration');return Response.json(await stub.loadAndHold(input.ms));}
  return Response.json(await (stub as any)[match[2]]());
 }catch(e){return Response.json({error:e instanceof Error?e.message:String(e)},{status:500});}
}} satisfies ExportedHandler<HeapEnv>;

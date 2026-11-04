import { DurableObject } from "cloudflare:workers";
import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import { authorized } from "../src/validation.ts";
import { isolatedSandboxRemote } from "../codemode/routing.ts";

interface Env { API_TOKEN: string; CALLERS: DurableObjectNamespace<Caller>; BARRIERS:DurableObjectNamespace<Barrier>; CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject & {status():unknown;vmFootprint(count:number):Promise<unknown>}> }
class Barrier extends DurableObject<Env> {
 private waiting:{resolve:(result:{arrived:number;releasedAt:number})=>void;reject:(reason:Error)=>void}[]=[];
 private timer:ReturnType<typeof setTimeout>|undefined;
 arrive(total:number) {
  if(!Number.isInteger(total)||total<1||total>200)throw Error('Invalid barrier size');
  return new Promise<{arrived:number;releasedAt:number}>((resolve,reject)=>{
   if(!this.timer)this.timer=setTimeout(()=>{this.waiting.splice(0).forEach(waiter=>waiter.reject(Error('Barrier timeout')));this.timer=undefined;},60000);
   this.waiting.push({resolve,reject});
   if(this.waiting.length===total){clearTimeout(this.timer);this.timer=undefined;const result={arrived:total,releasedAt:Date.now()};this.waiting.splice(0).forEach(waiter=>waiter.resolve(result));}
  });
 }
}
class Caller extends DurableObject<Env> {
  private instance = crypto.randomUUID();
  private active = 0;
  private calls = 0;
  private isolated = isolatedSandboxRemote({agentKey:this.ctx.id.toString(),getByName:key=>this.env.CODEMODE_SANDBOX.getByName(key),maxConcurrent:4});
  async run(input: { mode: "shared"|"agent"|"script"|"isolated"; shared: string; count: number; timeoutMs: number; batch: string;barrier?:boolean;scripts:number }) {
    const startedAt = Date.now(), id = crypto.randomUUID();
    const remoteKey = input.mode === "shared" ? input.shared : input.mode === "script" ? `${this.ctx.id}:${id}` : this.ctx.id.toString();
    const callbacks: number[] = [];
    let barrier:{arrived:number;releasedAt:number}|undefined;
    this.active++;
    const sandbox = new RemoteCodemodeSandbox({
      remote: input.mode === "isolated" ? this.isolated : () => this.env.CODEMODE_SANDBOX.getByName(remoteKey), timeoutMs: input.timeoutMs,
      tools: [{name:"echo", execute: async (value:any) => { this.calls++; callbacks.push(Date.now()-startedAt); if(callbacks.length===1&&input.barrier)barrier=await this.env.BARRIERS.getByName(input.batch).arrive(input.scripts); return value.value; }}],
    });
    try {
      const result = await sandbox.execute(`let n=0; for(let i=0;i<${input.count};i++) n=await tools.echo({value:n+1}); return n;`);
      return {instance:this.instance, id, remoteKey, startedAt, endedAt:Date.now(), wallMs:Date.now()-startedAt,
        callbacks, result, active:this.active, batch:input.batch,barrier};
    } finally { await sandbox.close(); this.active--; }
  }
  status() { return {instance:this.instance,active:this.active,calls:this.calls}; }
}
export { Caller as "camelrun-proto-r2-caller",Barrier as "camelrun-proto-r2-barrier" };
export default {
 async fetch(request:Request,env:Env) {
  if(!await authorized(request,env.API_TOKEN)) return Response.json({error:"Unauthorized"},{status:401});
  const path=new URL(request.url).pathname;
  const match=/^\/caller\/([A-Za-z0-9_-]{1,100})\/(run|status)$/.exec(path);
  try {
   if(match && match[2]==="status") return Response.json(await env.CALLERS.getByName(match[1]).status());
   if(match && match[2]==="run" && request.method==="POST") {
    const input=await request.json() as any;
    if(!["shared","agent","script","isolated"].includes(input.mode)||!Number.isInteger(input.count)||input.count<0||input.count>50||input.timeoutMs<1000||input.timeoutMs>60000) return Response.json({error:"Invalid input"},{status:400});
    return Response.json(await env.CALLERS.getByName(match[1]).run(input));
   }
   if(path.startsWith("/sandbox/")) return Response.json(await env.CODEMODE_SANDBOX.getByName(path.slice(9)).status());
   if(path.startsWith("/footprint/"))return Response.json(await env.CODEMODE_SANDBOX.getByName(`footprint-${path.slice(11)}`).vmFootprint(Number(path.slice(11))));
   return Response.json({ok:true});
  } catch(e) { return Response.json({error:e instanceof Error?e.message:String(e)},{status:500}); }
 }
} satisfies ExportedHandler<Env>;

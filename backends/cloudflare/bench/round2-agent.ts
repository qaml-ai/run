/** Disposable real-Pi load and bounded, alarm-driven soak. */
import { DurableObject } from "cloudflare:workers";
import { CamelAgent, json, type Env } from "../src/agent.ts";
import { authorized } from "../src/validation.ts";

interface LoadEnv extends Env {
  DRIVERS: DurableObjectNamespace<SoakDriver>;
  BENCH_BUILD: string;
}

function meteredAI(ctx: DurableObjectState, env: LoadEnv): Ai {
  return new Proxy(env.AI, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key !== "run") return typeof value === "function" ? value.bind(target) : value;
    return async (model: string, input: Record<string, unknown>, ...rest: unknown[]) => {
      if (model !== env.MODEL) throw new Error("Benchmark model is fixed");
      const inputBytes = new TextEncoder().encode(JSON.stringify(input)).length;
      if (inputBytes > 65536) throw new Error("Benchmark input cap exceeded");
      await ctx.storage.transaction(async tx => {
        const usage = await tx.get<{calls:number;inputBytes:number}>("bench:usage") ?? {calls:0,inputBytes:0};
        if (usage.calls >= 90) throw new Error("Per-agent benchmark dispatch cap exhausted");
        await tx.put("bench:usage", {calls:usage.calls+1,inputBytes:usage.inputBytes+inputBytes});
      });
      // The model-load/soak experiment exercises text generation; separate
      // codemode experiments exercise tools. A small model can otherwise call
      // ask_human and park forever, which confounds inference latency.
      const bounded={...input,max_tokens:64};
      delete (bounded as Record<string,unknown>).tools;
      delete (bounded as Record<string,unknown>).tool_choice;
      return Reflect.apply(value, target, [model, bounded, ...rest]);
    };
  }});
}

class LoadAgent extends CamelAgent {
  private readonly benchInstance = crypto.randomUUID();
  constructor(ctx: DurableObjectState, env: LoadEnv) { super(ctx, {...env,AI:meteredAI(ctx,env)}); }
  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/bench/usage") {
      const response=await super.fetch(new Request("https://agent/history"));
      const history=await response.json() as {messages?:{role:string;usage?:{input:number;output:number;cacheRead:number;cacheWrite:number}}[]};
      const tokens={input:0,output:0,cacheRead:0,cacheWrite:0};let responses=0;
      for(const message of history.messages??[])if(message.role==="assistant"&&message.usage){responses++;for(const key of Object.keys(tokens) as (keyof typeof tokens)[])tokens[key]+=message.usage[key]??0;}
      return json({instance:this.benchInstance,responses,tokens,dispatches:await this.ctx.storage.get("bench:usage")});
    }
    if (new URL(request.url).pathname === "/bench/status") return json({instance:this.benchInstance,
      objectId:this.ctx.id.toString(),build:(this.env as LoadEnv).BENCH_BUILD,
      usage:await this.ctx.storage.get("bench:usage"),storageBytes:this.ctx.storage.sql.databaseSize});
    return super.fetch(request);
  }
}

type SoakState = {agent:string;startedAt:number;stopAt:number;intervalMs:number;nextAt:number;tick:number;pending?:number;pendingStartedAt?:number};
class SoakDriver extends DurableObject<LoadEnv> {
  private readonly instance = crypto.randomUUID();
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/start") {
      const input = await request.json() as {agent:string;durationMs:number};
      if (!/^[a-z0-9-]{1,80}$/.test(input.agent) || !Number.isInteger(input.durationMs)
        || input.durationMs <= 0 || input.durationMs > 3600000) return json({error:"Invalid soak"},400);
      const now=Date.now();
      const state:SoakState={agent:input.agent,startedAt:now,stopAt:now+input.durationMs,intervalMs:60000,nextAt:now+1000,tick:0};
      await this.ctx.storage.put({state,stopped:false}); await this.ctx.storage.setAlarm(state.nextAt); return json(state);
    }
    if (path === "/stop") { await this.ctx.storage.put("stopped",true); const state=await this.ctx.storage.get<SoakState>("state"); if(state){state.stopAt=Date.now();await this.ctx.storage.put("state",state);} await this.ctx.storage.deleteAlarm(); return json({stopped:true}); }
    return json({state:await this.ctx.storage.get("state"),objectId:this.ctx.id.toString(),instance:this.instance,alarm:await this.ctx.storage.getAlarm(),
      rows:[...(await this.ctx.storage.list({prefix:"tick:"})).values()]});
  }
  async alarm() {
    if(await this.ctx.storage.get("stopped")){await this.ctx.storage.deleteAlarm();return;}
    const state=await this.ctx.storage.get<SoakState>("state");
    if(!state || (Date.now()>state.stopAt && state.pending===undefined)) return;
    const tick=state.pending??state.tick;
    state.pending=tick;state.pendingStartedAt??=Date.now(); await this.ctx.storage.put("state",state);
    // Watchdog allows a deploy-interrupted alarm to reconcile the same durable request.
    await this.ctx.storage.setAlarm(Date.now()+90000);
    const stub=this.env.AGENTS.getByName(state.agent), id=`soak-${tick}`, startedAt=state.pendingStartedAt;
    let record:Record<string,unknown>={}; let error:string|undefined;
    try {
      const accepted=await stub.fetch("https://agent/requests",{method:"POST",body:JSON.stringify({id,method:"prompt",params:{text:`Reply with OK. Timer tick ${tick}.`,history:"none"}})});
      if(!accepted.ok) throw new Error(`submit HTTP ${accepted.status}: ${(await accepted.text()).slice(0,300)}`);
      for(let attempt=0;attempt<3;attempt++) {
        const response=await stub.fetch(`https://agent/requests/${id}?wait=25`);
        record=await response.json();
        if(record.state==="completed") break;
      }
      if(record.state!=="completed") error="request did not finish in 75 seconds";
    } catch(e) { error=String(e).slice(0,500); }
    await this.ctx.storage.put(`tick:${String(tick).padStart(4,"0")}`,{tick,startedAt,endedAt:Date.now(),scheduledAt:state.nextAt,
      instance:this.instance,build:this.env.BENCH_BUILD,status:record.status??null,error: error??record.error??null,
      agentBegan:record.began??null,agentEndedAt:record.endedAt??null});
    state.tick=tick+1;delete state.pending;delete state.pendingStartedAt;state.nextAt=state.startedAt+state.tick*state.intervalMs+1000;
    // A concurrent stop must survive the local state captured before await.
    const stopped=await this.ctx.storage.get("stopped");
    if(stopped)state.stopAt=Date.now();
    await this.ctx.storage.put("state",state);
    if(!stopped&&state.nextAt<state.stopAt) await this.ctx.storage.setAlarm(Math.max(Date.now()+1000,state.nextAt));
    else await this.ctx.storage.deleteAlarm();
  }
}
export {LoadAgent as "camelrun-proto-r2-ai-agent", SoakDriver as "camelrun-proto-r2-ai-driver"};
export default {async fetch(request:Request,env:LoadEnv) {
  if(!await authorized(request,env.API_TOKEN)) return json({error:"Unauthorized"},401);
  const path=new URL(request.url).pathname;
  if(path==="/meta")return json({build:env.BENCH_BUILD,model:env.MODEL});
  if(path.startsWith("/batch/") && request.method === "POST") {
    const input=await request.json() as {ids:string[];id:string};
    if(!Array.isArray(input.ids)||input.ids.length>500||input.ids.some(id=>!/^[a-z0-9-]{1,80}$/.test(id))||!/^[a-z0-9-]{1,80}$/.test(input.id))return json({error:"Invalid batch"},400);
    const action=path.slice(7),began=Date.now();
    const run=async(id:string)=>{
      const agent=env.AGENTS.getByName(id);let response:Response;
      if(action==="provision")response=await agent.fetch("https://agent/configuration",{method:"PUT",body:JSON.stringify({id,revision:1,expiresAt:null,config:{model:env.MODEL,systemPrompt:"Answer briefly. Do not use tools.",thinkingLevel:"off",fileTools:false,codeMode:false}})});
      else if(action==="submit")response=await agent.fetch("https://agent/requests",{method:"POST",body:JSON.stringify({id:input.id,method:"prompt",params:{text:"In one short sentence explain what a compiler does.",history:"none"}})});
      else if(action==="poll")response=await agent.fetch(`https://agent/requests/${input.id}?wait=0`);
      else if(action==="usage")response=await agent.fetch("https://agent/bench/usage");
      else return {id,error:"Unknown batch operation"};
      const value=await response.json() as Record<string,unknown>;return {...value,agent:id,httpStatus:response.status};
    };
    // Bound startup I/O. Submit the already provisioned agents in one fan-out.
    const rows:unknown[]=[];
    if(action==="provision")for(let i=0;i<input.ids.length;i+=25)rows.push(...await Promise.all(input.ids.slice(i,i+25).map(run)));
    else rows.push(...await Promise.all(input.ids.map(async id=>{try{return await run(id);}catch(e){return{id,error:String(e)};}})));
    return json({began,endedAt:Date.now(),rows});
  }
  const m=/^\/(agents|drivers)\/([a-z0-9-]{1,80})(\/.*)?$/.exec(path);
  if(!m)return json({error:"Not found"},404);
  const stub=(m[1]==="agents"?env.AGENTS:env.DRIVERS).getByName(m[2]);
  return stub.fetch(new Request(`https://internal${m[3]??"/"}${new URL(request.url).search}`,request));
}} satisfies ExportedHandler<LoadEnv>;

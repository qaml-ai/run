import { CodemodeSandboxDurableObject, cloudflareQuickJSWasm } from "@earendil-works/pi-codemode/cloudflare";
import { QuickJS } from "quickjs-wasi";
import { authorized } from "../src/validation.ts";
class Sandbox extends CodemodeSandboxDurableObject {
 private instance=crypto.randomUUID(); private active=0; private started=0; private ended=0; private exchanges=0;
 private events: {t:number;event:string;active:number}[]=[];
 private event(event:string) { this.events.push({t:Date.now(),event,active:this.active}); if(this.events.length>150) this.events.shift(); }
 override async execute(request:any,exchange:any) {
  this.active++;this.started++; this.event("start");
  try { return await super.execute(request,async (messages:any) => {this.exchanges++;return exchange(messages);}); }
  finally {this.active--;this.ended++;this.event("end");}
 }
 status() { return {instance:this.instance,active:this.active,started:this.started,ended:this.ended,exchanges:this.exchanges,events:this.events}; }
 async vmFootprint(count:number) {
  if(!Number.isInteger(count)||count<1||count>50)throw Error('Invalid VM count');
  const vms:QuickJS[]=[];
  try {
   await Promise.all(Array.from({length:count},async()=>{vms.push(await QuickJS.create({wasm:cloudflareQuickJSWasm as WebAssembly.Module,memoryLimit:32*1024*1024}));}));
   const rows=vms.map(vm=>({linearBytes:vm._getMemory().buffer.byteLength,quickjs:vm.getMemoryUsage()}));
   return {count,rows,totalLinearBytes:rows.reduce((s,r)=>s+r.linearBytes,0),instance:this.instance};
  }finally{vms.forEach(vm=>vm.dispose());}
 }
}
export {Sandbox as "camelrun-proto-r2-sandbox"};
export default {async fetch(request:Request,env:{API_TOKEN:string}) {return new Response("Not found",{status:await authorized(request,env.API_TOKEN)?404:401});}};

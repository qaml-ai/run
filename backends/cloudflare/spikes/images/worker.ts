import { CamelAgent, type Env } from "../../src/agent.ts";
import { authorized } from "../../src/validation.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiHarness } from "agents/harness/pi";
import { Buffer } from "node:buffer";

type Mode = "inline" | "reference" | "cached";
interface ImageEnv extends Env {
  CASES: DurableObjectNamespace<ImageCase>;
  BUCKET: R2Bucket;
  IMAGES: ImagesBinding;
}
// A separate benchmark class leaves the prototype runtime unchanged.
class ImageCase extends CamelAgent {
  private readonly instance = crypto.randomUUID();
  private context: any;
  private payload: any;
  private serialized: string | undefined;
  private get piHarness() { return (this as any).harness as PiHarness; }
  private get bindings() { return this.env as ImageEnv; }
  status() {
    return {instance:this.instance, objectId:this.ctx.id.toString(), at:Date.now(),
      databaseBytes:this.ctx.storage.sql.databaseSize, messages:this.context?.messages.length??0,
      payloadImages:this.payload?.messages.length??0, serializedBytes:this.serialized?.length??0};
  }
  async prepare() {
    const response = await super.fetch(new Request("https://agent/configuration", {method:"PUT",body:JSON.stringify({
      id:this.ctx.id.toString(),revision:1,expiresAt:null,config:{codeMode:false,fileTools:false},
    })}));
    if (!response.ok) throw Error(`configuration HTTP ${response.status}`);
    await (await this.piHarness.pi()).root(BACKGROUND_CONTEXT);
    return this.status();
  }
  async seed(mode: Mode, count: number) {
    const pi=await this.piHarness.pi(), root=await pi.root(BACKGROUND_CONTEXT);
    let completed=0;
    for(let i=0;i<count;i++) {
      const key=`original/${i}.png`;
      let block: any={type:"image_ref",key,mimeType:"image/png",width:1600,height:1200};
      if(mode==="inline") {
        const object=await this.bindings.BUCKET.get(key);if(!object)throw Error("fixture missing");
        block={type:"image",data:Buffer.from(await object.arrayBuffer()).toString("base64"),mimeType:"image/png"};
      }
      try {
        await root.commit(async tx=>{await tx.appendEntry(root.id,{kind:"pi.user",model:[{
          role:"user",content:[{type:"text",text:`Synthetic screenshot ${i}`},block],timestamp:Date.now(),
        }]});},BACKGROUND_CONTEXT);
      } catch(error) {return {...this.status(),completed,error:String(error)};}
      completed++;
    }
    this.context=await root.context(BACKGROUND_CONTEXT);
    return {...this.status(),completed};
  }
  // This is deliberately separate: if stock journal persistence rejects a large
  // entry, show its in-memory cost without pretending this is a persisted turn.
  async inlineMemory(count:number) {
    this.context={messages:[]};
    for(let i=0;i<count;i++) {
      const object=await this.bindings.BUCKET.get(`original/${i}.png`);if(!object)throw Error("fixture missing");
      this.context.messages.push({role:"user",content:[{type:"image",mimeType:"image/png",data:Buffer.from(await object.arrayBuffer()).toString("base64")}],timestamp:Date.now()});
    }
    return this.status();
  }
  async request(mode:Mode,count:number,urlMode:boolean) {
    if(!this.context) {
      const root=await (await this.piHarness.pi()).root(BACKGROUND_CONTEXT);
      this.context=await root.context(BACKGROUND_CONTEXT);
    }
    const started=performance.now();let transformed=0,totalBytes=0;const output:any[]=[];
    for(let i=count-1;i>=0;i--) {
      const key=`original/${i}.png`,cachedKey=`scaled-v1/${i}.jpg`;
      // A URL-only request needs metadata, not a get() body. Leaving multiple
      // R2.get streams unread can exhaust the platform's open-connection slots.
      let scaled=mode==="cached"?await this.bindings.BUCKET.head(cachedKey):null;
      if(!scaled) {
        const original=await this.bindings.BUCKET.get(key);if(!original)throw Error("fixture missing");
        const result=await this.bindings.IMAGES.input(original.body)
          .transform({width:1568,height:1568,fit:"scale-down"}).output({format:"image/jpeg",quality:85,anim:false});
        const response=result.response();
        if(mode==="cached") {
          // R2.put requires a known-length stream; the Images response does
          // not promise Content-Length. Bound and buffer only the derivative.
          // The original still streams directly from R2 into Images.
          const chunks:Uint8Array[]=[];let size=0;
          for await(const chunk of response.body!) {
            size+=chunk.byteLength;if(size>3.75*1024*1024)throw Error("Derivative exceeds byte cap");
            chunks.push(chunk);
          }
          await this.bindings.BUCKET.put(cachedKey,Buffer.concat(chunks),{httpMetadata:{contentType:"image/jpeg"}});
          scaled=await this.bindings.BUCKET.head(cachedKey);
        } else {
          const bytes=Buffer.from(await response.arrayBuffer());totalBytes+=bytes.length;
          output.push({role:"user",content:[{type:"image",mimeType:"image/jpeg",data:bytes.toString("base64")}]});
        }
        transformed++;
      }
      if(scaled) {
        totalBytes+=scaled.size;
        if(urlMode) output.push({role:"user",content:[{type:"input_image",image_url:`https://example.invalid/image/${cachedKey}`} ]});
        else {
          const body=await this.bindings.BUCKET.get(cachedKey);if(!body)throw Error("cached image missing");
          output.push({role:"user",content:[{type:"image",mimeType:"image/jpeg",data:Buffer.from(await body.arrayBuffer()).toString("base64")}]});
        }
      }
    }
    this.payload={messages:output};this.serialized=JSON.stringify(this.payload);
    return {...this.status(),transformed,totalBytes,elapsedMs:performance.now()-started,
      note:urlMode?"URL-shaped payload only; no provider request or publicly exposed image":"Unbounded image batch for memory measurement; production must impose count/byte budgets"};
  }
  async hold(ms:number) {await new Promise(resolve=>setTimeout(resolve,ms));return this.status();}
  clear(){this.context=undefined;this.payload=undefined;this.serialized=undefined;return this.status();}
}
// Wrangler's local DO wrapper currently requires an identifier-style export.
export {ImageCase as "camelrun-proto-hybrid-images", ImageCase as CamelrunProtoHybridImages};
export default {async fetch(request:Request,env:ImageEnv) {
  if(!await authorized(request,env.API_TOKEN))return Response.json({error:"Unauthorized"},{status:401});
  const path=new URL(request.url).pathname;
  const fixture=/^\/fixture\/(\d+)$/.exec(path);
  if(fixture&&request.method==="PUT") {
    const index=Number(fixture[1]);if(index>99)return new Response("limit",{status:400});
    await env.BUCKET.put(`original/${index}.png`,request.body,{httpMetadata:{contentType:"image/png"}});
    return Response.json({stored:index});
  }
  if(path==="/cleanup") {
    const listing=await env.BUCKET.list();await env.BUCKET.delete(listing.objects.map(o=>o.key));
    return Response.json({deleted:listing.objects.length,truncated:listing.truncated});
  }
  const match=/^\/case\/([a-z0-9-]+)\/(prepare|seed|inlineMemory|request|status|hold|clear)$/.exec(path);
  if(!match)return new Response("not found",{status:404});
  const stub=env.CASES.getByName(match[1]);
  const input=request.method==="POST"?await request.json() as any:{};
  if(input.count!==undefined&&(!Number.isInteger(input.count)||input.count<1||input.count>100))return new Response("count",{status:400});
  if(input.mode!==undefined&&!["inline","reference","cached"].includes(input.mode))return new Response("mode",{status:400});
  try {
    if(match[2]==="seed")return Response.json(await stub.seed(input.mode,input.count));
    if(match[2]==="inlineMemory")return Response.json(await stub.inlineMemory(input.count));
    if(match[2]==="request")return Response.json(await stub.request(input.mode,input.count,!!input.urlMode));
    if(match[2]==="hold")return Response.json(await stub.hold(Math.min(60000,input.ms??1000)));
    return Response.json(await (stub as any)[match[2]]());
  }catch(error){return Response.json({error:String(error)},{status:500});}
}} satisfies ExportedHandler<ImageEnv>;

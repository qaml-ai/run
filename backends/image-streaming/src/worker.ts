import { DurableObject } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Harness, createRegistry, type ContextView } from '@earendil-works/pi-durable';
import { openDurableObjectSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import { createModels } from '@earendil-works/pi-ai/models';
import type { Api, ImageContent, Model, Message } from '@earendil-works/pi-ai';
import { stream as chat } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as responses } from '@earendil-works/pi-ai/api/openai-responses';
import { stream as anthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { makeMarker, type ImageReference } from './marker.ts';
import { streamingFetch } from './stream.ts';
import { substituteSignedUrls, serveSignedImage, createSignedImageUrl } from './signed.ts';
import { authorized } from './fake-provider.ts';
import { runPiProbe } from './pi-probe.ts';
import { runVisionCheck } from './vision.ts';

interface Env {
  CASES: DurableObjectNamespace<ImageAgent>;
  BUCKET: R2Bucket;
  IMAGES: ImagesBinding;
  AI: Ai;
  PROVIDER: Fetcher;
  PROXY: Fetcher;
  EXPERIMENT_TOKEN: string;
  PUBLIC_ORIGIN: string;
  IMAGE_PROFILE?: string;
  CPU_LIMIT_MS?: string;
}
type Mode = 'A' | 'B' | 'C' | 'D';
type RequestOptions = {api?: string; failAfter?: number; abortMs?: number; missing?: boolean; holdMs?: number};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown, status = 200) => Response.json(value, {status, headers: {'cache-control': 'no-store'}});
const derivativePrefix = 'derivative-v1/';

/** Experiment only: each named object is an independent stock Pi SQLite journal. */
export class ImageAgent extends DurableObject<Env> {
  private constructorId = crypto.randomUUID();
  private harness?: Harness;
  private loaded?: ContextView;
  private mode: Mode = 'B';
  private expected: ImageReference[] = [];
  private async pi() {
    return this.harness ??= await Harness.open(
      await openDurableObjectSqliteStorage(this.ctx.storage), {models: createModels(),registry:createRegistry()}, BACKGROUND_CONTEXT);
  }
  status() {
    return {constructorId: this.constructorId, objectId: this.ctx.id.toString(),
      mode: this.mode, databaseBytes: this.ctx.storage.sql.databaseSize,
      messages: this.loaded?.messages.length ?? 0, images: this.expected.length,
      cpuLimitMs: Number(this.env.CPU_LIMIT_MS ?? 300000), at: Date.now()};
  }
  async seed(mode: Mode, count: number) {
    this.mode = mode;
    const manifest = await this.env.BUCKET.get('manifest.json');
    if (!manifest) throw Error('Missing corpus');
    const refs = await manifest.json<ImageReference[]>();
    if (refs.length < count) throw Error('Insufficient corpus');
    this.expected = refs.slice(0, count);
    await this.ctx.storage.put('benchmark', {mode, refs: this.expected});
    const root = await (await this.pi()).root(BACKGROUND_CONTEXT);
    for (const [index, ref] of this.expected.entries()) {
      let data = makeMarker(ref);
      if (mode === 'A') {
        const object = await this.env.BUCKET.get(ref.key);
        if (!object) throw Error('Missing inline corpus image');
        data = Buffer.from(await object.arrayBuffer()).toString('base64');
      }
      const image: ImageContent = {type: 'image', data, mimeType: mode === 'A' ? ref.mimeType : 'image/png'};
      await root.commit(async tx => {
        await tx.appendEntry(root.id, {kind: 'pi.user', model: [{role: 'user', content: [
          {type: 'text', text: `Synthetic screenshot ${index}`}, image], timestamp: Date.now()}]});
      }, BACKGROUND_CONTEXT);
    }
    this.loaded = await root.context(BACKGROUND_CONTEXT);
    return {...this.status(), inlineBytes: mode === 'A' ? this.expected.reduce((n,r)=>n+r.size,0) : 0};
  }
  private async reload() {
    const record = await this.ctx.storage.get<{mode: Mode;refs: ImageReference[]}>('benchmark');
    if (record) {this.mode = record.mode; this.expected = record.refs;}
    const root = await (await this.pi()).root(BACKGROUND_CONTEXT);
    this.loaded = await root.context(BACKGROUND_CONTEXT);
    return this.loaded;
  }
  async request(options: RequestOptions) {
    const started = performance.now();
    const view = this.loaded ?? await this.reload();
    const messages = [...view.messages] as Message[];
    if (options.missing) {
      const first = messages[0] ? structuredClone(messages[0]) : undefined;
      if(first) messages[0]=first;
      if (first?.role === 'user' && Array.isArray(first.content)) {
        first.content = first.content.map(part => part.type === 'image' ? {...part,
          data: makeMarker({...this.expected[0]!, key: derivativePrefix + 'missing.png'})} : part);
      }
    }
    const api = options.api ?? 'openai-completions';
    const provider = this.env.PROVIDER.fetch.bind(this.env.PROVIDER);
    let calls = 0;
    let transportError: string | undefined;
    const requestFetch: typeof fetch = async (input, init) => {
      calls++;
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${this.env.EXPERIMENT_TOKEN}`);
      if (options.failAfter && calls === 1) headers.set('x-proto-fail-after', String(options.failAfter));
      if (this.mode === 'D') headers.set('x-proto-mode', 'urls');
      const args: RequestInit = {...init, headers};
      if (this.mode === 'B') return streamingFetch(provider, this.env.BUCKET)(input, args);
      if (this.mode === 'C') return this.env.PROXY.fetch(input, args);
      if (this.mode === 'D') {
        const changed = await substituteSignedUrls(String(args.body), {origin: this.env.PUBLIC_ORIGIN,
          secret: this.env.EXPERIMENT_TOKEN, keyPrefix: derivativePrefix});
        return provider(input, {...args, body: changed.body});
      }
      return provider(input, args);
    };
    const transport: typeof fetch = async (input,init) => {
      try{return await requestFetch(input,init);}
      catch(error){
        transportError=String(error).replace(/([?&]signature=)[^&\s"']+/g,'$1[redacted]').replaceAll(this.env.EXPERIMENT_TOKEN,'[redacted]');
        throw error;
      }
    };
    const model: Model<Api> = {id: 'image-hash', name: 'Image hash fixture', provider: 'experiment', api: api as Api,
      baseUrl: api === 'anthropic-messages' ? 'https://fake.internal' : 'https://fake.internal/v1', reasoning: false, input: ['text','image'], contextWindow: 1000000,
      maxTokens: 8192, cost: {input:0,output:0,cacheRead:0,cacheWrite:0}};
    const abort = new AbortController();
    const timer = options.abortMs === undefined ? undefined : setTimeout(()=>abort.abort(), options.abortMs);
    try {
      const requestOptions = {apiKey: this.env.EXPERIMENT_TOKEN, fetch: transport,
        signal: abort.signal, maxRetries: options.failAfter ? 1 : 0, timeoutMs: 180000};
      const context = normalizeContext({messages});
      const stream = api === 'anthropic-messages' ? anthropic(model as Model<'anthropic-messages'>, context, requestOptions) :
        api === 'openai-responses' ? responses(model as Model<'openai-responses'>, context, requestOptions) :
        chat(model as Model<'openai-completions'>, context, requestOptions);
      const result = await stream.result();
      if (result.stopReason === 'error' || result.stopReason === 'aborted') {
        return {...this.status(), calls, elapsedMs: performance.now()-started, stopReason: result.stopReason,
          expectedFault: options.missing ? 'missing' : options.abortMs !== undefined ? 'abort' : undefined, transportError,
          error: (result.errorMessage??'Provider request failed').replace(/([?&]signature=)[^&\s"']+/g,'$1[redacted]')};
      }
      const text = result.content.filter(p=>p.type==='text').map(p=>p.text).join('');
      const summary = JSON.parse(text) as {images: {sha256: string;bytes: number;mimeType?:string;declaredMimeType?:string}[]; imageCount: number;bytesRead: number};
      const match = summary.images.length === this.expected.length && summary.images.every((image,index)=>
        image.sha256 === this.expected[index]?.sha256 && image.bytes === this.expected[index]?.size);
      const mimeMatch = summary.images.every((image,index)=>image.mimeType===this.expected[index]?.mimeType &&
        (api==='anthropic-messages'||image.declaredMimeType===this.expected[index]?.mimeType));
      const elapsedMs = performance.now() - started;
      if (options.holdMs) await new Promise(resolve=>setTimeout(resolve, Math.min(options.holdMs!,45000)));
      return {...this.status(), calls, elapsedMs, match, mimeMatch, summary};
    } finally {if (timer !== undefined) clearTimeout(timer);}
  }
  async evict() {this.ctx.abort('Intentional experiment eviction');}
  async vision() {
    return {...await runVisionCheck(this.env), location:'ImageAgent Durable Object', ...this.status()};
  }
  async probe(): Promise<unknown> {
    return runPiProbe(this.ctx.storage, async image => {
      const bytes = Buffer.from(image.data, 'base64');
      if(bytes.length>32*1024*1024)throw Error('Image input exceeds 32 MiB');
      const key = `tool-original/${hash(bytes)}.png`;
      await this.env.BUCKET.put(key, bytes);
      const {ref}=await deriveImage(key,this.env);
      return {type:'image',mimeType:'image/png',data:makeMarker(ref)};
    });
  }
}

async function deriveImage(key: string,env: Env,realistic=false) {
  const format = realistic ? 'image/jpeg' : 'image/png';
  const qualities = realistic ? [82,72,90] : [undefined];
  let selected: {bytes: Buffer;quality: number|undefined;originalBytes: number}|undefined;
  const attempts: {quality?:number;bytes:number}[] = [];
  for (const quality of qualities) {
    const original = await env.BUCKET.get(key);
    if (!original) throw Error('Upload failed');
    const image = await env.IMAGES.input(original.body).transform({width:1568,height:1568,fit:'scale-down'})
      .output({format,anim:false,...(quality===undefined?{}:{quality})});
    const reader = image.response().body!.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {while (true) {const item=await reader.read();if(item.done)break;
      size+=item.value.byteLength; if(size>5*1024*1024)throw Error('Derivative exceeds 5 MiB');chunks.push(item.value);
    }} finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    selected={bytes:Buffer.concat(chunks),quality,originalBytes:original.size};
    attempts.push({quality,bytes:size});
    if (!realistic || (size>=200000&&size<=400000)) break;
  }
  const {bytes,quality,originalBytes}=selected!;
  const info = await env.IMAGES.info(new Response(bytes).body!);
  if ('width' in info && (info.width>1568||info.height>1568)) throw Error('Derivative dimensions exceed 1568 pixels');
  const sha256 = hash(bytes), derivativeKey = `${derivativePrefix}${sha256}.${realistic?'jpg':'png'}`;
  await env.BUCKET.put(derivativeKey, bytes, {httpMetadata:{contentType:format},customMetadata:{sha256}});
  const ref: ImageReference = {key:derivativeKey,size:bytes.length,mimeType:format,sha256};
  return {ref,originalBytes,output:{...info,quality},attempts};
}

async function upload(index: number, request: Request, env: Env) {
  const key = `original/${index}`;
  await env.BUCKET.put(key, request.body);
  const realistic=env.IMAGE_PROFILE==='realistic';
  const result=await deriveImage(key,env,realistic), {ref}=result;
  const accepted=!realistic || (ref.size>=200000&&ref.size<=400000);
  if (accepted) await env.BUCKET.put(`ref/${index}.json`,JSON.stringify(ref));
  return json({...result,accepted});
}

export default {async fetch(request: Request, env: Env) {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/signed-image') return serveSignedImage(request,env.BUCKET,{secret:env.EXPERIMENT_TOKEN,keyPrefix:derivativePrefix});
  if (!authorized(request,env.EXPERIMENT_TOKEN)) return new Response('Unauthorized',{status:401});
  const fixture = /^\/fixture\/(\d+)$/.exec(path);
  if (fixture && request.method === 'PUT' && Number(fixture[1])<500) {
    try{return await upload(Number(fixture[1]),request,env);}
    catch(error){return json({error:String(error)},500);}
  }
  if (path === '/manifest') {
    const listing = await env.BUCKET.list({prefix:'ref/'});
    const refs: ImageReference[] = [];
    for (const object of listing.objects.sort((a,b)=>Number(a.key.match(/\d+/)?.[0])-Number(b.key.match(/\d+/)?.[0]))) {
      const data=await env.BUCKET.get(object.key); if(data) refs.push(await data.json<ImageReference>());
    }
    await env.BUCKET.put('manifest.json',JSON.stringify(refs));
    return json({refs});
  }
  if (path === '/vision' && request.method === 'POST') {
    if (env.IMAGE_PROFILE==='realistic') {
      try{return json(await env.CASES.getByName('vision-b').vision());}
      catch(error){return json({error:String(error).replace(/https:\/\/[^\s"']+/g,'[url redacted]')},502);}
    }
    const manifest=await env.BUCKET.get('manifest.json');
    if(!manifest)return json({error:'Missing corpus'},400);
    const refs=await manifest.json<ImageReference[]>();
    const signed=await createSignedImageUrl(refs[0]!,{origin:env.PUBLIC_ORIGIN,secret:env.EXPERIMENT_TOKEN,keyPrefix:derivativePrefix});
    const started=performance.now();
    try {
      const result=await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct',{
        prompt:'Describe the visible image in one short sentence.',image:signed,max_tokens:40,
      });
      return json({model:'@cf/meta/llama-3.2-11b-vision-instruct',elapsedMs:performance.now()-started,result});
    } catch(error) {return json({error:String(error).replace(/https:\/\/[^\s"']+/g,'[url redacted]')},502);}
  }
  if (path === '/cleanup') {
    let deleted=0;
    while(true) {const list=await env.BUCKET.list();if(!list.objects.length)break;
      await env.BUCKET.delete(list.objects.map(o=>o.key));deleted+=list.objects.length;}
    return json({deleted});
  }
  const route=/^\/case\/([a-zA-Z0-9-]+)\/(seed|request|status|evict|probe)$/.exec(path);
  if (!route) return new Response('Not found',{status:404});
  const stub=env.CASES.getByName(route[1]!);
  const input = request.method === 'POST' ? await request.json() as Record<string,unknown> : {};
  try {
    if(route[2]==='seed') {
      if(!['A','B','C','D'].includes(String(input.mode))||![1,20,100].includes(Number(input.count)))return json({error:'Invalid case'},400);
      return json(await stub.seed(input.mode as Mode,Number(input.count)));
    }
    if(route[2]==='request') return json(await stub.request(input as RequestOptions));
    if(route[2]==='probe') return json(await stub.probe());
    if(route[2]==='evict') {try {await stub.evict();}catch{}return json({evicted:true});}
    return json(await stub.status());
  } catch(error) {return json({error: String(error).replace(/signature=[^&\s]+/g,'signature=[redacted]')},500);}
}} satisfies ExportedHandler<Env>;

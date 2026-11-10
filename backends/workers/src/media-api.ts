import { Buffer } from 'node:buffer';
import { Imager, imageRequest, imageOptions, type ImageSource } from './media/images.ts';
import { Transcriber, openaiTranscription, transcribeRequest, languageInput } from './media/transcription.ts';
import { openaiImages } from './media/images.ts';
import { Synthesizer, openaiSpeech, DEFAULT_VOICE } from './media/speech.ts';
import { speechRequest, speechInput, speechChoiceInput } from './media/speech-api.ts';
import { speechProvider, DEFAULT_VOICES } from './media/voice-providers/tts.ts';
import { speechPrices, ttsCost } from '../../../src/voice-providers/prices.ts';
import { boundedBytes } from './images.ts';
import { volume, type FileBindings } from './files.ts';
import { normalizePath } from './volume.ts';
import { HttpError } from './errors.ts';
import { withSql, transaction, database } from './postgres.ts';
import { EndUserCredits } from './end-user-credits.ts';
import { publishPending, type WebhookEnv } from './webhooks.ts';
import { keyServices, type KeyServices } from './security-services.ts';
import { runAdmission, type AdmissionEnv } from './admission.ts';
import { metric } from './observability.ts';
import { mediaAzure, azureCredentials, type MediaAzureEnv } from './media-azure.ts';
import type { AuthContext } from './control.ts';
import { chargesPlatform } from '../../../src/core/key-source.ts';

export type MediaBindings = Omit<FileBindings, 'HYPERDRIVE'> & WebhookEnv & Omit<AdmissionEnv, 'HYPERDRIVE'> & MediaAzureEnv & {
  PLATFORM_OPENAI_KEY?: string;
  MEDIA_BASE_URL?: string;
  AGENT_IMAGES_URL?: string;
  AGENT_TRANSCRIPTION_URL?: string;
  AGENT_SPEECH_URL?: string;
  MEDIA_PRICING?: string;
  MEDIA_ALLOWED_HOSTS?: string;
  AGENT_SPEECH_PRICES?: string;
  TENANTS?: { getByName(name: string): { rate(key: string, limit: number, windowMs?: number): Promise<boolean> } };
  /** Test fixtures only: source tenants-file configuration, containing synthetic keys. */
  TEST_MEDIA_TENANTS?: string;
  TEST_MODE?: string;
}
const json = (value: unknown) => Response.json(value, { headers: { 'cache-control': 'no-store' } });
const testConfig = (env: MediaBindings) => env.TEST_MODE === '1' ? JSON.parse(env.TEST_MEDIA_TENANTS ?? '{}') : {};

/** Credentials resolve at call time; they never enter agent history or public responses. */
export async function mediaKey(env: MediaBindings, tenant: string, scope: string | undefined, provider: string, services?: KeyServices, azureDeployment?: string) {
  const { accounts, keyScopes } = services ?? await keyServices(env);
  // Match src/node.ts's standalone media resolution: an address-only scope is
  // a gateway that needs no key, while an absent entry falls back to the account.
  const entry = scope ? await keyScopes.entry(tenant, scope, provider) : undefined;
  if (entry?.apiKey || entry?.baseUrl) return {
    apiKey: entry.apiKey ?? '', ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    ...(entry.headers ? { headers: entry.headers } : {}), platform: false,
  };
  const resolved = await accounts.providerKey(tenant, provider);
  if (resolved) {
    const platform = chargesPlatform(resolved.source);
    if (platform) { const limited = await accounts.billing.creditLimit(tenant); if (limited) throw limited; }
    const azure = platform && provider === 'openai' && azureDeployment ? mediaAzure(env) : undefined;
    if (azure && azureDeployment) return { ...azureCredentials(azure, azureDeployment, { apiKey: resolved.key }), platform: true };
    return { apiKey: resolved.key, platform };
  }
  // Keep old local fixtures usable; production keys come from the shared store.
  const configured = testConfig(env).tenants?.[tenant];
  if (configured?.apiKeys?.[provider]) return { apiKey: configured.apiKeys[provider], platform: false };
  if (configured?.platformKeys === false) return undefined;
  const key = env.TEST_MODE === '1' && provider === 'openai' ? env.PLATFORM_OPENAI_KEY : undefined;
  return key ? { apiKey: key, platform: true } : undefined;
}

/** Stream with bounded bytes; redirect destinations receive a fresh allowlist check. */
export function mediaOutbound(env: MediaBindings) {
  const azure = mediaAzure(env);
  return { fetch: async (address: string | URL, options: any = {}) => {
    let url = new URL(address);
    const base = env.MEDIA_BASE_URL ? new URL(env.MEDIA_BASE_URL) : undefined;
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let streaming = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 180000); };
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    refresh();
    try {
      for (let n = 0; n <= (options.maxRedirects ?? 0); n++) {
        const fixture = env.TEST_MODE === '1' && (base?.origin === url.origin || azure?.endpoint === url.origin) && ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
        // Workers cannot resolve and pin arbitrary DNS. An operator allowlist is
        // required for source URLs; this closes DNS rebinding as well as literal IPs.
        const provider = !!options.secrets && (['https://api.openai.com','https://api.elevenlabs.io','https://api.cartesia.ai','https://api.deepgram.com'].includes(url.origin) || base?.origin === url.origin || azure?.endpoint === url.origin);
        const allowed = env.MEDIA_ALLOWED_HOSTS?.split(',').map(host => host.trim().toLowerCase()).includes(url.hostname);
        if (url.username || url.password || (!fixture && (url.protocol !== 'https:' || (!provider && !allowed)))) throw new HttpError(400, 'Media URL must use an operator-allowlisted HTTPS hostname');
        const response = await fetch(url, { method: options.method, body: options.body, headers: { ...options.headers, ...options.secrets }, signal: controller.signal, redirect: 'manual' });
        if ([301,302,303,307,308].includes(response.status) && response.headers.has('location')) {
          await response.body?.cancel();
          if (options.secrets || n === (options.maxRedirects ?? 0)) throw new HttpError(400, 'Media redirect refused');
          url = new URL(response.headers.get('location')!, url); continue;
        }
        if (!response.body) return response;
        const max = options.maxBytes ?? 64*1024*1024;
        if (Number(response.headers.get('content-length')) > max) { await response.body.cancel(); throw new HttpError(413, 'Media response is larger than the byte limit'); }
        if (options.stream) {
          let total = 0;
          const reader = response.body.getReader();
          streaming = true;
          const bounded = new ReadableStream<Uint8Array>({
            async pull(c) {
              try {
                const next = await reader.read();
                if (next.done) { cleanup(); c.close(); return; }
                total += next.value.byteLength;
                if (total > max) { controller.abort(); await reader.cancel(); throw new HttpError(413, 'Media response is larger than the byte limit'); }
                refresh(); c.enqueue(next.value);
              } catch (error) { cleanup(); c.error(error); }
            },
            async cancel(reason) { controller.abort(reason); try { await reader.cancel(reason); } finally { cleanup(); } },
          });
          return new Response(bounded, response);
        }
        return new Response(await boundedBytes(response.body, max), response);
      }
      throw new HttpError(400, 'Media redirect limit exceeded');
    } finally { if (!streaming) cleanup(); }
  } } as any;
}

async function admit(env: MediaBindings, tenant: string, services: KeyServices) {
  const refused = await services.accounts.runLimit(tenant);
  if (refused) throw typeof refused === 'string' ? new HttpError(402, refused, 'SPEND_LIMIT') : refused;
  await runAdmission(env, tenant);
  // Compatibility for pre-money-track synthetic fixture settings only.
  if (env.TEST_MODE !== '1' || !env.TEST_MEDIA_TENANTS || services.accounts.tenants.has(tenant)) return;
  const configured = testConfig(env).tenants?.[tenant];
  const row = (await withSql(env, sql => sql.query('select t.billing,t.limits,a.balance,coalesce((select sum(amount) from credit_holds where tenant=t.id),0) held from tenants t left join credit_accounts a on a.tenant=t.id where t.id=$1', [tenant]))).rows[0];
  if (!row) throw new HttpError(401, 'Unknown account');
  const cap = configured?.maxMonthlyCost ?? row.limits?.maxMonthlyCost;
  if (cap !== undefined) {
    const spent = Number((await withSql(env, sql => sql.query('select coalesce(sum(cost),0) spent from usage where tenant=$1 and day >= $2', [tenant,new Date().toISOString().slice(0,7)+'-01']))).rows[0].spent);
    if (spent >= cap) throw new HttpError(402, 'Monthly spend limit reached', 'SPEND_LIMIT');
  }
  if (row.billing !== 'none' && Number(row.balance) - Number(row.held) <= 0) throw new HttpError(402, 'Credit required', 'INSUFFICIENT_CREDIT');
  const rate = configured?.runsPerMinute ?? row.limits?.runsPerMinute;
  if (rate !== undefined && env.TENANTS && !await env.TENANTS.getByName(tenant).rate('runs',rate)) throw new HttpError(429,'Run rate limit reached','RATE_LIMIT');
}
export { admit as admitMedia };

/** Known provider usage and its event are committed together. No prompt, image or transcript enters SQL. */
async function record(env: MediaBindings, services: KeyServices, tenant: string, usage: any) {
  const amount = Math.round(usage.usage.cost.total * 1e6);
  await transaction(env, sql => services.accounts.recordUsageIn(sql, tenant, '', usage));
  await services.accounts.usageCommitted(tenant);
  await publishPending(env);
  metric(env,'media_usage',{MediaRequests:1,MediaCostMicros:amount},{Provider:usage.provider,Model:usage.model});
}

function source(input: any): ImageSource {
  if (!input || typeof input !== 'object' || (input.data === undefined) === (input.url === undefined)) throw new HttpError(400,'Send data or url, one of them');
  if (input.url !== undefined) { if (typeof input.url !== 'string') throw new HttpError(400,'url must be a string'); return {url:input.url}; }
  if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new HttpError(400,'data must be base64');
  return {bytes:new Uint8Array(Buffer.from(input.data,'base64'))};
}
export async function handleMediaRequest(request: Request, env: MediaBindings, auth: AuthContext): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === '/v1/images' && !/^(application\/json|multipart\/form-data)/i.test(request.headers.get('content-type') ?? '')) return null;
  if (!['/v1/images','/v1/transcriptions','/v1/speech'].includes(path) || request.method !== 'POST') return null;
  const kind = path.slice(4), multipart = /^multipart\/form-data(;|$)/i.test(request.headers.get('content-type')??'');
  const sourceUrl = kind === 'images' ? env.AGENT_IMAGES_URL : kind === 'transcriptions' ? env.AGENT_TRANSCRIPTION_URL : env.AGENT_SPEECH_URL;
  if (sourceUrl) env = { ...env, MEDIA_BASE_URL: sourceUrl };
  const bytes = await boundedBytes(request.body, kind === 'images' ? 68*1024*1024 : kind === 'speech' ? 64*1024 : 34*1024*1024);
  let input: any, images: ImageSource[] = [], mask: ImageSource | undefined, audio: any;
  if (multipart) {
    let form: FormData;
    try { form = await new Response(bytes,{headers:{'content-type':request.headers.get('content-type')!}}).formData(); } catch { throw new HttpError(400,'Invalid multipart body'); }
    input = Object.fromEntries([...form].filter(([,v])=>typeof v==='string'));
    if (input.n !== undefined) input.n = Number(input.n);
    if (input.context) { try { input.context=JSON.parse(input.context); } catch { throw new HttpError(400,'context must be JSON'); } }
    for (const value of [...form.getAll('image'),...form.getAll('image[]')]) { if (!(value instanceof Blob)) throw new HttpError(400,'Send image file parts'); images.push({bytes:new Uint8Array(await value.arrayBuffer())}); }
    const masked=form.get('mask'); if (masked) { if (!(masked instanceof Blob)) throw new HttpError(400,'Send mask file part'); mask={bytes:new Uint8Array(await masked.arrayBuffer())}; }
    const file=form.get('file'); if (file instanceof Blob) audio={bytes:new Uint8Array(await file.arrayBuffer())};
  } else { try { input=JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400,'Expected JSON object'); } }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400,'Expected object');
  const extras = ['subject','actor','context','keyScope','bucket'];
  const fields = kind === 'images' ? ['prompt','images','mask','size','quality','format','n','background','volumeId','path'] : kind === 'transcriptions' ? ['data','url','language','prompt'] : ['text','voice','instructions','language','format','speech'];
  if (Object.keys(input).some(k=>![...fields,...extras].includes(k))) throw new HttpError(400,'Unknown request field');
  for (const key of ['subject','actor','keyScope','bucket']) if (input[key]!==undefined && (typeof input[key]!=='string' || !input[key].length || input[key].length>256)) throw new HttpError(400,`Invalid ${key}`);
  for (const key of ['subject','actor']) if (input[key]!==undefined && (!input[key].trim() || input[key].length>200)) throw new HttpError(400,`Invalid ${key}`);
  if (input.context!==undefined && (!input.context || typeof input.context!=='object' || Array.isArray(input.context))) throw new HttpError(400,'context must be an object');
  if (input.context!==undefined && Buffer.byteLength(JSON.stringify(input.context))>4096) throw new HttpError(400,'context must be at most 4 KB of JSON');
  for (const key of ['volumeId','path','text','voice','instructions','language','prompt','format']) if (input[key]!==undefined && typeof input[key]!=='string') throw new HttpError(400,`${key} must be a string`);
  if (input.path?.length>1000 || (kind==='transcriptions' && input.prompt?.length>2000)) throw new HttpError(400,'Request field is too long');
  if (kind==='speech' && typeof input.text!=='string') throw new HttpError(400,'text must be a string');
  const tenant=auth.tenantId, pending: Promise<void>[]=[];
  const services=await keyServices(env);
  const baseUrl = (kind === 'images' ? env.AGENT_IMAGES_URL : kind === 'transcriptions' ? env.AGENT_TRANSCRIPTION_URL : undefined) ?? env.MEDIA_BASE_URL;
  const outboundEnv = baseUrl === env.MEDIA_BASE_URL ? env : { ...env, MEDIA_BASE_URL: baseUrl };
  const drain = async <T>(task: Promise<T>) => { try { return await task; } finally { await Promise.all(pending); } };
  const common={outbound:mediaOutbound(outboundEnv),admit:()=>admit(env,tenant,services),record:(_tenant:string,usage:any)=>{ const write=record(env,services,tenant,usage); void write.catch(()=>{}); pending.push(write); }};
  const prices={...services.accounts.billing.pricing,...(env.TEST_MODE==='1'?JSON.parse(env.MEDIA_PRICING??'{}'):{})};
  const key=(_tenant:string,scope:string|undefined,provider:string)=>mediaKey(env,tenant,scope,provider,services);
  const azure=mediaAzure(env);
  const identity=input.subject!==undefined || input.context!==undefined ? {subject:input.subject,context:input.context}:undefined;
  const facts={...(input.bucket!==undefined?{bucket:input.bucket}:{}),...(input.keyScope?{keyScope:input.keyScope}:{}),...(input.actor?{actor:input.actor}:{}),...(identity?{identity}:{})};
  const hold=input.subject ? (usd:number)=>new EndUserCredits(database(env)).hold(tenant,input.subject,input.bucket??'default',usd,kind==='images'?'image':kind==='transcriptions'?'transcription':'speech') : undefined;
  if (kind==='images') {
    if (typeof input.prompt!=='string' || !input.prompt.trim() || input.prompt.length>32000) throw new HttpError(400,'prompt must contain 1–32000 characters');
    if (!multipart) { if(input.images!==undefined && !Array.isArray(input.images)) throw new HttpError(400,'images must be an array'); const checked=(value:any)=>{if (value && Object.keys(value).some(k=>k!=='data' && k!=='url')) throw new HttpError(400,'Unknown image source field');return source(value);}; images=(input.images??[]).map(checked); mask=input.mask!==undefined?checked(input.mask):undefined; }
    if (input.path!==undefined && input.volumeId===undefined) throw new HttpError(400,'path requires volumeId');
    const made=await drain(imageRequest({...common,imager:new Imager({provider:openaiImages({outbound:common.outbound,baseUrl}),key:(t,s,p)=>mediaKey(env,t,s,p,services,azure?.imageDeployment),price:()=>prices.image}), owns:async(t,id)=>!!await volume(env,t,id),save:async(t,id,p,b,ct)=>{const {key,...saved}=await (await volume(env,t,id)).write(p,b,ct);return saved;}},tenant,{prompt:input.prompt,images,mask,options:imageOptions(input),...facts,...(hold?{hold}:{}),...(input.volumeId!==undefined?{volume:{id:input.volumeId,path:normalizePath(input.path??'/images')}}:{})},request.signal));
    return json(made);
  }
  if(kind==='transcriptions') {
    audio??=source(input);
    const made=await drain(transcribeRequest({...common,transcriber:new Transcriber({provider:openaiTranscription({outbound:common.outbound,baseUrl}),key:(t,s,p)=>mediaKey(env,t,s,p,services,azure?.transcriptionDeployment),price:()=>prices.transcription})},tenant,{audio,language:languageInput(input.language),prompt:input.prompt,...facts,...(hold?{hold}:{})},request.signal));
    return json(made);
  }
  const tts = speechPrices({AGENT_SPEECH_PRICES:env.AGENT_SPEECH_PRICES});
  const synthesizer=new Synthesizer({provider:openaiSpeech({outbound:common.outbound,baseUrl:env.MEDIA_BASE_URL}),key,price:()=>prices.speech,chain:{provider:reference=>speechProvider(reference,common.outbound),defaultVoice:provider=>DEFAULT_VOICES[provider],price:(reference,made)=>ttsCost(tts,reference,made)}});
  let made: Awaited<ReturnType<typeof speechRequest>>;
  try { made=await speechRequest({...common,synthesizer},tenant,{...speechInput(input,DEFAULT_VOICE),...facts,language:languageInput(input.language),choice:speechChoiceInput(input.speech),...(hold?{hold}:{})},request.signal); }
  catch(error) { await Promise.all(pending); throw error; }
  const reader=made.body.getReader();
  const stream=new ReadableStream<Uint8Array>({async pull(c){try{const next=await reader.read();if(next.done){await Promise.all(pending);c.close();}else c.enqueue(next.value);}catch(e){await Promise.all(pending);c.error(e);}},async cancel(reason){try{await reader.cancel(reason);}finally{await Promise.all(pending);}}});
  return new Response(stream,{headers:{'content-type':made.contentType,'cache-control':'no-store','X-Speech-Model':made.model}});
}

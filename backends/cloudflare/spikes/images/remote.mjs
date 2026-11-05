// Owns exactly one disposable Worker/DO namespace/R2 bucket. No model calls.
// Cloudflare credentials come only from the existing process environment.
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {fixture} from './fixture.mjs';
const cwd=resolve(import.meta.dirname,'../..'), account='85bbd288051330fb51ee1c86031a299b';
const name='camelrun-proto-hybrid-images',base=`https://${name}.miguel-85b.workers.dev`;
const token=process.env.CLOUDFLARE_API_TOKEN;if(!token)throw Error('Configured Cloudflare credential required');
const lock=resolve(import.meta.dirname,'.remote-lock');
await mkdir(lock); // Exclusive local run; never remove another run's state.
const bearer=randomBytes(32).toString('hex'),state=await mkdtemp(resolve(import.meta.dirname,'.state-remote-'));
const report={startedAt:new Date().toISOString(),name,cases:[],events:[],fixture:{},telemetry:[],cleanup:{}};
function safe(value){const text=JSON.stringify(value,null,2);if([token,bearer].some(x=>text.includes(x)))throw Error('Credential output refused');return text;}
async function save(){await writeFile(resolve(cwd,'docs/hybrid-images-cloud.json'),safe(report)+'\n');}
async function api(path,method='GET',body) {
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
 const result=await response.json();if(!response.ok||result.success===false)throw Error(`Cloudflare ${method} ${path}: HTTP ${response.status}: ${safe(result.errors)}`);return result.result??result;
}
async function wrangler(args,input) {
 const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{cwd,env:{...process.env,WRANGLER_LOG_PATH:resolve(state,'logs'),WRANGLER_SEND_METRICS:'false'},stdio:['pipe','pipe','pipe']});let output='';
 child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);child.stdin.end(input);
 const code=await new Promise(r=>child.once('close',r));if(code!==0)throw Error(`Wrangler failed (${code}): ${safe(output.slice(-4000))}`);
 report.events.push({command:args.join(' '),completedAt:new Date().toISOString(),exitCode:code});await save();
}
async function call(path,input) {
 const startedAt=Date.now();try{const response=await fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json'},body:JSON.stringify(input??{}),signal:AbortSignal.timeout(120000)});return {startedAt,endedAt:Date.now(),status:response.status,data:await response.json()};}catch(error){return {startedAt,endedAt:Date.now(),error:error.message};}
}
async function namespaces(){const result=[];for(let page=1;page<=20;page++){const rows=await api(`/workers/durable_objects/namespaces?per_page=1000&page=${page}`);result.push(...rows);if(rows.length<1000)break;}return result;}
async function ownedBucketExists() {
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${name}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
 if(response.status===404)return false;
 if(!response.ok)throw Error(`Owned bucket inventory HTTP ${response.status}`);
 const body=await response.json();return body.result?.name===name;
}
let workerCreated=false,bucketCreated=false,ownershipEstablished=false;
try {
 const workers=await api('/workers/scripts'),ns=await namespaces(),buckets=await api('/r2/buckets');
 report.baseline={workers:workers.filter(x=>x.id.startsWith('camelrun-proto-')).map(x=>x.id),namespaces:ns.filter(x=>x.script?.startsWith('camelrun-proto-')),buckets:buckets.buckets?.filter(x=>x.name.startsWith('camelrun-proto-'))};
 if(workers.some(x=>x.id===name)||ns.some(x=>x.script===name)||await ownedBucketExists())throw Error('Owned resource name already exists; refusing reuse');
 ownershipEstablished=true;
 await api('/r2/buckets','POST',{name});bucketCreated=true;await save();
 await wrangler(['deploy','-c','spikes/images/wrangler.jsonc']);workerCreated=true;
 await wrangler(['secret','put','API_TOKEN','-c','spikes/images/wrangler.jsonc'],bearer+'\n');
 let min=Infinity,max=0,total=0;
 for(let i=0;i<100;i++) {
  const png=fixture(i+1);min=Math.min(min,png.length);max=Math.max(max,png.length);total+=png.length;
  const response=await fetch(`${base}/fixture/${i}`,{method:'PUT',headers:{authorization:`Bearer ${bearer}`},body:png,signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw Error(`fixture ${i}: HTTP ${response.status}`);
  if(i%20===19)console.log(safe({fixtureUploads:i+1}));
 }
 report.fixture={count:100,distinctContents:51,width:1600,height:1200,minBytes:min,maxBytes:max,totalBytes:total};await save();
 for(const mode of ['baseline','inline','reference','cached'])for(const count of mode==='baseline'?[0]:[20,100]) {
  const id=`${mode}-${count}`,row={mode,count,id};report.cases.push(row);
  row.prepare=await call(`/case/${id}/prepare`);
  if(mode!=='baseline')row.seed=await call(`/case/${id}/seed`,{mode,count});
  if(mode==='inline'&&row.seed.data?.error)row.materialized=await call(`/case/${id}/inlineMemory`,{count});
  else if(mode!=='baseline')row.request=await call(`/case/${id}/request`,{mode,count,urlMode:mode==='cached'});
  row.hold=await call(`/case/${id}/hold`,{ms:30000});row.after=await call(`/case/${id}/status`);
  if(mode==='cached')row.reuse=await call(`/case/${id}/request`,{mode,count,urlMode:true});
  await save();console.log(safe({id,seed:row.seed,request:row.request,materialized:row.materialized,hold:row.hold,after:row.after,reuse:row.reuse}));
 }
 const namespace=(await namespaces()).find(x=>x.script===name);report.namespace=namespace;
 // Metrics are delayed. Retain each nonempty read before teardown.
 for(let attempt=0;attempt<8;attempt++) {
  const until=new Date().toISOString();
  const query=`{viewer{accounts(filter:{accountTag:"${account}"}){metrics:durableObjectsPeriodicGroups(limit:1000,filter:{namespaceId:"${namespace.id}",datetime_geq:"${report.startedAt}",datetime_leq:"${until}"}){dimensions{objectId name datetime}sum{activeTime cpuTime duration exceededCpuErrors exceededMemoryErrors}max{memoryUsageBytes}quantiles{memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99}}}}}`;
  const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(60000)});const result=await response.json();
  report.telemetry.push({at:until,status:response.status,errors:result.errors??null,rows:result.data?.viewer?.accounts?.[0]?.metrics??[]});await save();console.log(safe({telemetryAttempt:attempt,rows:report.telemetry.at(-1).rows.length}));
  if(attempt<7)await new Promise(r=>setTimeout(r,45000));
 }
} catch(error) {report.error=String(error);await save();throw error;}
finally {
 if(!ownershipEstablished) {
  report.cleanup={skipped:'Preflight did not establish ownership; no existing resource is mutated.'};
  await save();await rm(state,{recursive:true,force:true});await rm(lock,{recursive:true,force:true});
 } else {
 const cleanupErrors=[];
 const attempt=async(label,run)=>{try{return await run();}catch(error){cleanupErrors.push({label,error:String(error)});return undefined;}};
 // Check actual inventory even if a deployment succeeded remotely but its
 // CLI acknowledgement was lost. Every deletion remains exact-name scoped.
 const foundWorkers=await attempt('inventory before cleanup',()=>api('/workers/scripts'));
 workerCreated ||= foundWorkers?.some(x=>x.id===name)??false;
 bucketCreated ||= await attempt('owned bucket before cleanup',ownedBucketExists)??false;
 if(workerCreated) {
  report.cleanup.objects=await attempt('empty owned bucket',()=>call('/cleanup'));
  const config=JSON.parse(await readFile(resolve(import.meta.dirname,'wrangler.jsonc'),'utf8'));
  config.main=resolve(state,'empty.ts');config.durable_objects={bindings:[]};delete config.r2_buckets;delete config.images;delete config.worker_loaders;
  config.migrations.push({tag:'v2-delete',deleted_classes:[name]});
  await writeFile(config.main,'export default {fetch(){return new Response("deleted",{status:410})}};');
  await writeFile(resolve(state,'delete.json'),JSON.stringify(config));
  await attempt('delete owned DO class',()=>wrangler(['deploy','-c',resolve(state,'delete.json')]));
  await attempt('delete owned Worker',async()=>{await api(`/workers/scripts/${name}`,'DELETE');report.cleanup.workerDeleted=true;});
 }
 if(bucketCreated)await attempt('delete owned bucket',async()=>{await api(`/r2/buckets/${name}`,'DELETE');report.cleanup.bucketDeleted=true;});
 report.cleanup.namespacesRemaining=await attempt('final namespace inventory',async()=>(await namespaces()).filter(x=>x.script===name));
 report.cleanup.workersRemaining=await attempt('final Worker inventory',async()=>(await api('/workers/scripts')).filter(x=>x.id===name).map(x=>x.id));
 report.cleanup.bucketsRemaining=await attempt('final bucket inventory',async()=>(await ownedBucketExists())?[name]:[]);
 report.cleanup.endpointStatus=await attempt('deleted endpoint',async()=>{
  let status;
  for(let i=0;i<15;i++){status=(await fetch(base,{signal:AbortSignal.timeout(10000)})).status;if(status===404)return status;await new Promise(r=>setTimeout(r,1000));}
  throw Error(`Deleted endpoint still returns ${status}`);
 });
 report.cleanup.errors=cleanupErrors;
 report.cleanup.at=new Date().toISOString();await save();await rm(state,{recursive:true,force:true});await rm(lock,{recursive:true,force:true});console.log(safe({cleanup:report.cleanup}));
 if(cleanupErrors.length||report.cleanup.workersRemaining?.length||report.cleanup.namespacesRemaining?.length||report.cleanup.bucketsRemaining?.length)throw Error('Cleanup needs reconciliation; see sanitized report');
 }
}

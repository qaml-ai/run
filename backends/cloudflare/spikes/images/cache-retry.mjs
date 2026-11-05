// Corrected cold/cache-hit cloud cases. Run while remote.mjs still owns the
// original fixture bucket; this script owns only its retry Worker/namespace.
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
const cwd=resolve(import.meta.dirname,'../..'),lock=resolve(import.meta.dirname,'.retry-lock');
const account='85bbd288051330fb51ee1c86031a299b',name='camelrun-proto-hybrid-images-retry';
const base=`https://${name}.miguel-85b.workers.dev`,token=process.env.CLOUDFLARE_API_TOKEN,bearer=randomBytes(32).toString('hex');
if(!token)throw Error('Configured Cloudflare credential required');
await mkdir(lock);
const state=await mkdtemp(resolve(import.meta.dirname,'.state-retry-'));
const config=JSON.parse(await readFile(resolve(import.meta.dirname,'wrangler.jsonc'),'utf8'));
config.name=name;config.main=resolve(import.meta.dirname,'worker.ts');
const configPath=resolve(state,'wrangler.json');await writeFile(configPath,JSON.stringify(config));
const report={startedAt:new Date().toISOString(),name,source:'Corrected bounded derivative buffer and R2.head cache metadata; 100 indexed images / 51 unique contents from the primary run.',cases:[],telemetry:[],cleanup:{}};
const safe=value=>{const text=JSON.stringify(value,null,2);if([token,bearer].some(x=>text.includes(x)))throw Error('Credential guard');return text;};
const save=()=>writeFile(resolve(cwd,'docs/hybrid-images-cache-retry.json'),safe(report)+'\n');
async function api(path,method='GET',body) {
 const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 const b=await r.json();if(!r.ok||b.success===false)throw Error(`Cloudflare ${method} ${path}: ${r.status}`);return b.result??b;
}
async function namespaces(){const rows=[];for(let page=1;page<=20;page++){const r=await api(`/workers/durable_objects/namespaces?per_page=1000&page=${page}`);rows.push(...r);if(r.length<1000)break;}return rows;}
async function wrangler(args,input){
 const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{cwd,env:{...process.env,WRANGLER_LOG_PATH:resolve(state,'logs'),WRANGLER_SEND_METRICS:'false'},stdio:['pipe','pipe','pipe']});let out='';
 child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>out+=x);child.stdin.end(input);const code=await new Promise(r=>child.once('close',r));if(code)throw Error(safe(out.slice(-2500)));
}
async function call(path,input){const began=Date.now();const r=await fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json'},body:JSON.stringify(input??{}),signal:AbortSignal.timeout(90000)});return {began,ended:Date.now(),status:r.status,data:await r.json()};}
let created=false,ownershipEstablished=false;
try {
 if((await api('/workers/scripts')).some(x=>x.id===name)||(await namespaces()).some(x=>x.script===name))throw Error('Retry Worker or namespace already exists');
 const bucket=await api('/r2/buckets/camelrun-proto-hybrid-images');
 if(bucket.name!=='camelrun-proto-hybrid-images')throw Error('Expected fixture bucket missing');
 ownershipEstablished=true;
 await wrangler(['deploy','-c',configPath]);created=true;await wrangler(['secret','put','API_TOKEN','-c',configPath],bearer+'\n');
 for(const count of [20,100]) {
  const id=`fixed-cached-${count}`,row={id,count};report.cases.push(row);await save();
  row.prepareAttempts=[];
  for(let attempt=0;attempt<5;attempt++) {
    row.prepare=await call(`/case/${id}/prepare`);row.prepareAttempts.push(row.prepare);
    if(row.prepare.status!==401)break;
    await new Promise(r=>setTimeout(r,250));
  }
  if(row.prepare.status!==200)throw Error(`prepare HTTP ${row.prepare.status}`);
  row.seed=await call(`/case/${id}/seed`,{mode:'cached',count});await save();
  row.request=await call(`/case/${id}/request`,{mode:'cached',count,urlMode:true});await save();
  row.hold=await call(`/case/${id}/hold`,{ms:30000});row.reuse=await call(`/case/${id}/request`,{mode:'cached',count,urlMode:true});row.after=await call(`/case/${id}/status`);
  await save();console.log(safe(row));
 }
 const ns=(await namespaces()).find(x=>x.script===name);report.namespace=ns;await save();
 for(let i=0;i<5;i++) {
  const until=new Date().toISOString(),query=`{viewer{accounts(filter:{accountTag:"${account}"}){metrics:durableObjectsPeriodicGroups(limit:1000,filter:{namespaceId:"${ns.id}",datetime_geq:"${report.startedAt}",datetime_leq:"${until}"}){dimensions{objectId name datetime}sum{activeTime cpuTime duration exceededCpuErrors exceededMemoryErrors}max{memoryUsageBytes}}}}}`;
  const r=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({query})});const b=await r.json();
  report.telemetry.push({at:until,status:r.status,errors:b.errors??null,rows:b.data?.viewer?.accounts?.[0]?.metrics??[]});await save();console.log(safe({retryTelemetry:i,rows:report.telemetry.at(-1).rows.length}));
  if(i<4)await new Promise(r=>setTimeout(r,45000));
 }
}catch(error){report.error=String(error);await save();throw error;}
finally {
 if(!ownershipEstablished) {
  report.cleanup={skipped:'Preflight did not establish ownership; no existing resource is mutated.'};await save();await rm(state,{recursive:true,force:true});await rm(lock,{recursive:true,force:true});
 } else {
 const errors=[],attempt=async(label,fn)=>{try{return await fn();}catch(error){errors.push({label,error:String(error)});}};
 const workers=await attempt('inventory',()=>api('/workers/scripts'));created||=workers?.some(x=>x.id===name)??false;
 if(created){
  delete config.r2_buckets;delete config.images;delete config.worker_loaders;config.durable_objects={bindings:[]};
  config.main=resolve(state,'empty.ts');config.migrations.push({tag:'v2-delete',deleted_classes:['camelrun-proto-hybrid-images']});
  await writeFile(config.main,'export default {fetch(){return new Response("deleted",{status:410})}}');await writeFile(configPath,JSON.stringify(config));
  await attempt('delete class',()=>wrangler(['deploy','-c',configPath]));await attempt('delete Worker',()=>api(`/workers/scripts/${name}`,'DELETE'));
 }
 report.cleanup.namespacesRemaining=await attempt('namespaces',async()=>(await namespaces()).filter(x=>x.script===name));
 report.cleanup.workersRemaining=await attempt('Workers',async()=>(await api('/workers/scripts')).filter(x=>x.id===name));
 report.cleanup.endpointStatus=await attempt('endpoint',async()=>{
  let status;
  for(let i=0;i<15;i++){status=(await fetch(base,{signal:AbortSignal.timeout(10000)})).status;if(status===404)return status;await new Promise(r=>setTimeout(r,1000));}
  throw Error(`Deleted endpoint still returns ${status}`);
 });report.cleanup.errors=errors;report.cleanup.at=new Date().toISOString();
 await save();await rm(state,{recursive:true,force:true});await rm(lock,{recursive:true,force:true});console.log(safe({cleanup:report.cleanup}));
 if(errors.length||report.cleanup.workersRemaining?.length||report.cleanup.namespacesRemaining?.length)throw Error('Retry cleanup needs reconciliation');
 }
}

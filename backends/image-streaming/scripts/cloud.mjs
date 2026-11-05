// Exact-name disposable resources. Credentials are read only from the process environment.
import { spawn } from 'node:child_process';
import { mkdir,mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fixture,digest } from './fixture.mjs';

const cwd=resolve(import.meta.dirname,'..');
const account=process.env.CLOUDFLARE_ACCOUNT_ID??'85bbd288051330fb51ee1c86031a299b';
const names=['camelrun-proto-image-streaming','camelrun-proto-image-proxy','camelrun-proto-image-provider'];
const name=names[0], domain=process.env.IMAGE_EXPERIMENT_WORKERS_DOMAIN??'miguel-85b.workers.dev';
const base=`https://${name}.${domain}`;
const token=process.env.CLOUDFLARE_API_TOKEN;
if(!token) throw Error('Configured CLOUDFLARE_API_TOKEN required; no credential is saved by this runner');
const smoke=process.argv.includes('--smoke');
const lock=resolve(cwd,'.cloud-lock');
await mkdir(lock); // Refuse concurrent runs on this worktree; cloud preflight catches other hosts.
const state=await mkdtemp(resolve(cwd,'.cloud-state-'));
const bearer=randomBytes(32).toString('hex');
const reportPath=resolve(cwd,'measurements',`cloud-${smoke?'smoke-':''}${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
await mkdir(resolve(cwd,'measurements'),{recursive:true});
const report={startedAt:new Date().toISOString(),smoke,account,resources:names,fixture:{},cases:[],concurrency:[],events:[],telemetry:[],cleanup:{}};
const stop=new AbortController();
const signalHandler=()=>stop.abort(new Error('Experiment interrupted; cleaning disposable resources'));
process.on('SIGINT',signalHandler);process.on('SIGTERM',signalHandler);
let ownsResources=false,telemetryTask,telemetryStop=false,namespace;

function safe(value) {
  let text=JSON.stringify(value,(_key,value)=>typeof value==='string'
    ?value.replace(/([?&](?:signature|token|sig)=)[^&\s"']+/gi,'$1[REDACTED]'):value,2);
  for(const secret of [token,bearer]) text=text.split(secret).join('[REDACTED]');
  return text;
}
let saveQueue=Promise.resolve();
async function save() {
  const snapshot=safe(report)+'\n';
  saveQueue=saveQueue.then(()=>writeFile(reportPath,snapshot));
  await saveQueue;
}
function event(value) { console.log(safe(value)); }
async function delay(ms) {
  if(stop.signal.aborted) throw stop.signal.reason;
  await new Promise((res,rej)=>{
    const timeout=setTimeout(()=>{stop.signal.removeEventListener('abort',abort);res();},ms);
    function abort(){clearTimeout(timeout);rej(stop.signal.reason);}
    stop.signal.addEventListener('abort',abort,{once:true});
  });
}
async function api(path,method='GET',body) {
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`,{
    method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000),
  });
  const result=await response.json();
  if(!response.ok||result.success===false) throw Error(`Cloudflare ${method} ${path}: HTTP ${response.status}: ${safe(result.errors)}`);
  return result.result??result;
}
async function namespaces() {
  const result=[];
  for(let page=1;page<=20;page++) {
    const rows=await api(`/workers/durable_objects/namespaces?per_page=1000&page=${page}`);
    result.push(...rows);if(rows.length<1000)break;
  }
  return result;
}
async function bucketExists() {
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${name}`,{
    headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000),
  });
  if(response.status===404)return false;
  if(!response.ok)throw Error(`Bucket inventory HTTP ${response.status}`);
  const data=await response.json();return data.result?.name===name;
}
async function wrangler(args,input) {
  const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{
    cwd,env:{...process.env,CLOUDFLARE_ACCOUNT_ID:account,WRANGLER_LOG_PATH:resolve(state,'logs'),WRANGLER_SEND_METRICS:'false'},
    stdio:['pipe','pipe','pipe'],
  });
  let output='';
  child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);child.stdin.end(input);
  const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('close',res);});
  report.events.push({command:args.join(' '),at:new Date().toISOString(),exitCode:code,output:output.slice(-8000)});await save();
  if(code!==0)throw Error(`Wrangler failed (${code}): ${safe(output.slice(-4000))}`);
}
async function call(path,input={},options={}) {
  const startedAt=new Date().toISOString(),started=performance.now();
  try {
    const response=await fetch(base+path,{
      method:options.method??'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json'},
      body:options.method==='GET'?undefined:JSON.stringify(input),
      signal:options.ignoreStop?AbortSignal.timeout(options.timeout??180000):AbortSignal.any([stop.signal,AbortSignal.timeout(options.timeout??180000)]),
    });
    const text=await response.text();let data;
    try{data=JSON.parse(text);}catch{data={text:text.slice(0,4000)};}
    return {startedAt,endedAt:new Date().toISOString(),latencyMs:performance.now()-started,status:response.status,data};
  }catch(error){return {startedAt,endedAt:new Date().toISOString(),latencyMs:performance.now()-started,error:String(error)};}
}
async function telemetry(label) {
  const until=new Date().toISOString();
  const query=`{viewer{accounts(filter:{accountTag:"${account}"}){metrics:durableObjectsPeriodicGroups(limit:10000,filter:{namespaceId:"${namespace.id}",datetime_geq:"${report.startedAt}",datetime_leq:"${until}"}){dimensions{objectId name datetime}avg{sampleInterval}sum{activeTime cpuTime duration rowsRead rowsWritten exceededCpuErrors exceededMemoryErrors}max{memoryUsageBytes}quantiles{memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99}}}}}`;
  try {
    const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{
      method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(60000),
    });
    const result=await response.json();
    const row={label,at:until,status:response.status,errors:result.errors??null,rows:result.data?.viewer?.accounts?.[0]?.metrics??[]};
    report.telemetry.push(row);await save();event({telemetry:label,rows:row.rows.length,errors:row.errors});
  }catch(error){report.telemetry.push({label,at:until,error:String(error)});await save();}
}
async function statelessTelemetry() {
  const until=new Date().toISOString();
  report.statelessTelemetry={at:until,queries:[]};
  for(const requestedScript of names) {
    const query=`{viewer{accounts(filter:{accountTag:"${account}"}){workers:workersInvocationsAdaptive(limit:1000,filter:{scriptName:${JSON.stringify(requestedScript)},datetime_geq:"${report.startedAt}",datetime_leq:"${until}"}){dimensions{scriptName usageModel}sum{requests errors subrequests cpuTimeUs duration}quantiles{cpuTimeP50 cpuTimeP95 cpuTimeP99 wallTimeP50 wallTimeP95 wallTimeP99 memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99 wasmMemoryBytesP50 wasmMemoryBytesP95 wasmMemoryBytesP99}}}}}`;
    try{
      const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(60000)});
      const result=await response.json();
      report.statelessTelemetry.queries.push({requestedScript,status:response.status,errors:result.errors??null,rows:result.data?.viewer?.accounts?.[0]?.workers??[]});
    }catch(error){report.statelessTelemetry.queries.push({requestedScript,error:String(error)});}
    await save();
  }
}
async function single(mode,count,apiName='openai-completions') {
  const id=`${mode.toLowerCase()}-${count}-${apiName}`;
  const row={id,mode,count,api:apiName};report.cases.push(row);
  row.seed=await call(`/case/${id}/seed`,{mode,count});await save();
  if(row.seed.status===200&&!row.seed.data?.error) {
    row.request=await call(`/case/${id}/request`,{api:apiName,holdMs:smoke?0:30000});await save();
    row.status=await call(`/case/${id}/status`);
  }
  await save();event({case:id,seedStatus:row.seed.status,requestStatus:row.request?.status,match:row.request?.data?.match,error:row.seed.error??row.seed.data?.error??row.request?.error??row.request?.data?.error});
  return row;
}
async function concurrent(mode,count) {
  const group={mode,count,agents:50,startedAt:new Date().toISOString(),outcomes:[]};report.concurrency.push(group);await save();
  // A seeded inline context can kill its isolate; all 50 are still attempted once.
  group.outcomes=await Promise.all(Array.from({length:50},async(_,index)=>{
    const id=`fan-${mode.toLowerCase()}-${count}-${index}`;
    const seed=await call(`/case/${id}/seed`,{mode,count},{timeout:120000});
    const request=seed.status===200&&!seed.data?.error?await call(`/case/${id}/request`,{api:'openai-completions',holdMs:0},{timeout:180000}):undefined;
    return {id,seed,request};
  }));
  group.endedAt=new Date().toISOString();await save();
  event({concurrency:`${mode}/${count}`,matched:group.outcomes.filter(x=>x.request?.data?.match).length,total:50});
}
async function faults() {
  report.faults=[];
  for(const mode of ['B','C','D'])for(const fault of ['retry','abort','missing']) {
    const id=`fault-${mode.toLowerCase()}-${fault}`,row={mode,fault,id};report.faults.push(row);
    row.seed=await call(`/case/${id}/seed`,{mode,count:smoke?1:20});
    const options={api:'openai-completions',...(fault==='retry'?{failAfter:50000}:fault==='abort'?{abortMs:20}:{missing:true})};
    row.request=await call(`/case/${id}/request`,options);await save();
    if(fault!=='missing')row.recovery=await call(`/case/${id}/request`,{api:'openai-completions'});
    row.status=await call(`/case/${id}/status`);await save();event({fault:`${mode}/${fault}`,status:row.request.status,recovered:row.recovery?.data?.match});
  }
}
async function replay() {
  report.replay=[];
  for(const mode of ['B','C','D']) {
    const id=`replay-${mode.toLowerCase()}`,row={mode,id};report.replay.push(row);
    row.seed=await call(`/case/${id}/seed`,{mode,count:smoke?1:20});
    row.before=await call(`/case/${id}/status`);row.evict=await call(`/case/${id}/evict`);
    row.after=await call(`/case/${id}/status`);row.request=await call(`/case/${id}/request`,{api:'anthropic-messages'});
    row.probe=await call(`/case/${id}/probe`);await save();event({replay:mode,match:row.request?.data?.match});
  }
}

try {
  await save();
  const workers=await api('/workers/scripts'),ns=await namespaces();
  report.baseline={workers:workers.filter(x=>names.includes(x.id)).map(x=>x.id),namespaces:ns.filter(x=>names.includes(x.script))};
  if(report.baseline.workers.length||report.baseline.namespaces.length||await bucketExists())throw Error('An exact experiment resource already exists; refusing adoption or deletion');
  ownsResources=true;
  await api('/r2/buckets','POST',{name});await save();
  for(const config of ['wrangler.provider.jsonc','wrangler.proxy.jsonc','wrangler.jsonc']) {
    await wrangler(['deploy','-c',config]);
    await wrangler(['secret','put','EXPERIMENT_TOKEN','-c',config],bearer+'\n');
  }
  namespace=(await namespaces()).find(x=>x.script===name);if(!namespace)throw Error('Deployed DO namespace missing');report.namespace=namespace;await save();
  telemetryTask=(async()=>{let index=0;while(!telemetryStop){await telemetry(`during-${index++}`);for(let part=0;part<9&&!telemetryStop;part++)await delay(5000);}})();
  void telemetryTask.catch(()=>{}); // SIGINT still reaches finally without an unhandled rejection.
  let min=Infinity,max=0,total=0;const hashes=new Set(),fixtures=[];
  for(let index=0;index<(smoke?1:100);index++) {
    if(stop.signal.aborted)throw stop.signal.reason;
    const bytes=fixture(index);const sha256=digest(bytes);hashes.add(sha256);min=Math.min(min,bytes.length);max=Math.max(max,bytes.length);total+=bytes.length;
    let response,data;
    for(let attempt=0;attempt<5;attempt++) {
      const started=performance.now();
      response=await fetch(`${base}/fixture/${index}`,{method:'PUT',headers:{authorization:`Bearer ${bearer}`},body:bytes,signal:AbortSignal.any([stop.signal,AbortSignal.timeout(60000)])});
      const text=await response.text();
      try{data=JSON.parse(text);}catch{data={text:text.slice(0,1000)};}
      report.fixtureAttempts??=[];
      report.fixtureAttempts.push({index,attempt,at:new Date().toISOString(),status:response.status,latencyMs:performance.now()-started,
        ...(response.ok?{}:{response:data})});await save();
      if(![401,404,429,502,503,504,520,522,524].includes(response.status))break;
      if(attempt<4)await delay(2000);
    }
    if(!response.ok)throw Error(`fixture ${index}: HTTP ${response.status}: ${safe(data)}`);
    fixtures.push({index,originalBytes:bytes.length,originalSha256:sha256,...data});
    if(index%10===9)event({fixtureUploads:index+1});
  }
  report.fixture={count:fixtures.length,distinctContents:hashes.size,width:1600,height:1200,minBytes:min,maxBytes:max,totalBytes:total,images:fixtures};await save();
  if(hashes.size!==fixtures.length)throw Error('Fixture corpus is not distinct');
  if(fixtures.some(x=>x.ref&&x.ref.size<2*1024*1024))throw Error('Derivative below required 2 MiB; adjust fixture before measuring');
  report.manifest=await call('/manifest',{}, {method:'GET'});await save();
  if(report.manifest.status!==200||report.manifest.data?.refs?.length!==fixtures.length)throw Error('Corpus manifest did not match uploads');
  if(!smoke) {report.workersAiVision=await call('/vision',{}, {timeout:120000});await save();}
  for(const mode of ['A','B','C','D'])for(const count of smoke?[1]:[1,20,100])await single(mode,count);
  for(const mode of ['A','B','C','D'])for(const apiName of ['openai-responses','anthropic-messages'])await single(mode,1,apiName);
  await faults();await replay();
  if(!smoke) {
    for(const mode of ['A','B','C','D'])for(const count of [1,20,100])await concurrent(mode,count);
  }
  report.finishedMeasurementsAt=new Date().toISOString();await save();
  telemetryStop=true;await telemetryTask;telemetryTask=undefined;
  for(let attempt=0;attempt<(smoke?1:8);attempt++) {
    await telemetry(`final-${attempt}`);
    if(attempt<(smoke?0:7))await delay(45000);
  }
  await statelessTelemetry();
}catch(error){report.error=String(error);await save();event({error:report.error});}
finally {
  telemetryStop=true;
  if(telemetryTask)await telemetryTask.catch(()=>{});
  const errors=[];
  const attempt=async(label,run)=>{try{return await run();}catch(error){errors.push({label,error:String(error)});return undefined;}};
  if(ownsResources) {
    const workers=await attempt('inventory before cleanup',()=>api('/workers/scripts'));
    if(workers?.some(x=>x.id===name))report.cleanup.objects=await attempt('empty bucket',async()=>{
      const result=await call('/cleanup',{}, {method:'GET',ignoreStop:true});
      if(result.status!==200)throw Error(`Bucket cleanup failed: ${safe(result)}`);
      return result;
    });
    const existingNamespaces=await attempt('namespaces before cleanup',namespaces);
    const matchingNamespaces=existingNamespaces?.filter(x=>x.script===name)??[];
    const sourceConfig=JSON.parse(await readFile(resolve(cwd,'wrangler.jsonc'),'utf8'));
    const classes=matchingNamespaces.length?[...new Set(matchingNamespaces.map(x=>x.class??x.class_name).filter(Boolean)
      .concat(sourceConfig.migrations.flatMap(x=>x.new_sqlite_classes??[])))]:[];
    if(classes.length)await attempt('delete DO classes',async()=>{
      const config=sourceConfig;
      config.main=resolve(state,'empty.ts');config.durable_objects={bindings:[]};
      for(const key of ['r2_buckets','images','ai','services','worker_loaders'])delete config[key];
      config.migrations.push({tag:'experiment-cleanup',deleted_classes:classes});
      await writeFile(config.main,'export default {fetch(){return new Response("deleted",{status:410})}};');
      await writeFile(resolve(state,'delete.json'),JSON.stringify(config));
      await wrangler(['deploy','-c',resolve(state,'delete.json')]);
    });
    for(const resource of names)if(workers?.some(x=>x.id===resource))await attempt(`delete ${resource}`,()=>api(`/workers/scripts/${resource}`,'DELETE'));
    if(await attempt('bucket inventory',bucketExists))await attempt('delete bucket',()=>api(`/r2/buckets/${name}`,'DELETE'));
    report.cleanup.namespacesRemaining=await attempt('final namespace inventory',async()=>(await namespaces()).filter(x=>names.includes(x.script)));
    report.cleanup.workersRemaining=await attempt('final Worker inventory',async()=>(await api('/workers/scripts')).filter(x=>names.includes(x.id)).map(x=>x.id));
    report.cleanup.bucketsRemaining=await attempt('final bucket inventory',async()=>(await bucketExists())?[name]:[]);
    report.cleanup.endpointStatuses=await Promise.all(names.map(async resource=>{
      let status;for(let i=0;i<15;i++) {
        try{status=(await fetch(`https://${resource}.${domain}`,{signal:AbortSignal.timeout(10000)})).status;}catch(error){return {name:resource,error:String(error)};}
        if(status===404)break;await new Promise(res=>setTimeout(res,1000));
      }return {name:resource,status};
    }));
  }else report.cleanup.skipped='Preflight did not establish ownership; no existing resource mutated';
  report.cleanup.errors=errors;report.cleanup.at=new Date().toISOString();await save();
  await rm(state,{recursive:true,force:true});await rm(lock,{recursive:true,force:true});
  process.removeListener('SIGINT',signalHandler);process.removeListener('SIGTERM',signalHandler);
  event({report:reportPath,cleanup:report.cleanup});
  if(report.error||errors.length||report.cleanup.namespacesRemaining?.length||report.cleanup.workersRemaining?.length||report.cleanup.bucketsRemaining?.length)process.exitCode=1;
}

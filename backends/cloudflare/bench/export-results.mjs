// Publish selected evidence only. Never copy credentials, logs or deployment state.
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const manifest=[];
async function read(name,optional=false) {
  try {
    const bytes=await readFile(new URL(`./.state/${name}.json`,import.meta.url));
    manifest.push({file:`${name}.json`,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    return JSON.parse(bytes);
  } catch(error) {if(optional && error.code==='ENOENT') return null; throw error;}
}
function trial(x) {
  const result=x.data?.result;
  return {httpStatus:x.httpStatus,httpMs:x.httpMs,
    case:x.data?.case,wallMs:x.data?.wallMs,firstToolAtMs:x.data?.firstToolAtMs,
    callbacks:x.data?.callbacks,result:result && {ok:result.ok,value:result.value,error:result.error,callCount:result.calls?.length}};
}
function codemode(data) {
  return {generatedAt:data.generatedAt,samples:data.samples,concurrency:data.concurrency,
    measurements:data.measurements,authentication:data.authentication,limits:data.limits,interpretation:data.interpretation,
    trials:Object.fromEntries(['cold','warm','nested'].map(key=>[key,data.raw[key].map(trial)])),
    batches:data.raw.batches.map(({rows,...batch})=>({...batch,rows:rows.map(trial)})),
    safety:data.raw.safety.map(x=>({case:x.case,...trial(x.result),
      callerBefore:x.before.data.instanceId,callerAfter:x.after.data.instanceId,
      failedAsExpected:x.failedAsExpected,recovered:x.recovered,probeMs:x.activeProbeMs}))};
}
const fifty=await read('codemode-fifty-refresh');
fifty.rows=fifty.rows.map(trial);
const telemetry=await read('telemetry-final');
delete telemetry.schema;
delete telemetry.datasetSettings;
telemetry.results=telemetry.results.filter(x=>x.kind!=='durable-object-periodic-by-object')
  .map(({query,...result})=>result);
const agents=await read('agent-measure');
const {diagnosticsAfter,...concurrency}=agents.deterministic;
const report={schema:1,generatedAt:new Date().toISOString(),date:'2026-11-04',
  versions:{wrangler:'4.157.0',agents:'0.33.0',pi:'1.5.0',sandbox:'1.0.3'},
  agent:{at:agents.at,auth:agents.auth,real:agents.real,concurrency,
    followup:await read('agent-followup'),recovery:await read('replay-result'),safety:await read('agent-safety',true)},
  codemode:{initial:codemode(await read('codemode-live')),recheck:codemode(await read('codemode-refresh')),
    nested50:fifty},
  computers:{initial:await read('computers-live'),lite:await read('computers-resumed-lite'),
    idle:await read('computers-idle-lite'),basic:await read('computers-idle-basic',true),cleanup:await read('computer-cleanup')},
  telemetry,costTelemetry:await read('cost-telemetry-final'),
  cost:await read('cost-estimate'),cleanup:await read('final-cleanup',true),manifest};
for(const value of Object.values(report.cost.sources)) {
  if(typeof value==='string') Object.entries(report.cost.sources).forEach(([k,v])=>{
    if(v===value) report.cost.sources[k]=value.split('/').at(-1);
  });
}
const serialized=JSON.stringify(report,null,2)+'\n';
const bearer=(await readFile(new URL('./.state/api-token',import.meta.url),'utf8').catch(error=>{
  if(error.code==='ENOENT') return ''; throw error;
})).trim();
if([bearer,process.env.CLOUDFLARE_API_TOKEN].filter(Boolean).some(secret=>serialized.includes(secret))) throw new Error('Refusing to publish credentials');
await writeFile(new URL('../docs/cloudflare-measurements-2026-11-04.json',import.meta.url),serialized);
console.log(JSON.stringify({output:'docs/cloudflare-measurements-2026-11-04.json',bytes:serialized.length,inputs:manifest.length}));

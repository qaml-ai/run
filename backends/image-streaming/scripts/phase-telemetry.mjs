// Read-only phase-scoped Worker telemetry. This never changes deployed resources.
import { readFile,writeFile } from 'node:fs/promises';
import { resolve,dirname,basename } from 'node:path';

const reportFile=process.argv[2];
if(!reportFile)throw Error('Usage: node scripts/phase-telemetry.mjs REPORT.json [--include-provider]');
const token=process.env.CLOUDFLARE_API_TOKEN;
if(!token)throw Error('Configured CLOUDFLARE_API_TOKEN is required');
const report=JSON.parse(await readFile(resolve(reportFile),'utf8'));
if(!report.finishedMeasurementsAt&&!report.cleanup?.at)throw Error('Wait for the measurement matrix to finish before querying phase telemetry');
const account=report.account??process.env.CLOUDFLARE_ACCOUNT_ID;
if(!/^[a-f0-9]{32}$/i.test(account??''))throw Error('Report must identify a valid Cloudflare account');
const names=['camelrun-proto-image-streaming','camelrun-proto-image-proxy'];
if(process.argv.includes('--include-provider'))names.push('camelrun-proto-image-provider');
const output=resolve(dirname(resolve(reportFile)),'phase-telemetry.json');
const phases=[];
for(const row of report.cases??[]) {
  if(row.request?.startedAt&&row.request?.endedAt)phases.push({kind:'single',id:row.id,mode:row.mode,count:row.count,api:row.api,
    start:row.request.startedAt,end:row.request.endedAt,match:row.request.data?.match??null,
    requestResult:row.request.status??null});
}
for(const group of report.concurrency??[]) {
  if(group.startedAt&&group.endedAt)phases.push({kind:'concurrent',id:`concurrent-${group.mode}-${group.count}`,
    mode:group.mode,count:group.count,agents:group.agents,start:group.startedAt,end:group.endedAt,
    matches:group.outcomes.filter(row=>row.request?.data?.match===true).length,attemptedAgents:group.outcomes.length});
}
const skipped=(report.cases??[]).filter(row=>!row.request?.startedAt||!row.request?.endedAt)
  .map(row=>({kind:'single',id:row.id,mode:row.mode,count:row.count,reason:'No completed provider request window; seed may have failed'}));
const startedAt=new Date().toISOString();
const result={source:basename(reportFile),generatedAt:startedAt,account,phases,skipped,queries:[],
  units:{cpuTimeUs:'microseconds',cpuTimeP50:'microseconds',cpuTimeP95:'microseconds',cpuTimeP99:'microseconds',wallTime:'microseconds',memoryUsageBytes:'bytes for a whole Worker isolate'},
  limitations:[
    'Each query is scoped by an explicit scriptName and exact phase window. The returned scriptName may still be __unknown__; requestedScript records the filter used.',
    'Single-request windows include client transit and the telemetry hold, but exclude seed. Concurrent windows include seed and requests for all 50 agents.',
    'Adaptive data may be sampled, delayed, absent or zero-valued. Missing rows and fields remain null; query errors are retained.',
    'Memory values are invocation-distribution quantiles over whole isolates, not peak resident memory or per-agent allocation.',
    'The largest returned P99 across rows is not a recomputed global P99. CPU sums are retained separately from those quantiles.',
    'Main Worker scope includes API dispatch and D signed-image serving. Proxy Worker scope isolates C transport. Neither scope replaces Durable Object telemetry.',
    'Provider scope is optional and measures the synthetic decoder overhead, not a production transport requirement.',
    'Boundary timestamps are inclusive. Adjacent phase windows and overlapping scripts must not be blindly summed into a billing total.',
  ]};
function safe(value) {
  const text=JSON.stringify(value,null,2);
  if(text.includes(token))throw Error('Refusing to persist a credential');
  return text;
}
let writeQueue=Promise.resolve();
async function save() {
  const text=safe(result)+'\n';
  writeQueue=writeQueue.then(()=>writeFile(output,text));
  await writeQueue;
}
function summarize(rows) {
  const sums={};
  for(const key of ['requests','errors','subrequests','cpuTimeUs','duration']) {
    const values=rows.map(row=>row.sum?.[key]).filter(Number.isFinite);
    sums[key]=values.length?values.reduce((sum,value)=>sum+value,0):null;
  }
  const maxQuantile=key=>{
    const values=rows.map(row=>row.quantiles?.[key]).filter(value=>Number.isFinite(value)&&value>0);
    return values.length?Math.max(...values):null;
  };
  return {available:rows.length>0,rowCount:rows.length,...sums,
    cpuMs:sums.cpuTimeUs===null?null:sums.cpuTimeUs/1000,
    largestRowMemoryP50Bytes:maxQuantile('memoryUsageBytesP50'),
    largestRowMemoryP95Bytes:maxQuantile('memoryUsageBytesP95'),
    largestRowMemoryP99Bytes:maxQuantile('memoryUsageBytesP99'),
    largestRowCpuP50Us:maxQuantile('cpuTimeP50'),largestRowCpuP95Us:maxQuantile('cpuTimeP95'),largestRowCpuP99Us:maxQuantile('cpuTimeP99'),
    returnedScriptNames:[...new Set(rows.map(row=>row.dimensions?.scriptName).filter(Boolean))]};
}
const requests=phases.flatMap(phase=>names.map(requestedScript=>({phase,requestedScript})));
let cursor=0;
await save();
await Promise.all(Array.from({length:2},async()=>{
  while(cursor<requests.length) {
    const {phase,requestedScript}=requests[cursor++];
    const start=new Date(phase.start).toISOString(),end=new Date(phase.end).toISOString();
    const query=`{viewer{accounts(filter:{accountTag:${JSON.stringify(account)}}){workers:workersInvocationsAdaptive(limit:1000,filter:{scriptName:${JSON.stringify(requestedScript)},datetime_geq:${JSON.stringify(start)},datetime_leq:${JSON.stringify(end)}}){dimensions{scriptName usageModel}sum{requests errors subrequests cpuTimeUs duration}quantiles{cpuTimeP50 cpuTimeP95 cpuTimeP99 wallTimeP50 wallTimeP95 wallTimeP99 memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99 wasmMemoryBytesP50 wasmMemoryBytesP95 wasmMemoryBytesP99}}}}}`;
    const observation={phaseId:phase.id,kind:phase.kind,mode:phase.mode,count:phase.count,requestedScript,start,end,queriedAt:new Date().toISOString()};
    try {
      const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{
        method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(30000),
      });
      const body=await response.json();
      observation.status=response.status;
      observation.errors=body.errors??null;
      observation.rows=body.data?.viewer?.accounts?.[0]?.workers??[];
      observation.summary=summarize(observation.rows);
    }catch(error) {
      observation.error=String(error);
      observation.rows=[];observation.summary=summarize([]);
    }
    result.queries.push(observation);await save();
    console.log(JSON.stringify({phase:phase.id,requestedScript,status:observation.status??null,rows:observation.rows.length,error:observation.error??observation.errors??null}));
  }
}));
result.completedAt=new Date().toISOString();await save();
console.log(JSON.stringify({output,phases:phases.length,queries:result.queries.length,nonempty:result.queries.filter(row=>row.rows.length).length,
  failures:result.queries.filter(row=>row.error||row.errors?.length||row.status!==200).length}));

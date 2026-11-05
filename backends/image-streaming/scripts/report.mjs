// Read-only reduction of retained cloud evidence. It never fills missing telemetry with zero.
import { readFile,readdir,writeFile } from 'node:fs/promises';
import { resolve,basename } from 'node:path';
import { gunzipSync } from 'node:zlib';

const cwd=resolve(import.meta.dirname,'..');
let files=process.argv.slice(2);
if(!files.length) {
  const candidates=(await readdir(resolve(cwd,'measurements'))).filter(name=>/^cloud-.*\.json(?:\.gz)?$/.test(name)).sort();
  const complete=candidates.filter(name=>!name.startsWith('cloud-smoke-'));
  files=[resolve(cwd,'measurements',(complete.length?complete:candidates).at(-1)??'missing-cloud-report.json')];
}
const median=values=>quantile(values,0.5);
function quantile(values,q) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length)return null;
  return sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*q))];
}
function numberOrNull(value) { return Number.isFinite(value)?value:null; }
function metrics(rows) {
  if(!rows.length)return {available:false,rows:0,memoryMaxMiB:null,cpuMs:null,durationGBSeconds:null,memoryErrorObservations:null,cpuErrorObservations:null};
  const memories=rows.map(row=>row.max?.memoryUsageBytes).filter(value=>Number.isFinite(value)&&value>0);
  const sum=key=>{
    const values=rows.map(row=>row.sum?.[key]).filter(Number.isFinite);
    return values.length?values.reduce((value,next)=>value+next,0):null;
  };
  const cpu=sum('cpuTime');
  return {available:true,rows:rows.length,memoryMaxMiB:memories.length?Math.max(...memories)/2**20:null,
    cpuMs:cpu===null?null:cpu/1000,durationGBSeconds:sum('duration'),
    memoryErrorObservations:sum('exceededMemoryErrors'),cpuErrorObservations:sum('exceededCpuErrors'),
    rowsRead:sum('rowsRead'),rowsWritten:sum('rowsWritten'),
    sampleIntervals:[...new Set(rows.map(row=>row.avg?.sampleInterval).filter(Number.isFinite))]};
}
function deduplicateTelemetry(report) {
  const unique=new Map();
  for(const poll of report.telemetry??[])for(const row of poll.rows??[]) {
    const dim=row.dimensions??{};
    // Each poll queries the same cumulative window. Latest row per object/minute wins.
    unique.set(JSON.stringify([dim.objectId,dim.name,dim.datetime]),row);
  }
  return [...unique.values()];
}
function single(row,allRows) {
  const ids=[row.seed?.data?.objectId,row.request?.data?.objectId,row.status?.data?.objectId].filter(Boolean);
  const matching=allRows.filter(metric=>ids.includes(metric.dimensions?.objectId)||metric.dimensions?.name===row.id);
  const firstConstructor=row.seed?.data?.constructorId,lastConstructor=row.status?.data?.constructorId??row.request?.data?.constructorId;
  return {id:row.id,mode:row.mode,count:row.count,api:row.api,seedStatus:row.seed?.status??null,
    seedSuccess:row.seed?.status===200&&!row.seed?.data?.error,
    match:row.request?.data?.match??null,imagesReceived:row.request?.data?.summary?.imageCount??null,
    serverLatencyMs:numberOrNull(row.request?.data?.elapsedMs),clientLatencyMs:numberOrNull(row.request?.latencyMs),
    calls:row.request?.data?.calls??null,databaseBytes:row.seed?.data?.databaseBytes??null,
    constructorChanged:firstConstructor&&lastConstructor?firstConstructor!==lastConstructor:null,
    error:row.seed?.error??row.seed?.data?.error??row.request?.error??row.request?.data?.error??null,
    telemetry:metrics(matching)};
}
const runs=[];
for(const file of files) {
  const bytes=await readFile(resolve(file));
  const report=JSON.parse((file.endsWith('.gz')?gunzipSync(bytes):bytes).toString('utf8'));
  const rows=deduplicateTelemetry(report);
  const cases=(report.cases??[]).map(row=>single(row,rows));
  const groups=(report.concurrency??[]).map(group=>{
    const objects=group.outcomes.map(row=>single({...row,mode:group.mode,count:group.count},rows));
    const successful=objects.filter(row=>row.match===true);
    const ids=group.outcomes.flatMap(row=>[row.seed?.data?.objectId,row.request?.data?.objectId]).filter(Boolean);
    const names=group.outcomes.map(row=>row.id);
    const matching=rows.filter(row=>ids.includes(row.dimensions?.objectId)||names.includes(row.dimensions?.name));
    return {mode:group.mode,count:group.count,agents:group.agents,
      attemptedAgents:objects.length,requestAttempts:group.outcomes.filter(row=>row.request).length,
      seedSuccesses:objects.filter(row=>row.seedSuccess).length,matches:successful.length,
      serverLatencySamples:objects.filter(row=>Number.isFinite(row.serverLatencyMs)).length,
      successfulServerLatencySamples:successful.filter(row=>Number.isFinite(row.serverLatencyMs)).length,
      serverLatencyMsP50:median(objects.map(row=>row.serverLatencyMs)),serverLatencyMsP95:quantile(objects.map(row=>row.serverLatencyMs),0.95),
      successfulServerLatencyMsP50:median(successful.map(row=>row.serverLatencyMs)),successfulServerLatencyMsP95:quantile(successful.map(row=>row.serverLatencyMs),0.95),
      clientLatencyMsP50:median(objects.map(row=>row.clientLatencyMs)),clientLatencyMsP95:quantile(objects.map(row=>row.clientLatencyMs),0.95),
      groupWallMs:group.endedAt&&group.startedAt?Date.parse(group.endedAt)-Date.parse(group.startedAt):null,
      telemetry:metrics(matching),objects};
  });
  runs.push({source:basename(file),startedAt:report.startedAt,smoke:report.smoke,
    fixture:{count:report.fixture?.count,distinctContents:report.fixture?.distinctContents,
      derivativeMinBytes:Math.min(...(report.fixture?.images??[]).map(row=>row.ref?.size).filter(Number.isFinite)),
      derivativeMaxBytes:Math.max(...(report.fixture?.images??[]).map(row=>row.ref?.size).filter(Number.isFinite))},
    cases,concurrency:groups,faults:report.faults??[],replay:report.replay??[],vision:report.workersAiVision??null,
    telemetry:{polls:report.telemetry?.length??0,emptyPolls:report.telemetry?.filter(p=>!p.rows?.length).length??0,
      errors:report.telemetry?.filter(p=>p.error||p.errors).map(p=>({label:p.label,error:p.error??p.errors}))??[],
      uniqueRows:rows.length,aggregate:metrics(rows),stateless:report.statelessTelemetry??null},
    cleanup:report.cleanup,error:report.error??null});
}
const sourceFiles=(await readdir(resolve(cwd,'src'))).filter(name=>name.endsWith('.ts'));
const codeSize=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>{
  const source=await readFile(resolve(cwd,'src',file),'utf8');
  return [file,{physicalLines:source.trimEnd().split('\n').length,bytes:Buffer.byteLength(source)}];
})));
const summary={generatedAt:new Date().toISOString(),units:{memory:'MiB (2^20 bytes)',cpu:'milliseconds from Cloudflare microseconds',duration:'GB*s'},
  limitations:[
    'Memory is a periodic whole-isolate sample; co-located objects share it. It is neither per-agent allocation nor a proven peak.',
    'Rows repeated by later polls are deduplicated by objectId/name/datetime, taking the latest observation.',
    'Counter sums are telemetry observations, not necessarily unique user-visible errors.',
    'Missing telemetry and missing latency are null, never zero. A success response does not establish a peak-memory bound.',
    'CPU and memory rows include seed, request, hold and status work for each named object.',
    'Worker and DO metrics overlap; do not sum both datasets as a bill. Latencies include all attempted requests only where a value exists.',
  ],codeSize,runs};
const output=resolve(cwd,'measurements','comparison.json');
await writeFile(output,JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({output,runs:runs.map(run=>({source:run.source,cases:run.cases,concurrency:run.concurrency.map(({objects,...row})=>row),telemetry:run.telemetry,cleanup:run.cleanup,error:run.error})),codeSize},null,2));

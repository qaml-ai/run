import {readFile,writeFile} from 'node:fs/promises';
const state=new URL('./.state/',import.meta.url);
const read=async name=>JSON.parse(await readFile(new URL(name,state),'utf8'));
const toolResults=text=>{try{return JSON.parse(text).map(result=>({isError:result.isError,content:result.content,calls:result.details?.calls?.length,callNames:result.details?.calls?.reduce((n,call)=>{n[call.name??call.tool??'unknown']=(n[call.name??call.tool??'unknown']??0)+1;return n;},{})}));}catch{return text;}};
const cleanRow=row=>({httpStatus:row.status,httpMs:row.httpMs??row.ms,error:row.error,
 ...(row.data?{instance:row.data.instance,startedAt:row.data.startedAt??row.data.began,endedAt:row.data.endedAt,
 wallMs:row.data.wallMs,callbackTimesMs:row.data.callbacks,ok:row.data.result?.ok,
 result:row.data.result?.ok?row.data.result.value:row.data.result?.error,remoteKey:row.data.remoteKey,barrier:row.data.barrier,
 ...(row.data.text?{toolResults:toolResults(row.data.text),status:row.data.status}:{}),...(row.data.error?{error:row.data.error}:{})}:{}),
});
const report={schemaVersion:1,at:new Date().toISOString(),
 versions:{pi:'1.5.0',wrangler:'4.157.0'},resources:{workers:['camelrun-proto-r2-codemode','camelrun-proto-r2-sandbox','camelrun-proto-r2-heap'],classes:['camelrun-proto-r2-caller','camelrun-proto-r2-barrier','camelrun-proto-r2-sandbox','camelrun-proto-r2-heap']},
 interpretation:[
  'The direct caller is a surrogate for an agent, not PiHarness. Full PiHarness measurements are separate.',
  'Ordinary fan-out batches launch every HTTP request concurrently; their server intervals need not overlap at exactly the requested fan-out.',
  'The first-callback barrier requires every remote VM to have started before any proceeds. Successful 200-way barrier batches prove 200 simultaneous VMs.',
  'A missing participant causes a strict barrier to time out all remaining participants; preserve the original failed row to distinguish this from VM capacity.',
  'Heap allocation probes hold actual PiHarness/CamelAgent state and a context with alternating 1 KiB user/assistant messages. Remote QuickJS memory stays in a separate Worker.',
  'A new constructor after increasing retained JS arrays indicates isolate replacement, not an exception. Added-array thresholds measure incremental headroom; subtracting them from the cap is not an accurate absolute footprint.',
  'Server Date.now/performance.now can stay frozen during CPU work; client elapsed timings are retained for pure initialization/load probes.',
 ],batches:[],heap:await read('round2-heap.json'),heapCohort:await read('round2-heap-cohort.json'),heapMetrics:await read('round2-heap-metrics.json'),vmFootprint:await read('round2-vm-footprint.json')};
const telemetry=await read('round2-telemetry-storage.json');
report.telemetryEvidence={generatedAt:telemetry.generatedAt,
 sharedOneCallback:telemetry.results.filter(r=>r.kind==='durable-object-periodic-by-object').flatMap(r=>r.rows).filter(r=>r.dimensions.name==='r2-1793823851757-50-shared-one-callback'),
 heapCohort:telemetry.results.filter(r=>r.kind==='durable-object-periodic-by-object'&&r.namespace.class==='camelrun-proto-r2-heap').flatMap(r=>r.rows).filter(r=>r.dimensions.name.startsWith('cohort-'))};
for(const [name,file]of Object.entries({diagnostic:'round2-codemode-diagnostic.json',causal:'round2-codemode-causal.json',fanout:'round2-codemode-load.json',isolated:'round2-codemode-isolated.json',barrierFirst:'round2-codemode-barrier-first.json',barrierRepeat:'round2-codemode-barrier.json',fullAgents:'round2-full-agent-codemode.json'})) {
 const run=await read(file);report.batches.push({name,at:run.at,run:run.run??run.stamp,results:run.results.map(r=>({summary:r.summary,rows:r.rows.map(cleanRow),sandbox:r.sandbox}))});
}
const serialized=JSON.stringify(report,null,2)+'\n';
const bearer=(await readFile(new URL('api-token',state),'utf8')).trim();
if([bearer,process.env.CLOUDFLARE_API_TOKEN].filter(Boolean).some(v=>serialized.includes(v)))throw Error('Refusing credentials');
await writeFile(new URL('../docs/round2-codemode.json',import.meta.url),serialized);
console.log(JSON.stringify({output:'backends/cloudflare/docs/round2-codemode.json',bytes:serialized.length,batches:report.batches.length}));

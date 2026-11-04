// Read-only matched-object periodic memory for the 30-second loaded contexts.
import{readFile,writeFile}from'node:fs/promises';
const run=JSON.parse(await readFile(new URL('./.state/round2-heap-metrics.json',import.meta.url),'utf8'));
const token=process.env.CLOUDFLARE_API_TOKEN;if(!token)throw Error('Configured token required');
const names=run.rows.map(r=>r.id);if(names.some(n=>!/^metrics-[0-9]+-(0|1000|10000|50000)$/.test(n)))throw Error('Unexpected benchmark name');
const previous=await readFile(new URL('./.state/round2-heap-metrics-telemetry.json',import.meta.url),'utf8').then(JSON.parse).catch(()=>null);
const objectIds=[...new Set((previous?.rows??[]).filter(r=>names.includes(r.dimensions.name)).map(r=>r.dimensions.objectId))];
if(objectIds.some(id=>!/^[a-f0-9]{64}$/.test(id)))throw Error('Invalid recorded object ID');
const since=new Date(Math.floor(Math.min(...run.rows.map(r=>r.held.startedAt))/60000)*60000).toISOString();
const until=new Date(Math.ceil(Math.max(...run.rows.map(r=>r.after.endedAt))/60000)*60000).toISOString();
// Name lookup can disappear after deleting the namespace. Previously observed
// object IDs keep the historical query attributable without recreating it.
const selector=objectIds.length?`objectId_in:${JSON.stringify(objectIds)}`:`name_in:${JSON.stringify(names)}`;
const filter=`namespaceId:"3f005931572f49b98689457c9e990988",${selector},datetime_geq:${JSON.stringify(since)},datetime_leq:${JSON.stringify(until)}`;
const query=`{viewer{accounts(filter:{accountTag:"85bbd288051330fb51ee1c86031a299b"}){metrics:durableObjectsPeriodicGroups(limit:1000,filter:{${filter}}){dimensions{namespaceId objectId name datetime}avg{sampleInterval}sum{activeTime cpuTime duration exceededCpuErrors exceededMemoryErrors}max{memoryUsageBytes}quantiles{memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99}}}}}`;
const r=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(30000)});const b=await r.json();
const report={at:new Date().toISOString(),since,until,query,status:r.status,errors:b.errors??null,rows:b.data?.viewer?.accounts?.[0]?.metrics??[],contexts:run.rows.map(r=>({id:r.id,n:r.n,loadedAt:r.held.data?.loaded.at,heldUntil:r.held.data?.after.at,after:r.after.data}))};
const text=JSON.stringify(report,null,2);if(text.includes(token))throw Error('Credential guard');
if(!report.rows.length&&previous?.rows?.length)throw Error('Empty refresh; retaining previous matched memory samples');
await writeFile(new URL('./.state/round2-heap-metrics-telemetry.json',import.meta.url),text+'\n');console.log(text);

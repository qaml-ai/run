// Read-only analytics for this round. The credential is never serialized.
import {readFile,writeFile} from 'node:fs/promises';
const account='85bbd288051330fb51ee1c86031a299b',prefix='camelrun-proto-';
const token=process.env.CLOUDFLARE_API_TOKEN;if(!token)throw new Error('Missing configured token');
const headers={authorization:'Bearer '+token,'content-type':'application/json'};
const since=process.env.BENCH_SINCE??'2026-11-04T20:20:45Z',until=new Date().toISOString();
const out=process.argv[2]??'bench/.state/round2-usage.json';
async function api(path){const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`,{headers,signal:AbortSignal.timeout(30000)});const b=await r.json();if(!r.ok||!b.success)throw new Error(`Inventory HTTP ${r.status}`);return b.result;}
async function query(body){const r=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers,body:JSON.stringify({query:body}),signal:AbortSignal.timeout(30000)});const b=await r.json();return {httpStatus:r.status,errors:b.errors??null,rows:b.data?.viewer?.accounts?.[0]?.metrics??[]};}
// Retain known IDs for delayed analytics after the disposable resources are gone.
const inventory=process.env.BENCH_INVENTORY?JSON.parse(await readFile(process.env.BENCH_INVENTORY,'utf8')):null;
const appsRaw=inventory?null:await api('/containers/applications'),bucketsRaw=inventory?null:await api('/r2/buckets');
const apps=inventory?.apps??(Array.isArray(appsRaw)?appsRaw:appsRaw.applications??[]).filter(x=>x.name.startsWith(prefix)).map(x=>({id:x.id,name:x.name}));
const buckets=inventory?.buckets??(bucketsRaw.buckets??[]).filter(x=>x.name.startsWith(prefix)).map(x=>x.name);
if(apps.some(x=>!x.name.startsWith(prefix)||!/^[a-f0-9]{32}$/.test(x.id))||buckets.some(x=>!x.startsWith(prefix)))throw new Error('Inventory outside scope');
const time=`datetime_geq:${JSON.stringify(since)},datetime_leq:${JSON.stringify(until)}`;
const requests=[];
for(const app of apps){
  const uuid=app.id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');
  requests.push({kind:'container-usage',app,selection:`containersUsageAdaptiveGroups(limit:100,filter:{applicationId:${JSON.stringify(uuid)},${time}}){dimensions{applicationId}sum{allocatedDisk allocatedMemory cpuTimeSec txBytes}}`});
  requests.push({kind:'container-metrics',app,selection:`containersMetricsAdaptiveGroups(limit:100,filter:{applicationId:${JSON.stringify(uuid)},${time}}){dimensions{applicationId instanceId}quantiles{memoryP50 memoryP95 memoryP99 cpuUtilizationP50 cpuUtilizationP95 diskUsageP99}}`});
}
for(const bucket of buckets){
  requests.push({kind:'r2-operations',bucket,selection:`r2OperationsAdaptiveGroups(limit:100,filter:{bucketName:${JSON.stringify(bucket)},${time}}){dimensions{bucketName actionType actionStatus}sum{requests responseBytes responseObjectSize}}`});
  requests.push({kind:'r2-storage',bucket,selection:`r2StorageAdaptiveGroups(limit:100,filter:{bucketName:${JSON.stringify(bucket)},${time}}){dimensions{bucketName date}max{payloadSize metadataSize objectCount uploadCount}}`});
}
// requestSource is schema-valid but suppresses binding-call rows on this account.
requests.push({kind:'workers-ai',scope:'Account + Granite model + time window. Compare application dispatch counts before attributing. requestSource omitted after paired queries showed it suppresses binding-call rows.',selection:`aiInferenceAdaptiveGroups(limit:1000,filter:{modelId:"@cf/ibm-granite/granite-4.0-h-micro",${time}}){count dimensions{modelId errorCode costMetricName1 costMetricName2}sum{totalInputTokens totalOutputTokens totalInferenceTimeMs totalNeurons totalRequestBytesIn totalRequestBytesOut totalCostMetricValue1 totalCostMetricValue2}}`});
const results=[];for(const {selection,...metadata}of requests)results.push({...metadata,...await query(`{viewer{accounts(filter:{accountTag:"${account}"}){metrics:${selection}}}}`)});
const report={at:new Date().toISOString(),since,until,apps,buckets,results};
const text=JSON.stringify(report,null,2);if(text.includes(token))throw new Error('Credential output refused');await writeFile(out,text+'\n');
console.log(JSON.stringify({out,since,until,results},null,2));

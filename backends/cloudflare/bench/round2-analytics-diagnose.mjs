// Read-only investigation of namespace/model filters. Never query billing.
import { writeFile } from 'node:fs/promises';
const account = '85bbd288051330fb51ee1c86031a299b', prefix = 'camelrun-proto-';
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw Error('Configured token required');
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const now = new Date().toISOString();
const out = process.argv[2] ?? 'bench/.state/round2-analytics-diagnose.json';
async function api(path) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, { headers, signal: AbortSignal.timeout(30000) });
  const b = await r.json();
  return { status: r.status, success: b.success, errors: b.errors, result: b.result, result_info: b.result_info };
}
async function gql(query) {
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers, body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000) });
  const b = await r.json();
  return { status: r.status, serverDate: r.headers.get('date'), errors: b.errors ?? null, data: b.data ?? null };
}
const inventory = [];
for (let page = 1; page <= 50; page++) {
  const r = await api(`/workers/durable_objects/namespaces?per_page=500&page=${page}`);
  if (!r.success) throw Error(`Inventory failed: ${r.status}`);
  inventory.push(...r.result.filter(x => x.script?.startsWith(prefix) && x.class?.startsWith(prefix)));
  if (r.result.length < 500 || !r.result_info || page >= r.result_info.total_pages) break;
}
const modelSearch = await api('/ai/models/search?search=granite-4.0-h-micro&per_page=100');
const models = Array.isArray(modelSearch.result) ? modelSearch.result.filter(x => x.name === '@cf/ibm-granite/granite-4.0-h-micro') : [];
const appsRaw = await api('/containers/applications');
const apps = (Array.isArray(appsRaw.result) ? appsRaw.result : appsRaw.result?.applications ?? []).filter(x=>x.name?.startsWith(prefix)).map(({id,name})=>({id,name}));
const types = ['AccountDurableObjectsInvocationsAdaptiveGroupsFilter_InputObject', 'AccountDurableObjectsPeriodicGroupsFilter_InputObject', 'AccountAiInferenceAdaptiveGroupsFilter_InputObject', 'AccountAiInferenceAdaptiveGroupsDimensions', 'AccountContainersUsageAdaptiveGroupsFilter_InputObject', 'AccountContainersMetricsAdaptiveGroupsFilter_InputObject', 'AccountDurableObjectsStorageGroupsFilter_InputObject'];
const schema = await gql(`{${types.map((x,i) => `t${i}:__type(name:${JSON.stringify(x)}){name fields{name description type{kind name ofType{kind name}}} inputFields{name description type{kind name ofType{kind name}}}}`).join(' ')}}`);
const settings = await gql(`{viewer{accounts(filter:{accountTag:"${account}"}){settings{durableObjectsPeriodicGroups{enabled maxDuration maxPageSize} durableObjectsInvocationsAdaptiveGroups{enabled maxDuration maxPageSize} aiInferenceAdaptiveGroups{enabled maxDuration maxPageSize} containersUsageAdaptiveGroups{enabled maxDuration maxPageSize} containersMetricsAdaptiveGroups{enabled maxDuration maxPageSize}}}}}`);
const queries = [];
const windows = [{ key: 'round', since: '2026-11-04T20:20:00Z' }, { key: 'day', since: new Date(Date.parse(now)-86400000).toISOString() }];
const uuid = x => `${x.slice(0,8)}-${x.slice(8,12)}-${x.slice(12,16)}-${x.slice(16,20)}-${x.slice(20)}`;
for (const w of windows) {
  const time = `datetime_geq:${JSON.stringify(w.since)},datetime_leq:${JSON.stringify(now)}`;
  for (const [format, ids] of [['hex', inventory.map(x=>x.id)], ['uuid', inventory.map(x=>uuid(x.id))]]) {
    queries.push({ key:`periodic-${w.key}-${format}`, scope: inventory.map(x=>x.script), selection:`durableObjectsPeriodicGroups(limit:1000,filter:{namespaceId_in:${JSON.stringify(ids)},${time}}){dimensions{namespaceId}sum{cpuTime activeTime duration exceededCpuErrors exceededMemoryErrors fatalInternalErrors}quantiles{memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99}}` });
    queries.push({ key:`invocations-${w.key}-${format}`, scope: inventory.map(x=>x.script), selection:`durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{namespaceId_in:${JSON.stringify(ids)},${time}}){dimensions{namespaceId scriptName}sum{requests errors wallTime}quantiles{cpuTimeP50 cpuTimeP95 cpuTimeP99}}` });
  }
  const scripts = [...new Set(inventory.map(x=>x.script))];
  queries.push({key:`invocations-${w.key}-scripts`,scope:scripts,selection:`durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{scriptName_in:${JSON.stringify(scripts)},${time}}){dimensions{namespaceId scriptName}sum{requests errors wallTime}quantiles{cpuTimeP50 cpuTimeP95 cpuTimeP99}}`});
  for (const [format, id] of [['name','@cf/ibm-granite/granite-4.0-h-micro'], ...models.map(x=>['id',x.id])]) {
    queries.push({key:`ai-${w.key}-${format}`,scope:id,selection:`aiInferenceAdaptiveGroups(limit:1000,filter:{modelId:${JSON.stringify(id)},${time}}){count dimensions{modelId errorCode requestSource costMetricName1 costMetricName2}sum{totalInputTokens totalOutputTokens totalInferenceTimeMs totalNeurons totalCostMetricValue1 totalCostMetricValue2}}`});
  }
}
const dateFilter = 'date_geq:"2026-11-03",date_leq:"2026-11-04"';
queries.push({key:'invocations-date-prefix',scope:prefix,selection:`durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{scriptName_like:"${prefix}%",${dateFilter}}){dimensions{namespaceId scriptName date}sum{requests errors wallTime}quantiles{cpuTimeP50 cpuTimeP95 cpuTimeP99}}`});
queries.push({key:'periodic-date-ids',scope:prefix,selection:`durableObjectsPeriodicGroups(limit:1000,filter:{namespaceId_in:${JSON.stringify(inventory.map(x=>x.id))},${dateFilter}}){dimensions{namespaceId date}sum{cpuTime activeTime duration}quantiles{memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99}}`});
queries.push({key:'periodic-date-minute',scope:prefix,selection:`durableObjectsPeriodicGroups(limit:10000,filter:{namespaceId_in:${JSON.stringify(inventory.map(x=>x.id))},${dateFilter}}){dimensions{namespaceId datetimeMinute}sum{cpuTime activeTime duration}quantiles{memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99}}`});
queries.push({key:'ai-date-model',scope:'@cf/ibm-granite/granite-4.0-h-micro',selection:`aiInferenceAdaptiveGroups(limit:10000,filter:{modelId:"@cf/ibm-granite/granite-4.0-h-micro",${dateFilter}}){count dimensions{modelId datetimeMinute requestSource errorCode}sum{totalInputTokens totalOutputTokens totalInferenceTimeMs totalNeurons}}`});
// Dimensions-only discovery determines whether a namespace-format mismatch is hiding rows.
// Unrelated dimension values are discarded and never serialized or printed.
queries.push({key:'invocations-dimensions-discovery',scope:'Only matching prototype dimensions retained',discovery:'do',selection:`durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{${dateFilter}}){dimensions{namespaceId scriptName}}`});
queries.push({key:'periodic-dimensions-discovery',scope:'Only matching prototype dimensions retained',discovery:'do',selection:`durableObjectsPeriodicGroups(limit:1000,filter:{${dateFilter}}){dimensions{namespaceId}}`});
queries.push({key:'ai-dimensions-discovery',scope:'Only matching Granite dimensions retained',discovery:'ai',selection:`aiInferenceAdaptiveGroups(limit:1000,filter:{${dateFilter}}){dimensions{modelId}}`});
queries.push({key:'ai-model-groups',scope:'Account date-window query; only exact Granite model retained',discovery:'ai',selection:`aiInferenceAdaptiveGroups(limit:1000,filter:{${dateFilter}}){count dimensions{modelId datetimeMinute requestSource errorCode costMetricName1 costMetricName2}sum{totalInputTokens totalOutputTokens totalInferenceTimeMs totalNeurons totalCostMetricValue1 totalCostMetricValue2}}`});
queries.push({key:'ai-model-in',scope:'Granite candidate model IDs',selection:`aiInferenceAdaptiveGroups(limit:1000,filter:{modelId_in:${JSON.stringify(['@cf/ibm-granite/granite-4.0-h-micro',...models.flatMap(x=>[x.id,x.id.replaceAll('-','')])])},${dateFilter}}){count dimensions{modelId datetimeMinute}sum{totalInputTokens totalOutputTokens totalInferenceTimeMs totalNeurons}}`});
queries.push({key:'storage-date-ids',scope:prefix,selection:`durableObjectsStorageGroups(limit:1000,filter:{namespaceIds_hasany:${JSON.stringify(inventory.map(x=>x.id))},${dateFilter}}){dimensions{namespaceIds}max{storedBytes}}`});
for(const [format,ids] of [['hex',apps.map(x=>x.id)],['uuid',apps.map(x=>uuid(x.id))]]) {
  queries.push({key:`container-date-${format}`,scope:apps,selection:`containersUsageAdaptiveGroups(limit:10000,filter:{applicationId_in:${JSON.stringify(ids)},${dateFilter}}){dimensions{applicationId datetimeMinute}sum{allocatedDisk allocatedMemory cpuTimeSec txBytes}}`});
}
const results=[];
for (const {selection,discovery,...meta} of queries) {
  const query=`{viewer{accounts(filter:{accountTag:"${account}"}){metrics:${selection}}}}`;
  const r=await gql(query);
  let rows=r.data?.viewer?.accounts?.[0]?.metrics ?? [], discoveredRows;
  if(discovery) {
    discoveredRows=rows.length;
    const ids=new Set(inventory.flatMap(x=>[x.id,uuid(x.id)]));
    rows=rows.filter(x=>discovery==='ai' ? (x.dimensions?.modelId?.includes('granite') || models.some(m=>m.id===x.dimensions?.modelId)) : (x.dimensions?.scriptName?.startsWith(prefix) || ids.has(x.dimensions?.namespaceId)));
  }
  results.push({...meta,query,status:r.status,serverDate:r.serverDate,errors:r.errors,rows,...(discovery?{discoveredRows,discoveryNote:'Unrelated dimension values discarded'}:{})});
}
const text=JSON.stringify({at:new Date().toISOString(),until:now,inventory,apps,modelSearch:{status:modelSearch.status,success:modelSearch.success,models},schema,settings,results},null,2);
if(text.includes(token))throw Error('Refusing credential output');
await writeFile(out,text+'\n',{mode:0o600});
console.log(JSON.stringify({out,at:new Date().toISOString(),models,settings,results:results.map(({query,...r})=>r)},null,2));

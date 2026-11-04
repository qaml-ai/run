// Isolate optional GraphQL dimensions that suppress Workers AI usage rows.
import {writeFile} from 'node:fs/promises';
const token=process.env.CLOUDFLARE_API_TOKEN;if(!token)throw Error('Configured token required');
const account='85bbd288051330fb51ee1c86031a299b',name='@cf/ibm-granite/granite-4.0-h-micro',id='7952d0cc-cb00-4e10-be02-667565c2ee0f';
const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
const time=`datetime_geq:"2026-11-04T20:20:00Z",datetime_leq:${JSON.stringify(new Date().toISOString())}`;
const baseSum='totalInputTokens totalOutputTokens totalInferenceTimeMs totalNeurons';
const queries=[
  ['name',`modelId:${JSON.stringify(name)}`, 'modelId',baseSum],
  ['uuid',`modelId:${JSON.stringify(id)}`, 'modelId',baseSum],
  ['compact',`modelId:${JSON.stringify(id.replaceAll('-',''))}`, 'modelId',baseSum],
  ['list',`modelId_in:${JSON.stringify([name,id,id.replaceAll('-','')])}`, 'modelId',baseSum],
  ['requestSource',`modelId:${JSON.stringify(name)}`, 'modelId requestSource',baseSum],
  ['errorCode',`modelId:${JSON.stringify(name)}`, 'modelId errorCode',baseSum],
  ['costDimensions',`modelId:${JSON.stringify(name)}`, 'modelId costMetricName1 costMetricName2',baseSum],
  ['costSums',`modelId:${JSON.stringify(name)}`, 'modelId',baseSum+' totalCostMetricValue1 totalCostMetricValue2'],
];
const results=[];
for(const [key,filter,dims,sum]of queries){
  const query=`{viewer{accounts(filter:{accountTag:"${account}"}){metrics:aiInferenceAdaptiveGroups(limit:1000,filter:{${filter},${time}}){count dimensions{${dims}}sum{${sum}}}}}}`;
  const r=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers,body:JSON.stringify({query}),signal:AbortSignal.timeout(30000)});const b=await r.json();
  results.push({key,query,status:r.status,errors:b.errors??null,rows:b.data?.viewer?.accounts?.[0]?.metrics??[]});
}
const types=['AccountDurableObjectsPeriodicGroupsAvg','AccountDurableObjectsInvocationsAdaptiveGroupsAvg','AccountAiInferenceAdaptiveGroupsAvg','AccountContainersUsageAdaptiveGroupsAvg'];
const query=`{${types.map((x,i)=>`t${i}:__type(name:${JSON.stringify(x)}){name fields{name description}}`).join(' ')}}`;
const r=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers,body:JSON.stringify({query}),signal:AbortSignal.timeout(30000)});const schema=await r.json();
const text=JSON.stringify({at:new Date().toISOString(),time,results,schema},null,2);if(text.includes(token))throw Error('Credential refused');
await writeFile(process.argv[2]??'bench/.state/round2-analytics-ai.json',text+'\n',{mode:0o600});console.log(text);

// Read-only bounded telemetry for this study's two exact namespaces.
import {readFile,writeFile} from 'node:fs/promises';
const token=process.env.CLOUDFLARE_API_TOKEN;if(!token)throw Error('Configured credential required');
const account='85bbd288051330fb51ee1c86031a299b',headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
const base=new URL('../../docs/',import.meta.url),output=new URL('hybrid-images-metrics.json',base);
const prior=await readFile(output,'utf8').then(JSON.parse).catch(()=>({runs:[]}));
const namespaces=[];
for(let page=1;page<=20;page++){
 const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/durable_objects/namespaces?per_page=1000&page=${page}`,{headers});
 const b=await r.json();if(!r.ok)throw Error(`namespace inventory HTTP ${r.status}`);namespaces.push(...b.result);if(b.result.length<1000)break;
}
const runs=[];
for(const file of ['hybrid-images-cloud.json','hybrid-images-cache-retry.json']){
 const report=JSON.parse(await readFile(new URL(file,base),'utf8'));
 const oldNamespace=prior.runs.find(x=>x.name===report.name)?.namespaceId;
 const ns=namespaces.find(x=>x.script===report.name)??report.namespace??(oldNamespace?{id:oldNamespace}:undefined);
 if(!ns){const previous=prior.runs.find(x=>x.name===report.name);if(previous)runs.push(previous);continue;}
 const until=new Date().toISOString();
 const objectIds=[...new Set(report.cases.flatMap(c=>[c.seed?.data?.objectId,c.after?.data?.objectId,c.prepare?.data?.objectId]).filter(Boolean))];
 const selector=objectIds.length?`,objectId_in:${JSON.stringify(objectIds)}`:'';
 const query=`{viewer{accounts(filter:{accountTag:"${account}"}){metrics:durableObjectsPeriodicGroups(limit:1000,filter:{namespaceId:"${ns.id}"${selector},datetime_geq:"${report.startedAt}",datetime_leq:"${until}"}){dimensions{namespaceId objectId name datetime}sum{activeTime cpuTime duration exceededCpuErrors exceededMemoryErrors}max{memoryUsageBytes}}}}}`;
 const r=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers,body:JSON.stringify({query})});const b=await r.json();
 const row={name:report.name,namespaceId:ns.id,since:report.startedAt,until,status:r.status,errors:b.errors??null,rows:b.data?.viewer?.accounts?.[0]?.metrics??[],contexts:report.cases.map(c=>({id:c.id,count:c.count,mode:c.mode,prepare:c.prepare,seed:c.seed,request:c.request,hold:c.hold,reuse:c.reuse,after:c.after}))};
 const previous=prior.runs.find(x=>x.name===report.name);runs.push(row.rows.length?row:previous?.rows.length?previous:row);
}
const result={at:new Date().toISOString(),scope:'Whole-isolate periodic samples; matched object identifiers do not imply per-object allocation attribution.',runs};
const text=JSON.stringify(result,null,2);if(text.includes(token))throw Error('Credential guard');await writeFile(output,text+'\n');
console.log(JSON.stringify(runs.map(x=>({name:x.name,status:x.status,errors:x.errors,rows:x.rows.length,byName:Object.fromEntries([...new Set(x.rows.map(r=>r.dimensions.name))].map(n=>[n,{maxMiB:Math.max(...x.rows.filter(r=>r.dimensions.name===n).map(r=>r.max.memoryUsageBytes))/2**20,memoryErrors:x.rows.filter(r=>r.dimensions.name===n).reduce((s,r)=>s+r.sum.exceededMemoryErrors,0)}]))})),null,2));

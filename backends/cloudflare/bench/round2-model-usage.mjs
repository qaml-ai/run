import {readFile,writeFile} from 'node:fs/promises';
const token=(await readFile(new URL('./.state/api-token',import.meta.url),'utf8')).trim();
const groups={smoke:1,burst100:100,burst500:500,serverburst500:500,soak:20,'clean-smoke':1,'clean-serverburst100':100,'clean-serverburst500':500,steady:20,limited:500};
const report={at:new Date().toISOString(),model:'@cf/ibm-granite/granite-4.0-h-micro',groups:{}};
for(const [prefix,n]of Object.entries(groups)){
 const ids=Array.from({length:n},(_,i)=>`${prefix}-${i}`);const rows=[];
 for(let i=0;i<n;i+=100){const response=await fetch('https://camelrun-proto-r2-ai.miguel-85b.workers.dev/batch/usage',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({ids:ids.slice(i,i+100),id:'usage'}),signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error(`Usage HTTP ${response.status}`);rows.push(...(await response.json()).rows);}
 report.groups[prefix]={rows,responses:rows.reduce((n,r)=>n+(r.responses??0),0),dispatches:rows.reduce((n,r)=>n+(r.dispatches?.calls??0),0),tokens:rows.reduce((n,r)=>({input:n.input+(r.tokens?.input??0),output:n.output+(r.tokens?.output??0),cacheRead:n.cacheRead+(r.tokens?.cacheRead??0),cacheWrite:n.cacheWrite+(r.tokens?.cacheWrite??0)}),{input:0,output:0,cacheRead:0,cacheWrite:0})};
}
const s=JSON.stringify(report,null,2);if(s.includes(token))throw new Error('Credential guard');await writeFile(new URL('../docs/round2-model-usage.json',import.meta.url),s+'\n');console.log(JSON.stringify({groups:Object.fromEntries(Object.entries(report.groups).map(([k,{rows,...v}])=>[k,v]))},null,2));

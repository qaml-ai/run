import {readFile,writeFile} from 'node:fs/promises';
const token=(await readFile(new URL('./.state/api-token',import.meta.url),'utf8')).trim();
const base='https://camelrun-proto-r2-heap.miguel-85b.workers.dev',stamp=`cohort-${Date.now()}`;
async function call(id,op,input={}){const start=performance.now();try{const r=await fetch(`${base}/agent/${id}/${op}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(120000)});return {status:r.status,data:await r.json(),ms:performance.now()-start};}catch(e){return {error:e.message,ms:performance.now()-start};}}
const agents=Array.from({length:16},(_,i)=>({id:`${stamp}-${i}`}));
for(let start=0;start<agents.length;start+=4)await Promise.all(agents.slice(start,start+4).map(async a=>{a.prepare=await call(a.id,'prepare');a.seed=await call(a.id,'seed',{count:1000,bytes:1024});a.load=await call(a.id,'load');}));
const held=agents.map(a=>call(a.id,'hold',{ms:20000}));
const during=await Promise.all(agents.map(a=>call(a.id,'status')));const after=await Promise.all(held);
const summary={agents:agents.length,loaded:agents.filter(a=>a.load.data?.loadedMessages===1005).length,isolates:[...new Set(during.map(a=>a.data?.isolate))].length,maxObservedColocated:Math.max(...during.map(a=>a.data?.liveObjects??0)),preserved:after.filter((a,i)=>a.data?.instance===during[i].data?.instance).length};
const out={at:new Date().toISOString(),stamp,summary,agents,during,after};const text=JSON.stringify(out,null,2);if(text.includes(token))throw Error('secret');await writeFile(new URL('./.state/round2-heap-cohort.json',import.meta.url),text);console.log(JSON.stringify(summary));

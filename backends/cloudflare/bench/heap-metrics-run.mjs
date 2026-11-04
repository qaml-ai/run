// Sustain loaded real Pi contexts long enough for remote periodic memory samples.
import {readFile,writeFile} from 'node:fs/promises';
const token=(await readFile(new URL('./.state/api-token',import.meta.url),'utf8')).trim();
const base='https://camelrun-proto-r2-heap.miguel-85b.workers.dev',stamp=`metrics-${Date.now()}`;
const rows=[0,1000,10000,50000].map(n=>({id:`${stamp}-${n}`,n,seeds:[]}));
async function call(id,op,input={}){const start=Date.now();try{const r=await fetch(`${base}/agent/${id}/${op}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(120000)});return{startedAt:start,endedAt:Date.now(),status:r.status,data:await r.json()};}catch(e){return{startedAt:start,endedAt:Date.now(),error:e.message};}}
async function save(){const text=JSON.stringify({at:new Date().toISOString(),stamp,rows},null,2);if(text.includes(token))throw Error('Credential guard');await writeFile(new URL('./.state/round2-heap-metrics.json',import.meta.url),text+'\n');}
for(const row of rows){row.prepare=await call(row.id,'prepare');if(row.prepare.status!==200)throw Error(`Prepare ${row.n} failed`);for(let i=0;i<row.n;i+=1000){const seed=await call(row.id,'seed',{count:Math.min(1000,row.n-i),bytes:1024});row.seeds.push(seed);await save();if(seed.status!==200)throw Error(`Seed ${row.n} failed`);}}
await Promise.all(rows.map(async row=>{row.held=await call(row.id,'loadAndHold',{ms:30000});row.after=await call(row.id,'status');await save();console.log(JSON.stringify({n:row.n,id:row.id,held:row.held,after:row.after}));}));

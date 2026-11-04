import {readFile,writeFile} from 'node:fs/promises';
import {distribution} from './codemode-run.mjs';
const token=(await readFile(new URL('./.state/api-token',import.meta.url),'utf8')).trim();
const repeat=process.argv.includes('--repeat');
const prior=repeat?JSON.parse(await readFile(new URL('./.state/round2-full-agent-codemode.json',import.meta.url),'utf8')):undefined;
const base='https://camelrun-proto-r2-heap.miguel-85b.workers.dev',stamp=prior?.stamp??`full-${Date.now()}`;
async function call(id,op){const start=performance.now();try{const r=await fetch(`${base}/agent/${id}/${op}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(120000)});return {status:r.status,data:await r.json(),ms:performance.now()-start};}catch(e){return {error:e.message,ms:performance.now()-start};}}
const preparation=prior?.preparation??[];
if(!repeat)for(let start=0;start<50;start+=10)preparation.push(...await Promise.all(Array.from({length:10},(_,j)=>call(`${stamp}-${start+j}`,'prepare'))));
const results=prior?.results??[];
for(const count of (repeat?[1,50]:[50,200])) {
 const start=performance.now();
 const rows=await Promise.all(Array.from({length:count},(_,i)=>call(`${stamp}-${count===1?42:i%50}`,'runScript')));
 const summary={agents:count===1?1:50,scripts:count,repeat,clientBatchMs:performance.now()-start,ok:rows.filter(r=>r.status===200&&r.data?.status==='done'&&!r.data.text?.includes('"isError":true')).length,httpMs:distribution(rows.map(r=>r.ms)),serverWallMs:distribution(rows.map(r=>r.data?.endedAt-r.data?.began))};
 results.push({summary,rows});const text=JSON.stringify({at:new Date().toISOString(),stamp,preparation,results},null,2);if(text.includes(token))throw Error('secret');await writeFile(new URL('./.state/round2-full-agent-codemode.json',import.meta.url),text);console.log(JSON.stringify(summary));
}

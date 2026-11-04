// Retry only the failed 500-agent capacity calls, with four in flight.
import {readFile,writeFile} from 'node:fs/promises';
const previous=JSON.parse(await readFile(new URL('../docs/round2-clean-load500.json',import.meta.url),'utf8'));
const token=(await readFile(new URL('./.state/api-token',import.meta.url),'utf8')).trim();
const reconcile=process.env.BENCH_RECONCILE==='1';
const jobs=reconcile ? JSON.parse(await readFile(new URL('../docs/round2-capacity-retry.json',import.meta.url),'utf8')).rows.filter(r=>r.status!=='completed')
  : previous.poll.rows.map((r,i)=>({r,agent:previous.ids[i]})).filter(x=>x.r.status==='failed');
const output=new URL(`../docs/round2-capacity-${reconcile?'reconcile':'retry'}.json`,import.meta.url);
const base='https://camelrun-proto-r2-ai.miguel-85b.workers.dev';
const report={startedAt:new Date().toISOString(),concurrency:4,initialFailureCount:jobs.length,rows:[]};
async function request(path,input){const r=await fetch(base+path,{method:input?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:input?JSON.stringify(input):undefined,signal:AbortSignal.timeout(100000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}
for(let i=0;i<jobs.length;i+=4){
 report.rows.push(...await Promise.all(jobs.slice(i,i+4).map(async({agent})=>{
  const start=Date.now(),id='capacity-retry-1';try{let r=await request(`/agents/${agent}/requests`,{id,method:'prompt',params:{text:'In one short sentence explain what a compiler does.',history:'none'}});while(r.state!=='completed'&&Date.now()-start<90000)r=await request(`/agents/${agent}/requests/${id}?wait=25`);return{agent,ms:Date.now()-start,status:r.status,error:r.error??null};}catch(e){return{agent,ms:Date.now()-start,error:String(e)};}
 })));
 await writeFile(output,JSON.stringify(report,null,2)+'\n');
}
report.completed=report.rows.filter(r=>r.status==='completed').length;report.finishedAt=new Date().toISOString();
await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));

import {readFile,writeFile} from 'node:fs/promises';
const token=(await readFile(new URL('./.state/api-token',import.meta.url),'utf8')).trim();
const base='https://camelrun-proto-r2-ai.miguel-85b.workers.dev';
const count=Number(process.env.BENCH_AGENTS??500);
if(![100,500].includes(count))throw new Error('Expected 100 or 500 agents');
const ids=Array.from({length:count},(_,i)=>`clean-serverburst${count}-${i}`),id='load';
const report={startedAt:new Date().toISOString(),method:`One authenticated Worker fans out to ${count} pre-provisioned full Pi agents; no client socket fanout.`,ids};
async function call(action){const r=await fetch(base+'/batch/'+action,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({ids,id}),signal:AbortSignal.timeout(180000)});if(!r.ok)throw new Error(`batch ${action} HTTP ${r.status}: ${(await r.text()).slice(0,300)}`);return r.json();}
async function save(){const s=JSON.stringify(report,null,2);if(s.includes(token))throw new Error('Credential guard');await writeFile(new URL(`../docs/round2-clean-load${count}.json`,import.meta.url),s+'\n');}
report.provision=await call('provision');await save();console.log(JSON.stringify({provisioned:report.provision.rows.filter(r=>r.httpStatus===200).length,ms:report.provision.endedAt-report.provision.began}));
report.submit=await call('submit');await save();const deadline=Date.now()+180000;
while(Date.now()<deadline){report.poll=await call('poll');await save();const done=report.poll.rows.filter(r=>r.state==='completed').length;console.log(JSON.stringify({at:new Date().toISOString(),done}));if(done===count)break;await new Promise(r=>setTimeout(r,3000));}
const rows=report.poll.rows;const ok=rows.filter(r=>r.status==='completed');const times=ok.map(r=>r.endedAt-r.startedAt).sort((a,b)=>a-b);const activeTimes=ok.filter(r=>r.began).map(r=>r.endedAt-r.began).sort((a,b)=>a-b);const q=(v,p)=>v[Math.max(0,Math.ceil(v.length*p)-1)]??null;
const edges=rows.filter(r=>r.began&&r.endedAt).flatMap(r=>[[r.began,1],[r.endedAt,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let active=0,max=0;for(const [,d]of edges){active+=d;max=Math.max(max,active);}
report.summary={completed:ok.length,failed:rows.filter(r=>r.status==='failed').length,pending:rows.filter(r=>r.state!=='completed').length,maxOverlappingAgentTurns:max,acceptedToCompletedMs:{p50:q(times,.5),p95:q(times,.95),p99:q(times,.99),max:times.at(-1)},activeTurnMs:{n:activeTimes.length,p50:q(activeTimes,.5),p95:q(activeTimes,.95),p99:q(activeTimes,.99),max:activeTimes.at(-1)},elapsedMs:Date.now()-report.submit.began};report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify(report.summary));

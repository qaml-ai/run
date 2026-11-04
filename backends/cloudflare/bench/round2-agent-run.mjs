import {readFile,writeFile,rename} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const base=process.env.CAMELRUN_BENCH_URL;
if(!base || !/^https:\/\/camelrun-proto-r2-ai\./.test(base))throw new Error('Expected prefixed benchmark URL');
const token=(await readFile(new URL('./.state/api-token',import.meta.url),'utf8')).trim();
const output=new URL('../docs/round2-agents.json',import.meta.url);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const resume=process.env.BENCH_RESUME==='1';
const report=resume?JSON.parse(await readFile(output,'utf8')):{startedAt:new Date().toISOString(),model:'@cf/ibm-granite/granite-4.0-h-micro',loads:[],soak:{},restarts:[]};
let saveQueue=Promise.resolve();
async function save(){const text=JSON.stringify(report,null,2);if(text.includes(token)||process.env.CLOUDFLARE_API_TOKEN&&text.includes(process.env.CLOUDFLARE_API_TOKEN))throw new Error('Credential guard');const pending=saveQueue.then(async()=>{const temporary=new URL(`.round2-agents.${process.pid}.tmp`,output);await writeFile(temporary,text+'\n');await rename(temporary,output);});saveQueue=pending.catch(()=>{});await pending;}
async function call(path,body){
 const method=body===undefined?'GET':'POST',attempts=method==='GET'?3:1;
 for(let attempt=1;attempt<=attempts;attempt++){
  const started=performance.now();let status=null;
  try{const r=await fetch(base+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(100000)});status=r.status;const text=await r.text();if(!r.ok)throw new Error(`HTTP ${r.status}: ${text.slice(0,400)}`);return JSON.parse(text);}
  catch(error){const retry=method==='GET'&&attempt<attempts&&(status===null||status===408||status===429||status>=500);(report.transportErrors??=[]).push({at:new Date().toISOString(),method,path,attempt,status,elapsedMs:performance.now()-started,error:String(error),retry});await save();if(!retry)throw error;await sleep(attempt*1000);}
 }
}
async function provision(id){const s=performance.now();const r=await fetch(base+`/agents/${id}/configuration`,{method:'PUT',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id,revision:1,expiresAt:null,config:{model:report.model,systemPrompt:'Answer briefly. Do not use tools.',thinkingLevel:'off',fileTools:false,codeMode:false}}),signal:AbortSignal.timeout(100000)});if(!r.ok)throw new Error(`Provision ${r.status}: ${(await r.text()).slice(0,250)}`);return {id,provisionMs:performance.now()-s};}
function distribution(values){const a=values.toSorted((a,b)=>a-b),q=p=>a[Math.max(0,Math.ceil(a.length*p)-1)]??null;return {n:a.length,p50:q(.5),p95:q(.95),p99:q(.99),max:a.at(-1)??null};}
function overlap(rows){const edges=rows.filter(r=>r.began&&r.endedAt).flatMap(r=>[[r.began,1],[r.endedAt,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let n=0,max=0;for(const [,d]of edges){n+=d;max=Math.max(max,n);}return max;}
async function turn(agent,id){const started=performance.now();try{const accepted=await call(`/agents/${agent}/requests`,{id,method:'prompt',params:{text:'In one short sentence explain what a compiler does.',history:'none'}});let record=accepted;const deadline=Date.now()+90000;while(record.state!=='completed'&&Date.now()<deadline)record=await call(`/agents/${agent}/requests/${id}?wait=25`);return {agent,clientMs:performance.now()-started,status:record.status,state:record.state,error:record.error??record.outcome?.error??null,began:record.began,endedAt:record.endedAt,replyChars:record.outcome?.result?.reply?.length??0};}catch(e){return {agent,clientMs:performance.now()-started,error:String(e)};}}
async function load(n,label){const ids=Array.from({length:n},(_,i)=>`${label}-${i}`);const start=performance.now();const created=await Promise.allSettled(ids.map(provision));const provisionMs=performance.now()-start;const ready=created.flatMap(x=>x.status==='fulfilled'?[x.value.id]:[]);const begin=new Date().toISOString();const batch=performance.now();const rows=await Promise.all(ready.map(id=>turn(id,'load')));const result={n,label,begin,endedAt:new Date().toISOString(),provisionBatchMs:provisionMs,provisionFailures:created.filter(x=>x.status==='rejected').map(x=>String(x.reason)),elapsedMs:performance.now()-batch,completed:rows.filter(r=>r.status==='completed').length,errors:rows.filter(r=>r.status!=='completed').length,maxOverlappingAgentTurns:overlap(rows),latencyMs:distribution(rows.map(r=>r.clientMs)),rows};report.loads.push(result);await save();console.log(JSON.stringify({...result,rows:undefined}));return result;}
async function restart(index){const config=new URL('./round2-agent.wrangler.jsonc',import.meta.url);const parsed=JSON.parse(await readFile(config,'utf8'));parsed.vars.BENCH_BUILD=`soak-restart-${index}`;await writeFile(config,JSON.stringify(parsed,null,2)+'\n');const startedAt=new Date().toISOString();const code=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['bench/cloud-run.mjs','enable','bench/round2-agent.wrangler.jsonc'],{cwd:new URL('../',import.meta.url),stdio:'inherit'});p.on('error',reject);p.on('exit',resolve);});report.restarts.push({index,startedAt,endedAt:new Date().toISOString(),code});await save();if(code!==0)throw new Error('Periodic restart failed');}
let ids,starts;
if(resume){
 starts=report.soak?.starts;
 if(!Array.isArray(starts)||starts.length!==20||!Array.isArray(report.restarts)||report.finishedAt||starts.some(s=>!/^steady-\d+$/.test(s.agent)||!Number.isFinite(s.startedAt)||!Number.isFinite(s.stopAt)))throw new Error('Saved report is not an unfinished 20-agent soak');
 ids=starts.map(s=>s.agent);
 if(new Set(ids).size!==20)throw new Error('Saved soak contains duplicate agents');
 console.log(JSON.stringify({resumedAt:new Date().toISOString(),soakStartedAt:report.soak.startedAt,deadline:Math.max(...starts.map(s=>s.stopAt)),restarts:report.restarts.length}));
}else{
 await save();
 const unauth=await fetch(base+'/meta');report.unauthorizedStatus=unauth.status;if(unauth.status!==401)throw new Error('Bearer protection failed');
 await load(1,'clean-smoke');
 if(report.loads[0].completed!==1)throw new Error('Smoke model turn failed');
 ids=Array.from({length:20},(_,i)=>`steady-${i}`);await Promise.all(ids.map(provision));
 starts=await Promise.all(ids.map(id=>call(`/drivers/${id}/start`,{agent:id,durationMs:3600000})));
 report.soak={startedAt:new Date().toISOString(),starts,expectedAgents:20,intervalMs:60000};await save();console.log('SOAK_STARTED '+report.soak.startedAt);
}
const deadline=Math.max(...starts.map(s=>s.stopAt));let nextRestart=report.restarts.length+1;
if(!resume&&!process.env.BENCH_SKIP_LOADS){await load(100,'clean-burst100');await sleep(65000);await load(500,'clean-burst500');}
while(Date.now()<deadline+30000){
  if(nextRestart<=3&&Date.now()>=starts[0].startedAt+nextRestart*15*60000){await restart(nextRestart++);}
  const statuses=await Promise.all(ids.map(id=>call(`/drivers/${id}`)));
  report.soak.statusAt=new Date().toISOString();report.soak.agents=statuses;await save();
  console.log(JSON.stringify({soakAt:report.soak.statusAt,ticks:statuses.reduce((n,s)=>n+s.rows.length,0),errors:statuses.flatMap(s=>s.rows).filter(r=>r.error||r.status!=='completed').length,restarts:report.restarts.length}));
  await sleep(Math.min(30000,Math.max(1000,deadline+30000-Date.now())));
}
report.soak.agents=await Promise.all(ids.map(id=>call(`/drivers/${id}`)));
report.soak.finalAgentState=await Promise.all(ids.map(id=>call(`/agents/${id}/bench/status`)));
await Promise.all(ids.map(id=>call(`/drivers/${id}/stop`,{})));
const rows=report.soak.agents.flatMap(s=>s.rows);report.soak.summary={ticks:rows.length,completed:rows.filter(r=>r.status==='completed').length,errors:rows.filter(r=>r.error||r.status!=='completed').length,latencyMs:distribution(rows.map(r=>r.endedAt-r.startedAt)),alarmLatenessMs:distribution(rows.map(r=>r.startedAt-r.scheduledAt)),distinctDriverInstances:new Set(rows.map(r=>r.instance)).size};
report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify(report.soak.summary));

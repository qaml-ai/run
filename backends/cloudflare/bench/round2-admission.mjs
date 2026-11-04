// A bounded admission queue. It does not modify the Worker or the alarm soak.
import {readFile,writeFile} from "node:fs/promises";
const base="https://camelrun-proto-r2-ai.miguel-85b.workers.dev";
const bearer=(await readFile(new URL("./.state/api-token",import.meta.url),"utf8")).trim();
const output=new URL("../docs/round2-admission.json",import.meta.url);
const ids=Array.from({length:500},(_,i)=>`limited-${i}`);
const report={startedAt:new Date().toISOString(),model:"@cf/ibm-granite/granite-4.0-h-micro",count:500,
  policy:{launchesPerSecond:4,maxInFlight:40,maxRetries:2,retryOnly:"Explicit capacity/rate-limit error; unresolved transport is polled with the same request ID and never blindly resubmitted",maxDispatches:1500},
  attempts:[],transportErrors:[],maxInFlightObserved:0};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function save(){const text=JSON.stringify(report,null,2);if([bearer,process.env.CLOUDFLARE_API_TOKEN].filter(Boolean).some(x=>text.includes(x)))throw Error("Credential export refused");await writeFile(output,text+"\n");}
async function request(path,body,timeoutMs=35000){
  const response=await fetch(base+path,{method:body?"POST":"GET",headers:{authorization:`Bearer ${bearer}`,"content-type":"application/json"},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeoutMs)});
  const raw=await response.text();let data;try{data=JSON.parse(raw)}catch{data={text:raw.slice(0,500)}}return {status:response.status,data};
}
const isCapacity=text=>/insufficient capacity|no (available )?capacity|capacity (temporarily )?(limit|exceeded|unavailable)|overloaded|rate.limit|too many requests|\b429\b/i.test(text);
async function details(agent){try{const h=await request(`/agents/${agent}/history`);return (h.data.messages??[]).slice(-8).flatMap(m=>m.errorMessage?[String(m.errorMessage)]:[]).join("\n").slice(0,4000)}catch{return ""}}
async function turn(job){
  const requestId=`admission-${job.attempt}`;
  const result={agent:job.agent,attempt:job.attempt,requestId,launchedAt:Date.now(),state:"unresolved"};
  report.attempts.push(result);
  let accepted;
  try{accepted=await request(`/agents/${job.agent}/requests`,{id:requestId,method:"prompt",params:{text:"In one short sentence explain what a compiler does.",history:"none"}});}
  catch(e){result.submitTransportError={message:e.message,cause:e.cause?.code};report.transportErrors.push({agent:job.agent,requestId,stage:"submit",...result.submitTransportError});}
  if(accepted){result.submitHttpStatus=accepted.status;result.submitted=accepted.data;
    if(accepted.status>=400){result.state="failed";result.error=JSON.stringify(accepted.data).slice(0,1000);result.capacityError=isCapacity(result.error)||accepted.status===429;result.endedAt=Date.now();return result;}}
  const deadline=Date.now()+120000;let row=accepted?.data;
  while(Date.now()<deadline&&row?.state!=="completed"){
    try{const polled=await request(`/agents/${job.agent}/requests/${requestId}?wait=25`);if(polled.status===404){result.error="Request absent while reconciling transport; no blind retry";break;}if(polled.status>=400){result.error=`Poll HTTP ${polled.status}`;break;}row=polled.data;}
    catch(e){report.transportErrors.push({agent:job.agent,requestId,stage:"poll",message:e.message,cause:e.cause?.code});await sleep(1000);}
  }
  result.endedAt=Date.now();result.record=row;
  if(row?.state==="completed"){
    result.state=row.status??"failed";result.error=row.error??row.outcome?.error??null;
    if(result.state!=="completed"){
      result.providerError=await details(job.agent);
      result.capacityError=isCapacity(`${result.error??""}\n${result.providerError}`);
    }
  }else{result.state="unresolved";result.error??="No terminal record within 120 seconds; not retried";}
  return result;
}
await save();
const meta=await request("/meta");report.meta=meta;
if(meta.status!==200||meta.data.model!==report.model)throw Error("Unexpected benchmark Worker/model");
const provisionStart=Date.now();report.provision=await request("/batch/provision",{ids,id:"admission"},180000);report.provisionMs=Date.now()-provisionStart;
if(report.provision.status!==200)throw Error("Provision batch failed");
const rows=report.provision.data.rows??[];
const ready=new Set(rows.filter(x=>x.httpStatus===200).map(x=>x.agent));
report.provisioned=ready.size;
const queue=ids.filter(id=>ready.has(id)).map(agent=>({agent,attempt:1}));
let inFlight=0,lastLaunch=-Infinity,dispatched=0,lastSave=Date.now();
const began=Date.now();report.admissionBeganAt=began;
while(queue.length||inFlight){
  const now=Date.now();
  if(queue.length&&inFlight<40&&now-lastLaunch>=250){
    if(dispatched>=1500)throw Error("Dispatch ceiling reached");
    const job=queue.shift();inFlight++;dispatched++;lastLaunch=Date.now();
    report.maxInFlightObserved=Math.max(report.maxInFlightObserved,inFlight);
    void turn(job).then(row=>{if(row.state!=="completed"&&row.capacityError&&job.attempt<3)queue.push({agent:job.agent,attempt:job.attempt+1});}).catch(e=>{report.transportErrors.push({agent:job.agent,stage:"client",message:e.message});}).finally(()=>inFlight--);
  }
  if(Date.now()-lastSave>10000){await save();console.log(JSON.stringify({at:new Date().toISOString(),dispatched,queued:queue.length,inFlight,completed:report.attempts.filter(x=>x.state==="completed").length}));lastSave=Date.now();}
  await sleep(25);
}
const final=ids.map(agent=>report.attempts.filter(x=>x.agent===agent).at(-1)).filter(Boolean);
const distribution=values=>{const v=values.sort((a,b)=>a-b),q=p=>v[Math.max(0,Math.ceil(v.length*p)-1)]??null;return {n:v.length,p50:q(.5),p95:q(.95),p99:q(.99),max:v.at(-1)??null}};
const edges=report.attempts.flatMap(x=>x.record?.began&&x.record?.endedAt?[[x.record.began,1],[x.record.endedAt,-1]]:[]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let active=0,maxOverlap=0;for(const [,change]of edges){active+=change;maxOverlap=Math.max(maxOverlap,active)}
report.summary={provisioned:ready.size,completed:final.filter(x=>x.state==="completed").length,failed:final.filter(x=>x.state==="failed").length,unresolved:final.filter(x=>!["completed","failed"].includes(x.state)).length,dispatched,retries:dispatched-ready.size,explicitCapacityFailures:report.attempts.filter(x=>x.capacityError).length,maxInFlight:report.maxInFlightObserved,maxOverlappingServerTurns:maxOverlap,admissionElapsedMs:Date.now()-began,successfulAttemptMs:distribution(report.attempts.filter(x=>x.state==="completed").map(x=>x.endedAt-x.launchedAt)),serverTurnMs:distribution(report.attempts.filter(x=>x.state==="completed"&&x.record?.began).map(x=>x.record.endedAt-x.record.began))};
report.usage=await request("/batch/usage",{ids,id:"admission"},180000);
report.usageSummary=(report.usage.data.rows??[]).reduce((sum,row)=>{
  for(const key of Object.keys(sum.tokens))sum.tokens[key]+=row.tokens?.[key]??0;
  sum.dispatches+=row.dispatches?.calls??0;sum.inputBytes+=row.dispatches?.inputBytes??0;sum.responses+=row.responses??0;return sum;
},{tokens:{input:0,output:0,cacheRead:0,cacheWrite:0},dispatches:0,inputBytes:0,responses:0});
const launches=report.attempts.map(x=>x.launchedAt).sort((a,b)=>a-b);
report.summary.minLaunchGapMs=Math.min(...launches.slice(1).map((x,i)=>x-launches[i]));
report.summary.averageLaunchRatePerSecond=(launches.length-1)/(launches.at(-1)-launches[0])*1000;
report.costEstimate={inputUsdPerMillion:0.017,outputUsdPerMillion:0.112,modelUsd:(report.usageSummary.tokens.input*.017+report.usageSummary.tokens.output*.112)/1e6,source:"https://developers.cloudflare.com/workers-ai/models/granite-4.0-h-micro/",excludes:"Worker/DO request, CPU, duration and storage; included in root usage accounting"};
report.limitations=["This is 500 admitted agents with bounded overlapping turns, not 500 simultaneous model calls.","Retries are configured but only measured if explicit capacity failures occur.","Worker and DO usage are accounted for in the root run."];
report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify(report.summary));

// Observe inactivity through the account API so polling does not wake the DO.
import {readFile, writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const account='85bbd288051330fb51ee1c86031a299b';
const base='https://camelrun-proto-computers.miguel-85b.workers.dev';
const token=(await readFile(new URL('./.state/api-token',import.meta.url),'utf8')).trim();
const apiToken=process.env.CLOUDFLARE_API_TOKEN;
if(!apiToken || token.length<32) throw new Error('Missing credentials');
const records=[];
const apps={native:'834ec9f61e1e4fb485f09bc8febb9212',sdk:'0a51b1c46c594bd3a82aa1390cf99c87'};
const size=process.env.COMPUTER_BENCH_SIZE??'lite';
if(!['lite','basic'].includes(size)) throw new Error('Invalid size');
const output=new URL(`./.state/computers-idle-${size}.json`,import.meta.url);
const save=async record=>{records.push(record);await writeFile(output,JSON.stringify(records,null,2)+'\n');console.log(JSON.stringify(record));};
async function call(provider,operation){
 const start=performance.now();
 const r=await fetch(`${base}/v1/${provider}/${size}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(operation),signal:AbortSignal.timeout(40000)});
 const result=await r.json();
 if(!r.ok)throw new Error(`${provider}: ${JSON.stringify(result)}`);
 return {clientMs:performance.now()-start,...result};
}
for(const provider of ['native','sdk']){
 try{
  await call(provider,{op:'cleanup'});
  const startedAt=new Date().toISOString();
  const arm=await call(provider,{op:'exec',idleMs:5000,timeoutMs:30000,argv:['node','-e',"require('node:fs').writeFileSync('/workspace/unsaved.txt','unsaved');console.log('armed')"]});
  const warm=[];
  if(process.env.COMPUTER_BENCH_WARM==='1') for(let trial=0;trial<3;trial++) warm.push(await call(provider,{op:'exec',idleMs:5000,timeoutMs:30000,argv:['node','-e','console.log(process.version)']}));
  const idleStart=performance.now();
  const observations=[];
  let stopped=false;
  for(let i=0;i<30;i++){
   await delay(2000);
   const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications/${apps[provider]}/instances-v2?per_page=100`,{headers:{Authorization:`Bearer ${apiToken}`},signal:AbortSignal.timeout(10000)});
   const j=await r.json();
   if(!j.success)throw new Error('Instance status unavailable');
   const instances=j.result.filter(x=>x.name===`camelrun-proto-${size}`);
   observations.push({elapsedMs:performance.now()-idleStart,instances:instances.map(x=>({status:x.status,configuration:x.configuration,location:x.location,started_at:x.started_at}))});
   if(instances.length && instances.every(x=>x.status.state==='stopped'||x.status.state==='inactive')){stopped=true;break;}
  }
  const idleMs=performance.now()-idleStart;
  const wake=await call(provider,{op:'exec',idleMs:5000,timeoutMs:30000,argv:['node','-e',"console.log(JSON.stringify({unsavedRetained:require('node:fs').existsSync('/workspace/unsaved.txt')}))"]});
  await save({provider,size,startedAt,arm,warm,stopped,idleMs,observations,wake});
 }finally{
  await call(provider,{op:'cleanup'});
 }
}

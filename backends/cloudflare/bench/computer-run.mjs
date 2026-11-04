// One bounded pass; no deployment, credentials, or cloud resource creation.
// API_TOKEN is read from environment or a mode-0600 token file, never printed.
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const base=process.env.COMPUTER_BENCH_URL;
const token=process.env.API_TOKEN ?? (process.env.COMPUTER_BENCH_TOKEN_FILE ? (await readFile(process.env.COMPUTER_BENCH_TOKEN_FILE,"utf8")).trim() : undefined);
const output=process.env.COMPUTER_BENCH_OUTPUT ?? "/tmp/camelrun-proto-computer-results.json";
const providers=(process.env.COMPUTER_BENCH_PROVIDERS??"native,sdk").split(",");
const sizes=(process.env.COMPUTER_BENCH_SIZES??"lite,basic").split(",");
const nativeSnapshots=process.env.COMPUTER_BENCH_NATIVE_SNAPSHOTS==="1";
if (!base || !token || token.length<32) throw new Error("COMPUTER_BENCH_URL and a >=32-character API_TOKEN/token file are required");
if (providers.some(v=>!["native","sdk"].includes(v)) || sizes.some(v=>!["lite","basic"].includes(v))) throw new Error("Invalid provider or size");
const origin=new URL(base);
if (origin.protocol!=="https:" && !["localhost","127.0.0.1"].includes(origin.hostname)) throw new Error("Remote endpoint must use HTTPS");
const records=[];
const failures=[];
const started=Date.now();
const deadline=started+14*60_000;
async function call(provider,size,operation,label=operation.op) {
  if(Date.now()>deadline && !["stop","cleanup","status"].includes(operation.op)) throw new Error("Runner wall time cap reached");
  const start=performance.now();
  const response=await fetch(new URL(`/v1/${provider}/${size}`,origin),{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(operation),signal:AbortSignal.timeout(190_000)});
  const text=await response.text();
  let result;try{result=JSON.parse(text);}catch{result={error:`Non-JSON HTTP ${response.status}`};}
  const record={provider,size,label,clientMs:performance.now()-start,status:response.status,result};
  records.push(record);
  await writeFile(output,JSON.stringify({startedAt:new Date(started).toISOString(),elapsedMs:Date.now()-started,nativeSnapshots,records,failures},null,2)+"\n");
  console.log(JSON.stringify(record));
  if (!response.ok || typeof result.exitCode==="number" && result.exitCode!==0) throw new Error(`${provider}/${size}/${label} failed: ${JSON.stringify(result)}`);
  return result;
}
const command=(op,kind)=>({op:"exec",argv:["node","/opt/fixtures/fixture.mjs",op,kind],timeoutMs:180_000});
try {
  const unauthorized=await fetch(new URL("/v1/native/lite",origin),{method:"POST",body:"{}",signal:AbortSignal.timeout(10_000)});
  if(unauthorized.status!==401) throw new Error("Unauthenticated endpoint was not denied");
  for(const provider of providers) for(const size of sizes) {
    try {
    await call(provider,size,{op:"stop"});
    await call(provider,size,{op:"exec",argv:["node","-e","console.log(process.version)"],timeoutMs:30_000},"cold-exec");
    for(let trial=0;trial<3;trial++) await call(provider,size,{op:"exec",argv:["node","-e","console.log(process.version)"],timeoutMs:30_000},`warm-exec-${trial+1}`);
    for(const kind of ["small","large"]) {
      await call(provider,size,command("prepare",kind),`${kind}-prepare`);
      await call(provider,size,command("work",kind),`${kind}-work`);
      if(provider==="sdk" || nativeSnapshots) {
        const name=`camelrun-proto-${provider}-${size}-${kind}`;
        await call(provider,size,{op:"snapshot",name,timeoutMs:180_000},`${kind}-capture`);
        await call(provider,size,command("dirty",kind),`${kind}-dirty`);
        await call(provider,size,{op:"stop"});
        await call(provider,size,{op:"restore",name,timeoutMs:180_000},`${kind}-restore`);
        await call(provider,size,command("verify",kind),`${kind}-verify`);
      } else records.push({provider,size,label:`${kind}-capture`,skipped:"Native snapshot deletion not verified; enable only after cleanup path confirmed"});
    }
    await call(provider,size,{op:"exec",argv:["node","-e","require('node:fs').writeFileSync('/workspace/unsaved.txt','unsaved');console.log('armed')"],idleMs:5000},"inactivity-arm");
    await delay(10_000);
    const asleep=await call(provider,size,{op:"status"},"inactivity-state");
    if(asleep.running) throw new Error("Container did not stop after inactivity interval");
    const wake=await call(provider,size,{op:"exec",argv:["node","-e","console.log(JSON.stringify({unsavedRetained:require('node:fs').existsSync('/workspace/unsaved.txt')}))"]},"wake-exec");
    if(JSON.parse(wake.stdout).unsavedRetained!==false) throw new Error("Unexpected unsaved file retention");
    } catch(error) {
      failures.push({provider,size,error:error instanceof Error?error.message:String(error)});
    } finally {
      try {await call(provider,size,{op:"cleanup"});}
      catch(error) {failures.push({provider,size,error:`Cleanup failed: ${String(error)}`});}
    }
  }
}catch(error){failures.push({error:error instanceof Error?error.message:String(error)});}
finally {
  for(const provider of providers) for(const size of sizes) {
    try{await call(provider,size,{op:"cleanup"},"final-cleanup");}catch(error){failures.push({provider,size,error:`Final cleanup failed: ${String(error)}`});}
  }
  await writeFile(output,JSON.stringify({startedAt:new Date(started).toISOString(),elapsedMs:Date.now()-started,nativeSnapshots,records,failures},null,2)+"\n");
  console.log(JSON.stringify({output,records:records.length,failures}));
}
if(failures.length)process.exitCode=1;

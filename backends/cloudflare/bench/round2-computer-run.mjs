import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
const base = "https://camelrun-proto-r2-sync.miguel-85b.workers.dev";
const bearer = (await readFile(new URL("./.state/api-token",import.meta.url),"utf8")).trim();
const output = new URL("./.state/round2-computer-results.json",import.meta.url);
let report;
try { report=JSON.parse(await readFile(output,"utf8")); } catch { report={beganAt:new Date().toISOString(),versions:{computer:"0.9.0",justBash:"3.0.1",wrangler:"4.157.0"},records:[]}; }
async function call(name,input,label=input.op,timeoutMs=360000) {
  const begin=performance.now();
  let record;
  try {
    const response=await fetch(`${base}/workspace/${name}`,{method:"POST",headers:{authorization:`Bearer ${bearer}`,"content-type":"application/json"},body:JSON.stringify(input),signal:AbortSignal.timeout(timeoutMs)});
    let body; const raw=await response.text();try{body=JSON.parse(raw);}catch{body={text:raw.slice(0,300)}}
    record={at:new Date().toISOString(),name,label,status:response.status,clientMs:performance.now()-begin,...body};
  } catch(error) {record={at:new Date().toISOString(),name,label,clientMs:performance.now()-begin,error:error.message};}
  report.records.push(record);
  const encoded=JSON.stringify(report,null,2);
  if(encoded.includes(bearer)||process.env.CLOUDFLARE_API_TOKEN&&encoded.includes(process.env.CLOUDFLARE_API_TOKEN))throw Error("Credential output refused");
  await writeFile(output,encoded,{mode:0o600});
  console.log(JSON.stringify(record)); return record;
}
const quote=s=>`'${s.replaceAll("'","'\\''")}'`;
const memoryScript=`const f=require('fs'); const p=f.readFileSync('/proc/1/status','utf8'); const out={daemon:p.split('\\n').filter(x=>/^(Name|VmRSS|VmHWM|VmSize|Threads):/.test(x)),node:process.memoryUsage(),processes:[]};for(const n of f.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{const s=f.readFileSync('/proc/'+n+'/status','utf8');out.processes.push({pid:Number(n),name:s.match(/^Name:\\s*(.*)$/m)?.[1],rssKiB:Number(s.match(/^VmRSS:\\s*(\\d+)/m)?.[1]??0)})}catch{}}for(const n of ['memory.current','memory.peak','memory.max','memory/memory.usage_in_bytes','memory/memory.max_usage_in_bytes','memory/memory.limit_in_bytes']){try{out[n]=f.readFileSync('/sys/fs/cgroup/'+n,'utf8').trim()}catch{}}console.log(JSON.stringify(out))`;
const memory=()=>({op:"exec",backend:"container",command:`node -e ${quote(memoryScript)}`});
const mode=process.argv[2]??"smoke";
const name=process.argv[3]??"shared";
if(mode==="smoke") {
  const nonce=Date.now().toString(36);
  const unauth=await fetch(`${base}/workspace/${name}`,{method:"POST",headers:{"content-type":"application/json"},body:'{"op":"status"}'});report.unauthStatus=unauth.status;
  await call(name,{op:"status"},"initial-status");
  await call(name,{op:"write",path:"/workspace/from-do.txt",text:`from durable workspace ${nonce}\n`},"write-from-do");
  await call(name,{op:"exec",backend:"worker-shell",command:`cat from-do.txt; printf 'worker shell wrote this ${nonce}\\n' > from-shell.txt`},"shell-read-and-write");
  await call(name,{op:"exec",backend:"container",command:`cat from-do.txt from-shell.txt; printf 'container wrote this ${nonce}\\n' > from-container.txt; node --version; tsc --version`},"container-read-and-write");
  await call(name,{op:"exec",backend:"worker-shell",command:"cat from-container.txt"},"shell-reads-container");
  await call(name,memory(),"memory-baseline");
} else if(mode==="build") {
  const count=Number(process.argv[4]??5000);
  const generate=`const fs=require('fs');const begin=performance.now(); fs.mkdirSync('src',{recursive:true}); for(let i=0;i<${count};i++)fs.writeFileSync('src/mod'+i+'.ts','export const item'+i+': number = '+i+';\\n'+ '// padding '.repeat(100)+'\\n');console.log(JSON.stringify({files:${count},elapsedMs:performance.now()-begin}));`;
  await call(name,{op:"exec",backend:"container",sync:"defer",command:`node -e ${quote(generate)}`},"generate-source-deferred");
  await call(name,{op:"pull"},"source-pull");
  await call(name,memory(),"memory-before-build");
  await call(name,{op:"exec",backend:"container",sync:"defer",timeoutMs:300000,command:`node -e ${quote(`const cp=require('child_process');const start=performance.now(); const r=cp.spawnSync('tsc',['--target','ES2022','--outDir','build',...require('fs').readdirSync('src').map(x=>'src/'+x)],{stdio:'inherit'});console.log(JSON.stringify({compilerMs:performance.now()-start,files:${count},exit:r.status}));process.exit(r.status??1);`)}`},"typescript-build-deferred");
  await call(name,{op:"pull"},"build-pull");
  await call(name,{op:"exec",backend:"worker-shell",command:`find build -type f | wc -l; head -c 100 build/mod${count-1}.js`},"shell-build-verification");
  await call(name,memory(),"memory-after-build");
  await call(name,{op:"status"},"status-after-build");
} else if(mode==="failure") {
  await call(name,{op:"idle",idleMs:1000},"set-short-inactivity");
  const sleepy=call(name,{op:"exec",backend:"container",command:"printf 'started\\n' > before-sleep.txt; sleep 15; printf 'finished\\n' > after-sleep.txt; echo completed"},"command-with-short-idle");
  await new Promise(r=>setTimeout(r,8000)); await call(name,{op:"status"},"status-during-idle-command"); await sleepy;
  const interrupted=call(name,{op:"exec",backend:"container",command:"printf 'unsynced\\n' > before-destroy.txt; sleep 60; echo unexpected > after-destroy.txt",timeoutMs:90000},"destroy-mid-command",110000);
  await new Promise(r=>setTimeout(r,5000)); await call(name,{op:"stop"},"force-destroy"); await interrupted;
  await call(name,{op:"exec",backend:"worker-shell",command:"cat from-container.txt; cat before-destroy.txt"},"durable-files-after-destroy");
  await call(name,{op:"exec",backend:"container",command:"cat from-container.txt; echo recovered"},"container-recovery");
  await call(name,{op:"status"},"status-after-recovery");
} else if(mode==="close") await call(name,{op:"close"},"close-and-stop");
else if(mode==="call") await call(name,JSON.parse(process.argv[4]),process.argv[5]??"manual");
else throw Error("Invalid mode");

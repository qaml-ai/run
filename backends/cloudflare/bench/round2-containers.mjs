import {readFile,writeFile} from 'node:fs/promises';
import {request as httpsRequest} from 'node:https';
const base=process.env.COMPUTER_BENCH_URL;
if(!base||!/^https:\/\/camelrun-proto-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(base))throw new Error('Set prefixed benchmark URL');
const token=(await readFile(new URL('./.state/api-token',import.meta.url),'utf8')).trim();
const output=process.env.COMPUTER_BENCH_OUTPUT ? new URL(process.env.COMPUTER_BENCH_OUTPUT,'file://'+process.cwd()+'/') : new URL('../docs/round2-containers.json',import.meta.url);
let report;try{report=JSON.parse(await readFile(output,'utf8'));}catch{report={startedAt:new Date().toISOString(),records:[],failures:[]};}
async function persist(){const text=JSON.stringify(report,null,2);if(text.includes(token)||process.env.CLOUDFLARE_API_TOKEN&&text.includes(process.env.CLOUDFLARE_API_TOKEN))throw new Error('Secret in output');await writeFile(output,text+'\n');}
// Node fetch has a separate five-minute header timeout. Long native builds need
// a client whose deadline matches the explicitly bounded container operation.
async function send(url,body){return new Promise((resolve,reject)=>{
 const encoded=JSON.stringify(body);const chunks=[];let bytes=0;
 const req=httpsRequest(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json','content-length':Buffer.byteLength(encoded)}},response=>{
  response.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576){req.destroy(new Error('Response too large'));return;}chunks.push(chunk);});
  response.on('end',()=>resolve({status:response.statusCode,ok:response.statusCode>=200&&response.statusCode<300,text:Buffer.concat(chunks).toString('utf8')}));response.on('error',reject);
 });const timer=setTimeout(()=>req.destroy(new Error('Benchmark client deadline exceeded')),1050000);req.on('error',reject);req.on('close',()=>clearTimeout(timer));req.end(encoded);
});}
async function call(size,op,label=op.op,slot='main'){
 const at=new Date().toISOString(),start=performance.now();
 try{
  const response=await send(base+`/v1/${size}/${slot}`,op);
  const text=response.text;let result;try{result=JSON.parse(text);}catch{result={error:`Non-JSON ${response.status}`,text:text.slice(0,500)};}
  if(result.stdout){try{result.parsedStdout=result.stdout.trim().split('\n').map(x=>JSON.parse(x));delete result.stdout;}catch{}}
  const record={at,size,slot,label,clientMs:performance.now()-start,status:response.status,result};report.records.push(record);await persist();console.log(JSON.stringify({at,size,label,clientMs:record.clientMs,status:response.status,elapsedMs:result.elapsedMs,exitCode:result.exitCode,snapshot:result.snapshot}));
  if(!response.ok||result.exitCode!==undefined&&result.exitCode!==0)throw new Error('Operation failed: '+label);
  return result;
 }catch(e){report.failures.push({at,size,label,error:String(e),code:e.code??e.cause?.code});await persist();throw e;}
}
const exec=(size,argv,label,timeoutMs=1000000)=>call(size,{op:'exec',argv,timeoutMs},label);
const stage=process.argv[2]??'all';
const selectedSize=process.env.COMPUTER_BENCH_SIZE??'basic';
if(!['basic','standard-2'].includes(selectedSize))throw new Error('Unknown size');
if(stage==='small'||stage==='all'){
 const size='basic';await call(size,{op:'stop'});await exec(size,['node','/opt/workload.mjs','small'],'small-prepare');
 await exec(size,['node','-e',"const fs=require('fs');const cp=require('child_process');const c=cp.spawn('sleep',['321'],{detached:true,stdio:'ignore'});c.unref();fs.writeFileSync('/workspace/pid',String(c.pid));console.log(JSON.stringify({pid:c.pid}))"],'small-process-start');
 await call(size,{op:'snapshot',name:'camelrun-proto-r2-small'},'small-snapshot');
 await exec(size,['node','-e',"require('fs').writeFileSync('/workspace/marker','dirty')"],'small-dirty');
 await call(size,{op:'stop'},'small-destroy');
 await call(size,{op:'restore',name:'camelrun-proto-r2-small'},'small-restore');
 await exec(size,['node','-e',"const fs=require('fs');const pid=fs.readFileSync('/workspace/pid','utf8');let command=null;try{command=fs.readFileSync('/proc/'+pid+'/cmdline','utf8')}catch{};console.log(JSON.stringify({marker:fs.readFileSync('/workspace/marker','utf8'),outside:fs.readFileSync('/tmp/outside-workspace','utf8'),pid,command,processRestored:command?.includes('sleep\\u0000321')??false}));"],'small-verify');
}
if(stage==='build'||stage==='all'){
 await Promise.all(['basic','standard-2'].map(async size=>{
  if(size==='standard-2')await call(size,{op:'stop'});
  for(const step of ['clone','install','build'])await exec(size,['node','/opt/workload.mjs',step],step);
  await exec(size,['node','/opt/workload.mjs','scan'],'large-scan');
 }));
}
if(stage==='large'||stage==='all'){
 const size=selectedSize;await call(size,{op:'snapshot',name:'camelrun-proto-r2-large'},'large-snapshot');
 await exec(size,['node','-e',"require('fs').writeFileSync('/workspace/repo/package.json','dirty')"],'large-dirty');
 await call(size,{op:'stop'},'large-destroy');await call(size,{op:'restore',name:'camelrun-proto-r2-large'},'large-restore');
 await exec(size,['node','/opt/workload.mjs','scan'],'large-restored-scan');
 await exec(size,['node','-e',"const fs=require('fs');console.log(JSON.stringify({package:JSON.parse(fs.readFileSync('/workspace/repo/package.json','utf8')).name,built:fs.existsSync('/workspace/repo/built/local/typescript.js')}))"],'large-verify');
}
if(stage==='repeat-build')await exec(selectedSize,['sh','-c','cd /workspace/repo && rm -rf built && /usr/bin/time -v npm run build:compiler'],'repeat-clean-build');
if(stage==='recover-build')await exec(selectedSize,['node','-e',"const fs=require('fs');console.log(fs.readFileSync('/workspace/build.json','utf8'));console.log(JSON.stringify({built:fs.existsSync('/workspace/repo/built/local/typescript.js')}))"],'build-recovered');
if(stage==='diagnose')await exec(selectedSize,['sh','-c','dmesg | tail -70; cat /proc/meminfo; cat /proc/vmstat'],'kernel-memory-diagnostics',30000);
if(stage==='restore-small'){
 await call('basic',{op:'restore',name:'camelrun-proto-r2-small'},'restore-after-image-tag-delete');
 await exec('basic',['node','-e',"const fs=require('fs');console.log(JSON.stringify({marker:fs.readFileSync('/workspace/marker','utf8'),outside:fs.readFileSync('/tmp/outside-workspace','utf8'),node:process.version}));"],'verify-after-image-tag-delete');
}
if(stage==='integrity'){
 const code="const fs=require('fs'),path=require('path'),crypto=require('crypto');const h=crypto.createHash('sha256');let files=0,bytes=0;function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const n=path.join(p,e.name);h.update(n);if(e.isDirectory())walk(n);else if(e.isFile()){const b=fs.readFileSync(n);files++;bytes+=b.length;h.update(b)}else if(e.isSymbolicLink())h.update(fs.readlinkSync(n));}}walk('/workspace/repo');console.log(JSON.stringify({files,bytes,sha256:h.digest('hex'),typescriptVersion:require('/workspace/repo/built/local/typescript.js').version}));";
 const before=await exec(selectedSize,['node','-e',code],'integrity-before');
 await exec(selectedSize,['node','-e',"require('fs').writeFileSync('/workspace/repo/built/local/typescript.js','dirty')"],'integrity-dirty');
 await call(selectedSize,{op:'stop'},'integrity-destroy');await call(selectedSize,{op:'restore',name:'camelrun-proto-r2-large'},'integrity-restore');
 const after=await exec(selectedSize,['node','-e',code],'integrity-after');
 const equal=JSON.stringify(before.parsedStdout)===JSON.stringify(after.parsedStdout);report.integrityEqual=equal;await persist();if(!equal)throw new Error('Aggregate file hash mismatch');
}
if(stage==='cleanup')for(const size of ['basic','standard-2'])await call(size,{op:'cleanup'},'cleanup');
if(stage==='cleanup-one')await call(selectedSize,{op:'cleanup'},'cleanup');
console.log(JSON.stringify({output:output.pathname,records:report.records.length,failures:report.failures.length}));

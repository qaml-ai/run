import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const op=process.argv[2];
function read(path){try{return readFileSync(path,'utf8').trim();}catch{return null;}}
function resources(){return {memoryCurrent:read('/sys/fs/cgroup/memory.current'),memoryPeak:read('/sys/fs/cgroup/memory.peak'),memoryEvents:read('/sys/fs/cgroup/memory.events'),cpuStat:read('/sys/fs/cgroup/cpu.stat')}}
function scan(root){let files=0,bytes=0;for(const ent of readdirSync(root,{withFileTypes:true})){const p=join(root,ent.name);if(ent.isDirectory()){const s=scan(p);files+=s.files;bytes+=s.bytes;}else if(ent.isFile()){files++;bytes+=statSync(p).size;}}return {files,bytes};}
async function run(label,argv,cwd='/workspace'){
 const start=performance.now(), before=resources();let tail='';
 const child=spawn(argv[0],argv.slice(1),{cwd,env:{...process.env,CI:'1',HOME:'/tmp',PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1'},detached:true,stdio:['ignore','pipe','pipe']});
 for(const s of [child.stdout,child.stderr]) s.on('data',b=>{tail=(tail+b.toString()).slice(-6000);});
 const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},900000);
 const result=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);
 const record={label,argv,elapsedMs:performance.now()-start,...result,tail,before,after:resources()};
 writeFileSync('/workspace/'+label+'.json',JSON.stringify(record)); console.log(JSON.stringify(record));if(result.code!==0) process.exitCode=1;
}
if(op==='small'){
 rmSync('/workspace',{recursive:true,force:true});mkdirSync('/workspace',{recursive:true});mkdirSync('/workspace/small');
 for(let i=0;i<20;i++) writeFileSync('/workspace/small/'+i+'.txt','x'.repeat(12000)+i);
 writeFileSync('/workspace/marker','small-snapshot');writeFileSync('/tmp/outside-workspace','outside-persisted');console.log(JSON.stringify({workspace:scan('/workspace'),resources:resources()}));
}else if(op==='clone'){
 rmSync('/workspace/repo',{recursive:true,force:true});
 await run('clone',['git','clone','--depth','1','--branch','v5.9.3','https://github.com/microsoft/TypeScript.git','repo']);
 if(!process.exitCode) console.log(JSON.stringify({checkout:read('/workspace/repo/.git/HEAD'),workspace:scan('/workspace/repo')}));
}else if(op==='install'){
 await run('install',['npm','ci','--no-audit','--no-fund'],'/workspace/repo');
 if(!process.exitCode)console.log(JSON.stringify({workspace:scan('/workspace/repo'),nodeModules:scan('/workspace/repo/node_modules')}));
}else if(op==='build'){
 await run('build',['npm','run','build:compiler'],'/workspace/repo');
 if(!process.exitCode)console.log(JSON.stringify({workspace:scan('/workspace/repo'),built:existsSync('/workspace/repo/built/local/typescript.js')}));
}else if(op==='scan') console.log(JSON.stringify({workspace:scan('/workspace'),nodeModules:existsSync('/workspace/repo/node_modules')?scan('/workspace/repo/node_modules'):null,resources:resources()}));
else throw new Error('Unknown workload');

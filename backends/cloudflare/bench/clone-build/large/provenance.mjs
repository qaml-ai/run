import {readFile,writeFile} from 'node:fs/promises';
import {Client} from '../runner.mjs';
const [key,url]=process.argv.slice(2);
if(!['s2','s4'].includes(key)||!url?.startsWith(`https://camelrun-proto-bench-${key}-worker.`))throw new Error('Unexpected benchmark target');
const base=new URL(`./.state/${key}`,import.meta.url);
const resultFile=new URL(base.href+'-result.json');
const result=JSON.parse(await readFile(resultFile,'utf8'));
if(result.record.state!=='completed')throw new Error('Wait until the agent completes');
const client=new Client(url,(await readFile(new URL(base.href+'.token'),'utf8')).trim());
result.provenance={};
for(const step of ['rust-install','ripgrep-build']){
 const data=await client.operate(result.agent.id,{op:'read',path:`/workspace/${step}.log`,timeoutMs:120000});
 await writeFile(new URL(base.href+`-${step}.log`),data.content??data.stdout??'');
 result.provenance[step]={bytes:(data.content??data.stdout??'').length,exitCode:data.exitCode};
}
result.provenance.versions=await client.operate(result.agent.id,{op:'exec',argv:['/bin/bash','-lc','export PATH=/root/.cargo/bin:$PATH; rustup --version; rustup show; cargo --version; rustc --version --verbose; ls -l /root/.cargo/bin; head -n 35 /workspace/rust-install.log; du -sb /root/.rustup /root/.cargo; ps -eo pid,comm,args | head -n 12'],timeoutMs:120000});
await writeFile(resultFile,JSON.stringify(result,null,2));
console.log(JSON.stringify(result.provenance,null,2));

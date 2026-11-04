// No shell interpolation or secret output; the CF token stays only in process.env.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class Client {
  constructor(url,token){this.url=url.replace(/\/$/,'');this.token=token;}
  async call(path,body,method){
    const r=await fetch(this.url+path,{method:method??(body===undefined?'GET':'POST'),headers:{authorization:`Bearer ${this.token}`,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(1250000)});
    const text=await r.text(); let value;try{value=JSON.parse(text)}catch{value={text:text.slice(0,1000)}}
    if(!r.ok)throw new Error(`HTTP ${r.status} ${path}: ${JSON.stringify(value).slice(0,1000)}`);return value;
  }
  async create(key){
    const r=await fetch(this.url+'/v1/agents',{method:'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json','Idempotency-Key':key},body:JSON.stringify({fileTools:false,codeMode:false,thinkingLevel:'off',systemPrompt:'You are executing a measured benchmark. Use the computer tool to provision your own Linux computer and actually run the requested commands. A failed step must be reported accurately. Keep each timing separate.'})});
    const value=await r.json();if(!r.ok)throw new Error(`Create HTTP ${r.status}: ${JSON.stringify(value)}`);return {id:value.id};
  }
  operate(id,op){return this.call(`/bench/agents/${id}/operate`,op);}
}
export async function run({url,tokenFile,output,label}){
  const token=(await readFile(tokenFile,'utf8')).trim(),client=new Client(url,token);
  const unauthorized=await fetch(url+'/healthz');if(unauthorized.status!==401)throw new Error('Bearer protection check failed');
  const result={label,url,startedAt:new Date().toISOString(),authStatus:unauthorized.status,prompt:await readFile(new URL('./prompt.txt',import.meta.url),'utf8')};
  await mkdir(dirname(output),{recursive:true});
  const save=()=>writeFile(output,JSON.stringify(result,null,2));
  const before=performance.now();result.agent=await client.create(`clone-build-${label}-${randomUUID().slice(0,8)}`);result.agentProvisionMs=performance.now()-before;
  await save();
  result.submission=await client.call(`/clients/${result.agent.id}/requests`,{id:'clone-build',method:'prompt',params:{text:result.prompt,history:'none'}});
  await save();let lastCalls=-1;
  const deadline=Date.now()+75*60_000;
  while(Date.now()<deadline){
    try{
      result.trace=await client.call(`/bench/agents/${result.agent.id}/trace`);
      result.record=await client.call(`/clients/${result.agent.id}/requests/clone-build?wait=1`);
      await save();
      if(result.trace.calls.length!==lastCalls){lastCalls=result.trace.calls.length;console.log(JSON.stringify({label,agent:result.agent.id,modelCalls:result.trace.modelCalls,toolCalls:lastCalls,last:result.trace.calls.at(-1)}));}
      if(result.record.state==='completed')break;
    }catch(error){console.log(JSON.stringify({label,pollError:String(error)}));}
    await sleep(5000);
  }
  result.history=await client.call(`/clients/${result.agent.id}/history`);
  result.agentEndedAt=new Date().toISOString();await save();
  console.log(JSON.stringify({label,status:result.record?.status,modelCalls:result.trace?.modelCalls,agent:result.agent.id}));
  return result;
}
export function lifecycleVerification(lifecycle,snapshot){
 const check=lifecycle.beforeSnapshot?.value,after=lifecycle.afterRestore?.value;
 const beforeHash=/^([a-f0-9]{64})\s+.*ripgrep\/target\/release\/rg$/m.exec(check?.stdout??'')?.[1];
 const afterHash=/^([a-f0-9]{64})\s+.*ripgrep\/target\/release\/rg$/m.exec(after?.stdout??'')?.[1];
 const sleepObserved=lifecycle.sleepState?.value?.running===false;
 const restoreSucceeded=Boolean(snapshot&&lifecycle.restore?.value?.restored===true);
 const verifiedRestore=restoreSucceeded&&after?.exitCode===0;
 const directoryBytes=(stdout,path)=>new RegExp(`^(\\d+)[\\t ]+${path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}[\\t ]*$`,'m').exec(stdout??'')?.[1]??null;
 const beforeCheckoutBytes=directoryBytes(check?.stdout,'/workspace/ripgrep'),afterCheckoutBytes=directoryBytes(after?.stdout,'/workspace/ripgrep');
 const beforeTargetBytes=directoryBytes(check?.stdout,'/workspace/ripgrep/target'),afterTargetBytes=directoryBytes(after?.stdout,'/workspace/ripgrep/target');
 return {sleepObserved,markerSurvivedSleep:sleepObserved&&(lifecycle.wake?.value?.stdout?.includes('camelrun-clone-build-persist')??false),builtTargetPresent:Boolean(beforeHash),restoreSucceeded,beforeHash:beforeHash??null,afterHash:afterHash??null,builtBinaryRestored:Boolean(verifiedRestore&&beforeHash&&beforeHash===afterHash),markerRestored:Boolean(verifiedRestore&&after?.stdout?.includes('camelrun-clone-build-persist')),beforeCheckoutBytes,afterCheckoutBytes,beforeTargetBytes,afterTargetBytes,checkoutSizeRestored:Boolean(verifiedRestore&&beforeCheckoutBytes&&beforeCheckoutBytes===afterCheckoutBytes),targetSizeRestored:Boolean(verifiedRestore&&beforeTargetBytes&&beforeTargetBytes===afterTargetBytes)};
}
export async function lifecycle({url,tokenFile,output,label}){
 const result=JSON.parse(await readFile(output,'utf8')),client=new Client(url,(await readFile(tokenFile,'utf8')).trim());
 const id=result.agent.id;const save=()=>writeFile(output,JSON.stringify(result,null,2));
 result.lifecycle??={};
 const measure=async(name,op)=>{const started=performance.now();try{const value=await client.operate(id,op);result.lifecycle[name]={wallMs:performance.now()-started,value};await save();return value;}catch(error){result.lifecycle[name]={wallMs:performance.now()-started,error:String(error)};await save();return null;}};
 await measure('writeMarker',{op:'write',path:'/workspace/persistence-marker',content:'camelrun-clone-build-persist\n'});
 await measure('readMarker',{op:'read',path:'/workspace/persistence-marker'});
 const check=await measure('beforeSnapshot',{op:'exec',argv:['/bin/bash','-lc','printf "camelrun-clone-build-persist\\n" > /workspace/persistence-marker; test -x /workspace/ripgrep/target/release/rg && /workspace/ripgrep/target/release/rg --version; sha256sum /workspace/ripgrep/target/release/rg; du -sb /workspace/ripgrep; du -sb /workspace/ripgrep/target; df -h /workspace'],timeoutMs:120000});
 const captured=check?.exitCode===0?await measure('snapshot',{op:'snapshot',name:`camelrun-proto-bench-${label}-${Date.now()}`,timeoutMs:1200000}):null;
 await measure('setSleep',{op:'sleep',idleMs:5000});
 // Do not contact the object while idle: DO traffic postpones sleep.
 await sleep(60000);
 await measure('sleepState',{op:'status'});
 await measure('wake',{op:'exec',argv:['/bin/bash','-lc','uname -m; if test -f /workspace/persistence-marker; then cat /workspace/persistence-marker; else echo MARKER_LOST; fi; test -x /workspace/ripgrep/target/release/rg && /workspace/ripgrep/target/release/rg --version; true'],timeoutMs:120000});
 const snapshot=captured?.snapshot;
 if(snapshot){await measure('restore',{op:'restore',name:snapshot.name,timeoutMs:1200000});await measure('afterRestore',{op:'exec',argv:['/bin/bash','-lc','cat /workspace/persistence-marker; /workspace/ripgrep/target/release/rg --version; sha256sum /workspace/ripgrep/target/release/rg; du -sb /workspace/ripgrep; du -sb /workspace/ripgrep/target; df -h /workspace'],timeoutMs:120000});}
 result.lifecycle.verification=lifecycleVerification(result.lifecycle,snapshot);
 await measure('stop',{op:'stop'});result.endedAt=new Date().toISOString();result.trace=await client.call(`/bench/agents/${id}/trace`);await save();return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,url,tokenFile,output,label]=process.argv.slice(2);if(!['run','lifecycle'].includes(mode)||!label)throw new Error('runner.mjs run|lifecycle URL TOKEN_FILE OUTPUT LABEL');
 await (mode==='run'?run:lifecycle)({url,tokenFile,output,label});
}

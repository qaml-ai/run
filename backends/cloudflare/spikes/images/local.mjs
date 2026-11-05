// Fresh workerd process per case; real local R2 and Pi SQLite, CDP isolate heap.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { fixture } from './fixture.mjs';
const cwd=resolve(import.meta.dirname,'../..');
const directory=await mkdtemp(`${tmpdir()}/camelrun-image-study-`);
const config=JSON.parse(await readFile(resolve(import.meta.dirname,'wrangler.jsonc'),'utf8'));
config.main=resolve(import.meta.dirname,'worker.ts');
for(const binding of config.durable_objects.bindings)binding.class_name='CamelrunProtoHybridImages';
config.migrations=[{tag:'v1',new_sqlite_classes:['CamelrunProtoHybridImages']}];
const localConfig=resolve(directory,'wrangler.json');await writeFile(localConfig,JSON.stringify(config));
const token='synthetic-local-image-benchmark-token';
const port=19261, inspector=19262, base=`http://127.0.0.1:${port}`;
const report={at:new Date().toISOString(),kind:'local workerd CDP',cases:[],fixture:{},limitations:['CDP JS heap plus embedder/backing-store fields, not a production isolate memory sample.','Fresh process per case; original R2 objects shared through local persisted storage.','Image requests deliberately unbounded to show the ceiling; no model provider is called.']};
let child, logs='';
async function start() {
  logs='';child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','-c',localConfig,'--port',String(port),'--inspector-port',String(inspector),'--persist-to',directory,'--var',`API_TOKEN:${token}`],{cwd,env:{...process.env,WRANGLER_LOG_PATH:resolve(cwd,'spikes/images/.wrangler/logs'),WRANGLER_SEND_METRICS:'false',BROWSER:'none'},stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream.on('data',v=>logs=(logs+v).slice(-12000));
  for(let i=0;i<200;i++) {try {if((await fetch(`${base}/none`)).status===401)return;}catch{};await new Promise(r=>setTimeout(r,100));}
  throw Error(`local Worker failed: ${logs}`);
}
async function stop(){if(!child)return;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);child.kill('SIGKILL');child=undefined;}
async function call(path,input) {
  const start=performance.now();try{const response=await fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input??{}),signal:AbortSignal.timeout(120000)});return {status:response.status,ms:performance.now()-start,data:await response.json()};}catch(error){return {error:error.message,ms:performance.now()-start};}
}
async function heap() {
  const list=await fetch(`http://127.0.0.1:${inspector}/json/list`).then(r=>r.json());
  const target=list.find(x=>x.title?.includes('camelrun-proto-hybrid-images'))??list.find(x=>x.webSocketDebuggerUrl);
  if(!target)throw Error('inspector target missing');
  const socket=new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((ok,no)=>{socket.once('open',ok);socket.once('error',no);});
    return await new Promise((ok,no)=>{socket.on('message',raw=>{const value=JSON.parse(raw.toString());if(value.id===1){if(value.error)no(Error(JSON.stringify(value.error)));else ok(value.result);}});socket.send(JSON.stringify({id:1,method:'Runtime.getHeapUsage'}));setTimeout(()=>no(Error('heap timeout')),10000).unref();});
  } catch(error) {return {error:error.message};} finally {socket.close();}
}
async function save(){await writeFile(resolve(cwd,'docs/hybrid-images-local.json'),JSON.stringify(report,null,2)+'\n');}
try {
  await start();
  let min=Infinity,max=0,total=0;
  for(let i=0;i<100;i++) {
    const png=fixture(i+1);min=Math.min(min,png.length);max=Math.max(max,png.length);total+=png.length;
    const response=await fetch(`${base}/fixture/${i}`,{method:'PUT',headers:{authorization:`Bearer ${token}`},body:png});
    if(!response.ok)throw Error(`fixture ${i}: HTTP ${response.status}`);
  }
  report.fixture={count:100,distinctContents:51,width:1600,height:1200,minBytes:min,maxBytes:max,totalBytes:total,description:'Indexed grayscale-noise screenshot fixture with title and sidebar; v1 seed mapping pairs adjacent seeds'};
  await stop();await save();
  const selected=process.argv.slice(2);
  for(const mode of ['inline','reference','cached']) for(const count of [20,100]) {
    if(selected.length&&!selected.includes(`${mode}-${count}`))continue;
    await start();const id=`${mode}-${count}`,row={mode,count};report.cases.push(row);
    row.prepare=await call(`/case/${id}/prepare`);row.baseline=await heap();await save();
    row.seed=await call(`/case/${id}/seed`,{mode,count});row.afterSeed=await heap();await save();
    if(mode==='inline'&&row.seed.data?.error)row.materialized=await call(`/case/${id}/inlineMemory`,{count});
    else if(mode!=='inline')row.request=await call(`/case/${id}/request`,{mode,count,urlMode:mode==='cached'});
    row.afterRequest=await heap();row.status=await call(`/case/${id}/status`);
    if(mode==='cached') {row.reuse=await call(`/case/${id}/request`,{mode,count,urlMode:true});row.afterReuse=await heap();}
    await save();console.log(JSON.stringify(row));await stop();
  }
} finally {await stop();await rm(directory,{recursive:true,force:true});}

// Exactly one synthetic native Container; no database or provider credentials.
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root=resolve(import.meta.dirname,'../..'),name='camelrun-proto-platform-container',account='85bbd288051330fb51ee1c86031a299b';
const token=process.env.CLOUDFLARE_API_TOKEN;if(!token)throw Error('Cloudflare credential unavailable');
const bearer=randomBytes(32).toString('hex'),state=await mkdtemp(join(tmpdir(),'camelrun-platform-container-'));
await mkdir(join(state,'docker'));
// Retain the installed buildx plugin while keeping registry login state ephemeral.
await writeFile(join(state,'docker','config.json'),JSON.stringify({cliPluginsExtraDirs:[join(homedir(),'.docker/cli-plugins'),'/opt/homebrew/lib/docker/cli-plugins','/Applications/Docker.app/Contents/Resources/cli-plugins']}));
const report={name,account,startedAt:new Date().toISOString(),budgetUsd:5,operations:[],cleanup:{}};
const path=join(root,'measurements/platform-container-cloud.json');
const clean=value=>String(value).replaceAll(token,'[redacted]').replaceAll(bearer,'[redacted]').replace(/\u001b\[[0-9;]*m/g,'');
const save=()=>writeFile(path,clean(JSON.stringify(report,null,2))+'\n');
const phase=value=>{console.log(value);report.operations.push({phase:value,at:new Date().toISOString()});};
async function api(suffix,method='GET',body){
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${suffix}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  const result=await response.json();
  if(!response.ok||result.success===false)throw Error(`Cloudflare ${method} ${suffix}: HTTP ${response.status} ${clean(JSON.stringify(result.errors??result))}`);
  return result.result??result;
}
async function wrangler(args,input){
  const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{cwd:root,env:{...process.env,CLOUDFLARE_ACCOUNT_ID:account,DOCKER_CONFIG:join(state,'docker'),WRANGLER_LOG_PATH:join(state,'logs'),WRANGLER_SEND_METRICS:'false',CI:'true'},stdio:['pipe','pipe','pipe']});
  let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);child.stdin.end(input);
  const timer=setTimeout(()=>child.kill('SIGTERM'),300000),code=await new Promise(r=>child.once('close',r));clearTimeout(timer);
  if(code!==0)throw Error(`Wrangler ${args[0]} failed (${code}): ${clean(output.slice(-5000))}`);
  report.operations.push({command:args.join(' '),exitCode:code});await save();return output;
}
async function images(){
  const output=await wrangler(['containers','images','list','--filter',name,'--json','-c','probes/computers/wrangler.jsonc']);
  return JSON.parse(output.slice(output.indexOf('[')));
}
async function namespaces(){const rows=[];for(let page=1;page<=20;page++){const found=await api(`/workers/durable_objects/namespaces?per_page=1000&page=${page}`);rows.push(...found);if(found.length<1000)break;}return rows;}
const applications=async()=>{const value=await api('/containers/applications');return Array.isArray(value)?value:value.applications??[];};
let owned=false,base;
try{
  phase('preflight');
  const [workers,ns,apps,priorImages]=await Promise.all([api('/workers/scripts'),namespaces(),applications(),images()]);
  if(workers.some(w=>w.id===name)||ns.some(n=>n.script===name)||apps.some(a=>a.name===name)||priorImages.length)throw Error('Probe name already exists; refusing reuse');
  owned=true;report.preflight={worker:false,namespace:false,application:false,images:[]};
  base=`https://${name}.${(await api('/workers/subdomain')).subdomain}.workers.dev`;
  phase('deploying');await wrangler(['deploy','-c','probes/computers/wrangler.jsonc']);
  await wrangler(['secret','put','PROBE_TOKEN','-c','probes/computers/wrangler.jsonc'],bearer+'\n');
  for(let i=0;i<45;i++){
    const health=await fetch(base+'/health',{headers:{authorization:`Bearer ${bearer}`},signal:AbortSignal.timeout(10000)});
    const ready=health.ok&&(await health.json().catch(()=>null))?.ok;
    await health.body?.cancel().catch(()=>{});
    if(ready)break;
    if(i===44)throw Error('Worker health did not propagate within 90 seconds');
    await new Promise(r=>setTimeout(r,2000));
  }
  phase('executing');
  let response;for(let i=0;i<45;i++){response=await fetch(base+'/run',{method:'POST',headers:{authorization:`Bearer ${bearer}`},signal:AbortSignal.timeout(90000)});if(![401,404].includes(response.status)||i===44)break;await response.body?.cancel();await new Promise(r=>setTimeout(r,1000));}
  report.status=response.status;const result=await response.text();try{report.result=JSON.parse(result);}catch{report.result=clean(result.slice(0,1500));}await save();
  if(!response.ok||report.result.command?.exitCode!==0||report.result.command?.stdout!=='container-probe-ready'||report.result.read?.content!=='synthetic-container-file')throw Error('Native container lifecycle assertions failed');
  report.applications=(await applications()).filter(a=>a.name===name).map(a=>({id:a.id,name:a.name}));
  for(const app of report.applications)report.instancesAfterStop=await api(`/containers/applications/${app.id}/instances-v2`);
  phase('verified');
}catch(error){report.error=clean(error);await save();process.exitCode=1;}
finally{
  phase('cleanup');const errors=[];const attempt=async(label,run)=>{try{return await run();}catch(error){errors.push({label,error:clean(error)});}};
  if(owned){
    const workers=await attempt('worker inventory',()=>api('/workers/scripts'));
    if(workers?.some(w=>w.id===name))await attempt('stop',async()=>{const response=await fetch(base+'/stop',{method:'POST',headers:{authorization:`Bearer ${bearer}`},signal:AbortSignal.timeout(45000)});report.cleanup.stopStatus=response.status;await response.body?.cancel();});
    const apps=await attempt('application inventory',applications);
    for(const app of apps?.filter(a=>a.name===name)??[])await attempt('delete application',()=>api(`/containers/applications/${app.id}`,'DELETE'));
    if(workers?.some(w=>w.id===name)){
      const config=JSON.parse(await readFile(join(root,'probes/computers/wrangler.jsonc'),'utf8'));
      config.main=join(root,'probes/computers/empty.ts');config.containers=[];config.durable_objects={bindings:[]};config.migrations.push({tag:'delete-container',deleted_classes:['ContainerComputer']});
      const teardown=join(state,'teardown.json');await writeFile(teardown,JSON.stringify(config));
      await attempt('delete namespace',()=>wrangler(['deploy','-c',teardown]));await attempt('delete worker',()=>api(`/workers/scripts/${name}`,'DELETE'));
    }
    const made=await attempt('image inventory',images);
    report.cleanup.deletedImages=[];
    for(const image of made??[])for(const tag of image.tags??[])await attempt('delete image',async()=>{await wrangler(['containers','images','delete',`${image.name}:${tag}`,'-y','-c','probes/computers/wrangler.jsonc']);report.cleanup.deletedImages.push(`${image.name}:${tag}`);});
    report.cleanup.workers=(await attempt('workers final',()=>api('/workers/scripts')))?.filter(w=>w.id===name).map(w=>w.id);
    report.cleanup.namespaces=(await attempt('namespaces final',namespaces))?.filter(n=>n.script===name).map(n=>({id:n.id,name:n.name}));
    report.cleanup.applications=(await attempt('applications final',applications))?.filter(a=>a.name===name).map(a=>({id:a.id,name:a.name}));
    report.cleanup.images=await attempt('images final',images);
  }else report.cleanup.skipped='Preflight did not establish ownership';
  report.cleanup.errors=errors;report.endedAt=new Date().toISOString();await save();await rm(state,{recursive:true,force:true});
  report.cleanup.verifiedAbsent=owned&&['workers','namespaces','applications','images'].every(key=>Array.isArray(report.cleanup[key])&&report.cleanup[key].length===0);
  if(errors.length||owned&&!report.cleanup.verifiedAbsent)process.exitCode=1;
  await save();
}
console.log(clean(JSON.stringify(report,null,2)));

// Own exactly these synthetic resources; credentials remain in memory and secret stdin.
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..'),name='camelrun-proto-platform-files',account='85bbd288051330fb51ee1c86031a299b';
const token=process.env.CLOUDFLARE_API_TOKEN;if(!token)throw new Error('Cloudflare credential unavailable');
const bearer=randomBytes(32).toString('hex'),state=await mkdtemp(join(tmpdir(),'camelrun-platform-files-'));
const report={name,startedAt:new Date().toISOString(),operations:[],cleanup:{}};
const path=join(root,'measurements/platform-files-cloud.json');
function safe(value){const text=JSON.stringify(value,null,2);if([token,bearer].some(secret=>text.includes(secret)))throw Error('Credential output refused');return text;}
async function save(){await writeFile(path,safe(report)+'\n');}
async function api(suffix,method='GET',body){const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${suffix}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const result=await response.json();if(!response.ok||result.success===false)throw Error(`Cloudflare ${method} ${suffix}: HTTP ${response.status} ${safe(result.errors)}`);return result.result??result;}
async function wrangler(args,input){const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{cwd:root,env:{...process.env,WRANGLER_LOG_PATH:join(state,'logs'),WRANGLER_SEND_METRICS:'false'},stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);child.stdin.end(input);const code=await new Promise(r=>child.once('close',r));if(code!==0)throw Error(`Wrangler ${args[0]} failed (${code}): ${safe(output.slice(-4000))}`);report.operations.push({command:args.join(' '),exitCode:code});await save();}
async function namespaces(){const result=[];for(let page=1;page<=20;page++){const rows=await api(`/workers/durable_objects/namespaces?per_page=1000&page=${page}`);result.push(...rows);if(rows.length<1000)break;}return result;}
async function hasBucket(){try{return (await api(`/r2/buckets/${name}`)).name===name;}catch(e){if(String(e).includes('HTTP 404'))return false;throw e;}}
let owned=false,worker=false,bucket=false,base;
try {
  const workers=await api('/workers/scripts'),ns=await namespaces();
  if(workers.some(w=>w.id===name)||ns.some(n=>n.script===name)||await hasBucket())throw Error('Probe name already exists; refusing reuse');
  owned=true;report.preflight={worker:false,namespace:false,bucket:false};
  base=`https://${name}.${(await api('/workers/subdomain')).subdomain}.workers.dev`;
  await api('/r2/buckets','POST',{name});bucket=true;
  await wrangler(['deploy','-c','probes/files/wrangler.jsonc']);worker=true;
  await wrangler(['secret','put','API_TOKEN','-c','probes/files/wrangler.jsonc'],bearer+'\n');
  let response;for(let i=0;i<20;i++){response=await fetch(base+'/run',{method:'POST',headers:{authorization:`Bearer ${bearer}`},signal:AbortSignal.timeout(60000)});if(response.status!==401)break;await new Promise(r=>setTimeout(r,1000));}
  report.status=response.status;report.result=await response.json();await save();
  if(!response.ok||report.result.cas?.success!==1||report.result.cas?.conflicts!==1||!report.result.gc?.pinRetained||!report.result.gc?.pinReleased||!report.result.multipart?.verified)throw Error('Cloud probe assertions failed');
} catch(error){report.error=String(error);await save();process.exitCode=1;}
finally {
  if(owned){const errors=[];const attempt=async(name,fn)=>{try{return await fn();}catch(error){errors.push({name,error:String(error)});}};
    worker||=(await attempt('worker inventory',()=>api('/workers/scripts')))?.some(w=>w.id===name)??false;
    if(worker){report.cleanup.objects=await attempt('objects',async()=>{const response=await fetch(base+'/cleanup',{method:'POST',headers:{authorization:`Bearer ${bearer}`},signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error(`HTTP ${response.status}`);return response.json();});
      const config=JSON.parse(await readFile(join(root,'probes/files/wrangler.jsonc'),'utf8'));
      config.main=join(root,'probes/files/empty.ts');config.durable_objects={bindings:[]};config.migrations.push({tag:'delete-volume',deleted_classes:['Volume']});config.r2_buckets=[];
      const teardown=join(state,'teardown.json');await writeFile(teardown,JSON.stringify(config));
      await attempt('namespace',()=>wrangler(['deploy','-c',teardown]));await attempt('worker',()=>api(`/workers/scripts/${name}`,'DELETE'));
    }
    if(bucket)await attempt('bucket',()=>api(`/r2/buckets/${name}`,'DELETE'));
    report.cleanup.workers=(await attempt('workers final',()=>api('/workers/scripts')))?.filter(w=>w.id===name).map(w=>w.id);
    report.cleanup.namespaces=(await attempt('namespaces final',namespaces))?.filter(n=>n.script===name);
    report.cleanup.bucketExists=await attempt('bucket final',hasBucket);
    report.cleanup.errors=errors;
    if(errors.length||report.cleanup.workers?.length||report.cleanup.namespaces?.length||report.cleanup.bucketExists)process.exitCode=1;
  }else report.cleanup.skipped='Preflight did not establish ownership';
  report.endedAt=new Date().toISOString();await save();await rm(state,{recursive:true,force:true});
}
console.log(safe(report));

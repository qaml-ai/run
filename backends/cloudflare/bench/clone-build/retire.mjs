// Removes only an explicit clone-build config's apps, DO classes and Worker.
// Call after stopping all its machines and collecting usage/evidence.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {account,retirementScope} from './scope.mjs';
const here=dirname(fileURLToPath(import.meta.url)),configPath=resolve(process.argv[2]??'');
if(relative(here,configPath).startsWith('..'))throw new Error('Config must be in clone-build');
const config=JSON.parse(await readFile(configPath,'utf8')),{classes,names}=retirementScope(config);
if(!process.env.CLOUDFLARE_API_TOKEN)throw new Error('Missing CF credential');
const headers={authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`};
async function api(path,method='GET'){
 const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`,{method,headers});
 const body=await r.text(),value=body?JSON.parse(body):{};
 if(!r.ok||value.success===false)throw new Error(`${method} ${path} HTTP ${r.status}: ${JSON.stringify(value.errors)}`);
 return value.result;
}
const refs=await api(`/workers/scripts/${config.name}/references`);
if((refs.durable_objects??[]).some(x=>x.service!==config.name)||(refs.services?.incoming??[]).length||(refs.dispatch_outbounds??[]).length)throw new Error('Unexpected references; inspect before retiring');
const inventory=await api('/containers/applications');const apps=(Array.isArray(inventory)?inventory:inventory.applications??[]).filter(a=>names.includes(a.name));
for(const app of apps){await api(`/containers/applications/${app.id}`,'DELETE');console.log(JSON.stringify({deletedApp:app.name,id:app.id}));}
const state=resolve(here,'.state');await mkdir(state,{recursive:true});
const entry=resolve(state,`retired-${config.name}.mjs`);await writeFile(entry,'export default {fetch(){return new Response("Unauthorized",{status:401});}};\n');
const target=resolve(state,`retire-${config.name}.json`);await writeFile(target,JSON.stringify({name:config.name,account_id:account,main:entry,compatibility_date:'2026-11-04',workers_dev:false,preview_urls:false,migrations:[...config.migrations,{tag:'camelrun-proto-bench-retire-v1',deleted_classes:classes}]},null,2));
const child=spawn(process.execPath,[resolve(here,'../../node_modules/wrangler/bin/wrangler.js'),'deploy','--config',target,'--durable-objects-code-update-mode','immediate'],{cwd:resolve(here,'../..'),stdio:['pipe','inherit','inherit'],env:{...process.env,WRANGLER_LOG_PATH:resolve(state,'logs'),WRANGLER_SEND_METRICS:'false'}});child.stdin.end('y\n');
const code=await new Promise((done,reject)=>{child.on('error',reject);child.on('exit',done)});if(code!==0)throw new Error('Retire migration failed');
await api(`/workers/scripts/${config.name}`,'DELETE');console.log(JSON.stringify({deletedWorker:config.name,deletedClasses:classes}));

// Retire only a known benchmark Worker and its own DO classes, then delete it.
// Run after measurements and after dependent prototype Workers are retired.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url));
const file=process.argv[2];
if(!['agent-wrangler.jsonc','codemode-caller.wrangler.jsonc','computer-wrangler.jsonc','codemode-sandbox.wrangler.jsonc',
  'round2-agent.wrangler.jsonc','round2-ai-sandbox.wrangler.jsonc','round2-native.wrangler.jsonc',
  'round2-computer-wrangler.jsonc','round2-codemode.wrangler.jsonc','round2-sandbox.wrangler.jsonc','heap.wrangler.jsonc'].includes(file)) throw new Error('Unknown benchmark config');
const source=JSON.parse(await readFile(resolve(here,file),'utf8'));
const account='85bbd288051330fb51ee1c86031a299b';
const classes=[...new Set(source.migrations.flatMap(m=>m.new_sqlite_classes??[]))];
if(source.account_id!==account || !source.name.startsWith('camelrun-proto-') || classes.some(n=>!n.startsWith('camelrun-proto-'))) throw new Error('Outside benchmark scope');
async function api(path) {
  const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`,{headers:{Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN}});
  const data=await r.json(); if(!r.ok||!data.success) throw new Error(`Cleanup preflight HTTP ${r.status}`); return data;
}
// Wrangler's legacy Sites cleanup must never reach an unprefixed KV namespace.
for(let page=1;page<=100;page++) {
  const data=await api(`/storage/kv/namespaces?per_page=1000&page=${page}`);
  if(data.result.some(x=>[`__${source.name}-workers_sites_assets`,`__${source.name}-workers_sites_assets_preview`].includes(x.title))) throw new Error('Legacy Sites namespace requires a different cleanup path');
  if(!data.result_info?.total_pages || page>=data.result_info.total_pages) break;
  if(page===100) throw new Error('Incomplete KV preflight');
}
const refs=(await api(`/workers/scripts/${source.name}/references`)).result;
if((refs.durable_objects??[]).some(x=>x.service!==source.name) || (refs.services?.incoming??[]).length || (refs.dispatch_outbounds??[]).length) throw new Error('Retire dependent Workers first');
const state=resolve(here,'.state'); await mkdir(state,{recursive:true});
const entry=resolve(state,'retired-worker.js');
await writeFile(entry,'export default {fetch(){return new Response("Retired",{status:410});}};\n');
const config=resolve(state,`retire-${source.name}.json`);
await writeFile(config,JSON.stringify({name:source.name,account_id:account,main:entry,
  compatibility_date:'2026-11-04',workers_dev:false,preview_urls:false,
  migrations:[...source.migrations,{tag:'camelrun-proto-delete-v1',deleted_classes:classes}]},null,2));
async function wrangler(args) {
  const child=spawn(process.execPath,[resolve(here,'../node_modules/wrangler/bin/wrangler.js'),...args],{
    cwd:resolve(here,'..'),stdio:['pipe','inherit','inherit'],
    env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:resolve(state,'logs')}});
  child.stdin.end('y\n');
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  if(code!==0) throw new Error(`Wrangler cleanup failed (${code})`);
}
await wrangler(['deploy','--config',config,'--durable-objects-code-update-mode','immediate']);
await wrangler(['delete',source.name,'--config',config,'--force']);
console.log(JSON.stringify({retired:source.name,deletedClasses:classes}));

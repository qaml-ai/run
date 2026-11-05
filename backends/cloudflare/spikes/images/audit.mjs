// Final read-only exact-name reconciliation. No teardown mutations here.
import {writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const token=process.env.CLOUDFLARE_API_TOKEN;if(!token)throw Error('Configured credential required');
const account='85bbd288051330fb51ee1c86031a299b',names=['camelrun-proto-hybrid-images','camelrun-proto-hybrid-images-retry'];
async function api(path){const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});const b=await r.json();if(!r.ok)throw Error(`Inventory ${r.status}`);return b;}
const workers=(await api('/workers/scripts')).result.filter(x=>names.includes(x.id)).map(x=>x.id),namespaces=[];
for(let page=1;page<=20;page++){const r=await api(`/workers/durable_objects/namespaces?per_page=1000&page=${page}`);namespaces.push(...r.result.filter(x=>names.includes(x.script)));if(r.result.length<1000)break;}
const buckets=[];let cursor;
for(let page=0;page<20;page++){const r=await api('/r2/buckets?per_page=1000'+(cursor?'&cursor='+encodeURIComponent(cursor):''));buckets.push(...r.result.buckets.filter(x=>names.includes(x.name)));cursor=r.result_info?.cursor;if(!cursor)break;}
const endpoints=[];
for(const name of names){const url=`https://${name}.miguel-85b.workers.dev`;let status;for(let attempt=0;attempt<5;attempt++){status=(await fetch(url,{signal:AbortSignal.timeout(10000)})).status;if(status===404)break;await new Promise(r=>setTimeout(r,1000));}endpoints.push({url,status});}
const processLines=execFileSync('ps',['-A','-o','pid=,command='],{encoding:'utf8'}).split('\n').filter(x=>/node (?:.*\/)?spikes\/images\/(?:local|remote|cache-retry)\.mjs/.test(x));
const temporaryDirectories=(await readdir(tmpdir())).filter(x=>x.startsWith('camelrun-image-study-'));
const report={at:new Date().toISOString(),workers,namespaces,buckets,endpoints,localOrRemoteRunners:processLines,temporaryDirectories};
const text=JSON.stringify(report,null,2);if(text.includes(token))throw Error('Credential guard');await writeFile(new URL('../../docs/hybrid-images-cleanup.json',import.meta.url),text+'\n');console.log(text);
if(workers.length||namespaces.length||buckets.length||endpoints.some(x=>x.status!==404)||processLines.length||temporaryDirectories.length)process.exitCode=1;

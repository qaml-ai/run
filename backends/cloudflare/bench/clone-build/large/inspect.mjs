// Read-only inventory and measured usage for this subtask's two named Workers.
// The Cloudflare API credential is only read from process.env and never stored.
import { mkdir, writeFile } from 'node:fs/promises';
const account = '85bbd288051330fb51ee1c86031a299b';
const prefixes = ['camelrun-proto-bench-s2-', 'camelrun-proto-bench-s4-'];
const credential = process.env.CLOUDFLARE_API_TOKEN;
if (!credential) throw new Error('Missing Cloudflare credential');
const headers = { authorization: `Bearer ${credential}`, 'content-type': 'application/json' };
const since = process.argv[2] ?? new Date(Date.now() - 4 * 60 * 60_000).toISOString();
if (!/^\d{4}-\d{2}-\d{2}T/.test(since)) throw new Error('Expected ISO start time');
const owned = item => [item.id,item.name,item.script,item.class].some(value => typeof value === 'string' && prefixes.some(prefix => value.startsWith(prefix)));
async function api(path) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {headers, signal:AbortSignal.timeout(30_000)});
  const body = await r.json();
  if (!r.ok || body.success === false) throw new Error(`Read-only inventory failed: ${r.status}: ${JSON.stringify(body.errors)}`);
  return body;
}
async function list(path, key) {
  const rows = []; const seen = new Set(); let pageToken,scanned=0;
  for (let page=1; page<=100; page++) {
    const params = new URLSearchParams({per_page:path.includes('durable_objects')?'1000':'100',page:String(page)});
    if (pageToken) params.set('page_token',pageToken);
    const body = await api(`${path}?${params}`);
    const items = Array.isArray(body.result) ? body.result : body.result?.[key] ?? [];
    scanned+=items.length; rows.push(...items.filter(owned));
    const info = body.result_info;
    if (info?.next_page_token) { if(seen.has(info.next_page_token))throw new Error('Repeated inventory page'); seen.add(info.next_page_token);pageToken=info.next_page_token;continue; }
    if (!info || !items.length || (Number.isFinite(info.total_count)&&scanned>=info.total_count) || (Number.isFinite(info.total_pages)&&page>=info.total_pages) || (!Number.isFinite(info.total_count)&&!Number.isFinite(info.total_pages))) return rows;
  }
  throw new Error('Inventory pagination limit');
}
const at = new Date().toISOString();
const workers=await list('/workers/scripts');
const namespaces=await list('/workers/durable_objects/namespaces');
const apps=await list('/containers/applications','applications');
const containers=[];
for(const app of apps) {
  const instances=await api(`/containers/dash/applications/${app.id}/instances?per_page=100`);
  const query=`{viewer{accounts(filter:{accountTag:${JSON.stringify(account)}}){metrics:containersUsageAdaptiveGroups(limit:100,filter:{applicationId:${JSON.stringify(app.id)},datetime_geq:${JSON.stringify(since)},datetime_leq:${JSON.stringify(at)}}){dimensions{applicationId}sum{allocatedDisk allocatedMemory cpuTimeSec txBytes}}}}}`;
  const r=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers,body:JSON.stringify({query}),signal:AbortSignal.timeout(30_000)});
  const usage=await r.json();
  containers.push({app,instances:instances.result,usage:{status:r.status,errors:usage.errors??null,rows:usage.data?.viewer?.accounts?.[0]?.metrics??[]}});
}
const report={at,since,account,prefixes,workers,namespaces,containers,units:{allocatedDisk:'byte-seconds',allocatedMemory:'byte-seconds',cpuTimeSec:'vCPU-seconds',txBytes:'bytes'},caveat:'Delayed sampled usage; empty rows do not mean zero usage.'};
const text=JSON.stringify(report,null,2)+'\n';
if(text.includes(credential))throw new Error('Refusing secret output');
await mkdir(new URL('./.state/',import.meta.url),{recursive:true});
await writeFile(new URL(`./.state/inspect-${Date.now()}.json`,import.meta.url),text);
console.log(text);

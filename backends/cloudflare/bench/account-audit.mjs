// Read-only account inventory. Never prints credentials or unprefixed resources.
import { mkdir, writeFile } from 'node:fs/promises';
const account = '85bbd288051330fb51ee1c86031a299b';
const prefix = 'camelrun-proto-';
const stamp = process.argv[2] ?? 'audit';
if (!/^[a-z0-9-]+$/.test(stamp)) throw new Error('Invalid audit label');
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set');
const endpoints = {
  workers: `/accounts/${account}/workers/scripts`,
  durableObjects: `/accounts/${account}/workers/durable_objects/namespaces`,
  r2: `/accounts/${account}/r2/buckets`,
  containers: `/accounts/${account}/containers/applications`,
  queues: `/accounts/${account}/queues`,
};
const audit = { at: new Date().toISOString(), account, prefix, resources: {} };
for (const [kind, endpoint] of Object.entries(endpoints)) {
  const matches = []; let pages = 0, scanned = 0, cursor, pageToken;
  const cursors = new Set();
  for (let page = 1; page <= 50; page++) {
    const params = new URLSearchParams(kind === 'r2' ? {} : {per_page:kind === 'durableObjects' ? '1000' : '100', page:String(page)});
    if (cursor) params.set('cursor', cursor);
    if (pageToken) params.set('page_token', pageToken);
    const response = await fetch(`https://api.cloudflare.com/client/v4${endpoint}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json(); pages++;
    if (!response.ok || !body.success) {
      audit.resources[kind] = { status: response.status, errors: body.errors?.map(({code, message}) => ({code, message})) };
      break;
    }
    const result = body.result;
    const items = Array.isArray(result) ? result : result?.buckets ?? result?.applications ?? [];
    scanned += items.length;
    matches.push(...items.filter(item => [item.name, item.id, item.script, item.class, item.queue_name].some(name => typeof name === 'string' && name.startsWith(prefix)))
      .map(item => ({id: item.id, name: item.name ?? item.queue_name, script: item.script, class: item.class})));
    const info = body.result_info;
    if (info?.next_page_token) {
      if (cursors.has(info.next_page_token)) throw new Error(`Repeated ${kind} page token; inventory incomplete`);
      cursors.add(info.next_page_token); pageToken = info.next_page_token;
      continue;
    }
    if (info?.cursor) {
      if (cursors.has(info.cursor)) throw new Error(`Repeated ${kind} cursor; inventory incomplete`);
      cursors.add(info.cursor); cursor = info.cursor;
      continue;
    }
    if (Number.isFinite(info?.total_count) && scanned >= info.total_count) {
      audit.resources[kind] = {items: matches, pages, scanned, complete:true}; break;
    }
    if (!info || items.length === 0 || (Number.isFinite(info.total_pages) && page >= info.total_pages) ||
        (!Number.isFinite(info.total_count) && !Number.isFinite(info.total_pages))) {
      audit.resources[kind] = {items: matches, pages, scanned, complete:true}; break;
    }
  }
  audit.resources[kind] ??= {items:matches,pages,scanned,complete:false};
}
await mkdir(new URL('./.state/', import.meta.url), {recursive:true});
await writeFile(new URL(`./.state/${stamp}.json`, import.meta.url), JSON.stringify(audit, null, 2));
console.log(JSON.stringify(audit, null, 2));

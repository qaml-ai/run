// Retire only the discarded tool-enabled cohort; leave steady-* untouched.
import { readFile, writeFile } from 'node:fs/promises';
const base = 'https://camelrun-proto-r2-ai.miguel-85b.workers.dev';
const bearer = (await readFile(new URL('./.state/api-token', import.meta.url), 'utf8')).trim();
async function call(path, body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90000) });
  return { status: response.status, body: await response.json() };
}
const rows = [];
for (let i = 0; i < 20; i++) {
  const id = `soak-${i}`;
  const before = await call(`/drivers/${id}`);
  const stop = await call(`/drivers/${id}/stop`, {});
  const abort = await call(`/agents/${id}/requests`, { id: 'stop-preliminary-v2', method: 'abort', params: { queued: 'cancel' } });
  const after = await call(`/drivers/${id}`);
  rows.push({ id, before, stop, abort, after });
  console.log(JSON.stringify({ id, stop: stop.status, abort: abort.status, alarm: after.body.alarm }));
}
const report = { at: new Date().toISOString(), reason: 'An in-flight preliminary alarm overwrote its first stop request. Durable stopped flag now survives the local-state write.', rows };
const serialized = JSON.stringify(report, null, 2);
if (serialized.includes(bearer)) throw new Error('Credential guard');
await writeFile('docs/round2-preliminary-stop.json', serialized + '\n');

// One extra bounded Workers AI call and five fresh deterministic objects.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {BenchmarkClient, distribution} from './agent-runner.mjs';

const prior = JSON.parse(await readFile(new URL('./.state/agent-measure.json', import.meta.url)));
const token = (await readFile(new URL('./.state/api-token', import.meta.url), 'utf8')).trim();
const client = new BenchmarkClient(prior.baseUrl, token);
const before = await client.json('/bench/meta');
assert.ok(before.budget.reservedDispatches < 24);
const samples = [];
for (let i = 0; i < 5; i++) {
  const agent = await client.create('deterministic', `cold-${i}`);
  const first = await client.turn(agent, 'first', 'first');
  const warm = await client.turn(agent, 'warm', 'warm');
  samples.push({agent, first, warm, diagnostics: await client.diagnostics(agent)});
}
const stream = await client.sseTurn(prior.real.agent, `long-stream-${Date.now()}`,
  'Write a numbered list from 1 to 30, one short sentence per line about counting. Use plain text and continue through 30.');
const after = await client.json('/bench/meta');
assert.equal(after.budget.reservedDispatches - before.budget.reservedDispatches, 1);
const history = await client.json(`/clients/${prior.real.agent.id}/history`);
const report = {at:new Date().toISOString(),samples,
  coldProvisionMs:distribution(samples.map(x=>x.agent.provisionMs)),
  firstTurnMs:distribution(samples.map(x=>x.first.totalMs)),
  warmTurnMs:distribution(samples.map(x=>x.warm.totalMs)),stream,
  usage:history.messages.filter(x=>x.role==='assistant').map(({model,provider,usage})=>({model,provider,usage})),
  totalReservedDispatches:after.budget.reservedDispatches,
  limits:['Provisioning creates the object; first turn is after provisioning, not an isolated platform cold-start timer.',
    'Deterministic turns exclude model latency. SSE text delta timestamps include client network time.']};
await writeFile(new URL('./.state/agent-followup.json',import.meta.url), JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({at:report.at,coldProvisionMs:report.coldProvisionMs,firstTurnMs:report.firstTurnMs,warmTurnMs:report.warmTurnMs,
  stream:{firstTextMs:stream.firstTextMs,totalMs:stream.totalMs,deltas:stream.textDeltas.length,
  first:stream.textDeltas[0],last:stream.textDeltas.at(-1)},totalReservedDispatches:report.totalReservedDispatches}));

// Read only the forty DO IDs that participated in the completed one-hour soak.
import { readFile, writeFile } from 'node:fs/promises';
const account = '85bbd288051330fb51ee1c86031a299b';
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error('Missing configured token');
const soak = JSON.parse(await readFile('docs/round2-agents.json', 'utf8')).soak;
if (!soak.summary || soak.finalAgentState.length !== 20) throw new Error('The soak must be complete');
const since = new Date(Math.min(...soak.starts.map(row => row.startedAt))).toISOString();
const until = new Date(Math.max(...soak.starts.map(row => row.stopAt))).toISOString();
const classes = [
  { kind: 'agent', namespace: '23e5256205b54a6aa9fbc6dbc1c93964', objects: soak.finalAgentState },
  { kind: 'driver', namespace: '5fa81dd8871c451398aab7a5139eb709', objects: soak.agents },
];
const rows = [];
for (const group of classes) {
  for (let index = 0; index < group.objects.length; index++) {
    const objectId = group.objects[index].objectId;
    if (!/^[a-f0-9]{64}$/.test(objectId)) throw new Error('Invalid recorded object ID');
    const filter = `namespaceId:"${group.namespace}",objectId:"${objectId}",datetime_geq:"${since}",datetime_leq:"${until}"`;
    const query = `{viewer{accounts(filter:{accountTag:"${account}"}){
      periodic:durableObjectsPeriodicGroups(limit:100,filter:{${filter}}){avg{sampleInterval}sum{duration activeTime cpuTime rowsRead rowsWritten}max{memoryUsageBytes}}
      invocations:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{${filter}}){avg{sampleInterval}sum{requests errors}}
    }}}`;
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok || result.errors) throw new Error(`Soak analytics failed: HTTP ${response.status}`);
    rows.push({ kind: group.kind, index, objectId, ...result.data.viewer.accounts[0] });
  }
}
const sum = (items, field) => items.reduce((n, row) => n + (row.sum?.[field] ?? 0), 0);
const summary = Object.fromEntries(classes.map(({ kind }) => {
  const selected = rows.filter(row => row.kind === kind);
  const periodic = selected.flatMap(row => row.periodic);
  const invocations = selected.flatMap(row => row.invocations);
  const value = { durationGBSeconds: sum(periodic, 'duration'), activeSeconds: sum(periodic, 'activeTime') / 1e6,
    requests: sum(invocations, 'requests'), errors: sum(invocations, 'errors'), rowsRead: sum(periodic, 'rowsRead'), rowsWritten: sum(periodic, 'rowsWritten') };
  value.computeCostUsd = value.durationGBSeconds * 12.5 / 1e6 + value.requests * .15 / 1e6;
  value.sqlCostUsd = value.rowsRead * .001 / 1e6 + value.rowsWritten / 1e6;
  value.meanCostPerAgentHourUsd = (value.computeCostUsd + value.sqlCostUsd) / 20;
  return [kind, value];
}));
const report = { generatedAt: new Date().toISOString(), since, until, agents: 20, summary, rows,
  caveats: ['Model, front Worker, and stored byte-time costs are separate.', 'Analytics can be sampled and delayed; the window is fixed to the actual soak.', 'Driver DOs are the benchmark timer/controller, separate from the real agent DOs.'] };
const serialized = JSON.stringify(report, null, 2);
if (serialized.includes(token)) throw new Error('Credential guard');
await writeFile('docs/round2-soak-cost.json', serialized + '\n');
console.log(JSON.stringify({ since, until, summary }, null, 2));

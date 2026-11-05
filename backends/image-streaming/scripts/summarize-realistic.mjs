// Read-only statistics from a completed realistic run. Missing telemetry stays null.
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const file = process.argv[2];
if (!file) throw Error('Usage: node scripts/summarize-realistic.mjs REPORT.json[.gz]');
const source = resolve(file), bytes = await readFile(source);
const report = JSON.parse((file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
if (report.profile !== 'realistic') throw Error('Expected a realistic-profile report');
if (!report.finishedMeasurementsAt) throw Error('Wait for the measurement matrix to finish');

// Match report.mjs: every poll reads a cumulative window; the latest copy wins.
const unique = new Map();
for (const poll of report.telemetry ?? []) for (const row of poll.rows ?? []) {
  const dim = row.dimensions ?? {};
  unique.set(JSON.stringify([dim.objectId, dim.name, dim.datetime]), row);
}
const rows = [...unique.values()];
const finite = values => values.filter(Number.isFinite);
const sum = values => { const numbers = finite(values); return numbers.length ? numbers.reduce((a, b) => a + b, 0) : null; };
function stats(values) {
  const sorted = finite(values).sort((a, b) => a - b);
  const percentile = q => sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null;
  return { samples: sorted.length, total: sum(sorted), mean: sorted.length ? sum(sorted) / sorted.length : null,
    max: sorted.at(-1) ?? null, p50: percentile(.5), p95: percentile(.95) };
}
function metrics(selected) {
  const total = key => sum(selected.map(row => row.sum?.[key]));
  const cpu = total('cpuTime'), active = total('activeTime');
  const memories = finite(selected.map(row => row.max?.memoryUsageBytes)).filter(value => value > 0);
  return { rows: selected.length, available: selected.length > 0,
    cpuMs: cpu === null ? null : cpu / 1000,
    activeSeconds: active === null ? null : active / 1e6,
    durationGBSeconds: total('duration'),
    memoryMaxMiB: memories.length ? Math.max(...memories) / 2 ** 20 : null,
    memoryErrorObservations: total('exceededMemoryErrors'), cpuErrorObservations: total('exceededCpuErrors'),
    rowsRead: total('rowsRead'), rowsWritten: total('rowsWritten') };
}
function object(row) {
  const ids = [row.seed?.data?.objectId, row.request?.data?.objectId, row.status?.data?.objectId].filter(Boolean);
  const selected = rows.filter(metric => ids.includes(metric.dimensions?.objectId) || metric.dimensions?.name === row.id);
  return { id: row.id, objectIds: [...new Set(ids)],
    seedStatus: row.seed?.status ?? null, requestStatus: row.request?.status ?? null,
    match: row.request?.data?.match ?? null, mimeMatch: row.request?.data?.mimeMatch ?? null,
    serverLatencyMs: Number.isFinite(row.request?.data?.elapsedMs) ? row.request.data.elapsedMs : null,
    clientLatencyMs: Number.isFinite(row.request?.latencyMs) ? row.request.latencyMs : null,
    telemetry: metrics(selected) };
}
const groups = (report.concurrency ?? []).map(group => {
  const objects = (group.outcomes ?? []).map(object);
  const ids = new Set(objects.flatMap(row => row.objectIds)), names = new Set(objects.map(row => row.id));
  const selected = rows.filter(row => ids.has(row.dimensions?.objectId) || names.has(row.dimensions?.name));
  const successful = objects.filter(row => row.match === true);
  return { mode: group.mode, count: group.count, requestedAgents: group.agents, attemptedAgents: objects.length,
    matches: successful.length, objectsWithTelemetry: objects.filter(row => row.telemetry.available).length,
    objectsWithCpuTelemetry: objects.filter(row => row.telemetry.cpuMs !== null).length,
    objectsWithMemoryTelemetry: objects.filter(row => row.telemetry.memoryMaxMiB !== null).length,
    telemetry: metrics(selected), cpuMsPerObject: stats(objects.map(row => row.telemetry.cpuMs)),
    serverLatencyMs: stats(objects.map(row => row.serverLatencyMs)),
    successfulServerLatencyMs: stats(successful.map(row => row.serverLatencyMs)),
    clientLatencyMs: stats(objects.map(row => row.clientLatencyMs)), objects };
});

const requests = [
  ...(report.cases ?? []).map(row => ({ label: `single/${row.id}`, operation: row.request })),
  ...(report.concurrency ?? []).flatMap(group => (group.outcomes ?? []).map(row => ({ label: `concurrent/${row.id}`, operation: row.request }))),
  ...(report.faults ?? []).flatMap(row => [{ label: `fault/${row.id}`, operation: row.request },
    ...(row.recovery ? [{ label: `recovery/${row.id}`, operation: row.recovery }] : [])]),
  ...(report.replay ?? []).map(row => ({ label: `replay/${row.id}`, operation: row.request })),
];
const successful = requests.filter(row => row.operation?.data?.match === true);
const result = {
  source: basename(source), profile: report.profile, generatedAt: new Date().toISOString(),
  startedAt: report.startedAt, finishedMeasurementsAt: report.finishedMeasurementsAt,
  units: { memory: 'MiB (2^20 bytes)', cpu: 'milliseconds from Cloudflare microseconds', duration: 'GB*s' },
  limitations: [
    'Whole-isolate memory samples are neither per-object allocations nor guaranteed peaks. Co-located objects can share the same isolate memory.',
    'CPU per object sums all observed lifecycle rows for that object, including seed, request, hold and status; it is not provider-request-only CPU.',
    'Group CPU is the aggregate across observed objects. Mean/max CPU per object use only objects with CPU telemetry; missing values stay null.',
    'Periodic counter sums are observations, not necessarily unique user-visible errors. Full-run metrics include vision, faults, replay and probes.',
    'Latency covers recorded requests, independent of telemetry availability. Successful latency includes only hash-matched requests.',
    'This reports usage evidence, not an invoice. DO duration already has GB-second units; do not multiply it by memory a second time.',
  ],
  corpus: { count: report.fixture?.count, kinds: (report.fixture?.images ?? []).reduce((counts, row) => {
    const key = row.source?.kind ?? 'unknown'; counts[key] = (counts[key] ?? 0) + 1; return counts;
  }, {}), derivativeBytes: stats((report.fixture?.images ?? []).map(row => row.ref?.size)) },
  requests: { recorded: requests.length, withOperation: requests.filter(row => row.operation).length,
    hashMatched: successful.length, verifiedImages: sum(successful.map(row => row.operation.data.summary?.imageCount)),
    verifiedImageBytes: sum(successful.flatMap(row => (row.operation.data.summary?.images ?? []).map(image => image.bytes))) },
  groups,
  fullTelemetry: { polls: report.telemetry?.length ?? 0,
    emptyPolls: (report.telemetry ?? []).filter(poll => !(poll.rows?.length)).length,
    uniqueRows: rows.length, uniqueObjects: new Set(rows.map(row => row.dimensions?.objectId ?? row.dimensions?.name).filter(Boolean)).size,
    metrics: metrics(rows) },
  errors: { run: report.error ?? null,
    telemetry: (report.telemetry ?? []).filter(poll => poll.error || poll.errors?.length).map(poll => ({ label: poll.label, at: poll.at, status: poll.status, error: poll.error, errors: poll.errors })),
    stateless: (report.statelessTelemetry?.queries ?? []).filter(query => query.error || query.errors?.length || query.status !== 200),
    requests: requests.filter(row => !row.operation || row.operation.error || row.operation.data?.error || row.operation.status !== 200 || row.operation.data?.match !== true).map(({ label, operation }) => ({ label, operation })) },
  vision: report.workersAiVision ?? null,
  cleanup: report.cleanup ?? null,
};
const output = resolve(dirname(source), 'summary-realistic.json');
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, requests: result.requests, fullTelemetry: result.fullTelemetry,
  groups: groups.map(({ objects, ...group }) => group), errors: result.errors }, null, 2));

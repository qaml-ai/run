// Apply public marginal rates to the recorded, prefix-scoped usage. This is
// intentionally not an invoice: allowances and rounding belong to the account.
import { readFile, writeFile } from 'node:fs/promises';
const [telemetryPath, usagePath, modelPath, outPath, fallbackTelemetryPath, fallbackUsagePath] = process.argv.slice(2);
if (!outPath) throw new Error('Expected TELEMETRY USAGE MODEL_USAGE OUTPUT [FALLBACK_TELEMETRY] [FALLBACK_USAGE]');
const [telemetry, usage, model, fallbackTelemetry, fallbackUsage] = await Promise.all(
  [telemetryPath, usagePath, modelPath, fallbackTelemetryPath, fallbackUsagePath]
    .map(async path => path ? JSON.parse(await readFile(path, 'utf8')) : undefined));
const sum = (rows, field) => rows.reduce((value, row) => value + (row.sum?.[field] ?? 0), 0);
const selected = kind => telemetry.results.filter(row => row.kind === kind).flatMap(row => row.rows);
// Deleted resources can disappear from historical name queries. Keep every
// nonempty final result; fill only missing results from the last predelete read.
const fallbacks = [];
function metricRows(kind, resourceKey, primary, fallback, source) {
  const byResource = new Map();
  for (const row of primary.results.filter(row => row.kind === kind)) {
    const key = resourceKey(row);
    if (row.rows.length || !byResource.has(key)) byResource.set(key, row.rows);
  }
  const prior = new Map();
  for (const row of fallback?.results ?? []) {
    if (row.kind === kind && row.rows.length) prior.set(resourceKey(row), row);
  }
  for (const [resource, row] of prior) {
    if (byResource.get(resource)?.length) continue;
    byResource.set(resource, row.rows);
    fallbacks.push({ kind, resource, source,
      since: row.sourceWindow?.since ?? fallback.since,
      until: row.sourceWindow?.until ?? fallback.until,
      generatedAt: row.sourceWindow?.generatedAt ?? fallback.generatedAt ?? fallback.at });
  }
  return [...byResource.values()].flat();
}
const workers = metricRows('worker', row => row.script, telemetry, fallbackTelemetry, fallbackTelemetryPath);
const invocations = metricRows('durable-object-invocations', row => row.namespace.id, telemetry, fallbackTelemetry, fallbackTelemetryPath);
const periodic = metricRows('durable-object-periodic', row => row.namespace.id, telemetry, fallbackTelemetry, fallbackTelemetryPath);
const containerRows = metricRows('container-usage', row => row.app.id, usage, fallbackUsage, fallbackUsagePath);
const aiRows = usage.results.filter(row => row.kind === 'workers-ai').flatMap(row => row.rows);
const r2Rows = metricRows('r2-operations', row => row.bucket, usage, fallbackUsage, fallbackUsagePath);
const worker = {
  requests: sum(workers, 'requests'), cpuMs: sum(workers, 'cpuTimeUs') / 1000,
};
worker.costUsd = worker.requests * .30 / 1e6 + worker.cpuMs * .02 / 1e6;
const durableObjects = {
  requests: sum(invocations, 'requests'), durationGBSeconds: sum(periodic, 'duration'),
  activeSeconds: sum(periodic, 'activeTime') / 1e6,
  rowsRead: sum(periodic, 'rowsRead'), rowsWritten: sum(periodic, 'rowsWritten'),
};
durableObjects.computeCostUsd = durableObjects.requests * .15 / 1e6
  + durableObjects.durationGBSeconds * 12.50 / 1e6;
durableObjects.sqlOperationCostUsd = durableObjects.rowsRead * .001 / 1e6
  + durableObjects.rowsWritten / 1e6;
const containers = {
  allocatedMemoryGiBSeconds: sum(containerRows, 'allocatedMemory') / 2 ** 30,
  allocatedDiskGBSeconds: sum(containerRows, 'allocatedDisk') / 1e9,
  cpuSeconds: sum(containerRows, 'cpuTimeSec'), txBytes: sum(containerRows, 'txBytes'),
};
containers.computeCostUsd = containers.allocatedMemoryGiBSeconds * .0000025
  + containers.allocatedDiskGBSeconds * .00000007 + containers.cpuSeconds * .000020;
// Recorded Container locations were in North America; this is before egress allowances.
containers.egressCostUsd = containers.txBytes / 1e9 * .025;
const ai = {
  requests: aiRows.reduce((n, row) => n + (row.count ?? 0), 0),
  inputTokens: sum(aiRows, 'totalInputTokens'), outputTokens: sum(aiRows, 'totalOutputTokens'),
  neurons: sum(aiRows, 'totalNeurons'),
};
ai.tokenCostUsd = ai.inputTokens * .017 / 1e6 + ai.outputTokens * .112 / 1e6;
ai.neuronCostUsd = ai.neurons * .011 / 1000;
const appModel = Object.values(model.groups).reduce((result, group) => ({
  dispatches: result.dispatches + group.dispatches,
  responses: result.responses + group.responses,
  inputTokens: result.inputTokens + group.tokens.input,
  outputTokens: result.outputTokens + group.tokens.output,
}), { dispatches: 0, responses: 0, inputTokens: 0, outputTokens: 0 });
appModel.tokenCostUsd = appModel.inputTokens * .017 / 1e6 + appModel.outputTokens * .112 / 1e6;
// Enumerate known actions instead of silently pricing unknown control-plane calls.
const classA = new Set(['PutObject', 'PutBucket', 'ListObjects', 'ListBuckets', 'ListMultipartUploads', 'CreateMultipartUpload', 'UploadPart', 'CompleteMultipartUpload', 'CopyObject']);
const classB = new Set(['GetObject', 'HeadObject', 'HeadBucket', 'UsageSummary']);
const r2 = { classA: 0, classB: 0, freeDelete: 0, unpriced: [] };
for (const row of r2Rows) {
  const action = row.dimensions.actionType, n = row.sum.requests;
  if (classA.has(action)) r2.classA += n;
  else if (classB.has(action)) r2.classB += n;
  else if (/^Delete|^Abort/.test(action)) r2.freeDelete += n;
  else r2.unpriced.push({ action, requests: n });
}
r2.operationCostUsd = r2.classA * 4.5 / 1e6 + r2.classB * .36 / 1e6;
const report = {
  generatedAt: new Date().toISOString(), sources: { telemetryPath, usagePath, modelPath,
    ...(fallbackTelemetryPath ? { fallbackTelemetryPath } : {}), ...(fallbackUsagePath ? { fallbackUsagePath } : {}) },
  windows: { telemetry: { since: telemetry.since, until: telemetry.until }, usage: { since: usage.since, until: usage.until }, appModelAt: model.at },
  worker, durableObjects, containers, ai, appModel, r2, fallbacks,
  observedMarginalCostUsd: worker.costUsd + durableObjects.computeCostUsd + durableObjects.sqlOperationCostUsd + containers.computeCostUsd
    + containers.egressCostUsd + ai.neuronCostUsd + r2.operationCostUsd,
  limitations: [
    'Analytics ingestion can be delayed or sampled; recorded time windows do not imply all records have arrived.',
    'Worker CPU and requests plus DO duration and requests are separate priced products. Worker duration is not added.',
    'AI analytics is model/account/time scoped, not Worker scoped. Application counters are the attribution cross-check.',
    'SQLite stored byte-time, log charges, retained snapshot/image storage and tiny R2 storage peaks are excluded unless separately quantified.',
    'This uses public marginal rates before included allowances, rounding and account terms; it is not a final invoice.',
    ...(fallbacks.length ? ['Deleted-resource fallback rows are the last available observed subset; they do not include usage after that read. Nonempty final rows and account-scoped AI rows are not replaced.'] : []),
  ],
};
await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

// Derive an unrounded usage estimate from sanitized benchmark artifacts.
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const state = join(dirname(fileURLToPath(import.meta.url)), ".state");
async function latest(pattern) {
  const paths = (await readdir(state)).filter(name => pattern.test(name)).map(name => join(state, name));
  const dated = await Promise.all(paths.map(async path => ({ path, at: (await stat(path)).mtimeMs })));
  dated.sort((a, b) => b.at - a.at);
  if (!dated.length) throw new Error(`Missing artifact ${pattern}`);
  return { path: dated[0].path, data: JSON.parse(await readFile(dated[0].path, "utf8")) };
}
const telemetry = await latest(/^telemetry.*\.json$/);
const cost = await latest(/^cost-telemetry.*\.json$/);
const agents = JSON.parse(await readFile(join(state, "agent-followup.json"), "utf8"));
const sum = (rows, field) => rows.reduce((total, row) => total + Number(row.sum?.[field] ?? 0), 0);
const rows = kind => telemetry.data.results.filter(result => result.kind === kind).flatMap(result => result.rows);
const workerRows = rows("worker"), durationRows = rows("durable-object-periodic"), doRows = rows("durable-object-invocations");
const counts = {
  workerRequests: sum(workerRows, "requests"), workerCpuMs: sum(workerRows, "cpuTimeUs") / 1000,
  durableObjectRequests: sum(doRows, "requests"), durableObjectGbSeconds: sum(durationRows, "duration"),
};
const components = {
  workersRequests: counts.workerRequests / 1e6 * 0.30,
  workersCpu: counts.workerCpuMs / 1e6 * 0.02,
  durableObjectRequests: counts.durableObjectRequests / 1e6 * 0.15,
  durableObjectDuration: counts.durableObjectGbSeconds / 1e6 * 12.50,
};
const containerRows = cost.data.results.filter(result => result.kind === "containers").flatMap(result => result.rows);
Object.assign(counts, {
  containerGiBSeconds: sum(containerRows, "allocatedMemory") / 2 ** 30,
  containerGBSeconds: sum(containerRows, "allocatedDisk") / 1e9,
  containerVCpuSeconds: sum(containerRows, "cpuTimeSec"),
});
Object.assign(components, {
  containerMemory: counts.containerGiBSeconds * 0.0000025,
  containerDisk: counts.containerGBSeconds * 0.00000007,
  containerCpu: counts.containerVCpuSeconds * 0.000020,
});
const classA = new Set(["PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts"]);
const classB = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary"]);
const r2Rows = cost.data.results.filter(result => result.kind === "r2-operations").flatMap(result => result.rows);
counts.r2ClassA = sum(r2Rows.filter(row => classA.has(row.dimensions?.actionType)), "requests");
counts.r2ClassB = sum(r2Rows.filter(row => classB.has(row.dimensions?.actionType)), "requests");
const storageRows = cost.data.results.filter(result => result.kind === "r2-storage").flatMap(result => result.rows);
counts.r2GbMonth = storageRows.reduce((total, row) => total + (Number(row.max?.payloadSize ?? 0) + Number(row.max?.metadataSize ?? 0)) / 1e9 / 30, 0);
Object.assign(components, { r2ClassA: counts.r2ClassA / 1e6 * 4.50, r2ClassB: counts.r2ClassB / 1e6 * 0.36, r2Storage: counts.r2GbMonth * 0.015 });
const tokens = agents.usage.reduce((total, message) => ({ input: total.input + message.usage.input, cachedInput: total.cachedInput + message.usage.cacheRead, output: total.output + message.usage.output }), { input: 0, cachedInput: 0, output: 0 });
components.model = tokens.input / 1e6 * 0.15 + tokens.cachedInput / 1e6 * 0.03 + tokens.output / 1e6 * 0.50;
const elapsedSeconds = (Date.now() - Date.parse("2026-11-04T19:38:55.555Z")) / 1000;
const conservativePlanningEnvelope = {
  elapsedSeconds, assumedMaximumObjects: 512,
  allObjectsResidentUsd: 512 * 0.128 * elapsedSeconds / 1e6 * 12.50,
  twoLiteAndTwoBasicAlwaysRunningUsd: 2 * elapsedSeconds * (0.000002015 + 0.00000778),
  reservedWorkersUsd: 10_000 / 1e6 * 0.30 + 1_000_000 / 1e6 * 0.02,
  reservedSQLiteUsd: 100_000 / 1e6 * 1.00 + 1_000_000 / 1e6 * 0.001,
  reservedR2Usd: 1_000 / 1e6 * 4.50 + 1_000 / 1e6 * 0.36 + 2 / 30 * 0.015,
};
conservativePlanningEnvelope.totalUsd = Object.entries(conservativePlanningEnvelope)
  .filter(([key]) => key.endsWith("Usd")).reduce((total, [, value]) => total + value, 0) + components.model;
const result = {
  at: new Date().toISOString(), sources: { telemetry: telemetry.path, costTelemetry: cost.path, modelCalls: agents.totalReservedDispatches },
  counts, tokens, components, observedPartialUnroundedUsd: Object.values(components).reduce((total, value) => total + value, 0),
  missingDatasets: [...telemetry.data.results, ...cost.data.results].filter(result => result.kind !== "durable-object-periodic-by-object" && (!result.rows.length || result.errors)).map(result => ({ kind: result.kind, resource: result.namespace?.name ?? result.script ?? result.app?.name ?? result.bucket, errors: result.errors })),
  conservativePlanningEnvelope,
  caveats: [
    "Observed telemetry is delayed and may be sampled. Empty or partial datasets do not establish zero spend.",
    "SQLite operation counts are not measured by these artifacts and are excluded from the observed partial estimate.",
    "The planning envelope assumes no more than 512 instantiated DOs, four VMs (two lite/two basic), and stated operation reserves; it is not metered usage or an invoice maximum.",
    "Account allowances, contractual rates, and billing-unit rounding apply to the actual invoice. The account billing endpoint has no records for the experiment date yet.",
  ],
};
await writeFile(join(state, "cost-estimate.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));

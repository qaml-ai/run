// Read-only Cloudflare analytics for this experiment's prefixed resources.
// Credentials stay in the environment and are never written to the artifact.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const account = "85bbd288051330fb51ee1c86031a299b";
const prefix = "camelrun-proto-";
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  if (!["--since", "--until", "--out", "--inventory"].includes(process.argv[index]) || !process.argv[index + 1]) throw new Error("Expected --since ISO_TIME [--until ISO_TIME] [--inventory PRIOR_TELEMETRY_FILE] --out FILE");
  options[process.argv[index].slice(2)] = process.argv[index + 1];
}
if (!options.since || !options.out) throw new Error("--since and --out are required");
const since = new Date(options.since).toISOString();
const until = new Date(options.until ?? Date.now()).toISOString();
if (Date.parse(until) <= Date.parse(since) || Date.parse(until) - Date.parse(since) > 86400000) throw new Error("Select a positive window of at most 24 hours");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
async function graphql(query) {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", headers, body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  return { httpStatus: response.status, errors: body.errors ?? null, data: body.data ?? null };
}

const bases = ["AccountWorkersInvocationsAdaptive", "AccountDurableObjectsInvocationsAdaptiveGroups", "AccountDurableObjectsPeriodicGroups", "AccountDurableObjectsSqlStorageGroups"];
const schemaNames = bases.flatMap(base => ["Sum", "Max", "Quantiles", "Dimensions", "Filter_InputObject"].map(suffix => `${base}${suffix}`));
const schemaResult = await graphql(`{${schemaNames.map((name, index) => `t${index}:__type(name:${JSON.stringify(name)}){name fields{name description} inputFields{name description}}`).join("\n")}}`);
const settingsResult = await graphql(`{viewer{accounts(filter:{accountTag:${JSON.stringify(account)}}){settings{workersInvocationsAdaptive{enabled maxDuration maxPageSize}durableObjectsPeriodicGroups{enabled maxDuration maxPageSize}durableObjectsInvocationsAdaptiveGroups{enabled maxDuration maxPageSize}durableObjectsSqlStorageGroups{enabled maxDuration maxPageSize}}}}}`);
const schema = Object.values(schemaResult.data ?? {}).filter(Boolean).map(type => ({
  name: type.name,
  fields: (type.fields ?? []).filter(field => /cpu|memory|wasm|duration|wall|active|exceeded|error|request|namespace|objectId|scriptName|rows|stored|^name$|datetimeMinute/i.test(field.name)),
  filters: (type.inputFields ?? []).filter(field => /^(scriptName|namespaceId|objectId|name|datetime_geq|datetime_leq)$/.test(field.name)),
}));

const namespaces = [];
let inventoryError = null;
if (options.inventory) {
  const prior = JSON.parse(await readFile(options.inventory, "utf8"));
  if (!Array.isArray(prior.namespaces) || prior.namespaces.length > 1000) throw new Error("Invalid inventory file");
  for (const row of prior.namespaces) {
    if (!/^[a-f0-9]{32}$/i.test(row.id) || !row.script?.startsWith(prefix) || !row.class?.startsWith(prefix)) throw new Error("Inventory contains a non-prototype namespace");
    namespaces.push({ id: row.id, name: row.name, script: row.script, class: row.class });
  }
} else for (let page = 1; page <= 50; page++) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/durable_objects/namespaces?per_page=500&page=${page}`, { headers, signal: AbortSignal.timeout(30000) });
  const body = await response.json();
  if (!response.ok || !body.success) {
    inventoryError = { httpStatus: response.status, errors: body.errors?.map(({ code, message }) => ({ code, message })) };
    break;
  }
  const rows = body.result ?? [];
  namespaces.push(...rows.filter(row => typeof row.script === "string" && row.script.startsWith(prefix) && typeof row.class === "string" && row.class.startsWith(prefix))
    .map(({ id, name, script, class: className }) => ({ id, name, script, class: className })));
  const info = body.result_info;
  if (rows.length < 500 || !info || page >= info.total_pages || page * 500 >= info.total_count) break;
}
const scripts = [...new Set(namespaces.map(namespace => namespace.script))];
const periodFilter = `datetime_geq:${JSON.stringify(since)},datetime_leq:${JSON.stringify(until)}`;
const queries = [];
for (let index = 0; index < scripts.length; index++) {
  const script = scripts[index];
  if (!script.startsWith(prefix)) throw new Error("Resource outside allowed prefix");
  queries.push({ key: `worker${index}`, kind: "worker", script,
    query: `workersInvocationsAdaptive(limit:100,filter:{scriptName:${JSON.stringify(script)},${periodFilter}}){dimensions{scriptName usageModel} sum{requests errors subrequests cpuTimeUs duration} quantiles{cpuTimeP50 cpuTimeP95 cpuTimeP99 wallTimeP50 wallTimeP95 wallTimeP99 memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99 wasmMemoryBytesP50 wasmMemoryBytesP95 wasmMemoryBytesP99}}` });
  queries.push({ key: `scriptInvocations${index}`, kind: "durable-object-invocations-by-script", script,
    query: `durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{scriptName:${JSON.stringify(script)},${periodFilter}}){dimensions{namespaceId scriptName}avg{sampleInterval}sum{requests errors wallTime}quantiles{cpuTimeP50 cpuTimeP95 cpuTimeP99}}` });
}
for (let index = 0; index < namespaces.length; index++) {
  const namespace = namespaces[index];
  if (!/^[a-f0-9]{32}$/i.test(namespace.id)) throw new Error("Invalid namespace ID");
  const filter = `namespaceId:${JSON.stringify(namespace.id)},${periodFilter}`;
  queries.push({ key: `periodic${index}`, kind: "durable-object-periodic", namespace,
    query: `durableObjectsPeriodicGroups(limit:100,filter:{${filter}}){dimensions{namespaceId} avg{sampleInterval}sum{cpuTime activeTime duration rowsRead rowsWritten exceededCpuErrors exceededMemoryErrors fatalInternalErrors}max{memoryUsageBytes} quantiles{memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99 memoryUsageBytesP999}}` });
  queries.push({ key: `objects${index}`, kind: "durable-object-periodic-by-object", namespace,
    query: `durableObjectsPeriodicGroups(limit:1000,filter:{${filter}}){dimensions{namespaceId objectId name} avg{sampleInterval}sum{cpuTime activeTime duration rowsRead rowsWritten}max{memoryUsageBytes} quantiles{memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99}}` });
  queries.push({ key: `invocations${index}`, kind: "durable-object-invocations", namespace,
    query: `durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{${filter}}){dimensions{namespaceId} avg{sampleInterval}sum{requests errors wallTime}quantiles{cpuTimeP50 cpuTimeP95 cpuTimeP99}}` });
  queries.push({ key: `sqlStorage${index}`, kind: "durable-object-sql-storage", namespace,
    query: `durableObjectsSqlStorageGroups(limit:100,filter:{${filter}}){dimensions{namespaceId}max{storedBytes}}` });
}
const results = [];
// Keep unrelated schemas from blocking all metrics if an account lacks one dataset.
for (const request of queries) {
  const query = `{viewer{accounts(filter:{accountTag:${JSON.stringify(account)}}){metrics:${request.query}}}}`;
  const response = await graphql(query);
  results.push({ ...request, query, httpStatus: response.httpStatus, errors: response.errors,
    rows: response.data?.viewer?.accounts?.[0]?.metrics ?? [] });
}
const evidence = {
  generatedAt: new Date().toISOString(), account, prefix, since, until, namespaces, inventoryError, inventorySource: options.inventory ?? "live",
  schemaError: schemaResult.errors, schema,
  datasetSettings: settingsResult.data?.viewer?.accounts?.[0]?.settings ?? null,
  datasetSettingsErrors: settingsResult.errors, results,
  units: { workerCpuTimeUs: "microseconds", workerCpuQuantiles: "microseconds", durableObjectCpuTime: "microseconds", activeTime: "microseconds", duration: "GB*s", memoryUsageBytes: "bytes for the entire V8 isolate", rowsRead: "SQLite rows read", rowsWritten: "SQLite rows written including index writes", storedBytes: "namespace maximum stored bytes in the selected window, not byte-hours" },
  limitations: [
    "GraphQL data can arrive after the query. Empty rows and zero memory fields are retained, not treated as proof of zero consumption.",
    "Memory describes the entire V8 isolate and can include multiple DOs. Filtering to one object does not make this a per-object heap measurement.",
    "The interval contains every request to these prefixed resources, including setup and health checks. It is not attributed to one benchmark case.",
    "Worker and DO datasets overlap in infrastructure scope; do not add their CPU or duration totals as a bill.",
    "The Worker dataset has no DO namespace or object dimension. Its CPU and memory cannot substitute for missing caller-DO telemetry.",
    "The DO invocation dataset reports scriptName as __unknown__ on this account; namespaceId filters are required for complete attribution.",
    "Adaptive sampleInterval is included so the precision of observed aggregates can be assessed; short per-object samples may be absent.",
    "DO CPU time is actual CPU telemetry. DO billed compute uses duration in GB*s, not CPU time alone; analytics is not a final billing invoice.",
    "SQL storage max(storedBytes) is a capacity sample, not a time integral. A byte-hour charge needs interval samples or a stated upper-bound holding interval.",
  ],
};
const serialized = JSON.stringify(evidence, null, 2);
if (serialized.includes(token)) throw new Error("Refusing to save credentials");
await writeFile(options.out, `${serialized}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output: resolve(options.out), since, until, namespaces,
  results: results.filter(result => result.kind !== "durable-object-periodic-by-object").map(({ key, kind, namespace, script, errors, rows }) => ({ key, kind, namespace, script, errors, rows })) }, null, 2));

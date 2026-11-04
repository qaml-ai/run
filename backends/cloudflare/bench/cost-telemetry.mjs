// Read-only usage for the prefixed prototype. Never prints or saves credentials.
import { writeFile } from "node:fs/promises";

const account = "85bbd288051330fb51ee1c86031a299b";
const prefix = "camelrun-proto-";
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("Missing configured Cloudflare credential");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const since = "2026-11-04T19:38:00Z";
const until = new Date().toISOString();
const output = process.argv[2] ?? new URL("./.state/cost-telemetry.json", import.meta.url);
async function graphql(query) {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", headers, body: JSON.stringify({ query }), signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  return { status: response.status, errors: body.errors ?? null, rows: body.data?.viewer?.accounts?.[0]?.metrics ?? [] };
}
const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications`, {
  headers, signal: AbortSignal.timeout(30_000),
});
const apps = await response.json();
if (!response.ok || !apps.success) throw new Error("Cannot read container inventory");
const owned = (Array.isArray(apps.result) ? apps.result : apps.result?.applications ?? [])
  .filter(app => typeof app.name === "string" && app.name.startsWith(prefix))
  .map(app => ({ id: app.id, name: app.name }));
const filter = `datetime_geq:${JSON.stringify(since)},datetime_leq:${JSON.stringify(until)}`;
const results = [];
for (const app of owned) {
  if (!/^[a-f0-9]{32}$/.test(app.id)) throw new Error("Invalid app id");
  results.push({ kind: "containers", app, ...await graphql(`{viewer{accounts(filter:{accountTag:${JSON.stringify(account)}}){metrics:containersUsageAdaptiveGroups(limit:100,filter:{applicationId:${JSON.stringify(app.id)},${filter}}){dimensions{applicationId}sum{allocatedDisk allocatedMemory cpuTimeSec txBytes}}}}}`) });
}
const bucket = "camelrun-proto-computer-backups";
results.push({ kind: "r2-operations", bucket,
  ...await graphql(`{viewer{accounts(filter:{accountTag:${JSON.stringify(account)}}){metrics:r2OperationsAdaptiveGroups(limit:100,filter:{bucketName:${JSON.stringify(bucket)},${filter}}){dimensions{bucketName actionType actionStatus}sum{requests responseBytes responseObjectSize}}}}}`) });
results.push({ kind: "r2-storage", bucket,
  ...await graphql(`{viewer{accounts(filter:{accountTag:${JSON.stringify(account)}}){metrics:r2StorageAdaptiveGroups(limit:100,filter:{bucketName:${JSON.stringify(bucket)},${filter}}){dimensions{bucketName date}max{payloadSize metadataSize objectCount uploadCount}}}}}`) });
const report = { at: new Date().toISOString(), since, until, results, units: {
  allocatedDisk: "byte-seconds; divide by 1e9 for GB-seconds",
  allocatedMemory: "byte-seconds; divide by 2**30 for GiB-seconds",
  cpuTimeSec: "vCPU-seconds", payloadSize: "bytes",
}, limitation: "Delayed sampled usage is an estimate, not an invoice. Empty rows are not evidence of zero consumption." };
const serialized = JSON.stringify(report, null, 2);
if (serialized.includes(token)) throw new Error("Refusing credential output");
await writeFile(output, `${serialized}\n`, { mode: 0o600 });
console.log(serialized);

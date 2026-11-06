// node do.mjs <from ISO> <to ISO>  -> per-object, per-minute DO duration (GB-s), plus Worker invocations
const token = process.env.CLOUDFLARE_API_TOKEN, account = "85bbd288051330fb51ee1c86031a299b";
const ns = "fb0d60f014ee4c62ab1b0314636a91bb", script = "sse-bridge-proto-6c912d";
const [from, to] = process.argv.slice(2);
const query = `{ viewer { accounts(filter:{accountTag:"${account}"}) {
  durableObjectsPeriodicGroups(limit:1000,filter:{datetime_geq:"${from}",datetime_leq:"${to}",namespaceId:"${ns}"},orderBy:[datetimeMinute_ASC]) { dimensions {datetimeMinute objectId} sum {duration activeTime cpuTime inboundWebsocketMsgCount outboundWebsocketMsgCount} }
  durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{datetime_geq:"${from}",datetime_leq:"${to}",namespaceId:"${ns}"},orderBy:[datetimeMinute_ASC]){dimensions{datetimeMinute objectId type}sum{requests wallTime errors}}
  workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:"${from}",datetime_leq:"${to}",scriptName:"${script}"},orderBy:[datetimeMinute_ASC]){dimensions{datetimeMinute status}sum{requests errors subrequests cpuTimeUs wallTime duration} quantiles{cpuTimeP50 cpuTimeP99 cpuTimeP999}}
} } }`;
const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query }) });
const j = await r.json();
console.log(JSON.stringify({ queriedAt: new Date().toISOString(), query, ...j }, null, 1));

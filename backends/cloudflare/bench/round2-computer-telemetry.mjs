import { readFile, writeFile } from "node:fs/promises";
const token=process.env.CLOUDFLARE_API_TOKEN;
if(!token)throw Error("Configured Cloudflare credential required");
const account="85bbd288051330fb51ee1c86031a299b";
const script="camelrun-proto-r2-sync";
const headers={authorization:`Bearer ${token}`,"content-type":"application/json"};
let namespace;
for(let page=1;page<=20;page++) {
  const inventory=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/durable_objects/namespaces?per_page=1000&page=${page}`,{headers}).then(x=>x.json());
  namespace=inventory.result?.find(x=>x.script===script&&x.class===script);
  if(namespace || inventory.result?.length<1000)break;
}
if(!namespace)throw Error("Benchmark namespace not found");
const since=process.argv[2]??"2026-11-04T20:25:55Z", until=new Date().toISOString();
const filter=`namespaceId:${JSON.stringify(namespace.id)},datetime_geq:${JSON.stringify(since)},datetime_leq:${JSON.stringify(until)}`;
const query=`{viewer{accounts(filter:{accountTag:${JSON.stringify(account)}}){metrics:durableObjectsPeriodicGroups(limit:1000,filter:{${filter}}){dimensions{objectId}sum{cpuTime activeTime duration exceededCpuErrors exceededMemoryErrors fatalInternalErrors}quantiles{memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99}} invocations:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{${filter}}){sum{requests errors wallTime}quantiles{cpuTimeP50 cpuTimeP95 cpuTimeP99}} workers:workersInvocationsAdaptive(limit:100,filter:{scriptName:${JSON.stringify(script)},datetime_geq:${JSON.stringify(since)},datetime_leq:${JSON.stringify(until)}}){sum{requests errors cpuTimeUs}quantiles{memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99}}}}}`;
const response=await fetch("https://api.cloudflare.com/client/v4/graphql",{method:"POST",headers,body:JSON.stringify({query})});
const data=await response.json();
const metrics=data.data?.viewer?.accounts?.[0];
const result={at:new Date().toISOString(),since,until,script,namespaceId:namespace.id,status:response.status,errors:data.errors??null,rows:metrics?.metrics??[],invocations:metrics?.invocations??[],workers:metrics?.workers??[],scope:"memory covers the entire Worker isolate, not per-object allocation"};
const serialized=JSON.stringify(result,null,2);if(serialized.includes(token))throw Error("Credential output refused");
await writeFile(new URL("./.state/round2-computer-telemetry.json",import.meta.url),serialized,{mode:0o600});
console.log(serialized);

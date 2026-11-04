import { readFile, writeFile } from "node:fs/promises";
const read=async name=>JSON.parse(await readFile(new URL(`./.state/${name}.json`,import.meta.url),"utf8"));
const report=await read("round2-computer-results");
const artifact={...report, exportedAt:new Date().toISOString(),
  resources:{worker:"camelrun-proto-r2-sync",namespace:"a55ea0128ec747febc58fc13e1136693",containerApplication:"a55ea0128ec747febc58fc13e1136693",
    imageRepository:"camelrun-proto-r2-sync-camelrun-proto-r2-sync-workspace",imageTags:["wrangler-mw2kdhfa","wrangler-mw2kfh4k"],snapshots:[],r2Buckets:[]},
  setupFailure:{code:10021,reason:"Cloudflare rejected the experimental compatibility flag. Deployment and both backends succeeded after omitting the flag."},
  telemetry:await read("round2-computer-telemetry"),
  duringLargeBuild:await read("round2-computer-during-build"),
  afterLongRequestFailure:await read("round2-computer-after-timeout"),
  stoppedInstances:await read("round2-computer-stopped"),
  limitations:["Client timing includes network round trips; samples are not latency percentiles.","The 5k and 20k fixtures are synthetic flat directories of independent TypeScript modules.","The 20k build's HTTP call failed at 301 seconds. Its compiler still ran at 346 seconds. A later diagnostic code deployment interrupted the session; the recovered execution was cancelled with exit 143. No successful 20k build duration is claimed.","The partial 20k build pull ran concurrently with the still-running compiler; it is not the total final-output sync time.","Container RSS and Worker isolate memory are different measurements. DO-filtered memory still describes an entire isolate.","GraphQL rows lag the run and are not a complete invoice."]};
const encoded=JSON.stringify(artifact,null,2);
const bearer=(await readFile(new URL("./.state/api-token",import.meta.url),"utf8")).trim();
if([bearer,process.env.CLOUDFLARE_API_TOKEN].filter(Boolean).some(x=>encoded.includes(x)))throw Error("Credential export refused");
const path=new URL("../docs/round2-computer-backend.json",import.meta.url);
await writeFile(path,encoded+"\n");console.log(JSON.stringify({output:path.pathname,bytes:encoded.length,records:report.records.length}));

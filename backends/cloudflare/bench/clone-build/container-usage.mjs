// Delayed metered Container usage, filtered to the dedicated benchmark apps.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const account='85bbd288051330fb51ee1c86031a299b',prefix='camelrun-proto-bench-',since='2026-11-04T21:00:00Z';
const token=process.env.CLOUDFLARE_API_TOKEN;if(!token)throw new Error('Missing CF credential');
const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
const inventory=JSON.parse(await readFile(process.argv[2],'utf8'));
const apps=inventory.resources.containers.items,until=new Date().toISOString(),results=[];
for(const app of apps){
 if(!app.name.startsWith(prefix)||!/^[a-f0-9]{32}$/.test(app.id))throw new Error('App outside benchmark scope');
 const query=`{viewer{accounts(filter:{accountTag:${JSON.stringify(account)}}){metrics:containersUsageAdaptiveGroups(limit:100,filter:{applicationId:${JSON.stringify(app.id)},datetime_geq:${JSON.stringify(since)},datetime_leq:${JSON.stringify(until)}}){dimensions{applicationId}sum{allocatedDisk allocatedMemory cpuTimeSec txBytes}}}}}`;
 const r=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers,body:JSON.stringify({query}),signal:AbortSignal.timeout(30000)}),body=await r.json();
 results.push({app,httpStatus:r.status,errors:body.errors??null,rows:body.data?.viewer?.accounts?.[0]?.metrics??[]});
}
const report={since,until,results,units:{allocatedDisk:'byte-seconds / 1e9 = GB-s',allocatedMemory:'byte-seconds / 2^30 = GiB-s',cpuTimeSec:'active vCPU-seconds',txBytes:'egress bytes'},caveat:'Empty or delayed rows are not zero usage. Rates exclude account allowances; estimates are not an invoice.'};
const output=process.argv[3]??new URL('./.state/container-usage.json',import.meta.url);await mkdir(new URL('./.state/',import.meta.url),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));

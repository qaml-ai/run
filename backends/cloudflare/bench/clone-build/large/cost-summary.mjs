// Summarize saved benchmark usage without contacting Cloudflare or reading secrets.
// node cost-summary.mjs [--inventory FILE --containers FILE --telemetry FILE --out FILE] RESULT...
import {readFile,writeFile} from 'node:fs/promises';
import {runWindow} from './run-window.mjs';
const defaults={inventory:new URL('../.state/all-deployed.json',import.meta.url),containers:new URL('../.state/container-usage.json',import.meta.url),telemetry:new URL('../.state/telemetry-active.json',import.meta.url)};
const options={...defaults},files=[];
for(let i=2;i<process.argv.length;i++){
 const arg=process.argv[i];
 if(arg.startsWith('--')){const key=arg.slice(2);if(!['inventory','containers','telemetry','out'].includes(key)||!process.argv[i+1])throw new Error('Invalid option');options[key]=process.argv[++i];}
 else files.push(arg);
}
if(!files.length)throw new Error('Pass at least one saved runner result JSON');
const load=async path=>JSON.parse(await readFile(path,'utf8'));
const [inventory,containerUsage,telemetry,...runs]=await Promise.all([load(options.inventory),load(options.containers),load(options.telemetry),...files.map(load)]);
const rates={containerCpuPerVcpuSecond:0.000020,containerMemoryPerGiBSecond:0.0000025,containerDiskPerGBSecond:0.00000007,workerPerRequest:0.30/1e6,workerPerCpuMs:0.02/1e6,doPerRequest:0.15/1e6,doPerGBSecond:12.50/1e6};
const sizeTable={basic:{name:'basic',vcpu:0.25,memoryGiB:1,diskGB:4},s2:{name:'standard-2',vcpu:1,memoryGiB:6,diskGB:12},s4:{name:'standard-4',vcpu:4,memoryGiB:12,diskGB:20},sdk:{name:'default lite',vcpu:1/16,memoryGiB:0.25,diskGB:2},computer:{name:'standard-2',vcpu:1,memoryGiB:6,diskGB:12}};
const sum=(rows,key)=>rows.reduce((v,row)=>v+Number(row.sum?.[key]??0),0);
const safeSum=(rows,key)=>rows.length&&rows.every(r=>typeof r.sum?.[key]==='number'&&Number.isFinite(r.sum[key]))?sum(rows,key):null;
const scriptOf=run=>new URL(run.url).hostname.split('.')[0];
const scripts=runs.map(scriptOf);
const records=[];
for(let i=0;i<runs.length;i++){
 const run=runs[i],script=scripts[i];if(!script.startsWith('camelrun-proto-bench-'))throw new Error('Unexpected saved Worker');
 const window=runWindow(run);
 const namespace=inventory.resources?.durableObjects?.items?.find(n=>n.script===script&&/(machine|computer)$/.test(n.class));
 const app=inventory.resources?.containers?.items?.find(a=>a.id===namespace?.id);
 const dataset=containerUsage.results?.find(r=>r.app.id===app?.id),data=dataset?.rows??[];
 const rawMemory=safeSum(data,'allocatedMemory'),rawDisk=safeSum(data,'allocatedDisk'),cpu=safeSum(data,'cpuTimeSec'),tx=safeSum(data,'txBytes');
 const metered=data.length&&cpu!==null&&rawMemory!==null&&rawDisk!==null?{cpuVcpuSeconds:cpu,memoryGiBSeconds:rawMemory/(2**30),diskGBSeconds:rawDisk/1e9,egressBytes:tx,cpuUsd:cpu*rates.containerCpuPerVcpuSecond,memoryUsd:rawMemory/(2**30)*rates.containerMemoryPerGiBSecond,diskUsd:rawDisk/1e9*rates.containerDiskPerGBSecond}:null;
 if(metered)metered.computeUsd=metered.cpuUsd+metered.memoryUsd+metered.diskUsd;
 const baseLabel=run.label?.startsWith('computer')?'computer':run.label?.startsWith('sdk')?'sdk':run.label;
 const allocation=sizeTable[baseLabel],seconds=Number.isFinite(window.startMs)&&Number.isFinite(window.endMs)?Math.max(0,(window.endMs-window.startMs)/1000):null;
 const upper=allocation&&seconds!==null?{allocation,seconds,closedByObservedStop:window.closedByObservedStop,cpuUsd:seconds*allocation.vcpu*rates.containerCpuPerVcpuSecond,memoryUsd:seconds*allocation.memoryGiB*rates.containerMemoryPerGiBSecond,diskUsd:seconds*allocation.diskGB*rates.containerDiskPerGBSecond}:null;
 if(upper)upper.computeUsd=upper.cpuUsd+upper.memoryUsd+upper.diskUsd;
 const assistant=(run.history?.messages??[]).filter(m=>m.role==='assistant'),withUsage=assistant.filter(m=>m.usage);
 const completePrices=withUsage.length>0&&withUsage.every(m=>Number.isFinite(m.usage.cost?.total));
 const model={messagesWithUsage:withUsage.length,assistantMessages:assistant.length,reservedDispatches:run.trace?.modelCalls??null,input:0,output:0,cacheRead:0,cacheWrite:0,estimatedUsd:completePrices?0:null};
 for(const m of withUsage){for(const k of['input','output','cacheRead','cacheWrite'])model[k]+=Number(m.usage[k]??0);if(completePrices)model.estimatedUsd+=m.usage.cost.total;}
 const workerDatasets=telemetry.results.filter(r=>r.kind==='worker'&&r.script===script),workerRows=workerDatasets.flatMap(r=>r.rows??[]);
 const invDatasets=telemetry.results.filter(r=>r.kind==='durable-object-invocations'&&r.namespace?.script===script),invRows=invDatasets.flatMap(r=>r.rows??[]);
 const periodicDatasets=telemetry.results.filter(r=>r.kind==='durable-object-periodic'&&r.namespace?.script===script),periodicRows=periodicDatasets.flatMap(r=>r.rows??[]);
 const workerRequests=safeSum(workerRows,'requests'),workerCpuUs=safeSum(workerRows,'cpuTimeUs'),doRequests=safeSum(invRows,'requests'),doGBSeconds=safeSum(periodicRows,'duration');
 const partial={workerRequests,workerCpuUs,workerUsd:workerRequests!==null&&workerCpuUs!==null?workerRequests*rates.workerPerRequest+workerCpuUs/1000*rates.workerPerCpuMs:null,doRequests,doGBSeconds,doRequestUsd:doRequests===null?null:doRequests*rates.doPerRequest,doComputeUsd:doGBSeconds===null?null:doGBSeconds*rates.doPerGBSecond,errors:[...workerDatasets,...invDatasets,...periodicDatasets].flatMap(r=>r.errors??[]),hasAllNamespaceInvocationRows:invDatasets.length>0&&invDatasets.every(d=>d.rows?.length),hasAllNamespacePeriodicRows:periodicDatasets.length>0&&periodicDatasets.every(d=>d.rows?.length)};
 const repeated=scripts.filter(s=>s===script).length>1;
 records.push({label:run.label,agent:run.agent?.id??null,resultFile:files[i],script,app,sharedScriptAcrossResults:repeated,runWindow:window,containerUsage:{status:dataset?.errors?.length?'error':data.length?'available':'unavailable_or_delayed',errors:dataset?.errors??null,metered},allocationTimeUpperEstimate:upper,model,partialWorkerAndDoTelemetry:partial});
}
const unique=new Map();for(const row of records)if(row.app&&!unique.has(row.app.id))unique.set(row.app.id,row);
const duplicateAgentSnapshots=[...new Set(records.map(row=>row.agent).filter(Boolean))].filter(agent=>records.filter(row=>row.agent===agent).length>1);
const report={at:new Date().toISOString(),rates,sources:{inventory:String(options.inventory),containers:String(options.containers),telemetry:String(options.telemetry)},windows:{containers:{since:containerUsage.since,until:containerUsage.until},workerDo:{since:telemetry.since,until:telemetry.until}},rows:records,duplicateAgentSnapshots,totals:{uniqueApps:unique.size,meteredContainerComputeUsd:unique.size>0&&[...unique.values()].every(r=>r.containerUsage.metered)?[...unique.values()].reduce((n,r)=>n+r.containerUsage.metered.computeUsd,0):null,allocationTimeUpperEstimateUsd:!duplicateAgentSnapshots.length&&records.every(r=>r.allocationTimeUpperEstimate?.closedByObservedStop)?records.reduce((n,r)=>n+r.allocationTimeUpperEstimate.computeUsd,0):null,modelEstimatedUsd:!duplicateAgentSnapshots.length&&records.every(r=>r.model.estimatedUsd!==null)?records.reduce((n,r)=>n+r.model.estimatedUsd,0):null},caveats:['Empty/missing/error telemetry is unknown, never zero. Available rows may be delayed or incomplete.','Metered Container values apply to each whole app and analytics window; multiple result files on one app are not individually attributable.','The allocation-time estimate assumes full nominal CPU and allocated RAM/disk for the entire start-to-observed-stop interval, including sleep. It is a planning estimate, not metered usage or an invoice. If no observed stop exists, its interval ends at the last saved event and does not bound subsequent running time.','Pass the latest result once per agent, plus separate failed agents. Duplicate agent snapshots disable model/allocation totals to avoid double counting. Manual diagnostic agents and gaps between saved runs are not covered by the allocation/model estimate; whole-app telemetry may include them.','Worker costs use only requests and CPU; DO costs use one namespace-level invocation and periodic dataset each. Script/object duplicate aggregates are excluded.','Model costs are SDK price estimates from saved usage, not provider billing receipts; failed requests may be missing usage.','Included allowances, minimum charges/rounding, contract discounts, logs, SQLite, egress, registry, retained snapshot storage and other unreported costs are excluded. Retained snapshot prices are unknown.']};
const text=JSON.stringify(report,null,2)+'\n';if(options.out)await writeFile(options.out,text);console.log(text);

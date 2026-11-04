// Real, small R2 operation sample; only this prefixed bucket is touched.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const bucket='camelrun-proto-r2-cost',run=promisify(execFile);
const config='bench/round2-agent.wrangler.jsonc';
const fixture='bench/.state/r2-fixture.bin',data=Buffer.alloc(65536,0x52);
await writeFile(fixture,data);
const report={startedAt:new Date().toISOString(),bucket,bytesPerObject:data.length,objects:8,operations:[]};
async function command(args,label){const s=performance.now();await run(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args,'--config',config],{env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:'bench/.state/logs'},timeout:60000});report.operations.push({label,ms:performance.now()-s});await writeFile('docs/round2-r2.json',JSON.stringify(report,null,2)+'\n');console.log(label);}
await command(['r2','bucket','create',bucket,'--location','wnam'],'create');
for(let i=0;i<8;i++)await command(['r2','object','put',`${bucket}/sample-${i}`,'--file',fixture,'--remote','--force'],`put-${i}`);
for(let i=0;i<8;i++){
 const path=`bench/.state/r2-read-${i}.bin`;await command(['r2','object','get',`${bucket}/sample-${i}`,'--file',path,'--remote'],`get-${i}`);
 if(!data.equals(await readFile(path)))throw new Error('R2 byte verification failed');
}
report.sha256=createHash('sha256').update(data).digest('hex');report.verifiedObjects=8;
for(let i=0;i<8;i++)await command(['r2','object','delete',`${bucket}/sample-${i}`,'--remote'],`delete-${i}`);
report.finishedAt=new Date().toISOString();report.expectedObjectOperations={classA:8,classB:8,freeDelete:8};report.unroundedObjectOperationUsd=(8*4.5+8*.36)/1e6;
await writeFile('docs/round2-r2.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({bucket,verifiedObjects:8,operationUsd:report.unroundedObjectOperationUsd,bucketRetainedForTelemetry:true}));

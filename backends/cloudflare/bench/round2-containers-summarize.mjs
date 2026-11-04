import {readFile,writeFile} from 'node:fs/promises';
const sources=['../docs/round2-containers.json','.state/native-large-captured.json','.state/native-integrity.json','.state/native-repeat.json','.state/native-basic-recovery.json','.state/native-basic-recovery-long.json','.state/native-basic-diagnostics.json','.state/native-image-delete-restore.json','.state/native-cleanup.json'];
const documents=[];
for(const path of sources){try{documents.push(JSON.parse(await readFile(new URL(path,import.meta.url),'utf8')));}catch(error){if(error.code!=='ENOENT')throw error;}}
const unique=new Map();const failures=new Map();
for(const document of documents){
 for(const row of document.records??[])unique.set(row.at+'|'+row.size+'|'+row.label,row);
 for(const row of document.failures??[])failures.set(JSON.stringify(row),row);
}
const records=[...unique.values()].sort((a,b)=>a.at.localeCompare(b.at));
for(const row of records){if(row.result.parsedStdout){delete row.result.stdout;for(const v of row.result.parsedStdout)if(v.tail)v.tail=v.tail.replace(/\u001b\[[0-9;]*m/g,'').slice(-2000);}}
const snapshots=new Map();
for(const row of records){
 if(row.result.snapshot){const value=row.result;snapshots.set(value.snapshot.id,{...snapshots.get(value.snapshot.id),...value.snapshot,capturedAt:value.capturedAt,lastRestoredAt:value.lastRestoredAt??snapshots.get(value.snapshot.id)?.lastRestoredAt});}
}
for(const snapshot of snapshots.values())snapshot.estimatedExpiresAt=new Date(Date.parse(snapshot.lastRestoredAt??snapshot.capturedAt)+30*86400000).toISOString();
const find=(size,label)=>records.find(r=>r.size===size&&r.label===label);
const buildResult=(size)=>size==='basic'?find(size,'build-recovered')?.result.parsedStdout?.[0]:find(size,'build')?.result.parsedStdout?.[0];
const stages=Object.fromEntries(['basic','standard-2'].map(size=>[size,{cloneMs:find(size,'clone')?.result.parsedStdout?.[0]?.elapsedMs,installMs:find(size,'install')?.result.parsedStdout?.[0]?.elapsedMs,build:buildResult(size)}]));
const rss=/Maximum resident set size \(kbytes\): (\d+)/.exec(find('standard-2','repeat-clean-build')?.result.stderr??'');
const finalInstanceState=JSON.parse(await readFile(new URL('.state/native-final-instances.json',import.meta.url),'utf8').catch(()=>'{"unavailable":true}'));
const boundedBuildFailures=Object.entries(stages).filter(([,value])=>value.build&&value.build.code!==0).map(([size,value])=>({size,operation:'build:compiler',elapsedMs:value.build.elapsedMs,signal:value.build.signal,exitCode:value.build.code,reason:'The configured 900-second timeout killed the process group; observed completion includes kill/drain delay.'}));
const report={
 generatedAt:new Date().toISOString(),startedAt:records[0]?.at,
 repository:'https://github.com/microsoft/TypeScript',ref:'v5.9.3',commit:'c63de15a992d37f0d6cec03ac7631872838602cb',
 commands:{clone:['git','clone','--depth','1','--branch','v5.9.3','https://github.com/microsoft/TypeScript.git','repo'],install:['npm','ci','--no-audit','--no-fund'],build:['npm','run','build:compiler']},
 resources:{worker:'camelrun-proto-r2-computers',class:'camelrun-proto-r2-native',applicationId:'1d1384d055924d36b25f963e05ddbcd5',image:'camelrun-proto-r2-computers-camelrun-proto-r2-native-workspace:wrangler-mw2kc4mk',imageDigest:'sha256:1a58f37c29462cccd44a6be4207194dc3ab04acb1d574bb5b320c712f39da61d'},
 unauthorizedStatus:401,records,failures:[...failures.values()],boundedBuildFailures,finalInstanceState,retainedSnapshots:[...snapshots.values()],integrityEqual:documents.some(x=>x.integrityEqual===true),
 measurements:{stages,standard2RepeatBuildMs:find('standard-2','repeat-clean-build')?.result.elapsedMs,standard2PeakProcessRssKiB:rss?Number(rss[1]):undefined,restoredAfterNormalImageTagDeletion:!!find('basic','verify-after-image-tag-delete')},
 documentedLimits:{snapshotMaximumBytes:20000000000,snapshotRetentionDays:30,refreshOnRestore:true,maximumExperimentallyTested:false},
  limitations:['One initial clone/install/build per instance type; command timings exclude wrapper scans and initial placement.','Native snapshot covers writable root filesystem and is tied to original image version; SDK DirectoryBackup and native snapshots used different trees and instance types.','Expiry is documented last-restore-plus-30-days, not an observed expiration.','Linux cgroup memory files were unavailable; cgroup CPU output is not used as billing attribution.','Build is the real compiler/services target, not the full upstream test suite. Node 24 npm did not authorize optional lifecycle scripts; no install-script setting was changed.','The original Node22 fetch client hit UND_ERR_HEADERS_TIMEOUT after five minutes on basic. The runner now uses node:https with an explicit deadline. A separate request retrieves the already-running build result without rerunning it.'],
 sources:['https://developers.cloudflare.com/containers/guides/snapshots/','https://developers.cloudflare.com/containers/api/durable-object-container/','https://developers.cloudflare.com/containers/platform/limits/','https://developers.cloudflare.com/containers/platform/pricing/']
};
const text=JSON.stringify(report,null,2);
const token=(await readFile(new URL('.state/api-token',import.meta.url),'utf8')).trim();
if(text.includes(token)||process.env.CLOUDFLARE_API_TOKEN&&text.includes(process.env.CLOUDFLARE_API_TOKEN))throw new Error('Refusing credential output');
await writeFile(new URL('../docs/round2-containers.json',import.meta.url),text+'\n');
console.log(JSON.stringify({records:records.length,retainedSnapshots:report.retainedSnapshots,integrityEqual:report.integrityEqual,failures:report.failures}));

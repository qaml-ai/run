// Verify a completed retained run without network calls or cloud mutations.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const file=process.argv[2];
if(!file)throw Error('Usage: node scripts/verify-results.mjs measurements/cloud-....json[.gz]');
const bytes=await readFile(resolve(file));
const report=JSON.parse((file.endsWith('.gz')?gunzipSync(bytes):bytes).toString('utf8'));
const failures=[],notes=[];
let checks=0;
function check(ok,message) {checks++;if(!ok)failures.push(message);}
const ok=operation=>operation?.status===200&&!operation?.error&&!operation?.data?.error;
const fixtures=report.fixture?.images??[];
const expectedCount=report.smoke?1:100;
check(!report.error,`Run error: ${report.error}`);
check(report.fixture?.count===expectedCount,`Expected ${expectedCount} corpus images`);
check(fixtures.length===expectedCount,'Corpus manifest length differs from requested count');
check(new Set(fixtures.map(row=>row.originalSha256)).size===expectedCount,'Original corpus hashes are not distinct');
check(new Set(fixtures.map(row=>row.ref?.sha256)).size===expectedCount,'Derivative corpus hashes are not distinct');
check(fixtures.every(row=>row.ref?.size>=2*1024*1024&&row.ref.size<=5*1024*1024),'Derivative outside requested 2–5 MiB range');
check(report.manifest?.data?.refs?.length===expectedCount,'Stored manifest count differs from uploaded corpus');

function matches(operation,count,label,mode) {
  const success=ok(operation);
  check(success,`${label}: HTTP/transport/model failure`);
  if(!success)return;
  const data=operation?.data,summary=data?.summary;
  check(data?.match===true,`${label}: server did not report all hashes matched`);
  check(summary?.imageCount===count,`${label}: wrong image count`);
  check(summary?.images?.length===count,`${label}: wrong digest count`);
  for(let index=0;index<count;index++) {
    const image=summary?.images?.[index],ref=fixtures[index]?.ref;
    check(!!ref&&image?.sha256===ref.sha256&&image?.bytes===ref.size,`${label}: digest/byte mismatch at image ${index}`);
    if(mode)check(image?.source===(mode==='D'?'url':'base64'),`${label}: wrong image transport at image ${index}`);
  }
  if(mode==='B'||mode==='C') {
    check(summary?.contentLengthMatches===true,`${label}: fixed Content-Length did not match bytes read`);
    check(summary?.transferEncoding===null,`${label}: transfer used chunked encoding`);
  }
}

const cases=report.cases??[];
const singleKeys=new Set(cases.map(row=>`${row.mode}/${row.count}/${row.api}`));
check(singleKeys.size===cases.length,'Duplicate single-case identifiers');
for(const mode of ['A','B','C','D']) {
  for(const count of report.smoke?[1]:[1,20,100])check(singleKeys.has(`${mode}/${count}/openai-completions`),`Missing ${mode}/${count}/openai-completions case`);
  for(const api of ['openai-responses','anthropic-messages'])check(singleKeys.has(`${mode}/1/${api}`),`Missing ${mode}/1/${api} case`);
}
for(const row of cases) {
  const label=`${row.mode}/${row.count}/${row.api}`;
  if(row.mode==='A'&&row.count>1) {
    if(ok(row.seed)&&row.request?.data?.match)matches(row.request,row.count,label,row.mode);
    else notes.push(`${label}: baseline failure retained as an expected experiment outcome`);
  } else {
    check(ok(row.seed),`${label}: seed failed`);
    matches(row.request,row.count,label,row.mode);
    const constructor=row.seed?.data?.constructorId;
    check(!!constructor&&constructor===row.request?.data?.constructorId,`${label}: constructor changed during successful request`);
  }
}

const faults=report.faults??[];
check(faults.length===9,'Expected retry, abort, and missing-object checks for B/C/D');
for(const mode of ['B','C','D'])for(const fault of ['retry','abort','missing']) {
  const rows=faults.filter(row=>row.mode===mode&&row.fault===fault);
  check(rows.length===1,`Expected exactly one ${mode}/${fault} fault case`);
  const row=rows[0];if(!row)continue;
  const label=`${mode}/${fault}`,count=report.smoke?1:20;
  check(ok(row.seed),`${label}: seed failed`);
  if(fault==='retry') {
    matches(row.request,count,label,mode);
    check(row.request?.data?.calls>=2,`${label}: injected disconnect did not produce a fresh adapter call`);
  } else if(fault==='abort') {
    check(row.request?.data?.stopReason==='aborted',`${label}: request did not report aborted`);
  } else {
    check(row.request?.data?.stopReason==='error',`${label}: request did not reject missing object`);
    const reason=[row.request?.data?.error,row.request?.data?.transportError].filter(Boolean).join(' ');
    check(/missing image|image transport failed|\b404\b/i.test(reason),`${label}: error did not identify missing image or failed image transport`);
  }
  if(fault!=='missing')matches(row.recovery,count,`${label}/recovery`,mode);
}

const replay=report.replay??[];
check(replay.length===3,'Expected three eviction/replay/probe cases');
for(const mode of ['B','C','D']) {
  const rows=replay.filter(row=>row.mode===mode);
  check(rows.length===1,`Expected exactly one ${mode} replay`);
  const row=rows[0];if(!row)continue;
  const label=`${mode}/replay`,count=report.smoke?1:20;
  check(ok(row.seed)&&ok(row.before)&&ok(row.after),`${label}: seed/status failed`);
  check(row.evict?.data?.evicted===true,`${label}: eviction was not acknowledged`);
  check(!!row.before?.data?.constructorId&&row.before.data.constructorId!==row.after?.data?.constructorId,`${label}: constructor did not change after forced eviction`);
  check(!!row.before?.data?.objectId&&row.before.data.objectId===row.after?.data?.objectId,`${label}: replay targeted a different object`);
  matches(row.request,count,label,mode);
  check(ok(row.probe),`${label}: Pi probe failed`);
  const probe=row.probe?.data;
  for(const key of ['userInputMarkerAccepted','replayPreserved','forkPreserved','codeImageAccepted','codeSucceeded','plainReferenceRejected','malformedBase64Rejected','validPngMarkerAccepted'])check(probe?.[key]===true,`${label}/probe: ${key} failed`);
  check(probe?.afterToolCalls>0&&probe?.markedImages>0,`${label}/probe: afterTool did not externalize an image`);
  check(probe?.compaction?.outcome?.status==='completed',`${label}/probe: compaction failed`);
  check(probe?.compactionAddedEntries>0&&probe?.historicalMarkers>0,`${label}/probe: compaction/history evidence missing`);
  check(probe?.tokenEstimateOriginal===probe?.tokenEstimateMarker&&Number.isFinite(probe?.tokenEstimateMarker),`${label}/probe: marker changed fixed image token estimate`);
  check(Array.isArray(probe?.reports)&&probe.reports.length===0,`${label}/probe: Pi emitted an error report`);
  for(const key of ['small','oversized','wide','oversizedRefusedBeforeFullRead'])check(probe?.nativeReadCases?.[key]===true,`${label}/probe: native read ${key} failed`);
  if(probe?.codeOutputSavedMarkerCaveat)notes.push(`${label}/probe: ${probe.codeOutputSavedMarkerCaveat}`);
}

const concurrency=report.concurrency??[];
if(!report.smoke) {
  check(concurrency.length===12,'Expected twelve 50-agent groups');
  for(const mode of ['A','B','C','D'])for(const count of [1,20,100]) {
    const groups=concurrency.filter(group=>group.mode===mode&&group.count===count);
    check(groups.length===1,`Expected exactly one concurrent ${mode}/${count} group`);
    const group=groups[0];if(!group)continue;
    check(group.agents===50&&group.outcomes?.length===50,`${mode}/${count}: concurrency did not attempt exactly 50 agents`);
    check(new Set(group.outcomes?.map(row=>row.id)).size===50,`${mode}/${count}: concurrent agent names are not unique`);
    check(!!group.startedAt&&!!group.endedAt,`${mode}/${count}: concurrency group is incomplete`);
    if(mode==='A') {
      notes.push(`${mode}/${count}: baseline concurrent outcomes retained; successful requests still have hashes checked`);
      for(const row of group.outcomes??[])if(row.request?.data?.match)matches(row.request,count,`${mode}/${count}/${row.id}`,mode);
    } else for(const row of group.outcomes??[]) {
      check(ok(row.seed),`${mode}/${count}/${row.id}: concurrent seed failed`);
      matches(row.request,count,`${mode}/${count}/${row.id}`,mode);
    }
  }
}

check(!!report.cleanup?.at,'Cleanup did not complete');
check(Array.isArray(report.cleanup?.errors)&&report.cleanup.errors.length===0,'Cleanup reported errors');
for(const key of ['namespacesRemaining','workersRemaining','bucketsRemaining'])check(Array.isArray(report.cleanup?.[key])&&report.cleanup[key].length===0,`Cleanup ${key} is not confirmed empty`);
check(report.cleanup?.endpointStatuses?.length===3&&report.cleanup.endpointStatuses.every(row=>row.status===404),'Not all three deleted Worker endpoints returned 404');
const polls=report.telemetry??[];
if(!polls.some(poll=>poll.rows?.length))notes.push('DO telemetry is missing: memory, CPU and error counters remain unverified');
if(polls.some(poll=>poll.errors?.length||poll.error))notes.push('Some DO telemetry queries failed; preserve their errors and state coverage limits');
if(report.workersAiVision?.data?.error||report.workersAiVision?.error)notes.push('Optional Workers AI real-model check failed; this is not a fake-provider correctness failure');
const result={source:resolve(file),smoke:!!report.smoke,checks,passed:checks-failures.length,failed:failures.length,failures,notes};
console.log(JSON.stringify(result,null,2));
if(failures.length)process.exitCode=1;

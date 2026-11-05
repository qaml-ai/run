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
const realistic=report.profile==='realistic';
const modes=realistic?['B','D']:['A','B','C','D'];
const transportModes=realistic?['B','D']:['B','C','D'];
const expectedCount=report.smoke?1:100;
check(!report.error,`Run error: ${report.error}`);
check(report.fixture?.count===expectedCount,`Expected ${expectedCount} corpus images`);
check(fixtures.length===expectedCount,'Corpus manifest length differs from requested count');
check(new Set(fixtures.map(row=>row.originalSha256)).size===expectedCount,'Original corpus hashes are not distinct');
check(new Set(fixtures.map(row=>row.ref?.sha256)).size===expectedCount,'Derivative corpus hashes are not distinct');
if(realistic) {
  check(fixtures.every(row=>row.ref?.size>=200000&&row.ref.size<=400000),'Realistic derivative outside requested 200000–400000 byte range');
  check(fixtures.every(row=>row.ref?.mimeType==='image/jpeg'),'Realistic derivative is not declared JPEG');
  check(fixtures.every(row=>Number.isFinite(row.output?.width)&&row.output.width>0&&
    Number.isFinite(row.output?.height)&&row.output.height>0&&
    Math.max(row.output.width,row.output.height)<=1568),'Realistic derivative dimensions exceed 1568 pixels or are missing');
} else check(fixtures.every(row=>row.ref?.size>=2*1024*1024&&row.ref.size<=5*1024*1024),'Derivative outside requested 2–5 MiB range');
check(report.manifest?.data?.refs?.length===expectedCount,'Stored manifest count differs from uploaded corpus');

function cpuLimit(operation,label) {
  if(realistic)check(operation?.data?.cpuLimitMs===30000,`${label}: expected the deployed 30000 ms CPU limit`);
}

function matches(operation,count,label,mode,api='openai-completions') {
  cpuLimit(operation,label);
  const success=ok(operation);
  check(success,`${label}: HTTP/transport/model failure`);
  if(!success)return;
  const data=operation?.data,summary=data?.summary;
  check(data?.match===true,`${label}: server did not report all hashes matched`);
  if(realistic)check(data?.mimeMatch===true,`${label}: server did not report matching image MIME types`);
  check(summary?.imageCount===count,`${label}: wrong image count`);
  check(summary?.images?.length===count,`${label}: wrong digest count`);
  for(let index=0;index<count;index++) {
    const image=summary?.images?.[index],ref=fixtures[index]?.ref;
    check(!!ref&&image?.sha256===ref.sha256&&image?.bytes===ref.size,`${label}: digest/byte mismatch at image ${index}`);
    if(mode)check(image?.source===(mode==='D'?'url':'base64'),`${label}: wrong image transport at image ${index}`);
    if(realistic) {
      check(image?.mimeType==='image/jpeg',`${label}: decoded image ${index} is not JPEG`);
      if(mode==='D'||api!=='anthropic-messages')check(image?.declaredMimeType==='image/jpeg',`${label}: declared MIME for image ${index} is not JPEG`);
    }
  }
  if(mode==='B'||mode==='C') {
    check(summary?.contentLengthMatches===true,`${label}: fixed Content-Length did not match bytes read`);
    check(summary?.transferEncoding===null,`${label}: transfer used chunked encoding`);
  }
}

const cases=report.cases??[];
const singleKeys=new Set(cases.map(row=>`${row.mode}/${row.count}/${row.api}`));
check(singleKeys.size===cases.length,'Duplicate single-case identifiers');
if(realistic)check(cases.length===modes.length*((report.smoke?1:3)+2)&&cases.every(row=>modes.includes(row.mode)),
  'Realistic profile must contain only the complete B/D single-case matrix');
for(const mode of modes) {
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
    cpuLimit(row.seed,`${label}/seed`);
    matches(row.request,row.count,label,row.mode,row.api);
    cpuLimit(row.status,`${label}/status`);
    const constructor=row.seed?.data?.constructorId;
    check(!!constructor&&constructor===row.request?.data?.constructorId,`${label}: constructor changed during successful request`);
  }
}

const faults=report.faults??[];
check(faults.length===transportModes.length*3,`Expected retry, abort, and missing-object checks for ${transportModes.join('/')}`);
for(const mode of transportModes)for(const fault of ['retry','abort','missing']) {
  const rows=faults.filter(row=>row.mode===mode&&row.fault===fault);
  check(rows.length===1,`Expected exactly one ${mode}/${fault} fault case`);
  const row=rows[0];if(!row)continue;
  const label=`${mode}/${fault}`,count=report.smoke?1:20;
  check(ok(row.seed),`${label}: seed failed`);
  cpuLimit(row.seed,`${label}/seed`);
  cpuLimit(row.status,`${label}/status`);
  if(fault==='retry') {
    matches(row.request,count,label,mode);
    check(row.request?.data?.calls>=2,`${label}: injected disconnect did not produce a fresh adapter call`);
  } else if(fault==='abort') {
    cpuLimit(row.request,label);
    check(row.request?.data?.stopReason==='aborted',`${label}: request did not report aborted`);
  } else {
    cpuLimit(row.request,label);
    check(row.request?.data?.stopReason==='error',`${label}: request did not reject missing object`);
    const reason=[row.request?.data?.error,row.request?.data?.transportError].filter(Boolean).join(' ');
    check(/missing image|image transport failed|\b404\b/i.test(reason),`${label}: error did not identify missing image or failed image transport`);
  }
  if(fault!=='missing')matches(row.recovery,count,`${label}/recovery`,mode);
}

const replay=report.replay??[];
check(replay.length===transportModes.length,realistic?'Expected two eviction/replay/probe cases':'Expected three eviction/replay/probe cases');
for(const mode of transportModes) {
  const rows=replay.filter(row=>row.mode===mode);
  check(rows.length===1,`Expected exactly one ${mode} replay`);
  const row=rows[0];if(!row)continue;
  const label=`${mode}/replay`,count=report.smoke?1:20;
  check(ok(row.seed)&&ok(row.before)&&ok(row.after),`${label}: seed/status failed`);
  cpuLimit(row.seed,`${label}/seed`);
  cpuLimit(row.before,`${label}/before`);
  cpuLimit(row.after,`${label}/after`);
  check(row.evict?.data?.evicted===true,`${label}: eviction was not acknowledged`);
  check(!!row.before?.data?.constructorId&&row.before.data.constructorId!==row.after?.data?.constructorId,`${label}: constructor did not change after forced eviction`);
  check(!!row.before?.data?.objectId&&row.before.data.objectId===row.after?.data?.objectId,`${label}: replay targeted a different object`);
  matches(row.request,count,label,mode,'anthropic-messages');
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
  check(concurrency.length===modes.length*3,realistic?'Expected six 50-agent groups':'Expected twelve 50-agent groups');
  for(const mode of modes)for(const count of [1,20,100]) {
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
      cpuLimit(row.seed,`${mode}/${count}/${row.id}/seed`);
      matches(row.request,count,`${mode}/${count}/${row.id}`,mode);
    }
  }
}

if(realistic) {
  const operation=report.workersAiVision,data=operation?.data;
  check(ok(operation),'Workers AI real-model check failed');
  check(data?.match===true,'Workers AI real-model recognition did not match');
  check(data?.checks?.leftRedSquare===true&&data?.checks?.rightBlueCircle===true,'Workers AI did not recognize both expected shapes/colors');
  check(data?.location==='ImageAgent Durable Object','Workers AI check did not run inside ImageAgent');
  cpuLimit(operation,'Workers AI vision');
  check(data?.calls===1&&Number.isFinite(data?.aiElapsedMs)&&data.aiElapsedMs>=0,'Workers AI invocation count/timing is missing');
  check(typeof data?.model==='string'&&data.model.startsWith('@cf/'),'Workers AI model identifier is missing');
  check(typeof data?.modelResult?.response==='string'&&data.modelResult.response.trim().length>0,'Workers AI model response is missing');
  check(data?.transport?.piAdapter==='openai-completions'&&
    data?.transport?.request==='B streamingFetch -> FixedLengthStream -> bounded Workers AI bridge'&&
    data?.transport?.aiInput==='one buffered image as number[]'&&
    data?.transport?.aiReceivesHttpStream===false&&
    data?.transport?.journalUsed===false&&
    Array.isArray(data?.transport?.path)&&data.transport.path.includes('AI.run image:number[]'),
    'Workers AI check did not record the actual bounded AI binding path');
  check(data?.received?.hashMatches===true&&data?.received?.sha256===data?.fixture?.sha256&&
    data?.received?.imageBytes===data?.fixture?.bytes&&data?.received?.imageCount===1,
    'Workers AI bridge did not verify the exact fixture bytes');
  check(data?.received?.contentLength===data?.received?.consumedBytes&&
    Number.isSafeInteger(data?.received?.contentLength)&&data.received.contentLength>0&&
    data?.received?.transferEncoding===null,'Workers AI bridge request length/framing is invalid');
}

check(!!report.cleanup?.at,'Cleanup did not complete');
check(Array.isArray(report.cleanup?.errors)&&report.cleanup.errors.length===0,'Cleanup reported errors');
for(const key of ['namespacesRemaining','workersRemaining','bucketsRemaining'])check(Array.isArray(report.cleanup?.[key])&&report.cleanup[key].length===0,`Cleanup ${key} is not confirmed empty`);
const expectedEndpoints=realistic?report.resources?.length:3;
check(Number.isSafeInteger(expectedEndpoints)&&expectedEndpoints>0&&
  report.cleanup?.endpointStatuses?.length===expectedEndpoints&&report.cleanup.endpointStatuses.every(row=>row.status===404),
  realistic?'Not all deleted Worker endpoints returned 404':'Not all three deleted Worker endpoints returned 404');
const polls=report.telemetry??[];
if(!polls.some(poll=>poll.rows?.length))notes.push('DO telemetry is missing: memory, CPU and error counters remain unverified');
if(polls.some(poll=>poll.errors?.length||poll.error))notes.push('Some DO telemetry queries failed; preserve their errors and state coverage limits');
if(report.workersAiVision?.data?.error||report.workersAiVision?.error)notes.push('Optional Workers AI real-model check failed; this is not a fake-provider correctness failure');
const result={source:resolve(file),smoke:!!report.smoke,checks,passed:checks-failures.length,failed:failures.length,failures,notes};
console.log(JSON.stringify(result,null,2));
if(failures.length)process.exitCode=1;

// Repeat sandbox failures through the full deployed PiHarness agent path.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {BenchmarkClient} from './agent-runner.mjs';
const baseline=JSON.parse(await readFile(new URL('./.state/agent-measure.json',import.meta.url)));
const token=(await readFile(new URL('./.state/api-token',import.meta.url),'utf8')).trim();
const client=new BenchmarkClient(baseline.baseUrl,token);
const before=await client.json('/bench/meta');
const agent=await client.create('deterministic','safety',{codeMode:true,fileTools:true});
const original=await client.diagnostics(agent);
const results=[];
for(const [name,code] of [
  ['loop','while (true) {}'],
  ['memory','const a=[]; while(true) a.push("x".repeat(1024*1024));'],
  ['pending','await new Promise(()=>{});'],
  ['throw','throw new Error("intentional benchmark error");'],
  ['tool','await tools.read({path:"/workspace/missing-benchmark-file"});'],
]) {
  const turn=client.turn(agent,`safety-${name}`,`code:${code}`);
  await delay(30);
  const start=performance.now();
  await client.json(`/bench/deterministic/clients/${agent.id}/state`);
  const probeMs=performance.now()-start;
  const completed=await turn;
  const toolResults=JSON.parse(completed.reply);
  assert.equal(toolResults.at(-1).isError,true);
  const recovery=await client.turn(agent,`recover-${name}`,`after ${name}`);
  assert.equal(recovery.reply,`Echo: after ${name}`);
  const diagnostics=await client.diagnostics(agent);
  assert.equal(diagnostics.instanceId,original.instanceId);
  results.push({name,totalMs:completed.totalMs,probeMs,toolResults,
    instancePreserved:true,recovered:true,recoveryMs:recovery.totalMs});
}
const after=await client.json('/bench/meta');
assert.equal(after.budget.reservedDispatches,before.budget.reservedDispatches);
const report={at:new Date().toISOString(),agent,instance:original.instanceId,results,realCalls:0};
await writeFile(new URL('./.state/agent-safety.json',import.meta.url),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({at:report.at,results:results.map(({toolResults,...rest})=>rest)}));

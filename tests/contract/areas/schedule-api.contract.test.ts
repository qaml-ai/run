import { contractTest, OPERATOR, OTHER_OPERATOR, free, lastUser, toolCall, toolResults, until, sleep, listen, watchEvents, type T } from '../support.ts';
import type { ContractFixture, ModelReply } from '../fixture.ts';

async function useFixture(f: ContractFixture, respond?: ModelReply, _env?: Record<string,string>, _tenants?: object) { if(respond) f.setModel(respond); return f; }

import assert from "node:assert/strict";

import { createHash } from "node:crypto";

contractTest("schedules", "tests/schedule-api.test.ts:7", "calendar schedules and owner-configured email round trip through the API without crossing accounts", async (t, f) => {
 const r=await useFixture(f,()=>({role:"assistant",content:"done"}),{AGENT_ACCOUNT_EMAIL_FROM:"reports@example.com"});
 const a=(await r.call("/v1/agents",{body:{}})).json.id;
 const path=`/v1/agents/${a}/schedules`;
 const c=await r.call(path,{body:{text:"Write a report",calendar:{time:"08:00",timeZone:"America/Chicago",daysOfWeek:[1,2,3,4,5]},email:{to:"reader@example.com",subject:"Research",format:"html"}}});
 assert.equal(c.status,201,JSON.stringify(c.json));assert.equal(c.json.calendar.time,"08:00");assert.equal(c.json.email.to,"reader@example.com");assert.equal(c.json.email.format,"html");
 assert.equal((await r.call(path,{body:{text:"Report",inSeconds:60,email:{to:"reader@example.com",subject:"Report",format:"pdf"}}})).status,400);
 assert.equal((await r.call(path)).json.length,1);
 assert.notEqual((await r.call(`/v1/agents/${a}/schedule-deliveries`,{token:OTHER_OPERATOR})).status,200);
 assert.equal((await r.call(`/v1/agents/${a}/schedule-deliveries`)).status,200);
 assert.equal((await r.call(`${path}/${c.json.id}`,{method:"DELETE"})).status,200);
 assert.equal((await r.call(path)).json.length,0);

}, {env:{AGENT_ACCOUNT_EMAIL_FROM:"reports@example.com"}});

contractTest("schedules", "tests/schedule-api.test.ts:21", "public accounts can email their verified address and cannot email strangers or suppressed recipients", async (t, f)=>{
 const r=await useFixture(f,()=>({role:"assistant",content:"done"}),{AGENT_ACCOUNT_EMAIL_FROM:"reports@example.com",AGENT_VERIFY_KEYS:"false"});
 const {id:tenant,token}=await r.seedTenant("reader",{operator:false,credits:5_000_000});
 const a=(await r.call("/v1/agents",{token,body:{}})).json.id;
 assert.ok(a);
 const path=`/v1/agents/${a}/schedules`,body={text:"Report",inSeconds:3600,email:{to:"reader@example.com",subject:"Report"}};
 assert.equal((await r.call(path,{token,body})).status,403);
 await r.seedTenant(tenant,{operator:false,token,email:"reader@example.com"});
 assert.equal((await r.call(path,{token,body})).status,201);
 assert.equal((await r.call(path,{token,body:{...body,email:{...body.email,to:"stranger@example.com"}}})).status,403);
 await r.seedTenant(tenant,{operator:false,token,email:"reader@example.com",suppressed:true});
 assert.equal((await r.call(path,{token,body})).status,403);

}, {env:{AGENT_ACCOUNT_EMAIL_FROM:"reports@example.com",AGENT_VERIFY_KEYS:"false"}});

contractTest("schedules", "tests/schedule-api.test.ts:37", "a calendar wake-up tells the model its fixed local edition date", async (t, f)=>{
 const r=await useFixture(f,()=>({role:"assistant",content:"Report saved"}));
 const a=(await r.call("/v1/agents",{body:{}})).json.id;
 const schedule=(await r.call(`/v1/agents/${a}/schedules`,{body:{text:"Write a report",calendar:{time:"22:30",timeZone:"America/Chicago"}}})).json;
 const dueAt=Date.parse("2000-01-02T04:30:00Z");
 await r.setScheduleDueAt(a,schedule.id,dueAt);
 await until(()=>r.model.bodies.some(body=>lastUser(body).includes("local edition date is 2000-01-01 in America/Chicago")),"the dated calendar prompt");
 assert.ok(r.model.bodies.some(body=>lastUser(body).includes("2000-01-02T04:30:00.000Z")));

}, {env:{AGENT_ACCOUNT_EMAIL_FROM:"reports@example.com",AGENT_VERIFY_KEYS:"false"}});
contractTest("schedules", "tests/schedule-api.test.ts:55", "cron run-now preserves timing and fresh runs isolate history", async (t,f)=>{
 const r=await useFixture(f,()=>({role:"assistant",content:"done"}));
 const definition=(await r.call('/v1/definitions',{body:{name:'Scheduled worker',systemPrompt:'Reply briefly.'}})).json.id;
 const agent=(await r.call('/v1/agents',{body:{definition}})).json.id;
 const path=`/v1/agents/${agent}/schedules`;
 await r.call(`/v1/agents/${agent}/prompt`,{body:{text:'PARENT_HISTORY_MARKER',allowDisconnected:true}});
 await until(()=>r.model.bodies.length>0,'parent history');
 const created=await r.call(path,{body:{text:'Run now',cron:{expression:'0 9 * * 1-5',timeZone:'America/Chicago'},sessionMode:'fresh',spendLimit:{usd:1}}});
 assert.equal(created.status,201,JSON.stringify(created.json));
 const schedule=created.json;
 const first=await r.call(`${path}/${schedule.id}/run`,{body:{}});
 assert.equal(first.status,202,JSON.stringify(first.json));
 assert.notEqual(first.json.agent,agent);
 const second=await r.call(`${path}/${schedule.id}/run`,{body:{}});
 assert.equal(second.status,202,JSON.stringify(second.json));
 assert.notEqual(first.json.agent,second.json.agent);
 await until(()=>r.model.bodies.length>=3,'fresh model calls');
 assert.ok(r.model.bodies.slice(1).every(body=>!JSON.stringify(body).includes('PARENT_HISTORY_MARKER')));
 assert.equal((await r.call(path)).json[0].dueAt,schedule.dueAt);
 await until(async()=>{
  const deliveries=(await r.call(`/v1/agents/${agent}/schedule-deliveries`)).json;
  return deliveries.length===2 && deliveries.every((d:any)=>d.state==='completed');
 },'scheduled runs complete');
 assert.notEqual((await r.call(`${path}/${schedule.id}/run`,{body:{},token:OTHER_OPERATOR})).status,202);
 assert.equal((await r.call(`${path}/invalid/run`,{body:{}})).status,404);
 assert.equal((await r.call(path,{body:{text:'x',cron:{expression:'* * * * * *',timeZone:'UTC'}}})).status,400);
});

contractTest("schedules", "tests/schedule-api.test.ts", "run-now rejects a different tenant without firing and validates unsafe schedules", async (t,f)=>{
 const r=await useFixture(f,()=>({role:'assistant',content:'done'}));
 const agent=(await r.call('/v1/agents',{body:{}})).json.id, path=`/v1/agents/${agent}/schedules`;
 const schedule=(await r.call(path,{body:{text:'Private task',inSeconds:3600}})).json;
 const response=await r.call(`${path}/${schedule.id}/run`,{token:OTHER_OPERATOR,body:{}});
 assert.ok([403,404].includes(response.status),JSON.stringify(response));
 assert.deepEqual((await r.call(`/v1/agents/${agent}/schedule-deliveries`)).json,[]);
 assert.equal(r.model.bodies.length,0);
 assert.equal((await r.call(path,{body:{code:'1',inSeconds:3600,spendLimit:{usd:1}}})).status,400);
 for(const timing of [{everySeconds:60,inSeconds:3600},{cron:{expression:'* * * * *',timeZone:'UTC'}}])
  assert.equal((await r.call(path,{body:{text:'x',sessionMode:'fresh',...timing}})).status,400);
});

contractTest("schedules", "tests/schedule-api.test.ts", "code schedules retain their terminal outcome",async(t,f)=>{
 const r=await useFixture(f,()=>({role:'assistant',content:'done'}));
 const agent=(await r.call('/v1/agents',{body:{}})).json.id,path=`/v1/agents/${agent}/schedules`;
 const made=await r.call(path,{body:{code:'console.log(42)',inSeconds:3600}});
 assert.equal(made.status,201,JSON.stringify(made.json));
 const run=await r.call(`${path}/${made.json.id}/run`,{body:{}});
 assert.equal(run.status,202,JSON.stringify(run.json));
 await until(async()=>{
  const rows=(await r.call(`/v1/agents/${agent}/schedule-deliveries`)).json;
  return rows.some((row:any)=>row.runId===run.json.requestId && row.endedAt && row.state==='completed');
 },'code outcome recorded');
});

contractTest("schedules", "tests/schedule-api.test.ts", "batched and cancelled schedules retain their outcomes",async(t,f)=>{
 const r=await useFixture(f,()=>({role:'assistant',content:'done'}));
 const agent=(await r.call('/v1/agents',{body:{queue:{mode:'batch',windowMs:2000}}})).json.id,path=`/v1/agents/${agent}/schedules`;
 const schedule=(await r.call(path,{body:{text:'Report',inSeconds:3600}})).json;
 const first=(await r.call(`${path}/${schedule.id}/run`,{body:{}})).json;
 const second=(await r.call(`${path}/${schedule.id}/run`,{body:{}})).json;
 await until(async()=>{
  const rows=(await r.call(`/v1/agents/${agent}/schedule-deliveries`)).json;
  return rows.length===2 && rows.every((row:any)=>row.state==='completed');
 },'batched schedule outcomes');
 assert.equal((await r.call(`/v1/agents/${agent}/requests/${second.requestId}`)).json.batchedInto,first.requestId);
 const cancelled=(await r.call(`${path}/${schedule.id}/run`,{body:{}})).json;
 await r.call(`/v1/agents/${agent}/abort`,{body:{queued:'cancel'}});
 await until(async()=>{
  const rows=(await r.call(`/v1/agents/${agent}/schedule-deliveries`)).json;
  return rows.some((row:any)=>row.runId===cancelled.requestId && row.state==='failed' && row.endedAt);
 },'cancelled schedule outcome');
});

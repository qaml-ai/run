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

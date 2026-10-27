import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { runtime, OTHER_OPERATOR, until, lastUser } from "./runtime-server.ts";
test("calendar schedules and owner-configured email round trip through the API without crossing accounts",async t=>{
 const r=await runtime(t,()=>({role:"assistant",content:"done"}),{AGENT_ACCOUNT_EMAIL_FROM:"reports@example.com"});
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
});

test("public accounts can email their verified address and cannot email strangers or suppressed recipients",async t=>{
 const r=await runtime(t,()=>({role:"assistant",content:"done"}),{AGENT_ACCOUNT_EMAIL_FROM:"reports@example.com",AGENT_VERIFY_KEYS:"false"});
 const accounts=new Accounts({db:r.db,tenants:new Tenants({read:async()=>JSON.stringify({tenants:{}})}),pricing:{startingGrant:5_000_000} as never});
 const tenant=await accounts.tenantForGithub({login:"reader",id:42424,createdAt:Date.now()-365*86400000},{minAccountAgeMs:0});
 const {token}=await accounts.createToken(tenant,"test");
 const a=(await r.call("/v1/agents",{token,body:{}})).json.id;
 assert.ok(a);
 const path=`/v1/agents/${a}/schedules`,body={text:"Report",inSeconds:3600,email:{to:"reader@example.com",subject:"Report"}};
 assert.equal((await r.call(path,{token,body})).status,403);
 await r.db.query("insert into tenant_passwords(tenant,email,hash,set_at) values($1,$2,'fixture',0)",[tenant,"reader@example.com"]);
 assert.equal((await r.call(path,{token,body})).status,201);
 assert.equal((await r.call(path,{token,body:{...body,email:{...body.email,to:"stranger@example.com"}}})).status,403);
 await r.db.query("insert into billing_email_suppressions(email_hash,created_at) values($1,0)",[createHash("sha256").update("reader@example.com").digest("hex")]);
 assert.equal((await r.call(path,{token,body})).status,403);
});

test("a calendar wake-up tells the model its fixed local edition date",async t=>{
 const r=await runtime(t,()=>({role:"assistant",content:"Report saved"}));
 const a=(await r.call("/v1/agents",{body:{}})).json.id;
 const schedule=(await r.call(`/v1/agents/${a}/schedules`,{body:{text:"Write a report",calendar:{time:"22:30",timeZone:"America/Chicago"}}})).json;
 const dueAt=Date.parse("2000-01-02T04:30:00Z");
 await r.db.query("update schedules set due_at=$2 where id=$1",[schedule.id,dueAt]);
 await until(()=>r.model.bodies.some(body=>lastUser(body).includes("local edition date is 2000-01-01 in America/Chicago")),"the dated calendar prompt");
 assert.ok(r.model.bodies.some(body=>lastUser(body).includes("2000-01-02T04:30:00.000Z")));
});

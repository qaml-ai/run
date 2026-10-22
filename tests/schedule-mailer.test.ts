import { test } from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database.ts";
import { Scheduler, scheduleInput } from "../src/scheduler.ts";
import { ScheduleMailer } from "../src/schedule-mailer.ts";

test("calendar and email schedules persist; accepted requests are mailed once across workers and survive restart", async () => {
 const {db}=await testDatabase(); let state="running",sent=0;
 const scheduler=new Scheduler({db,node:"a",emailEnabled:true,deliver:async()=>{}});
 const create=await scheduler.create({agent:"client_mail",tenant:"alice",text:"Write a report",calendar:{time:"08:00",timeZone:"America/Chicago"},email:{to:"reader@example.com",subject:"Report"},dueAt:Date.now()-10});
 await scheduler.scan();
 const persisted=(await scheduler.list("client_mail"))[0];assert.deepEqual(persisted.calendar,create.calendar);assert.ok(persisted.dueAt>Date.now());
 const options={db,request:async()=>({state,outcome:{result:{reply:"# News\nA <script> is not HTML."}}}) as any,send:async(mail:any)=>{sent++;assert.equal(mail.to,"reader@example.com");assert.match(mail.html,/&lt;script&gt;/);return {messageId:"ses-id"};}};
 await new ScheduleMailer(options).pump();assert.equal(sent,0);
 state="completed";await db.query("update schedule_deliveries set next_at=0");
 await Promise.all([new ScheduleMailer(options).pump(),new ScheduleMailer(options).pump()]);assert.equal(sent,1);
 const row=(await db.query("select * from schedule_deliveries")).rows[0];assert.equal(row.state,"sent");assert.equal(row.message_id,"ses-id");
 await new ScheduleMailer(options).pump();assert.equal(sent,1);
});
test("failed reports are never emailed; transient sends retry from durable state",async()=>{
 const {db}=await testDatabase();let sent=0, fail=true;
 const scheduler=new Scheduler({db,node:"a",emailEnabled:true,deliver:async()=>{}});
 for(const agent of ["failed","retry"])await scheduler.create({agent,tenant:"alice",text:"Report",dueAt:Date.now()-1,email:{to:"r@example.com",subject:agent}});
 await scheduler.scan();
 const mailer=new ScheduleMailer({db,request:async(agent)=>({state:"completed",outcome:{result:agent==="failed"?{error:"No report"}:{reply:"Report"}}}) as any,send:async()=>{if(fail)throw Error("unavailable");sent++;return {messageId:"sent"};}});
 await mailer.pump();assert.equal(sent,0);assert.equal((await db.query("select state from schedule_deliveries where agent='failed'")).rows[0].state,"failed");
 fail=false;await db.query("update schedule_deliveries set next_at=0");await mailer.pump();assert.equal(sent,1);
});
test("calendar cannot be mixed with interval or absolute timing; email requires enabled delivery and text",async()=>{
 const {db}=await testDatabase();const s=new Scheduler({db,node:"a",deliver:async()=>{}});
 assert.throws(()=>scheduleInput({text:"x",calendar:{time:"08:00",timeZone:"UTC"},everySeconds:60}));
 assert.throws(()=>scheduleInput({text:"x",inSeconds:1,email:{to:"bad",subject:"x"}}));
 await assert.rejects(s.create({agent:"a",tenant:"t",text:"x",dueAt:Date.now(),email:{to:"r@example.com",subject:"x"}}),/not enabled/);
});
test("email requires an eligible recipient at creation and again before delivery", async () => {
 const {db}=await testDatabase(); let allowed=false, sent=0;
 const canEmail=async()=>allowed;
 const scheduler=new Scheduler({db,node:"a",emailEnabled:true,canEmail,deliver:async()=>{}});
 const input={agent:"a",tenant:"alice",text:"Report",dueAt:Date.now()-1,email:{to:"r@example.com",subject:"Report"}};
 await assert.rejects(scheduler.create(input),/verified/);
 allowed=true;await scheduler.create(input);await scheduler.scan();allowed=false;
 const mailer=new ScheduleMailer({db,canEmail,request:async()=>({state:"completed",outcome:{result:{reply:"Report"}}}) as any,send:async()=>{sent++;return {messageId:"x"};}});
 await mailer.pump();assert.equal(sent,0);
 assert.equal((await db.query("select state from schedule_deliveries")).rows[0].state,"failed");
});


test("email formats preserve custom HTML and send plain text without adding markup", async () => {
 const {db}=await testDatabase();
 const scheduler=new Scheduler({db,node:"formats",emailEnabled:true,deliver:async()=>{}});
 const html='<!doctype html><html><head><style>h1{color:red}</style></head><body style="background:#ece8df"><h1>Desk &amp; news</h1><p>Full report</p></body></html>';
 for (const format of ["html", "text"] as const) await scheduler.create({agent:format,tenant:"alice",text:"Report",dueAt:Date.now()-1,email:{to:"r@example.com",subject:"Report",format}});
 await scheduler.scan();
 const mails:any[]=[];
 await new ScheduleMailer({db,request:async(agent)=>({state:"completed",outcome:{result:{reply:agent==="html"?html:"# Plain <text>"}}}) as any,send:async(mail)=>{mails.push(mail);return {messageId:"sent"};}}).pump();
 assert.equal(mails.length,2);
 const custom=mails.find(m=>m.html!==undefined),plain=mails.find(m=>m.html===undefined);
 assert.equal(custom.html,html);assert.equal(custom.text,"Desk & news\n\nFull report");
 assert.equal(plain.text,"# Plain <text>");assert.ok(!Object.hasOwn(plain,"html"));
 assert.throws(()=>scheduleInput({text:"x",inSeconds:1,email:{to:"r@example.com",subject:"x",format:"pdf"}}),/format/);
});

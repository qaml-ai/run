import test from 'node:test';
import assert from 'node:assert/strict';
import {startFixture} from './fixture.ts';

test('calendar/email rules persist and suppressed or unverified recipients are denied', {timeout:60000}, async t=>{
 const f=await startFixture({vars:{SCHEDULE_EMAIL_FROM:'reports@example.test'}});t.after(()=>f.stop());
 const call=async(path:string,body?:unknown,method=body?'POST':'GET')=>{const r=await fetch(f.url+path,{method,headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 const agent=(await call('/v1/agents',{codeMode:false,fileTools:false})).body.id,path=`/v1/agents/${agent}/schedules`;
 const request={text:'Synthetic report',calendar:{time:'08:00',timeZone:'America/Chicago',daysOfWeek:[1,2,3,4,5]},email:{to:'reader@example.test',subject:'Report',format:'html'}};
 assert.equal((await call(path,request)).status,403);
 await f.db.query("insert into billing_recipients(id,tenant,email,status,created_at,confirmation_hash,confirmation_expires) values($1,$2,$3,'verified',$4,'fixture',0)",[crypto.randomUUID(), 'camelrun-proto-local','reader@example.test',Date.now()]);
 const made=await call(path,request);assert.equal(made.status,201,JSON.stringify(made.body));assert.deepEqual(made.body.calendar,request.calendar);assert.deepEqual(made.body.email,request.email);
 assert.equal((await call(path,{...request,everySeconds:60})).status,400);assert.equal((await call(path,{text:'x',inSeconds:1,everySeconds:1})).status,400);
 assert.equal((await call(path,{text:'x',inSeconds:10,email:{...request.email,format:'pdf'}})).status,400);
 assert.equal((await call(path)).body.length,1);
 assert.equal((await call(`/v1/agents/${agent}/schedule-deliveries`)).status,200);
 await call(path+'/'+made.body.id,undefined,'DELETE');assert.equal((await call(path)).body.length,0);
});

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

test('continue schedules fire before the outcome migration; summaries recover after it', {timeout:90000}, async t=>{
 const f=await startFixture();t.after(()=>f.stop());
 const call=async(path:string,body?:unknown)=>{const r=await fetch(f.url+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
 const agent=(await call('/v1/agents',{codeMode:false,fileTools:false})).body.id,path=`/v1/agents/${agent}/schedules`;
 const manual=(await call(path,{text:'Manual report',inSeconds:3600})).body;
 const automatic=(await call(path,{text:'Automatic report',inSeconds:1})).body;
 await f.db.query('alter table schedule_runs rename to schedule_runs_pending_migration');
 try {
  const result=await call(`${path}/${manual.id}/run`,{});
  assert.equal(result.status,202,JSON.stringify(result.body));
  const deadline=Date.now()+20000;
  while((await call(path)).body.some((s:any)=>s.id===automatic.id)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(!(await call(path)).body.some((s:any)=>s.id===automatic.id),'automatic occurrence submitted without outcome table');
  assert.equal((await call(`${path}/${manual.id}/run`,{})).status,202);
 } finally {await f.db.query('alter table schedule_runs_pending_migration rename to schedule_runs');}
});

test('fresh capacity failures are stored as delivery outcomes', {timeout:60000},async t=>{
 const f=await startFixture();t.after(()=>f.stop());
 const call=async(path:string,body?:unknown)=>{const r=await fetch(f.url+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
 const definition=(await call('/v1/definitions',{name:'Capacity test',systemPrompt:'Reply briefly.'})).body.id;
 const agent=(await call('/v1/agents',{definition})).body.id,path=`/v1/agents/${agent}/schedules`;
 const schedule=(await call(path,{text:'Report',inSeconds:3600,sessionMode:'fresh'})).body;
 await f.db.query("insert into schedule_runs(id,tenant,agent,schedule,created_at,expires_at) select 'capacity-'||i,'camelrun-proto-local',$1,$2,$3,$4 from generate_series(1,200) i",[agent,schedule.id,Date.now(),Date.now()+60000]);
 const result=await call(`${path}/${schedule.id}/run`,{});
 assert.equal(result.status,429,JSON.stringify(result.body));
 const deadline=Date.now()+10000;let failed:any;
 do {failed=(await call(`/v1/agents/${agent}/schedule-deliveries`)).body.find((d:any)=>d.state==='failed');if(failed)break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);
 assert.match(failed?.error??'',/200 live run agents/);
 await f.db.query("insert into schedule_runs(id,tenant,agent,schedule,created_at) select 'expired-'||i,'camelrun-proto-local',$1,$2,$3 from generate_series(1,501) i",[agent,schedule.id,Date.now()-31*86400000]);
 await f.worker.scheduled();
 assert.equal((await f.db.query("select count(*)::int n from schedule_runs where id like 'expired-%'")).rows[0].n,1);
 await f.worker.scheduled();
 assert.equal((await f.db.query("select count(*)::int n from schedule_runs where id like 'expired-%'")).rows[0].n,0);
});

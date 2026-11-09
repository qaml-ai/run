import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase} from './database.ts';
import {transaction} from '../src/db.ts';
import {Triggers, type TriggerHost} from '../src/triggers.ts';
import {HookAdmission,handleHook} from '../src/core/trigger-ingress.ts';
import {freshAutomationRun} from '../src/core/fresh-runs.ts';

async function fixture(options:Partial<TriggerHost>={}) {
 const {db}=await testDatabase();let now=Date.now();
 await db.query("insert into agents(id,tenant,header,revision,name,type,model) values('client_hook','alice','{}',1,'hook','test','test')");
 const host:TriggerHost={db,transaction:work=>transaction(db,work),keys:{seal:(_c,t)=>({text:t}),unseal:(_c,t)=>t.text},now:()=>now,
  fresh:{precheck:async()=>{},definition:async()=> 'd',upsert:async()=> 'client_hook'},upload:async()=>({path:'untrusted-webhook-payload.json'}),submit:async()=>({}),...options};
 const service=new Triggers(host);
 const made=await service.create('alice','client_hook',{name:'Hook',prompt:'Inspect',budget:{usd:1},deliveryIdHeader:'x-id'},'https://hooks.test');
 const receive=(id='one')=>service.receive(made.url.split('/').at(-1)!,new Request(made.url,{method:'POST',headers:{'x-id':id},body:'{}'}));
 return {db,service,host,made,receive,advance:(ms:number)=>{now+=ms;}};
}

test('limited and failed deliveries do not swallow sender retries',async()=>{
 const f=await fixture({submit:async()=>{throw Object.assign(new Error('permanent'),{status:400});}});
 await f.db.query("update agent_triggers set config=jsonb_set(config,'{rateLimit}','1') where id=$1",[f.made.id]);
 assert.equal((await f.receive('first')).code,202);
 assert.equal((await f.receive('later')).code,429);
 f.advance(61000);
 assert.equal((await f.receive('later')).body.status,'queued');
 await f.service.scan();
 assert.equal((await f.receive('later')).body.status,'queued');
});

test('transient submissions retry five times with bounded backoff, retain data, then release failed payloads',async()=>{
 const ids:string[]=[];
 const f=await fixture({submit:async(_a,_t,r)=>{ids.push(r.id);throw Object.assign(new Error('transport secret'),{status:503});}});
 await f.receive();
 for(let attempt=1;attempt<=5;attempt++) {
  await f.service.scan();
  const row=(await f.db.query('select * from trigger_deliveries')).rows[0];
  assert.equal(row.attempts,attempt);assert.equal(row.status,attempt===5?'failed':'queued');
  assert.equal(row.data===null,attempt===5);assert.equal(row.error,'Trigger submission failed');
  await f.service.scan();assert.equal(ids.length,attempt,'not retried before its due time');
  f.advance([30000,60000,120000,300000,0][attempt-1]);
 }
 assert.equal(new Set(ids).size,1,'every retry keeps its request id');
});

test('a transient submit can recover, and permanent failures never retry internally',async()=>{
 let calls=0,policy:unknown;
 const f=await fixture({prepareRun:async(_a,_t,p)=>{policy=p;},submit:async()=>{if(++calls===1)throw new Error('lost response');}});
 await f.receive();await f.service.scan();f.advance(30000);await f.service.scan();
 const row=(await f.db.query('select * from trigger_deliveries')).rows[0];
 assert.equal(row.status,'submitted');assert.equal(row.data,null);assert.equal(row.attempts,2);
 assert.deepEqual(policy,{humanInput:{unattended:'decline'}});
 assert.equal((await f.receive()).body.status,'duplicate');
});

test('dispatch is parallel, bounded to four and protected against concurrent claims',async()=>{
 let active=0,peak=0,release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const f=await fixture({submit:async()=>{peak=Math.max(peak,++active);await gate;active--;}});
 for(let i=0;i<9;i++)await f.receive(String(i));
 const running=f.service.scan();
 for(let i=0;i<200&&active<4;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(active,4);assert.equal(peak,4);
 const other=new Triggers(f.host);const second=other.scan();
 // Another process may claim the next batch, but never the same four deliveries.
 release();await Promise.all([running,second]);
 assert.equal(Number((await f.db.query("select count(*) as n from trigger_deliveries where status='submitted'")).rows[0].n),8);
});

test('oversized Content-Length and ingress rate limits run before any service/database work',async()=>{
 let calls=0;
 const service=async()=>{calls++;throw new Error('service must not be reached');};
 await assert.rejects(handleHook(new Request('https://hooks.test/v1/hooks/'+ 'a'.repeat(64),{method:'POST',headers:{'Content-Length':'1048577'}}),'ip',service),{status:413});
 assert.equal(calls,0);
 const rates=new HookAdmission(2,3,10);
 await rates.admit('one','a',0);await rates.admit('one','a',0);
 await assert.rejects(rates.admit('one','b',0),{status:429});
 await rates.admit('two','a',0);
 await assert.rejects(rates.admit('three','a',0),{status:429});
 await rates.admit('one','a',60000);
});

test('ingress errors redact hook tokens and URLs',async()=>{
 const token='b'.repeat(64),url='https://hooks.test/v1/hooks/'+token;
 await assert.rejects(handleHook(new Request(url,{method:'POST'}),'ip',async()=>({receive:async()=>{throw new Error(url);}})),error=>{
  assert.equal((error as Error).message,'Hook temporarily unavailable');return true;
 });
});

test('fresh-run orchestration checks tenant limits before provisioning and reuses reservations',async()=>{
 const calls:string[]=[];
 const host={reserve:async()=>null,precheck:async()=>{calls.push('precheck');},definition:async()=>{calls.push('definition');return 'd';},upsert:async()=>{calls.push('upsert');return 'a';},record:async()=>{calls.push('record');}};
 assert.equal(await freshAutomationRun(host,'key'),'a');assert.deepEqual(calls,['precheck','definition','upsert','record']);
 calls.length=0;
 assert.equal(await freshAutomationRun({...host,reserve:async()=> 'a'},'key'),'a');assert.deepEqual(calls,[]);
 await assert.rejects(freshAutomationRun({...host,precheck:async()=>{throw new Error('tenant cap');}},'key'),/tenant cap/);
 assert.deepEqual(calls,[]);
});

test('rejected requests consume both ingress budgets without reaching a saturated service',async()=>{
 let verified=0;
 const limits=new HookAdmission(2,3);
 const service=async()=>({receive:async()=>{verified++;return {code:401,body:{status:'rejected'}};}});
 const req=()=>new Request('https://hooks.test/v1/hooks/'+ 'c'.repeat(64),{method:'POST'});
 assert.equal((await handleHook(req(),'sender',service,limits)).code,401);
 assert.equal((await handleHook(req(),'sender',service,limits)).code,401);
 await assert.rejects(handleHook(req(),'sender',service,limits),{status:429});
 assert.equal(verified,2);
});

test('signature rejection updates only its counter, without a delivery transaction',async()=>{
 const f=await fixture();
 const signed=await f.service.create('alice','client_hook',{name:'Signed',prompt:'Inspect',budget:{usd:1},verify:{type:'github',secret:'0123456789abcdef'}},'https://hooks.test');
 f.host.transaction=async()=>{throw new Error('rejected request took a delivery lock');};
 const rejected=await f.service.receive(signed.url.split('/').at(-1)!,new Request(signed.url,{method:'POST',body:'{}'}));
 assert.equal(rejected.code,401);
 assert.equal(Number((await f.db.query('select count(*) as n from trigger_deliveries')).rows[0].n),0);
 assert.equal(Number((await f.db.query('select rejected_count from agent_triggers where id=$1',[signed.id])).rows[0].rejected_count),1);
});

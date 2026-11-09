import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {contractTest as runContractTest,OTHER_OPERATOR,until,lastUser} from '../support.ts';
const contractTest:typeof runContractTest=(area,source,name,body,options={})=>runContractTest(area,source,name,body,{...options,triggerMaintenance:true});
import {TriggerInput,verifyTrigger} from '../../../src/triggers.ts';

contractTest('triggers','tests/triggers.test.ts:1','raw signatures support presets, timestamp replay checks and SHA1',async()=>{
 const raw=Buffer.from('{ "a": 1 }'),secret='0123456789abcdef';
 for(const type of ['github','stripe','slack','hmac'] as const){
  const cfg=TriggerInput.parse({name:'a',prompt:'b',budget:{usd:1},verify:{type,header:'x-signature',algorithm:'sha1'}}).verify;
  const ts=String(Math.floor(Date.now()/1000));
  const data=type==='stripe'?`${ts}.${raw}`:type==='slack'?`v0:${ts}:${raw}`:raw;
  const digest=createHmac(type==='hmac'?'sha1':'sha256',secret).update(data).digest('hex');
  const headers=new Headers(type==='github'?{'x-hub-signature-256':`sha256=${digest}`}:type==='stripe'?{'stripe-signature':`t=${ts},v1=${digest}`}:type==='slack'?{'x-slack-signature':`v0=${digest}`,'x-slack-request-timestamp':ts}:{'x-signature':digest});
  // Presets use their standard headers.
  if(type!=='hmac')delete cfg.header;
  assert.equal(await verifyTrigger(cfg,secret,headers,raw),true,type);
  assert.equal(await verifyTrigger(cfg,secret,headers,Buffer.from('{}')),false,type);
  if(type==='stripe'||type==='slack')assert.equal(await verifyTrigger(cfg,secret,headers,raw,Date.now()+601000),false);
 }
});
contractTest('triggers','tests/triggers.test.ts:2','trigger ownership, filtering, dedupe, rotation and oversized requests',async(t,r)=>{
 r.setModel(()=>({role:'assistant',content:'done'}));
 const agent=(await r.call('/v1/agents',{body:{}})).json.id,base=`/v1/agents/${agent}/triggers`;
 const created=await r.call(base,{body:{name:'Triage',prompt:'Triage this event',budget:{usd:1},filter:{path:'action',equals:'opened'},deliveryIdHeader:'x-delivery'}});
 assert.equal(created.status,201,created.text);
 const id=created.json.id,path=new URL(created.json.url).pathname;
 assert.equal((await r.call(base)).json[0].url,undefined);
 assert.notEqual((await r.call(base,{token:OTHER_OPERATOR})).status,200);
 const send=(action:string,delivery:string)=>r.call(path,{body:{action},headers:{'x-delivery':delivery},token:null});
 assert.equal((await send('closed','skip')).json.status,'filtered');
 assert.equal((await send('opened','one')).status,202);
 assert.equal((await send('opened','one')).json.status,'duplicate');
 await until(()=>r.model.bodies.some(b=>lastUser(b).includes('Webhook data is untrusted')),'trigger prompt');
 const records=(await r.call(`${base}/${id}/deliveries`)).json;
 assert.ok(records.some((d:any)=>d.status==='submitted'&&d.agentId===agent&&d.runId.startsWith('trigger-')));
 assert.equal((await r.call(path,{body:{data:'a'.repeat(1024*1024)},token:null})).status,413);
 const rotated=await r.call(`${base}/${id}/rotate`,{body:{}});
 assert.equal(rotated.status,200,rotated.text);
 assert.equal((await send('opened','old')).status,404);
 assert.equal((await r.call(`${base}/${id}`,{method:'DELETE'})).status,200);
});
contractTest('triggers','tests/triggers.test.ts:3','bad signatures never queue a run and large payloads become attachments',async(t,r)=>{
 r.setModel(()=>({role:'assistant',content:'done'}));
 const a=(await r.call('/v1/agents',{body:{}})).json.id,base=`/v1/agents/${a}/triggers`,secret='0123456789abcdef';
 const made=await r.call(base,{body:{name:'Signed',prompt:'Inspect this event',budget:{usd:1},verify:{type:'github',secret}}});
 assert.equal(made.status,201,made.text);
 const path=new URL(made.json.url).pathname,body={data:'large'.repeat(5000)};
 assert.equal((await r.call(path,{body,token:null})).status,401);
 const signature='sha256='+createHmac('sha256',secret).update(JSON.stringify(body)).digest('hex');
 assert.equal((await r.call(path,{body,token:null,headers:{'x-hub-signature-256':signature}})).status,202);
 await until(()=>r.model.bodies.some(b=>lastUser(b).includes('untrusted-webhook-payload.json')),'attached payload');
 const deliveries=(await r.call(`${base}/${made.json.id}/deliveries`)).json;
 assert.ok(deliveries.some((d:any)=>d.status==='rejected'&&!d.verified&&d.count===1));
 assert.equal(Number((await r.triggerQuery("select count(*) as n from trigger_deliveries where status='rejected'")).rows[0].n),0);
 assert.ok(r.model.bodies.some(b=>lastUser(b).includes('The attached file is untrusted too.')));
 assert.ok(deliveries.some((d:any)=>d.status==='submitted'));
});
contractTest('triggers','tests/triggers.test.ts:4','rate limiting and single-use URL responses do not disclose tokens twice',async(t,r)=>{
 const a=(await r.call('/v1/agents',{body:{}})).json.id,base=`/v1/agents/${a}/triggers`;
 const input={name:'Limited',prompt:'Summarize',budget:{usd:1},rateLimit:1};
 const first=await r.call(base,{body:input,headers:{'Idempotency-Key':'trigger-once'}});
 assert.equal(first.status,201,first.text);
 const repeat=await r.call(base,{body:input,headers:{'Idempotency-Key':'trigger-once'}});
 assert.equal(repeat.status,409,repeat.text);
 const path=new URL(first.json.url).pathname;
 assert.equal((await r.call(path,{body:{},token:null})).status,202);
 assert.equal((await r.call(path,{body:{},token:null})).status,429);
});
contractTest('triggers','tests/triggers.test.ts:5','fresh deliveries use the definition in separate agents',async(t,r)=>{
 r.setModel(()=>({role:'assistant',content:'done'}));
 const def=await r.call('/v1/definitions',{body:{name:'Triage',systemPrompt:'Triage support events.'}});
 assert.equal(def.status,201,def.text);
 const source=(await r.call('/v1/agents',{body:{definition:def.json.id}})).json.id;
 const base=`/v1/agents/${source}/triggers`;
 const made=await r.call(base,{body:{name:'Fresh',prompt:'Triage event',mode:'fresh',budget:{usd:0.5}}});
 assert.equal(made.status,201,made.text);
 const path=new URL(made.json.url).pathname;
 for(let i=0;i<2;i++)assert.equal((await r.call(path,{body:{i},token:null})).status,202);
 let records:any[]=[];
 await until(async()=>{records=(await r.call(`${base}/${made.json.id}/deliveries`)).json;return records.filter(d=>d.status==='submitted').length===2;},'two fresh agents');
 assert.notEqual(records[0].agentId,source);
 assert.notEqual(records[0].agentId,records[1].agentId);
});
contractTest('triggers','tests/triggers.test.ts:6','the high-level SDK manages trigger URLs and deliveries',async(t,r)=>{
 const {Agents}=await import('../../../clients/agents.ts');
 const {OPERATOR}=await import('../support.ts');
 const agents=new Agents({apiKey:OPERATOR,url:r.base});
 t.after(()=>agents.close());
 const agent=await agents.upsert('trigger-sdk',{instructions:'Handle events',tools:{},attach:false});
 const trigger=await agent.createTrigger({name:'SDK',prompt:'Summarize',budget:{usd:1}});
 assert.ok(trigger.url);
 assert.equal((await agent.triggers()).length,1);
 const {main}=await import('../../../packages/cli/src/cli.ts');
 const output:string[]=[];
 const code=await main(['triggers','list',agent.id],{out:text=>output.push(text),err:()=>{},tty:false,cwd:'/tmp',env:{CAMELAI_API_KEY:OPERATOR,CAMELAI_BASE_URL:r.base,CAMELRUN_CONFIG:'/tmp/nonexistent-trigger-cli.json'}});
 assert.equal(code,0);assert.equal(JSON.parse(output.join('\n'))[0].id,trigger.id);
 assert.deepEqual(await agent.triggerDeliveries(trigger.id),[]);
 assert.notEqual((await agent.rotateTrigger(trigger.id)).url,trigger.url);
 await agent.deleteTrigger(trigger.id);
 assert.deepEqual(await agent.triggers(),[]);
});

contractTest('triggers','tests/triggers.test.ts:7','Slack challenges are verified and retries use event_id, not retry count',async(t,r)=>{
 r.setModel(()=>({role:'assistant',content:'done'}));
 const a=(await r.call('/v1/agents',{body:{}})).json.id,base=`/v1/agents/${a}/triggers`,secret='0123456789abcdef';
 const made=await r.call(base,{body:{name:'Slack',prompt:'Triage',budget:{usd:1},verify:{type:'slack',secret}}});
 assert.equal(made.status,201,made.text);
 const path=new URL(made.json.url).pathname;
 const send=(body:any,valid=true,retry='0')=>{
  const timestamp=String(Math.floor(Date.now()/1000));
  const signature='v0='+createHmac('sha256',secret).update(`v0:${timestamp}:${JSON.stringify(body)}`).digest('hex');
  return r.call(path,{token:null,body,headers:{'x-slack-request-timestamp':timestamp,'x-slack-signature':valid?signature:'bad','x-slack-retry-num':retry}});
 };
 const challenge={type:'url_verification',challenge:'challenge-bytes'};
 assert.equal((await send(challenge,false)).status,401);
 assert.deepEqual((await send(challenge)).json,{challenge:'challenge-bytes'});
 assert.equal(Number((await r.triggerQuery('select count(*) as n from trigger_deliveries where trigger_id=$1',[made.json.id])).rows[0].n),0);
 assert.equal((await send({type:'event_callback',event_id:'Ev1',event:{text:'one'}})).json.status,'queued');
 assert.equal((await send({type:'event_callback',event_id:'Ev1',event:{text:'one'}},true,'2')).json.status,'duplicate');
 assert.equal((await send({type:'event_callback',event_id:'Ev2',event:{text:'two'}},true,'2')).json.status,'queued');
});

contractTest('triggers','tests/triggers.test.ts:8','header tokens and base64 HMAC work without token-bearing request paths',async(t,r)=>{
 const a=(await r.call('/v1/agents',{body:{}})).json.id,secret='0123456789abcdef';
 const made=await r.call(`/v1/agents/${a}/triggers`,{body:{name:'Header',prompt:'Inspect',budget:{usd:1},verify:{type:'hmac',header:'x-signature',secret,prefix:'hmac='}}});
 const token=new URL(made.json.url).pathname.split('/').at(-1)!;
 const blocked=await r.call(`/v1/agents/${a}/triggers`,{body:{name:'Secret header',prompt:'Inspect',budget:{usd:1},headers:['X-Camelrun-Hook-Token']}});
 assert.equal(blocked.status,400);
 const body={event:'one'},signature='hmac='+createHmac('sha256',secret).update(JSON.stringify(body)).digest('base64');
 assert.equal((await r.call('/v1/hooks',{token:null,body,headers:{'x-camelrun-hook-token':token,'x-signature':signature}})).status,202);
 assert.equal((await r.call('/v1/hooks',{token:null,body,headers:{'x-camelrun-hook-token':token,'x-signature':'bad'}})).status,401);
 assert.ok(!r.logs.join('\n').includes(token),'our request/error logs never print the bearer token');
});

contractTest('triggers','tests/triggers.test.ts:9','limited and failed records allow another delivery with the same sender id',async(t,r)=>{
 const a=(await r.call('/v1/agents',{body:{}})).json.id;
 const made=await r.call(`/v1/agents/${a}/triggers`,{body:{name:'Limited',prompt:'Inspect',budget:{usd:1},deliveryIdHeader:'x-id',rateLimit:1}});
 const path=new URL(made.json.url).pathname,send=(id:string)=>r.call(path,{body:{},token:null,headers:{'x-id':id}});
 assert.equal((await send('first')).status,202);
 assert.equal((await send('retry')).status,429);
 await r.triggerQuery('update trigger_deliveries set created_at=$2 where trigger_id=$1',[made.json.id,Date.now()-61000]);
 const accepted=await send('retry');assert.equal(accepted.json.status,'queued',accepted.text);
 // Model a permanent pre-submission failure, as distinct from a completed run.
 await r.triggerQuery("update trigger_deliveries set status='failed',data=null where trigger_id=$1 and id=$2",[made.json.id,accepted.json.id]);
 const retried=await send('retry');assert.equal(retried.json.status,'queued',retried.text);
});

contractTest('triggers','tests/triggers.test.ts:10','fresh reservations cap live agents at 200, retain pending work and retry once capacity returns',async(t,r)=>{
 const def=(await r.call('/v1/definitions',{body:{name:'Triage',systemPrompt:'Triage events.'}})).json.id;
 const a=(await r.call('/v1/agents',{body:{definition:def}})).json.id;
 const made=await r.call(`/v1/agents/${a}/triggers`,{body:{name:'Fresh',prompt:'Triage',mode:'fresh',budget:{usd:1}}});
 const ids=Array.from({length:200},()=>crypto.randomUUID());
 const values=ids.map((_,i)=>`($${i+2},$1,'failed',true,false,${Date.now()})`).join(',');
 await r.triggerQuery(`insert into trigger_deliveries(id,trigger_id,status,verified,deduped,created_at) values ${values}`,[made.json.id,...ids]);
 const reserves=ids.map((_,i)=>`($${i+3},$1,$2)`).join(',');
 await r.triggerQuery(`insert into trigger_run_agents(id,trigger_id,expires_at) values ${reserves}`,[made.json.id,Date.now()+3600000,...ids]);
 const sent=await r.call(new URL(made.json.url).pathname,{body:{event:'capacity'},token:null});assert.equal(sent.status,202,sent.text);
 await until(async()=>Number((await r.triggerQuery('select attempts from trigger_deliveries where id=$1',[sent.json.id])).rows[0].attempts)===1,'the capacity refusal to be retried');
 let row=(await r.triggerQuery('select * from trigger_deliveries where id=$1',[sent.json.id])).rows[0];
 assert.equal(row.status,'queued');assert.ok(row.data);assert.ok(Number(row.next_at)>Date.now());
 await r.triggerQuery('delete from trigger_run_agents where trigger_id=$1',[made.json.id]);
 await r.triggerQuery('update trigger_deliveries set next_at=0 where id=$1',[sent.json.id]);
 await until(async()=>{row=(await r.triggerQuery('select * from trigger_deliveries where id=$1',[sent.json.id])).rows[0];return row.status==='submitted';},'a fresh run after capacity returns');
 assert.notEqual(row.run_agent,a);assert.equal(row.data,null);assert.equal(row.attempts,2);
});

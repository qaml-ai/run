import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {contractTest,OTHER_OPERATOR,until,lastUser} from '../support.ts';
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
 await until(()=>r.model.bodies.some(b=>lastUser(b).includes('payload.json')),'attached payload');
 const deliveries=(await r.call(`${base}/${made.json.id}/deliveries`)).json;
 assert.ok(deliveries.some((d:any)=>d.status==='rejected'&&!d.verified));
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

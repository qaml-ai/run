import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './database.ts';
import { Dreaming, redactDream, type DreamHost, type DreamConfig } from '../shared/dreaming.ts';

const config: DreamConfig={enabled:false,volumeId:'vol_memory',schedule:{time:'01:00',timeZone:'UTC'},analyzerModel:'cheap',organizerModel:'organizer',budgetUsd:1,instructions:'Keep preferences.'};
const output={status:'completed',files:[{path:'_index.md',text:'---\ntitle: Memory\n---\nEvidence.'}],summary:'Added evidence.'};
test('durable dreams keep the window on publication failure, resume polling after restart, and save summaries',async()=>{
  const {db}=await testDatabase();
  await db.query("insert into agents(id,tenant,header,revision,name,type,model) values('agent','tenant','{}',1,'a','agent','m')");
  let starts=0,publishes=0,failPublish=true,done=false,sourceTime=0,runError: string | undefined;
  const host: DreamHost={
    db:(sql,values)=>db.query(sql,values),verify:async()=>{},memory:async()=>({}),
    page:async()=>({entries:[{index:0,message:{timestamp:sourceTime,content:'token=abcdefghijklmno'}}],total:1,nextAfter:1}),
    start:async(_tenant,_key,_config,code)=>{starts++;assert.ok(!code.includes('abcdefghijklmno'));return {agent:'dreamer',request:'request'};},
    result:async()=>({done,output,error:runError}),
    publish:async()=>{publishes++;if(failPublish) throw new Error('Storage unavailable');},
  };
  const service=new Dreaming(host);
  await service.configure('tenant','agent',config);
  const since=(await service.get('tenant','agent'))!.since;
  sourceTime=since+1;
  await new Promise(resolve=>setTimeout(resolve,5));
  await service.now('tenant','agent');
  await service.scan();
  assert.equal(starts,1);
  const restarted=new Dreaming(host);
  await restarted.scan();
  assert.equal(starts,1,'polling does not start another coordinator');
  done=true;await restarted.scan();
  let state=(await restarted.get('tenant','agent'))!;
  assert.equal(state.since,since,'failed publication does not advance the watermark');
  assert.equal(state.lastResult.status,'failed');
  assert.equal(state.results.length,1);
  failPublish=false;
  await new Promise(resolve=>setTimeout(resolve,5));
  await restarted.now('tenant','agent');
  await restarted.scan();await restarted.scan();
  state=(await restarted.get('tenant','agent'))!;
  assert.equal(state.lastResult.status,'completed');
  assert.ok(state.since>since);
  assert.equal(state.results.length,2);
  assert.equal(publishes,2);
  const completedSince=state.since;
  sourceTime=completedSince+1;
  await new Promise(resolve=>setTimeout(resolve,5));
  runError='spend_limit';
  await restarted.now('tenant','agent');
  await Promise.all([restarted.scan(),restarted.scan()]);
  await restarted.scan();
  state=(await restarted.get('tenant','agent'))!;
  assert.equal(state.lastResult.status,'budget_reached');
  assert.equal(state.since,completedSince);
  assert.equal(publishes,2,'a budget failure never publishes');
  runError=undefined; done=false;
  await restarted.configure('tenant','agent',{...config,enabled:true});
  await db.query('update agent_dreaming set due_at=0 where agent=$1',['agent']);
  const previousStarts=starts;
  await restarted.scan();await restarted.scan();
  assert.equal(starts,previousStarts+1,'a due enabled job starts without run-now');
  assert.equal((await restarted.get('tenant','agent'))!.running,true);
});

test('dream redaction removes credential fields, bearer tokens and private keys',()=>{
  const redacted=redactDream({apiKey:'secret',message:'password=hunter2 Bearer secret-token',nested:{token:'secret'},key:'-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----'});
  const serialized=JSON.stringify(redacted);
  assert.equal(redactDream('access_token=short value with spaces'),'access_token=[redacted]');
  assert.equal(redactDream('Authorization: Basic short'),'Authorization=[redacted]');
  assert.equal(redactDream('api key: short'),'api key=[redacted]');
  const source='client_'+'1'.repeat(40);
  assert.equal(redactDream(`Evidence from ${source}, message 3.`),`Evidence from ${source}, message 3.`);
  for(const secret of ['hunter2','secret-token','private','"secret"']) assert.ok(!serialized.includes(secret));
});

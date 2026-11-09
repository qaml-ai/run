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

test('paths and low-entropy words survive while opaque credentials and every URL userinfo scheme are redacted',()=>{
  assert.equal(redactDream('projects/customer-onboarding-flow.md'),'projects/customer-onboarding-flow.md');
  assert.equal(redactDream('customer-onboarding-flow-with-weekly-updates'),'customer-onboarding-flow-with-weekly-updates');
  for(const scheme of ['postgres','redis','mongodb+srv','amqp','custom.thing']) {
    const text=redactDream(`${scheme}://alice:short%20secret@host/db`);
    assert.ok(!text.includes('alice'));assert.ok(!text.includes('short'));assert.ok(text.includes(`${scheme}://`));
  }
  assert.equal(redactDream('Ab2xT9mW4nP7qR5yK8jH3dV6zL0sC1fG'),'[redacted]');
});

test('defaults require explicit budget and multi-user dreaming requires a scope or explicit consent',async()=>{
  const {dreamConfig}=await import('../shared/dreaming.ts');
  const {analyzerModel:_,organizerModel:__,...minimal}=config;
  assert.equal(dreamConfig(minimal).analyzerModel,'camelrun/default');
  assert.equal(dreamConfig(minimal).organizerModel,'camelrun/default');
  assert.throws(()=>dreamConfig({...minimal,budgetUsd:undefined}));
  const {db}=await testDatabase();await db.query("insert into agents(id,tenant,header,revision,name,type,model) values('agent','tenant','{}',1,'a','agent','m')");
  const service=new Dreaming({db:(s,v)=>db.query(s,v),page:async()=>({entries:[],total:0}),verify:async()=>{},memory:async()=>({}),start:async()=>({agent:'x',request:'x'}),result:async()=>({done:false}),publish:async()=>{},scope:async()=>({requests:[{id:'a',endUser:'alice'},{id:'b',endUser:'bob'}]})});
  await assert.rejects(service.configure('tenant','agent',{...config,enabled:true}),/multiple end users/);
  await service.configure('tenant','agent',{...config,enabled:true,endUser:'alice'});
  await service.configure('tenant','agent',{...config,enabled:true,acrossUsers:true});
});

test('chunks split oversized windows and single messages, preserving a durable checkpoint',async()=>{
  const {dreamChunk}=await import('../shared/dreaming.ts');
  const entries=Array.from({length:12},(_,i)=>({index:i,message:{timestamp:i<6?10:20,content:'abcd'.repeat(8000)}}));
  const store={query:async()=>({rows:[{id:'agent'}]}),page:async(_a:string,after:number,limit:number)=>({entries:entries.slice(after,after+limit),total:entries.length,nextAfter:Math.min(entries.length,after+limit)})};
  let point:any={from:0,to:30,target:30};let count=0;const seen=new Set<number>();
  while(point) {
    const chunk=await dreamChunk(store,'tenant','agent',point);
    assert.ok(chunk.inputs.length<=4);
    for(const input of chunk.inputs) {assert.ok(new TextEncoder().encode(JSON.stringify(input)).length<25000);for(const entry of input.entries) seen.add(entry.index);}
    if(chunk.next) assert.notDeepEqual(chunk.next,point);
    point=chunk.next;if(++count>100) throw new Error('chunk did not advance');
  }
  assert.equal(seen.size,12);assert.ok(count>4);
});

test('known secrets never reach published text, results, audit, or failure notices; paths remain exact',async()=>{
  const {db}=await testDatabase();await db.query("insert into agents(id,tenant,header,revision,name,type,model) values('agent','tenant','{}',1,'a','agent','m')");
  let at=0,fail=false,published:Record<string,string>={};
  const secret='short credential with spaces';
  const path='projects/customer-onboarding-flow.md';
  const service=new Dreaming({db:(s,v)=>db.query(s,v),verify:async()=>{},secrets:async()=>[secret],memory:async()=>published,
    page:async()=>({entries:[{index:0,message:{timestamp:at,content:'useful fact'}}],total:1,nextAfter:1}),
    start:async()=>({agent:'worker',request:'request'}),result:async()=>fail?{done:true,error:`Provider failed: ${secret}`}:{done:true,output:{status:'completed',files:[{path:'_index.md',text:`---\ntitle: Memory\n---\n[Project](${path})`},{path,text:`---\ntitle: Project\n---\nFact ${secret} https://evil.example/exfil`}],summary:`Saved ${secret}`}},publish:async(_t,_v,files)=>{published=files;}});
  await service.configure('tenant','agent',config);at=(await service.get('tenant','agent'))!.since+1;await new Promise(r=>setTimeout(r,5));
  await service.now('tenant','agent');await service.scan();await service.scan();
  assert.ok(published[path]);assert.ok(!JSON.stringify(published).includes(secret));assert.ok(!published[path].includes('evil.example'));
  assert.ok(!JSON.stringify(await service.get('tenant','agent')).includes(secret));
  fail=true;
  for(let night=0;night<3;night++) {
    await db.query('update agent_dreaming set failed_date=$1',[new Date(Date.now()-86400000).toISOString().slice(0,10)]);at=(await service.get('tenant','agent'))!.since+1;await new Promise(r=>setTimeout(r,5));
    await service.now('tenant','agent');await service.scan();await service.scan();
  }
  const state=(await service.get('tenant','agent'))!;assert.equal(state.failedNights,3);assert.ok(state.lastResult.error.includes('[redacted]'));
  const events=(await db.query("select data from billing_events where type='dreaming.failed'")).rows;
  assert.equal(events.length,1);assert.ok(!JSON.stringify(events).includes(secret));
  const audits=(await db.query('select result from agent_dreaming_runs')).rows;assert.ok(!JSON.stringify(audits).includes(secret));
});

test('a busy source caps the window at its unfinished turn and still publishes older messages',async()=>{
  const {db}=await testDatabase();await db.query("insert into agents(id,tenant,header,revision,name,type,model) values('agent','tenant','{}',1,'a','agent','m')");
  let since=0,code='',published=0;
  const service=new Dreaming({db:(s,v)=>db.query(s,v),verify:async()=>{},memory:async()=>({}),
    scope:async()=>({requests:[{id:'running',method:'prompt',state:'running',began:since+10}]}),
    page:async()=>({entries:[{index:0,message:{timestamp:since+1,content:'older fact'}},{index:1,message:{timestamp:since+11,content:'BUSY_UNFINISHED'}}],total:2,nextAfter:2}),
    start:async(_t,_k,_c,input)=>{code=input;return {agent:'worker',request:'request'};},result:async()=>({done:true,output}),publish:async()=>{published++;}});
  await service.configure('tenant','agent',config);since=(await service.get('tenant','agent'))!.since;
  await new Promise(r=>setTimeout(r,20));await service.now('tenant','agent');await service.scan();await service.scan();
  assert.ok(code.includes('older fact'));assert.ok(!code.includes('BUSY_UNFINISHED'));assert.equal(published,1);
  assert.equal((await service.get('tenant','agent'))!.since,since+10);
});

test('published chunks advance time and a failed later chunk resumes from the committed checkpoint',async()=>{
  const {db}=await testDatabase();await db.query("insert into agents(id,tenant,header,revision,name,type,model) values('agent','tenant','{}',1,'a','agent','m')");
  const base=Date.now()-1000;
  const entries=[200,400,600,800].map((n,index)=>({index,message:{timestamp:base+n,content:`entry-${index} `+'long factual note '.repeat(4000)}}));
  let published=0,fail=false;const keys:string[]=[];let memory:Record<string,string>={};
  const host:DreamHost={db:(s,v)=>db.query(s,v),verify:async()=>{},memory:async()=>memory,
    page:async()=>({entries,total:entries.length,nextAfter:entries.length}),
    start:async(_t,key,_c,_code,request)=>{keys.push(key);return {agent:key,request:request!};},
    result:async()=>fail?{done:true,error:'Provider temporarily unavailable'}:{done:true,output},
    publish:async(_t,_v,files)=>{published++;memory=files;}};
  const service=new Dreaming(host);await service.configure('tenant','agent',config);
  await db.query('update agent_dreaming set since=$1',[base]);await service.now('tenant','agent');
  await service.scan();await service.scan();
  const saved=(await service.get('tenant','agent'))!;
  assert.equal(published,1);assert.ok(saved.since>base);assert.ok(saved.checkpoint);
  const checkpoint=JSON.stringify(saved.checkpoint);fail=true;
  await service.scan();await service.scan();
  assert.equal((await service.get('tenant','agent'))!.since,saved.since);
  assert.equal(JSON.stringify((await service.get('tenant','agent'))!.checkpoint),checkpoint);
  assert.equal(keys[0],keys[1],'chunks in a night share one coordinator budget');
  fail=false;const restarted=new Dreaming(host);await new Promise(r=>setTimeout(r,5));await restarted.now('tenant','agent');
  for(let i=0;i<30 && (await restarted.get('tenant','agent'))!.running;i++) await restarted.scan();
  assert.equal((await restarted.get('tenant','agent'))!.checkpoint,null);
  assert.ok((await restarted.get('tenant','agent'))!.since>saved.since);
  assert.ok(published>1);
});

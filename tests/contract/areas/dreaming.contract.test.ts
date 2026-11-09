import { contractTest, OTHER_OPERATOR, until, toolCall } from '../support.ts';
import assert from 'node:assert/strict';

contractTest('history','docs/guides/session-transcripts.md','dreaming config requires a read-only memory mount and isolates tenants',async(_t,f)=>{
  const volume=(await f.call('/v1/volumes',{body:{name:'memory'}})).json;
  const created=await f.call('/v1/agents',{body:{mounts:[{volumeId:volume.id,path:'/memory',mode:'ro'}]}});
  const agent=created.json.id;
  assert.equal(created.status,201,created.text);
  const config={enabled:false,volumeId:volume.id,schedule:{time:'01:00',timeZone:'UTC'},analyzerModel:'openrouter/openai/gpt-4o-mini',organizerModel:'openrouter/openai/gpt-4o-mini',budgetUsd:1,instructions:'Keep durable preferences.'};
  const saved=await f.call(`/v1/agents/${agent}/dreaming`,{method:'PUT',body:config});
  assert.equal(saved.status,200,saved.text);
  assert.equal(saved.json.config.budgetUsd,1);
  assert.equal((await f.call(`/v1/agents/${agent}/dreaming`,{token:OTHER_OPERATOR})).status,404);
  assert.equal((await f.call('/v1/agents',{body:{mounts:[{volumeId:volume.id,path:'/memory',mode:'rw'}]}})).status,400);
  const other=(await f.call('/v1/agents',{body:{}})).json.id;
  assert.equal((await f.call(`/v1/agents/${other}/dreaming`,{method:'PUT',body:config})).status,400);
});

contractTest('history','docs/guides/session-transcripts.md','a run-now dream delegates analysis and organization and publishes an index',async(_t,f)=>{
  const provider=await f.call('/v1/providers/dream-test',{method:'PUT',body:{type:'openai-completions',baseUrl:f.model.url,models:[{id:'small',contextWindow:128000,pricing:{input:1,output:1}}]}});
  assert.equal(provider.status,200,provider.text);
  const analyzed: string[]=[];
  const workerTools: string[][]=[];
  f.setModel(body=>{
    const text=JSON.stringify(body.messages);
    if(text.includes('Treat transcripts') || text.includes('Treat candidate notes')) workerTools.push((body.tools ?? []).map((tool:any)=>tool.function?.name ?? tool.name));
    if(text.includes('Treat candidate notes')) return toolCall('final_output',{files:[{path:'_index.md',text:'---\ntitle: Memory\n---\nPrefers concise answers. token=demo-hidden-secret-123'}],summary:'Recorded a preference.'},'organizer_output');
    if(text.includes('Treat transcripts')) {analyzed.push(text);return toolCall('final_output',{notes:'Prefers concise answers; source message 0.'},'analyzer_output');}
    return {content:'Acknowledged.'};
  });
  const volume=(await f.call('/v1/volumes',{body:{name:'dream memory'}})).json;
  const agent=(await f.call('/v1/agents',{body:{mounts:[{volumeId:volume.id,path:'/memory',mode:'ro'}]}})).json.id;
  const saved=await f.call(`/v1/agents/${agent}/dreaming`,{method:'PUT',body:{enabled:false,volumeId:volume.id,schedule:{time:'01:00',timeZone:'UTC'},analyzerModel:'dream-test/small',organizerModel:'dream-test/small',budgetUsd:1,instructions:'Keep preferences.'}});
  assert.equal(saved.status,200,saved.text);
  await f.prompt(agent,'I prefer concise answers. token=demo-hidden-secret-123');
  const queued=await f.call(`/v1/agents/${agent}/dreaming/run`,{body:{}});
  assert.equal(queued.status,202,queued.text);
  const state=await until(async()=>{
    const result=(await f.call(`/v1/agents/${agent}/dreaming`)).json;
    return result.lastResult ? result : undefined;
  },'dream result',60000);
  assert.equal(state.lastResult.status,'completed',JSON.stringify(state));
  assert.equal(state.lastResult.summary,'Recorded a preference.');
  assert.ok(state.since > saved.json.since);
  const files=await f.call(`/v1/volumes/${volume.id}/files?content=true`);
  assert.equal(files.status,200,files.text);
  assert.ok(files.json.files.some((file:any)=>file.path==='/_index.md'));
  assert.ok(analyzed.length);
  assert.ok(workerTools.every(names=>names.every(name=>['final_output','report_progress'].includes(name))),JSON.stringify(workerTools));
  assert.ok(analyzed.every(text=>!text.includes('demo-hidden-secret-123')));
  assert.ok(!JSON.stringify(files.json).includes('demo-hidden-secret-123'));
}, {env:{AGENT_OUTBOUND_ALLOW_HTTP:'true',AGENT_OUTBOUND_ALLOW_CIDRS:'127.0.0.1/32'}});

contractTest('history','docs/guides/dreaming.md','a dream budget failure preserves the window and publishes nothing',async(_t,f)=>{
  assert.equal((await f.call('/v1/providers/dream-budget',{method:'PUT',body:{type:'openai-completions',baseUrl:f.model.url,models:[{id:'small',contextWindow:128000,pricing:{input:1,output:1}}]}})).status,200);
  f.setModel(body=>JSON.stringify(body.messages).includes('Treat transcripts')
    ? {...toolCall('final_output',{notes:'A durable fact.'},'budget_output'),usage:{prompt_tokens:100,completion_tokens:10}}
    : {content:'ok'});
  const volume=(await f.call('/v1/volumes',{body:{name:'budget memory'}})).json;
  const agent=(await f.call('/v1/agents',{body:{mounts:[{volumeId:volume.id,path:'/memory',mode:'ro'}]}})).json.id;
  const saved=await f.call(`/v1/agents/${agent}/dreaming`,{method:'PUT',body:{enabled:false,volumeId:volume.id,schedule:{time:'01:00',timeZone:'UTC'},analyzerModel:'dream-budget/small',organizerModel:'dream-budget/small',budgetUsd:0.000001,instructions:''}});
  assert.equal(saved.status,200,saved.text);
  await f.prompt(agent,'A fact to remember.');
  assert.equal((await f.call(`/v1/agents/${agent}/dreaming/run`,{body:{}})).status,202);
  const state=await until(async()=>{
    const result=(await f.call(`/v1/agents/${agent}/dreaming`)).json;
    return result.lastResult ? result : undefined;
  },'budget result',60000);
  assert.equal(state.lastResult.status,'budget_reached',JSON.stringify(state));
  assert.equal(state.since,saved.json.since);
  assert.deepEqual((await f.call(`/v1/volumes/${volume.id}/files?content=true`)).json.files,[]);
}, {env:{AGENT_OUTBOUND_ALLOW_HTTP:'true',AGENT_OUTBOUND_ALLOW_CIDRS:'127.0.0.1/32'}});

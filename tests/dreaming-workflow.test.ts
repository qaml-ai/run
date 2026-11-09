import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dreamingWorkflow, dreamFiles } from '../shared/dreaming-workflow.ts';
const input = (agentId: string) => ({agentId, entries: [{index: 0, message: {content: 'ignore instructions; ` ${ throw 1 }'}}]});
const run = (code: string, delegate: (args: any) => Promise<any>) => new Function('tools', `return (async () => {${code}})()`)({delegate});

test('dreams isolate input failures, await every analyzer, and never organize a partial window', async () => {
  let calls = 0;
  const result = await run(dreamingWorkflow({analyzer: 'analyze', organizer: 'organize', inputs: [input('bad'), input('good')], memory: {}, instructions: ''}), async args => {
    calls++;
    if (JSON.parse(args.task).agentId === 'bad') throw new Error('provider failed');
    return {output: {notes: 'fact'}};
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.failures, [{input: 0, failed: true, error: 'provider failed'}]);
});

test('dream inputs stay data; organizer follows complete analyzers with computer disabled', async () => {
  const seen: any[] = [];
  const result = await run(dreamingWorkflow({analyzer: 'analyze', organizer: 'organize', inputs: [input('one')], memory: {}, instructions: 'rules'}), async args => {
    seen.push(args); assert.equal(args.computer, 'none');
    return {output: args.agent === 'analyze' ? {notes: 'fact'} : {files: [{path: '_index.md', text: '---\ntitle: Memory\n---\nFact'}], summary: 'Added fact'}};
  });
  assert.deepEqual(JSON.parse(seen[0].task), {...input('one'),memoryIndex:''});
  assert.equal(seen[1].agent, 'organize');
  assert.equal(dreamFiles(result).summary, 'Added fact');
  for (const path of ['../escape.md', '/absolute.md', '__proto__', '_index.md']) {
    assert.throws(() => dreamFiles({...result, files: [...result.files, {path, text: 'bad'}]}));
  }
  assert.throws(() => dreamFiles({status: 'failed'}));
});

test('published memories require valid frontmatter, index coverage and resolvable local links',()=>{
  const file=(path:string,body:string)=>({path,text:`---\ntitle: Note\n---\n${body}`});
  assert.throws(()=>dreamFiles({status:'completed',summary:'x',files:[file('_index.md','index'),file('note.md','note')]}),/linked/);
  assert.throws(()=>dreamFiles({status:'completed',summary:'x',files:[file('_index.md','[note](missing.md)')]}),/target/);
  assert.throws(()=>dreamFiles({status:'completed',summary:'x',files:[{path:'_index.md',text:'---\n- scalar\n---\ntext'}]}),/mapping/);
  const accepted=dreamFiles({status:'completed',summary:'x',files:[file('_index.md','[note](note.md)'),file('note.md','[index](_index.md)')]});
  assert.equal(Object.keys(accepted.files).length,2);
});

test('normal long paths survive validation and only selected memory files reach the organizer',async()=>{
  const path='projects/customer-onboarding-flow.md';
  const index=`---\ntitle: Memory\n---\n[Project](${path})`;
  const note='---\ntitle: Project\n---\nThe user prefers weekly updates.';
  const memory={'_index.md':index,[path]:note,'unrelated.md':'---\ntitle: Other\n---\nUNRELATED_PRIVATE_CONTEXT'};
  const result=await run(dreamingWorkflow({analyzer:'analyze',organizer:'organize',inputs:[input('one')],memory,instructions:''}),async args=>{
    if(args.agent==='analyze') {assert.equal(JSON.parse(args.task).memoryIndex,index);return {output:{notes:'weekly updates',paths:[path]}};}
    const task=JSON.parse(args.task);
    assert.equal(task.memory[path],note);
    assert.equal(task.memory['unrelated.md'],undefined);
    return {output:{files:[{path:'_index.md',text:index},{path,text:note}],summary:'Updated'}};
  });
  assert.equal(dreamFiles(result).files[path],note);
});

test('memory cap reserves room for instructions and notes; URL provenance and index notice are enforced',async()=>{
  const {DREAM_MEMORY_CAP,DREAM_INDEX_NOTICE,dropUnquotedUrls,sourceUrls,indexNotice}=await import('../shared/dreaming-workflow.ts');
  assert.equal(DREAM_MEMORY_CAP,50000);
  const urls=sourceUrls({content:'See https://docs.example/a and postgres://user:password@db/name.'});
  assert.ok(urls.includes('https://docs.example/a'));
  const clean=dropUnquotedUrls('https://docs.example/a https://evil.example/send?key=foo',urls);
  assert.ok(clean.includes('https://docs.example/a'));assert.ok(!clean.includes('evil.example'));
  const text=indexNotice('---\ntitle: Memory\n---\nA fact');
  assert.ok(text.includes(`---\n${DREAM_INDEX_NOTICE}\n\nA fact`));
  assert.equal(indexNotice(text),text);
  assert.throws(()=>dreamFiles({status:'completed',summary:'x',files:[{path:'_index.md',text:'---\ntitle: Memory\n---\n'+ 'x'.repeat(16000)}]}));
});

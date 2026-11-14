import { fixture } from './workflow-repo-fixture.ts';
import { hookTierServices } from './tier-env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const hooks = hookTierServices();
const { commitChanges, setRefToVersion, branch } = await import('../src/repos/write.ts');
const { mergeRefs } = await import('../src/repos/merge.ts');
const { createRepo, repoContext, deleteRepo } = await import('../src/repos/registry.ts');
const { repoTools } = await import("../src/repos/tools.ts");
const { agentRepoId, releaseAgentFiles } = await import("../src/repos/mounts.ts");
const { PromptAttachments } = await import("../src/prompt-attachments.ts");
const {configImpl}=await import('../src/agent-config.ts');
const {readDreamMemory,publishDreamMemory}=await import('../src/repos/dream-memory.ts');
const {authorizedAttachment}=await import('../src/repos/attachments.ts');
const {configuration,storedConfiguration}=await import('../src/api-contract.ts');
const {dreamConfig}=await import('../src/dreaming-policy.ts');
hooks.deregister();
const bytes = (s: string) => new TextEncoder().encode(s);
const err = (code: string) => (e: any) => { assert.equal(e.code, code); return true; };

test('agent writes commit once with trailers; stale reads, checkpoints and restore preserve history',async t=>{
  const {env,create,fake}=await fixture(t),ctx=await create({key:'agent:a'} as any);
  const seen=new Map<string,string>();
  const mounts=[{repo:ctx.repoId,path:'/workspace',mode:'rw' as const}];
  const tools=repoTools(env,'t','a',async()=>mounts,undefined,undefined,{get:k=>seen.get(k),remember:(k,v)=>{seen.set(k,v);}},{'Camel-Run':'run-1','Camel-Call':'call-1'});
  const run=async(name:string,args:any)=>{const out=await tools.find(t=>t.name===name)!.execute(args,{} as never,{} as never);return (out.output[0] as any).text;};
  const count=()=>fake.calls.filter(c=>c.endsWith('/write')&&c.startsWith('POST ')).length;
  for(const [name,args] of [['write',{path:'/workspace/a.txt',content:'hello'}],['edit',{path:'/workspace/a.txt',edits:[{oldText:'hello',newText:'world'}]}],['cp',{from:'/workspace/a.txt',to:'/workspace/b.txt'}],['mv',{from:'/workspace/b.txt',to:'/workspace/c.txt'}]] as const) {
    const before=count();await run(name,args);assert.equal(count(),before+1,name);
    const head=await ctx.repo.resolve('main'),v=await ctx.repo.commit(head.version);
    assert.equal(v?.author,'agent:a');assert.deepEqual(v?.trailers,{'Camel-Agent':'a','Camel-Checkpoint':'automatic','Camel-Run':'run-1','Camel-Call':'call-1','Camel-Op':'turn'});
  }
  await run('write',{path:'/workspace/b.txt',content:'recreated after move'});
  const checkpoint=await run('checkpoint',{message:'tests pass'}),before=count();
  assert.equal(await run('checkpoint',{message:'tests pass'}),checkpoint,'the same name for the same point is free');assert.equal(count(),before);
  const renamed=await run('checkpoint',{message:'again'});
  assert.notEqual(renamed,checkpoint,'a new name is a new empty commit, not dropped');assert.equal(count(),before+1);
  assert.equal((await ctx.repo.commit(renamed))!.message,'again');
  assert.equal((await ctx.repo.commit(renamed))!.trailers['Camel-Op'],'turn');
  await run('write',{path:'/workspace/a.txt',content:'later'});
  assert.match(await run('diff',{}),/modified a.txt/);
  const restored = await run('restore',{version:checkpoint.slice(0,7)});
  assert.equal((await ctx.repo.commit(restored))!.trailers['Camel-Op'],'restore');
  assert.equal(await run('read',{path:'/workspace/a.txt'}),'world');
  const history = JSON.parse(await run('history',{path:'/workspace/a.txt',limit:1}));
  assert.equal(history.versions[0].author,'agent:a');
  assert.equal(history.next,restored);
  assert.ok(JSON.parse(await run('history',{path:'/workspace/a.txt',after:history.next})).versions.length);
  await commitChanges(ctx,{ref:'main',op:'api',changes:{'a.txt':{bytes:bytes('other')}},message:'other',author:'api:t'});
  await assert.rejects(run('write',{path:'/workspace/a.txt',content:'bad'}),/changed since you last read it/);
  mounts[0].mode='ro' as any;
  for(const name of ['write','checkpoint','restore'])await assert.rejects(run(name,{path:'/workspace/a.txt',content:'bad',message:'bad',version:checkpoint}),/Mount is read-only/);
});
test('attachments of a message are one commit; fork and deletion preserve the parent',async t=>{
  const {env,create,fake}=await fixture(t),ctx=await create({key:'agent:a'} as any);
  const data=new Map();const storage={get:async(k:string)=>data.get(k),put:async(k:string,v:any)=>{data.set(k,v);}};
  const attachments=new PromptAttachments(storage as never,env);
  const commitsBefore=fake.calls.filter(c=>c.startsWith('POST ')&&c.endsWith('/write')).length;
  const files=await attachments.attach({tenant:'t',agent:'a',requestId:'message',mounts:[{repo:ctx.repoId,path:'/workspace',mode:'rw'}]},[{name:'one.txt',data:Buffer.from('one').toString('base64')},{name:'two.txt',data:Buffer.from('two').toString('base64')}]);
  assert.equal(files.length,2);assert.equal(files[0].version,files[1].version);
  assert.equal(fake.calls.filter(c=>c.startsWith('POST ')&&c.endsWith('/write')).length-commitsBefore,1);
  const fork=await createRepo(env,'t',{key:'agent:b',from:{repo:ctx.repoId,version:files[0].version}});
  const child=await repoContext(env,'t',fork.info.id);
  await commitChanges(child,{ref:'main',op:'turn',changes:{'uploads/message/one.txt':{bytes:bytes('child')}},message:'child',author:'agent:b'});
  assert.notEqual((await child.repo.resolve('main')).tree,(await ctx.repo.resolve('main')).tree);
  assert.equal((await ctx.repo.resolve('main')).version,files[0].version);
  const removedMount=await create();
  await removedMount.repo.watch('main','b');
  await deleteRepo(env,'t',removedMount.repoId);
  await releaseAgentFiles(env,'t','b',[{repo:removedMount.repoId,path:'/removed',mode:'ro',notify:true}]);
  await assert.rejects(repoContext(env,'t',fork.info.id),err('no_repo'));
  assert.ok(await ctx.repo.ref('main'));
});
test('stored volume mounts are refused with a counted log and a repair route', async () => {
  const lines: string[] = [], original = console.error;
  console.error = line => lines.push(line);
  try {
    const stored = {id:'stored', config:{mounts:[{volumeId:'vol_old',path:'/workspace'}, {volumeId:'vol_other',path:'/data'}]}};
    const host = {ctx:{storage:{get:async(key:string)=>key==='configuration'?stored:undefined}},env:new Proxy({}, {get:()=>assert.fail('refusal must not read volumes')})};
    await assert.rejects(configImpl.call(host as never), (error: any) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /Mount of volume vol_old at \/workspace is retired/);
      assert.match(error.message, /PUT \/v1\/agents\/stored\/mounts with the full mounts array and remount: true/);
      return true;
    });
    assert.deepEqual(lines.map(line => JSON.parse(line)), [{type:'legacy_volume_mount_refused',agent:'stored',volumes:2}]);
  } finally { console.error = original; }
});

test('dream memory publishes versioned refs and retries restore without new versions',async t=>{
  const {env,create,write}=await fixture(t),ctx=await create();
  await write(ctx,{'old.txt':{bytes:bytes('old')}});
  await publishDreamMemory(env,'t',ctx.repoId,{'memory.txt':'remember'},'night');
  assert.deepEqual(await readDreamMemory(env,'t',ctx.repoId),{'memory.txt':'remember'});
  const snapshot=await ctx.repo.ref('dream/night'),head=await ctx.repo.ref('main');
  assert.ok(snapshot);assert.notEqual(head?.version,snapshot.version);
  for (const version of [head!.version, snapshot.version]) assert.equal((await ctx.repo.commit(version))!.trailers['Camel-Op'],'turn');
  await publishDreamMemory(env,'t',ctx.repoId,{'memory.txt':'ignored retry'},'night');
  assert.equal((await ctx.repo.ref('main'))?.version,head?.version);
  await branch(ctx,{name:'dream/interrupted',from:{version:head!.version}});
  await publishDreamMemory(env,'t',ctx.repoId,{'memory.txt':'after interruption'},'interrupted');
  assert.deepEqual(await readDreamMemory(env,'t',ctx.repoId),{'memory.txt':'after interruption'});
});
test('repo attachment markers require mounted ancestry and respect subpaths',async t=>{
  const {env,create,write}=await fixture(t),parent=await create();
  const original=await write(parent,{'safe/image.png':{bytes:bytes('image')}});
  const child=await create({from:{repo:parent.repoId,version:original.version}} as any);
  const fork=await create({from:{repo:parent.repoId,version:original.version}} as any);
  const privateWrite=await write(fork,{'safe/private.png':{bytes:bytes('private')}});
  const mount={repo:child.repoId,path:'/workspace',mode:'rw' as const};
  const ref:any={repo:parent.repoId,version:original.version,blob:original.files['safe/image.png']!.blob,repoPath:'safe/image.png'};
  assert.equal(await authorizedAttachment(env,'t',[mount],ref),true);
  assert.equal(await authorizedAttachment(env,'t',[{...mount,subpath:'/other'}],ref),false);
  assert.equal(await authorizedAttachment(env,'t',[mount],{...ref,repo:fork.repoId,version:privateWrite.version}),false);
});
test('new and stored mount inputs reject volumes; dreaming keeps its HTTP shape',()=>{
  const legacy={volumeId:'vol_'+ 'a'.repeat(24),path:'/workspace',mode:'rw'};
  assert.throws(()=>configuration({mounts:[legacy] as never},'camel-test/deterministic'),/Volumes are replaced by repos: mount { repo }/);
  assert.throws(()=>storedConfiguration({mounts:[legacy] as never},'camel-test/deterministic'),/Volumes are replaced by repos: mount { repo }/);
  const config={enabled:true,volumeId:'repo_'+'a'.repeat(24),schedule:{time:'03:00',timeZone:'UTC'},budgetUsd:1,instructions:''};
  assert.equal(dreamConfig(config).volumeId,config.volumeId);
  assert.throws(()=>dreamConfig({...config,volumeId:legacy.volumeId}),/Invalid dreaming configuration/);
});

test('recursive copies and moves commit once, and pathless versions select the own workspace',async t=>{
  const {env,create,fake}=await fixture(t),own=await create({key:'agent:owner'} as any),shared=await create();
  const mounts=[{repo:shared.repoId,path:'/shared',mode:'rw' as const},{repo:own.repoId,path:'/work',mode:'rw' as const}];
  const tools=repoTools(env,'t','owner',async()=>mounts);
  const run=async(name:string,args:any)=>tools.find(t=>t.name===name)!.execute(args,{} as never,{} as never);
  await run('write',{path:'/work/src/a',content:'a'});await run('write',{path:'/work/src/b',content:'b'});
  const count=()=>fake.calls.filter(c=>c.startsWith('POST ')&&c.endsWith('/write')).length;
  for(const [name,args]of [['cp',{from:'/work/src',to:'/work/copy',recursive:true}],['mv',{from:'/work/copy',to:'/work/moved'}]] as const){const before=count();await run(name,args);assert.equal(count(),before+1);}
  const before=count();await run('cp',{from:'/work/src',to:'/shared/copied',recursive:true});assert.equal(count(),before+1);
  const checkpoint=await run('checkpoint',{message:'own workspace'});
  assert.equal((await own.repo.commit((await own.repo.ref('main'))!.version))?.message,'own workspace');
  assert.equal((await shared.repo.commit((await shared.repo.ref('main'))!.version))?.message,'cp /work/src');
  const grep=await run('grep',{path:'/work/src/a',pattern:'a'});
  assert.match((grep.output[0]as any).text,/a/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fakeCamelfsd } from './fake-camelfsd.ts';
import { camelfsStorage, StorageError } from '../src/repos/storage.ts';
const hooks = registerHooks({ load(url,context,next) { const result=next(url,context); if((url.endsWith('/prompt-attachments.ts') || url.endsWith('/legacy-prompt-attachments.ts')) && result.source) return {...result,format:'module',source:stripTypeScriptTypes(Buffer.from(result.source).toString(),{mode:'transform'})};return result; }, resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers')
      return { url: 'data:text/javascript,export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} } export const waitUntil=p=>p;', shortCircuit: true };
    if (specifier.endsWith('/security-services.ts'))
      return { url: 'data:text/javascript,export const keyServices=async env=>({accounts:{billing:{storageLimit:async()=>env.limit}}});', shortCircuit: true };
    return next(specifier, context);
  } });
const { RepoDO } = await import('../src/repos/repo-do.ts');
const { TenantRepos } = await import('../src/repos/tenant-repos.ts');
const { commitChanges, setRefToVersion, branch, advanceRef } = await import('../src/repos/write.ts');
const { mergeRefs } = await import('../src/repos/merge.ts');
const { createRepo, repoContext, deleteRepo } = await import('../src/repos/registry.ts');
const { repoTools } = await import("../src/repos/tools.ts");
const { agentRepoId, releaseAgentFiles } = await import("../src/repos/mounts.ts");
const { PromptAttachments } = await import("../src/prompt-attachments.ts");
const {inheritLegacyHistoryPins}=await import('../src/legacy-prompt-attachments.ts');
const {readDreamMemory,publishDreamMemory}=await import('../src/repos/dream-memory.ts');
const {authorizedAttachment}=await import('../src/repos/attachments.ts');
const {configuration,storedConfiguration}=await import('../src/api-contract.ts');
const {dreamConfig}=await import('../src/dreaming-policy.ts');
hooks.deregister();
const bytes = (s: string) => new TextEncoder().encode(s);
const err = (code: string) => (e: any) => { assert.equal(e.code, code); return true; };
function fixture(t: any) {
  const databases: DatabaseSync[] = [];
  function state() {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    const sql = { exec(q: string, ...args: any[]) { const stmt = db.prepare(q); const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []); return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } };
    return { storage: { sql, transactionSync(fn: any) {
          db.exec('BEGIN');
          try {
            const v = fn();
            db.exec('COMMIT');
            return v;
          }
          catch (e) {
            db.exec('ROLLBACK');
            throw e;
          }
        }, setAlarm: async () => { }, deleteAlarm: async () => { } } };
  }
  t.after(() => databases.forEach(d => d.close()));
  const repos = new Map<string, InstanceType<typeof RepoDO>>(), index = new TenantRepos(state().storage as never);
  const tenant = { registerRepo: (r: any) => index.register(r), repoRow: (id: string) => index.row(id), listRepos: (i: any) => index.list(i), markRepoDeleted: (id: string) => index.deleted(id), repoUsage: (id: string, b: number, f: number) => index.usage(id, b, f), reposUsed: () => index.used() };
  const fake = fakeCamelfsd('test-token');
  const env: any = { CAMELFS: { fetch: (input: any, init: any) => fake.fetch(input instanceof Request ? input : new Request(input, init)) }, CAMELFS_API_TOKEN: 'test-token', TENANTS: { getByName: () => tenant }, REPOS: { getByName: (id: string) => {
        if (!repos.has(id))
          repos.set(id, new RepoDO(state() as never, {}));
        return repos.get(id);
      } } };
  const create = async (input = {}) => { const { info } = await createRepo(env, 't', input); return repoContext(env, 't', info.id); };
  const write = (ctx: any, changes: any, extra = {}) => commitChanges(ctx, { ref: 'main', changes, message: 'test', author: 'api:t', who: 'api:t', why: 'test', ...extra });
  return { env, fake, create, write, index };
}

test('agent writes commit once with trailers; stale reads, checkpoints and restore preserve history',async t=>{
  const {env,create,fake}=fixture(t),ctx=await create({key:'agent:a'} as any);
  const seen=new Map<string,string>();
  const mounts=[{repo:ctx.repoId,path:'/workspace',mode:'rw' as const}];
  const tools=repoTools(env,'t','a',async()=>mounts,undefined,undefined,{get:k=>seen.get(k),remember:(k,v)=>{seen.set(k,v);}},{'Camel-Run':'run-1','Camel-Call':'call-1'});
  const run=async(name:string,args:any)=>{const out=await tools.find(t=>t.name===name)!.execute(args,{} as never,{} as never);return (out.output[0] as any).text;};
  const count=()=>fake.calls.filter(c=>c.includes('/commits')&&c.startsWith('POST ')).length;
  for(const [name,args] of [['write',{path:'/workspace/a.txt',content:'hello'}],['edit',{path:'/workspace/a.txt',edits:[{oldText:'hello',newText:'world'}]}],['cp',{from:'/workspace/a.txt',to:'/workspace/b.txt'}],['mv',{from:'/workspace/b.txt',to:'/workspace/c.txt'}]] as const) {
    const before=count();await run(name,args);assert.equal(count(),before+1,name);
    const head=await ctx.stub.resolve('main'),v=await ctx.stub.commit(head.version);
    assert.equal(v?.author,'agent:a');assert.deepEqual(v?.trailers,{'Camel-Agent':'a','Camel-Checkpoint':'automatic','Camel-Run':'run-1','Camel-Call':'call-1'});
  }
  await run('write',{path:'/workspace/b.txt',content:'recreated after move'});
  const checkpoint=await run('checkpoint',{message:'tests pass'}),before=count();
  assert.equal(await run('checkpoint',{message:'again'}),checkpoint);assert.equal(count(),before);
  await run('write',{path:'/workspace/a.txt',content:'later'});
  assert.match(await run('diff',{}),/modified a.txt/);
  await run('restore',{version:checkpoint.slice(0,7)});
  assert.equal(await run('read',{path:'/workspace/a.txt'}),'world');
  assert.match(await run('history',{path:'/workspace/a.txt'}),/agent:a/);
  await commitChanges(ctx,{ref:'main',changes:{'a.txt':{bytes:bytes('other')}},message:'other',author:'api:t',who:'api:t',why:'test'});
  await assert.rejects(run('write',{path:'/workspace/a.txt',content:'bad'}),/changed since you last read it/);
  mounts[0].mode='ro' as any;
  for(const name of ['write','checkpoint','restore'])await assert.rejects(run(name,{path:'/workspace/a.txt',content:'bad',message:'bad',version:checkpoint}),/Mount is read-only/);
});
test('attachments of a message are one commit; fork and deletion preserve the parent',async t=>{
  const {env,create,fake}=fixture(t),ctx=await create({key:'agent:a'} as any);
  const data=new Map();const storage={get:async(k:string)=>data.get(k),put:async(k:string,v:any)=>{data.set(k,v);}};
  const attachments=new PromptAttachments(storage as never,env);
  const files=await attachments.attach({tenant:'t',agent:'a',requestId:'message',mounts:[{repo:ctx.repoId,path:'/workspace',mode:'rw'}]},[{name:'one.txt',data:Buffer.from('one').toString('base64')},{name:'two.txt',data:Buffer.from('two').toString('base64')}]);
  assert.equal(files.length,2);assert.equal(files[0].version,files[1].version);
  assert.equal(fake.calls.filter(c=>c.startsWith('POST ')&&c.includes('/commits')).length,1);
  const fork=await createRepo(env,'t',{key:'agent:b',from:{repo:ctx.repoId,version:files[0].version}});
  const child=await repoContext(env,'t',fork.info.id);
  await commitChanges(child,{ref:'main',changes:{'uploads/message/one.txt':{bytes:bytes('child')}},message:'child',author:'agent:b',who:'agent:b',why:'test'});
  assert.notEqual((await child.stub.resolve('main')).tree,(await ctx.stub.resolve('main')).tree);
  assert.equal((await ctx.stub.resolve('main')).version,files[0].version);
  const removedMount=await create();
  await removedMount.stub.watch('main','b');
  await deleteRepo(env,'t',removedMount.repoId);
  await releaseAgentFiles(env,'t','b',[{repo:removedMount.repoId,path:'/removed',mode:'ro',notify:true}]);
  await assert.rejects(repoContext(env,'t',fork.info.id),err('no-repo'));
  assert.ok(await ctx.stub.ref('main'));
});
test('stored legacy volume mounts still read and write through volume tools',async()=>{
  const files=new Map<string,any>();let reads=0,writes=0;
  const volume={initialize:async()=>{},stat:async(path:string)=>{const f=files.get(path);if(!f)throw new Error('FILE_404:missing');return f;},read:async(path:string)=>{reads++;return {file:files.get(path),bytes:bytes(files.get(path).text)};},write:async(path:string,data:Uint8Array,contentType:string)=>{writes++;const file={path,text:new TextDecoder().decode(data),version:writes,size:data.length,contentType,key:'legacy'};files.set(path,file);return file;}};
  const env:any={VOLUMES:{getByName:(id:string)=>{assert.equal(id,'t:agent:stored');return volume;}},REPOS:{getByName:()=>{throw new Error('Legacy mount must not access repos');}}};
  const tools=repoTools(env,'t','stored',async()=>[{volumeId:'agent:stored',path:'/workspace',mode:'rw'}]);
  await tools.find(t=>t.name==='write')!.execute({path:'/workspace/old.txt',content:'still works'},{} as never,{} as never);
  const result=await tools.find(t=>t.name==='read')!.execute({path:'/workspace/old.txt'},{} as never,{} as never);
  assert.equal((result.output[0] as any).text,'still works');assert.equal(writes,1);assert.equal(reads,1);
});

test('legacy fork history retains only source-authorized pins, and repo refs need no pins',async()=>{
  const pinned:unknown[]=[],key='files/t/vol_legacy/blob';
  const env:any={VOLUMES:{getByName:(id:string)=>{assert.equal(id,'t:vol_legacy');return {hasPin:async(owner:string,k:string)=>owner==='agent:parent'&&k===key,pin:async(owner:string,keys:string[])=>{pinned.push({owner,keys});}};}}};
  assert.deepEqual(await inheritLegacyHistoryPins(env,'t','parent','child',[{content:[{type:'file',repo:'repo_new',blob:'a'.repeat(40),version:'b'.repeat(40)}]}]),[]);
  assert.deepEqual(pinned,[]);
  assert.deepEqual(await inheritLegacyHistoryPins(env,'t','parent','child',[{content:[{type:'file',key}]}]),['vol_legacy']);
  assert.deepEqual(pinned,[{owner:'agent:child',keys:[key]}]);
});

test('dream memory publishes versioned refs and retries restore without new versions',async t=>{
  const {env,create,write}=fixture(t),ctx=await create();
  await write(ctx,{'old.txt':{bytes:bytes('old')}});
  await publishDreamMemory(env,'t',ctx.repoId,{'memory.txt':'remember'},'night');
  assert.deepEqual(await readDreamMemory(env,'t',ctx.repoId),{'memory.txt':'remember'});
  const snapshot=await ctx.stub.ref('dream/night'),head=await ctx.stub.ref('main');
  assert.ok(snapshot);assert.notEqual(head?.version,snapshot.version);
  await publishDreamMemory(env,'t',ctx.repoId,{'memory.txt':'ignored retry'},'night');
  assert.equal((await ctx.stub.ref('main'))?.version,head?.version);
  await branch(ctx,{name:'dream/interrupted',from:{version:head!.version},who:'test'});
  await publishDreamMemory(env,'t',ctx.repoId,{'memory.txt':'after interruption'},'interrupted');
  assert.deepEqual(await readDreamMemory(env,'t',ctx.repoId),{'memory.txt':'after interruption'});
});
test('repo attachment markers require mounted ancestry and respect subpaths',async t=>{
  const {env,create,write}=fixture(t),parent=await create();
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
test('new mount input rejects volumes while stored mounts remain valid; dreaming keeps its HTTP shape',()=>{
  const legacy={volumeId:'vol_'+ 'a'.repeat(24),path:'/workspace',mode:'rw'};
  assert.throws(()=>configuration({mounts:[legacy]},'camel-test/deterministic'),/Volumes are replaced by repos: mount { repo }/);
  assert.deepEqual(storedConfiguration({mounts:[legacy]},'camel-test/deterministic').config.mounts,[legacy]);
  const config={enabled:true,volumeId:'repo_'+'a'.repeat(24),schedule:{time:'03:00',timeZone:'UTC'},budgetUsd:1,instructions:''};
  assert.equal(dreamConfig(config).volumeId,config.volumeId);
  assert.throws(()=>dreamConfig({...config,volumeId:legacy.volumeId}),/Invalid dreaming configuration/);
});

test('recursive copies and moves commit once, and pathless versions select the own workspace',async t=>{
  const {env,create,fake}=fixture(t),own=await create({key:'agent:owner'} as any),shared=await create();
  const mounts=[{repo:shared.repoId,path:'/shared',mode:'rw' as const},{repo:own.repoId,path:'/work',mode:'rw' as const}];
  const tools=repoTools(env,'t','owner',async()=>mounts);
  const run=async(name:string,args:any)=>tools.find(t=>t.name===name)!.execute(args,{} as never,{} as never);
  await run('write',{path:'/work/src/a',content:'a'});await run('write',{path:'/work/src/b',content:'b'});
  const count=()=>fake.calls.filter(c=>c.startsWith('POST ')&&c.includes('/commits')).length;
  for(const [name,args]of [['cp',{from:'/work/src',to:'/work/copy',recursive:true}],['mv',{from:'/work/copy',to:'/work/moved'}]] as const){const before=count();await run(name,args);assert.equal(count(),before+1);}
  const before=count();await run('cp',{from:'/work/src',to:'/shared/copied',recursive:true});assert.equal(count(),before+1);
  const checkpoint=await run('checkpoint',{message:'own workspace'});
  assert.equal((await own.stub.commit((await own.stub.ref('main'))!.version))?.message,'own workspace');
  assert.equal((await shared.stub.commit((await shared.stub.ref('main'))!.version))?.message,'cp /work/src');
  const grep=await run('grep',{path:'/work/src/a',pattern:'a'});
  assert.match((grep.output[0]as any).text,/a/);
});

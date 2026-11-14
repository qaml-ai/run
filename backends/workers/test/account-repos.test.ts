import test from 'node:test';
import assert from 'node:assert/strict';
import { exportRepoFiles, liveRepos } from '../src/account-repos.ts';
import type { RepoContext, RepoEnv } from '../src/repos/registry.ts';

const cap = 64 * 1024 * 1024;
test('account export bounds batches by path count and bytes and streams large blobs', async () => {
  const files = [
    ...Array.from({length:257},(_,i)=>({path:`small/${i}`,size:1,blob:'blob',mode:'100644'})),
    {path:'a',size:cap/2+1,blob:'a',mode:'100644'},
    {path:'b',size:cap/2+1,blob:'b',mode:'100644'},
    {path:'large',size:cap+1,blob:'large',mode:'100644'},
  ];
  const batches: string[][] = [], opened: string[] = [];
  const ctx = {lineage:'lineage',storage:{
    listAll:async()=>files,
    readBatch:async(lineage:string,tree:string,paths:string[],max:number)=>{
      assert.equal(lineage,'lineage');assert.equal(tree,'tree');assert.equal(max,cap);
      assert.ok(paths.length<=256);assert.ok(paths.reduce((n,p)=>n+files.find(f=>f.path===p)!.size,0)<=cap);
      batches.push(paths);
      return paths.map(path=>({...files.find(f=>f.path===path)!,bytes:new Uint8Array(files.find(f=>f.path===path)!.size)}));
    },
    openBlob:async(lineage:string,blob:string,tree:string,path:string)=>{
      assert.equal(lineage,'lineage');assert.equal(tree,'tree');assert.equal(blob,'large');opened.push(path);
      let remaining=cap+1;
      return new Response(new ReadableStream({pull(c){if(!remaining){c.close();return;}const size=Math.min(remaining,1024*1024);remaining-=size;c.enqueue(new Uint8Array(size));}}));
    },
  }} as unknown as RepoContext;
  let count=0;
  for await (const file of exportRepoFiles(ctx,'repo_one',{tree:'tree'})) {
    assert.ok(file.name.startsWith('repos/repo_one/main/'));
    let size=0; for await(const bytes of file.body) size+=bytes.byteLength;
    assert.equal(size,files[count++].size);
  }
  assert.equal(count,files.length);assert.equal(batches[0].length,256);assert.deepEqual(opened,['large']);
});

test('account export refuses a missing batch member instead of silently omitting data', async () => {
  const ctx={storage:{listAll:async()=>[{path:'missing',size:1,blob:'missing'}],readBatch:async()=>[]}} as unknown as RepoContext;
  await assert.rejects(async()=>{for await(const _ of exportRepoFiles(ctx,'id',{tree:'t'})){}},/unavailable/);
});

test('live repos follows tenant index cursors even while each yielded repo is deleted', async () => {
  const calls:unknown[]=[];
  const env={TENANTS:{getByName:(tenant:string)=>{assert.equal(tenant,'tenant');return {listRepos:async(input:any)=>{calls.push(input.after);return input.after?{repos:[{id:'b'}],next:null}:{repos:[{id:'a'}],next:'a'};}};}}} as unknown as RepoEnv;
  const ids=[];for await(const row of liveRepos(env,'tenant'))ids.push(row.id);
  assert.deepEqual(ids,['a','b']);assert.deepEqual(calls,[undefined,'a']);
});

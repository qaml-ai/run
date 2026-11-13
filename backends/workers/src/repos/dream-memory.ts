import { repoContext, versionEntries, type RepoEnv } from './registry.ts';
import { branch, commitChanges, setRefToVersion, type WriteInput } from './write.ts';
import { DreamError } from '../dreaming-policy.ts';
export async function readDreamMemory(env:RepoEnv,tenant:string,repo:string) {
  const ctx=await repoContext(env,tenant,repo),head=await ctx.stub.ref('main');
  if(!head)return {};
  const entries=await versionEntries(ctx,head.version,head.tree);
  const files:Record<string,string>={};
  let used=0;
  for(let offset=0;offset<entries.length;offset+=256) {
    const batch=await ctx.storage.readBatch(ctx.lineage,head.tree,entries.slice(offset,offset+256).map(e=>e.path),16*2**20-used);
    for(const entry of batch) {
      if('error'in entry||entry.bytes.includes(0))throw new DreamError('Memory must contain only text files');
      used+=entry.bytes.length;
      files[entry.path]=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(entry.bytes);
    }
  }
  return files;
}
export async function publishDreamMemory(env:RepoEnv,tenant:string,repo:string,files:Record<string,string>,key:string) {
  const ctx=await repoContext(env,tenant,repo),ref=`dream/${key}`;
  let published=await ctx.stub.ref(ref);
  const metadata=published&&await ctx.stub.commit(published.version);
  // A retry may find the branch created before the organizer's files were committed.
  if(metadata?.trailers['Camel-Dream']!==key) {
    const head=published??await ctx.stub.ref('main');
    if(!published&&head)await branch(ctx,{name:ref,from:{version:head.version},who:'system:dream'});
    const changes:WriteInput['changes']={};
    for(const e of head?await versionEntries(ctx,head.version,head.tree):[])changes[e.path]=null;
    for(const [path,text]of Object.entries(files))changes[path]={bytes:new TextEncoder().encode(text)};
    const saved=await commitChanges(ctx,{ref,changes,expect:head?.version??null,message:`dream ${key}`,author:'system:dream',who:'system:dream',why:'dream',allowEmpty:true,trailers:{'Camel-Checkpoint':'automatic','Camel-Dream':key}});
    published=await ctx.stub.ref(ref);
  }
  const current=await ctx.stub.ref('main'),commit=current&&await ctx.stub.commit(current.version);
  if(commit?.trailers['Camel-Dream']===key&&commit.tree===published!.tree)return;
  await setRefToVersion(ctx,{ref:'main',version:published!.version,newCommit:true,author:'system:dream',who:'system:dream',why:'dream',trailers:{'Camel-Checkpoint':'automatic','Camel-Dream':key}});
}

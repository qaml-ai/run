import type { FileRef } from '../attachment-policy.ts';
import { camelfsStorage } from './storage.ts';
import { repoContext, type RepoEnv } from './registry.ts';
export async function readAttachment(env: RepoEnv, tenant: string, file: FileRef, range?: string) {
  const row=await env.TENANTS.getByName(tenant).repoRow(file.repo);
  if(!row)throw new Error('Attached repo is missing');
  const storage=camelfsStorage(env),v=await storage.getCommit(row.lineage,file.version);
  const path=file.repoPath ?? file.path.replace(/^\/+/, '');
  return storage.readBlob(row.lineage,file.blob,v.tree,path,range);
}

/** A marker is data supplied by a user; bytes require a version reachable through an allowed mount. */
export async function authorizedAttachment(env:RepoEnv,tenant:string,mounts:import('./mounts.ts').Mount[],file:import('../attachment-policy.ts').RepoFileRef) {
  const index=env.TENANTS.getByName(tenant),source=await index.repoRow(file.repo);
  if(!source)return false;
  const path=file.repoPath??file.path.replace(/^\/+/,'');
  const storage=camelfsStorage(env);
  for(const mount of mounts) {
    if(!('repo'in mount))continue;
    const row=await index.repoRow(mount.repo),base=(mount.subpath??'/').replace(/^\/+/,'');
    if(!row||row.deletedAt!==null||row.lineage!==source.lineage||(base&&path!==base&&!path.startsWith(base+'/')))continue;
    const stub=env.REPOS.getByName(`${tenant}:${mount.repo}`),head=await stub.ref(mount.ref??'main');
    if(!head)continue;
    // The repo's own commit index answers ancestry in-process; only a version it never indexed (made in the repo
    // it was forked from) walks the storage plane's parents, bounded.
    if(await stub.commit(file.version)) { if(await stub.mergeBase(head.version,file.version)===file.version)return true; continue; }
    const queue=[head.version],seen=new Set<string>();
    for(let i=0;i<queue.length&&seen.size<1000;i++) {
      const version=queue[i];if(seen.has(version))continue;seen.add(version);
      if(version===file.version)return true;
      const commit=await storage.getCommit(row.lineage,version);queue.push(...commit.parents);
    }
  }
  return false;
}

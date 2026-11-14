import type { FileRef } from '../attachment-policy.ts';
import { camelfsStorage } from './storage.ts';
import { repoContext, type RepoEnv } from './registry.ts';
export async function readAttachment(env: RepoEnv, tenant: string, file: FileRef, range?: string) {
  const row=await env.TENANTS.getByName(tenant).repoRow(file.repo);
  if(!row)throw new Error('Attached repo is missing');
  const storage=camelfsStorage(env, `api:${tenant}`),v=await storage.getCommit(row.lineage,file.version);
  const path=file.repoPath ?? file.path.replace(/^\/+/, '');
  return storage.readBlob(row.lineage,file.blob,v.tree,path,range);
}

/** A marker is data supplied by a user; bytes require a version reachable through an allowed mount. */
export async function authorizedAttachment(env:RepoEnv,tenant:string,mounts:import('./mounts.ts').Mount[],file:import('../attachment-policy.ts').RepoFileRef) {
  const index=env.TENANTS.getByName(tenant),source=await index.repoRow(file.repo);
  if(!source)return false;
  const path=file.repoPath??file.path.replace(/^\/+/,'');
  const storage=camelfsStorage(env, `api:${tenant}`);
  for(const mount of mounts) {
    if(!('repo'in mount))continue;
    const row=await index.repoRow(mount.repo),base=(mount.subpath??'/').replace(/^\/+/,'');
    if(!row||row.deletedAt!==null||row.lineage!==source.lineage||(base&&path!==base&&!path.startsWith(base+'/')))continue;
    const {repo}=await repoContext(env,tenant,mount.repo),head=await repo.ref(mount.ref??'main');
    if(!head)continue;
    if(await storage.isAncestor(row.lineage,file.version,head.version))return true;
  }
  return false;
}

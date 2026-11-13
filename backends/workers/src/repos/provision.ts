import { AsyncLocalStorage } from 'node:async_hooks';
import { prepareApply } from '../../../../shared/apply-scope.ts';
import { keyedRepoId } from './identity.ts';
import { check, RepoError } from './repo-policy.ts';
import type { RepoEnv } from './registry.ts';
import type { RepoRow } from './tenant-repos.ts';
/** Apply validates repo identities without creating Durable Objects during its rolled-back preview. */
export const repoProvision = new AsyncLocalStorage<Map<string,{key:string;name:string;row:RepoRow}>>();
export async function planRepo(env:RepoEnv,tenant:string,key:string,name='repo') {
  check(typeof name==='string'&&name.length>=1&&name.length<=120,'bad-name');
  const id=keyedRepoId(tenant,key);
  const prior=await prepareApply(`repo-row:${tenant}:${id}`,()=>env.TENANTS.getByName(tenant).repoRow(id));
  if(prior?.deletedAt!==null&&prior?.deletedAt!==undefined)throw new RepoError('deleted-key',409,'deleted-key');
  const row=prior??{id,key,name,lineage:`${tenant}:${id}`,createdAt:Date.now(),deletedAt:null,bytes:0,files:0};
  repoProvision.getStore()!.set(id,{key,name,row});
  return {row,existing:!!prior};
}
export async function plannedRow(env:RepoEnv,tenant:string,id:string) {
  return repoProvision.getStore()?.get(id)?.row??await prepareApply(`repo-row:${tenant}:${id}`,()=>env.TENANTS.getByName(tenant).repoRow(id));
}

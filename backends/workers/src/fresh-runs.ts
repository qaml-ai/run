import type { FreshRunProvisioner } from '../../../src/core/fresh-runs.ts';
import type { Env } from './agent-types.ts';
import { Directory } from './control.ts';
import { keyServices } from './security-services.ts';
import { accountServices } from './account-services.ts';
import { provisionDefinition } from './definitions.ts';
import { HttpError } from './errors.ts';

/** Shared by scheduled and webhook runs; Directory owns creation admission and idempotency. */
export async function workerFreshRunHost(env:Env):Promise<FreshRunProvisioner> {
 const {accounts}=await keyServices(env);
 return {
  async precheck(tenant) {
   await accountServices(env,accounts,env.AGENT_PUBLIC_URL||'https://localhost').limits.runsLeft(tenant);
   const refusal=await accounts.runLimit(tenant);
   if(refusal)throw typeof refusal==='string'?new HttpError(402,refusal):refusal;
   const limit=await accounts.billing.busyLimit(tenant);
   if(Number((await env.TENANTS.getByName(tenant).status()).active)>=Math.min(limit.limit,Number(env.TENANT_MAX_ACTIVE??Number.MAX_SAFE_INTEGER)))throw new HttpError(429,'Tenant concurrency limit');
  },
  async definition(tenant,agent) {
   const source=await new Directory(env,tenant).get(agent);
   if(!source?.config.definition)throw new HttpError(400,'Fresh runs require an agent definition');
   return source.config.definition;
  },
  async upsert(tenant,input,key) {
   const entry=await new Directory(env,tenant).upsert(await provisionDefinition(env,tenant,input),key,env.AGENT_PUBLIC_URL||'https://localhost');
   if('failed' in entry)throw new HttpError(entry.status,entry.error);
   return entry.id;
  }
 };
}

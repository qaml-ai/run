export const FRESH_RUN_TTL_MS = 7 * 86400000;
export const MAX_FRESH_RUN_AGENTS = 200;
export interface FreshRunProvisioner {
  precheck(tenant:string):Promise<void>;
  definition(tenant:string,agent:string):Promise<string>;
  upsert(tenant:string,input:{definition:string;ttlSeconds:number;mounts?:unknown},key:string):Promise<string>;
}
/** The shared orchestration point for fresh automation runs. Reservations are durable and source-specific. */
export interface FreshRunHost {
  reserve(): Promise<string | null>;
  precheck(): Promise<void>;
  definition(): Promise<string>;
  upsert(input: { definition: string; ttlSeconds: number }, key: string): Promise<string>;
  record(agent: string): Promise<void>;
}
export async function freshAutomationRun(host: FreshRunHost, key: string): Promise<string> {
  const prior = await host.reserve();
  if (prior) return prior;
  await host.precheck();
  const agent = await host.upsert({ definition: await host.definition(), ttlSeconds: FRESH_RUN_TTL_MS / 1000 }, key);
  await host.record(agent);
  return agent;
}

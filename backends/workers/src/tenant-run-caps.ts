import { keyServices, type KeyEnv } from './security-services.ts';
import { RUN_LIMITS, ADMIN_RUN_LIMITS } from './run-caps-policy.ts';

type CapsEnv = KeyEnv & Partial<Record<'AGENT_MAX_RUN_RESPONSES' | 'AGENT_MAX_RUN_SECONDS' | 'AGENT_ADMIN_MAX_RUN_RESPONSES' | 'AGENT_ADMIN_MAX_RUN_SECONDS', string>>;
export async function tenantRunCaps(env: CapsEnv, tenant: string) {
  const { accounts, tenants } = await keyServices(env);
  const own = await accounts.billing.runLimits(tenant), admin = tenants.has(tenant);
  const prefix = admin ? 'AGENT_ADMIN_MAX_RUN_' : 'AGENT_MAX_RUN_';
  const defaults = admin ? ADMIN_RUN_LIMITS : RUN_LIMITS;
  const maxResponses = own.maxResponses ?? Number(env[`${prefix}RESPONSES`] ?? defaults.maxResponses);
  const maxSeconds = own.maxSeconds ?? Number(env[`${prefix}SECONDS`] ?? defaults.maxSeconds);
  if (![maxResponses, maxSeconds].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Run limits must be positive integers');
  return { maxResponses, maxSeconds };
}

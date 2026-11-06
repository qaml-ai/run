import type { Env } from "./agent.ts";
import { HttpError } from "./errors.ts";
import { keyServices } from "./security-services.ts";

/** Creation and busy runs share the tenant's admission authority. Idle Durable
 * Objects do not occupy execution capacity; concurrent initializations do. */
export async function reserveAgentCreation(env: Env, tenant: string, id: string): Promise<() => Promise<void>> {
  const { accounts } = await keyServices(env);
  const { limit } = await accounts.billing.busyLimit(tenant);
  const admission = env.TENANTS.getByName(tenant);
  const token = crypto.randomUUID();
  const accepted = await admission.reserveCreation(id, token, limit);
  if (!accepted) throw Object.assign(new HttpError(429, `This tenant already has ${limit} agents running; retry when one finishes`), { retryAfter: 5 });
  return () => admission.releaseCreation(token);
}

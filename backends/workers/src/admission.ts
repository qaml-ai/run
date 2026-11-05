import { accountServices, type AccountEnv } from "./account-services.ts";
import { keyServices, type SecurityEnv } from "./security-services.ts";
import { BrowserTokens } from "./browser-tokens.ts";
import { RateLimited, rateLimitHeaders, type RateLimitState } from "./account-rate-limits.ts";
import { errorFields, errorHeaders } from "./admission-errors.ts";

export { errorFields, errorHeaders, RateLimited };
export type { RateLimitState };
export type AdmissionEnv = SecurityEnv & AccountEnv;

async function service(env: AdmissionEnv) {
  const { accounts } = await keyServices(env);
  // One rate-limit service per env/origin, shared with console authentication. Only
  // /v1 per-address buckets are isolate-local; tenant and sign-in counters are SQL.
  return accountServices(env, accounts, env.AGENT_PUBLIC_URL || env.PUBLIC_URL || "https://runtime.invalid");
}

/** Per-address /v1 admission. Public account routes already count their own auth requests. */
export async function apiRequest(request: Request, env: AdmissionEnv): Promise<void> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/v1/")) return;
  const services = await service(env), { limits, accounts, auth } = services;
  const client = limits.client(name => request.headers.get(name) ?? undefined, undefined);
  await limits.request(path, client.key, async () => {
    // src/node.ts callerTenant: only credentials that authenticate an operator
    // tenant are exempt. A false or expired token receives the normal IP budget.
    try {
      const authorization = request.headers.get("authorization") ?? undefined;
      const tenant = BrowserTokens.carries(authorization)
        ? new BrowserTokens(env.AGENT_SESSION_SECRET || env.API_TOKEN).verify(authorization!).tenant
        : authorization ? (await accounts.authenticate(authorization))?.tenant : (await auth.principal(request))?.tenant;
      return tenant !== undefined && accounts.tenants.has(tenant);
    } catch { return false; }
  });
}

/** Unchanged upserts read the minute's state without spending another create. */
export async function createAdmission(env: AdmissionEnv, tenant: string, counted = true): Promise<RateLimitState | undefined> {
  return (await service(env)).limits.agentCreate(tenant, counted);
}

/** A replay of an already admitted request neither consumes nor rechecks its budget. */
export async function runAdmission(env: AdmissionEnv, tenant: string, counted = true): Promise<RateLimitState | undefined> {
  if (!counted) return undefined;
  return (await service(env)).limits.run(tenant);
}

export const admissionHeaders = rateLimitHeaders;

/** Called by scheduled maintenance; no per-isolate interval keeps a Worker alive. */
export async function sweepAdmission(env: AdmissionEnv): Promise<void> {
  await (await service(env)).limits.sweep();
}

/** Preserve src's error fields and Retry-After / per-tenant rate-limit headers. */
export function admissionError(error: unknown): Response | undefined {
  if (!(error instanceof RateLimited)) return undefined;
  return Response.json({ error: error.message, code: error.code, ...errorFields(error) }, { status: error.status, headers: errorHeaders(error) });
}

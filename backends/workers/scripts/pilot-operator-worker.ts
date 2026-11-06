import { timingSafeEqual } from "node:crypto";
import { keyRoutes } from "../src/key-routes.ts";
import { billingRoutes } from "../src/billing-routes.ts";
import { keyServices, type SecurityEnv } from "../src/security-services.ts";
import { accountDeletions, type AccountLifecycleEnv } from "../src/account-lifecycle.ts";
import type { AccountServices } from "../src/account-services.ts";

type Options = { tokenHash: string; tenantIds: string[]; expiresAt: number };
type Env = SecurityEnv & AccountLifecycleEnv;

/** Temporary operator, restricted to explicit pilot tenants and an expiry.
 * The deployed source contains a token hash, never a usable credential. It uses
 * the same tenant, token, billing and deletion services as the public app. */
export default function pilotOperator(options: Options) {
  const allowed = new Set(options.tenantIds);
  const principal = { tenantId: "pilot-bootstrap", kind: "operator", scopes: ["*"] };
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
      if (Date.now() > options.expiresAt) return reply({ error: "Bootstrap expired" }, 410);
      const token = request.headers.get("Authorization")?.match(/^Bearer ([^\s]{32,200})$/)?.[1];
      if (!token) return reply({ error: "Unauthorized" }, 401);
      const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
      if (!timingSafeEqual(hash, Buffer.from(options.tokenHash, "hex"))) return reply({ error: "Unauthorized" }, 401);
      const url = new URL(request.url), path = url.pathname;
      if (path === "/healthz" && request.method === "GET") return reply({ ok: true });
      try {
        const setup = { ...env, AGENT_BILLING_ADMINS: "pilot-bootstrap" };
        const services = await keyServices(setup);
        const targeted = /^\/v1\/tenants\/([a-z0-9-]+)(?:\/(limits|deletion))?$/.exec(path);
        const inspect = path === "/pilot/inspect" && request.method === "GET";
        let tenant: string | undefined;
        if (targeted) tenant = targeted[1];
        else if (inspect) tenant = url.searchParams.get("tenant") ?? undefined;
        else if ((path === "/v1/tenants" || path === "/v1/billing/adjustments") && request.method === "POST") {
          const body = await request.clone().json() as { id?: string; tenant?: string };
          tenant = path === "/v1/tenants" ? body.id : body.tenant;
        } else return reply({ error: "Not found" }, 404);
        if ((!tenant || !allowed.has(tenant)) && !(inspect && tenant === undefined)) return reply({ error: "Tenant outside bootstrap scope" }, 403);

        if (inspect) {
          const { rows: [row] } = await services.accounts.db.query(`select
            (select count(*) from tenants where id=any($1::text[]))::int as tenants,
            (select count(*) from agents where tenant=any($1::text[]))::int as agents,
            (select count(*) from api_tokens where tenant=any($1::text[]))::int as api_tokens,
            (select count(*) from provider_keys where tenant=any($1::text[]))::int as provider_keys,
            (select count(*) from model_providers where tenant=any($1::text[]))::int as model_providers,
            (select count(*) from volumes where tenant=any($1::text[]))::int as volumes,
            (select count(*) from end_users where tenant=any($1::text[]))::int as end_users,
            (select count(*) from credit_holds where tenant=any($1::text[]))::int as holds,
            (select coalesce(sum(amount),0)::bigint from credit_holds where tenant=any($1::text[])) as held_micros,
            (select count(*) from end_user_holds where tenant=any($1::text[]))::int as end_user_holds,
            (select coalesce(sum(paid+allowance),0)::bigint from end_user_holds where tenant=any($1::text[])) as end_user_held_micros,
            (select coalesce(sum(balance),0)::bigint from credit_accounts where tenant=any($1::text[])) as balance_micros,
            (select count(*) from credit_ledger where tenant=any($1::text[]) and kind='usage')::int as usage_debits,
            (select coalesce(sum(amount),0)::bigint from credit_ledger where tenant=any($1::text[]) and kind='usage') as usage_micros,
            (select coalesce(sum(responses),0)::bigint from usage where tenant=any($1::text[])) as responses,
            (select count(*) from pi_usage_receipts where tenant=any($1::text[]))::int as receipts,
            (select count(*) from model_attempts where tenant=any($1::text[]))::int as attempts,
            (select count(*) from model_attempts where tenant=any($1::text[]) and state='pending')::int as pending_attempts,
            (select count(*) from model_attempts where tenant=any($1::text[]) and state='settled')::int as settled_attempts,
            (select coalesce(sum(charge),0)::bigint from model_attempts where tenant=any($1::text[])) as attempt_charge_micros,
            (select count(*) from account_deletions where tenant=any($1::text[]) and completed_at is not null)::int as deleted_tenants`, [tenant ? [tenant] : [...allowed]]);
          return reply(row);
        }
        if (targeted && (!targeted[2] || targeted[2] === "deletion")) {
          const deletions = accountDeletions(setup, { accounts: services.accounts } as AccountServices);
          if (request.method === "DELETE" && !targeted[2]) {
            const result = await deletions.request(tenant!, "operator:pilot-bootstrap");
            ctx.waitUntil(deletions.kick());
            return reply(result, 202);
          }
          if (request.method === "GET" && targeted[2] === "deletion") {
            const result = await deletions.status(tenant!);
            ctx.waitUntil(deletions.kick());
            return result ? reply(result) : reply({ error: "No deletion" }, 404);
          }
          return reply({ error: "Not found" }, 404);
        }
        return await keyRoutes(request, setup, principal, services)
          ?? await billingRoutes(request, setup, principal, { billing: services.accounts.billing, exists: id => services.accounts.exists(id) })
          ?? reply({ error: "Not found" }, 404);
      } catch (error) {
        // Never send database errors, request bodies, or credentials to logs.
        const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 500;
        return reply({ error: "Pilot operator request failed" }, status >= 400 && status <= 599 ? status : 500);
      }
    },
  };
}

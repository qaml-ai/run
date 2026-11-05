import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Billing } from "./billing.ts";
import { BillingAlerts } from "./billing-alerts.ts";
import { database, type Db, type PostgresEnv } from "./postgres.ts";
import { databaseTenants, type Tenants } from "./billing-host.ts";
import { Stripe } from "./stripe.ts";
import { HttpError } from "./errors.ts";
import * as schema from "./billing-inputs.ts";
import type { RateLimits } from "./account-rate-limits.ts";

export type BillingEnv = PostgresEnv & {
  PUBLIC_URL?: string;
  AGENT_PUBLIC_URL?: string;
  AGENT_STRIPE_API_URL?: string;
  AGENT_STRIPE_PORTAL_CONFIGURATION?: string;
  AGENT_BILLING_ADMINS?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_API_URL?: string;
  STRIPE_PORTAL_CONFIGURATION?: string;
  BILLING_ADMINS?: string;
  TEST_MODE?: string;
  EMAIL_FROM?: string;
};
export type BillingPrincipal = { tenantId: string; kind: string };
export type BillingServices = { billing?: Billing; alerts?: BillingAlerts; emailEnabled?: boolean; rateLimits?: Pick<RateLimits, "tenantLimit">; busy?: (tenant: string) => Promise<number>; exists?: (tenant: string) => Promise<boolean> };
const json = (value: unknown, status = 200) => Response.json(value, { status });

/** This experiment can never make a live Stripe charge, even if given a live key. */
export function createStripe(env: BillingEnv): Stripe | undefined {
  if (!env.STRIPE_SECRET_KEY) return undefined;
  if (!/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY)) throw new Error("Workers parity only accepts Stripe test keys");
  if (!env.STRIPE_WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET is required");
  const apiUrl = env.STRIPE_API_URL ?? env.AGENT_STRIPE_API_URL;
  if (apiUrl) {
    const url = new URL(apiUrl);
    if (env.TEST_MODE !== "1" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password)
      throw new Error("A Stripe API override requires a local fake in TEST_MODE");
  }
  return new Stripe({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    apiUrl, portalConfiguration: env.STRIPE_PORTAL_CONFIGURATION ?? env.AGENT_STRIPE_PORTAL_CONFIGURATION });
}
export function createBilling(env: BillingEnv, options: { db?: Db; tenants?: Tenants } = {}) {
  return new Billing({ db: options.db ?? database(env), tenants: options.tenants ?? databaseTenants,
    stripe: createStripe(env), publicUrl: env.PUBLIC_URL ?? env.AGENT_PUBLIC_URL });
}
async function input<T>(request: Request, validator: z.ZodType<T>, limit = 4096): Promise<T> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > limit) throw new HttpError(413, "Request body is too large");
  let value: unknown;
  try { value = text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, "Invalid JSON body"); }
  const result = validator.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues.map(i => i.message).join("; "));
  return result.data;
}
function micros(amount: number) {
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) throw new HttpError(400, "Use whole cents");
  return Math.round(amount * 100) * 10_000;
}
function operator(env: BillingEnv, principal: BillingPrincipal) {
  if (principal.kind !== "operator" || !(env.BILLING_ADMINS ?? env.AGENT_BILLING_ADMINS ?? "").split(",").map(s => s.trim()).includes(principal.tenantId))
    throw new HttpError(403, "Only the platform operator can adjust credit");
}

/** Signature/capability-authenticated routes run before account authentication. */
export async function billingPublicRoutes(request: Request, env: BillingEnv, services: BillingServices = {}): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === "/v1/billing/stripe/webhook" && request.method === "POST") {
    const payload = await request.text();
    if (new TextEncoder().encode(payload).length > 1024 * 1024) throw new HttpError(413, "Request body is too large");
    return json(await (services.billing ?? createBilling(env)).webhook(payload, request.headers.get("stripe-signature") ?? undefined));
  }
  const match = /^\/v1\/billing\/alerts\/(confirmation\/(inspect|confirm)|unsubscribe\/(inspect|stop))$/.exec(path);
  if (match && request.method === "POST") {
    const { token } = await input(request, schema.BillingConfirmationInput, 1024);
    const alerts = services.alerts;
    if (!alerts) return json({ status: "unavailable" });
    if (match[2]) {
      if (match[2] === "confirm" && !await alerts.confirm(token)) return json({ status: "unavailable" });
      return json(await alerts.inspectConfirmation(token));
    }
    if (match[3] === "stop") await alerts.unsubscribe(token);
    return json(await alerts.inspectUnsubscribe(token));
  }
  const oneClick = /^\/v1\/billing\/alerts\/one-click\/([^/]+)$/.exec(path);
  if (oneClick) {
    const token = decodeURIComponent(oneClick[1]);
    if (request.method === "GET") return new Response(null, { status: 302, headers: { location: `/console/billing/unsubscribe#${encodeURIComponent(token)}` } });
    if (request.method === "POST") {
      const type = request.headers.get("content-type") ?? "";
      if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)(;|$)/i.test(type)) throw new HttpError(415, "Expected a form submission");
      const text = await request.text();
      if (new TextEncoder().encode(text).length > 4096) throw new HttpError(413, "Request body is too large");
      let form: FormData;
      try { form = await new Request("https://localhost", { method: "POST", headers: { "content-type": type }, body: text }).formData(); }
      catch { throw new HttpError(400, "Invalid form submission"); }
      if (form.get("List-Unsubscribe") !== "One-Click") throw new HttpError(400, "Expected List-Unsubscribe=One-Click");
      await services.alerts?.unsubscribe(token);
      return json({ unsubscribed: true });
    }
  }
}

/** HTTP translation only. The services below retain src/'s SQL transactions and policy. */
export async function billingRoutes(request: Request, env: BillingEnv, principal: BillingPrincipal, services: BillingServices = {}): Promise<Response | undefined> {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (!path.startsWith("/v1/billing") && path !== "/v1/limits") return;
  const billing = services.billing ?? createBilling(env), tenant = principal.tenantId;
  if (path === "/v1/billing" && method === "GET") {
    const [summary, runs, busy] = await Promise.all([billing.summary(tenant), services.rateLimits?.tenantLimit(tenant, "runs"), services.busy?.(tenant)]);
    const after = summary.freeCredit && runs?.tier?.next ? runs.tier.next.limit : runs?.paid !== undefined ? runs.paid || null : undefined;
    return json({ ...summary, ...(busy === undefined ? {} : { busyAgents: { ...summary.busyAgents, busy } }),
      runsPerMinute: runs ? { limit: runs.max, ...(after !== undefined ? { afterPurchase: after } : {}) } : null });
  }
  if (path === "/v1/limits" && method === "GET") {
    const [own, runs, creates, busy] = await Promise.all([billing.limits(tenant), services.rateLimits?.tenantLimit(tenant, "runs"), services.rateLimits?.tenantLimit(tenant, "agentCreates"), services.busy?.(tenant)]);
    const perMinute = (applied: Awaited<ReturnType<RateLimits["tenantLimit"]>>) => applied
      ? { limit: applied.max, source: applied.source, ...(applied.tier ? { tier: applied.tier.name, paid: applied.tier.paid, ...(applied.tier.next ? { next: applied.tier.next } : {}) } : {}) }
      : { limit: null, source: own.tier?.name === "internal" ? "internal" : "default" };
    return json({ tier: own.tier, limits: { busyAgents: { ...own.busyAgents, ...(busy === undefined ? {} : { busy }) }, runsPerMinute: perMinute(runs), agentCreatesPerMinute: perMinute(creates), codeConcurrency: own.codeConcurrency, decisionConcurrency: own.decisionConcurrency }, tiers: own.tiers });
  }
  if (path === "/v1/billing/ledger" && method === "GET") {
    const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined;
    if (before !== undefined && !Number.isSafeInteger(before)) throw new HttpError(400, "before must be a ledger entry id");
    return json(await billing.ledger(tenant, { before, limit: Number(url.searchParams.get("limit") ?? 50) || 50 }));
  }
  if (path === "/v1/billing/adjustments" && method === "POST") {
    operator(env, principal);
    const body = await input(request, schema.AdjustmentInput), key = `adjustment:${body.idempotencyKey ?? randomUUID()}`;
    if (!(services.exists ? await services.exists(body.tenant) : (await billing.db.query("select 1 from tenants where id=$1", [body.tenant])).rowCount)) throw new HttpError(404, `Unknown tenant ${body.tenant}`);
    await billing.post([{ tenant: body.tenant, kind: "adjustment", amount: body.amount, key, metadata: { reason: body.reason, by: tenant } }]);
    const row = (await billing.db.query("select id, tenant, kind, amount, metadata, created_at from credit_ledger where idempotency_key = $1", [key])).rows[0];
    if (row.tenant !== body.tenant || row.amount !== body.amount) throw new HttpError(409, "Idempotency key reused with a different adjustment");
    return json({ id: row.id, kind: row.kind, amount: row.amount, metadata: row.metadata, createdAt: row.created_at }, 201);
  }
  if (path === "/v1/billing/starting-credit/grant" && method === "POST") {
    operator(env, principal);
    const body = await input(request, schema.StartingCreditGrantInput);
    if (!(await billing.db.query("select 1 from tenants where id=$1", [body.tenant])).rowCount) throw new HttpError(404, `Unknown tenant ${body.tenant}`);
    return json(await billing.grantStartingCredit(body.tenant, micros(body.amountUsd), body.reason, tenant), 201);
  }
  if (path === "/v1/billing/checkout" && method === "POST") {
    const body = await input(request, schema.CheckoutInput);
    return json(await billing.checkout(tenant, micros(body.amountUsd), body.requestId), 201);
  }
  if (path === "/v1/billing/payment-method" && method === "GET") return json(await billing.paymentMethod(tenant));
  if (path === "/v1/billing/portal" && method === "POST") {
    const body = await input(request, schema.BillingPortalInput);
    return json(await billing.portal(tenant, body.flow, body.resumeAutoTopup), 201);
  }
  if (path.startsWith("/v1/billing/card-check") && method === "POST") {
    if (!billing.cardCredit) throw new HttpError(503, "Stripe billing is not configured");
    if (path === "/v1/billing/card-check") return json(await billing.cardCredit.start(tenant), 201);
    if (path === "/v1/billing/card-check/confirm") return json(await billing.cardCredit.confirm(tenant, (await input(request, schema.CardCheckConfirmInput)).session));
  }
  if (path.startsWith("/v1/billing/auto-topup")) {
    const auto = billing.autoTopup;
    if (!auto) throw new HttpError(503, "Stripe billing is not configured");
    if (path === "/v1/billing/auto-topup" && method === "GET") return json(await auto.get(tenant));
    if (path === "/v1/billing/auto-topup/quote") {
      if (method === "GET") {
        const id = z.uuid().optional().safeParse(url.searchParams.get("id") ?? undefined);
        if (!id.success) throw new HttpError(400, "Invalid quote id");
        return json(await auto.preview(tenant, id.data));
      }
      if (method === "POST") {
        const body = await input(request, schema.AutoTopupTerms);
        return json(await auto.quote(tenant, { threshold: micros(body.thresholdUsd), amount: micros(body.amountUsd), monthlyLimit: micros(body.monthlyLimitUsd) }), 201);
      }
    }
    if (method === "POST") {
      if (path.endsWith("/enable")) { const body = await input(request, schema.AutoTopupConsent); return json(await auto.enable(tenant, body.quoteId, body.version, body.consent)); }
      if (path.endsWith("/disable")) return json(await auto.disable(tenant));
      if (path.endsWith("/refresh")) return json(await auto.refresh(tenant));
      if (path.endsWith("/retry")) return json(await auto.retry(tenant, (await input(request, schema.AutoTopupRetry)).attemptId));
    }
  }
  if (path.startsWith("/v1/billing/alerts")) {
    if (await billing.mode(tenant) !== "prepaid") throw new HttpError(400, "Billing alerts are only available for prepaid accounts");
    const alerts = services.alerts;
    if (!alerts) throw new HttpError(503, "Billing email is not configured on this runtime");
    const emailEnabled = services.emailEnabled ?? !!env.EMAIL_FROM;
    if (path === "/v1/billing/alerts") {
      if (method === "GET") return json({ ...await alerts.get(tenant), emailEnabled });
      if (method === "PUT") return json({ ...await alerts.setThreshold(tenant, micros((await input(request, schema.BillingAlertThreshold)).thresholdUsd)), emailEnabled });
    }
    if (path === "/v1/billing/alerts/recipients" && method === "POST") {
      if (!emailEnabled) throw new HttpError(503, "Billing email is not configured on this runtime");
      const body = await input(request, schema.BillingRecipientInput);
      return json(await alerts.add(tenant, body.email, body.events), 201);
    }
    const match = /^\/v1\/billing\/alerts\/recipients\/([^/]+)(\/resend)?$/.exec(path);
    if (match) {
      const id = z.uuid().safeParse(match[1]);
      if (!id.success) throw new HttpError(400, "Invalid recipient id");
      if (match[2] && method === "POST") {
        if (!emailEnabled) throw new HttpError(503, "Billing email is not configured on this runtime");
        await alerts.resend(tenant, id.data); return json({ queued: true });
      }
      if (!match[2] && method === "PUT") return json(await alerts.update(tenant, id.data, await input(request, schema.BillingAlertChoices)));
      if (!match[2] && method === "DELETE") {
        if (!await alerts.remove(tenant, id.data)) throw new HttpError(404, "Unknown billing recipient");
        return json({ deleted: true });
      }
    }
  }
}

/** Cron invokes one bounded pass; never start process timers inside Workers. */
export async function billingMaintenance(billing: Billing) {
  await billing.autoTopup?.pump();
  await billing.payments?.refreshInvoices();
}

import { keyServices, type KeyEnv } from './security-services.ts';
import { keyRoutes } from './key-routes.ts';
import { accountServices, publicAccountRoutes, accountPrincipal, accountManagementRoutes, oauthAllows, type AccountEnv } from './account-services.ts';
import { billingRoutes, billingPublicRoutes, billingMaintenance } from './billing-routes.ts';
import { BillingAlerts } from './billing-alerts.ts';
import { pumpBillingMail } from './billing-mail.ts';
import { Webhooks } from './webhook-policy.ts';
import { Workspaces } from './workspaces.ts';
import { HttpError } from './errors.ts';
import { modelAttempts } from './model-metering.ts';
import { EndUserCredits } from './end-user-credits.ts';
import { endUserRoutes } from './end-user-routes.ts';
import type { AuthContext } from './control.ts';
import { sweepAdmission } from './admission.ts';
import { withMoneyIdempotency, expireMoneyIdempotency } from './money-idempotency.ts';
import { z } from 'zod';
const workspaceName = z.string().trim().min(1).max(120);
const workspaceInput = z.object({ name: workspaceName });
const workspacePatch = z.object({ name: workspaceName.optional(), archived: z.boolean().optional() });
export type MoneyEnv = KeyEnv & AccountEnv;
async function services(env: MoneyEnv, request?: Request) {
  const keys = await keyServices(env);
  const account = accountServices(env, keys.accounts, request ? new URL(request.url).origin : env.PUBLIC_URL ?? 'https://localhost');
  const alerts = new BillingAlerts(keys.accounts.db, keys.accounts);
  const namespace = (env as MoneyEnv & { TENANTS?: { getByName(name: string): {status(): Promise<{active: unknown}>} } }).TENANTS;
  const billing = { billing: keys.accounts.billing, alerts, emailEnabled: !!((env.EMAIL || (env.TEST_MODE === '1' && env.MAIL_TEST_URL)) && (env.AGENT_BILLING_EMAIL_FROM || env.EMAIL_FROM)), rateLimits: account.limits, exists: (tenant: string) => keys.accounts.exists(tenant),
    ...(namespace ? { busy: async (tenant: string) => Number((await namespace.getByName(tenant).status()).active) } : {}) };
  const webhooks = new Webhooks({ db: keys.accounts.db, accounts: keys.accounts, outbound: keys.outbound });
  return { keys, account, billing, webhooks };
}
export async function publicMoneyRoutes(request: Request, env: MoneyEnv, ctx: ExecutionContext) {
  const s = await services(env, request);
  return await publicAccountRoutes(request, s.account, ctx) ?? await billingPublicRoutes(request, env, s.billing);
}
export async function authenticateMoney(request: Request, env: MoneyEnv): Promise<AuthContext | null> {
  const s = await services(env, request);
  const principal = await s.keys.accounts.authenticate(request.headers.get('authorization') ?? undefined)
    ?? await accountPrincipal(request, s.account);
  // Agent MCP is mounted beside the REST API in src and accepts the same tenant credential.
  const agentMcp = /^\/v1\/agents\/client_[a-f0-9]{40}\/mcp$/.test(new URL(request.url).pathname);
  if (principal?.via === 'oauth' && new URL(request.url).pathname.startsWith('/v1/') && !agentMcp && !oauthAllows(request.method, new URL(request.url).pathname))
    throw new HttpError(403, 'An OAuth access token works with agents only: it cannot get agent tokens or make API tokens, links, webhooks, channels or provider keys. Use an API token or the console');
  return principal ? { tenantId: principal.tenant, kind: principal.via === 'operator' ? 'operator' : principal.via === 'oauth' ? 'oauth' : principal.via === 'console' ? 'console' : 'api',
    scopes: ['*'], principal } : null;
}
export async function moneyRoutes(request: Request, env: MoneyEnv, auth: AuthContext, ctx: ExecutionContext): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!/^\/v1\/(?:me|limits|billing|providers|key-scopes|api-keys|tokens|tenants|sessions|oauth|account|usage|webhooks|usage-webhook|workspaces|workspace-memberships|end-user-settings|end-users)/.test(path)) return;
  return withMoneyIdempotency(request, env, auth.tenantId, request => routeMoney(request, env, auth, ctx));
}
async function routeMoney(request: Request, env: MoneyEnv, auth: AuthContext, ctx: ExecutionContext): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  const s = await services(env, request), tenant = auth.tenantId;
  if (auth.kind === 'oauth' && !oauthAllows(request.method, path)) throw new HttpError(403, 'An OAuth access token works with agents only: use an API token or the console');
  const principal = auth.principal ?? { tenant, via: auth.kind === 'operator' ? 'operator' as const : 'token' as const };
  try {
    const managed = await accountManagementRoutes(request, s.account, principal, s.webhooks);
    if (managed) return managed;
  } finally { if (s.account.mail) ctx.waitUntil(s.account.mail.stop()); }
  const keys = await keyRoutes(request, env, auth, s.keys);
  if (keys) {
    if (keys.ok && request.method === 'POST' && ['/v1/tokens', '/v1/api-keys'].includes(path) && s.account.journey) {
      await s.account.journey.tokenCreated({ tenant, ...(principal.via === 'console' ? { browser: s.account.journey.browser(request) } : {}) });
      ctx.waitUntil(s.account.journey.send());
    }
    return keys;
  }
  const billed = await billingRoutes(request, env, auth, s.billing);
  if (billed) return billed;
  const endUser = await endUserRoutes(request, tenant, new EndUserCredits(s.keys.accounts.db));
  if (endUser) return endUser;
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
  const setter = principal.tokenId ? `token:${principal.tokenId}` : principal.via === 'oauth' ? `oauth:${'grantId' in principal ? principal.grantId : undefined}` : principal.via;
  if (path === '/v1/usage' && request.method === 'GET') {
    const query = new URL(request.url).searchParams, days = Math.min(365, Math.max(1, Number(query.get('days') ?? 30) || 30));
    const workspace = query.get('workspaceId') ?? undefined;
    if (workspace && workspace !== 'unassigned') await new Workspaces(s.keys.accounts.db).get(tenant, workspace);
    return json(await s.keys.accounts.usage(tenant, Date.now() - days * 86400000, workspace));
  }
  if (path.startsWith('/v1/webhooks') || path.startsWith('/v1/usage-webhook')) {
    if (!s.keys.accounts.canStoreKeys) throw new HttpError(503, 'This runtime is not configured to store webhook secrets');
    const webhooks = s.webhooks;
    if (path === '/v1/webhooks') {
      if (request.method === 'GET') return json(await webhooks.list(tenant));
      if (request.method === 'POST') return json(await webhooks.create(tenant, await webhookInput(request), setter), 201);
    }
    const match = /^\/v1\/webhooks\/([^/]+)(\/(?:secret|rotate-secret))?$/.exec(path);
    if (match) {
      if (match[2] && request.method === 'POST') return json(await webhooks.rotate(tenant, match[1]));
      if (request.method === 'GET') return json(await webhooks.get(tenant, match[1]));
      if (request.method === 'PATCH') return json(await webhooks.update(tenant, match[1], await webhookInput(request), setter));
      if (request.method === 'DELETE') { await webhooks.delete(tenant, match[1]); return json({ deleted: true }); }
    }
    if (path === '/v1/usage-webhook') {
      if (request.method === 'GET') { const webhook = await webhooks.usageWebhook(tenant); if (!webhook) throw new HttpError(404, 'No usage webhook is set'); return json(webhook); }
      if (request.method === 'PUT') { const value = await webhookInput(request); if (Object.keys(value).some(key => key !== 'url')) throw new HttpError(400, 'Unknown usage webhook field'); return json(await webhooks.setUsageWebhook(tenant, value.url, setter)); }
      if (request.method === 'DELETE') { if (!await webhooks.deleteUsageWebhook(tenant)) throw new HttpError(404, 'No usage webhook is set'); return json({ deleted: true }); }
    }
    if (['/v1/usage-webhook/secret', '/v1/usage-webhook/rotate-secret'].includes(path) && request.method === 'POST') return json(await webhooks.rotateUsageWebhook(tenant));
  }
  if (path.startsWith('/v1/workspace')) {
    const spaces = new Workspaces(s.keys.accounts.db);
    if (path === '/v1/workspaces') {
      if (request.method === 'GET') return json(await spaces.list(tenant));
      if (request.method === 'POST') {
        const value = workspaceInput.safeParse(await request.json());
        if (!value.success) throw new HttpError(400, value.error.issues[0].message);
        return json(await spaces.create(tenant, value.data.name), 201);
      }
    }
    if (path === '/v1/workspace-memberships') return json(await spaces.memberships(tenant));
    const member = /^\/v1\/workspace-memberships\/(agent|definition)\/([^/]+)$/.exec(path);
    if (member && request.method === 'PUT') {
      const { workspaceId } = await request.json() as { workspaceId: string | null };
      await spaces.validate(tenant, workspaceId);
      const exists = await s.keys.accounts.db.query(`select 1 from ${member[1] === 'agent' ? 'agents' : 'definitions'} where tenant=$1 and id=$2`, [tenant, member[2]]);
      if (!exists.rowCount) throw new HttpError(404, 'Unknown resource');
      return json({ workspaceId: (await spaces.assign(tenant, member[1] as 'agent'|'definition', member[2], workspaceId)).workspace });
    }
    const workspace = /^\/v1\/workspaces\/([^/]+)(\/members)?$/.exec(path);
    if (workspace) {
      if (request.method === 'GET') return json(workspace[2] ? await spaces.members(tenant, workspace[1]) : await spaces.get(tenant, workspace[1]));
      if (request.method === 'PATCH') {
        const value = workspacePatch.safeParse(await request.json());
        if (!value.success) throw new HttpError(400, value.error.issues[0].message);
        return json(await spaces.update(tenant, workspace[1], value.data));
      }
    }
  }
}
async function webhookInput(request: Request): Promise<Record<string, unknown>> {
  const { readText } = await import('./account-http.ts');
  const text = await readText(request.body as AsyncIterable<Uint8Array> | null, 16 * 1024);
  try { const value = JSON.parse(text || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new HttpError(400, 'Invalid JSON body'); }
}
export async function sendMoneyWebhooks(env: MoneyEnv) { await (await services(env)).webhooks.send(); }
export async function moneyMaintenance(env: MoneyEnv) {
  const s = await services(env);
  await sweepAdmission(env);
  await expireMoneyIdempotency(env);
  await billingMaintenance(s.keys.accounts.billing);
  await (await modelAttempts(env)).reconcile();
  await new EndUserCredits(s.keys.accounts.db).expireDue();
  await s.webhooks.send();
  await pumpBillingMail(env, s.billing.alerts);
}

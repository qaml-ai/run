import { operationsMcp } from "./ops-api.ts";
import type { Context } from "hono";
import type { Accounts, Principal } from "./accounts.ts";
import { ConsoleAuth, personal } from "./account-console-auth.ts";
import { EmailAccounts } from "./account-email-accounts.ts";
import { Passwords, checkPassword, checkNewPassword, normalizeEmail } from "./account-passwords.ts";
import { OAuth } from "./account-oauth.ts";
import { publicOrigins, type PublicOrigins } from "./account-origins.ts";
import { RateLimits, RateLimited } from "./account-rate-limits.ts";
import { accountRateLimits } from "./account-rate-service.ts";
import { AccountMail, type MailEnv } from "./account-mail.ts";
import { HttpError, readText } from "./account-http.ts";
import type { Webhooks } from "./webhook-policy.ts";
import { RuntimeSigner } from "./runtime-identity.ts";
import { defaultModelFor, type DefaultModelEnv } from "./default-model.ts";
import { createJourney, publicJourneyRoutes, type JourneyEnv } from "./journey.ts";
import { flushJourney } from "./journey-delivery.ts";
import type { Journey } from "../../../src/core/journey.ts";
export { oauthAllows } from "./account-access.ts";

export type AccountEnv = MailEnv & JourneyEnv & {
  API_TOKEN: string;
  AGENT_PUBLIC_URL?: string;
  AGENT_BROWSER_URL?: string;
  AGENT_PUBLIC_ALIASES?: string;
  AGENT_ISSUER?: string;
  AGENT_SESSION_SECRET?: string;
  AGENT_OPEN_SIGNUP?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_ORG?: string;
  AGENT_SIGNUP_MIN_ACCOUNT_DAYS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  AGENT_BILLING_ADMINS?: string;
  AGENT_OPS_ADMINS?: string;
  TEST_GITHUB_WEB_URL?: string;
  TEST_GITHUB_API_URL?: string;
  TEST_GOOGLE_ISSUER?: string;
};
export interface AccountServices {
  environment: DefaultModelEnv;
  accounts: Accounts;
  auth: ConsoleAuth;
  oauth: OAuth;
  passwords: Passwords;
  mail?: AccountMail;
  limits: RateLimits;
  origin: string;
  origins: PublicOrigins;
  signer: RuntimeSigner;
  billingAdmins: ReadonlySet<string>;
  defaultModel: string;
  journey?: Journey;
}
const cache = new WeakMap<AccountEnv, Map<string, AccountServices>>();

/** Reuse the source state machines; only networking, mail, timers and database ownership differ. */
export function accountServices(env: AccountEnv, accounts: Accounts, fallbackOrigin: string): AccountServices {
  const origins = publicOrigins(env as unknown as NodeJS.ProcessEnv, fallbackOrigin);
  const origin = origins.canonical;
  const secret = env.AGENT_SESSION_SECRET || env.API_TOKEN;
  if (!secret || secret.length < 32) throw new Error("Set AGENT_SESSION_SECRET to at least 32 random characters");
  // The auth service lives with the isolate; tenant limits use this request's
  // accounts so an operator update is visible across API and agent DOs.
  const limits = accountRateLimits(env as AccountEnv & import("./postgres.ts").PostgresEnv & Record<string, unknown>, accounts, secret);
  const cached = cache.get(env)?.get(origin);
  if (cached) return cached;
  const openSignup = env.AGENT_OPEN_SIGNUP === "true";
  const minAccountDays = env.AGENT_SIGNUP_MIN_ACCOUNT_DAYS === undefined ? undefined : Number(env.AGENT_SIGNUP_MIN_ACCOUNT_DAYS);
  if (minAccountDays !== undefined && (!Number.isFinite(minAccountDays) || minAccountDays < 0 || !Number.isSafeInteger(Math.round(minAccountDays * 86_400_000))))
    throw new Error("AGENT_SIGNUP_MIN_ACCOUNT_DAYS must be a non-negative, safely representable number of days");
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && accounts.billing.pricing.startingGrant > 0 && minAccountDays === undefined)
    throw new Error("Configure AGENT_SIGNUP_MIN_ACCOUNT_DAYS before enabling GitHub starting credit");
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && !openSignup)
    throw new Error("Google sign-in lets anyone sign up; set AGENT_OPEN_SIGNUP=true to enable it, or remove its client");
  const passwords = new Passwords(accounts.db);
  const mail = (env.EMAIL || (env.TEST_MODE === "1" && env.MAIL_TEST_URL)) && (env.AGENT_ACCOUNT_EMAIL_FROM || env.EMAIL_FROM)
    ? new AccountMail(env, origin) : undefined;
  const client = (c: Context) => limits.client(name => c.req.header(name), undefined).key;
  const test = env.TEST_MODE === "1";
  const journey = createJourney(env, accounts, origin);
  const auth = new ConsoleAuth({
    accounts, publicUrl: origin, passwords, journey,
    ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { github: {
      clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, org: env.GITHUB_ORG ?? "qaml-ai",
      open: openSignup, minAccountDays,
      ...(test ? { webUrl: env.TEST_GITHUB_WEB_URL, apiUrl: env.TEST_GITHUB_API_URL } : {}),
    } } : {}),
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: {
      clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
      ...(test ? { issuer: env.TEST_GOOGLE_ISSUER } : {}),
    } } : {}),
    email: mail && new EmailAccounts({ accounts, mail, openSignup }),
    emailLimit: (c, email) => limits.emailRequest(client(c), email),
    admitSignup: c => sql => limits.signup(sql, client(c)),
    passwordLimits: { allowed: (c, email) => limits.passwordAllowed(client(c), email), failed: (c, email) => limits.passwordFailed(client(c), email) },
  });
  const oauth = new OAuth({ db: accounts.db, accounts, consoleAuth: auth, secret,
    origins, github: !!auth.options.github, google: !!auth.options.google,
    opsAdmins: new Set((env.AGENT_OPS_ADMINS ?? "").split(",").filter(Boolean)),
  });
  // Hono's default error handler would print the upstream error. Only known public errors leave this boundary.
  for (const app of [auth.app, oauth.app]) app.onError((error, c) => {
    if (error instanceof RateLimited) c.header("Retry-After", String(error.retryAfter));
    if (error instanceof HttpError) return c.json({ error: error.message, code: error.code, ...(error instanceof RateLimited ? { limit: error.limit } : {}) }, error.status as 400);
    return c.json({ error: "Account operation failed", code: "BACKEND_ERROR" }, 500);
  });
  const signer = new RuntimeSigner({ db: accounts.db, accounts, issuer: origins.issuer });
  const result = { environment: env as unknown as DefaultModelEnv, accounts, auth, oauth, passwords, mail, limits, origin, origins, signer, journey,
    defaultModel: (env as AccountEnv & { MODEL?: string }).MODEL ?? "",
    billingAdmins: new Set((env.AGENT_BILLING_ADMINS ?? "").split(",").filter(Boolean)) };
  const originsCache = cache.get(env) ?? new Map();
  originsCache.set(origin, result);
  cache.set(env, originsCache);
  return result;
}

export async function publicAccountRoutes(request: Request, service: AccountServices, ctx?: Pick<ExecutionContext, "waitUntil">): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname;
  if (path === "/v1/ops/mcp") return operationsMcp(request, service);
  if (["GET", "HEAD"].includes(request.method) && /^\/(?:$|console(?:\/|$)|oauth\/authorize$)/.test(path) && service.origins.alias(request.headers)) {
    return Response.redirect(`${service.origins.canonical}${path}${url.search}`, 302);
  }
  const page = await publicJourneyRoutes(request, service.environment as unknown as AccountEnv, service.journey, service.auth);
  if (page) {
    if (service.journey) ctx?.waitUntil(flushJourney(service.journey));
    return page;
  }
  if (path === "/.well-known/jwks.json" && request.method === "GET") {
    return Response.json(await service.signer.jwks(), { headers: { "Cache-Control": "public, max-age=300" } });
  }
  if (path === "/.well-known/oauth-authorization-server" && request.method === "GET") {
    return Response.json({ issuer: service.oauth.issuer, jwks_uri: `${service.oauth.issuer}/.well-known/jwks.json`, ...service.oauth.metadata() },
      { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
  }
  const app = path.startsWith("/console/auth/") ? service.auth.app
    : path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-") ? service.oauth.app : undefined;
  if (!app) return null;
  await service.limits.request(path, service.limits.client(name => request.headers.get(name) ?? undefined, undefined).key);
  try { return await app.fetch(request); }
  finally {
    if (service.mail) ctx?.waitUntil(service.mail.stop());
    if (service.journey) ctx?.waitUntil(flushJourney(service.journey));
  }
}

export async function accountPrincipal(request: Request, service: AccountServices) {
  const oauth = await service.oauth.authenticate(request.headers.get("Authorization") ?? undefined);
  if (oauth) return oauth;
  const principal = await service.auth.principal(request);
  if (principal && !["GET", "HEAD", "OPTIONS"].includes(request.method) && !service.auth.allowsMutation(request)) throw new HttpError(403, "Forbidden");
  return principal;
}

/** Account-management HTTP projection; policy and mutations remain in the source services. */
export async function accountManagementRoutes(request: Request, service: AccountServices, principal: Principal, webhooks?: Pick<Webhooks, "setBy">): Promise<Response | null> {
  const path = new URL(request.url).pathname, tenant = principal.tenant;
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  const body = async () => {
    const text = await readText(request.body, 4096);
    try { return JSON.parse(text || "{}"); }
    catch { throw new HttpError(400, "Invalid JSON"); }
  };
  const googleEmail = async () => (await service.accounts.db.query("select google_email from tenants where id=$1", [tenant])).rows[0]?.google_email as string | undefined;
  if (path === "/v1/me" && request.method === "GET") {
    const person = principal as Principal & { login?: string; name?: string; signIn?: string };
    const login = "login" in person ? person.login : await service.accounts.identity(tenant);
    return reply({ tenant, via: principal.via, ...(login ? { login } : {}), ...(person.name ? { name: person.name } : {}),
      ...(person.signIn ? { signIn: person.signIn } : {}), canStoreKeys: service.accounts.canStoreKeys, defaultModel: await defaultModelFor(service.environment, tenant) });
  }
  if (path === "/v1/sessions" && request.method === "DELETE") return reply({ signedOut: await service.auth.endSessions(tenant) });
  if (path === "/v1/oauth/grants" && request.method === "GET") return reply(await service.oauth.grants(tenant));
  const grant = /^\/v1\/oauth\/grants\/([^/]+)$/.exec(path);
  if (grant && request.method === "DELETE") {
    const id = decodeURIComponent(grant[1]);
    if (!await service.oauth.revoke(tenant, id)) throw new HttpError(404, "Unknown grant");
    return reply({ revoked: true, left: webhooks && service.accounts.canStoreKeys ? await webhooks.setBy(tenant, `oauth:${id}`) : [] });
  }
  if (path === "/v1/account/password") {
    if (request.method === "GET") {
      const email = await service.passwords.email(tenant) ?? null;
      return reply({ email, googleEmail: await googleEmail() ?? null, canAdd: !email && !!service.auth.options.email });
    }
    if (!personal(principal)) throw new HttpError(403, "A password is changed from the console, signed in");
    const input = await body();
    if (request.method === "PUT") {
      if (typeof input.currentPassword !== "string") throw new HttpError(400, "currentPassword is required");
      return reply({ changed: true, signedOut: await service.passwords.change(tenant, input.currentPassword, checkNewPassword(input.newPassword, await service.passwords.email(tenant)), principal.session) });
    }
    if (request.method === "POST") {
      if (!service.auth.options.email) throw new HttpError(404, "Adding a password needs account email, which this runtime does not have");
      const address = normalizeEmail(input.email);
      if (!address) throw new HttpError(400, "Enter a valid email address");
      checkNewPassword(input.password, address);
      await service.limits.emailRequest(service.limits.client(name => request.headers.get(name) ?? undefined, undefined).key, address);
      const added = await service.auth.options.email.add(tenant, address, input.password, await googleEmail());
      return reply(added, "set" in added ? 200 : 202);
    }
  }
  const target = /^\/v1\/tenants\/([^/]+)\/password$/.exec(path);
  if (target) {
    const id = decodeURIComponent(target[1]);
    if (principal.via !== "operator" || (principal.tenant !== id && !service.billingAdmins.has(principal.tenant))) throw new HttpError(403, "Only the platform operator, or this tenant's operator token, sets its password");
    if (request.method === "PUT") {
      const input = await body(), email = normalizeEmail(input.email);
      if (!email) throw new HttpError(400, "email is not an email address");
      if (!await service.accounts.exists(id)) throw new HttpError(404, `Unknown tenant ${id}`);
      return reply({ tenant: id, email, signedOut: await service.passwords.set(id, email, checkPassword(input.password)) });
    }
    if (request.method === "DELETE") return reply({ tenant: id, email: null, signedOut: (await service.passwords.clear(id)).signedOut });
  }
  return null;
}

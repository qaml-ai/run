import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import type { Accounts, Principal } from "./accounts.ts";
import { readText } from "./http.ts";
import type { Sql } from "./db.ts";
import type { Journey, JourneyMethod } from "./journey.ts";
import { checkNewPassword, MAX_PASSWORD, normalizeEmail, type Passwords } from "./passwords.ts";
import { LINK_GONE, type EmailAccounts } from "./email-accounts.ts";

/**
 * Console sign-in. Sessions live in Postgres (`console_sessions`); the cookie (HttpOnly, Secure, SameSite=Lax)
 * carries only a random id, so signing out ends a session for good. Browsers may only mutate state with the
 * console's custom header, which a cross-site page cannot send without a CORS preflight this server never
 * grants, and from our origin, which the browser names in Origin or Sec-Fetch-Site.
 */
export interface ConsoleAuthOptions {
  accounts: Accounts;
  /** Public origin, e.g. https://run.camelai.com. Cookies are Secure when it is https. */
  publicUrl: string;
  /**
   * GitHub sign-in: for members of `org`, or with `open`, for anyone with a GitHub
   * account. New tenants' starting credit needs an account at least `minAccountDays` old.
   */
  github?: { clientId: string; clientSecret: string; org: string; open?: boolean; minAccountDays?: number; webUrl?: string; apiUrl?: string };
  /**
   * Google sign-in (OpenID Connect, with PKCE and a nonce), for anyone with a verified Google address.
   * `issuer` is Google's unless a test points it elsewhere; its endpoints come from its discovery document.
   */
  google?: { clientId: string; clientSecret: string; issuer?: string };
  sessionHours?: number;
  /** What a sign-in that makes a new account must pass, in the transaction that makes it: the sign-up rate limit for the request's source. */
  admitSignup?: (c: Context) => ((sql: Sql) => Promise<void>) | undefined;
  /** Email and password sign-in (src/passwords.ts). */
  passwords: Passwords;
  /** Sign-up, password reset and adding a password by email, where account mail is configured (src/email-accounts.ts). */
  email?: EmailAccounts;
  /** Requests that mail a link, counted per source and per address: RateLimited past either. */
  emailLimit?: (c: Context, email: string) => Promise<void>;
  /** Journey events (src/journey.ts), where the operator configured them: a sign-in tells of the account it made, or of the sign-in. */
  journey?: Journey;
  /** Failed password sign-ins per source and per address: `allowed` refuses (RateLimited) once either has failed too often, `failed` counts one. */
  passwordLimits?: { allowed(c: Context, email: string): Promise<void>; failed(c: Context, email: string): Promise<void> };
}
/** How a console session was signed in. */
export type SignIn = "github" | "google" | "password";
export type ConsolePrincipal = Principal & { via: "console"; signIn: SignIn; login?: string; name?: string; session: string };
/** A person signed in to the console, who may mint API tokens, delete the account, bill and ask for help; a token may not. */
export const personal = (principal: { via: string }): principal is ConsolePrincipal => principal.via === "console";
/** What every failed password sign-in says, whether the address is unknown or the password wrong. */
export const WRONG_PASSWORD = "Wrong email or password";
export const GOOGLE_ISSUER = "https://accounts.google.com";
export const CONSOLE_HEADER = "x-agent-runtime-console";
const SESSION_COOKIE = "ar_session";
const STATE_COOKIE = "ar_oauth_state";
/** Where GitHub or Google sign-in returns to when it was started from the MCP consent page (src/oauth.ts). */
const NEXT_COOKIE = "ar_next";
/** Google sign-in's state, nonce and PKCE verifier, between the redirect and the callback. */
const GOOGLE_COOKIE = "ar_google";
const nextPath = (value: string | undefined) => {
  if (!value) return undefined;
  if (/^\/oauth\/authorize\?[^\s]*$/.test(value)) return value;
  // Adding Camel to Discord (its Install Link) resumes after sign-in; never arbitrary redirects.
  if (/^\/console\/discord\/install(\?guild_id=\d{1,20})?$/.test(value)) return value;
  // A use-case start the console opens after sign-in (a landing page's deep link): two fixed values.
  if (/^\/console\/\?start=(discord|code)$/.test(value)) return value;
  return undefined;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** An issuer's OpenID configuration, read at each sign-in. */
async function discover(issuer: string) {
  const response = await fetch(new URL("/.well-known/openid-configuration", issuer), { signal: AbortSignal.timeout(10_000) });
  const config = response.ok ? await response.json() as { issuer?: string; authorization_endpoint?: string; token_endpoint?: string; jwks_uri?: string } : {};
  if (config.issuer !== issuer || !config.authorization_endpoint || !config.token_endpoint || !config.jwks_uri) throw new Error("Google sign-in is unavailable; try again");
  return config as Required<typeof config>;
}
function cookies(req: Request) {
  const result: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

export class ConsoleAuth {
  readonly options: ConsoleAuthOptions;
  constructor(options: ConsoleAuthOptions) { this.options = options; }

  private get secure() { return this.options.publicUrl.startsWith("https://"); }
  private get db() { return this.options.accounts.db; }
  private swept = 0;
  private cookie(name: string, value: string, maxAgeSeconds: number, path = "/") {
    return `${name}=${value}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${this.secure ? "; Secure" : ""}`;
  }

  /** The signed-in principal from the session cookie: its row, while unexpired, for a tenant that exists. `session` is the row's key. */
  async principal(req: Request): Promise<ConsolePrincipal | undefined> {
    const raw = cookies(req)[SESSION_COOKIE];
    if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return undefined;
    const session = sha256(raw);
    const row = (await this.db.query("select tenant, login, name, method from console_sessions where sha256 = $1 and expires_at > $2 and method <> 'token'", [session, Date.now()])).rows[0];
    if (!row || !await this.options.accounts.exists(row.tenant)) return undefined;
    return { tenant: row.tenant, via: "console", signIn: row.method, session, ...(row.login ? { login: row.login } : {}), ...(row.name ? { name: row.name } : {}) };
  }

  /**
   * Browser requests that change state must carry the console header and come from our origin: the Origin header
   * names it, or, where a browser leaves Origin out, Sec-Fetch-Site says same-origin. A request with neither (curl
   * with a stolen cookie) is refused.
   */
  allowsMutation(req: Request) {
    return req.headers.get(CONSOLE_HEADER) === "1" && this.sameOrigin(req);
  }

  /** Whether a browser says `req` comes from a page of ours. */
  sameOrigin(req: Request) {
    const origin = req.headers.get("origin");
    if (origin === null) return req.headers.get("sec-fetch-site") === "same-origin";
    if (origin === new URL(this.options.publicUrl).origin) return true;
    // Same-origin also means the Origin names the host this request was sent to.
    try { return new URL(origin).host === req.headers.get("host"); } catch { return false; }
  }

  /** A session cookie for `tenant` after GitHub or Google sign-in. */
  session(tenant: string, signIn: Exclude<SignIn, "password">, login?: string, name?: string) { return this.startSession({ tenant, method: signIn, login, name }); }

  /**
   * Sign in with an email address and password: a session cookie for the tenant they are for, or WRONG_PASSWORD, the
   * same, and as slow, for an unknown address as for a wrong password. Past the failures allowed (`passwordLimits`),
   * a RateLimited error, before the password is checked.
   */
  async passwordSession(c: Context, email: unknown, password: unknown): Promise<{ tenant: string; cookie: string } | { error: string }> {
    const address = normalizeEmail(email);
    if (!address || typeof password !== "string" || !password || password.length > MAX_PASSWORD) return { error: WRONG_PASSWORD };
    await this.options.passwordLimits?.allowed(c, address);
    const tenant = await this.options.passwords.verify(address, password);
    if (!tenant || !await this.options.accounts.exists(tenant)) {
      await this.options.passwordLimits?.failed(c, address);
      return { error: WRONG_PASSWORD };
    }
    return { tenant, cookie: await this.startSession({ tenant, method: "password", login: address }) };
  }

  /** `login` (Google or sign-in address, or GitHub login) and `name` show who is signed in; the tenant id is only for the API. */
  async startSession(session: { tenant: string; method: SignIn; login?: string; name?: string }) {
    const hours = this.options.sessionHours ?? 12;
    const id = randomBytes(32).toString("base64url"), now = Date.now();
    await this.db.query("insert into console_sessions (sha256, tenant, login, name, method, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7)",
      [sha256(id), session.tenant, session.login ?? null, session.name?.slice(0, 100) ?? null, session.method, now, now + hours * 3600_000]);
    // Expired sessions go now and then.
    if (now - this.swept > 60_000) {
      this.swept = now;
      await this.db.query("delete from console_sessions where expires_at < $1", [now]).catch(() => {});
    }
    return this.cookie(SESSION_COOKIE, id, hours * 3600);
  }

  /** End the session `req` carries, if any. Returns the tenant whose it was. */
  async endSession(req: Request): Promise<string | undefined> {
    const raw = cookies(req)[SESSION_COOKIE];
    return raw ? (await this.db.query("delete from console_sessions where sha256 = $1 returning tenant", [sha256(raw)])).rows[0]?.tenant : undefined;
  }

  /** Sign `tenant` out everywhere: every console session of it ends. Returns how many did. */
  async endSessions(tenant: string) {
    return (await this.db.query("delete from console_sessions where tenant = $1", [tenant])).rowCount ?? 0;
  }

  /**
   * What a sign-in tells the journey store, when there is one: `created` goes to `tenantFor*`, which calls it in the
   * transaction that makes a new account; `signedIn` is for after it, and says so only if no account was made.
   */
  private journeySignIn(c: Context, method: JourneyMethod, next: string | undefined, email?: string) {
    const journey = this.options.journey;
    if (!journey) return { started: async () => {}, signedIn: async (_tenant: string) => {} };
    const browser = journey.browser(c.req.raw), surface = next?.startsWith("/oauth/authorize") ? "mcp" as const : "console" as const;
    let made = false;
    return {
      started: () => journey.authStarted({ method, surface, browser }),
      created: async (sql: Sql, tenant: string) => { made = true; await journey.accountCreated(sql, { tenant, method, surface, browser, email }); },
      signedIn: async (tenant: string) => { if (!made) await journey.signedIn({ tenant, method, surface, browser, email }); },
    };
  }

  /** The /console/auth/* routes. */
  readonly app = this.routes();

  private routes() {
    const app = new Hono();
    const withCookies = (c: Context, setCookies: string[]) => { for (const cookie of setCookies) c.header("Set-Cookie", cookie, { append: true }); return c; };
    const redirect = (c: Context, location: string, setCookies: string[] = []) => withCookies(c, setCookies).redirect(location, 302);
    const json = (c: Context, status: 200 | 400 | 401 | 403 | 404, value: unknown, setCookies: string[] = []) => withCookies(c, setCookies).json(value, status);
    const fail = (c: Context, message: string, setCookies: string[] = []) => redirect(c, `/console/?error=${encodeURIComponent(message)}`, setCookies);
    app.use("/console/auth/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

    app.get("/console/auth/methods", c => {
      const github = this.options.github;
      // Any runtime takes a password, beside GitHub and Google where they are configured. Sign-up and reset by email only
      // where account mail is configured (sign-up, also only with open sign-up), and otherwise go unmentioned.
      const email = this.options.email;
      return json(c, 200, { github: !!github, google: !!this.options.google, password: true, ...(github?.open ? { open: true } : { org: github?.org }),
        ...(email?.signup ? { signup: true } : {}), ...(email ? { reset: true } : {}) });
    });
    app.get("/console/auth/github", async c => {
      const github = this.options.github;
      if (!github) return fail(c, "GitHub sign-in is not configured");
      const state = randomBytes(24).toString("base64url");
      const authorize = new URL("/login/oauth/authorize", github.webUrl ?? "https://github.com");
      authorize.searchParams.set("client_id", github.clientId);
      authorize.searchParams.set("redirect_uri", new URL("/console/auth/callback", this.options.publicUrl).href);
      // Open sign-up reads only the public profile; org mode needs to see memberships.
      if (!github.open) authorize.searchParams.set("scope", "read:org");
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("allow_signup", github.open ? "true" : "false");
      const next = nextPath(c.req.query("next"));
      await this.journeySignIn(c, "github", next).started();
      return redirect(c, authorize.href, [this.cookie(STATE_COOKIE, state, 600, "/console/auth"), ...(next ? [this.cookie(NEXT_COOKIE, encodeURIComponent(next), 600, "/console/auth")] : [])]);
    });
    app.get("/console/auth/callback", async c => {
      const github = this.options.github;
      const state = c.req.query("state");
      const code = c.req.query("code");
      const expected = cookies(c.req.raw)[STATE_COOKIE];
      const clearState = this.cookie(STATE_COOKIE, "", 0, "/console/auth");
      const next = nextPath(decodeURIComponent(cookies(c.req.raw)[NEXT_COOKIE] ?? ""));
      const clearNext = this.cookie(NEXT_COOKIE, "", 0, "/console/auth");
      if (!github || !state || !code || !expected || state.length !== expected.length || !timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
        return fail(c, "Sign-in expired or was tampered with; try again", [clearState, clearNext]);
      }
      try {
        const exchange = await fetch(new URL("/login/oauth/access_token", github.webUrl ?? "https://github.com"), {
          method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: github.clientId, client_secret: github.clientSecret, code, redirect_uri: new URL("/console/auth/callback", this.options.publicUrl).href }),
          signal: AbortSignal.timeout(10_000),
        });
        const { access_token: accessToken } = await exchange.json() as { access_token?: string };
        if (!accessToken) throw new Error("GitHub did not issue a token");
        const api = github.apiUrl ?? "https://api.github.com";
        const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "camelai-agent-runtime" };
        type Profile = { login?: string; id?: number; name?: string | null; created_at?: string };
        let user: Profile | undefined;
        // Retry an incomplete profile before making a permanent signup decision.
        // An existing account may still sign in if only the creation time is unavailable.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await fetch(`${api}/user`, { headers, signal: AbortSignal.timeout(10_000) });
            if (!response.ok) continue;
            const profile = await response.json() as Profile;
            if (!profile.login || !Number.isSafeInteger(profile.id) || profile.id! <= 0) continue;
            user = profile;
            const created = Date.parse(profile.created_at ?? "");
            if (Number.isSafeInteger(created) && created >= 0 && created <= Date.now()) break;
          } catch { /* A second lookup can recover; no tenant has been created. */ }
        }
        if (!user?.login || !user.id) throw new Error("GitHub account details are unavailable; try signing in again");
        if (!github.open) {
          const membership = await fetch(`${api}/user/memberships/orgs/${encodeURIComponent(github.org)}`, { headers, signal: AbortSignal.timeout(10_000) });
          const member = membership.ok && (await membership.json() as { state?: string }).state === "active";
          if (!member) throw new Error(`Only members of the ${github.org} GitHub organization can sign in`);
        }
        const createdAt = user.created_at ? Date.parse(user.created_at) : NaN;
        const journey = this.journeySignIn(c, "github", next);
        const tenant = await this.options.accounts.tenantForGithub(
          { login: user.login, id: user.id, ...(Number.isFinite(createdAt) ? { createdAt } : {}) },
          { minAccountAgeMs: github.minAccountDays === undefined ? undefined : Math.round(github.minAccountDays * 86_400_000), admit: this.options.admitSignup?.(c), created: journey.created });
        await journey.signedIn(tenant);
        return redirect(c, next ?? "/console/", [clearState, clearNext, await this.session(tenant, "github", user.login, user.name ?? undefined)]);
      } catch (error) {
        return fail(c, (error as Error).message, [clearState, clearNext]);
      }
    });
    app.get("/console/auth/google", async c => {
      const google = this.options.google;
      if (!google) return fail(c, "Google sign-in is not configured");
      try {
        const { authorization_endpoint: endpoint } = await discover(google.issuer ?? GOOGLE_ISSUER);
        const [state, nonce, verifier] = [24, 24, 32].map(size => randomBytes(size).toString("base64url"));
        const authorize = new URL(endpoint);
        for (const [key, value] of Object.entries({
          client_id: google.clientId, redirect_uri: new URL("/console/auth/google/callback", this.options.publicUrl).href, response_type: "code",
          scope: "openid email profile", state, nonce, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: "select_account",
        })) authorize.searchParams.set(key, value);
        const next = nextPath(c.req.query("next"));
        await this.journeySignIn(c, "google", next).started();
        return redirect(c, authorize.href, [this.cookie(GOOGLE_COOKIE, `${state}.${nonce}.${verifier}`, 600, "/console/auth"), ...(next ? [this.cookie(NEXT_COOKIE, encodeURIComponent(next), 600, "/console/auth")] : [])]);
      } catch (error) {
        return fail(c, (error as Error).message);
      }
    });
    app.get("/console/auth/google/callback", async c => {
      const google = this.options.google;
      const [expected, nonce, verifier] = (cookies(c.req.raw)[GOOGLE_COOKIE] ?? "").split(".");
      const state = c.req.query("state"), code = c.req.query("code");
      const clear = [this.cookie(GOOGLE_COOKIE, "", 0, "/console/auth"), this.cookie(NEXT_COOKIE, "", 0, "/console/auth")];
      const next = nextPath(decodeURIComponent(cookies(c.req.raw)[NEXT_COOKIE] ?? ""));
      if (!google || !state || !expected || !nonce || !verifier || !same(state, expected)) return fail(c, "Sign-in expired or was tampered with; try again", clear);
      if (!code) return fail(c, "Google sign-in was cancelled", clear);
      try {
        const issuer = google.issuer ?? GOOGLE_ISSUER;
        const config = await discover(issuer);
        const exchange = await fetch(config.token_endpoint, {
          method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10_000),
          body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: google.clientId, client_secret: google.clientSecret, redirect_uri: new URL("/console/auth/google/callback", this.options.publicUrl).href }),
        });
        const { id_token: idToken } = await exchange.json().catch(() => ({})) as { id_token?: string };
        if (!exchange.ok || typeof idToken !== "string") throw new Error("Google did not complete sign-in; try again");
        const keys = await fetch(config.jwks_uri, { signal: AbortSignal.timeout(10_000) }).then(response => response.json()) as JSONWebKeySet;
        let claims;
        // Google's tokens name their issuer with or without the scheme; the signature, audience and expiry are checked here too.
        try { ({ payload: claims } = await jwtVerify(idToken, createLocalJWKSet(keys), { issuer: [issuer, issuer.replace(/^https:\/\//, "")], audience: google.clientId, algorithms: ["RS256"] })); }
        catch { throw new Error("Google's sign-in token did not verify; try again"); }
        if (typeof claims.nonce !== "string" || !same(claims.nonce, nonce) || (claims.azp !== undefined && claims.azp !== google.clientId)) throw new Error("Google's sign-in token did not verify; try again");
        if (claims.email_verified !== true || typeof claims.email !== "string" || typeof claims.sub !== "string") throw new Error("Sign in with a Google account whose email address is verified");
        const journey = this.journeySignIn(c, "google", next, claims.email);
        const tenant = await this.options.accounts.tenantForGoogle({ sub: claims.sub, email: claims.email }, { admit: this.options.admitSignup?.(c), created: journey.created });
        await journey.signedIn(tenant);
        return redirect(c, next ?? "/console/", [...clear, await this.session(tenant, "google", claims.email, typeof claims.name === "string" ? claims.name : undefined)]);
      } catch (error) {
        return fail(c, (error as Error).message, clear);
      }
    });
    // Email and password, for accounts an operator gave a password (no sign-up). A session it makes is a person's, as GitHub's and Google's are.
    app.post("/console/auth/password", async c => {
      if (!this.allowsMutation(c.req.raw)) return json(c, 403, { error: "Forbidden" });
      let body: { email?: unknown; password?: unknown; next?: unknown };
      try { body = JSON.parse(await readText(c.req.raw.body, 4096)); }
      catch { return json(c, 400, { error: "Send {\"email\": \"...\", \"password\": \"...\"}" }); }
      const next = typeof body?.next === "string" ? nextPath(body.next) : undefined;
      const journey = this.journeySignIn(c, "password", next, normalizeEmail(body?.email) ?? undefined);
      await journey.started();
      const session = await this.passwordSession(c, body?.email, body?.password);
      if ("error" in session) return json(c, 401, { error: session.error });
      await journey.signedIn(session.tenant);
      return json(c, 200, { tenant: session.tenant, ...(next ? { next } : {}) }, [session.cookie]);
    });
    // Sign-up, reset and adding a password by email (src/email-accounts.ts). Requests that mail a link answer the same
    // whether or not the address has an account.
    const body = async (c: Context) => {
      try { const value = JSON.parse(await readText(c.req.raw.body, 4096)); if (value && typeof value === "object") return value as Record<string, unknown>; }
      catch { /* answered below */ }
      return undefined;
    };
    const address = (value: unknown) => normalizeEmail(value);
    app.post("/console/auth/signup", async c => {
      if (!this.allowsMutation(c.req.raw)) return json(c, 403, { error: "Forbidden" });
      const email = this.options.email;
      if (!email?.signup) return json(c, 404, { error: "Sign-up is not open on this runtime" });
      const input = await body(c);
      const to = address(input?.email);
      if (!to) return json(c, 400, { error: "Enter a valid email address" });
      // A password refused costs nothing against the address's mails for the day.
      checkNewPassword(input!.password, to);
      await this.options.emailLimit?.(c, to);
      const next = typeof input!.next === "string" ? nextPath(input!.next) : undefined;
      await email.signUp(to, input!.password, next);
      await this.journeySignIn(c, "password", next, to).started();
      return c.json({ sent: true }, 202);
    });
    app.post("/console/auth/link", async c => {
      if (!this.allowsMutation(c.req.raw)) return json(c, 403, { error: "Forbidden" });
      const link = await this.options.email?.inspect((await body(c))?.token);
      return link ? json(c, 200, link) : json(c, 404, { error: LINK_GONE });
    });
    app.post("/console/auth/verify", async c => {
      if (!this.allowsMutation(c.req.raw)) return json(c, 403, { error: "Forbidden" });
      const email = this.options.email;
      if (!email) return json(c, 404, { error: LINK_GONE });
      const input = await body(c);
      const link = await email.inspect(input?.token);
      if (!link || link.purpose === "reset") return json(c, 400, { error: LINK_GONE });
      // Wrong passwords count as failed sign-ins for the address.
      await this.options.passwordLimits?.allowed(c, link.email);
      if (typeof input!.password === "string" && input!.password.length > MAX_PASSWORD) return json(c, 401, { error: "That is not the password you chose" });
      // The account is made here, in the browser that opened the mailed link: the journey's visitor is this one.
      const journey = this.journeySignIn(c, "password", undefined, link.email);
      const done = await email.complete(input!.token, input!.password, this.options.admitSignup?.(c), journey.created);
      if ("wrong" in done) {
        await this.options.passwordLimits?.failed(c, done.email);
        return json(c, 401, { error: "That is not the password you chose" });
      }
      console.log(JSON.stringify({ type: link.purpose === "verify" ? "email_signup_verified" : "password_added", tenant: done.tenant }));
      const next = done.next && nextPath(done.next);
      return json(c, 200, { tenant: done.tenant, ...(next ? { next } : {}) }, [await this.startSession({ tenant: done.tenant, method: "password", login: done.email })]);
    });
    app.post("/console/auth/reset/request", async c => {
      if (!this.allowsMutation(c.req.raw)) return json(c, 403, { error: "Forbidden" });
      const email = this.options.email;
      if (!email) return json(c, 404, { error: "Password reset by email is not available on this runtime" });
      const input = await body(c);
      const to = address(input?.email);
      if (!to) return json(c, 400, { error: "Enter a valid email address" });
      await this.options.emailLimit?.(c, to);
      await email.requestReset(to, typeof input!.next === "string" ? nextPath(input!.next) : undefined);
      return c.json({ sent: true }, 202);
    });
    app.post("/console/auth/reset", async c => {
      if (!this.allowsMutation(c.req.raw)) return json(c, 403, { error: "Forbidden" });
      const email = this.options.email;
      if (!email) return json(c, 404, { error: LINK_GONE });
      const input = await body(c);
      const done = await email.reset(input?.token, input?.password);
      console.log(JSON.stringify({ type: "password_reset", tenant: done.tenant, signedOut: done.signedOut }));
      const next = done.next && nextPath(done.next);
      await this.journeySignIn(c, "password", next || undefined, done.email).signedIn(done.tenant);
      return json(c, 200, { tenant: done.tenant, signedOut: done.signedOut, ...(next ? { next } : {}) }, [await this.startSession({ tenant: done.tenant, method: "password", login: done.email })]);
    });
    app.post("/console/auth/logout", async c => {
      if (!this.allowsMutation(c.req.raw)) return json(c, 403, { error: "Forbidden" });
      const tenant = await this.endSession(c.req.raw);
      if (tenant && this.options.journey) await this.options.journey.signedOut({ tenant, browser: this.options.journey.browser(c.req.raw) });
      return json(c, 200, { signedOut: true }, [this.cookie(SESSION_COOKIE, "", 0)]);
    });
    app.all("/console/auth/*", c => json(c, 404, { error: "Unknown sign-in route" }));
    return app;
  }
}

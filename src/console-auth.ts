import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import type { Accounts, Principal } from "./accounts.ts";
import { readText } from "./http.ts";

/**
 * Console sign-in. Sessions are HMAC-signed cookies (HttpOnly, Secure, SameSite=Lax).
 * Browsers may only mutate state with the console's custom header, which a cross-site
 * page cannot send without a CORS preflight this server never grants.
 */
export interface ConsoleAuthOptions {
  accounts: Accounts;
  secret: string;
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
}
export const GOOGLE_ISSUER = "https://accounts.google.com";
export const CONSOLE_HEADER = "x-agent-runtime-console";
const SESSION_COOKIE = "ar_session";
const STATE_COOKIE = "ar_oauth_state";
/** Where GitHub or Google sign-in returns to when it was started from the MCP consent page (src/oauth.ts). */
const NEXT_COOKIE = "ar_next";
/** Google sign-in's state, nonce and PKCE verifier, between the redirect and the callback. */
const GOOGLE_COOKIE = "ar_google";
const nextPath = (value: string | undefined) => value && /^\/oauth\/authorize\?[^\s]*$/.test(value) ? value : undefined;

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");
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
  private sign(payload: string) { return createHmac("sha256", this.options.secret).update(`console-session:${payload}`).digest("base64url"); }
  private cookie(name: string, value: string, maxAgeSeconds: number, path = "/") {
    return `${name}=${value}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${this.secure ? "; Secure" : ""}`;
  }

  /** The signed-in principal from the session cookie, if valid and unexpired. */
  async principal(req: Request): Promise<(Principal & { login?: string; name?: string }) | undefined> {
    const raw = cookies(req)[SESSION_COOKIE];
    if (!raw) return undefined;
    const [payload, signature] = raw.split(".");
    if (!payload || !signature) return undefined;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    let session: { tenant: string; login?: string; name?: string; exp: number };
    try { session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return undefined; }
    if (typeof session.exp !== "number" || session.exp < Date.now() || !await this.options.accounts.exists(session.tenant)) return undefined;
    return { tenant: session.tenant, via: "console", ...(session.login ? { login: session.login } : {}), ...(session.name ? { name: session.name } : {}) };
  }

  /** Browser requests that change state must carry the console header and come from our origin. */
  allowsMutation(req: Request) {
    if (req.headers.get(CONSOLE_HEADER) !== "1") return false;
    const origin = req.headers.get("origin");
    if (origin === null || origin === new URL(this.options.publicUrl).origin) return true;
    // Same-origin also means the Origin names the host this request was sent to.
    try { return new URL(origin).host === req.headers.get("host"); } catch { return false; }
  }

  /** A session cookie for `tenant`, as sign-in sets it. */
  session(tenant: string, login?: string) { return this.startSession(tenant, login); }

  /** A session cookie after token sign-in, naming the person the tenant belongs to when that is known. */
  async tokenSession(tenant: string) { return this.startSession(tenant, await this.options.accounts.identity(tenant)); }

  /** `login` (Google address or GitHub login) and `name` show who is signed in; the tenant id is only for the API. */
  private startSession(tenant: string, login?: string, name?: string) {
    const hours = this.options.sessionHours ?? 12;
    const payload = b64(JSON.stringify({ tenant, ...(login ? { login } : {}), ...(name ? { name: name.slice(0, 100) } : {}), exp: Date.now() + hours * 3600_000 }));
    return this.cookie(SESSION_COOKIE, `${payload}.${this.sign(payload)}`, hours * 3600);
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
      return json(c, 200, { github: !!github, google: !!this.options.google, token: true, ...(github?.open ? { open: true } : { org: github?.org }) });
    });
    app.get("/console/auth/github", c => {
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
        const tenant = await this.options.accounts.tenantForGithub(
          { login: user.login, id: user.id, ...(Number.isFinite(createdAt) ? { createdAt } : {}) },
          { minAccountAgeMs: github.minAccountDays === undefined ? undefined : Math.round(github.minAccountDays * 86_400_000) });
        return redirect(c, next ?? "/console/", [clearState, clearNext, this.startSession(tenant, user.login, user.name ?? undefined)]);
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
        const tenant = await this.options.accounts.tenantForGoogle({ sub: claims.sub, email: claims.email });
        return redirect(c, next ?? "/console/", [...clear, this.startSession(tenant, claims.email, typeof claims.name === "string" ? claims.name : undefined)]);
      } catch (error) {
        return fail(c, (error as Error).message, clear);
      }
    });
    // Operator or API token sign-in, for tenants an admin created without GitHub or Google.
    app.post("/console/auth/token", async c => {
      if (!this.allowsMutation(c.req.raw)) return json(c, 403, { error: "Forbidden" });
      let token = "";
      try { token = JSON.parse(await readText(c.req.raw.body, 4096)).token; }
      catch { return json(c, 400, { error: "Send {\"token\": \"...\"}" }); }
      const principal = typeof token === "string" ? await this.options.accounts.authenticate(`Bearer ${token}`) : undefined;
      if (!principal) return json(c, 401, { error: "Unknown token" });
      return json(c, 200, { tenant: principal.tenant }, [await this.tokenSession(principal.tenant)]);
    });
    app.post("/console/auth/logout", c => {
      if (!this.allowsMutation(c.req.raw)) return json(c, 403, { error: "Forbidden" });
      return json(c, 200, { signedOut: true }, [this.cookie(SESSION_COOKIE, "", 0)]);
    });
    app.all("/console/auth/*", c => json(c, 404, { error: "Unknown sign-in route" }));
    return app;
  }
}

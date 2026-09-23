import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
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
  /** Public origin, e.g. https://agents.camelai.dev. Cookies are Secure when it is https. */
  publicUrl: string;
  github?: { clientId: string; clientSecret: string; org: string; webUrl?: string; apiUrl?: string };
  sessionHours?: number;
}
export const CONSOLE_HEADER = "x-agent-runtime-console";
const SESSION_COOKIE = "ar_session";
const STATE_COOKIE = "ar_oauth_state";

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");
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
  async principal(req: Request): Promise<(Principal & { login?: string }) | undefined> {
    const raw = cookies(req)[SESSION_COOKIE];
    if (!raw) return undefined;
    const [payload, signature] = raw.split(".");
    if (!payload || !signature) return undefined;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    let session: { tenant: string; login?: string; exp: number };
    try { session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return undefined; }
    if (typeof session.exp !== "number" || session.exp < Date.now() || !await this.options.accounts.exists(session.tenant)) return undefined;
    return { tenant: session.tenant, via: "console", ...(session.login ? { login: session.login } : {}) };
  }

  /** Browser requests that change state must carry the console header and come from our origin. */
  allowsMutation(req: Request) {
    if (req.headers.get(CONSOLE_HEADER) !== "1") return false;
    const origin = req.headers.get("origin");
    if (origin === null || origin === new URL(this.options.publicUrl).origin) return true;
    // Same-origin also means the Origin names the host this request was sent to.
    try { return new URL(origin).host === req.headers.get("host"); } catch { return false; }
  }

  private startSession(tenant: string, login?: string) {
    const hours = this.options.sessionHours ?? 12;
    const payload = b64(JSON.stringify({ tenant, ...(login ? { login } : {}), exp: Date.now() + hours * 3600_000 }));
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

    app.get("/console/auth/methods", c => json(c, 200, { github: !!this.options.github, token: true, org: this.options.github?.org }));
    app.get("/console/auth/github", c => {
      const github = this.options.github;
      if (!github) return fail(c, "GitHub sign-in is not configured");
      const state = randomBytes(24).toString("base64url");
      const authorize = new URL("/login/oauth/authorize", github.webUrl ?? "https://github.com");
      authorize.searchParams.set("client_id", github.clientId);
      authorize.searchParams.set("redirect_uri", new URL("/console/auth/callback", this.options.publicUrl).href);
      authorize.searchParams.set("scope", "read:org");
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("allow_signup", "false");
      return redirect(c, authorize.href, [this.cookie(STATE_COOKIE, state, 600, "/console/auth")]);
    });
    app.get("/console/auth/callback", async c => {
      const github = this.options.github;
      const state = c.req.query("state");
      const code = c.req.query("code");
      const expected = cookies(c.req.raw)[STATE_COOKIE];
      const clearState = this.cookie(STATE_COOKIE, "", 0, "/console/auth");
      if (!github || !state || !code || !expected || state.length !== expected.length || !timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
        return fail(c, "Sign-in expired or was tampered with; try again", [clearState]);
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
        const user = await (await fetch(`${api}/user`, { headers, signal: AbortSignal.timeout(10_000) })).json() as { login?: string };
        if (!user.login) throw new Error("GitHub did not return a user");
        const membership = await fetch(`${api}/user/memberships/orgs/${encodeURIComponent(github.org)}`, { headers, signal: AbortSignal.timeout(10_000) });
        const member = membership.ok && (await membership.json() as { state?: string }).state === "active";
        if (!member) throw new Error(`Only members of the ${github.org} GitHub organization can sign in`);
        const tenant = await this.options.accounts.tenantForGithub(user.login);
        return redirect(c, "/console/", [clearState, this.startSession(tenant, user.login)]);
      } catch (error) {
        return fail(c, (error as Error).message, [clearState]);
      }
    });
    // Operator or API token sign-in, for tenants an admin created without GitHub.
    app.post("/console/auth/token", async c => {
      if (!this.allowsMutation(c.req.raw)) return json(c, 403, { error: "Forbidden" });
      let token = "";
      try { token = JSON.parse(await readText(c.req.raw.body, 4096)).token; }
      catch { return json(c, 400, { error: "Send {\"token\": \"...\"}" }); }
      const principal = typeof token === "string" ? await this.options.accounts.authenticate(`Bearer ${token}`) : undefined;
      if (!principal) return json(c, 401, { error: "Unknown token" });
      return json(c, 200, { tenant: principal.tenant }, [this.startSession(principal.tenant)]);
    });
    app.post("/console/auth/logout", c => {
      if (!this.allowsMutation(c.req.raw)) return json(c, 403, { error: "Forbidden" });
      return json(c, 200, { signedOut: true }, [this.cookie(SESSION_COOKIE, "", 0)]);
    });
    app.all("/console/auth/*", c => json(c, 404, { error: "Unknown sign-in route" }));
    return app;
  }
}

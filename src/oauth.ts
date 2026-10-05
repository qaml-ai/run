import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type { Accounts, Principal } from "./accounts.ts";
import type { ConsoleAuth } from "./console-auth.ts";
import type { Db } from "./db.ts";
import { readText } from "./http.ts";
import type { PublicOrigins } from "./origins.ts";

/**
 * The runtime as an OAuth 2.1 authorization server for its hosted MCP endpoints (/mcp, and each agent's), as MCP's authorization spec
 * asks: protected-resource metadata (RFC 9728), dynamic client registration (RFC 7591), the authorization code
 * flow with PKCE (S256 only), refresh tokens that rotate (a reused one revokes its grant, but within REFRESH_GRACE_MS
 * of its rotation gets the same successor, so a client's retry or concurrent refresh is not taken for theft), and revocation (RFC
 * 7009). People sign in with the console's session and consent on a page of ours. Access tokens are opaque and act
 * for the tenant as an API token does, at /mcp and /v1, until they expire or the grant is revoked.
 *
 * Clients have no rows: a client_id is its registration, signed, and a confidential client's secret is an HMAC of
 * its id under the server's secret. So registration, which anyone may do, stores nothing. Each registration's id
 * carries a random nonce, so registering the same metadata again (which anyone can read from a public client_id)
 * makes another client, never one whose secret is someone else's.
 */
export interface OAuthOptions {
  db: Db;
  accounts: Accounts;
  consoleAuth: ConsoleAuth;
  /** Signs client ids and derives client secrets. */
  secret: string;
  /** The issuer; the public URL, where the endpoints and pages are; and the aliases, where MCP endpoints are too. */
  origins: PublicOrigins;
  /** Whether the console signs in with GitHub and with Google (the sign-in page also takes an API token, behind a disclosure). */
  github: boolean;
  google?: boolean;
}

export const SCOPE = "agents";
export const ACCESS_TOKEN_MS = 3600_000;
export const REFRESH_TOKEN_MS = 30 * 86_400_000;
/** How long after a refresh token is rotated presenting it again returns the same new tokens, instead of revoking the grant. */
export const REFRESH_GRACE_MS = 10_000;
const CODE_MS = 600_000;
const ACCESS = "aro_", REFRESH = "arr_", CODE = "arc_";
const CACHE_MS = 10_000;
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
type AuthMethod = typeof AUTH_METHODS[number];
interface Client { name: string; redirectUris: string[]; method: AuthMethod; nonce?: string }
export interface Grant { id: string; clientName: string; login: string | null; scope: string; createdAt: number; usedAt: number | null }
export type OAuthPrincipal = Principal & { via: "oauth"; grantId: string; login?: string };

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/**
 * A rotated refresh token's successor (the token response it was exchanged for), sealed with a key only that refresh
 * token derives: the row keeps its hash, so what is stored opens for no one but whoever presents the token again.
 */
const sealKey = (refreshToken: string) => createHash("sha256").update(`oauth-successor:${refreshToken}`).digest();
function seal(refreshToken: string, value: object) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", sealKey(refreshToken), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(part => part.toString("base64url")).join(".");
}
function unseal(refreshToken: string, sealed: string) {
  const [iv, tag, body] = sealed.split(".").map(part => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", sealKey(refreshToken), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
}
/** An agent's MCP endpoint (agent-mcp.ts), as a path. */
const AGENT_RESOURCE = /^\/v1\/agents\/client_[a-f0-9]{40}\/mcp\/?$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);

/** An OAuth error, answered as RFC 6749 says: JSON at the token endpoint, a redirect from the authorization endpoint. */
class OAuthError extends Error {
  readonly code: string; readonly status: 400 | 401;
  constructor(code: string, description: string, status: 400 | 401 = 400) { super(description); this.code = code; this.status = status; }
}

export class OAuth {
  private readonly options: OAuthOptions;
  private readonly cache = new Map<string, { principal: OAuthPrincipal; until: number }>();
  private swept = 0;
  constructor(options: OAuthOptions) { this.options = options; }

  get issuer() { return this.options.origins.issuer; }
  private get base() { return this.options.origins.canonical; }

  /** The authorization server's metadata (RFC 8414), merged into the runtime's /.well-known/oauth-authorization-server. */
  metadata() {
    return {
      authorization_endpoint: `${this.base}/oauth/authorize`, token_endpoint: `${this.base}/oauth/token`,
      registration_endpoint: `${this.base}/oauth/register`, revocation_endpoint: `${this.base}/oauth/revoke`,
      scopes_supported: [SCOPE], response_types_supported: ["code"], response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [...AUTH_METHODS], revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
      authorization_response_iss_parameter_supported: true,
    };
  }

  /**
   * An MCP endpoint's metadata (RFC 9728), the hosted one's or an agent's (agent-mcp.ts): where its tokens come from.
   * `resource` is the endpoint at the origin the client reached, which clients check; the issuer is the same at every one.
   */
  protectedResource(resource: string, documentation = "reference/cli.md") {
    return { resource, authorization_servers: [this.issuer], scopes_supported: [SCOPE], bearer_methods_supported: ["header"], resource_name: "camelRun", resource_documentation: `${this.base}/docs/${documentation}` };
  }

  /** The tenant an OAuth access token acts for, while it is unexpired and its grant stands. */
  async authenticate(authorization: string | undefined): Promise<OAuthPrincipal | undefined> {
    if (!authorization?.startsWith(`Bearer ${ACCESS}`)) return undefined;
    const hash = sha(authorization.slice(7));
    const cached = this.cache.get(hash);
    if (cached && cached.until > Date.now()) return cached.principal;
    const row = (await this.options.db.query(
      "select g.id, g.tenant, g.login, t.expires_at from oauth_tokens t join oauth_grants g on g.id = t.grant_id where t.sha256 = $1 and t.kind = 'access'", [hash])).rows[0];
    if (!row || Number(row.expires_at) <= Date.now() || !await this.options.accounts.exists(row.tenant)) return undefined;
    const principal: OAuthPrincipal = { tenant: row.tenant, via: "oauth", grantId: row.id, ...(row.login ? { login: row.login } : {}) };
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(hash, { principal, until: Math.min(Date.now() + CACHE_MS, Number(row.expires_at)) });
    return principal;
  }

  /** The clients a tenant has let act for it. */
  async grants(tenant: string): Promise<Grant[]> {
    const { rows } = await this.options.db.query("select id, client_name, login, scope, created_at, used_at from oauth_grants where tenant = $1 order by created_at desc", [tenant]);
    return rows.map(row => ({ id: row.id, clientName: row.client_name, login: row.login, scope: row.scope, createdAt: Number(row.created_at), usedAt: row.used_at === null ? null : Number(row.used_at) }));
  }

  /** Revoke a grant: its tokens stop working at once on this node, and within seconds on others. */
  async revoke(tenant: string, id: string) {
    const deleted = (await this.options.db.query("delete from oauth_grants where id = $1 and tenant = $2", [id, tenant])).rowCount! > 0;
    this.forget(id);
    return deleted;
  }

  private forget(grantId: string) { for (const [hash, entry] of this.cache) if (entry.principal.grantId === grantId) this.cache.delete(hash); }

  // Clients: the registration is the id.
  private sign(payload: string, purpose: string) { return createHmac("sha256", this.options.secret).update(`oauth-${purpose}:${payload}`).digest("base64url"); }
  private clientId(client: Client) {
    const payload = b64(JSON.stringify({ n: client.name, r: client.redirectUris, m: client.method, ...(client.nonce ? { i: client.nonce } : {}) }));
    return `mcp_${payload}.${this.sign(payload, "client").slice(0, 32)}`;
  }
  /** Clients registered before ids had a nonce keep their ids and secrets; no registration makes such an id again. */
  private clientSecret(clientId: string) { return this.sign(clientId, "client-secret"); }
  private client(clientId: string | undefined): Client | undefined {
    const [, payload, signature] = /^mcp_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{32})$/.exec(clientId ?? "") ?? [];
    if (!payload || !same(signature, this.sign(payload, "client").slice(0, 32))) return undefined;
    const { n, r, m, i } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return { name: n, redirectUris: r, method: m, ...(i ? { nonce: i } : {}) };
  }

  /** Register a client (RFC 7591): anyone may, and nothing is stored. */
  register(body: any) {
    if (!body || typeof body !== "object") throw new OAuthError("invalid_client_metadata", "Send the client's metadata as JSON");
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) throw new OAuthError("invalid_redirect_uri", "redirect_uris is a list of 1 to 10 URIs");
    for (const uri of uris) if (!validRedirect(uri)) throw new OAuthError("invalid_redirect_uri", `Not a redirect URI this server accepts: ${String(uri).slice(0, 200)} (https, http on a loopback address, or an app's own scheme; no fragment)`);
    const method: AuthMethod = body.token_endpoint_auth_method ?? "client_secret_basic";
    if (!AUTH_METHODS.includes(method)) throw new OAuthError("invalid_client_metadata", `token_endpoint_auth_method is one of ${AUTH_METHODS.join(", ")}`);
    const grantTypes: string[] = body.grant_types ?? ["authorization_code", "refresh_token"];
    if (!Array.isArray(grantTypes) || grantTypes.some(type => type !== "authorization_code" && type !== "refresh_token")) throw new OAuthError("invalid_client_metadata", "grant_types are authorization_code and refresh_token");
    if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.some((type: unknown) => type !== "code"))) throw new OAuthError("invalid_client_metadata", "response_types is [\"code\"]");
    const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : "An MCP client";
    const client: Client = { name, redirectUris: uris, method, nonce: randomBytes(12).toString("base64url") };
    const clientId = this.clientId(client);
    if (clientId.length > 6000) throw new OAuthError("invalid_client_metadata", "The registration is too large");
    return {
      client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
      grant_types: grantTypes, response_types: ["code"], token_endpoint_auth_method: method, scope: SCOPE,
      ...(method === "none" ? {} : { client_secret: this.clientSecret(clientId), client_secret_expires_at: 0 }),
    };
  }

  /** Check an authorization request. Errors before the redirect URI is known are shown, not redirected. */
  private authorization(params: URLSearchParams) {
    const client = this.client(params.get("client_id") ?? undefined);
    if (!client) throw new OAuthError("invalid_client", "This application is not registered here (unknown client_id). Try connecting it again.");
    const redirectUri = params.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : "");
    if (!client.redirectUris.some(registered => redirectMatches(registered, redirectUri))) throw new OAuthError("invalid_request", "The redirect URI is not one this application registered.");
    const request = { client, clientId: params.get("client_id")!, redirectUri, state: params.get("state") ?? undefined };
    const fail = (code: string, description: string) => Object.assign(new OAuthError(code, description), { redirect: request });
    if (params.get("response_type") !== "code") throw fail("unsupported_response_type", "response_type must be code");
    const challenge = params.get("code_challenge") ?? "";
    if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) throw fail("invalid_request", "PKCE is required: code_challenge with code_challenge_method S256");
    const resource = params.get("resource");
    // The hosted endpoint, or an agent's, at any origin the runtime answers at: a token acts for the tenant at each.
    const ours = (origin: string) => resource !== null && ([`${origin}/mcp`, `${origin}/mcp/`, origin, `${origin}/`].includes(resource)
      || (resource.startsWith(`${origin}/v1/agents/`) && AGENT_RESOURCE.test(resource.slice(origin.length))));
    if (resource !== null && !this.options.origins.all.some(ours)) throw fail("invalid_target", `The resource is ${this.base}/mcp`);
    if ((request.state?.length ?? 0) > 2000) throw fail("invalid_request", "state is too long");
    return { ...request, challenge };
  }

  private redirect(c: Context, to: { redirectUri: string; state?: string }, params: Record<string, string>) {
    const url = new URL(to.redirectUri);
    for (const [key, value] of Object.entries({ ...params, ...(to.state !== undefined ? { state: to.state } : {}), iss: this.issuer })) url.searchParams.set(key, value);
    return c.redirect(url.href, 302);
  }

  /** Consent given: a code for the client to exchange, carrying who consented. */
  private async code(tenant: string, login: string | undefined, request: ReturnType<OAuth["authorization"]>) {
    const code = `${CODE}${randomBytes(32).toString("base64url")}`;
    await this.options.db.query("insert into oauth_tokens (sha256, kind, expires_at, data) values ($1, 'code', $2, $3)", [sha(code), Date.now() + CODE_MS, JSON.stringify({
      tenant, login: login ?? null, clientId: request.clientId, clientName: request.client.name, redirectUri: request.redirectUri, challenge: request.challenge,
    })]);
    return code;
  }

  /** The client's credentials from HTTP Basic or the body, checked as it registered. */
  private authenticateClient(c: Context, form: URLSearchParams): { clientId: string; client: Client } {
    let clientId = form.get("client_id") ?? undefined, secret = form.get("client_secret") ?? undefined;
    const basic = /^Basic\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (basic) {
      const decoded = Buffer.from(basic, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon < 0) throw new OAuthError("invalid_client", "Malformed Basic credentials", 401);
      clientId = decodeURIComponent(decoded.slice(0, colon)); secret = decodeURIComponent(decoded.slice(colon + 1));
    }
    const client = this.client(clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
    if (client.method !== "none" && (!secret || !same(secret, this.clientSecret(clientId!)))) throw new OAuthError("invalid_client", "Wrong or missing client secret", 401);
    return { clientId: clientId!, client };
  }

  private async issue(grantId: string) {
    const now = Date.now();
    const access = `${ACCESS}${randomBytes(32).toString("base64url")}`, refresh = `${REFRESH}${randomBytes(32).toString("base64url")}`;
    await this.options.db.query("insert into oauth_tokens (sha256, kind, grant_id, expires_at) values ($1, 'access', $3, $4), ($2, 'refresh', $3, $5)",
      [sha(access), sha(refresh), grantId, now + ACCESS_TOKEN_MS, now + REFRESH_TOKEN_MS]);
    await this.options.db.query("update oauth_grants set used_at = $2 where id = $1", [grantId, now]);
    // Expired tokens go now and then; used refresh tokens stay until they expire, to catch their reuse.
    if (now - this.swept > 60_000) {
      this.swept = now;
      await this.options.db.query("delete from oauth_tokens where expires_at < $1", [now - 86_400_000]).catch(() => {});
    }
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_MS / 1000, refresh_token: refresh, scope: SCOPE };
  }

  private async exchange(c: Context, form: URLSearchParams) {
    const { clientId, client } = this.authenticateClient(c, form);
    switch (form.get("grant_type")) {
      case "authorization_code": {
        const code = form.get("code") ?? "";
        // Deleting it is what makes a code single-use.
        const row = (await this.options.db.query("delete from oauth_tokens where sha256 = $1 and kind = 'code' returning expires_at, data", [sha(code)])).rows[0];
        if (!row || Number(row.expires_at) <= Date.now()) throw new OAuthError("invalid_grant", "The code is unknown, used or expired");
        const data = row.data;
        if (data.clientId !== clientId) throw new OAuthError("invalid_grant", "The code was issued to another client");
        if ((form.get("redirect_uri") ?? data.redirectUri) !== data.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri differs from the authorization request's");
        const verifier = form.get("code_verifier") ?? "";
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !same(b64(createHash("sha256").update(verifier).digest()), data.challenge)) throw new OAuthError("invalid_grant", "The code_verifier does not match the code_challenge");
        if (!await this.options.accounts.exists(data.tenant)) throw new OAuthError("invalid_grant", "The account no longer exists");
        const grantId = `grt_${randomBytes(12).toString("hex")}`;
        await this.options.db.query("insert into oauth_grants (id, tenant, client_id, client_name, login, scope, created_at) values ($1, $2, $3, $4, $5, $6, $7)",
          [grantId, data.tenant, clientId, client.name, data.login, SCOPE, Date.now()]);
        return this.issue(grantId);
      }
      case "refresh_token": {
        const presented = form.get("refresh_token") ?? "", hash = sha(presented);
        const current = (await this.options.db.query(
          "select t.grant_id, t.expires_at, t.used_at, t.data, g.client_id from oauth_tokens t join oauth_grants g on g.id = t.grant_id where t.sha256 = $1 and t.kind = 'refresh'", [hash])).rows[0];
        if (!current) throw new OAuthError("invalid_grant", "The refresh token is unknown, used or revoked");
        if (current.client_id !== clientId) throw new OAuthError("invalid_grant", "The refresh token was issued to another client");
        if (Number(current.expires_at) <= Date.now()) throw new OAuthError("invalid_grant", "The refresh token expired; connect again");
        if (current.used_at === null) {
          // The successor is stored before the rotation is claimed, so a request that loses the claim finds it.
          const tokens = await this.issue(current.grant_id);
          const claimed = (await this.options.db.query("update oauth_tokens set used_at = $2, data = $3 where sha256 = $1 and used_at is null returning 1",
            [hash, Date.now(), { successor: seal(presented, tokens) }])).rowCount;
          if (claimed) return tokens;
          await this.options.db.query("delete from oauth_tokens where sha256 = any($1)", [[sha(tokens.access_token), sha(tokens.refresh_token)]]);
        }
        // Used already: within the grace, a retry or a concurrent refresh gets what the rotation issued.
        const used = (await this.options.db.query("select used_at, data from oauth_tokens where sha256 = $1", [hash])).rows[0];
        if (used?.data?.successor && Date.now() - Number(used.used_at) <= REFRESH_GRACE_MS) return unseal(presented, used.data.successor);
        // Past it, a used refresh token is a copy someone kept: end the grant it belongs to.
        await this.options.db.query("delete from oauth_grants where id = $1", [current.grant_id]);
        this.forget(current.grant_id);
        throw new OAuthError("invalid_grant", "The refresh token is unknown, used or revoked");
      }
      default: throw new OAuthError("unsupported_grant_type", "grant_type is authorization_code or refresh_token");
    }
  }

  /** The routes: metadata, registration, the consent page, the token and revocation endpoints. */
  readonly app = this.routes();

  private routes() {
    const app = new Hono();
    // Clients in browsers (an inspector, a web app) call these directly: they take no cookies.
    const open = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version", "Cache-Control": "no-store" };
    const publicPaths = ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/oauth/register", "/oauth/token", "/oauth/revoke"];
    for (const path of publicPaths) app.options(path, c => c.body(null, 204, { ...open, "Access-Control-Max-Age": "86400" }));
    const oauthError = (c: Context, error: unknown) => {
      if (!(error instanceof OAuthError)) throw error;
      return c.json({ error: error.code, error_description: error.message }, error.status, { ...open, ...(error.status === 401 ? { "WWW-Authenticate": "Basic realm=\"oauth\"" } : {}) });
    };
    const form = async (c: Context) => {
      const text = await readText(c.req.raw.body, 64 * 1024);
      if ((c.req.header("content-type") ?? "").includes("application/json")) {
        const body = text ? JSON.parse(text) : {};
        return new URLSearchParams(Object.entries(body).filter(([, value]) => typeof value === "string") as [string, string][]);
      }
      return new URLSearchParams(text);
    };

    const reached = (c: Context) => this.options.origins.of(c.req.raw.headers);
    for (const path of publicPaths.slice(0, 2)) app.get(path, c => c.json(this.protectedResource(`${reached(c)}/mcp`), 200, { ...open, "Cache-Control": "public, max-age=300" }));
    const agentMetadata = "/.well-known/oauth-protected-resource/v1/agents/:id{client_[a-f0-9]{40}}/mcp";
    app.options(agentMetadata, c => c.body(null, 204, { ...open, "Access-Control-Max-Age": "86400" }));
    app.get(agentMetadata, c => c.json(this.protectedResource(`${reached(c)}/v1/agents/${c.req.param("id")}/mcp`, "guides/mcp-server.md"), 200, { ...open, "Cache-Control": "public, max-age=300" }));

    app.post("/oauth/register", async c => {
      try {
        let body: unknown;
        try { body = JSON.parse(await readText(c.req.raw.body, 32 * 1024)); } catch { throw new OAuthError("invalid_client_metadata", "Send the client's metadata as JSON"); }
        return c.json(this.register(body), 201, open);
      } catch (error) { return oauthError(c, error); }
    });

    app.post("/oauth/token", async c => {
      try { return c.json(await this.exchange(c, await form(c)), 200, { ...open, Pragma: "no-cache" }); }
      catch (error) { return oauthError(c, error); }
    });

    // Revoking a token ends its grant, and every token of it (RFC 7009 answers 200 whatever the token was).
    app.post("/oauth/revoke", async c => {
      try {
        const params = await form(c);
        this.authenticateClient(c, params);
        const row = (await this.options.db.query("select grant_id from oauth_tokens where sha256 = $1 and kind in ('access', 'refresh')", [sha(params.get("token") ?? "")])).rows[0];
        if (row?.grant_id) { await this.options.db.query("delete from oauth_grants where id = $1", [row.grant_id]); this.forget(row.grant_id); }
        return c.body(null, 200, open);
      } catch (error) { return oauthError(c, error); }
    });

    // The consent page. It is never framed, and its form posts back here, same-origin, with the session's cookie.
    const page = (c: Context, status: 200 | 400 | 403, title: string, body: string) => c.html(PAGE(title, body), status, {
      "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", "Referrer-Policy": "same-origin",
    });
    const shown = (c: Context, error: unknown) => {
      if (!(error instanceof OAuthError)) throw error;
      const redirect = (error as OAuthError & { redirect?: { redirectUri: string; state?: string } }).redirect;
      if (redirect) return this.redirect(c, redirect, { error: error.code, error_description: error.message });
      return page(c, 400, "Cannot connect", `<h1>Cannot connect this application</h1><p>${escape(error.message)}</p>`);
    };
    // A browser names our origin in Origin, or where it leaves that out, says same-origin in Sec-Fetch-Site; a request with neither is not a form of ours.
    const sameOrigin = (c: Context) => {
      const origin = c.req.header("origin");
      if (origin === undefined) return c.req.header("sec-fetch-site") === "same-origin";
      if (origin === this.base) return true;
      try { return new URL(origin).host === c.req.header("host"); } catch { return false; }
    };

    app.get("/oauth/authorize", async c => {
      const params = new URL(c.req.url).searchParams;
      let request;
      try { request = this.authorization(params); } catch (error) { return shown(c, error); }
      const principal = await this.options.consoleAuth.principal(c.req.raw);
      const here = `/oauth/authorize?${params}`;
      const providers = this.options.github || this.options.google;
      // API-token sign-in, which the ChatGPT plugin's reviewers use: out of the way where GitHub or Google is offered.
      // TODO: remove after the ChatGPT review (docs/operations).
      const tokenForm = `<form method="post" action="/oauth/login"><input type="hidden" name="next" value="${escape(here)}">
<input type="password" name="token" placeholder="art_…" autocomplete="off" required aria-label="API token"><button type="submit"${providers ? " class=\"secondary\"" : ""}>Sign in</button></form>`;
      if (!principal) {
        return page(c, 200, "Sign in", `<h1>Sign in to camelRun</h1>
<p>An application calling itself <strong>${escape(request.client.name)}</strong> <span class="muted">(unverified)</span>, at <code>${escape(destinationOf(request.redirectUri))}</code>, wants to connect to your camelRun account. Sign in first.</p>
${providers ? `<p>${this.options.github ? `<a class="button" href="/console/auth/github?next=${encodeURIComponent(here)}">Sign in with GitHub</a>` : ""}${this.options.github && this.options.google ? " " : ""}${this.options.google ? `<a class="button" href="/console/auth/google?next=${encodeURIComponent(here)}">Sign in with Google</a>` : ""}</p>
<details><summary class="muted">Use an API token instead</summary>${tokenForm}</details>` : tokenForm}`);
      }
      const destination = escape(destinationOf(request.redirectUri));
      return page(c, 200, "Connect", `<h1>Connect an application?</h1>
<p class="muted">Signed in as <strong>${escape(principal.name ? `${principal.name} (${principal.login ?? principal.tenant})` : principal.login ?? principal.tenant)}</strong></p>
<p class="destination">Access goes to<br><strong><code>${destination}</code></strong></p>
<p>An application calling itself <strong>${escape(request.client.name)}</strong> <span class="muted">(a name it chose; camelRun has not verified it)</span> is asking to manage your camelRun agents: to create, configure, run and delete agents and definitions, read their history, and answer their questions and approvals. It acts for this account until you revoke it.</p>
<p class="muted">Only connect if you trust <code>${destination}</code>, whatever the application calls itself.</p>
<form method="post" action="/oauth/authorize">${[...params].map(([key, value]) => `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`).join("")}
<button type="submit" name="decision" value="allow">Allow</button> <button type="submit" name="decision" value="deny" class="secondary">Deny</button></form>`);
    });

    app.post("/oauth/authorize", async c => {
      if (!sameOrigin(c)) return page(c, 403, "Forbidden", "<h1>Forbidden</h1><p>This form must be sent from this site.</p>");
      const params = new URLSearchParams(await readText(c.req.raw.body, 64 * 1024));
      const decision = params.get("decision");
      params.delete("decision");
      let request;
      try { request = this.authorization(params); } catch (error) { return shown(c, error); }
      const principal = await this.options.consoleAuth.principal(c.req.raw);
      if (!principal) return c.redirect(`/oauth/authorize?${params}`, 303);
      if (decision !== "allow") return this.redirect(c, request, { error: "access_denied", error_description: "The person declined" });
      return this.redirect(c, request, { code: await this.code(principal.tenant, principal.login, request) });
    });

    // Sign in with an API token, then back to the consent page.
    app.post("/oauth/login", async c => {
      if (!sameOrigin(c)) return page(c, 403, "Forbidden", "<h1>Forbidden</h1><p>This form must be sent from this site.</p>");
      const params = new URLSearchParams(await readText(c.req.raw.body, 16 * 1024));
      const next = params.get("next") ?? "";
      if (!next.startsWith("/oauth/authorize?")) return page(c, 400, "Cannot sign in", "<h1>Cannot sign in</h1><p>Start again from the application.</p>");
      const session = await this.options.consoleAuth.tokenSession(params.get("token") ?? "");
      if (!session) return page(c, 403, "Unknown token", `<h1>Unknown token</h1><p>That API token is not valid. <a href="${escape(next)}">Try again</a>.</p>`);
      c.header("Set-Cookie", session.cookie);
      return c.redirect(next, 303);
    });
    return app;
  }
}

/** https anywhere, http only on a loopback address, or a native app's own scheme; never a fragment. */
function validRedirect(uri: unknown) {
  if (typeof uri !== "string" || uri.length > 2000) return false;
  let url: URL;
  try { url = new URL(uri); } catch { return false; }
  if (url.hash || uri.includes("#")) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:"].includes(url.protocol);
}

/**
 * Where a redirect URI sends the code, as the consent page shows it: a web address's scheme and host, which is
 * whose server gets it; for an app's own scheme the whole URI but its query, since any app may claim a scheme.
 */
function destinationOf(uri: string) {
  const url = new URL(uri);
  if (url.protocol === "https:" || url.protocol === "http:") return `${url.protocol}//${url.host}`;
  const shown = `${url.protocol}${uri.slice(url.protocol.length).split("?")[0]}`;
  return shown.length > 200 ? `${shown.slice(0, 200)}…` : shown;
}

/** The same URI, or for a loopback http one the same but for its port (RFC 8252: native apps listen on any port). */
function redirectMatches(registered: string, given: string) {
  if (registered === given) return true;
  try {
    const a = new URL(registered), b = new URL(given);
    return a.protocol === "http:" && b.protocol === "http:" && LOOPBACK.has(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}

const PAGE = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · camelRun</title><style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--accent:#1c1917;--on:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--card:#1c1917;--line:#292524;--accent:#f5f5f4;--on:#0c0a09}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}
main{max-width:440px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 12px}.muted{color:var(--muted);font-size:13px}code{font-size:13px}
button,.button{display:inline-block;border:1px solid var(--accent);background:var(--accent);color:var(--on);border-radius:8px;padding:8px 16px;font:inherit;cursor:pointer;text-decoration:none}
.secondary{background:transparent;color:var(--fg)}input[type=password]{width:100%;box-sizing:border-box;margin:0 0 12px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
details{margin-top:16px}summary{cursor:pointer;margin-bottom:12px}.brand{font-weight:600;margin-bottom:16px}.destination{border:1px solid var(--line);border-radius:8px;padding:10px 12px;word-break:break-all}.destination code{font-size:15px}</style></head><body><main><div class="brand">camelRun</div>${body}</main></body></html>`;

import type { Sql } from "./host.ts";
import { HttpError } from "./http-error.ts";
import { fetchWithoutRedirects } from "./no-redirect.ts";
import { pem, randomHex, rs256, rsaSigningKey, textBase64Url, toBase64Url } from "./channels/crypto.ts";

/**
 * GitHub Apps a tenant keeps in camelRun: the App ID, the private key and (optionally) the webhook secret, sealed with
 * the runtime's secrets key as provider keys are, and never shown again. From them the runtime mints installation
 * tokens itself, where a definition asks for one (`auth: { type: "github-app", app, ... }` on a computer's egress grant,
 * an MCP server or an OpenAPI source), so a product needs no server of its own to hold the key.
 *
 *   github_apps   one row per App: its id (gha_…), the tenant, its name, and the record below (`app`, JSON)
 *
 * A token is minted with an App JWT (RS256, ten minutes), for one installation (given, or found by repository or
 * owner), scoped to the repositories and permissions the definition names. It is kept in this process's memory until
 * five minutes before it expires, and only for the same App, key, installation and scope; the App's row is read on
 * every use, so a deleted App stops minting at once on every node, and a rotated key is used from the next token on.
 * Tokens are never stored, logged or returned by an API: they go only to where the runtime injects them.
 *
 * This module is shared by the Node runtime and the Workers backend: hosts give it the database, sealing and fetch.
 */

export type Sealed = { iv: string; tag: string; ciphertext: string };
export type GitHubPermission = "read" | "write" | "admin";
/** How a source or an egress grant asks for an installation token. */
export type GitHubAppAuth = {
  type: "github-app";
  /** The App's name or id (gha_…) in the tenant. */
  app: string;
  /** The installation, when known; else found from `repositories` or `owner`, or the App's only installation. */
  installation?: number;
  /** The account (user or organization) whose installation to use. */
  owner?: string;
  /** `owner/name` of each repository the token may reach (one owner); every repository of the installation when left out. */
  repositories?: string[];
  /** The token's permissions (`contents: "write"`); the installation's own when left out. */
  permissions?: Record<string, GitHubPermission>;
};
/** An App as stored: `sealed` holds `{ privateKey, webhookSecret? }`. */
export interface GitHubAppRecord {
  id: string; tenant: string; name: string;
  appId: string; slug: string; owner?: string; htmlUrl?: string;
  masked: { privateKey: string; webhookSecret?: string };
  sealed: Sealed;
  /** Raised by every key change, so tokens minted under an older key are not reused. */
  keyVersion: number;
  createdAt: number; updatedAt: number;
}
export type GitHubAppView = Omit<GitHubAppRecord, "sealed" | "tenant" | "keyVersion"> & { keyRotatedAt?: number };
export type GitHubAppCredentials = { appId: string; privateKey: string; webhookSecret?: string };
export type GitHubAppInput = { name?: unknown; appId?: unknown; privateKey?: unknown; webhookSecret?: unknown };
export type GitHubAppUpdate = { name?: unknown; privateKey?: unknown; webhookSecret?: unknown };
/** An installation token at its injection point: `refused` drops it when the upstream turns it away (401). */
export type GitHubToken = { token: string; expiresAt: number; refused(): void };

export interface GitHubAppsHost {
  sql: Sql;
  keys: { canStore: boolean; seal(context: string, plaintext: string): Sealed; unseal(context: string, sealed: Sealed): string };
  /** The host's outbound fetch to GitHub's API. */
  fetch: typeof fetch;
  /** GitHub's REST API (tests: a fake), default https://api.github.com. */
  apiUrl?: string;
  /** Where tokens are kept, when it should outlive this object (a Worker isolate's, across requests). */
  cache?: GitHubTokenCache;
}
type Entry = { token: string; expiresAt: number; usedAt: number };
/** Installation tokens a node holds, in memory only, by App, key version, installation and scope. */
export type GitHubTokenCache = { tokens: Map<string, Entry>; minting: Map<string, Promise<Entry>> };
export const githubTokenCache = (): GitHubTokenCache => ({ tokens: new Map(), minting: new Map() });

export const GITHUB_APP_LIMITS = Object.freeze({
  apps: 50,
  repositories: 500,
  permissions: 50,
  /** A token this close to expiry is replaced (GitHub's last an hour). */
  marginMs: 5 * 60_000,
  /** Tokens kept in memory on a node; past it the ones used longest ago go. */
  entries: 10_000,
  requestMs: 15_000,
});
/** Hosts a `github-app` egress grant may name: GitHub's own, where an installation token is the credential. */
export const GITHUB_HOSTS = ["github.com", "api.github.com", "uploads.github.com", "codeload.github.com", "raw.githubusercontent.com"] as const;

const ID = /^gha_[a-f0-9]{20}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/;
const PERMISSION = /^[a-z][a-z_]{0,63}$/;
const bad = (message: string) => new HttpError(400, message);
const aad = (id: string) => `github-app:${id}`;
/** A request body's fields: an object of only these. */
function fields(input: unknown, known: string[], usage: string) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad(`Body must be ${usage}`);
  const extra = Object.keys(input).find(key => !known.includes(key));
  if (extra) throw bad(`Unknown field ${extra}; the body is ${usage}`);
}
const mask = (privateKey: string) => `…${privateKey.trim().slice(-40, -30)}…`;

/** The shape of `auth: { type: "github-app", ... }`, checked where a definition is saved. Existence is checked at use. */
export function githubAppAuthInput(value: unknown, label: string): GitHubAppAuth {
  const usage = `${label} is { type: "github-app", app, installation?, owner?, repositories?, permissions? }`;
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { type?: unknown }).type !== "github-app") throw bad(usage);
  const extra = Object.keys(value).find(key => !["type", "app", "installation", "owner", "repositories", "permissions"].includes(key));
  if (extra) throw bad(`${label}: Unrecognized key: "${extra}"`);
  const { app, installation, owner, repositories, permissions } = value as Record<string, unknown>;
  if (typeof app !== "string" || !(ID.test(app) || NAME.test(app))) throw bad(`${label}.app is the name or id (gha_…) of one of your GitHub Apps (POST /v1/github-apps)`);
  const auth: GitHubAppAuth = { type: "github-app", app };
  if (installation !== undefined) {
    if (!Number.isSafeInteger(installation) || (installation as number) <= 0) throw bad(`${label}.installation is the installation's numeric id`);
    auth.installation = installation as number;
  }
  if (owner !== undefined) {
    if (typeof owner !== "string" || !ACCOUNT.test(owner)) throw bad(`${label}.owner is a GitHub user or organization login`);
    auth.owner = owner;
  }
  if (repositories !== undefined) {
    if (!Array.isArray(repositories) || !repositories.length || repositories.length > GITHUB_APP_LIMITS.repositories)
      throw bad(`${label}.repositories is a list of 1 to ${GITHUB_APP_LIMITS.repositories} owner/name entries`);
    const owners = new Set<string>(), names = new Set<string>();
    for (const entry of repositories) {
      const match = typeof entry === "string" ? REPOSITORY.exec(entry) : null;
      if (!match) throw bad(`${label}.repositories: ${JSON.stringify(entry)} is not owner/name`);
      owners.add(match[1]!.toLowerCase());
      names.add(entry.toLowerCase());
    }
    if (owners.size > 1) throw bad(`${label}.repositories must all have one owner: a token reaches one installation`);
    if (auth.owner && !owners.has(auth.owner.toLowerCase())) throw bad(`${label}.owner must be the repositories' owner`);
    auth.repositories = [...names].sort();
  }
  if (permissions !== undefined) {
    if (!permissions || typeof permissions !== "object" || Array.isArray(permissions) || !Object.keys(permissions).length || Object.keys(permissions).length > GITHUB_APP_LIMITS.permissions)
      throw bad(`${label}.permissions is an object of 1 to ${GITHUB_APP_LIMITS.permissions} GitHub permissions, each "read", "write" or "admin"`);
    const checked: Record<string, GitHubPermission> = {};
    for (const name of Object.keys(permissions).sort()) {
      const level = (permissions as Record<string, unknown>)[name];
      if (!PERMISSION.test(name) || (level !== "read" && level !== "write" && level !== "admin")) throw bad(`${label}.permissions.${name} must be "read", "write" or "admin"`);
      checked[name] = level;
    }
    auth.permissions = checked;
  }
  return auth;
}

/** Why a token could not be had: an HttpError whose message names the App and what GitHub said, never a credential. */
export class GitHubAppError extends HttpError {
  /** Whether asking again later could do better (GitHub unreachable, 5xx, rate limited). */
  readonly transient: boolean;
  constructor(status: number, message: string, transient = false) { super(status, message, "GITHUB_APP_FAILED"); this.name = "GitHubAppError"; this.transient = transient; }
}

export class GitHubApps {
  private readonly host: GitHubAppsHost;
  private readonly base: string;
  private readonly tokens: Map<string, Entry>;
  private readonly minting: Map<string, Promise<Entry>>;
  private readonly signingKeys = new Map<string, Promise<CryptoKey>>();

  constructor(host: GitHubAppsHost) {
    this.host = host;
    this.base = (host.apiUrl || "https://api.github.com").replace(/\/+$/, "");
    const cache = host.cache ?? githubTokenCache();
    this.tokens = cache.tokens;
    this.minting = cache.minting;
  }

  // Records -------------------------------------------------------------------------------------------------------

  private async read(tenant: string, ref: string, sql: Sql = this.host.sql): Promise<GitHubAppRecord | undefined> {
    if (typeof ref !== "string" || !(ID.test(ref) || NAME.test(ref))) return undefined;
    const row = (await sql.query(ID.test(ref) ? "select app from github_apps where tenant = $1 and id = $2" : "select app from github_apps where tenant = $1 and name = $2", [tenant, ref])).rows[0];
    return row ? (typeof row.app === "string" ? JSON.parse(row.app) : row.app) as GitHubAppRecord : undefined;
  }
  private async owned(tenant: string, ref: string) {
    const app = await this.read(tenant, ref);
    if (!app) throw new HttpError(404, `Unknown GitHub App ${ref}`);
    return app;
  }
  private secrets(app: GitHubAppRecord): { privateKey: string; webhookSecret?: string } {
    return JSON.parse(this.host.keys.unseal(aad(app.id), app.sealed));
  }
  /** What callers see: never the key or the secret, only their masked forms. */
  view({ sealed: _sealed, tenant: _tenant, keyVersion, ...app }: GitHubAppRecord): GitHubAppView {
    return { ...app, ...(keyVersion > 1 ? { keyRotatedAt: app.updatedAt } : {}) } as GitHubAppView;
  }

  async list(tenant: string) {
    const { rows } = await this.host.sql.query("select app from github_apps where tenant = $1 order by created_at, id", [tenant]);
    return rows.map(row => this.view(typeof row.app === "string" ? JSON.parse(row.app) : row.app));
  }
  async get(tenant: string, ref: string) { return this.view(await this.owned(tenant, ref)); }

  /** The App's credentials, for the runtime's own use (a GitHub channel that names it). */
  async credentials(tenant: string, ref: string): Promise<GitHubAppCredentials & { id: string; name: string; slug: string }> {
    const app = await this.owned(tenant, ref);
    const { privateKey, webhookSecret } = this.secrets(app);
    return { id: app.id, name: app.name, slug: app.slug, appId: app.appId, privateKey, ...(webhookSecret ? { webhookSecret } : {}) };
  }

  private name(value: unknown, fallback: string) {
    const name = value ?? fallback;
    if (typeof name !== "string" || !NAME.test(name) || ID.test(name)) throw bad("name is 1–100 letters, digits, '_', '.' or '-', starting with a letter or digit");
    return name;
  }

  /** Store an App: its key is checked by asking GitHub who the App is with a JWT it signs (GET /app). */
  async create(tenant: string, input: GitHubAppInput) {
    if (!this.host.keys.canStore) throw new HttpError(503, "This runtime has no AGENT_SECRETS_KEY, so it cannot store GitHub Apps");
    fields(input, ["name", "appId", "privateKey", "webhookSecret"], "{ name?, appId, privateKey, webhookSecret? }");
    const { appId, privateKey, webhookSecret } = input;
    if (typeof appId !== "string" && typeof appId !== "number" || !/^\d{1,20}$/.test(String(appId))) throw bad("appId is the App ID from the App's General settings");
    const key = this.privateKeyInput(privateKey);
    const secret = this.webhookSecretInput(webhookSecret);
    const about = await this.whoAmI(String(appId), key);
    return this.insert(tenant, input.name, { appId: String(appId), privateKey: key, ...(secret ? { webhookSecret: secret } : {}) }, about);
  }

  /**
   * An App made from a manifest (GitHub's manifest flow): GitHub gives a one-use `code` on the redirect after the App is
   * created, which this exchanges (POST /app-manifests/{code}/conversions) for the App's id, key and webhook secret,
   * stored at once. GitHub's OAuth client secret for the App is not kept: the runtime has no use for it.
   */
  async fromManifest(tenant: string, input: { code?: unknown; name?: unknown }) {
    if (!this.host.keys.canStore) throw new HttpError(503, "This runtime has no AGENT_SECRETS_KEY, so it cannot store GitHub Apps");
    fields(input, ["code", "name"], "{ code, name? }");
    if (typeof input.code !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(input.code)) throw bad("code is the one-use code GitHub gave on the manifest flow's redirect");
    const name = input.name === undefined ? undefined : this.name(input.name, "");
    const answer = await this.call(`POST /app-manifests/${input.code}/conversions`, "POST", `/app-manifests/${input.code}/conversions`);
    const { id, slug, pem: key, webhook_secret: secret, owner, html_url: htmlUrl } = answer as Record<string, any>;
    if (!Number.isSafeInteger(id) || typeof slug !== "string" || typeof key !== "string") throw new GitHubAppError(502, "GitHub's manifest conversion gave no App id, slug and key");
    return this.insert(tenant, name, { appId: String(id), privateKey: key, ...(typeof secret === "string" && secret ? { webhookSecret: secret } : {}) },
      { slug, ...(typeof owner?.login === "string" ? { owner: owner.login } : {}), ...(typeof htmlUrl === "string" ? { htmlUrl } : {}) });
  }

  private async insert(tenant: string, requested: unknown, credentials: GitHubAppCredentials, about: { slug: string; owner?: string; htmlUrl?: string }) {
    const name = this.name(requested, about.slug);
    const count = Number((await this.host.sql.query("select count(*) as count from github_apps where tenant = $1", [tenant])).rows[0]?.count ?? 0);
    if (count >= GITHUB_APP_LIMITS.apps) throw new HttpError(409, `A tenant can have at most ${GITHUB_APP_LIMITS.apps} GitHub Apps`);
    const id = `gha_${randomHex(10)}`, now = Date.now();
    const { privateKey, webhookSecret } = credentials;
    const app: GitHubAppRecord = {
      id, tenant, name, appId: credentials.appId, slug: about.slug, ...(about.owner ? { owner: about.owner } : {}), ...(about.htmlUrl ? { htmlUrl: about.htmlUrl } : {}),
      masked: { privateKey: mask(privateKey), ...(webhookSecret ? { webhookSecret: `…${webhookSecret.slice(-4)}` } : {}) },
      sealed: this.host.keys.seal(aad(id), JSON.stringify({ privateKey, ...(webhookSecret ? { webhookSecret } : {}) })),
      keyVersion: 1, createdAt: now, updatedAt: now,
    };
    await this.host.sql.query("insert into github_apps (id, tenant, name, app, created_at) values ($1, $2, $3, $4, $5)", [id, tenant, name, JSON.stringify(app), now])
      .catch(error => { throw (error as { code?: string }).code === "23505" ? new HttpError(409, `A GitHub App named ${name} exists; give another name`) : error; });
    return this.view(app);
  }

  /** Rename it, rotate its key (checked with GitHub first) or set its webhook secret (null removes it). */
  async update(tenant: string, ref: string, input: GitHubAppUpdate) {
    const app = await this.owned(tenant, ref);
    if ((input as Record<string, unknown> | null)?.appId !== undefined) throw bad("An App's appId cannot change: store the other App on its own");
    fields(input, ["name", "privateKey", "webhookSecret"], "{ name?, privateKey?, webhookSecret? }");
    const next: GitHubAppRecord = { ...app, masked: { ...app.masked }, updatedAt: Date.now() };
    if (input.name !== undefined) next.name = this.name(input.name, app.name);
    if (input.privateKey !== undefined || input.webhookSecret !== undefined) {
      const secrets = this.secrets(app);
      if (input.privateKey !== undefined) {
        const key = this.privateKeyInput(input.privateKey);
        await this.whoAmI(app.appId, key);
        secrets.privateKey = key;
        next.masked.privateKey = mask(key);
        next.keyVersion = app.keyVersion + 1;
      }
      if (input.webhookSecret === null) { delete secrets.webhookSecret; delete next.masked.webhookSecret; }
      else if (input.webhookSecret !== undefined) {
        secrets.webhookSecret = this.webhookSecretInput(input.webhookSecret)!;
        next.masked.webhookSecret = `…${secrets.webhookSecret.slice(-4)}`;
      }
      next.sealed = this.host.keys.seal(aad(app.id), JSON.stringify(secrets));
    }
    await this.host.sql.query("update github_apps set name = $3, app = $4 where tenant = $1 and id = $2", [tenant, app.id, next.name, JSON.stringify(next)])
      .catch(error => { throw (error as { code?: string }).code === "23505" ? new HttpError(409, `A GitHub App named ${next.name} exists; give another name`) : error; });
    if (next.keyVersion !== app.keyVersion) this.forget(app.id);
    return this.view(next);
  }

  /**
   * Delete it: no token is minted or served from it after this, on any node (each use reads its row). The tokens this
   * node holds for it are revoked at GitHub too; another node's lapse within the hour, unused.
   */
  async remove(tenant: string, ref: string, sql: Sql = this.host.sql) {
    const app = await this.read(tenant, ref, sql);
    if (!app) throw new HttpError(404, `Unknown GitHub App ${ref}`);
    const used = (await sql.query("select id from channels where tenant = $1 and channel->'account'->>'githubApp' = $2 limit 1", [tenant, app.id])).rows[0];
    if (used) throw new HttpError(409, `Channel ${used.id} uses this GitHub App; delete the channel, or give it the App's credentials itself, first`);
    await sql.query("delete from github_apps where tenant = $1 and id = $2", [tenant, app.id]);
    const held = this.forget(app.id);
    await Promise.all(held.map(token => fetchWithoutRedirects(this.host.fetch, `${this.base}/installation/token`, {
      method: "DELETE", headers: this.headers(token), signal: AbortSignal.timeout(5_000),
    }).then(response => response.body?.cancel()).catch(() => {})));
  }

  /** Drop this node's tokens of an App; returns them, for revoking. */
  private forget(id: string) {
    const held: string[] = [];
    for (const [key, entry] of this.tokens) if (key.startsWith(`${id}|`)) { held.push(entry.token); this.tokens.delete(key); }
    return held;
  }

  // Tokens --------------------------------------------------------------------------------------------------------

  /**
   * An installation token for `auth`, minted by the tenant's App or reused while it has five minutes left. The App's
   * row is read each time: a deleted App gives none, and a rotated key's tokens are fresh ones.
   */
  async token(tenant: string, auth: GitHubAppAuth): Promise<GitHubToken> {
    const app = await this.read(tenant, auth.app);
    if (!app) throw new GitHubAppError(404, `GitHub App ${auth.app} is not one of this tenant's (POST /v1/github-apps)`);
    const key = [app.id, app.keyVersion, auth.installation ?? "", (auth.owner ?? "").toLowerCase(), (auth.repositories ?? []).join(","),
      Object.entries(auth.permissions ?? {}).map(([name, level]) => `${name}=${level}`).join(",")].join("|");
    const now = Date.now();
    let entry = this.tokens.get(key);
    if (!entry || entry.expiresAt - GITHUB_APP_LIMITS.marginMs <= now) {
      let pending = this.minting.get(key);
      if (!pending) {
        pending = this.mint(app, auth).then(value => {
          if (this.tokens.size >= GITHUB_APP_LIMITS.entries) {
            const oldest = [...this.tokens].sort((a, b) => a[1].usedAt - b[1].usedAt).slice(0, Math.ceil(GITHUB_APP_LIMITS.entries / 10));
            for (const [old] of oldest) this.tokens.delete(old);
          }
          this.tokens.set(key, value);
          return value;
        }).finally(() => this.minting.delete(key));
        this.minting.set(key, pending);
      }
      entry = await pending;
    }
    entry.usedAt = now;
    const token = entry.token;
    return { token, expiresAt: entry.expiresAt, refused: () => { if (this.tokens.get(key)?.token === token) this.tokens.delete(key); } };
  }

  /** A token an upstream turned away (401): dropped, so the next use mints another. */
  refuse(token: string) {
    for (const [key, entry] of this.tokens) if (entry.token === token) this.tokens.delete(key);
  }

  private async mint(app: GitHubAppRecord, auth: GitHubAppAuth): Promise<Entry> {
    const { privateKey } = this.secrets(app);
    const jwt = await this.jwt(app.appId, privateKey);
    const where = `GitHub App ${app.name}`;
    const installation = auth.installation ?? await this.installation(app, auth, jwt);
    const body = {
      ...(auth.repositories ? { repositories: auth.repositories.map(entry => entry.split("/")[1]) } : {}),
      ...(auth.permissions ? { permissions: auth.permissions } : {}),
    };
    const answer = await this.call(`${where}: POST /app/installations/${installation}/access_tokens`, "POST", `/app/installations/${installation}/access_tokens`, jwt, Object.keys(body).length ? body : undefined);
    const token = answer.token, expiresAt = Date.parse(String(answer.expires_at));
    if (typeof token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(token)) throw new GitHubAppError(502, `${where}: GitHub gave no installation token`);
    return { token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60 * 60_000, usedAt: Date.now() };
  }

  /** The installation to mint for: the repositories' (GET /repos/{owner}/{repo}/installation), the owner's, or the App's only one. */
  private async installation(app: GitHubAppRecord, auth: GitHubAppAuth, jwt: string): Promise<number> {
    const where = `GitHub App ${app.name}`;
    const found = (answer: Record<string, any>) => {
      if (!Number.isSafeInteger(answer.id)) throw new GitHubAppError(502, `${where}: GitHub named no installation`);
      return answer.id as number;
    };
    if (auth.repositories) {
      const [owner, repo] = auth.repositories[0]!.split("/");
      return found(await this.call(`${where} is not installed on ${owner}/${repo}`, "GET", `/repos/${owner}/${repo}/installation`, jwt));
    }
    if (auth.owner) {
      try { return found(await this.call(`${where} is not installed for ${auth.owner}`, "GET", `/orgs/${auth.owner}/installation`, jwt)); }
      catch (error) {
        if ((error as GitHubAppError).status !== 404) throw error;
        return found(await this.call(`${where} is not installed for ${auth.owner}`, "GET", `/users/${auth.owner}/installation`, jwt));
      }
    }
    const list = await this.call(`${where}: GET /app/installations`, "GET", "/app/installations?per_page=2", jwt) as unknown;
    if (!Array.isArray(list) || !list.length) throw new GitHubAppError(422, `${where} has no installations: install it on an account first`);
    if (list.length > 1) throw new GitHubAppError(422, `${where} has more than one installation: say which with installation, owner or repositories`);
    return found(list[0]);
  }

  // GitHub --------------------------------------------------------------------------------------------------------

  private privateKeyInput(value: unknown) {
    if (typeof value !== "string" || value.length > 16_384 || !pem(value)) throw bad("privateKey is a private key generated for the App (PEM)");
    return value;
  }
  private webhookSecretInput(value: unknown) {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value || value.length > 1024) throw bad("webhookSecret is the App's webhook secret, a string of 1–1024 characters");
    return value;
  }
  private key(privateKey: string) {
    let value = this.signingKeys.get(privateKey);
    if (value) return value;
    value = rsaSigningKey(privateKey).then(key => {
      if (!key) throw bad("privateKey must be the App's RSA private key (PEM, PKCS#1 or PKCS#8)");
      return key;
    });
    value.catch(() => this.signingKeys.delete(privateKey));
    if (this.signingKeys.size > 100) this.signingKeys.clear();
    this.signingKeys.set(privateKey, value);
    return value;
  }
  /** A JWT the App signs for itself, good for ten minutes (backdated a minute for clock drift). */
  private async jwt(appId: string, privateKey: string) {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${textBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${textBase64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))}`;
    return `${unsigned}.${toBase64Url(await rs256(await this.key(privateKey), unsigned))}`;
  }
  /** Who the App is, by its own JWT: GitHub refuses a key that is not the App's. */
  private async whoAmI(appId: string, privateKey: string) {
    const jwt = await this.jwt(appId, privateKey);
    let app: Record<string, any>;
    try { app = await this.call("GET /app", "GET", "/app", jwt); }
    catch (error) {
      if ((error as GitHubAppError).transient) throw error;
      throw new HttpError(422, `GitHub rejected the App's credentials (${(error as Error).message})`);
    }
    if (String(app.id) !== appId || typeof app.slug !== "string") throw new HttpError(422, "GitHub rejected the App's credentials (GET /app named another App)");
    return { slug: app.slug as string, ...(typeof app.owner?.login === "string" ? { owner: app.owner.login as string } : {}), ...(typeof app.html_url === "string" ? { htmlUrl: app.html_url as string } : {}) };
  }
  private headers(auth?: string) {
    return { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "camelai-agent-runtime", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) };
  }
  private async call(what: string, method: string, path: string, auth?: string, body?: unknown): Promise<Record<string, any>> {
    let response: Response;
    try {
      response = await fetchWithoutRedirects(this.host.fetch, `${this.base}${path}`, {
        method, headers: { ...this.headers(auth), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(GITHUB_APP_LIMITS.requestMs),
      });
    } catch (error) { throw new GitHubAppError(502, `${what}: GitHub could not be reached (${error instanceof Error ? error.name : "network error"})`, true); }
    const answer = await response.json().catch(() => ({})) as Record<string, any>;
    if (response.ok) return answer;
    const limited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
    const message = typeof answer.message === "string" ? ` ${answer.message.slice(0, 300)}` : "";
    throw new GitHubAppError(response.status === 404 ? 404 : response.status >= 500 || limited ? 502 : 422, `${what}: GitHub answered HTTP ${response.status}${message}`, response.status >= 500 || limited);
  }
}

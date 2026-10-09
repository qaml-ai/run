import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createLocalJWKSet, errors, jwtVerify, type JWK } from "jose";
import type { Accounts, Sealed } from "./accounts.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";

/**
 * Identity tokens for tool servers: for a source whose auth is `{ type: "runtime" }`, every
 * request carries a short-lived JWT the runtime signs (EdDSA, Ed25519), naming the tenant,
 * the agent, the subject the application gave the agent, its context, and who is acting in
 * the turn. Servers verify it against /.well-known/jwks.json: no shared secret, and nothing
 * per user is stored anywhere.
 */
export type AgentIdentity = { subject?: string; context?: Record<string, unknown> };
/** Who a call is for: the agent's identity, and in its turn who is acting and where it came from. */
/** `approval`: the call was approved by a person (inputs.ts): which input, who, and when. */
/** `request` and `toolCall`: the run (its request id) and the model's tool call a request is made for. */
/** `parent` and `root`: in a child's run (a delegate or spawn_agent call's), its parent agent and its chain's first, from the run's signed chain. */
export type TokenClaims = { tenant: string; agent: string; definition?: string; identity?: AgentIdentity; actor?: string; origin?: Record<string, unknown>; approval?: Record<string, unknown>; request?: string; toolCall?: string; parent?: string; root?: string };

/**
 * What a call-bound file URL grants (file-arguments.ts): one file at one version, or a file, a manifest or an archive of a
 * directory in a snapshot made for the call. `path` is in the volume; `agentPath` is the path as the agent names it.
 */
export type FileGrant = {
  tenant: string; agent: string; call: string; tool: string; volume: string; path: string; agentPath: string;
  kind: "file" | "manifest" | "archive"; version?: number; snapshot?: string;
};
/** The `aud` of file URL tokens, which no tool source can have (theirs are URLs on their own origin). */
export const FILE_AUDIENCE = "camelrun:file";
const FILE_TYPE = "file+jwt";

const ALGORITHM = "EdDSA";
const TOKEN_SECONDS = 120;
const KEYS_TTL_MS = 10 * 60_000;
const aad = (kid: string) => `runtime-signing:${kid}`;
/** An Ed25519 key's PKCS#8 encoding before its 32-byte seed. */
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
/**
 * A new Ed25519 signing key, from a seed of node:crypto's randomBytes (a simulator's seeded stream, so its runs replay;
 * WebCrypto's key generation draws from its own), as JWKs.
 */
function ed25519Key() {
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, randomBytes(32)]), format: "der", type: "pkcs8" });
  return { publicJwk: createPublicKey(privateKey).export({ format: "jwk" }) as JWK, privateJwk: privateKey.export({ format: "jwk" }) as JWK };
}
type Keys = { signing?: { kid: string; key: KeyObject }; published: JWK[] };
const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/**
 * A JWT signed with an Ed25519 key, at once: node:crypto signs synchronously, where WebCrypto (jose's SignJWT) finishes
 * on a thread of its own, at a moment a simulator cannot replay.
 */
function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject) {
  const signed = `${base64url(header)}.${base64url(payload)}`;
  return `${signed}.${sign(null, Buffer.from(signed), key).toString("base64url")}`;
}

/** The turn a tool call belongs to, for requests made on its behalf deep in a transport (MCP). */
export const callScope = new AsyncLocalStorage<{ actor?: string; origin?: Record<string, unknown>; approval?: Record<string, unknown>; request?: string; toolCall?: string; parent?: string; root?: string }>();

export class RuntimeSigner {
  /** The runtime's public URL; without AGENT_PUBLIC_URL, the address it listens on, once known. */
  issuer: string;
  private readonly db: Db;
  private readonly accounts: Accounts;
  private cache?: { at: number; keys: Promise<Keys> };

  constructor(options: { db: Db; accounts: Accounts; issuer: string }) {
    this.db = options.db;
    this.accounts = options.accounts;
    this.issuer = options.issuer;
  }

  /** Whether this runtime can sign: it needs AGENT_SECRETS_KEY to keep its private key. */
  get available() { return this.accounts.canStoreKeys; }

  /** The keys, read at most every ten minutes (so a rotation reaches every node); a failed read is not kept. */
  private load(): Promise<Keys> {
    if (!this.cache || Date.now() - this.cache.at > KEYS_TTL_MS) {
      const keys = this.read();
      this.cache = { at: Date.now(), keys };
      keys.catch(() => { if (this.cache?.keys === keys) this.cache = undefined; });
    }
    return this.cache.keys;
  }

  /**
   * Read the keys, making the first one if there is none. Nodes starting together may each make
   * one; all are published, and every node signs with the oldest active key, so they converge.
   */
  private async read(): Promise<Keys> {
    const select = async () => (await this.db.query("select kid, public_jwk, private_sealed, retired_at from signing_keys order by created_at, kid")).rows;
    let rows = await select();
    if (!rows.some(row => row.retired_at === null)) {
      if (!this.available) throw new HttpError(503, "This runtime has no AGENT_SECRETS_KEY, so it cannot sign identity tokens");
      const { publicJwk: key, privateJwk } = ed25519Key();
      const kid = randomUUID();
      const publicJwk = { ...key, kid, alg: ALGORITHM, use: "sig" };
      await this.db.query("insert into signing_keys (kid, public_jwk, private_sealed, created_at) values ($1, $2, $3, $4)",
        [kid, JSON.stringify(publicJwk), JSON.stringify(this.accounts.seal(aad(kid), JSON.stringify(privateJwk))), Date.now()]);
      rows = await select();
    }
    const active = rows.find(row => row.retired_at === null)!;
    const signing = this.available
      ? { kid: active.kid as string, key: createPrivateKey({ key: JSON.parse(this.accounts.unseal(aad(active.kid), active.private_sealed as Sealed)), format: "jwk" }) }
      : undefined;
    return { ...(signing ? { signing } : {}), published: rows.map(row => row.public_jwk as JWK) };
  }

  /** The published keys, for /.well-known/jwks.json. */
  async jwks() { return { keys: (await this.load()).published }; }

  /** A file URL's token (file-arguments.ts), valid until `expiresAt` (ms), signed with the same key as identity tokens. */
  async fileToken(grant: FileGrant, expiresAt: number): Promise<string> {
    const { signing } = await this.load();
    if (!signing) throw new Error("This runtime cannot sign file URLs");
    return signJwt({ alg: ALGORITHM, kid: signing.kid, typ: FILE_TYPE },
      { ...grant, iss: this.issuer, aud: FILE_AUDIENCE, sub: grant.agent, iat: Math.floor(Date.now() / 1000), exp: Math.floor(expiresAt / 1000) }, signing.key);
  }

  /**
   * The grant a file URL's token carries: signed by one of this runtime's keys, for files, and not expired. A key made
   * on another node since the keys were read is looked for once more.
   */
  async verifyFileToken(token: string): Promise<FileGrant & { exp: number }> {
    const verify = async () => (await jwtVerify(token, createLocalJWKSet(await this.jwks()), { issuer: this.issuer, audience: FILE_AUDIENCE, algorithms: [ALGORITHM], typ: FILE_TYPE })).payload;
    try {
      return await verify().catch(error => {
        if (!(error instanceof errors.JWKSNoMatchingKey) || Date.now() - (this.cache?.at ?? 0) < 10_000) throw error;
        this.cache = undefined;
        return verify();
      }) as FileGrant & { exp: number };
    } catch (error) {
      throw new HttpError(403, error instanceof errors.JWTExpired ? "This link has expired" : "Invalid link");
    }
  }

  /** A token for one request to `audience` (the server's URL), valid for two minutes. */
  async token(audience: string, claims: TokenClaims): Promise<string> {
    const { signing } = await this.load();
    if (!signing) throw new Error("This runtime cannot sign identity tokens");
    const { identity, actor, origin, tenant, agent, definition, approval, request, toolCall, parent, root } = claims;
    const now = Math.floor(Date.now() / 1000);
    return signJwt({ alg: ALGORITHM, kid: signing.kid, typ: "JWT" }, {
      tenant, agent, ...(definition ? { definition } : {}), ...(identity?.context ? { ctx: identity.context } : {}),
      ...(actor ? { act: actor } : {}), ...(origin ? { origin } : {}), ...(approval ? { approval } : {}),
      ...(request ? { req: request } : {}), ...(toolCall ? { tcid: toolCall } : {}), ...(parent ? { par: parent } : {}), ...(root ? { root } : {}),
      iss: this.issuer, aud: audience, sub: identity?.subject ?? agent, iat: now, exp: now + TOKEN_SECONDS, jti: randomUUID(),
    }, signing.key);
  }
}

/** An agent's identity from a create request: `subject` (who the agent acts for) and `context` (claims the application wants carried). */
export function identityInput(params: { subject?: unknown; context?: unknown }): AgentIdentity | undefined {
  const { subject, context } = params;
  if (subject === undefined && context === undefined) return undefined;
  if (subject !== undefined && (typeof subject !== "string" || !subject.trim() || subject.length > 200)) throw new HttpError(400, "subject must be a string of 1–200 characters");
  if (context !== undefined) {
    if (!context || typeof context !== "object" || Array.isArray(context)) throw new HttpError(400, "context must be an object");
    if (Buffer.byteLength(JSON.stringify(context)) > 4096) throw new HttpError(400, "context must be at most 4 KB of JSON");
  }
  return { ...(subject !== undefined ? { subject: subject as string } : {}), ...(context !== undefined ? { context: context as Record<string, unknown> } : {}) };
}

/** Who is acting in a run, from its request: a string of 1–200 characters. */
export function actorInput(actor: unknown): string | undefined {
  if (actor === undefined) return undefined;
  if (typeof actor !== "string" || !actor.trim() || actor.length > 200) throw new HttpError(400, "actor must be a string of 1–200 characters");
  return actor;
}

import { createHash } from "node:crypto";
import { canonical } from "../shared/durable-json.ts";
import type { AgentIdentity, RuntimeSigner } from "./identity.ts";
import { recordCredentialExchange } from "./metrics.ts";
import { clock } from "./node-context.ts";
import type { Outbound } from "./outbound.ts";
import { ToolFailure } from "./tool-servers.ts";

/**
 * Credentials the runtime fetches for a tool server, for a source whose auth is `{ type: "exchange", url }`: a token
 * that lives an hour (a GitHub App installation token, a cloud STS token, an OAuth access token) cannot be stored in a
 * definition, so the tenant's own endpoint at `url` mints one when the runtime asks. The runtime asks with an identity
 * token it signs (identity.ts) for that endpoint's audience, naming the tenant, the agent and its subject, and the tool
 * server the credential is for; the endpoint verifies it against /.well-known/jwks.json and answers
 * `{ token, expiresAt | expiresIn }`.
 *
 * What it answers is kept in this process's memory only, per agent: never stored, logged, returned by an API or shown
 * to a model. Each node of a cluster has its own, so a credential may be fetched once per node.
 */
export type ExchangeAuth = { type: "exchange"; url: string; audience?: string };
/** Whom a credential is for: the endpoint decides per caller, so one fetched for an agent is never used for another. */
export type ExchangeCaller = { tenant: string; agent: string; definition?: string; identity?: AgentIdentity };
/** The tool server a credential is for, and where to ask for it. */
export type ExchangeTarget = { name: string; url: string; exchange: string; audience: string };

/**
 * Why an exchange gave no credential: `unreachable` (no connection), `blocked` (the outbound guard refused its address), `timeout`,
 * `unavailable` (it answered 5xx, 408 or 429 past every retry), `refused` (any other status: it will not issue one to
 * this caller), `invalid_response` (not the JSON it should answer), `expired` (a credential already past its expiry),
 * and `rejected` (the tool server refused, twice, the credentials it issued).
 */
export type ExchangeFailure = "unreachable" | "blocked" | "timeout" | "unavailable" | "refused" | "invalid_response" | "expired" | "rejected";
/** A tool call that could not run for want of a credential: the source is unavailable for that call, and the model reads why. */
export class CredentialExchangeError extends ToolFailure {
  readonly reason: ExchangeFailure;
  /** The endpoint's HTTP status, when it answered with one. */
  readonly status?: number;
  constructor(reason: ExchangeFailure, message: string, status?: number) {
    super("source_unavailable", message);
    this.name = "CredentialExchangeError";
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
  /** Whether asking again later could do better: an endpoint that is down, not one that answered and refused or answered wrongly. */
  get transient() { return this.reason === "unreachable" || this.reason === "timeout" || this.reason === "unavailable"; }
}

export const EXCHANGE_LIMITS = Object.freeze({
  /** One request to the endpoint. */
  attemptMs: 5_000,
  /** All of a fetch's attempts and the waits between them: under the 10 s a tools listing has. */
  totalMs: 8_000,
  attempts: 3,
  backoffMs: 200,
  responseBytes: 64 * 1024,
  /** A credential is fetched again this long before it expires, or a fifth of its life before if that is sooner. */
  refreshMs: 5 * 60_000,
  /** A credential is used for at least this long, however soon it says it expires: a fetch per request would spin. */
  minLifeMs: 5_000,
  /** And for at most this long, however late it says it expires. */
  maxLifeMs: 24 * 60 * 60_000,
  /** Credentials kept on a node; past it the ones used longest ago go. */
  entries: 10_000,
});
/** A token as it goes in an Authorization header: printable ASCII without spaces, as a stored bearer token is. */
const TOKEN = /^[\x21-\x7e]{1,8192}$/;

type Entry = { token: string; refreshAt: number; usedAt: number };
/** `limits` replaces some of EXCHANGE_LIMITS (tests: a deadline short enough to wait out). */
type Options = { outbound: Outbound; signer?: RuntimeSigner; limits?: Partial<Record<keyof typeof EXCHANGE_LIMITS, number>> };

export class CredentialExchange {
  private readonly outbound: Outbound;
  private readonly signer?: RuntimeSigner;
  private readonly credentials = new Map<string, Entry>();
  private readonly fetching = new Map<string, Promise<string>>();
  private readonly limits: Record<keyof typeof EXCHANGE_LIMITS, number>;

  constructor(options: Options) {
    this.outbound = options.outbound;
    this.signer = options.signer;
    this.limits = { ...EXCHANGE_LIMITS, ...options.limits };
  }

  /**
   * What a credential is kept under: the tenant, the agent (with the identity its tokens carry, so one re-made for
   * another subject starts again), its definition, and the server and endpoint. Never less than the agent: the
   * endpoint may answer each caller differently.
   */
  key(caller: ExchangeCaller, target: ExchangeTarget) {
    return createHash("sha256").update(canonical({
      tenant: caller.tenant, agent: caller.agent, definition: caller.definition ?? "", subject: caller.identity?.subject ?? "", context: caller.identity?.context ?? {},
      name: target.name, url: target.url, exchange: target.exchange, audience: target.audience,
    })).digest("hex");
  }

  /** The credential for `caller`'s requests to `target`: the one kept while it is fresh, else fetched; callers at once share one fetch. */
  token(caller: ExchangeCaller, target: ExchangeTarget): Promise<string> {
    const key = this.key(caller, target);
    const kept = this.credentials.get(key);
    if (kept && Date.now() < kept.refreshAt) {
      kept.usedAt = Date.now();
      return Promise.resolve(kept.token);
    }
    let fetching = this.fetching.get(key);
    if (!fetching) {
      fetching = this.fetch(caller, target).then(({ token, refreshAt }) => {
        this.credentials.delete(key);
        this.credentials.set(key, { token, refreshAt, usedAt: Date.now() });
        this.trim();
        return token;
      }).finally(() => { this.fetching.delete(key); });
      this.fetching.set(key, fetching);
    }
    return fetching;
  }

  /**
   * The tool server refused `token` (401, 403): forget it, so the next `token` fetches another. Only if it is still the
   * one kept: of many requests refused with the same credential, the first drops it and all share the fetch after.
   */
  refused(caller: ExchangeCaller, target: ExchangeTarget, token: string) {
    const key = this.key(caller, target);
    if (this.credentials.get(key)?.token !== token) return;
    this.credentials.delete(key);
    this.record(caller, target, "rejected", { ms: 0, attempts: 0 });
  }

  /** How many credentials this node holds (tests). */
  get size() { return this.credentials.size; }

  private trim() {
    if (this.credentials.size <= this.limits.entries) return;
    const now = Date.now();
    for (const [key, entry] of this.credentials) if (now >= entry.refreshAt) this.credentials.delete(key);
    const oldest = [...this.credentials].sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [key] of oldest.slice(0, Math.max(0, this.credentials.size - this.limits.entries))) this.credentials.delete(key);
  }

  private record(caller: ExchangeCaller, target: ExchangeTarget, outcome: "fetched" | ExchangeFailure, facts: { ms: number; attempts: number; status?: number; lifeMs?: number }) {
    let host = "";
    try { host = new URL(target.exchange).host; } catch { /* a stored URL that no longer parses */ }
    recordCredentialExchange({ tenant: caller.tenant, agent: caller.agent, definition: caller.definition, server: target.name, host, outcome, ...facts });
  }

  /** Ask the endpoint, a few times if it cannot be reached or answers that it is down, within `totalMs` in all. */
  private async fetch(caller: ExchangeCaller, target: ExchangeTarget): Promise<{ token: string; refreshAt: number }> {
    const started = Date.now();
    const where = `MCP server ${target.name}'s credential exchange (${describe(target.exchange)})`;
    let attempts = 0;
    try {
      if (!this.signer) throw new CredentialExchangeError("unreachable", `${where} cannot be asked: this runtime cannot sign identity tokens`);
      for (;;) {
        attempts++;
        const left = this.limits.totalMs - (Date.now() - started);
        try {
          const credential = await this.attempt(caller, target, where, Math.max(1, Math.min(this.limits.attemptMs, left)));
          this.record(caller, target, "fetched", { ms: Date.now() - started, attempts, lifeMs: credential.lifeMs });
          return credential;
        } catch (error) {
          const failure = error instanceof CredentialExchangeError ? error : new CredentialExchangeError("unreachable", `${where} could not be reached`);
          const wait = this.limits.backoffMs * 3 ** (attempts - 1);
          if (!failure.transient || attempts >= this.limits.attempts || Date.now() - started + wait >= this.limits.totalMs) throw failure;
          await clock().sleep(wait);
        }
      }
    } catch (error) {
      const failure = error as CredentialExchangeError;
      this.record(caller, target, failure.reason, { ms: Date.now() - started, attempts, ...(failure.status ? { status: failure.status } : {}) });
      throw failure;
    }
  }

  private async attempt(caller: ExchangeCaller, target: ExchangeTarget, where: string, timeoutMs: number) {
    // Outside a turn's scope on purpose: the credential outlives the turn and serves every actor of the agent, so its
    // request names the agent and whom it acts for, never one turn's actor, origin or tool call.
    const identity = await this.signer!.token(target.audience, {
      tenant: caller.tenant, agent: caller.agent, ...(caller.definition ? { definition: caller.definition } : {}), ...(caller.identity ? { identity: caller.identity } : {}),
      exchange: { server: target.name, url: target.url },
    });
    // A save lists a definition's servers as the definition itself (no agent yet): the body then names no agent.
    const agent = caller.agent !== caller.definition ? { agent: caller.agent } : {};
    let response: Response;
    let text: string;
    try {
      response = await this.outbound.fetch(target.exchange, {
        method: "POST", timeoutMs, maxBytes: this.limits.responseBytes,
        headers: { "Content-Type": "application/json", Accept: "application/json" }, secrets: { Authorization: `Bearer ${identity}` },
        body: JSON.stringify({ server: { name: target.name, url: target.url }, tenant: caller.tenant, ...(caller.definition ? { definition: caller.definition } : {}), ...agent }),
      });
      text = await response.text();
    } catch (error) {
      const name = (error as Error)?.name, message = (error as Error)?.message ?? "";
      if (name === "OutboundBlocked" && /^No response within/.test(message)) throw new CredentialExchangeError("timeout", `${where} did not answer within ${timeoutMs} ms`);
      // The guard's own words (an address it will not call, a redirect, an answer too large) name no secret.
      if (name === "OutboundBlocked") throw new CredentialExchangeError(/^Response larger|Redirects are not followed|^More than/.test(message) ? "invalid_response" : "blocked", `${where} cannot be used: ${message}`);
      throw new CredentialExchangeError("unreachable", `${where} could not be reached`);
    }
    if (!response.ok) {
      const down = response.status >= 500 || response.status === 408 || response.status === 429;
      throw new CredentialExchangeError(down ? "unavailable" : "refused", `${where} answered HTTP ${response.status}${reasonGiven(text)}`, response.status);
    }
    // From here the body may hold a credential: nothing of it goes into an error.
    let body: { token?: unknown; expiresAt?: unknown; expiresIn?: unknown };
    try { body = JSON.parse(text); } catch { throw new CredentialExchangeError("invalid_response", `${where} did not answer with JSON`); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new CredentialExchangeError("invalid_response", `${where} must answer a JSON object { token, expiresAt | expiresIn }`);
    if (typeof body.token !== "string" || !TOKEN.test(body.token)) throw new CredentialExchangeError("invalid_response", `${where} answered without a usable token: token is 1–8192 printable characters without spaces`);
    const now = Date.now();
    let expiresAt: number;
    if (typeof body.expiresAt === "string" && !Number.isNaN(Date.parse(body.expiresAt))) expiresAt = Date.parse(body.expiresAt);
    else if (typeof body.expiresIn === "number" && Number.isFinite(body.expiresIn)) expiresAt = now + body.expiresIn * 1000;
    else throw new CredentialExchangeError("invalid_response", `${where} must say when the token expires: expiresAt (an RFC 3339 time) or expiresIn (seconds)`);
    if (expiresAt <= now) throw new CredentialExchangeError("expired", `${where} answered a token that has already expired`);
    const lifeMs = Math.min(expiresAt - now, this.limits.maxLifeMs);
    const useMs = Math.max(this.limits.minLifeMs, lifeMs - Math.min(this.limits.refreshMs, lifeMs / 5));
    return { token: body.token, refreshAt: now + useMs, lifeMs };
  }
}

/** An endpoint as errors and people name it: its origin and path, never its query (which a tenant may have put a key in). */
function describe(url: string) {
  try { const { origin, pathname } = new URL(url); return `${origin}${pathname}`; } catch { return "its url"; }
}

/** Why an endpoint says it refused: its JSON answer's `error` (or `message`), shortened; nothing else of its body. */
function reasonGiven(text: string) {
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    const reason = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : undefined;
    return reason ? `: ${reason.replace(/\s+/g, " ").slice(0, 200)}` : "";
  } catch { return ""; }
}

import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.ts";
import { outcomeEnding } from "../shared/client-protocol.ts";

/** What a browser token may read of its one agent. */
export const BROWSER_SCOPES = ["events", "state", "history", "inputs"] as const;
export type BrowserScope = typeof BROWSER_SCOPES[number];
/** Fields a token may hide from its reader. */
export const BROWSER_REDACTIONS = ["usage.cost"] as const;
/** Events a browser never gets unless its token lists them: the runtime's own bookkeeping. */
const INTERNAL_EVENTS = new Set(["codemode", "compaction_usage", "spend_limit_reached"]);
/** A token lives this long by default, and between these bounds (seconds). */
export const BROWSER_TOKEN_SECONDS = { default: 900, min: 5, max: 3600 };
const PREFIX = "abt_";

/**
 * What a browser token grants: reading one agent of one tenant (`scopes` of its routes), until
 * `exp` (ms). `events` limits which of its events it gets; `redact` hides fields; `sub` says whom
 * the tenant minted it for (its own user id), for logs.
 */
export type BrowserClaims = { v: 1; tenant: string; agent: string; scopes: BrowserScope[]; events?: string[]; redact?: string[]; sub?: string; exp: number };

/**
 * Stateless, short-lived, read-only tokens for one agent, which a tenant mints for its users'
 * browsers. They are HMACs under a key derived from the session secret every node shares: only the
 * runtime reads them, so nothing needs publishing, and a check costs no database read. Nothing is
 * stored and nothing is revoked: the short lifetime is the revocation.
 */
export class BrowserTokens {
  private readonly key: Buffer;
  constructor(secret: string) { this.key = createHmac("sha256", secret).update("agent-runtime:browser-tokens:v1").digest(); }

  private mac(payload: string) { return createHmac("sha256", this.key).update(payload).digest("base64url"); }

  /** Mint a token for `agent` of `tenant` from a request's body (checked here: 400 for anything else). */
  mint(tenant: string, agent: string, input: unknown): { token: string; expiresAt: number } {
    const body = (input ?? {}) as Record<string, unknown>;
    if (typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Send { ttlSeconds?, scopes?, events?, redact?, subject? }");
    const unknown = Object.keys(body).filter(key => !["ttlSeconds", "scopes", "events", "redact", "subject"].includes(key));
    if (unknown.length) throw new HttpError(400, `Unknown field ${unknown[0]}`);
    const ttl = body.ttlSeconds ?? BROWSER_TOKEN_SECONDS.default;
    if (!Number.isInteger(ttl) || (ttl as number) < BROWSER_TOKEN_SECONDS.min || (ttl as number) > BROWSER_TOKEN_SECONDS.max) throw new HttpError(400, `ttlSeconds must be ${BROWSER_TOKEN_SECONDS.min}–${BROWSER_TOKEN_SECONDS.max}`);
    const list = (name: string, value: unknown, allowed?: readonly string[]) => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== "string" || !item || item.length > 64 || (allowed && !allowed.includes(item)))) {
        throw new HttpError(400, allowed ? `${name} must be a list of ${allowed.join(", ")}` : `${name} must be a list of at most 64 names`);
      }
      return [...new Set(value as string[])];
    };
    const scopes = (list("scopes", body.scopes, BROWSER_SCOPES) ?? [...BROWSER_SCOPES]) as BrowserScope[];
    if (!scopes.length) throw new HttpError(400, "scopes must name at least one of events, state, history, inputs");
    const events = list("events", body.events);
    const redact = list("redact", body.redact, BROWSER_REDACTIONS);
    if (body.subject !== undefined && (typeof body.subject !== "string" || !body.subject || body.subject.length > 200)) throw new HttpError(400, "subject must be a string of at most 200 characters");
    const claims: BrowserClaims = {
      v: 1, tenant, agent, scopes, ...(events ? { events } : {}), ...(redact?.length ? { redact } : {}),
      ...(body.subject !== undefined ? { sub: body.subject as string } : {}), exp: Date.now() + (ttl as number) * 1000,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return { token: `${PREFIX}${payload}.${this.mac(payload)}`, expiresAt: claims.exp };
  }

  /** Whether an Authorization header carries a browser token (checked or not). */
  static carries(authorization: string | undefined) { return !!authorization?.startsWith(`Bearer ${PREFIX}`); }

  /** The claims of a Bearer browser token whose signature holds and which has not expired (401 otherwise). */
  verify(authorization: string): BrowserClaims {
    const [payload, mac, ...rest] = authorization.slice(`Bearer ${PREFIX}`.length).split(".");
    const expected = payload ? Buffer.from(this.mac(payload)) : undefined;
    if (rest.length || !expected || !mac || expected.length !== mac.length || !timingSafeEqual(expected, Buffer.from(mac))) throw new HttpError(401, "Invalid browser token");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as BrowserClaims;
    if (claims.v !== 1 || !(claims.exp > Date.now())) throw new HttpError(401, "This browser token has expired; mint a new one");
    return claims;
  }
}

/** A value without the `cost` of any `usage` in it, however deep: messages, and whatever holds them (agent_end's, turn_end's). */
function withoutCost(value: any): any {
  if (Array.isArray(value)) return value.map(withoutCost);
  if (!value || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "usage" && item && typeof item === "object" && !Array.isArray(item)) { const { cost: _cost, ...usage } = item as Record<string, unknown>; copy[key] = withoutCost(usage); }
    else copy[key] = withoutCost(item);
  }
  return copy;
}

/** A message (or anything holding messages) as a token's reader may see it. */
export function readableMessage(claims: BrowserClaims, message: unknown) {
  return claims.redact?.includes("usage.cost") ? withoutCost(message) : message;
}

/**
 * An event-stream frame as a browser token's reader may see it, or undefined to leave it out: the
 * runtime's own events never (unless the token lists them), events outside its list never, and a
 * run's outcome only as whether and why it stopped.
 */
export function readableFrame(claims: BrowserClaims, data: any): unknown {
  if (data?.type === "response") {
    return { type: "response", id: data.id, outcome: outcomeEnding(data.outcome) };
  }
  if (data?.type === "snapshot") {
    // Its turn's messages are what history, or the stream's message_ends, would show; its message streaming, what message_updates would.
    const lists = (type: string) => !claims.events || claims.events.includes(type);
    if (!data.turn) return data;
    const messages = claims.scopes.includes("history") || lists("message_end");
    if (!messages) return { ...data, turn: null };
    return readableMessage(claims, { ...data, turn: { ...data.turn, partial: lists("message_update") ? data.turn.partial : null } });
  }
  if (data?.type !== "event") return undefined;
  const type = data.event?.type;
  if (claims.events ? !claims.events.includes(type) : INTERNAL_EVENTS.has(type)) return undefined;
  return readableMessage(claims, data);
}

/** A request as a browser token's reader may see it (`/state`): what it is and how it ended (its error, the model's included, and early stop), not its parameters or result. */
export function readableRequest(record: { id: string; method: string; state: string; startedAt?: number; began?: number; endedAt?: number; outcome?: any }) {
  const { id, method, state, startedAt, began, endedAt, outcome } = record;
  const ending = outcomeEnding(outcome);
  return { id, method, state, ...(startedAt ? { startedAt } : {}), ...(began ? { began } : {}), ...(endedAt ? { endedAt } : {}),
    ...(outcome ? { ...ending, outcome: ending } : {}) };
}

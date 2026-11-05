import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createHash } from "node:crypto";
import { canonical } from "../../../shared/durable-json.ts";
import { signRuntimeIdentity, type IdentityEnv, type RuntimeIdentity } from "./tool-identity.ts";
import { EXCHANGE_LIMITS, TOKEN, describe, reasonGiven } from "./exchange-policy.ts";

export class CredentialExchangeError extends Error {
  readonly code = "source_unavailable";
  readonly reason: string;
  readonly status?: number;
  constructor(reason: string, message: string, status?: number) { super(message); this.name = "CredentialExchangeError"; this.reason = reason; this.status = status; }
}
export type ExchangeAuth = { type: "exchange"; url: string; audience?: string };
type FetchExchange = (url: string, init: RequestInit, max: number) => Promise<{ response: Response; text: string }>;
type CachedCredential = { token: string; refreshAt: number; usedAt: number };
// An agent's registry is rebuilt on configuration and explicit refresh. Like
// src/CredentialExchange, credentials outlive those listings and individual turns.
const credentials = new Map<string, CachedCredential>();
const fetching = new Map<string, Promise<CachedCredential>>();
function trim() {
  if (credentials.size <= EXCHANGE_LIMITS.entries) return;
  for (const [key, value] of credentials) if (value.refreshAt <= Date.now()) credentials.delete(key);
  const oldest = [...credentials].sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [key] of oldest.slice(0, Math.max(0, credentials.size - EXCHANGE_LIMITS.entries))) credentials.delete(key);
}

/** Credentials are cached for this source of this agent only, never for a user or another agent. */
export function credentialExchange(env: IdentityEnv, source: { name: string; url: string; auth: ExchangeAuth }, identity: (api?: ToolExecutionApi) => Promise<{ issuer: string; claims: RuntimeIdentity }>, fetcher: FetchExchange) {
  let last: { key: string; token: string } | undefined;
  const load = async ({ issuer, claims }: { issuer: string; claims: RuntimeIdentity }) => {
    const where = `MCP server ${source.name}'s credential exchange (${describe(source.auth.url)})`;
    const token = await signRuntimeIdentity(env, issuer, source.auth.audience ?? source.auth.url, {
      tenant: claims.tenant, agent: claims.agent, ...(claims.definition ? { definition: claims.definition } : {}),
      ...(claims.sub ? { sub: claims.sub } : {}), ...(claims.ctx ? { ctx: claims.ctx } : {}), exchange: { server: source.name, url: source.url },
    });
    const started = Date.now();
    let response: Response | undefined, text = "";
    for (let attempt = 0; attempt < EXCHANGE_LIMITS.attempts; attempt++) {
      try {
        const result = await fetcher(source.auth.url, {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ server: { name: source.name, url: source.url }, tenant: claims.tenant, ...(claims.definition ? { definition: claims.definition } : {}), ...(claims.agent !== claims.definition ? { agent: claims.agent } : {}) }),
          signal: AbortSignal.timeout(Math.max(1, Math.min(EXCHANGE_LIMITS.attemptMs, EXCHANGE_LIMITS.totalMs - (Date.now() - started)))),
        }, EXCHANGE_LIMITS.responseBytes);
        response = result.response; text = result.text;
        if (response.ok || response.status < 500 && ![408, 429].includes(response.status)) break;
      } catch {
        if (attempt === EXCHANGE_LIMITS.attempts - 1) throw new CredentialExchangeError("unreachable", `${where} could not be reached`);
      }
      const delay = EXCHANGE_LIMITS.backoffMs * 2 ** attempt;
      if (Date.now() - started + delay >= EXCHANGE_LIMITS.totalMs) break;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    if (!response?.ok) throw new CredentialExchangeError(response && (response.status >= 500 || [408, 429].includes(response.status)) ? "unavailable" : "refused", `${where} answered HTTP ${response?.status ?? "unavailable"}${reasonGiven(text)}`, response?.status);
    let body: { token?: unknown; expiresAt?: unknown; expiresIn?: unknown };
    try { body = JSON.parse(text); } catch { throw new CredentialExchangeError("invalid_response", `${where} did not answer with JSON`); }
    if (!body || typeof body !== "object" || typeof body.token !== "string" || !TOKEN.test(body.token)) throw new CredentialExchangeError("invalid_response", `${where} answered without a usable token`);
    const now = Date.now(), expiresAt = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : typeof body.expiresIn === "number" && Number.isFinite(body.expiresIn) ? now + body.expiresIn * 1000 : NaN;
    if (!Number.isFinite(expiresAt)) throw new CredentialExchangeError("invalid_response", `${where} must say when the token expires: expiresAt (an RFC 3339 time) or expiresIn (seconds)`);
    if (expiresAt <= now) throw new CredentialExchangeError("expired", `${where} answered a token that has already expired`);
    const lifeMs = Math.min(expiresAt - now, EXCHANGE_LIMITS.maxLifeMs);
    return { token: body.token, refreshAt: now + Math.max(EXCHANGE_LIMITS.minLifeMs, lifeMs - Math.min(EXCHANGE_LIMITS.refreshMs, lifeMs / 5)) };
  };
  return {
    async headers(api?: ToolExecutionApi) {
      const caller = await identity(api), { issuer, claims } = caller;
      const key = createHash("sha256").update(canonical({
        database: env.HYPERDRIVE.connectionString, issuer,
        tenant: claims.tenant, agent: claims.agent, definition: claims.definition ?? "",
        subject: claims.sub ?? "", context: claims.ctx ?? {}, name: source.name,
        url: source.url, exchange: source.auth.url, audience: source.auth.audience ?? source.auth.url,
      })).digest("hex");
      let cached = credentials.get(key);
      if (!cached || cached.refreshAt <= Date.now()) {
        let pending = fetching.get(key);
        if (!pending) {
          pending = load(caller).then(value => {
            const entry = { ...value, usedAt: Date.now() };
            credentials.set(key, entry);
            trim();
            return entry;
          }).finally(() => fetching.delete(key));
          fetching.set(key, pending);
        }
        cached = await pending;
      }
      cached.usedAt = Date.now();
      last = { key, token: cached.token };
      return { Authorization: `Bearer ${cached.token}` };
    },
    refused() {
      if (last && credentials.get(last.key)?.token === last.token) credentials.delete(last.key);
    },
  };
}

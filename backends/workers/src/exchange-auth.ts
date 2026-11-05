import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { signRuntimeIdentity, type IdentityEnv, type RuntimeIdentity } from "./tool-identity.ts";
import { EXCHANGE_LIMITS, TOKEN } from "./exchange-policy.ts";

export class CredentialExchangeError extends Error {
  readonly code = "source_unavailable";
  readonly reason: string;
  readonly status?: number;
  constructor(reason: string, message: string, status?: number) { super(message); this.name = "CredentialExchangeError"; this.reason = reason; this.status = status; }
}
export type ExchangeAuth = { type: "exchange"; url: string; audience?: string };
type FetchExchange = (url: string, init: RequestInit, max: number) => Promise<{ response: Response; text: string }>;

/** Credentials are cached for this source of this agent only, never for a user or another agent. */
export function credentialExchange(env: IdentityEnv, source: { name: string; url: string; auth: ExchangeAuth }, identity: (api?: ToolExecutionApi) => Promise<{ issuer: string; claims: RuntimeIdentity }>, fetcher: FetchExchange) {
  let cached: { token: string; refreshAt: number } | undefined, pending: Promise<{ token: string; refreshAt: number }> | undefined;
  const load = async (api?: ToolExecutionApi) => {
    const { issuer, claims } = await identity(api), where = `MCP server ${source.name}'s credential exchange`;
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
    if (!response?.ok) throw new CredentialExchangeError(response && (response.status >= 500 || [408, 429].includes(response.status)) ? "unavailable" : "refused", `${where} answered HTTP ${response?.status ?? "unavailable"}`, response?.status);
    let body: { token?: unknown; expiresAt?: unknown; expiresIn?: unknown };
    try { body = JSON.parse(text); } catch { throw new CredentialExchangeError("invalid_response", `${where} did not answer with JSON`); }
    if (!body || typeof body !== "object" || typeof body.token !== "string" || !TOKEN.test(body.token)) throw new CredentialExchangeError("invalid_response", `${where} answered without a usable token`);
    const now = Date.now(), expiresAt = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : typeof body.expiresIn === "number" && Number.isFinite(body.expiresIn) ? now + body.expiresIn * 1000 : NaN;
    if (!Number.isFinite(expiresAt)) throw new CredentialExchangeError("invalid_response", `${where} must say when the token expires`);
    if (expiresAt <= now) throw new CredentialExchangeError("expired", `${where} answered a token that has already expired`);
    const lifeMs = Math.min(expiresAt - now, EXCHANGE_LIMITS.maxLifeMs);
    return { token: body.token, refreshAt: now + Math.max(EXCHANGE_LIMITS.minLifeMs, lifeMs - Math.min(EXCHANGE_LIMITS.refreshMs, lifeMs / 5)) };
  };
  return {
    async headers(api?: ToolExecutionApi) {
      if (!cached || cached.refreshAt <= Date.now()) {
        pending ??= load(api).finally(() => { pending = undefined; });
        cached = await pending;
      }
      return { Authorization: `Bearer ${cached.token}` };
    },
    refused() { cached = undefined; },
  };
}

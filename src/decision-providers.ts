import type { Outbound } from "./outbound.ts";
import { DecisionFailed, type DecisionProvider } from "./decisions.ts";
import { DECISION_LIMITS } from "./limits.ts";
import { safeError } from "./metrics.ts";

/**
 * OpenRouter's Decisions API (alpha): `POST /api/alpha/decisions` with TypeSafe's own body, `{model, state, questions}`,
 * answering `{model, answers, usage: {input_tokens, output_tokens, cost}, id, provider}`. Checked with a live call on
 * 2026-10-28 (typesafe/jev-1.14: 200 in 0.3 s, answers in TypeSafe's format, `usage.cost` in USD, the model as its dated
 * version). Being alpha, it may move or change shape: a 404 or 410 says decisions are unavailable, and an answer this
 * cannot read is a 502 that names what was missing, never a crash. Neither the state nor a provider's error detail that
 * may quote it is logged.
 *
 * Always OpenRouter's own address: a key scope's `baseUrl` (a chat gateway) and headers are for its model calls, not
 * this API. `dataPolicy`: whether `provider.data_collection: "deny"` is sent, which OpenRouter's docs do not yet say the
 * decisions API takes (off until a live call shows it does; agents that deny data collection are refused meanwhile).
 */
export function openrouterDecisions(options: { outbound: Outbound; baseUrl?: string; timeoutMs?: number; dataPolicy?: boolean }): DecisionProvider {
  const { outbound, baseUrl = "https://openrouter.ai/api/alpha", timeoutMs = DECISION_LIMITS.callTimeoutMs, dataPolicy = false } = options;
  return {
    id: "openrouter",
    dataPolicy,
    async decide(item, model, credentials, signal, policy) {
      const url = `${baseUrl.replace(/\/+$/, "")}/decisions`;
      const provider = dataPolicy && policy?.dataCollection === "deny" ? { provider: { data_collection: "deny" } } : {};
      let response: Response;
      try {
        response = await outbound.fetch(url, {
          method: "POST", body: JSON.stringify({ model, state: item.state, questions: item.questions, ...provider }),
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          secrets: credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {}, timeoutMs, maxBytes: 1024 * 1024, signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new DecisionFailed(502, `OpenRouter could not be reached for a decision (${safeError(error)})`, { transient: true });
      }
      if (!response.ok) {
        const status = response.status;
        const detail = await response.json().then(errorDetail, () => "");
        const said = `HTTP ${status}${detail ? `: ${detail}` : ""}`;
        if (status === 400 || status === 422) throw new DecisionFailed(400, `OpenRouter refused the decision request (${said})`, { code: "DECISION_REFUSED" });
        if (status === 413) throw new DecisionFailed(413, `The state and questions are too large for ${model} (${said})`, { code: "DECISION_TOO_LARGE" });
        if (status === 401 || status === 403) throw new DecisionFailed(502, `OpenRouter rejected the API key (HTTP ${status})`);
        if (status === 402) throw new DecisionFailed(502, "OpenRouter has no credit left on this key (HTTP 402)");
        if (status === 404 || status === 410) throw new DecisionFailed(502, `OpenRouter's decisions API or ${model} is not available (HTTP ${status}): it is in alpha and may have moved`, { code: "DECISIONS_UNAVAILABLE" });
        const transient = status === 408 || status === 429 || status >= 500;
        const retryAfterMs = transient ? retryAfter(response.headers.get("retry-after")) : undefined;
        throw new DecisionFailed(502, `OpenRouter failed the decision (HTTP ${status})`, { transient, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
      }
      const body: any = await response.json().catch(() => undefined);
      if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object") throw new DecisionFailed(502, "OpenRouter answered the decision without answers: its alpha API may have changed shape");
      const usage = body.usage ?? {};
      const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
      const cost = typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined;
      return {
        answers: body.answers, ...(typeof body.model === "string" ? { model: body.model } : {}),
        inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens), ...(cost !== undefined ? { costUsd: cost } : {}),
      };
    },
  };
}

/**
 * What a provider's error body says, without echoing the request: OpenRouter's `error.message`, or TypeSafe's `detail`
 * (a string, or validation errors whose `loc` and `msg` are kept and whose `input` is not).
 */
function errorDetail(body: any): string {
  if (typeof body?.error?.message === "string") return body.error.message.slice(0, 300);
  if (typeof body?.detail === "string") return body.detail.slice(0, 300);
  if (Array.isArray(body?.detail)) {
    return body.detail.slice(0, 5).map((entry: any) => `${Array.isArray(entry?.loc) ? entry.loc.join(".") : "?"}: ${typeof entry?.msg === "string" ? entry.msg : "invalid"}`).join("; ").slice(0, 300);
  }
  return "";
}

/** Retry-After as ms: seconds, or an HTTP date; at most a minute. */
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(60_000, Math.max(0, ms)) : undefined;
}

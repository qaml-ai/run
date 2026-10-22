import { GetWebIdentityTokenCommand, STSClient } from "@aws-sdk/client-sts";
import { metricLine } from "./metrics.ts";
import type { Credentials } from "./protocol.ts";

const IDS = ["FEDERATION_RULE_ID", "ORGANIZATION_ID", "SERVICE_ACCOUNT_ID", "WORKSPACE_ID"] as const;
export type AnthropicFederationConfig = {
  federation_rule_id: string; organization_id: string; service_account_id: string; workspace_id: string; region: string;
};
type Event = { type: "anthropic_federation_exchange" | "anthropic_federation_fallback"; ok: boolean; ms?: number; expires_in?: number; error_class?: string };
type Options = {
  sts?: { send(command: GetWebIdentityTokenCommand, options: { abortSignal: AbortSignal }): Promise<{ WebIdentityToken?: string }> };
  fetch?: typeof fetch;
  now?: () => number;
  log?: (event: Event) => void;
};

/** Even partial configuration enables the provider: a bad rollout must still use the static fallback. */
export function anthropicFederationFromEnvironment(env: NodeJS.ProcessEnv): AnthropicFederation | undefined {
  const values = IDS.map(id => env[`AGENT_ANTHROPIC_${id}`]?.trim() ?? "");
  if (!values.some(Boolean)) return undefined;
  return new AnthropicFederation({ federation_rule_id: values[0], organization_id: values[1], service_account_id: values[2], workspace_id: values[3],
    region: env.AGENT_ANTHROPIC_FEDERATION_STS_REGION?.trim() || env.AWS_REGION?.trim() || "us-west-2" });
}

/** Fixed error classes only. Neither upstream error messages nor token endpoint bodies may escape into logs. */
class FederationError extends Error {
  readonly errorClass: string;
  constructor(errorClass: string) { super(`Anthropic federation failed (${errorClass})`); this.errorClass = errorClass; }
}
const emit = (event: Event) => console.log(metricLine(event.type, {
  dimensions: { outcome: event.ok ? "ok" : "error" }, rollups: [[]],
  metrics: { AnthropicFederationExchanges: event.type === "anthropic_federation_exchange" ? 1 : undefined,
    AnthropicFederationFailures: event.type === "anthropic_federation_exchange" && !event.ok ? 1 : undefined,
    AnthropicFederationFallbacks: event.type === "anthropic_federation_fallback" ? 1 : undefined, ms: event.ms === undefined ? undefined : [event.ms, "Milliseconds"] },
  properties: event,
}));

/** One per node. Each exchange gets a new STS JWT; only the Anthropic access token is cached. */
export class AnthropicFederation {
  private cached?: { token: string; expires: number };
  private refreshing?: Promise<string>;
  private retryAfter = 0;
  private readonly now: () => number;
  private readonly log: (event: Event) => void;
  private sts?: Options["sts"];
  constructor(privateConfig: AnthropicFederationConfig, options: Options = {}) {
    this.config = privateConfig;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? emit;
    this.sts = options.sts;
  }
  private readonly config: AnthropicFederationConfig;
  private readonly options: Options;

  async credentials(fallback?: string): Promise<Credentials> {
    try { return { apiKey: await this.token(), bearer: true }; }
    catch (error) {
      if (!fallback) throw error;
      this.log({ type: "anthropic_federation_fallback", ok: false, error_class: (error as FederationError).errorClass });
      return { apiKey: fallback };
    }
  }

  private async token(): Promise<string> {
    const remaining = (this.cached?.expires ?? 0) - this.now();
    if (this.cached && remaining > 30_000) {
      if (remaining <= 120_000 && this.now() >= this.retryAfter) void this.refresh().catch(() => {});
      return this.cached.token;
    }
    // Inside the last 30 seconds, all callers wait for the same refresh. Never serve the old token here.
    return this.refresh();
  }

  private refresh(): Promise<string> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.exchange().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async exchange(): Promise<string> {
    const started = this.now();
    let stage = "ConfigurationError";
    try {
      const { region, ...ids } = this.config;
      if (!Object.values(ids).every(Boolean) || !/^[a-z0-9-]+$/.test(region)) throw new FederationError(stage);
      // Pin the regional endpoint: GetWebIdentityToken is not available on sts.amazonaws.com.
      this.sts ??= new STSClient({ region, endpoint: `https://sts.${region}.amazonaws.com`, maxAttempts: 1 });
      stage = "StsError";
      const signal = AbortSignal.timeout(10_000);
      const result = await this.sts.send(new GetWebIdentityTokenCommand({ Audience: ["https://api.anthropic.com"], SigningAlgorithm: "RS256", DurationSeconds: 900 }), { abortSignal: signal });
      if (!result.WebIdentityToken) throw new FederationError("StsResponseError");
      stage = "TokenEndpointError";
      // No retries with this assertion: JWTs containing jti are single-use, even after an ambiguous failure.
      const response = await (this.options.fetch ?? fetch)("https://api.anthropic.com/v1/oauth/token", {
        method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal,
        body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: result.WebIdentityToken, ...ids }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new FederationError(stage); }
      stage = "TokenResponseError";
      const body = await response.json() as { access_token?: unknown; expires_in?: unknown };
      if (typeof body.access_token !== "string" || !body.access_token.startsWith("sk-ant-oat01-") || typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 30) throw new FederationError(stage);
      const expires = started + body.expires_in * 1000;
      if (expires <= this.now() + 30_000) throw new FederationError(stage);
      this.cached = { token: body.access_token, expires };
      this.retryAfter = 0;
      this.log({ type: "anthropic_federation_exchange", ok: true, ms: this.now() - started, expires_in: body.expires_in });
      return body.access_token;
    } catch (error) {
      const safe = error instanceof FederationError ? error : new FederationError(stage);
      this.retryAfter = this.now() + 10_000;
      this.log({ type: "anthropic_federation_exchange", ok: false, ms: this.now() - started, error_class: safe.errorClass });
      throw safe;
    }
  }
}

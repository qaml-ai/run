import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The few Stripe calls credit purchases need, over plain fetch against the REST API
 * (form-encoded requests, JSON answers), and webhook signature checks. The secret key
 * and webhook signing secret come from AGENT_STRIPE_SECRET_ARN or STRIPE_SECRET_KEY
 * and STRIPE_WEBHOOK_SECRET (src/secrets.ts).
 */
export interface StripeOptions { secretKey: string; webhookSecret: string; apiUrl?: string; portalConfiguration?: string }
export const STRIPE_API_VERSION = "2026-08-26.dahlia";
export class StripeError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  constructor(status: number, value: any, requestId?: string) {
    super(`Stripe answered HTTP ${status}: ${value?.error?.message ?? "no detail"}`);
    this.name = "StripeError";
    this.status = status;
    this.code = value?.error?.code;
    this.requestId = requestId;
  }
}
/** A webhook signed longer ago than this is refused, so a captured one cannot be replayed later. */
const TOLERANCE_SECONDS = 300;

/** Nested parameters as Stripe's form encoding: `line_items[0][price_data][currency]=usd`. */
export function formEncode(params: Record<string, unknown>) {
  const form = new URLSearchParams();
  const add = (prefix: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((item, index) => add(`${prefix}[${index}]`, item));
    else if (typeof value === "object") for (const [key, item] of Object.entries(value)) add(prefix ? `${prefix}[${key}]` : key, item);
    else form.append(prefix, String(value));
  };
  add("", params);
  return form;
}

export class Stripe {
  private readonly options: StripeOptions;
  constructor(options: StripeOptions) {
    if (!/^(sk|rk)_(test|live)_/.test(options.secretKey)) throw new Error("The Stripe secret key must be a secret (sk_) or restricted (rk_) key");
    if (!options.webhookSecret.startsWith("whsec_")) throw new Error("The Stripe webhook secret must be a signing secret (whsec_...)");
    if (options.portalConfiguration && !/^bpc_[A-Za-z0-9]+$/.test(options.portalConfiguration)) throw new Error("AGENT_STRIPE_PORTAL_CONFIGURATION must be a Stripe portal configuration id");
    this.options = options;
  }

  get live() { return this.options.secretKey.includes("_live_"); }
  get portalConfiguration() { return this.options.portalConfiguration; }

  get<T = any>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.request("GET", path, params);
  }

  /** POST to the Stripe API; `idempotencyKey` makes a retried create return the first result. */
  async post<T = any>(path: string, params: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    return this.request("POST", path, params, idempotencyKey);
  }

  private async request<T>(method: "GET" | "POST", path: string, params: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    if (!path.startsWith("/v1/") || path.includes("?") || path.includes("#")) throw new Error("Expected a Stripe API path");
    const url = new URL(path, this.options.apiUrl ?? "https://api.stripe.com");
    const form = formEncode(params);
    if (method === "GET") url.search = form.toString();
    const response = await fetch(url, {
      method, ...(method === "POST" ? { body: form } : {}), signal: AbortSignal.timeout(15_000), redirect: "error",
      headers: {
        Authorization: `Bearer ${this.options.secretKey}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": STRIPE_API_VERSION,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
    });
    const value = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new StripeError(response.status, value, response.headers.get("request-id") ?? undefined);
    return value as T;
  }

  /**
   * The event in a webhook request, if `signature` (the Stripe-Signature header,
   * `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<payload>">`, one v1 per active
   * secret) verifies and is recent; undefined otherwise.
   */
  verify(payload: string, signature: string | undefined, now = Date.now()): { id: string; type: string; livemode?: boolean; data: { object: any } } | undefined {
    const parts = (signature ?? "").split(",").map(part => part.trim().split("="));
    const timestamp = parts.find(([key]) => key === "t")?.[1];
    if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return undefined;
    const expected = createHmac("sha256", this.options.webhookSecret).update(`${timestamp}.${payload}`).digest();
    const valid = parts.some(([key, value]) => {
      if (key !== "v1" || !/^[a-f0-9]{64}$/.test(value ?? "")) return false;
      return timingSafeEqual(expected, Buffer.from(value, "hex"));
    });
    if (!valid) return undefined;
    try { return JSON.parse(payload); } catch { return undefined; }
  }
}

/** A Stripe-Signature header for `payload`, as Stripe computes it (tests and the local fake). */
export function signWebhook(secret: string, payload: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")}`;
}

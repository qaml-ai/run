import { runtimeSigner, type IdentityEnv } from "../tool-identity.ts";
import type { TierClaims } from "./claims.ts";

export type TierEnv = IdentityEnv & { CAMELFS_URL?: string };

// TEMPORARY(R5)
export const tierConfigured = (env: { CAMELFS_URL?: string }) => env.CAMELFS_URL !== undefined;

export class TierError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly op: string;
  constructor(status: number, code: string, message: string, details: unknown, op: string, cause?: unknown) {
    super(message, { cause });
    this.name = "TierError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.op = op;
  }
}

type TierRequest = {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  claims: TierClaims;
  idempotencyKey?: string;
  timeoutMs?: number;
};

export async function tierFetch(env: TierEnv, request: TierRequest, raw?: RequestInit): Promise<Response> {
  const { method, path, claims, body, idempotencyKey, timeoutMs = 30_000 } = request;
  const op = `${method} ${path}`;
  let stage = "url";
  let response: Response;
  try {
    const signal = raw?.signal ?? AbortSignal.timeout(timeoutMs);
    const origin = new URL(env.CAMELFS_URL!);
    const url = new URL(path, origin);
    if (origin.origin !== url.origin || !path.startsWith("/")) throw new Error("Invalid camelFS path");
    for (const [key, value] of Object.entries(request.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    stage = "sign";
    const issuer = env.AGENT_PUBLIC_URL;
    if (!issuer) throw new Error("AGENT_PUBLIC_URL is required for camelFS");
    const token = await (await runtimeSigner(env, issuer, issuer)).camelfsToken(claims);
    const headers = new Headers(raw?.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (body !== undefined) headers.set("content-type", "application/json");
    if (idempotencyKey !== undefined) headers.set("Idempotency-Key", idempotencyKey);
    stage = "fetch";
    response = await fetch(url, { method, headers, signal, redirect: "manual", body: raw?.body ?? JSON.stringify(body) });
  } catch (cause) {
    const message = stage === "fetch" ? "camel-fs tier unreachable" : `camel-fs tier request failed at ${stage}`;
    throw new TierError(502, "transport_error", message, { stage }, op, cause);
  }
  // workerd only supports manual and follow. Keep the token on the configured origin.
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    void response.body?.cancel().catch(() => {});
    throw new TierError(502, "transport_error", "camel-fs tier returned a redirect", { stage: "fetch", status: response.status }, op);
  }
  return response;
}

export async function tierRequest<T>(env: TierEnv, request: TierRequest): Promise<T> {
  const response = await tierFetch(env, request);
  const op = `${request.method} ${request.path}`;
  if (response.status === 204) return undefined as T;
  let value: { error?: string | { code?: string; message?: string; details?: unknown } } | null;
  try { value = await response.json() as typeof value; }
  catch { throw new TierError(response.ok ? 502 : response.status, "invalid_response", "Invalid camelFS response", undefined, op); }
  if (response.ok) return value as T;
  const error = value?.error;
  if (typeof error === "string") throw new TierError(response.status, error, error, undefined, op);
  const code = typeof error?.code === "string" ? error.code : "invalid_response";
  const message = typeof error?.message === "string" ? error.message : "Invalid camelFS response";
  throw new TierError(response.status, code, message, error?.details, op);
}

import type { CreditStop } from "./model-attempt.ts";

/** The source host's creditStop/refusalStop fields, retained across the Pi boundary. */
export type BillingRunStop = {
  error: string;
  code: "spend_limit" | "end_user_credit";
  stopped: "spend_limit";
  limit?: "agent" | "run" | "tenant" | "credit" | "end_user";
  reason?: string;
  bucket?: string;
  endUser?: string;
};

export function creditRunStop(stop: CreditStop): BillingRunStop {
  return stop.endUser
    ? { error: stop.message, stopped: "spend_limit", code: "end_user_credit", limit: "end_user", reason: stop.reason, bucket: stop.bucket, endUser: stop.endUser }
    : { error: stop.message, stopped: "spend_limit", code: "spend_limit", limit: "credit" };
}

export function billingRunStop(error: unknown): BillingRunStop | undefined {
  const value = error as { status?: number; code?: string; message?: string; stopLimit?: "agent" | "run"; details?: Record<string, unknown> } | undefined;
  if (!value?.message) return;
  // The source host also stops the current turn at the free-credit hourly
  // ceiling; only admission exposes that ceiling as HTTP 429.
  if (value.status === 429 && value.code === undefined)
    return { error: value.message, stopped: "spend_limit", code: "spend_limit", limit: "credit" };
  if (value.status !== 402) return;
  if (value.code === "END_USER_CREDIT") {
    const details = value.details ?? {};
    return { error: value.message, stopped: "spend_limit", code: "end_user_credit", limit: "end_user",
      ...(typeof details.reason === "string" ? { reason: details.reason } : {}),
      ...(typeof details.bucket === "string" ? { bucket: details.bucket } : {}),
      ...(typeof details.endUser === "string" ? { endUser: details.endUser } : {}) };
  }
  if (value.code === "INSUFFICIENT_CREDIT") return creditRunStop({ message: value.message, reason: "balance" });
  if (value.code === "SPEND_LIMIT") return { error: value.message, stopped: "spend_limit", code: "spend_limit", ...(value.stopLimit ? { limit: value.stopLimit } : {}) };
}

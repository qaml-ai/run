// Generated from src/model-attempt.ts; infrastructure imports only.
/** The host can describe usage, but never chooses the tenant, key owner or billing policy. */
/** Begin records the input estimate and the runtime-selected payer. Progress keeps the attempt active. */
export type ModelAttemptEvent =
  | { type: "begin"; id: string; provider: string; model: string; kind: "response" | "compaction"; at: number; keyHash: string; reconciliationDisabled?: string; reconciliationEligible?: boolean; context?: Pick<import("./money-host.ts").UsageRecord, "requestId" | "actor" | "identity" | "keyScope" | "bucket">; estimate?: AttemptEstimate; endUser?: { id: string; bucket: string } }
  | { type: "generation"; id: string; generation: string }
  | { type: "progress"; id: string; chars: number }
  /**
   * `superseded`: why the call's response is not the answer (`content_filter`: its provider's filter blocked it;
   * `unavailable`: a virtual model's member could not take it), and the request is made again on another model
   * (model-fallback.ts). Recorded for the platform's books; never charged, and no response in the tenant's usage.
   */
  | { type: "finish"; id: string; usage: Record<string, any>; chars: number; completed: boolean; superseded?: Superseded };
/** Why a call's response was replaced by another call's (see `finish`). */
export type Superseded = "content_filter" | "unavailable";
export type AttemptEstimate = { inputTokens: number; cachedTokens?: number; maxOutputTokens: number; rates: { input: number; output: number; cacheRead?: number } };
/** Acknowledgment of an attempt and any admission refusal. */
export type AttemptAck = { tracked: boolean; refused?: CreditStop };
/** An end user's credit refusing a call: what to say, why (`balance`, `daily_limit`, `bucket_limit`), whose and which bucket; or, with no `endUser`, the tenant's own credit. */
export type CreditStop = { message: string; reason: string; endUser?: string; bucket?: string };
export type ModelAttemptHook = (event: ModelAttemptEvent) => Promise<boolean | AttemptAck>;
/** An acknowledgment as a whole, from either form. */
export const attemptAck = (ack: boolean | AttemptAck | undefined): AttemptAck => typeof ack === "object" ? ack : { tracked: !!ack };
/** The code of a run stopped because its end user's credit refused a model call (`AttemptAck.refused`): never retried. */
export const END_USER_CREDIT = "end_user_credit";

/** The host can describe usage, but never chooses the tenant, key owner or billing policy. */
/**
 * `estimate` (begin): what the host expects the call to take, for its end user's hold (end-user-credits.ts): the input's
 * tokens as estimated, of which `cachedTokens` the provider likely reads from its cache (the prefix the previous response
 * read or wrote), the most output it asked for, and the model's rates (USD per million tokens) as the host has them.
 * `endUser` (begin): who pays for the call and from which bucket, set by the runtime (client-sessions.ts), never the host.
 * `progress`: the call has streamed `chars` characters (text, thinking, tool-call arguments), the `checkAtChars` its last
 * acknowledgment asked to hear at.
 */
export type ModelAttemptEvent =
  | { type: "begin"; id: string; provider: string; model: string; kind: "response" | "compaction"; at: number; keyHash: string; reconciliationDisabled?: string; reconciliationEligible?: boolean; context?: Pick<import("./client-sessions/state.ts").UsageRecord, "requestId" | "actor" | "identity" | "keyScope">; estimate?: AttemptEstimate; endUser?: { id: string; bucket: string } }
  | { type: "generation"; id: string; generation: string }
  | { type: "progress"; id: string; chars: number }
  /**
   * `superseded`: why the call's response is not the answer (`content_filter`: its provider's filter blocked it, and the
   * request is made again on another model, content-filter-fallback.ts). Recorded for the platform's books; never charged.
   */
  | { type: "finish"; id: string; usage: Record<string, any>; chars: number; completed: boolean; superseded?: Superseded };
/** Why a call's response was replaced by another call's (see `finish`). */
export type Superseded = "content_filter";
export type AttemptEstimate = { inputTokens: number; cachedTokens?: number; maxOutputTokens: number; rates: { input: number; output: number; cacheRead?: number } };
/**
 * What the runtime answers an attempt's begin or progress: whether it tracks the attempt (a bare boolean says only that),
 * and for a call its end user pays for, where its hold runs out (`stopAtChars`: streamed characters, as an estimate
 * counts them) and when to ask for more ahead of that (`checkAtChars`). `refused`: nothing more will be held (its end
 * user is out of credit): refused at begin, the call is never made; after, its stream is cut at `stopAtChars`.
 * `maxOutputTokens` (begin): the most output what is left can pay for, which the call asks for at most: the provider then
 * ends a reply whose reasoning never streams, which `stopAtChars` cannot see.
 */
export type AttemptAck = { tracked: boolean; checkAtChars?: number; stopAtChars?: number; refused?: CreditStop; maxOutputTokens?: number };
/** An end user's credit refusing a call: what to say, why (`balance`, `daily_limit`, `bucket_limit`), whose and which bucket; or, with no `endUser`, the tenant's own credit. */
export type CreditStop = { message: string; reason: string; endUser?: string; bucket?: string };
export type ModelAttemptHook = (event: ModelAttemptEvent) => Promise<boolean | AttemptAck>;
/** An acknowledgment as a whole, from either form. */
export const attemptAck = (ack: boolean | AttemptAck | undefined): AttemptAck => typeof ack === "object" ? ack : { tracked: !!ack };
/** The code of a run stopped because its end user's credit refused a model call (`AttemptAck.refused`): never retried. */
export const END_USER_CREDIT = "end_user_credit";

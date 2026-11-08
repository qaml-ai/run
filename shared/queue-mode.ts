/**
 * An agent's `queue`: what it does with the prompts that wait while a turn runs. Unset (or `{mode: "each"}`): each runs
 * as a turn of its own, in order. `{mode: "batch"}`: those that can share a turn (`batchable`) run together as the next
 * one, each its own user message in arrival order, so a burst of events costs one turn. `windowMs` (batch only) holds a
 * prompt that reaches an idle agent that long, so a burst arriving at once merges too. Both backends read it here.
 */
export type QueueSetting = { mode: "batch"; windowMs?: number };

/** The longest an idle agent's first prompt waits for others to join it. */
export const MAX_BATCH_WINDOW_MS = 2_000;

/** An agent's or definition's `queue` as stored: `{mode: "batch", windowMs?}`, or null for one turn per prompt. Throws on anything else. */
export function queueInput(value: unknown): QueueSetting | null {
  if (value === null) return null;
  const fields = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const windowMs = fields?.windowMs;
  if (!fields || Object.keys(fields).some(key => key !== "mode" && key !== "windowMs") || !["each", "batch"].includes(fields.mode as string)
    || (windowMs !== undefined && (fields.mode !== "batch" || !Number.isSafeInteger(windowMs) || (windowMs as number) < 0 || (windowMs as number) > MAX_BATCH_WINDOW_MS))) {
    throw new Error(`queue must be {mode: "each"} or {mode: "batch", windowMs?: 0 to ${MAX_BATCH_WINDOW_MS}}, or null`);
  }
  if (fields.mode === "each") return null;
  return windowMs ? { mode: "batch", windowMs: windowMs as number } : { mode: "batch" };
}

/** Request ids the runtime gives its own prompts: a delegate call's, a spawned or messaged agent's, a resume, a notification, a schedule's. */
const RUNTIME_IDS = /^(?:delegate_|spawn_|msg_|resume_|child_|schedule-|kept-queue-)/;

/**
 * Whether a queued prompt may share a turn with others: one the application sent (not a sub-agent's notification or
 * message, nor a prompt the runtime makes: a delegate call's, a schedule's), shaping no turn of its own (no `output`
 * schema) and limiting none (no `spendLimit` or `runLimits` of its own). A prompt signed into a delegation chain is its
 * caller's, whose call waits on that turn's answer alone, so it never joins nor leads one.
 */
export function batchable(given: unknown, id?: string) {
  const params = given as Record<string, unknown> | undefined;
  const metadata = params?.metadata as Record<string, unknown> | undefined;
  return !!params && typeof params === "object" && params.notice === undefined && params.landOnly === undefined && params.output === undefined
    && params.spendLimit === undefined && params.runLimits === undefined && !(id !== undefined && RUNTIME_IDS.test(id))
    && metadata?.parentAgentId === undefined && metadata?.delegationSignature === undefined;
}

/**
 * Whether `member` may join `lead`'s turn: both batchable, acting for the same actor and spending from the same bucket
 * (the turn acts for one and is charged to one).
 */
export function joins(lead: { id?: string; actor?: string; bucket?: string; params?: unknown }, member: { id?: string; actor?: string; bucket?: string; params?: unknown }) {
  return batchable(lead.params, lead.id) && batchable(member.params, member.id) && (lead.actor ?? null) === (member.actor ?? null) && (lead.bucket ?? null) === (member.bucket ?? null);
}

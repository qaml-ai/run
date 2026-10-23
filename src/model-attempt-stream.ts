import { createHash, randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { attemptAck, type AttemptAck, type AttemptEstimate, type CreditStop, type ModelAttemptHook } from "./model-attempt.ts";
import { PERSISTENCE_FAILED } from "./protocol.ts";

/** How often a metered call that is still streaming reports, at least: well inside the hold's life (HOLD_MS, ten minutes). */
export const RENEW_MS = 3 * 60_000;

/** What a call's response says beyond Pi's message: the provider's cost (and credits), its generation id, and the host it was served by (`host`, OpenRouter's). */
export type UsageSink = { cost?: number; credits?: number; host?: string; generation?: (id: string) => Promise<void> };
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/**
 * Persist before dispatch; acknowledge settlement before the host sees its terminal response. `estimate` is what the
 * call is expected to take, for its end user's hold: a begin its end user's credit refuses makes no call, and ends with
 * the refusal's words as the response's error. A call that streams reports how far it got (`progress`) each time it
 * reaches the characters its last acknowledgment named, ahead of where its hold ends; with nothing more to hold, it is
 * cut there (`halt`, which `start`'s request listens to), billed for what it streamed, and ends with the refusal's
 * words. `onRefused` hears of a call refused or cut so, as it happens.
 */
export async function attemptStream(model: Model<Api>, key: string, kind: "response" | "compaction", hook: ModelAttemptHook | undefined,
  start: (sink: UsageSink, halt: AbortSignal) => AssistantMessageEventStream, estimate?: AttemptEstimate, onRefused?: (stop: CreditStop) => void, gateway = false): Promise<AssistantMessageEventStream> {
  const id = randomUUID(), at = Date.now();
  let ack: AttemptAck;
  try { ack = attemptAck(await hook?.({ type: "begin", id, at, provider: model.provider, model: model.id, kind, keyHash: createHash("sha256").update(key).digest("hex"), ...(!key || gateway ? { reconciliationDisabled: "Gateway credential has no direct provider reconciliation; estimate is final" } : {}), ...(estimate ? { estimate } : {}) })); }
  catch { throw new Error(PERSISTENCE_FAILED); }
  if (ack.refused) {
    onRefused?.(ack.refused);
    const refused = createAssistantMessageEventStream();
    refused.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), timestamp: at, stopReason: "error", errorMessage: ack.refused.message } });
    refused.end();
    return refused;
  }
  const tracked = ack.tracked;
  let generation: string | undefined;
  const sink: UsageSink = { ...(tracked && model.provider === "openrouter" ? { generation: async (value: string) => {
    if (value === generation || !value.startsWith("gen-")) return;
    await hook!({ type: "generation", id, generation: value });
    generation = value;
  } } : {}) };
  const halt = new AbortController();
  const stream = start(sink, halt.signal);
  if (!tracked) return stream;
  const out = createAssistantMessageEventStream();
  /**
   * Characters streamed so far; where the hold ends (`stopAt`) and where to ask for more ahead of it (`checkAt`); the
   * request for more in flight; why no more will come (`refusal`); and why the call was cut, once it is.
   */
  let streamed = 0, checkAt = ack.checkAtChars, stopAt = ack.stopAtChars, asking: Promise<void> | undefined, refusal: CreditStop | string | undefined, cut: string | undefined, asked = Date.now();
  // A metered call that streams slowly (or thinks a long while before it writes) reports as time passes too, so its hold
  // never lapses while it is still running.
  const renewing = stopAt === undefined ? undefined : setInterval(() => { if (Date.now() - asked >= RENEW_MS && refusal === undefined && cut === undefined) void ask(); }, RENEW_MS / 4);
  renewing?.unref?.();
  /** Ask for more of the hold, without holding up the stream: only the line itself waits for the answer. */
  const ask = () => asking ??= hook!({ type: "progress", id, chars: streamed }).then(answer => {
    asked = Date.now();
    const next = attemptAck(answer);
    if (next.stopAtChars !== undefined) stopAt = next.stopAtChars;
    checkAt = next.refused ? undefined : next.checkAtChars;
    if (next.refused) refusal = next.refused;
  }, error => {
    // Spend that cannot be checked is not let through: the call ends at its line as a failed accounting write does.
    checkAt = undefined;
    refusal = `${PERSISTENCE_FAILED}: ${error instanceof Error ? error.message : "the end user's credit could not be checked"}`;
  }).finally(() => { asking = undefined; });
  void (async () => {
    try {
      for await (const event of stream) {
        if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
          if (cut !== undefined) continue;
          streamed += event.delta.length;
          if (checkAt !== undefined && streamed >= checkAt) void ask();
          if (stopAt !== undefined && streamed >= stopAt) {
            // At the end of its hold: the answer in flight may move the line; one never asked for is asked now.
            await asking;
            if (streamed >= stopAt && refusal === undefined) await ask();
            if (streamed >= stopAt) {
              cut = typeof refusal === "string" ? refusal : refusal?.message ?? "This end user's credit ran out";
              if (typeof refusal === "object") onRefused?.(refusal);
              halt.abort(new Error(cut));
              continue;
            }
          }
        }
        if (event.type === "done" || event.type === "error") {
          // A request for more of the hold still in flight is answered before the call's end is reported, so it never
          // lands after its settlement.
          await asking;
          const message = event.type === "done" ? event.message : event.error;
          if (sink.cost !== undefined) Object.assign(message.usage, { providerCost: sink.cost, providerCreditCost: sink.credits });
          if (sink.host) Object.assign(message.usage, { providerHost: sink.host });
          // Empty envelopes do not prove a provider generated billable output.
          const billed = message.content.length ? JSON.stringify(message.content).length : 0;
          try {
            await hook!({ type: "finish", id, usage: message.usage, chars: billed, completed: event.type === "done" && cut === undefined });
            Object.assign(message.usage, { billingAttemptId: id });
          } catch {
            // The durable begin/generation remains recoverable. Do not retry the model because billing failed.
            out.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: PERSISTENCE_FAILED } });
            out.end(); return;
          }
          if (cut !== undefined) {
            // What streamed before the cut stays: the response ends there, failed with why.
            out.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: cut } as AssistantMessage });
            out.end(); return;
          }
        }
        out.push(event);
      }
    } catch (error) {
      out.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: zeroUsage(), timestamp: at, stopReason: "error", errorMessage: `${PERSISTENCE_FAILED}: ${error instanceof Error ? error.message : "attempt interrupted"}` } });
    } finally { clearInterval(renewing); out.end(); }
  })();
  return out;
}

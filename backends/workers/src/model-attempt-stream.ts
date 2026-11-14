// Generated from src/model-attempt-stream.ts; infrastructure imports only.
import { createHash, randomUUID } from "node:crypto";
import { calculateCost, createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { tierCost } from "./model-catalog.ts";
import { attemptAck, type AttemptAck, type AttemptEstimate, type CreditStop, type ModelAttemptHook, type Superseded } from "./model-attempt.ts";
import { PERSISTENCE_FAILED } from "./money-host.ts";
import { safeError } from "./money-host.ts";

/** How often a streaming call reports activity for reconciliation. */
export const RENEW_MS = 3 * 60_000;

/** What a call's response says beyond Pi's message: the provider's cost (and credits), its generation id, the host it was served by (`host`, OpenRouter's) and the service tier that served it (`serviceTier`, OpenRouter's). */
export type UsageSink = { cost?: number; credits?: number; host?: string; serviceTier?: string; generation?: (id: string) => Promise<void> };
/**
 * The service tier a call asked for (`requestedServiceTier`, a virtual model's member: virtual-models.ts) and the one
 * that served it (`serviceTier`, the response's own word), on its usage; its cost at the served tier's prices where it
 * has its own (pi-catalog.ts `tierCost`): Pi priced it at the model's. Nothing for a call that asked none and heard none.
 */
export function servedTier(model: Model<Api>, message: AssistantMessage, served: string | undefined) {
  const requested = (model as { serviceTier?: string }).serviceTier;
  if (!requested && !served) return;
  const first = (message.usage as { requestedServiceTier?: unknown }).requestedServiceTier === undefined;
  Object.assign(message.usage, { ...(requested ? { requestedServiceTier: requested } : {}), ...(served ? { serviceTier: served } : {}) });
  // Asked flex and answered on another tier (or none said): OpenRouter did not honour it, which no fallback explains
  // (a fallback asks the default tier, never flex). Once per response.
  if (first && requested === "flex" && served !== "flex" && message.stopReason !== "error" && message.stopReason !== "aborted")
    console.log(JSON.stringify({ type: "model_flex_unhonored", provider: model.provider, model: model.id, servedTier: served ?? null }));
  const rates = tierCost(model.provider, model.id, served);
  if (rates) calculateCost({ ...model, cost: rates }, message.usage);
}
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** Persist before dispatch and acknowledge settlement before delivering the terminal response. */
export async function attemptStream(model: Model<Api>, key: string, kind: "response" | "compaction", hook: ModelAttemptHook | undefined,
  start: (sink: UsageSink) => AssistantMessageEventStream, estimate?: AttemptEstimate, onRefused?: (stop: CreditStop) => void, gateway = false,
  supersede?: (message: AssistantMessage) => Superseded | undefined): Promise<AssistantMessageEventStream> {
  const id = randomUUID(), at = Date.now();
  let ack: AttemptAck;
  try { ack = attemptAck(await hook?.({ type: "begin", id, at, provider: model.provider, model: model.id, kind, keyHash: createHash("sha256").update(key).digest("hex"), reconciliationEligible: !!key && !gateway, ...(!key || gateway ? { reconciliationDisabled: "Gateway credential has no direct provider reconciliation; reported usage is final" } : {}), ...(estimate ? { estimate } : {}) })); }
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
  const stream = start(sink);
  if (!tracked) return stream;
  const out = createAssistantMessageEventStream();
  let streamed = 0, heartbeat: Promise<unknown> | undefined;
  const renewing = setInterval(() => {
    heartbeat ??= hook!({ type: "progress", id, chars: streamed }).catch(() => {}).finally(() => { heartbeat = undefined; });
  }, RENEW_MS);
  renewing?.unref?.();
  void (async () => {
    try {
      for await (const event of stream) {
        if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") streamed += event.delta.length;
        if (event.type === "done" || event.type === "error") {
          clearInterval(renewing);
          await heartbeat;
          const message = event.type === "done" ? event.message : event.error;
          if (sink.cost !== undefined) Object.assign(message.usage, { providerCost: sink.cost, providerCreditCost: sink.credits });
          if (sink.host) Object.assign(message.usage, { providerHost: sink.host });
          servedTier(model, message, sink.serviceTier);
          // Empty envelopes do not prove a provider generated billable output.
          const billed = message.content.length ? JSON.stringify(message.content).length : 0;
          try {
            const superseded = event.type === "error" ? supersede?.(message) : undefined;
            await hook!({ type: "finish", id, usage: message.usage, chars: billed, completed: event.type === "done", ...(superseded ? { superseded } : {}) });
            Object.assign(message.usage, { billingAttemptId: id });
          } catch (error) {
            // The durable begin/generation remains recoverable. Do not retry the model because billing failed. Said, as a
            // safe summary (class, name, code, length: never the message), so the cause is not a mystery.
            console.error(JSON.stringify({ type: "model_attempt_finish_failed", attempt: id, provider: model.provider, model: model.id, error: safeError(error) }));
            out.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: PERSISTENCE_FAILED } });
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

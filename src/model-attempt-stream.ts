import { createHash, randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, type Api, type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { ModelAttemptHook } from "./model-attempt.ts";
import { PERSISTENCE_FAILED } from "./protocol.ts";

export type UsageSink = { cost?: number; credits?: number; generation?: (id: string) => Promise<void> };
/** Persist before dispatch; acknowledge settlement before the host sees its terminal response. */
export async function attemptStream(model: Model<Api>, key: string, kind: "response" | "compaction", hook: ModelAttemptHook | undefined,
  start: (sink: UsageSink) => AssistantMessageEventStream): Promise<AssistantMessageEventStream> {
  const id = randomUUID(), at = Date.now();
  let tracked: boolean | undefined;
  try { tracked = await hook?.({ type: "begin", id, at, provider: model.provider, model: model.id, kind, keyHash: createHash("sha256").update(key).digest("hex") }); }
  catch { throw new Error(PERSISTENCE_FAILED); }
  let generation: string | undefined;
  const sink: UsageSink = { ...(tracked && model.provider === "openrouter" ? { generation: async (value: string) => {
    if (value === generation || !value.startsWith("gen-")) return;
    await hook!({ type: "generation", id, generation: value });
    generation = value;
  } } : {}) };
  const stream = start(sink);
  if (!tracked) return stream;
  const out = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of stream) {
        if (event.type === "done" || event.type === "error") {
          const message = event.type === "done" ? event.message : event.error;
          if (sink.cost !== undefined) Object.assign(message.usage, { providerCost: sink.cost, providerCreditCost: sink.credits });
          // Empty envelopes do not prove a provider generated billable output.
          const chars = message.content.length ? JSON.stringify(message.content).length : 0;
          try {
            await hook!({ type: "finish", id, usage: message.usage, chars, completed: event.type === "done" });
            Object.assign(message.usage, { billingAttemptId: id });
          } catch {
            // The durable begin/generation remains recoverable. Do not retry the model because billing failed.
            out.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: PERSISTENCE_FAILED } });
            out.end(); return;
          }
        }
        out.push(event);
      }
    } catch (error) {
      out.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} }, timestamp:at, stopReason:"error",errorMessage:`${PERSISTENCE_FAILED}: ${error instanceof Error ? error.message : "attempt interrupted"}` } });
    } finally { out.end(); }
  })();
  return out;
}

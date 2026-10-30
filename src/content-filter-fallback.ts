import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isContentFilterBlock } from "./model-errors.ts";

type Streamed = AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * One model request whose provider's content filter may block it, made again on `fallback` (the same model on another
 * provider) when it does, before Pi sees the block: Pi gets one response, the fallback's, and no failed attempt to
 * retry or keep. What streamed before the block stays on the stream: the fallback's `start` follows it, which begins the
 * response again for watchers (a `message_start` resets their partial), and Pi keeps partial snapshots, not deltas.
 * Each attempt is its own billed model call (model-attempt-stream.ts). Where `fallback` cannot be made (no credentials),
 * the block is the response, as without a fallback.
 */
export async function withContentFilterFallback(first: Streamed, fallback: () => Streamed,
  hooks: { blocked(message: AssistantMessage): void; unavailable(error: unknown): void; aborted(): boolean }): Promise<AssistantMessageEventStream> {
  const stream = await first;
  const out = createAssistantMessageEventStream();
  void (async () => {
    let partial: AssistantMessage | undefined;
    try {
      for await (const event of stream) {
        if (event.type !== "done" && event.type !== "error") partial = event.partial;
        if (event.type === "error" && event.reason === "error" && !hooks.aborted() && isContentFilterBlock(event.error)) {
          hooks.blocked(event.error);
          let next: AssistantMessageEventStream;
          try { next = await fallback(); }
          catch (error) {
            if (!hooks.aborted()) hooks.unavailable(error);
            out.push(event);
            return;
          }
          for await (const retried of next) {
            if (retried.type !== "done" && retried.type !== "error") partial = retried.partial;
            out.push(retried);
          }
          return;
        }
        out.push(event);
      }
    } catch (error) {
      // pi-ai's streams end with an error event rather than throw; one that throws still ends the response, failed.
      out.push({ type: "error", reason: "error", error: { ...partial!, stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) } });
    } finally { out.end(); }
  })();
  return out;
}

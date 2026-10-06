import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";

/**
 * How long a model request may go quiet before the runtime gives up on it. A provider's stream can stop partway
 * (a dropped connection a proxy keeps open, an upstream that hangs while its gateway sends keep-alives), and nothing
 * else would ever end the request: the turn would sit busy and silent.
 *
 * - `firstTokenMs`: from the request until the model's first content (text, thinking or a tool call). Not extended by
 *   anything the provider sends meanwhile (headers, keep-alives, an envelope event), since gateways keep a hung request
 *   alive with those. Reasoning models think before they write, so this is generous.
 * - `idleMs`: once content flows, the longest gap between two events of the stream (content, or any provider event but
 *   a keep-alive `ping`).
 */
export type StreamTimeouts = { firstTokenMs: number; idleMs: number };

/**
 * The runtime's defaults (AGENT_MODEL_FIRST_TOKEN_SECONDS and AGENT_MODEL_IDLE_SECONDS change them per runtime; an agent's
 * `runLimits.firstTokenSeconds` and `runLimits.idleSeconds` per agent or definition). A model the catalog marks as reasoning,
 * asked to think hard (high and up), gets `reasoningFirstTokenMs` before its first token instead.
 */
export const STREAM_TIMEOUTS = Object.freeze({ firstTokenMs: 120_000, reasoningFirstTokenMs: 300_000, idleMs: 45_000 });

/** Thinking levels at which a reasoning model may think for minutes before it writes anything. */
const LONG_THINKING = ["high", "xhigh", "max"];

/**
 * The timeouts for one request: the agent's own (seconds), else the runtime's, with the longer wait before the first
 * token for a reasoning model thinking hard.
 */
export function streamTimeouts(model: Pick<Model<Api>, "reasoning">, reasoning: string | undefined, own?: { firstTokenSeconds?: number; idleSeconds?: number } | null, runtime?: Partial<StreamTimeouts>): StreamTimeouts {
  const thinkingHard = !!model.reasoning && !!reasoning && LONG_THINKING.includes(reasoning);
  const firstTokenMs = own?.firstTokenSeconds !== undefined ? own.firstTokenSeconds * 1000
    : Math.max(runtime?.firstTokenMs ?? STREAM_TIMEOUTS.firstTokenMs, thinkingHard ? STREAM_TIMEOUTS.reasoningFirstTokenMs : 0);
  return { firstTokenMs, idleMs: own?.idleSeconds !== undefined ? own.idleSeconds * 1000 : runtime?.idleMs ?? STREAM_TIMEOUTS.idleMs };
}

/** The start of a stalled request's error message: retried as a timeout (Pi's "timed out"), and classed `stream_stalled` (metrics.ts). */
export const STALLED = "Model stream stalled";
export const isStalled = (message: string | null | undefined) => !!message?.startsWith(STALLED);

export type Stall = { phase: "first_token" | "idle"; ms: number };

/**
 * A model request's events, ended by the runtime when the provider goes quiet (`timeouts`) or the caller aborts
 * (`signal`). `start(signal, activity)` makes the request: its signal aborts the provider's call, and `activity` is
 * told of each provider event (Pi's `onProviderStreamEvent`).
 *
 * Either way the stream ends at once with a terminal event, whether or not the provider's client honors the abort:
 * a stall as a retryable error (`STALLED`), an abort as Pi's own (`stopReason: "aborted"`). What the provider sends
 * after that is dropped.
 */
export function watchedStream(
  model: Model<Api>,
  start: (signal: AbortSignal, activity: (event: unknown) => void) => AssistantMessageEventStream,
  timeouts: StreamTimeouts,
  signal?: AbortSignal,
  onStall?: (stall: Stall) => void,
  /** Sees (and may replace) the terminal event, however the stream ends. */
  terminal: (event: Extract<AssistantMessageEvent, { type: "done" | "error" }>) => AssistantMessageEvent = event => event,
): AssistantMessageEventStream {
  const created = createAssistantMessageEventStream();
  const out = { push: (event: AssistantMessageEvent) => created.push(event.type === "done" || event.type === "error" ? terminal(event) : event), end: () => created.end() };
  const controller = new AbortController();
  let ended = false;
  let partial: AssistantMessage | undefined;
  let started = false;
  const began = Date.now();
  let last = began;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = (reason: "error" | "aborted", errorMessage: string) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", aborted);
    const base: AssistantMessage = partial ? structuredClone(partial) : {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: reason, timestamp: began,
    } as AssistantMessage;
    // As Pi's adapters leave a failed message: no streaming scratch.
    for (const block of base.content as unknown as Record<string, unknown>[]) { delete block.index; delete block.partialArgs; delete block.customInput; delete block.streamIndex; }
    const error = { ...base, stopReason: reason, errorMessage } as AssistantMessage;
    out.push({ type: "error", reason, error });
    out.end();
  };
  const aborted = () => {
    controller.abort(signal?.reason);
    finish("aborted", "Request was aborted");
  };
  /** Check the deadline, and arm the timer for the next one. */
  const check = () => {
    if (ended) return;
    const now = Date.now();
    const phase = started ? "idle" : "first_token";
    const limit = started ? timeouts.idleMs : timeouts.firstTokenMs;
    const deadline = (started ? last : began) + limit;
    if (now < deadline) { timer = setTimeout(check, deadline - now); timer.unref?.(); return; }
    const seconds = Math.round(limit / 1000);
    const message = phase === "first_token"
      ? `${STALLED}: ${model.provider}/${model.id} sent nothing within ${seconds}s of the request (timed out before its first token)`
      : `${STALLED}: ${model.provider}/${model.id} sent nothing for ${seconds}s mid-response (timed out)`;
    onStall?.({ phase, ms: now - began });
    controller.abort(new Error(message));
    finish("error", message);
  };
  const activity = (event?: unknown) => {
    // A provider's keep-alive (Anthropic's `ping`) says the connection is open, not that the model is answering.
    if ((event as { type?: unknown } | undefined)?.type === "ping") return;
    if (started) last = Date.now();
  };

  if (signal?.aborted) { aborted(); return created; }
  signal?.addEventListener("abort", aborted, { once: true });
  check();
  void (async () => {
    try {
      for await (const event of start(controller.signal, activity) as AsyncIterable<AssistantMessageEvent>) {
        if (ended) break;
        if ("partial" in event) partial = event.partial;
        // Content (or the end) is the first token; `start` is only the response's headers.
        if (event.type !== "start") { started = true; last = Date.now(); }
        if (event.type === "done" || event.type === "error") {
          ended = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", aborted);
          out.push(event);
          out.end();
          return;
        }
        out.push(event);
      }
      // A stream that ended with no terminal event: say so rather than leave the turn waiting.
      finish("error", `The model's stream ended without a final event (${model.provider}/${model.id}); the response was cut off`);
    } catch (error) {
      finish(signal?.aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error));
    }
  })();
  return created;
}

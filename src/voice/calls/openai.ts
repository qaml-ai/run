import { closeDetail, messageJson, openSocket, redactDetail, wsBase, type SocketFactory } from "../../voice-providers/socket.ts";
import { fetchWithoutRedirects } from "../../core/no-redirect.ts";
import { NO_USAGE, type RealtimeTool, type RealtimeUsage } from "../realtime/provider.ts";

export type OpenAICallsOptions = { baseUrl?: string; socket?: SocketFactory; fetch?: typeof fetch };
export interface OpenAICalls {
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly voices: readonly string[];
  create(input: { sdp: string; model: string; voice: string; instructions: string; language?: string; interruptResponse: boolean; tools: RealtimeTool[]; apiKey: string }, events: SidebandEvents): Promise<{ callId: string; sdpAnswer: string; sideband: Sideband }>;
  hangup(callId: string, apiKey: string): Promise<void>;
}
export interface SidebandEvents {
  responseStarted(response: string): void;
  responseDone(response: string, outcome: { status: "completed" | "cancelled" | "failed" | "incomplete"; usage: RealtimeUsage; error?: string; rateLimited?: boolean }): void;
  heard(item: string, text: string, seconds: number): void;
  said(response: string, text: string): void;
  toolCall(call: { response: string; id: string; name: string; args: Record<string, unknown> }): void;
  rateLimits(limits: { name: string; limit: number }[]): void;
  warning(code: string, message: string): void;
  closed(reason: "requested" | "error", detail?: string): void;
}
export interface Sideband {
  note(text: string): void;
  toolResult(callId: string, output: string): void;
  respond(instructions?: string): void;
  close(): void;
}

const TIMEOUT_MS = 10_000;
const auth = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}` });

/** Broker a WebRTC offer, then attach a server socket for events and tool replies. */
export function openaiCalls(options: OpenAICallsOptions = {}): OpenAICalls {
  const base = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const send = options.fetch ?? fetch;
  const dial = options.socket ?? openSocket;
  const hangup = async (id: string, apiKey: string) => {
    const response = await fetchWithoutRedirects(send, `${base}/realtime/calls/${encodeURIComponent(id)}/hangup`, {
      method: "POST", headers: auth(apiKey), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 404) throw await responseError(response, apiKey);
    await response.body?.cancel();
  };
  return {
    models: ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"],
    defaultModel: "gpt-realtime-2.1",
    voices: ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"],
    async create(input, events) {
      const pcm = { type: "audio/pcm", rate: 24_000 };
      const session = {
        type: "realtime", model: input.model, instructions: input.instructions, output_modalities: ["audio"],
        audio: {
          input: {
            format: pcm,
            turn_detection: { type: "semantic_vad", eagerness: "auto", create_response: true, interrupt_response: input.interruptResponse },
            transcription: { model: "gpt-transcribe", ...(input.language ? { language: input.language } : {}) },
          },
          output: { format: pcm, voice: input.voice },
        },
        tools: input.tools.map(tool => ({ type: "function", ...tool })), tool_choice: "auto",
      };
      const body = new FormData();
      body.set("sdp", new Blob([input.sdp], { type: "application/sdp" }), "offer.sdp");
      body.set("session", JSON.stringify(session));
      const response = await fetchWithoutRedirects(send, `${base}/realtime/calls`, {
        method: "POST", headers: auth(input.apiKey), body, signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw await responseError(response, input.apiKey);
      const callId = /\/realtime\/calls\/([\w-]+)$/.exec(response.headers.get("location") ?? "")?.[1];
      if (!callId) {
        await response.body?.cancel();
        throw new Error("OpenAI did not return a realtime call id");
      }
      try {
        const sdpAnswer = await response.text();
        const sideband = await openSideband(dial, `${wsBase(base)}/realtime?call_id=${encodeURIComponent(callId)}`, input.apiKey, events);
        return { callId, sdpAnswer, sideband };
      } catch (error) {
        await hangup(callId, input.apiKey).catch(() => {});
        throw error;
      }
    },
    hangup,
  };
}

async function responseError(response: Response, key: string) {
  return new Error(`OpenAI realtime HTTP ${response.status}: ${redactDetail(await response.text().catch(() => ""), 300, [key])}`);
}

async function openSideband(dial: SocketFactory, url: string, key: string, events: SidebandEvents): Promise<Sideband> {
  const socket = dial(url, auth(key));
  const ready = Promise.withResolvers<void>();
  const safe = (detail: string) => redactDetail(detail, 200, [key]);
  let opened = false, requested = false, limitsReported = false;
  const timer = setTimeout(() => ready.reject(new Error("OpenAI realtime sideband timed out")), TIMEOUT_MS);
  socket.onopen = () => { opened = true; ready.resolve(); };
  socket.onerror = () => {
    if (!opened) ready.reject(new Error("OpenAI realtime sideband failed to open"));
  };
  socket.onclose = event => {
    const detail = safe(closeDetail(event));
    if (!opened) ready.reject(new Error(detail));
    else events.closed(requested ? "requested" : "error", requested ? undefined : detail);
  };
  socket.onmessage = ({ data }) => {
    const event = messageJson(data);
    if (!event) return;
    switch (event.type) {
      case "response.created":
        if (event.response?.id) events.responseStarted(event.response.id);
        break;
      case "response.function_call_arguments.done": {
        let args;
        try { args = JSON.parse(event.arguments); } catch { /* The model wrote no JSON. */ }
        events.toolCall({ response: event.response_id, id: event.call_id, name: event.name, args: args && typeof args === "object" && !Array.isArray(args) ? args : {} });
        break;
      }
      case "response.done": {
        const response = event.response ?? {};
        if (!response.id) break;
        const status = ["completed", "cancelled", "failed", "incomplete"].includes(response.status) ? response.status : "failed";
        const detail = response.status_details?.error;
        const error = detail?.message ? [detail.code ?? detail.type, detail.message].filter(Boolean).join(": ") : response.status_details?.reason;
        events.responseDone(response.id, { status, usage: usageOf(response.usage), ...(status === "failed" && error ? { error: safe(String(error)) } : {}), ...(status === "failed" && rateLimited(detail) ? { rateLimited: true } : {}) });
        break;
      }
      case "conversation.item.input_audio_transcription.completed":
        events.heard(event.item_id, String(event.transcript ?? "").trim(), event.usage?.type === "duration" && Number.isFinite(event.usage.seconds) ? Math.max(0, event.usage.seconds) : 0);
        break;
      case "conversation.item.input_audio_transcription.failed":
        events.heard(event.item_id, "", 0);
        break;
      case "response.output_audio_transcript.done":
        events.said(event.response_id, String(event.transcript ?? ""));
        break;
      case "rate_limits.updated":
        if (!limitsReported && Array.isArray(event.rate_limits)) {
          limitsReported = true;
          events.rateLimits(event.rate_limits.filter((limit: any) => typeof limit?.name === "string" && typeof limit?.limit === "number").map((limit: any) => ({ name: limit.name, limit: limit.limit })));
        }
        break;
      case "error":
        events.warning(safe(String(event.error?.code ?? "error")), safe(String(event.error?.message ?? "")));
        break;
    }
  };
  const close = () => {
    requested = true;
    if (socket.readyState < 2) socket.close();
  };
  try {
    await ready.promise;
  } catch (error) {
    close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const send = (type: string, data: Record<string, unknown>) => {
    if (socket.readyState === 1) socket.send(JSON.stringify({ type, ...data }));
  };
  return {
    note: text => send("conversation.item.create", { item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }),
    toolResult: (callId, output) => send("conversation.item.create", { item: { type: "function_call_output", call_id: callId, output } }),
    respond: instructions => send("response.create", instructions === undefined ? {} : { response: { instructions } }),
    close,
  };
}

function rateLimited(error: { code?: unknown; type?: unknown; message?: unknown } | undefined) {
  return /rate_?limit|too_many/i.test(`${error?.code} ${error?.type}`) || /too many tokens|rate limit/i.test(String(error?.message ?? ""));
}

function usageOf(usage: any): RealtimeUsage {
  if (!usage || typeof usage !== "object") return { ...NO_USAGE };
  const n = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const input = usage.input_token_details ?? {}, cached = input.cached_tokens_details ?? {}, output = usage.output_token_details ?? {};
  return {
    inputText: n(input.text_tokens), inputAudio: n(input.audio_tokens), cachedText: n(cached.text_tokens), cachedAudio: n(cached.audio_tokens),
    outputText: n(output.text_tokens), outputAudio: n(output.audio_tokens),
  };
}

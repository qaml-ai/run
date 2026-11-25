import { closeDetail, messageJson, redactDetail } from "../lib/voice-socket.ts";
import { fetchWithoutRedirects } from "../lib/no-redirect.ts";
import { NO_USAGE, type RealtimeTool, type RealtimeUsage } from "../lib/realtime-provider.ts";

export type OpenAICallsOptions = { baseUrl?: string; azure?: boolean; fetch?: typeof fetch };

export interface OpenAICalls {
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly voices: readonly string[];
  create(
    input: {
      sdp: string;
      model: string;
      voice: string;
      instructions: string;
      language?: string;
      interruptResponse?: boolean;
      tools: RealtimeTool[];
      apiKey: string;
    },
    events: SidebandEvents,
  ): Promise<{ callId: string; sdpAnswer: string; sideband: Sideband }>;
  hangup(callId: string, apiKey: string): Promise<void>;
}

export interface SidebandEvents {
  responseStarted(response: string): void;
  responseDone(
    response: string,
    outcome: {
      status: "completed" | "cancelled" | "failed" | "incomplete";
      usage: RealtimeUsage;
      error?: string;
      rateLimited?: boolean;
    },
  ): void;
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
const auth = (apiKey: string, azure = false): Record<string, string> =>
  azure ? { "api-key": apiKey } : { Authorization: `Bearer ${apiKey}` };

/** Broker a WebRTC offer, then attach a server socket for events and tool replies. */
export function openaiCalls(options: OpenAICallsOptions = {}): OpenAICalls {
  const azure = options.azure === true;
  const base = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const send = options.fetch ?? fetch;
  const hangup = async (id: string, apiKey: string) => {
    const response = await fetchWithoutRedirects(send, `${base}/realtime/calls/${encodeURIComponent(id)}/hangup`, {
      method: "POST",
      headers: auth(apiKey, azure),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 404) throw await responseError(response, [apiKey]);
    await response.body?.cancel();
  };
  return {
    models: ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"],
    defaultModel: "gpt-realtime-2.1",
    voices: ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"],
    async create(input, events) {
      const pcm = { type: "audio/pcm", rate: 24_000 };
      const session = {
        type: "realtime",
        model: input.model,
        instructions: input.instructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: pcm,
            turn_detection: {
              type: "semantic_vad",
              eagerness: "auto",
              create_response: true,
              interrupt_response: input.interruptResponse ?? true,
            },
            transcription: {
              model: "gpt-transcribe",
              ...(input.language ? { language: input.language } : {}),
            },
          },
          output: { format: pcm, voice: input.voice },
        },
        tools: input.tools.map((tool) => ({ type: "function", ...tool })),
        tool_choice: "auto",
      };
      const secrets: string[] = [input.apiKey];
      let response: Response;
      if (azure) {
        const secretRes = await fetchWithoutRedirects(send, `${base}/realtime/client_secrets`, {
          method: "POST",
          headers: { ...auth(input.apiKey, true), "Content-Type": "application/json" },
          body: JSON.stringify({ session }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!secretRes.ok) throw await responseError(secretRes, secrets);
        let ephemeralKey: string | undefined;
        try {
          const parsed = (await secretRes.json()) as { value?: unknown; client_secret?: { value?: unknown } };
          const raw = typeof parsed?.value === "string" ? parsed.value : parsed?.client_secret?.value;
          if (typeof raw === "string" && raw.length > 0) ephemeralKey = raw;
        } catch {
          // Handled below
        }
        if (!ephemeralKey) {
          throw new Error("OpenAI realtime did not return an ephemeral client secret");
        }
        secrets.push(ephemeralKey);
        try {
          response = await fetchWithoutRedirects(send, `${base}/realtime/calls`, {
            method: "POST",
            headers: { Authorization: `Bearer ${ephemeralKey}`, "Content-Type": "application/sdp" },
            body: input.sdp,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (secrets.some((secret) => secret && message.includes(secret))) {
            throw new Error(redactDetail(message, 300, secrets));
          }
          throw error;
        }
      } else {
        const body = new FormData();
        body.set("sdp", input.sdp);
        body.set("session", JSON.stringify(session));
        response = await fetchWithoutRedirects(send, `${base}/realtime/calls`, {
          method: "POST",
          headers: auth(input.apiKey, false),
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      }
      if (!response.ok) throw await responseError(response, secrets);
      const callId = /\/realtime\/calls\/([\w-]+)$/.exec((response.headers.get("location") ?? "").trim())?.[1];
      if (!callId) {
        await response.body?.cancel();
        throw new Error("OpenAI did not return a realtime call id");
      }
      try {
        const sdpAnswer = await response.text();
        const sideband = await openSideband(
          send,
          `${base}/realtime?call_id=${encodeURIComponent(callId)}`,
          input.apiKey,
          events,
          azure,
          secrets,
        );
        return { callId, sdpAnswer, sideband };
      } catch (error) {
        await hangup(callId, input.apiKey).catch(() => {});
        throw error;
      }
    },
    hangup,
  };
}

async function responseError(response: Response, secrets: readonly string[]) {
  return new Error(`OpenAI realtime HTTP ${response.status}: ${redactDetail(await response.text().catch(() => ""), 300, secrets)}`);
}

async function openSideband(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  key: string,
  events: SidebandEvents,
  azure = false,
  secrets: readonly string[] = [key],
): Promise<Sideband> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const handshake = fetchImpl(url, {
    headers: { ...auth(key, azure), Upgrade: "websocket" },
    redirect: "manual",
  });
  handshake
    .then((res) => {
      if (timedOut) res.webSocket?.close();
    })
    .catch(() => {});
  const response = await Promise.race([
    handshake,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("OpenAI realtime sideband timed out"));
      }, TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  const socket = response.webSocket;
  if (response.status !== 101 || !socket) throw await responseError(response, secrets);
  const safe = (detail: string) => redactDetail(detail, 200, secrets);
  let requested = false;
  let limitsReported = false;
  socket.addEventListener("close", (event) => {
    if (!requested) events.closed("error", safe(closeDetail(event)));
  });
  socket.addEventListener("error", () => {
    if (!requested) events.closed("error", "The realtime connection failed");
  });
  socket.addEventListener("message", ({ data }) => {
    const event = messageJson(data);
    if (!event) return;
    switch (event.type) {
      case "response.created":
        if (event.response?.id) events.responseStarted(event.response.id);
        break;
      case "response.function_call_arguments.done": {
        let args: unknown;
        try {
          args = JSON.parse(event.arguments);
        } catch {
          /* The model wrote no JSON. */
        }
        events.toolCall({
          response: event.response_id,
          id: event.call_id,
          name: event.name,
          args: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
        });
        break;
      }
      case "response.done": {
        const res = event.response ?? {};
        if (!res.id) break;
        const status = ["completed", "cancelled", "failed", "incomplete"].includes(res.status)
          ? res.status
          : "failed";
        const detail = res.status_details?.error;
        const error = detail?.message
          ? [detail.code ?? detail.type, detail.message].filter(Boolean).join(": ")
          : res.status_details?.reason;
        events.responseDone(res.id, {
          status,
          usage: usageOf(res.usage),
          ...(status === "failed" && error ? { error: safe(String(error)) } : {}),
          ...(status === "failed" && rateLimited(detail) ? { rateLimited: true } : {}),
        });
        break;
      }
      case "conversation.item.input_audio_transcription.completed":
        events.heard(
          event.item_id,
          String(event.transcript ?? "").trim(),
          event.usage?.type === "duration" && Number.isFinite(event.usage.seconds)
            ? Math.max(0, event.usage.seconds)
            : 0,
        );
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
          events.rateLimits(
            event.rate_limits
              .filter((limit: any) => typeof limit?.name === "string" && typeof limit?.limit === "number")
              .map((limit: any) => ({ name: limit.name, limit: limit.limit })),
          );
        }
        break;
      case "error":
        events.warning(safe(String(event.error?.code ?? "error")), safe(String(event.error?.message ?? "")));
        break;
    }
  });
  const close = () => {
    requested = true;
    if (socket.readyState < 2) socket.close();
  };
  socket.accept();
  const send = (type: string, data: Record<string, unknown>) => {
    if (socket.readyState === 1) socket.send(JSON.stringify({ type, ...data }));
  };
  return {
    note: (text) =>
      send("conversation.item.create", {
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      }),
    toolResult: (callId, output) =>
      send("conversation.item.create", {
        item: { type: "function_call_output", call_id: callId, output },
      }),
    respond: (instructions) =>
      send("response.create", instructions === undefined ? {} : { response: { instructions } }),
    close,
  };
}

function rateLimited(error: { code?: unknown; type?: unknown; message?: unknown } | undefined) {
  return /rate_?limit|too_many/i.test(`${error?.code} ${error?.type}`) || /too many tokens|rate limit/i.test(String(error?.message ?? ""));
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageOf(usage: any): RealtimeUsage {
  if (!usage || typeof usage !== "object") return { ...NO_USAGE };
  const inputDetails = usage.input_token_details ?? {};
  const cachedDetails = inputDetails.cached_tokens_details ?? {};
  const outputDetails = usage.output_token_details ?? {};
  return {
    inputText: num(inputDetails.text_tokens),
    inputAudio: num(inputDetails.audio_tokens),
    cachedText: num(cachedDetails.text_tokens),
    cachedAudio: num(cachedDetails.audio_tokens),
    outputText: num(outputDetails.text_tokens),
    outputAudio: num(outputDetails.audio_tokens),
  };
}

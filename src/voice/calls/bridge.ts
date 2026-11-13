import { setTimeout as sleep } from "node:timers/promises";
import type { VoiceCallsOptions } from "../../voice-calls.ts";
import { agentMoved } from "../../voice-sessions.ts";
import { askPrompt } from "./prompts.ts";

export const ASK_LIMITS = Object.freeze({ pendingMs: 45_000, lateMs: 5 * 60_000, replyChars: 4_000, requestChars: 300, retryMs: 1_000 });
export const TRANSCRIPT_LINES = 20;
export const TRANSCRIPT_CHARS = 2_000;

export async function askAgent(deps: {
  submit: VoiceCallsOptions["submitStreaming"]; agent: string; tenant: string; call: string; n: number;
  speaker?: { id: string; name?: string }; now: () => number; transcript?: string[];
  payer?: { endUser: string; bucket?: string };
}, request: string, signal: AbortSignal): Promise<{ outcome: "ok" | "empty" | "error" | "timeout"; reply: string; ms: number }> {
  const started = deps.now();
  const ms = () => Math.round(deps.now() - started);
  if (!request.trim()) return { outcome: "empty", reply: "", ms: ms() };
  const prefix = deps.transcript?.length ? `[Said in the call since your last reply]\n${deps.transcript.join("\n")}\n\n` : "";
  const body = {
    id: `voice_${deps.call.slice(3)}_ask_${started.toString(36)}${deps.n}`, method: "prompt",
    params: {
      text: prefix + askPrompt(request, deps.speaker?.name),
      ...(deps.speaker ? { from: deps.speaker } : {}),
      metadata: { voiceCall: deps.call, via: "voice" }, allowDisconnected: true,
      ...deps.payer,
    },
  };
  let text = "";
  const submit = async () => {
    for await (const piece of deps.submit(deps.agent, deps.tenant, body, signal)) {
      text += piece.slice(0, Math.max(0, ASK_LIMITS.replyChars - text.length));
    }
  };
  try {
    try {
      await submit();
    } catch (error) {
      if (text || signal.aborted || !agentMoved(error)) throw error;
      await sleep(ASK_LIMITS.retryMs, undefined, { signal });
      await submit();
    }
    signal.throwIfAborted();
    return { outcome: "ok", reply: text.trim(), ms: ms() };
  } catch {
    return { outcome: signal.aborted ? "timeout" : "error", reply: "", ms: ms() };
  }
}

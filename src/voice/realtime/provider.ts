import { micros } from "../../pricing.ts";

/**
 * A speech-to-speech model as a voice session's brain (`brain: "realtime"`; docs/guides/voice-calls.md, "Realtime
 * brain"). The session's media plane, turn-taking, addressing and echo guard stay in front of it
 * (src/voice/realtime/brain.ts): the model hears the call's audio mixed into one stream, with a text item naming who
 * speaks each time that changes, and it answers aloud only when the brain asks it to (manual commits; the provider's
 * own turn detection is off). Its audio plays on the session's connection like any speech.
 *
 * A provider is a connection factory. The connection's verbs are what the brain needs, not one vendor's events, so
 * Gemini Live (activityStart/activityEnd, clientContent) can be a second implementation of the same interface.
 * Audio is 24 kHz mono 16-bit PCM both ways, as the media plane gives and takes it.
 */

/** The brains a session may have: today's pipeline (STT, the agent, TTS), or a speech-to-speech model. */
export const BRAINS = ["cascade", "realtime"] as const;
export type Brain = typeof BRAINS[number];

/** A tool the model may call. */
export type RealtimeTool = { name: string; description: string; parameters: Record<string, unknown> };

/** How a connection is opened. */
export type RealtimeConfig = {
  model: string;
  /** The provider's voice. */
  voice: string;
  instructions: string;
  tools: RealtimeTool[];
  /** Transcribe what people say (each committed item), for addressing by name and voice.utterance. */
  transcribe: boolean;
  language?: string;
  /** Words to expect, for the transcription's prompt. */
  prompt?: string;
};

/** Tokens one response used, as the provider counts them. */
export type RealtimeUsage = {
  inputText: number; inputAudio: number; cachedText: number; cachedAudio: number;
  outputText: number; outputAudio: number;
};
export const NO_USAGE: Readonly<RealtimeUsage> = Object.freeze({ inputText: 0, inputAudio: 0, cachedText: 0, cachedAudio: 0, outputText: 0, outputAudio: 0 });

/** What a connection reports. Each is called once per thing, in the order the provider sent it. */
export interface RealtimeEvents {
  /** Opened and configured. */
  ready(): void;
  /** Billable audio seconds and text input items, as they cross the provider connection. */
  meter?(audioSeconds: number, textInputs: number): void;
  /** A response began (`respond`), or the provider began one itself. */
  responseStarted(response: string): void;
  /** Audio of a response, as it is made. */
  audio(response: string, pcm: Uint8Array): void;
  /** What a response is saying, as it is said (its audio's transcript): the echo guard compares against it. */
  said(response: string, text: string): void;
  /** The model called a tool; its arguments are whole. */
  toolCall(call: { response: string; id: string; name: string; args: Record<string, unknown> }): void;
  /** A response ended: completed, cancelled (`cancel`, or the provider's), or failed; what it used. */
  responseDone(response: string, outcome: { status: "completed" | "cancelled" | "failed" | "incomplete"; usage: RealtimeUsage; error?: string }): void;
  /** What a committed item (named by its `commit` tag) was heard to say, and the seconds transcribed. */
  heard(tag: string, text: string, seconds: number): void;
  /** Something went wrong that did not end the connection (an event refused): logged. */
  warning(code: string, message: string): void;
  /** The connection ended: closed by us (`requested`), or not (the provider's limit, a network failure). */
  closed(reason: "requested" | "error", detail?: string): void;
}

export interface RealtimeConnection {
  /** The call's audio, mixed: appended to the input not yet committed. */
  append(pcm: Uint8Array): void;
  /** How much input (ms) is waiting to be committed. */
  readonly pendingMs: number;
  /**
   * Keep the input appended since the last commit as one item, named `tag` for its transcript (`heard`). Too little to
   * keep (under the provider's minimum) is dropped; answers whether it was kept.
   */
  commit(tag: string): boolean;
  /** Drop the input appended since the last commit (echo, a cough). */
  discard(): void;
  /** Add a text item to the conversation (who speaks next, what was said before): it is context, not a turn. */
  note(text: string): void;
  /** Answer now, from everything so far; `instructions` add to the session's for this response alone. */
  respond(options?: { instructions?: string }): void;
  /** Stop the response being made, if one is. */
  cancel(): void;
  /**
   * People heard only `heardMs` of a response's audio (barge-in): its item is cut there, so the model's history holds
   * what was played and not the rest. 0 removes the item.
   */
  truncate(response: string, heardMs: number): void;
  /** A tool call's result, as the model reads it. */
  toolResult(callId: string, output: string): void;
  close(): void;
}

/** A provider's connections, on a tenant's credentials. */
export interface RealtimeProvider {
  /** The provider key it uses: PUT /v1/providers/<key>/key. */
  readonly key: string;
  readonly id: RealtimeProviderId;
  readonly models: readonly string[];
  readonly defaultModel: string;
  /** Its voices, and the nearest of them to a session's voice (OpenAI's names) where the names differ. */
  readonly voices: readonly string[];
  readonly voiceFor?: Readonly<Record<string, string>>;
  /** Its transcript of a turn comes only once it is asked to answer (Gemini): addressing by name decides after. */
  readonly wordsAfterAnswer?: boolean;
  connect(config: RealtimeConfig, credentials: { apiKey: string }, events: RealtimeEvents): RealtimeConnection;
}

export const REALTIME_PROVIDERS = ["openai", "gemini", "grok"] as const;
export type RealtimeProviderId = typeof REALTIME_PROVIDERS[number];

/** Micro-USD per million tokens, or per minute of audio and per text input item. */
export type RealtimePrice = { perMinute: number; perTextInput: number } | { inputText: number; cachedText: number; outputText: number; inputAudio: number; cachedAudio: number; outputAudio: number };

/**
 * List prices as of 2026-10-18 (developers.openai.com/api/docs/pricing), per million tokens. Audio is 10 tokens a
 * second in, 20 out. A tenant's own key is billed by OpenAI; the usage record still carries the cost.
 */
export const REALTIME_PRICES: Readonly<Record<string, RealtimePrice>> = Object.freeze({
  "openai/gpt-realtime-2.1": { inputText: micros(4), cachedText: micros(0.4), outputText: micros(24), inputAudio: micros(32), cachedAudio: micros(0.4), outputAudio: micros(64) },
  "openai/gpt-realtime-2.1-mini": { inputText: micros(0.6), cachedText: micros(0.06), outputText: micros(2.4), inputAudio: micros(10), cachedAudio: micros(0.3), outputAudio: micros(20) },
  // https://docs.x.ai/developers/models/speech-to-speech (2026-10-19): manual turns bill audio sent and received,
  // plus text input items; function_call_output is exempt. https://docs.x.ai/developers/pricing lists grok-voice-3.0.
  "grok/grok-voice-latest": { perMinute: micros(0.08), perTextInput: micros(0.004) },
  "grok/grok-voice-3.0": { perMinute: micros(0.08), perTextInput: micros(0.004) },
  // ai.google.dev/gemini-api/docs/pricing (2026-10-18): no cached price is listed, so cached tokens are billed in full;
  // thoughts are output text.
  "gemini/gemini-3.8-live": { inputText: micros(0.75), cachedText: micros(0.75), outputText: micros(4.5), inputAudio: micros(3), cachedAudio: micros(3), outputAudio: micros(12) },
});
/** The input transcription's model, and its price per minute (gpt-transcribe, as POST /v1/transcriptions bills it). */
export const REALTIME_TRANSCRIPTION = Object.freeze({ model: "gpt-transcribe", perMinute: micros(0.0045) });

/** What tokens or metered audio and text items cost (USD) at `reference`'s list price. */
export function realtimeCost(reference: string, usage: RealtimeUsage, audioSeconds = 0, textInputs = 0): number {
  const price = REALTIME_PRICES[reference];
  if (!price) throw new Error(`Realtime model ${reference} has no price configured`);
  if ("perMinute" in price) return (Math.max(0, audioSeconds) * price.perMinute / 60 + Math.max(0, textInputs) * price.perTextInput) / 1_000_000;
  // Cached tokens are counted within input: billed at the cached rate, the rest at the full one.
  const micro = (usage.inputText - usage.cachedText) * price.inputText + usage.cachedText * price.cachedText
    + (usage.inputAudio - usage.cachedAudio) * price.inputAudio + usage.cachedAudio * price.cachedAudio
    + usage.outputText * price.outputText + usage.outputAudio * price.outputAudio;
  return Math.max(0, micro) / 1_000_000 / 1_000_000;
}

/** What transcribing `seconds` of input cost (USD), per second. */
export function realtimeTranscriptionCost(seconds: number): number {
  return Math.ceil(seconds) * REALTIME_TRANSCRIPTION.perMinute / 60 / 1_000_000;
}

/**
 * A session's voice (OpenAI's text-to-speech names: alloy, coral, nova…) as a realtime voice: the same where the
 * realtime model has it, else the nearest (nova → marin, onyx → cedar, fable → ballad).
 */
export const REALTIME_VOICE_FOR: Readonly<Record<string, string>> = Object.freeze({ nova: "marin", onyx: "cedar", fable: "ballad" });
export function realtimeVoice(provider: RealtimeProvider, voice: string): string {
  if (provider.voices.includes(voice)) return voice;
  const near = provider.voiceFor?.[voice] ?? REALTIME_VOICE_FOR[voice];
  return near && provider.voices.includes(near) ? near : provider.voices[0];
}

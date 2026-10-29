import { grokTranscriptionLanguage } from "../../language.ts";
import type { SocketFactory } from "../../voice-providers/socket.ts";
import { openaiCompatibleRealtime } from "./openai.ts";
import type { RealtimeConfig, RealtimeProvider } from "./provider.ts";

/**
 * xAI Voice Agent uses OpenAI's events and bearer auth at wss://api.x.ai/v1/realtime, with a different session shape:
 * https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech
 * https://docs.x.ai/developers/rest-api-reference/inference/voice#realtime
 * Voice names: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech#voices
 * Voice and turn_detection are top-level; { type: null } allows manual audio commits. PCM16 LE at 24 kHz and JSON
 * audio transport match our media plane. Transcripts are native (no OpenAI transcription model); streaming input
 * transcripts are cumulative, so we use only completed. Both old and GA output audio event names are accepted.
 * Function calls and function_call_output match OpenAI. Only our functions are sent: web_search, x_search and other
 * built-in tools are never enabled. ask_agent remains the route to facts and actions.
 */
export const GROK_REALTIME = Object.freeze({
  models: ["grok-voice-latest", "grok-voice-3.0"] as const,
  defaultModel: "grok-voice-latest",
  voices: ["ara", "eve", "leo", "rex", "sal", "carina", "zagan", "helix", "orion", "luna", "iris", "altair", "zenith",
    "perseus", "helios", "lux", "kepler", "rigel", "cosmo", "celeste", "ursa", "sirius", "lumen", "castor", "naksh", "atlas", "aurora", "liora"] as const,
});

const VOICE_FOR: Readonly<Record<string, string>> = Object.freeze({
  alloy: "sal", coral: "ara", nova: "eve", sage: "ara", shimmer: "eve", marin: "ara",
  ash: "rex", verse: "rex", onyx: "leo", fable: "leo", ballad: "sal", echo: "rex", cedar: "leo",
});

export function grokRealtime(options: { baseUrl?: string; socket?: SocketFactory } = {}): RealtimeProvider {
  return openaiCompatibleRealtime({
    id: "grok", key: "xai", models: GROK_REALTIME.models, defaultModel: GROK_REALTIME.defaultModel,
    voices: GROK_REALTIME.voices, voiceFor: VOICE_FOR,
  }, {
    ...options, baseUrl: options.baseUrl ?? "https://api.x.ai/v1", session: grokSession, language: grokTranscriptionLanguage, legacyAudioEvents: true, nativeTranscription: true, metered: true,
    redact: text => text.replace(/\bxai-[\w-]+/g, "[redacted]"),
  });
}

function grokSession(config: RealtimeConfig) {
  return {
    instructions: config.instructions, voice: config.voice, turn_detection: { type: null },
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24_000 },
        ...(config.transcribe && config.language ? { transcription: { language_hint: config.language } } : {}),
      },
      output: { format: { type: "audio/pcm", rate: 24_000 } },
    },
    tools: config.tools.map(tool => ({ type: "function", ...tool })),
  };
}

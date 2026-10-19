import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BROWSER_BOT } from "./voice-browser.ts";
import type { Accounts, Sealed } from "./accounts.ts";
import { transaction, type Db, type Sql } from "./db.ts";
import { HttpError } from "./http.ts";
import { clock } from "./node-context.ts";
import { identityInput } from "./identity.ts";
import { metricLine, safeError, writeMetricLine } from "./metrics.ts";
import { underClaim, type Claim, type Ownership } from "./ownership.ts";
import { checkedAudio, languageInput, type Transcribed, type Transcriber, type Transcript } from "./transcription.ts";
import { LIVE_LIMITS, type LiveTranscription, type SttEvent } from "./transcription-live.ts";
import { enqueueEvents, webhookEvent, type WebhookEvent } from "./webhooks.ts";
import type { UsageRecord } from "./client-sessions.ts";
import { oggOpus, type Cut } from "./voice-audio.ts";
import { inlineMedia, type Media, type MediaFactory, type MediaOptions } from "./voice/media.ts";
import { SessionSpeech, SPEECH_QUEUE, speechId, SpokenReply, type Player, type SpeechEnding, type SpeechItem } from "./voice-speech.ts";
import { DEFAULT_VOICE, SPEECH_LIMITS, type SpeechInput, type Synthesizer } from "./speech.ts";
import type { Served } from "./voice-providers/tts-chain.ts";
import { sttReference } from "./voice-providers/stt.ts";
import { TTS_PROVIDERS, ttsReference } from "./voice-providers/tts.ts";
import type { LiveTranscript } from "./transcription-live.ts";
import { bucketInput, DEFAULT_BUCKET } from "./end-user-credits.ts";
import { TurnClock, WaitingTurns } from "./voice/latency.ts";
import { DEFAULT_ADDRESSING, Floor, withContext, type Addressed, type AddressingPolicy } from "./voice/turns/floor.ts";
import { BARGE_IN_LIMITS, BargeInGuard, DEFAULT_BARGE_IN, type BargeInOutcome, type BargeInPolicy } from "./voice/echo-guard.ts";
import type { TurnModels } from "./voice/turns/inference.ts";
import { RealtimeBrain, ASK_AGENT, STAY_SILENT, realtimeInstructions, type BrainHooks } from "./voice/realtime/brain.ts";
import { REALTIME_PRICES, REALTIME_PROVIDERS, REALTIME_TRANSCRIPTION, realtimeVoice, type RealtimeProvider, type RealtimeProviderId } from "./voice/realtime/provider.ts";

/**
 * Voice sessions: calls camelRun holds for a tenant's bot. Joining a voice channel is the one step that needs the bot's
 * gateway, which the tenant's app keeps: it asks to join (Discord's OP 4), and forwards what Discord answers (the voice
 * session id, the voice server's endpoint and a token) to `POST /v1/voice/sessions`. With those, camelRun opens the
 * voice connection itself and listens. Leaving the channel is the app's again (OP 4 with no channel).
 *
 * Each session is an actor (`voice:<id>` in actor_owners), so one node holds its connection, as one node holds a
 * channel's gateway: the node that takes the request connects at once, and every node's scan takes any open session no
 * node holds (its node died, fenced or retired). A change made on another node (new credentials, the end) bumps the
 * row's revision and notifies the owner, whose scan also compares revisions. Effects of a session (its events, its
 * usage) are written under the owner's claim. The credentials are sealed and dropped when the session ends; audio is
 * never stored.
 *
 * The owner cuts each speaker's audio into utterances (voice-audio.ts), transcribes each as `POST /v1/transcriptions`
 * would (the same provider, model and price, recorded as the session's subject's usage), and delivers the text: a
 * `voice.utterance` event for the tenant's webhooks, and a prompt to an agent. Only a fresh lease transcribes (a node cut
 * off from the cluster pays for nothing), one utterance at a time per speaker and a few at a time per node. An utterance
 * is at most once until its transcript is written (its audio lives only in the node's memory), at least once after.
 */

/** What a voice connection needs: the bot's voice session (its user, guild and channel) and the voice server's grant. */
export type VoiceCredentials = {
  guildId: string; channelId: string; userId: string; sessionId: string;
  /** The voice server, host[:port] as Discord gives it; null while Discord moves the call (wait for the next). */
  endpoint: string | null;
  token: string;
};

/** What a connection reports to the session that holds it. */
export interface VoiceHandlers {
  /** Connected and receiving (again, after a reconnect). */
  ready(): void;
  /**
   * One Opus packet of `speaker`'s audio, in order. `lost`: packets missing just before it (the transport's jitter
   * buffer gave up on them), which the segmenter conceals.
   */
  packet(speaker: string, packet: Uint8Array, lost?: number): void;
  /** `speaker`'s audio stream broke (a packet that would not decrypt): what came of it so far ends there. */
  broken(speaker: string): void;
  /**
   * The connection cannot go on with these credentials: the bot was disconnected from the channel (`kicked`: removed,
   * moved, the channel deleted) or Discord no longer takes the session (`credentials`). New ones may come (`update`).
   */
  lost(reason: "kicked" | "credentials" | "error", detail?: string): void;
  /** Structured transport diagnostics: never audio, tokens or session ids. */
  diagnostic(event: string, fields: Record<string, unknown>): void;
}
export interface VoiceConnection {
  /** Discord moved the call (a new endpoint and token, or channel): reconnect with these. */
  update(credentials: VoiceCredentials): void;
  /** The other users in the call now, when the connection knows; undefined until it does. */
  others(): string[] | undefined;
  /**
   * Play speech (20 ms Opus packets at 48 kHz stereo); a transport that cannot speak has none. `expectedMs`: about how
   * long it is (from its text), so playback can start as soon as what is buffered will last.
   */
  play?(packets: AsyncIterable<Uint8Array>, started: () => void, expectedMs?: number): import("./voice-speech.ts").Playback;
  /** A session's event, for a transport whose far end shows them (a browser call's page). */
  notify?(event: Record<string, unknown>): void;
  /**
   * Close the connection. `handoff`: another node takes the call next, with the same credentials, so the voice
   * service must not end its session (Discord's ends one whose socket closes normally: 4006 for the next node).
   */
  close(how?: "handoff" | "end"): void;
}
/** A voice service's connections (src/voice-discord.ts). */
export interface VoiceTransport {
  connect(credentials: VoiceCredentials, handlers: VoiceHandlers): VoiceConnection;
  /** Whether its connections can play speech (`play`). */
  speaks?: boolean;
}

export const VOICE_PROVIDERS = ["discord", "browser"] as const;
export type VoiceState = "connecting" | "live" | "reconnecting" | "ended";
export const END_REASONS = ["requested", "empty", "idle", "max_duration", "budget", "kicked", "credentials", "error"] as const;
export type EndReason = typeof END_REASONS[number];
/** Why a session ended, with what the reason needs: which limit for `budget`, a short detail for `error`. */
/** How a session ended; with reason budget, whose credit (`limit`), and for an end user's why (one of CREDIT_REASONS) and which bucket. */
export type Ending = { reason: EndReason; limit?: "tenant" | "end_user"; endUserReason?: string; bucket?: string; detail?: string };

/** A session's settings, as created (and some patched): stored as they are read back. */
export type VoiceOptions = {
  deliver: { agent?: string; webhooks: boolean };
  subject?: string; bucket?: string; context?: Record<string, unknown>; keyScope?: string;
  language?: string; prompt?: string;
  silenceMs: number; maxMinutes: number; idleMinutes: number; emptySeconds: number;
  ignoreUserIds: string[]; metadata: Record<string, unknown>;
  notice: string;
  /** The bot may speak (`POST …/speak`); its app joins un-muted. */
  speak: boolean;
  /** With speak: a person talking over the bot stops its speech (after the echo guard: src/voice/echo-guard.ts). */
  bargeIn: boolean;
  /** With bargeIn: its timing, when the session set it (else DEFAULT_BARGE_IN). */
  interruption?: BargeInPolicy;
  /** With speak: the voice its speech is made in, unless a speech asks for another. */
  voice: string;
  /** With speak and deliver.agent: the session speaks the agent's reply to each utterance, as it is written. */
  agentReplies: boolean;
  /**
   * Speech to text as people speak: the streaming providers to try, in order (`deepgram/flux-general-en`, `soniox`,
   * …; else the runtime's), and terms to listen for (names, jargon).
   */
  transcription?: { providers?: string[]; keyterms?: string[] };
  /** With speak: the text-to-speech providers to try, in order (else the runtime's), and its voice for each provider. */
  speech?: { providers?: string[]; voices?: Record<string, string> };
  /**
   * How a speaker's turn ends: smart, when Smart Turn judges them done at a pause (commitMs of silence) or after
   * maxSilenceMs regardless (src/voice/turns), with Silero VAD for speech; silence, after silenceMs of quiet (the
   * energy segmenter). Sessions from before it have none: silence.
   */
  endOfTurn?: EndOfTurn;
  /**
   * Which turns are the bot's (src/voice/turns/floor.ts): every one (always), or those that name it, come from someone
   * it is talking with, or are said with no one else in the call (addressed). Others are delivered as events, and go to
   * the agent as context with the next turn that is the bot's. Sessions from before it have none: always.
   */
  addressing?: AddressingPolicy;
  /**
   * What answers: today's pipeline (cascade: transcription, the agent or the app, text to speech), or a speech-to-speech
   * model (realtime: src/voice/realtime) that hears the call and answers aloud, asking deliver.agent for anything
   * beyond talk (ask_agent). Sessions without one: cascade.
   */
  brain?: "cascade" | "realtime";
  /** With brain realtime: its provider, model and voice, the bot's persona, and how it listens. */
  realtime?: RealtimeOptions;
  /** Speakers' names by user id, for the realtime brain's notes of who speaks (else "Speaker 1", "Speaker 2"…). */
  speakers?: Record<string, string>;
};
export type RealtimeOptions = {
  provider: RealtimeProviderId; model: string; voice: string;
  /** The bot's persona and instructions, before the call's rules. */
  instructions?: string;
  /** Inputs transcribed (names address the bot; voice.utterance has text). */
  transcribe: boolean;
  /** Answer at Smart Turn's likely end, held until the turn ends (smart end of turn only). */
  speculative: boolean;
};
export type EndOfTurn = { mode: "smart" | "silence"; commitMs: number; threshold: number; maxSilenceMs: number };

export const VOICE_LIMITS = Object.freeze({
  silenceMs: { default: 800, min: 200, max: 5_000 },
  /** endOfTurn (smart): silence after which a turn Smart Turn calls complete ends, and after which any does. */
  commitMs: { default: 500, min: 200, max: 3_000 },
  maxSilenceMs: { default: 1_400, min: 500, max: 5_000 },
  /** addressing: how long after the bot answers someone (or they name it) their turns are still the bot's. */
  conversationMs: { default: DEFAULT_ADDRESSING.conversationMs, min: 0, max: 600_000 },
  maxMinutes: { default: 240, min: 1, max: 720 },
  idleMinutes: { default: 30, min: 1, max: 720 },
  emptySeconds: { default: 60, min: 5, max: 3_600 },
  /** Live sessions per tenant, unless the runtime sets another (AGENT_VOICE_SESSIONS_PER_TENANT). */
  perTenant: 10,
  /** Sessions one node holds at most (AGENT_VOICE_SESSIONS_PER_NODE): past it, peers take new ones. */
  perNode: 200,
  /** How long a connection that lost its credentials waits for new ones (PATCH) before the session ends. */
  reconnectGraceMs: 15_000,
  /** Utterances one node transcribes at once; one waiting longer than `queueMs` for its turn is dropped. */
  transcriptionsPerNode: 16,
  queueMs: 60_000,
  /** A delivery to an agent that fails is tried this many times in all. */
  submitAttempts: 3,
  ignoreUserIds: 50,
  metadataBytes: 4_096,
  noticeChars: 500,
  promptChars: 1_000,
  /** Providers a session's transcription or speech chain names at most, and terms it listens for. */
  providers: 5,
  keyterms: 100,
  /** A realtime brain's instructions (the bot's persona), and the speakers' names a session may give. */
  realtimeInstructionsChars: 8_000,
  speakers: 50, speakerNameChars: 40,
  /** Ended sessions are listed this long, then deleted. */
  retentionDays: 30,
});
/** A session whose media crashes this many times within `windowMs` ends (`error`, `media_crashed`). */
export const MEDIA_CRASHES = Object.freeze({ max: 3, windowMs: 5 * 60_000 });
const DEFAULT_NOTICE = "<@{bot}> is listening and transcribing speech in this channel. Audio is not stored.";
const SPEAKING_NOTICE = "<@{bot}> is listening, transcribing speech and may speak in this channel. Audio is not stored.";
const VOICE_NAME = /^[a-z][a-z0-9_-]{1,31}$/;
/** The voice notifications' channel: a session's id, changed on some node. */
export const VOICE_CHANNEL = "voice_sessions";
const PRUNE_EVERY_MS = 60 * 60_000;

const SNOWFLAKE = /^\d{1,20}$/;
const ID = /^vs_[a-f0-9]{24}$/;
/** How long a browser session's socket token opens it. */
export const BROWSER_TOKEN_MS = 10 * 60_000;
const actor = (id: string) => `voice:${id}`;
const aad = (id: string) => `voice:${id}`;
type Secret = { sessionId: string; endpoint: string | null; token: string };

/** A row of voice_sessions. */
type Row = {
  id: string; tenant: string; provider: string; guild: string; bot_user: string; channel: string; state: VoiceState;
  end_reason: string | null; sealed: Sealed | null; options: VoiceOptions & { ending?: Ending }; revision: number;
  utterances: number; speech_seconds: number; cost: string | number; speeches: number; spoken_seconds: string | number;
  created_at: string | number; started_at: string | number | null; last_speech_at: string | number | null; ended_at: string | number | null; updated_at: string | number;
};
const num = (value: string | number | null) => value === null ? null : Number(value);

/** A session as the API shows it: never its token or voice session id. */
export function sessionView(row: Row) {
  const { ending, ...options } = row.options;
  return {
    id: row.id, provider: row.provider,
    discord: { guildId: row.guild, channelId: row.channel, userId: row.bot_user },
    state: row.state, endReason: row.end_reason,
    ...(ending?.limit ? { limit: ending.limit } : {}), ...(ending?.endUserReason ? { endUserReason: ending.endUserReason } : {}),
    ...options,
    // Sessions from before speaking have none of its settings.
    speak: options.speak ?? false, bargeIn: options.bargeIn ?? true, voice: options.voice ?? DEFAULT_VOICE, agentReplies: options.agentReplies ?? false,
    ...(options.speak && (options.bargeIn ?? true) ? { interruption: interruption(options) } : {}),
    endOfTurn: options.endOfTurn ?? { mode: "silence" as const, ...SMART_DEFAULTS },
    addressing: options.addressing ?? { ...DEFAULT_ADDRESSING },
    brain: options.brain ?? "cascade" as const,
    utterances: row.utterances, speechSeconds: row.speech_seconds, speeches: row.speeches ?? 0, spokenSeconds: Number(row.spoken_seconds ?? 0),
    costUsd: Number(row.cost) / 1_000_000,
    createdAt: num(row.created_at)!, startedAt: num(row.started_at), lastSpeechAt: num(row.last_speech_at), endedAt: num(row.ended_at),
  };
}
export type SessionView = ReturnType<typeof sessionView>;

/** A session's barge-in timing: what it set, else the defaults. */
export function interruption(options: Pick<VoiceOptions, "interruption">): BargeInPolicy {
  return { ...DEFAULT_BARGE_IN, ...options.interruption };
}

/** Two parts of one turn's transcript, as one (a failure of either fails it: the turn is then transcribed whole). */
function joined(first: Promise<Transcript>, second: Promise<Transcript>): Promise<Transcript> {
  const both = Promise.all([first, second]).then(([a, b]) => ({ ...a, ...b, text: [a.text, b.text].map(text => text.trim()).filter(Boolean).join(" "), seconds: a.seconds + b.seconds, ...(b.language ?? a.language ? { language: b.language ?? a.language } : {}) }));
  both.catch(() => {});
  return both;
}
/** addressing as given: {mode, names, conversationMs}. */
function addressingInput(value: unknown): AddressingPolicy {
  if (value === undefined) return { ...DEFAULT_ADDRESSING };
  const given = object(value, "addressing");
  only(given, "addressing", ["mode", "names", "conversationMs"]);
  if (given.mode !== undefined && given.mode !== "always" && given.mode !== "addressed") throw new HttpError(400, "addressing.mode must be always or addressed");
  const names = given.names;
  if (names !== undefined && (!Array.isArray(names) || names.length > 20 || names.some(name => typeof name !== "string" || !name.trim() || name.length > 60))) {
    throw new HttpError(400, "addressing.names must be at most 20 names (wake words), each 1 to 60 characters");
  }
  return {
    ...DEFAULT_ADDRESSING,
    mode: (given.mode as AddressingPolicy["mode"] | undefined) ?? (names?.length ? "addressed" : "always"),
    names: ((names as string[] | undefined) ?? []).map(name => name.trim()),
    conversationMs: integer(given.conversationMs, "addressing.conversationMs", VOICE_LIMITS.conversationMs),
  };
}
/** `bargeIn` as given: true, false, or {minMs, confirmMs, resumeMs, backchannels} (barge-in on, with that timing). */
function bargeInInput(value: unknown): { on: boolean; policy?: BargeInPolicy } {
  if (value === undefined) return { on: true };
  if (typeof value === "boolean") return { on: value };
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "bargeIn must be true, false or {minMs, confirmMs, resumeMs, backchannels}");
  only(value as Record<string, unknown>, "bargeIn", ["minMs", "confirmMs", "resumeMs", "backchannels"]);
  const given = value as Record<string, unknown>;
  const field = (name: "minMs" | "confirmMs" | "resumeMs") => integer(given[name], `bargeIn.${name}`, { default: DEFAULT_BARGE_IN[name], ...BARGE_IN_LIMITS[name] });
  const extra = given.backchannels;
  if (extra !== undefined && (!Array.isArray(extra) || extra.length > BARGE_IN_LIMITS.backchannels || extra.some(word => typeof word !== "string" || !word.trim() || word.length > 40))) {
    throw new HttpError(400, `bargeIn.backchannels must be at most ${BARGE_IN_LIMITS.backchannels} words or short phrases (1 to 40 characters)`);
  }
  const backchannels = [...new Set(((extra as string[] | undefined) ?? []).map(word => word.trim().toLowerCase()))];
  return { on: true, policy: { minMs: field("minMs"), confirmMs: field("confirmMs"), resumeMs: field("resumeMs"), ...(backchannels.length ? { backchannels } : {}) } };
}

function text(value: unknown, name: string, pattern: RegExp, hint: string) {
  if (typeof value !== "string" || !pattern.test(value)) throw new HttpError(400, `${name} must be ${hint}`);
  return value;
}
function integer(value: unknown, name: string, range: { default: number; min: number; max: number }) {
  if (value === undefined || value === null) return range.default;
  if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) throw new HttpError(400, `${name} must be a whole number from ${range.min} to ${range.max}`);
  return value;
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${name} must be an object`);
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, name: string, keys: string[]) {
  const extra = Object.keys(value).find(key => !keys.includes(key));
  if (extra) throw new HttpError(400, `${name}.${extra} is not a field: ${keys.join(", ")}`);
}
function ignored(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > VOICE_LIMITS.ignoreUserIds || value.some(id => typeof id !== "string" || !SNOWFLAKE.test(id))) {
    throw new HttpError(400, `ignoreUserIds must be at most ${VOICE_LIMITS.ignoreUserIds} Discord user ids`);
  }
  return [...new Set(value as string[])];
}
/** A list of providers to try in order, each `<provider>` or `<provider>/<model>` as `reference` reads it. */
function providersInput(value: unknown, name: string, reference: (given: string) => string) {
  if (!Array.isArray(value) || !value.length || value.length > VOICE_LIMITS.providers) throw new HttpError(400, `${name} must list 1 to ${VOICE_LIMITS.providers} providers, in the order to try them`);
  const references = value.map(given => {
    if (typeof given !== "string") throw new HttpError(400, `${name} must list providers by name, such as deepgram or elevenlabs/eleven_flash_v2_5`);
    try { return reference(given); } catch (error) { throw new HttpError(400, `${name}: ${(error as Error).message}`); }
  });
  return [...new Set(references)];
}
function transcriptionInput(value: unknown): VoiceOptions["transcription"] {
  if (value === undefined) return undefined;
  const given = object(value, "transcription");
  only(given, "transcription", ["providers", "keyterms"]);
  const providers = given.providers === undefined ? undefined : providersInput(given.providers, "transcription.providers", sttReference);
  if (given.keyterms !== undefined && (!Array.isArray(given.keyterms) || given.keyterms.length > VOICE_LIMITS.keyterms || given.keyterms.some(term => typeof term !== "string" || !term.trim() || term.length > 50))) {
    throw new HttpError(400, `transcription.keyterms must be at most ${VOICE_LIMITS.keyterms} terms of 1 to 50 characters`);
  }
  const keyterms = given.keyterms === undefined ? undefined : [...new Set((given.keyterms as string[]).map(term => term.trim()))];
  return { ...(providers ? { providers } : {}), ...(keyterms?.length ? { keyterms } : {}) };
}
/** A session's `speech` (providers in order, their voices), as given; POST /v1/speech takes the same. */
export function speechChoiceInput(value: unknown) { return speechInput(value); }
function speechInput(value: unknown): VoiceOptions["speech"] {
  if (value === undefined) return undefined;
  const given = object(value, "speech");
  only(given, "speech", ["providers", "voices"]);
  const providers = given.providers === undefined ? undefined : providersInput(given.providers, "speech.providers", ttsReference);
  const voices = voicesInput(given.voices, "speech.voices");
  return { ...(providers ? { providers } : {}), ...(voices ? { voices } : {}) };
}
/** Voices by text-to-speech provider (`{elevenlabs: "<voice id>", openai: "coral"}`): a session's `speech.voices`, or a speech's `voices`. */
function voicesInput(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const voices = object(value, name);
  for (const [provider, voice] of Object.entries(voices)) {
    if (!(TTS_PROVIDERS as readonly string[]).includes(provider)) throw new HttpError(400, `${name}.${provider}: voices are by provider, one of ${TTS_PROVIDERS.join(", ")}`);
    if (typeof voice !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(voice)) throw new HttpError(400, `${name}.${provider} must be that provider's voice id or name`);
  }
  return Object.keys(voices).length ? voices as Record<string, string> : undefined;
}
const SMART_DEFAULTS = Object.freeze({ commitMs: VOICE_LIMITS.commitMs.default, threshold: 0.5, maxSilenceMs: VOICE_LIMITS.maxSilenceMs.default });
/** endOfTurn as given: a mode ("smart" or "silence") or {mode?, commitMs?, threshold?, maxSilenceMs?}; `mode` defaults to the runtime's. */
function endOfTurnInput(value: unknown, mode: EndOfTurn["mode"]): EndOfTurn {
  if (value === undefined) return { mode, ...SMART_DEFAULTS };
  if (value === "smart" || value === "silence") return { mode: value, ...SMART_DEFAULTS };
  const given = object(value, "endOfTurn");
  only(given, "endOfTurn", ["mode", "commitMs", "threshold", "maxSilenceMs"]);
  if (given.mode !== undefined && given.mode !== "smart" && given.mode !== "silence") throw new HttpError(400, "endOfTurn.mode must be smart or silence");
  const threshold = given.threshold ?? SMART_DEFAULTS.threshold;
  if (typeof threshold !== "number" || !(threshold >= 0.05 && threshold <= 0.95)) throw new HttpError(400, "endOfTurn.threshold must be a number from 0.05 to 0.95");
  const out: EndOfTurn = {
    mode: (given.mode as EndOfTurn["mode"] | undefined) ?? mode,
    commitMs: integer(given.commitMs, "endOfTurn.commitMs", VOICE_LIMITS.commitMs),
    threshold,
    maxSilenceMs: integer(given.maxSilenceMs, "endOfTurn.maxSilenceMs", VOICE_LIMITS.maxSilenceMs),
  };
  if (out.maxSilenceMs < out.commitMs) throw new HttpError(400, "endOfTurn.maxSilenceMs must be at least its commitMs");
  return out;
}
/** `speakers` as given: names by Discord user id, for a realtime brain's notes of who speaks. */
function speakersInput(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const given = object(value, "speakers");
  const entries = Object.entries(given);
  if (entries.length > VOICE_LIMITS.speakers) throw new HttpError(400, `speakers must name at most ${VOICE_LIMITS.speakers} users`);
  const out: Record<string, string> = {};
  for (const [id, name] of entries) {
    if (!SNOWFLAKE.test(id)) throw new HttpError(400, "speakers is names by Discord user id");
    // A name goes into the model's context: one line, no brackets, short.
    const clean = typeof name === "string" ? name.replace(/[\[\]\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, VOICE_LIMITS.speakerNameChars) : "";
    if (!clean) throw new HttpError(400, `speakers.${id} must be a name of 1 to ${VOICE_LIMITS.speakerNameChars} characters`);
    out[id] = clean;
  }
  return out;
}

function metadataInput(value: unknown) {
  if (value === undefined) return {};
  const metadata = object(value, "metadata");
  if (Buffer.byteLength(JSON.stringify(metadata)) > VOICE_LIMITS.metadataBytes) throw new HttpError(400, `metadata must be at most ${VOICE_LIMITS.metadataBytes} bytes of JSON`);
  return metadata;
}

/**
 * `discord` as given: the ids and grant Discord's VOICE_STATE_UPDATE and VOICE_SERVER_UPDATE carried. `partial` for an
 * update, where each is optional. `endpoints` is what a voice server's host must match (Discord's own by default), so a
 * session cannot point the runtime at any other host.
 */
function discordInput(value: unknown, endpoints: RegExp, partial = false): Partial<VoiceCredentials> {
  const given = object(value, "discord");
  only(given, "discord", partial ? ["channelId", "sessionId", "endpoint", "token"] : ["guildId", "channelId", "userId", "sessionId", "endpoint", "token"]);
  const out: Partial<VoiceCredentials> = {};
  const snowflake = (key: "guildId" | "channelId" | "userId") => {
    if (given[key] !== undefined || !partial) out[key] = text(given[key], `discord.${key}`, SNOWFLAKE, "a Discord id");
  };
  if (!partial) { snowflake("guildId"); snowflake("userId"); }
  snowflake("channelId");
  if (given.sessionId !== undefined || !partial) out.sessionId = text(given.sessionId, "discord.sessionId", /^[A-Za-z0-9_-]{1,128}$/, "the voice session id from the bot's VOICE_STATE_UPDATE");
  if (given.token !== undefined || !partial) out.token = text(given.token, "discord.token", /^[\x21-\x7e]{1,256}$/, "the token from VOICE_SERVER_UPDATE");
  if (given.endpoint !== undefined || !partial) {
    if (given.endpoint === null) out.endpoint = null;
    else {
      const endpoint = text(given.endpoint, "discord.endpoint", /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i, "the endpoint from VOICE_SERVER_UPDATE (host[:port]), or null");
      if (!endpoints.test(endpoint.replace(/:\d+$/, ""))) throw new HttpError(400, "discord.endpoint is not a Discord voice server");
      out.endpoint = endpoint;
    }
  }
  return out;
}

/**
 * The tenant's end users' credit (end-user-credits.ts), for sessions with a subject: refused before a session starts
 * when the subject has nothing left in its bucket, and each utterance's transcription held before it is sent and
 * settled with what it cost, as `POST /v1/transcriptions` does. Undefined answers: the tenant does not meter end users.
 */
export interface VoiceCredit {
  refusal(tenant: string, endUser: string, bucket: string): Promise<{ reason: string; message: string } | undefined>;
  /** Throws 402 END_USER_CREDIT (`details.reason`) when the subject cannot cover `usd`. */
  hold(tenant: string, endUser: string, bucket: string, usd: number, call: string, metadata?: Record<string, unknown>): Promise<{ settle(usd: number): Promise<void>; release(): Promise<void> } | undefined>;
}

export interface VoiceSessionsOptions {
  db: Db;
  accounts: Pick<Accounts, "seal" | "unseal" | "canStoreKeys">;
  /** This node's address, in logs. */
  node: string;
  /** Decides which node holds each session's connection; without it no session connects. */
  ownership?: Ownership;
  /** Each provider's connections. A runtime without one for a provider refuses its sessions. */
  transports: Partial<Record<typeof VOICE_PROVIDERS[number], VoiceTransport>>;
  /** Refuses a tenant that may not start paid work now (spent credit, monthly cap); throws an HttpError. */
  admit(tenant: string): Promise<void>;
  /** Whether an agent is the tenant's (and not deleted), for `deliver.agent`. */
  agentOwned(agent: string, tenant: string): Promise<boolean>;
  /** Speech to text, as `POST /v1/transcriptions` makes it. */
  transcriber: Transcriber;
  /** Text to speech, for sessions that speak; without it, no session may. */
  synthesizer?: Synthesizer;
  /** Whether the tenant has a key to transcribe with (in a key scope): OpenAI's, or one of the streaming chain's providers. */
  canTranscribe(tenant: string, keyScope: string | undefined, streaming?: string[]): Promise<boolean>;
  /** Records a transcription's usage, as a model response's is (billing, usage.recorded). */
  record(tenant: string, usage: UsageRecord): void;
  /** Submit a request to an agent wherever it is served (an utterance's prompt). */
  submit(agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }): Promise<unknown>;
  /** As `submit`, yielding the text the run writes as it is written (agentReplies); without it, replies are not spoken. */
  submitStreaming?(agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }, signal: AbortSignal): AsyncIterable<string>;
  /** The text a submitted run writes, so far and as it is written (a prompt's speak); without it, prompts cannot speak. */
  followStreaming?(agent: string, tenant: string, requestId: string, signal: AbortSignal): AsyncIterable<string>;
  transcriptionsPerNode?: number;
  /**
   * The node's turn-taking models (src/voice/turns: Silero VAD, Smart Turn), for sessions whose endOfTurn is smart (the
   * default when given); without them, sessions end turns on silence.
   */
  turnModels?: TurnModels;
  /** End users' credit; without it, sessions are billed to the tenant alone. */
  credit?: VoiceCredit;
  /**
   * Realtime brains (brain: "realtime"): the providers this runtime offers (AGENT_VOICE_REALTIME; none: refused), and
   * the tenant's key for one (in a key scope), else the platform's; undefined when there is none.
   */
  realtime?: {
    providers: Partial<Record<RealtimeProviderId, RealtimeProvider>>;
    key(tenant: string, keyScope: string | undefined, provider: string): Promise<{ apiKey: string; platform: boolean } | undefined>;
  };
  /** Live sessions per tenant (VOICE_LIMITS.perTenant). */
  perTenant?: (tenant: string) => number;
  perNode?: number;
  reconnectGraceMs?: number;
  /** What a voice server's host must match: Discord's (*.discord.media) unless a test serves its own. */
  endpoints?: RegExp;
  /** Send the webhook outbox now (Webhooks.kick): a voice event is waited on, by a bot that answers aloud. */
  kickWebhooks?(): void;
  /** Browser sessions' sockets: the secret their tokens are signed with, and where pages reach them. */
  browser?: { secret: string; url(session: string): string };
  /**
   * Where each session's media runs (src/voice/media.ts): given a provider's transport, its factory. By default on this
   * thread (`inlineMedia`).
   */
  media?(transport: VoiceTransport, provider: typeof VOICE_PROVIDERS[number]): MediaFactory;
}

/** A session this node holds: its claim, its media (its connection, its speakers' audio), and what its limits are measured from. */
type Held = {
  id: string; tenant: string; claim: Claim; revision: number; row: Row;
  credentials: VoiceCredentials; media?: Media;
  /** Since when the call has had no one else in it. */
  emptySince?: number;
  /** The connection lost its credentials (`lost`): when, and why, until new ones come. */
  lost?: { at: number; reason: "kicked" | "credentials" | "error"; detail?: string };
  ending?: boolean;
  /** What the bot was asked to say, for a session that speaks. */
  speech?: SessionSpeech;
  /** The runs whose replies it speaks (a prompt's speak), by agent and request: each spoken once. */
  replies?: Set<string>;
  /** When its media crashed lately (MEDIA_CRASHES): too many end the session. */
  crashes?: number[];
  /** Each speaker's live transcription (Transcriber.live), while they keep talking now and then. */
  live?: Map<string, LiveSpeaker>;
  /** Barge-in's echo guard, for a session that speaks with bargeIn: decides each pause. */
  guard?: BargeInGuard;
  /** When each speaker's current utterance began (speechStart), on this node's clock. */
  speechStarts?: Map<string, number>;
  /** Which turns are the bot's, and what was said around them (addressing). */
  floor: Floor;
  /** Smart turns' events counted (voice_turn_stats when the session is let go). */
  turnStats?: { likelyEnds: number; resumes: number; turns: number };
  /** The reply being made to the last turn (agentReplies), until it is heard: a newer turn supersedes it before then. */
  reply?: { requestId: string; speaker: string; abort: AbortController; heard: boolean };
  /** A realtime brain (brain: "realtime"), in place of transcription and speech. */
  brain?: RealtimeBrain;
};
type LiveSpeaker = {
  stream: LiveTranscription; platform: Promise<boolean>; idle?: ReturnType<typeof setTimeout>;
  /** Bytes appended since its last commit or clear. */
  appended: number;
  /**
   * What was committed early (at likely_end, before the turn ended) of the turn being spoken: its transcript comes while
   * the turn waits to be sure, and the cut adds only what was said after, if anything.
   */
  early?: Promise<Transcript>;
  /** They spoke again after it: what came after is speech, and is committed with the cut (else it is silence). */
  resumed?: boolean;
};
/** An utterance's transcript from its speaker's live stream, committed as it was cut. */
type Committed = { transcript: Promise<Transcript>; platform: Promise<boolean> };
/** A prompt's `speak`: the voice session its run's reply is spoken in, and how. */
export type VoiceReplyTarget = { session: string; voice?: string; interrupt?: boolean };
/** What an utterance's work needs of its session, fixed when it was cut: the session may move or end meanwhile. */
type Origin = { id: string; tenant: string; claim: Claim; row: Row };

export class VoiceSessions {
  readonly db: Db;
  private readonly options: VoiceSessionsOptions;
  private readonly held = new Map<string, Held>();
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;
  private prunedAt = 0;
  private stopped = false;
  private rescan = false;
  /** Sessions being taken now. */
  private readonly taking = new Set<string>();
  /** Utterances being transcribed or delivered, and the last one of each session's speaker (they go one at a time). */
  private readonly pending = new Set<Promise<void>>();
  private readonly speakers = new Map<string, Promise<void>>();
  private transcribing = 0;
  private readonly slots: (() => void)[] = [];
  /** Each speaking session's latest turn, waiting for the app to speak its reply (src/voice/latency.ts). */
  private readonly waitingTurns = new WaitingTurns();

  constructor(options: VoiceSessionsOptions) {
    this.options = options;
    this.db = options.db;
    // A fenced node's claims are void: the connections close, and a peer takes the sessions once its heartbeat expires.
    options.ownership?.onFence(() => { for (const held of [...this.held.values()]) void this.drop(held, false); });
  }

  /** Sessions this node holds now. */
  get size() { return this.held.size; }

  start(intervalMs = 5_000) {
    this.stopped = false;
    this.timer ??= setInterval(() => void this.scan().catch(error => console.error(JSON.stringify({ type: "voice_scan_failed", error: safeError(error) }))), intervalMs);
    this.timer.unref();
  }

  /** Stop taking sessions, hand those held to peers (`release`), and finish the utterances cut (for up to `waitMs`). */
  async stop(waitMs = 30_000) {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.release();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.pending]), new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
  }

  /**
   * Hand every session held to a peer: each is closed and released, and peers are told, so their next scan takes it and
   * connects again (a retiring or draining node, whose ownership takes nothing new meanwhile).
   */
  async release() {
    const released = [...this.held.values()];
    // Released before peers are told, so the scan a notification starts finds them free.
    await Promise.all(released.map(held => this.drop(held, true)));
    if (released.length) await this.notify(released.map(held => held.id)).catch(() => {});
  }

  // API ---------------------------------------------------------------------------

  private endpoints() { return this.options.endpoints ?? /^[a-z0-9-]+(\.[a-z0-9-]+)*\.discord\.media$/i; }

  /** Validate a create request's settings. */
  private settings(input: Record<string, unknown>, socket = false): VoiceOptions {
    const deliverGiven = input.deliver === undefined ? {} : object(input.deliver, "deliver");
    only(deliverGiven, "deliver", ["agent", "webhooks"]);
    const agent = deliverGiven.agent === undefined ? undefined : text(deliverGiven.agent, "deliver.agent", /^client_[a-f0-9]{40}$/, "an agent id");
    if (deliverGiven.webhooks !== undefined && typeof deliverGiven.webhooks !== "boolean") throw new HttpError(400, "deliver.webhooks must be true or false");
    const webhooks = deliverGiven.webhooks !== false;
    // A browser session's socket gets every utterance itself.
    if (!agent && !webhooks && !socket) throw new HttpError(400, "deliver must send utterances somewhere: an agent, webhooks, or both");
    const identity = identityInput({ subject: input.subject, context: input.context });
    const bucket = input.bucket === undefined ? undefined : bucketInput(input.bucket);
    const keyScope = input.keyScope === undefined ? undefined : text(input.keyScope, "keyScope", /^.{1,100}$/s, "a key scope's name");
    const language = languageInput(input.language);
    const prompt = input.prompt === undefined ? undefined : text(input.prompt, "prompt", new RegExp(`^[\\s\\S]{1,${VOICE_LIMITS.promptChars}}$`), `at most ${VOICE_LIMITS.promptChars} characters`);
    // speak: true, or {agentReplies} (which is speaking too).
    const speakGiven = input.speak !== null && typeof input.speak === "object" && !Array.isArray(input.speak) ? input.speak as Record<string, unknown> : undefined;
    if (input.speak !== undefined && typeof input.speak !== "boolean" && !speakGiven) throw new HttpError(400, "speak must be true, false or {agentReplies}");
    if (speakGiven) only(speakGiven, "speak", ["agentReplies"]);
    if (speakGiven?.agentReplies !== undefined && typeof speakGiven.agentReplies !== "boolean") throw new HttpError(400, "speak.agentReplies must be true or false");
    const bargeIn = bargeInInput(input.bargeIn);
    // A realtime brain speaks: it needs no speak.
    const speak = input.speak === true || !!speakGiven || input.brain === "realtime";
    const agentReplies = speakGiven?.agentReplies === true;
    if (!speak && (input.voice !== undefined || input.bargeIn !== undefined)) throw new HttpError(400, "voice and bargeIn are for a session that speaks (speak: true)");
    const voice = input.voice === undefined ? DEFAULT_VOICE : text(input.voice, "voice", VOICE_NAME, "a voice's name, such as alloy, coral or verse");
    const notice = input.notice === undefined ? speak ? SPEAKING_NOTICE : DEFAULT_NOTICE : text(input.notice, "notice", new RegExp(`^[\\s\\S]{1,${VOICE_LIMITS.noticeChars}}$`), `at most ${VOICE_LIMITS.noticeChars} characters`);
    const transcription = transcriptionInput(input.transcription);
    if (input.speech !== undefined && !speak) throw new HttpError(400, "speech is for a session that speaks (speak: true)");
    const speech = speechInput(input.speech);
    const realtime = this.realtimeInput(input, voice);
    if (realtime && agentReplies) throw new HttpError(400, "speak.agentReplies is the cascade's: a realtime brain speaks for itself (and asks deliver.agent with ask_agent)");
    if (realtime && transcription?.providers) throw new HttpError(400, "transcription.providers is the cascade's: a realtime brain's model hears the call itself");
    const speakers = speakersInput(input.speakers);
    return {
      deliver: { ...(agent ? { agent } : {}), webhooks },
      ...(identity?.subject !== undefined ? { subject: identity.subject } : {}), ...(bucket ? { bucket } : {}),
      ...(identity?.context ? { context: identity.context } : {}), ...(keyScope ? { keyScope } : {}),
      ...(language ? { language } : {}), ...(prompt ? { prompt } : {}),
      silenceMs: integer(input.silenceMs, "silenceMs", VOICE_LIMITS.silenceMs),
      maxMinutes: integer(input.maxMinutes, "maxMinutes", VOICE_LIMITS.maxMinutes),
      idleMinutes: integer(input.idleMinutes, "idleMinutes", VOICE_LIMITS.idleMinutes),
      emptySeconds: integer(input.emptySeconds, "emptySeconds", VOICE_LIMITS.emptySeconds),
      ignoreUserIds: ignored(input.ignoreUserIds), metadata: metadataInput(input.metadata), notice,
      speak, bargeIn: bargeIn.on, ...(bargeIn.policy ? { interruption: bargeIn.policy } : {}), voice, agentReplies,
      ...(transcription ? { transcription } : {}), ...(speech ? { speech } : {}),
      endOfTurn: endOfTurnInput(input.endOfTurn, this.options.turnModels ? "smart" : "silence"),
      addressing: addressingInput(input.addressing),
      ...(realtime ? { brain: "realtime" as const, realtime } : {}), ...(speakers ? { speakers } : {}),
    };
  }

  /**
   * `brain` and `realtime` as given: a realtime brain (a session that speaks: `speak` may be left out) on one of the
   * runtime's providers, with its model, voice (the session's mapped to the provider's when not given), persona and
   * listening settings; undefined for the cascade.
   */
  private realtimeInput(input: Record<string, unknown>, voice: string): RealtimeOptions | undefined {
    if (input.brain !== undefined && input.brain !== "cascade" && input.brain !== "realtime") throw new HttpError(400, "brain must be cascade or realtime");
    if (input.brain !== "realtime") {
      if (input.realtime !== undefined) throw new HttpError(400, "realtime is for brain: realtime");
      return undefined;
    }
    const providers = this.options.realtime?.providers ?? {};
    if (!Object.keys(providers).length) throw new HttpError(404, "Realtime voice is not enabled on this runtime (AGENT_VOICE_REALTIME)");
    if (input.speak === false) throw new HttpError(400, "A realtime brain speaks: leave speak out, or true");
    const given = input.realtime === undefined ? {} : object(input.realtime, "realtime");
    only(given, "realtime", ["provider", "model", "voice", "instructions", "transcribe", "speculative"]);
    const id = (given.provider ?? Object.keys(providers)[0]) as string;
    const provider = providers[id as RealtimeProviderId];
    if (!provider) throw new HttpError(400, `realtime.provider must be one of this runtime's: ${Object.keys(providers).join(", ")}`);
    const model = given.model === undefined ? provider.defaultModel : given.model;
    if (typeof model !== "string" || !provider.models.includes(model)) throw new HttpError(400, `realtime.model must be one of ${provider.models.join(", ")}`);
    if (!REALTIME_PRICES[`${provider.id}/${model}`]) throw new HttpError(400, `Realtime model ${provider.id}/${model} has no price configured`, "REALTIME_UNPRICED");
    if (given.voice !== undefined && (typeof given.voice !== "string" || !provider.voices.includes(given.voice))) throw new HttpError(400, `realtime.voice must be one of ${provider.id}'s: ${provider.voices.join(", ")}`);
    const instructions = given.instructions === undefined ? undefined : text(given.instructions, "realtime.instructions", new RegExp(`^[\\s\\S]{1,${VOICE_LIMITS.realtimeInstructionsChars}}$`), `at most ${VOICE_LIMITS.realtimeInstructionsChars} characters`);
    for (const flag of ["transcribe", "speculative"] as const) if (given[flag] !== undefined && typeof given[flag] !== "boolean") throw new HttpError(400, `realtime.${flag} must be true or false`);
    return {
      provider: provider.id, model, voice: (given.voice as string | undefined) ?? realtimeVoice(provider, voice),
      ...(instructions ? { instructions } : {}), transcribe: given.transcribe !== false, speculative: given.speculative !== false,
    };
  }

  /**
   * Start a session from the credentials the app forwarded: stored (the grant sealed), then taken and connected here
   * when this node can, else by a peer's scan. Answers the session with the notice the app must post.
   */
  async create(tenant: string, input: Record<string, unknown>) {
    only(input, "body", ["provider", "discord", "subject", "bucket", "context", "keyScope", "deliver", "language", "prompt", "silenceMs", "maxMinutes", "idleMinutes", "emptySeconds", "ignoreUserIds", "metadata", "notice", "speak", "bargeIn", "voice", "transcription", "speech", "endOfTurn", "addressing", "brain", "realtime", "speakers"]);
    const provider = input.provider ?? "discord";
    if (provider !== "discord" && provider !== "browser") throw new HttpError(400, `provider must be one of: ${VOICE_PROVIDERS.join(", ")}`);
    if (!this.options.transports[provider] || (provider === "browser" && !this.options.browser)) throw new HttpError(404, provider === "browser" ? "Browser voice sessions are not enabled on this runtime" : "Voice sessions are not enabled on this runtime");
    if (!this.options.accounts.canStoreKeys) throw new HttpError(503, "This runtime has no AGENT_SECRETS_KEY, so it cannot hold voice credentials");
    const id = `vs_${randomBytes(12).toString("hex")}`;
    let credentials: VoiceCredentials;
    if (provider === "browser") {
      if (input.discord !== undefined) throw new HttpError(400, "A browser session has no discord: leave it out");
      // Its own ids: the session's (unique, so any number of browser calls), and a bot that is never a speaker.
      credentials = { guildId: id, channelId: id, userId: BROWSER_BOT, sessionId: id, endpoint: "browser", token: randomBytes(16).toString("hex") };
    } else {
      if (input.discord === undefined) throw new HttpError(400, "discord is required: guildId, channelId, userId, sessionId, endpoint and token");
      credentials = discordInput(input.discord, this.endpoints()) as VoiceCredentials;
    }
    const options = this.settings(input, provider === "browser");
    if (options.agentReplies && !options.deliver.agent) throw new HttpError(400, "speak.agentReplies speaks deliver.agent's replies: give deliver.agent");
    if (options.agentReplies && !this.options.submitStreaming) throw new HttpError(404, "Speaking agents' replies is not enabled on this runtime");
    if (options.speak && (!(this.options.synthesizer || options.realtime) || !this.options.transports[provider]?.speaks)) throw new HttpError(404, "Speaking is not enabled on this runtime");
    if (options.endOfTurn?.mode === "smart" && !this.options.turnModels) throw new HttpError(404, "Smart end of turn is not enabled on this runtime: use endOfTurn silence");
    if (options.deliver.agent && !await this.options.agentOwned(options.deliver.agent, tenant)) throw new HttpError(404, "Unknown agent in deliver.agent");
    await this.options.admit(tenant);
    const refused = options.subject !== undefined ? await this.options.credit?.refusal(tenant, options.subject, options.bucket ?? DEFAULT_BUCKET) : undefined;
    if (refused) throw new HttpError(402, refused.message, "END_USER_CREDIT", { endUser: options.subject, bucket: options.bucket ?? DEFAULT_BUCKET, reason: refused.reason });
    if (options.transcription?.providers && !this.options.transcriber.options.live) throw new HttpError(404, "Streaming transcription is not enabled on this runtime");
    if (options.speech?.providers && !this.options.synthesizer?.options.chain) throw new HttpError(404, "Speech providers other than OpenAI are not enabled on this runtime");
    const streaming = this.options.transcriber.liveOrder(options.transcription?.providers);
    if (options.realtime) {
      const provider = this.options.realtime!.providers[options.realtime.provider]!;
      if (!await this.options.realtime!.key(tenant, options.keyScope, provider.key)) {
        throw new HttpError(400, `A realtime brain on ${provider.id} needs a key for ${provider.key}: add one under Models & keys (PUT /v1/providers/${provider.key}/key)${options.keyScope ? `, or to key scope ${options.keyScope}` : ""}`, "REALTIME_UNAVAILABLE");
      }
    } else if (!await this.options.canTranscribe(tenant, options.keyScope, streaming)) {
      const names = [...new Set(["openai", ...streaming.map(reference => reference.split("/")[0])])];
      throw new HttpError(400, `Voice sessions transcribe with a key for ${names.join(" or ")}: add one under Models & keys (PUT /v1/providers/<provider>/key)${options.keyScope ? `, or to key scope ${options.keyScope}` : ""}`, "TRANSCRIPTION_UNAVAILABLE");
    }
    const now = Date.now();
    const limit = this.options.perTenant?.(tenant) ?? VOICE_LIMITS.perTenant;
    const secret: Secret = { sessionId: credentials.sessionId, endpoint: credentials.endpoint, token: credentials.token };
    const row = await transaction(this.db, async sql => {
      // One at a time per tenant, so its limit holds.
      await sql.query("select pg_advisory_xact_lock(hashtext('voice-sessions:' || $1))", [tenant]);
      const existing = (await sql.query("select id from voice_sessions where tenant = $1 and provider = $2 and guild = $3 and bot_user = $4 and state <> 'ended'",
        [tenant, provider, credentials.guildId, credentials.userId])).rows[0];
      if (existing) throw new HttpError(409, `This bot already has a voice session in this server (${existing.id}): update it (PATCH) or end it (DELETE) first`, "VOICE_SESSION_EXISTS", { session: existing.id });
      const live = Number((await sql.query("select count(*) as count from voice_sessions where tenant = $1 and state <> 'ended'", [tenant])).rows[0].count);
      if (live >= limit) throw new HttpError(429, `This account has ${live} live voice sessions, its limit: end one first`, "VOICE_SESSION_LIMIT", { limit });
      return (await sql.query(`
        insert into voice_sessions (id, tenant, provider, guild, bot_user, channel, state, sealed, options, created_at, updated_at)
        values ($1, $2, $3, $4, $5, $6, 'connecting', $7, $8, $9, $9) returning *`,
      [id, tenant, provider, credentials.guildId, credentials.userId, credentials.channelId, JSON.stringify(this.options.accounts.seal(aad(id), JSON.stringify(secret))), JSON.stringify(options), now])).rows[0] as Row;
    });
    console.log(JSON.stringify({ type: "voice_session_created", session: id, tenant, provider, node: this.options.node }));
    if (!this.stopped) void this.take(row).catch(error => console.error(JSON.stringify({ type: "voice_take_failed", session: id, error: safeError(error) })));
    return {
      ...sessionView(row), notice: { required: true, channelId: credentials.channelId, text: options.notice.replaceAll("{bot}", credentials.userId) },
      // How the app should have joined: un-muted when the bot may speak.
      join: { self_mute: !options.speak, self_deaf: false },
      ...(provider === "browser" ? { browser: this.browserToken(id) } : {}),
    };
  }

  /** A browser session's socket: its URL, and a token that opens it (BROWSER_TOKEN_MS). */
  browserToken(id: string, now = Date.now()) {
    const browser = this.options.browser!;
    const expiresAt = now + BROWSER_TOKEN_MS;
    return { url: browser.url(id), token: `${expiresAt}.${createHmac("sha256", browser.secret).update(`voice-socket:${id}:${expiresAt}`).digest("base64url")}`, expiresAt };
  }

  /** Another token for a browser session's socket (the page reconnects after its first expired). */
  async newBrowserToken(tenant: string, id: string) {
    const row = await this.row(tenant, id);
    if (row.provider !== "browser") throw new HttpError(409, "Only a browser session has a socket", "VOICE_NOT_BROWSER");
    if (row.state === "ended") throw new HttpError(409, `This voice session ended (${row.end_reason})`, "VOICE_SESSION_ENDED");
    return this.browserToken(id);
  }

  /** Whether `token` opens session `id`'s socket now. */
  verifyBrowserToken(id: string, token: string, now = Date.now()) {
    const browser = this.options.browser;
    const [expires, signature] = token.split(".");
    if (!browser || !ID.test(id) || !expires || !signature || !(Number(expires) > now)) return false;
    const expected = createHmac("sha256", browser.secret).update(`voice-socket:${id}:${expires}`).digest();
    const given = Buffer.from(signature, "base64url");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** Whether this node holds session `id` now (its browser socket is served here). */
  holds(id: string) { return this.held.has(id); }

  private async row(tenant: string, id: string, sql: Pick<Db, "query"> = this.db): Promise<Row> {
    const row = ID.test(id) ? (await sql.query("select * from voice_sessions where id = $1 and tenant = $2", [id, tenant])).rows[0] as Row | undefined : undefined;
    if (!row) throw new HttpError(404, "Unknown voice session");
    return row;
  }

  async get(tenant: string, id: string) { return sessionView(await this.row(tenant, id)); }

  /** A tenant's sessions, newest first: live, ended or all of them, a page at a time (`after`: the last id seen). */
  async list(tenant: string, query: { state?: string; limit?: number; after?: string } = {}) {
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    if (query.state !== undefined && query.state !== "live" && query.state !== "ended") throw new HttpError(400, "state must be live or ended");
    const after = query.after !== undefined && ID.test(query.after)
      ? (await this.db.query("select created_at from voice_sessions where id = $1 and tenant = $2", [query.after, tenant])).rows[0] : undefined;
    if (query.after !== undefined && !after) throw new HttpError(400, "after must be a session id from this list");
    const { rows } = await this.db.query(`
      select * from voice_sessions where tenant = $1
        ${query.state === "live" ? "and state <> 'ended'" : query.state === "ended" ? "and state = 'ended'" : ""}
        ${after ? "and (created_at, id) < ($3, $4)" : ""}
      order by created_at desc, id desc limit $2`, after ? [tenant, limit, after.created_at, query.after] : [tenant, limit]);
    return { sessions: (rows as Row[]).map(sessionView), next: rows.length === limit ? rows.at(-1).id as string : null };
  }

  /**
   * Discord moved the call (a new voice server, or a move to another channel), or the app changed whom to ignore or the
   * metadata: stored, and the owner reconnects with the new credentials.
   */
  async update(tenant: string, id: string, input: Record<string, unknown>) {
    only(input, "body", ["discord", "ignoreUserIds", "metadata", "speakers"]);
    if (input.discord !== undefined && (await this.row(tenant, id)).provider === "browser") throw new HttpError(400, "A browser session has no discord to change");
    const changes = input.discord === undefined ? {} : discordInput(input.discord, this.endpoints(), true);
    const ignore = input.ignoreUserIds === undefined ? undefined : ignored(input.ignoreUserIds);
    const metadata = input.metadata === undefined ? undefined : metadataInput(input.metadata);
    const speakers = speakersInput(input.speakers);
    const row = await transaction(this.db, async sql => {
      const current = await this.row(tenant, id, sql);
      const locked = (await sql.query("select * from voice_sessions where id = $1 for update", [current.id])).rows[0] as Row;
      if (locked.state === "ended") throw new HttpError(409, `This voice session ended (${locked.end_reason}); start a new one`, "VOICE_SESSION_ENDED");
      const secret: Secret = JSON.parse(this.options.accounts.unseal(aad(id), locked.sealed!));
      const next: Secret = { sessionId: changes.sessionId ?? secret.sessionId, endpoint: changes.endpoint === undefined ? secret.endpoint : changes.endpoint, token: changes.token ?? secret.token };
      const options = { ...locked.options, ...(ignore ? { ignoreUserIds: ignore } : {}), ...(metadata ? { metadata } : {}), ...(speakers ? { speakers } : {}) };
      return (await sql.query(`
        update voice_sessions set sealed = $2, options = $3, channel = $4, revision = revision + 1, updated_at = $5 where id = $1 returning *`,
      [id, JSON.stringify(this.options.accounts.seal(aad(id), JSON.stringify(next))), JSON.stringify(options), changes.channelId ?? locked.channel, Date.now()])).rows[0] as Row;
    });
    await this.changed(id);
    return sessionView(row);
  }

  /**
   * Say `text` in the call (a session that speaks): queued behind what is being said, or with `interrupt`, instead of
   * it. Only the node that holds the session plays it (requests reach it: node.ts routes them), so elsewhere a 503 says
   * to retry while the session moves.
   */
  async speak(tenant: string, id: string, input: Record<string, unknown>) {
    only(input, "body", ["text", "voice", "voices", "instructions", "interrupt"]);
    const textGiven = text(input.text, "text", new RegExp(`^[\\s\\S]{1,${SPEECH_LIMITS.textChars}}$`), `1 to ${SPEECH_LIMITS.textChars} characters`);
    if (!textGiven.trim()) throw new HttpError(400, "text must say something");
    const voice = input.voice === undefined ? undefined : text(input.voice, "voice", VOICE_NAME, "a voice's name, such as alloy, coral or verse");
    // This speech's voice for each provider of the session's chain, over the session's own (speech.voices).
    const voices = voicesInput(input.voices, "voices");
    const instructions = input.instructions === undefined ? undefined : text(input.instructions, "instructions", new RegExp(`^[\\s\\S]{1,${SPEECH_LIMITS.instructionsChars}}$`), `at most ${SPEECH_LIMITS.instructionsChars} characters`);
    if (input.interrupt !== undefined && typeof input.interrupt !== "boolean") throw new HttpError(400, "interrupt must be true or false");
    const row = await this.row(tenant, id);
    if (row.state === "ended") throw new HttpError(409, `This voice session ended (${row.end_reason})`, "VOICE_SESSION_ENDED");
    if (!row.options.speak) throw new HttpError(409, "This voice session does not speak: start one with speak: true", "VOICE_SPEAK_DISABLED");
    if (row.options.brain === "realtime") throw new HttpError(409, "This voice session's realtime brain speaks for itself", "VOICE_REALTIME");
    const held = this.held.get(id);
    if (!held?.speech) throw new HttpError(503, "This voice session is moving between nodes; retry");
    if (held.speech.waiting >= SPEECH_QUEUE.max && !input.interrupt) throw new HttpError(429, `This voice session has ${SPEECH_QUEUE.max} speeches waiting; interrupt or wait`, "VOICE_SPEECH_QUEUE_FULL");
    const turn = this.waitingTurns.take(id)?.via("speak").mark("firstPiece");
    const item: SpeechItem = { id: speechId(), text: textGiven, voice: voice ?? row.options.voice, ...(voices ? { voices } : {}), ...(instructions ? { instructions } : {}), queuedAt: Date.now(), ...(turn ? { turn } : {}) };
    const position = held.speech.say(item, input.interrupt === true);
    console.log(JSON.stringify({ type: "voice_speech_queued", session: id, speech: item.id, chars: item.text.length, position, node: this.options.node }));
    return { speechId: item.id, session: id, state: "queued" as const, position, voice: item.voice, characters: item.text.length };
  }

  /**
   * A prompt's `speak` ({session, voice?, interrupt?}), checked before the prompt is taken: one of the tenant's sessions
   * that speaks and has not ended. The tenant may name any; an agent's own token (`agentToken`, which may be in an end
   * user's browser) only a session of its agent's subject, so one user cannot make another's bot talk.
   */
  async replyTarget(tenant: string, input: unknown, agentToken?: { subject?: string }): Promise<VoiceReplyTarget> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "speak is {session, voice?, interrupt?}");
    const given = input as Record<string, unknown>;
    only(given, "speak", ["session", "voice", "interrupt"]);
    const session = text(given.session, "speak.session", /^vs_[a-f0-9]{24}$/, "a voice session's id (vs_…)");
    const voice = given.voice === undefined ? undefined : text(given.voice, "speak.voice", VOICE_NAME, "a voice's name, such as alloy, coral or verse");
    if (given.interrupt !== undefined && typeof given.interrupt !== "boolean") throw new HttpError(400, "speak.interrupt must be true or false");
    if (!this.options.followStreaming) throw new HttpError(404, "Speaking a prompt's reply is not enabled on this runtime");
    const row = await this.row(tenant, session);
    if (row.state === "ended") throw new HttpError(409, `This voice session ended (${row.end_reason})`, "VOICE_SESSION_ENDED");
    if (agentToken && (agentToken.subject === undefined || row.options.subject !== agentToken.subject)) {
      throw new HttpError(403, agentToken.subject === undefined
        ? "An agent's token may speak only in voice sessions of its agent's subject, and this agent has none: prompt with the tenant's API key"
        : "An agent's token may speak only in voice sessions whose subject is its agent's: prompt with the tenant's API key", "VOICE_SPEAK_FORBIDDEN");
    }
    if (!row.options.speak) throw new HttpError(409, "This voice session does not speak: start one with speak: true", "VOICE_SPEAK_DISABLED");
    if (row.options.brain === "realtime") throw new HttpError(409, "This voice session's realtime brain speaks for itself", "VOICE_REALTIME");
    return { session, ...(voice ? { voice } : {}), ...(given.interrupt === true ? { interrupt: true } : {}) };
  }

  /**
   * Speak a run's reply in a session (a prompt's speak), as it is written: as `agentReplies` does an utterance's, on the
   * node that holds the session (elsewhere, 503: node.ts sends it there). A run already being spoken is not again.
   */
  async speakRun(tenant: string, target: VoiceReplyTarget, run: { agent: string; requestId: string }) {
    const row = await this.row(tenant, target.session);
    if (row.state === "ended") return { speaking: false };
    const held = this.held.get(target.session);
    if (!held?.speech) throw new HttpError(503, "This voice session is moving between nodes; retry");
    const key = `${run.agent}:${run.requestId}`;
    const replies = held.replies ??= new Set();
    if (replies.has(key)) return { speaking: true };
    replies.add(key);
    if (replies.size > 100) replies.delete(replies.values().next().value!);
    const speech = held.speech;
    console.log(JSON.stringify({ type: "voice_reply_followed", session: held.id, agent: run.agent, request: run.requestId, node: this.options.node }));
    const turn = this.waitingTurns.take(held.id)?.via("prompt_speak");
    const job = this.sayAsWritten(held, speech, run, target, signal => this.options.followStreaming!(run.agent, tenant, run.requestId, signal), undefined, turn)
      .catch(error => console.error(JSON.stringify({ type: "voice_reply_stream_failed", session: held.id, request: run.requestId, status: (error as HttpError).status, error: safeError(error) })));
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
    return { speaking: true };
  }

  /** Stop what the bot is saying, and what it was going to: answers how many speeches that stopped. */
  async stopSpeaking(tenant: string, id: string) {
    const row = await this.row(tenant, id);
    if (!row.options.speak) throw new HttpError(409, "This voice session does not speak", "VOICE_SPEAK_DISABLED");
    if (row.state === "ended") return { stopped: 0 };
    const held = this.held.get(id);
    if (held?.brain) return { stopped: held.brain.stopSpeaking() };
    if (!held?.speech) throw new HttpError(503, "This voice session is moving between nodes; retry");
    return { stopped: held.speech.stop("requested") };
  }

  /** End a session (`requested`): answers it, and the OP 4 the app sends to leave the channel. */
  async end(tenant: string, id: string) {
    const row = await this.row(tenant, id);
    const ended = row.state === "ended" ? row : await this.finish(undefined, id, { reason: "requested" }) ?? await this.row(tenant, id);
    return { ...sessionView(ended), leave: { op: 4, d: { guild_id: ended.guild, channel_id: null, self_mute: false, self_deaf: false } } };
  }

  // Holding sessions --------------------------------------------------------------

  /**
   * Every open session's row: hold those this node should, let go of what it no longer may, and end sessions past their
   * limits. Any node may run it; one at a time here.
   */
  async scan(now = Date.now()) {
    // A scan asked for while one runs (a peer's notification) runs again after it: what it was told may be newer.
    if (this.scanning) { this.rescan = true; return; }
    this.scanning = true;
    try {
      // With whether a node holds each now (a live heartbeat names it): those are left to it, without trying to take them.
      const { rows } = await this.db.query(`
        select v.*, n.node is not null as owned from voice_sessions v
        left join actor_owners o on o.actor = 'voice:' || v.id
        left join runtime_nodes n on n.node = o.node and n.session = o.session and n.expires_at > now()
        where v.state <> 'ended'`);
      const open = new Map((rows as Row[]).map(row => [row.id, row]));
      for (const held of [...this.held.values()]) {
        const row = open.get(held.id);
        if (!this.options.ownership?.holds(held.claim)) void this.drop(held, false);
        else if (!row) void this.drop(held, true, "end");
        else {
          if (row.revision !== held.revision) this.apply(held, row);
          await this.limits(held, now);
        }
      }
      if (!this.stopped && !this.options.ownership?.draining) {
        for (const row of open.values()) {
          if (this.held.has(row.id) || (row as Row & { owned: boolean }).owned) continue;
          if (this.held.size >= (this.options.perNode ?? VOICE_LIMITS.perNode)) break;
          await this.take(row).catch(error => console.error(JSON.stringify({ type: "voice_take_failed", session: row.id, error: safeError(error) })));
        }
      }
      await this.prune(now);
    } finally { this.scanning = false; }
    if (this.rescan) {
      this.rescan = false;
      await this.scan();
    }
  }

  /** A session changed on some node (`pg_notify`): apply it here at once if this node holds it. */
  async changed(id: string, notify = true) {
    const held = this.held.get(id);
    if (held) {
      const row = (await this.db.query("select * from voice_sessions where id = $1", [id])).rows[0] as Row | undefined;
      if (!row || row.state === "ended") void this.drop(held, true, "end");
      else if (row.revision !== held.revision) this.apply(held, row);
      return;
    }
    if (notify) await this.notify([id]);
  }

  private async notify(ids: string[]) {
    for (const id of ids) await this.db.query("select pg_notify($1, $2)", [VOICE_CHANNEL, `${this.options.node} ${id}`]);
  }

  /** A notification from any node (VOICE_CHANNEL): `<node> <session>`. Sessions released by a peer are taken by a scan soon. */
  heard(payload: string) {
    const [from, id] = payload.split(" ");
    if (!id || from === this.options.node) return;
    if (this.held.has(id)) void this.changed(id, false).catch(error => console.error(JSON.stringify({ type: "voice_change_failed", session: id, error: safeError(error) })));
    else if (!this.stopped) void this.scan().catch(error => console.error(JSON.stringify({ type: "voice_scan_failed", error: safeError(error) })));
  }

  /**
   * Take a session and connect it, unless another node holds it, or this node holds it already or is taking it (the
   * request's take and a scan's at once would each acquire it, and connect twice).
   */
  private async take(row: Row) {
    const { ownership } = this.options;
    if (!ownership || this.held.has(row.id) || this.taking.has(row.id) || ownership.draining) return;
    const transport = this.options.transports[row.provider as typeof VOICE_PROVIDERS[number]];
    if (!transport) return;
    this.taking.add(row.id);
    try { await this.takeNow(row, ownership, transport); }
    finally { this.taking.delete(row.id); }
  }

  private async takeNow(row: Row, ownership: Ownership, transport: VoiceTransport) {
    const taken = await ownership.acquire(actor(row.id)).catch(() => undefined);
    if (!taken || !("claim" in taken)) return;
    // Read again under the claim: a change made before it was taken is what this node connects with.
    const current = (await this.db.query("select * from voice_sessions where id = $1", [row.id])).rows[0] as Row | undefined;
    if (!current || current.state === "ended" || this.held.has(row.id)) {
      if (!this.held.has(row.id)) await ownership.release(taken.claim).catch(() => {});
      return;
    }
    const held: Held = {
      id: current.id, tenant: current.tenant, claim: taken.claim, revision: current.revision, row: current, credentials: this.credentials(current),
      floor: new Floor(current.options.addressing ?? {}, () => clock().now()),
    };
    if (current.options.brain === "realtime") {
      const brain = await this.brainOf(held).catch((error: unknown) => { console.error(JSON.stringify({ type: "voice_realtime_unavailable", session: held.id, error: safeError(error) })); return undefined; });
      if (!brain) {
        await ownership.release(taken.claim).catch(() => {});
        await this.finish(undefined, held.id, { reason: "error", detail: "realtime_unavailable" }).catch(() => {});
        return;
      }
      held.brain = brain;
    } else if (current.options.speak && this.options.synthesizer) held.speech = new SessionSpeech(this.options.synthesizer, this.speechEffects(held));
    this.held.set(held.id, held);
    console.log(JSON.stringify({ type: "voice_session_acquired", session: held.id, node: this.options.node, epoch: taken.claim.epoch }));
    if (current.state === "live") await this.setState(held, "reconnecting").catch(() => {});
    this.connect(held, transport);
  }

  /** A session's segmenter: turn-taking's (smart), when the session asks for it and this node has the models; else by level and silence. */
  private credentials(row: Row): VoiceCredentials {
    const secret: Secret = JSON.parse(this.options.accounts.unseal(aad(row.id), row.sealed!));
    return { guildId: row.guild, channelId: row.channel, userId: row.bot_user, ...secret };
  }

  /** What a session's media needs of its settings. */
  private mediaOptions(held: Held): MediaOptions {
    const { options } = held.row;
    // Transcribed as they speak, when this runtime can: each utterance committed as it is cut.
    const policy = interruption(options);
    return {
      silenceMs: options.silenceMs, ignoreUserIds: options.ignoreUserIds, bargeIn: !!(held.speech || held.brain) && options.bargeIn !== false,
      bargeInMinMs: policy.minMs, bargeInPause: policy.confirmMs > 0,
      // A realtime brain hears each speaker's audio as it comes.
      live: !!held.brain || this.options.transcriber.liveOrder(options.transcription?.providers).length > 0,
      ...(options.endOfTurn ? { endOfTurn: options.endOfTurn } : {}),
    };
  }

  /**
   * The session's echo guard (src/voice/echo-guard.ts), made at its first barge-in: for a session that speaks with
   * bargeIn on and a confirmMs (else barge-in stops the bot at minMs, unguarded). Each decision is logged and counted:
   * `voice_barge_in_candidate` (paused), then `voice_barge_in_confirmed` (stopped) or `voice_barge_in_echo_rejected`
   * (resumed), with `why` and `pausedMs`. Never the words.
   */
  private guardOf(held: Held): BargeInGuard | undefined {
    if (held.guard) return held.guard;
    const { options } = held.row;
    const policy = interruption(options);
    if (!held.speech || options.bargeIn === false || policy.confirmMs <= 0) return undefined;
    const log = (type: string, outcome: BargeInOutcome) => {
      const { type: _type, ...fields } = outcome;
      console.log(JSON.stringify({ type, session: held.id, node: this.options.node, ...fields }));
      writeMetricLine(metricLine("voice_barge_in", {
        dimensions: { Outcome: outcome.type, Why: outcome.why }, rollups: [["Outcome"], ["Outcome", "Why"]],
        metrics: { VoiceBargeIns: 1, VoiceBargeInPausedMs: [outcome.pausedMs, "Milliseconds"] }, properties: { session: held.id, tenant: held.tenant },
      }));
    };
    held.guard = new BargeInGuard(policy, {
      speaking: () => !!held.speech?.speaking,
      spoken: () => held.speech?.recentlySaid() ?? [],
      stop: outcome => {
        log("voice_barge_in_confirmed", outcome);
        held.speech?.stop("barge_in");
        held.media?.resume();
      },
      resume: outcome => {
        log("voice_barge_in_echo_rejected", outcome);
        held.media?.resume();
      },
    });
    return held.guard;
  }

  /** Open the session's media: its connection, and its speakers' audio cut into utterances. */
  private connect(held: Held, transport: VoiceTransport) {
    if (held.credentials.endpoint === null) return;
    const log = (type: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ type, session: held.id, node: this.options.node, epoch: held.claim.epoch, ...fields }));
    const factory = this.options.media?.(transport, held.row.provider as typeof VOICE_PROVIDERS[number]) ?? inlineMedia(transport, this.options.turnModels);
    // Events of a media replaced (lost, crashed) or of a session let go are not the session's, but its cuts are: what
    // was said is still transcribed.
    let media: Media | undefined;
    const current = () => this.held.get(held.id) === held && held.media === media;
    media = factory(held.id, held.credentials, this.mediaOptions(held), {
      ready: () => {
        if (!current()) return;
        held.lost = undefined;
        log("voice_session_ready");
        void this.ready(held).catch(error => console.error(JSON.stringify({ type: "voice_ready_failed", session: held.id, error: safeError(error) })));
      },
      lost: (reason, detail) => {
        if (!current()) return;
        log("voice_session_lost", { reason, ...(detail ? { detail } : {}) });
        held.lost = { at: Date.now(), reason, ...(detail ? { detail } : {}) };
        held.media = undefined;
        void media!.close("error");
        void this.setState(held, "reconnecting").catch(() => {});
        // Only the app's gateway can get new credentials (OP 4 for the same channel again): it is told at once.
        if (reason === "credentials") this.credentialsNeeded(held, detail);
      },
      diagnostic: (event, fields) => log(`voice_${event}`, fields),
      speechStart: speaker => {
        if (!current()) return;
        (held.speechStarts ??= new Map()).set(speaker, clock().now());
        if (held.brain) { held.brain.speechStart(speaker); return; }
        // A reply may follow what they say: the speech provider's connection is made now, not when it is asked.
        if (held.speech) this.options.synthesizer?.warm(held.row.options.speech?.providers);
      },
      // Barge-in: a person talked over the bot for minMs. The media already stopped what it plays, or paused it for
      // the echo guard to decide.
      bargeIn: (speaker, speechMs) => {
        if (!current()) return;
        if (held.brain) { held.brain.bargeIn(speaker, speechMs, held.speechStarts?.get(speaker)); return; }
        const guard = this.guardOf(held);
        if (!guard) {
          if (held.row.options.bargeIn && held.speech?.speaking) {
            log("voice_barge_in_confirmed", { why: "immediate", pausedMs: 0, speechMs });
            held.speech.stop("barge_in");
          }
          return;
        }
        if (guard.candidate(speaker, speechMs, held.speechStarts?.get(speaker))) {
          if (guard.pausing) log("voice_barge_in_candidate", { speechMs });
        } else held.media?.resume();
      },
      speechProgress: (speaker, speechMs) => { if (current()) { if (held.brain) held.brain.speechProgress(speaker, speechMs); else held.guard?.progress(speaker, speechMs); } },
      // Smart turns: a turn too short to be an utterance (a cough) ends a barge-in pause it made, at once.
      turn: event => {
        if (!current()) return;
        held.brain?.turnEvent(event);
        if (event.type === "turn_end") held.guard?.ended(event.speaker, event.speechMs);
        // Likely done: its transcript is made now, while the turn waits to be sure (preemptive transcription).
        if (event.type === "likely_end") this.commitEarly(held, event.speaker);
        if (event.type === "resume") { const live = held.live?.get(event.speaker); if (live?.early) live.resumed = true; }
        (held.turnStats ??= { likelyEnds: 0, resumes: 0, turns: 0 });
        if (event.type === "likely_end") held.turnStats.likelyEnds++;
        else if (event.type === "resume") held.turnStats.resumes++;
        else if (event.type === "turn_end") held.turnStats.turns++;
      },
      pcm: (speaker, pcm) => { if (current()) { if (held.brain) held.brain.pcm(speaker, pcm); else this.liveAudio(held, speaker, pcm); } },
      drop: speaker => { if (held.brain) { if (current()) held.brain.drop(speaker); } else this.liveDrop(held, speaker); },
      // A realtime brain's turns are its own: nothing is transcribed after.
      cut: cut => { if (held.brain) { if (current()) held.brain.cut(cut); } else this.cut(held, cut); },
      crashed: reason => { if (current()) this.crashed(held, transport, reason); },
    });
    held.media = media;
  }

  /**
   * The session's media died (src/voice/media-host.ts): its worker crashed, ran out of memory or stopped answering.
   * Nothing else on the node is touched. The session says so (`voice.session.error`) and reconnects in a fresh worker
   * with the same credentials, unless that is the MEDIA_CRASHES.max-th time in its window: then it ends (`error`).
   */
  private crashed(held: Held, transport: VoiceTransport, reason: string) {
    held.media = undefined;
    const now = Date.now();
    held.crashes = [...(held.crashes ?? []).filter(at => now - at < MEDIA_CRASHES.windowMs), now];
    const attempt = held.crashes.length, restarting = attempt < MEDIA_CRASHES.max;
    console.error(JSON.stringify({ type: "voice_media_crashed", session: held.id, node: this.options.node, reason: reason.slice(0, 300), attempt, restarting }));
    // What each speaker's live stream had of an utterance the media will never cut is forgotten.
    for (const live of held.live?.values() ?? []) live.stream.clear();
    void transaction(this.db, async sql => {
      const row = (await sql.query("select * from voice_sessions where id = $1", [held.id])).rows[0] as Row | undefined;
      if (row?.options.deliver.webhooks && row.state !== "ended") {
        await enqueueEvents(sql, [this.event(row, "voice.session.error", { code: "media_crashed", detail: reason.slice(0, 200), restarting, attempt }, `voice:${held.id}:error:${now}`)]);
      }
    }).then(() => this.options.kickWebhooks?.(), error => console.error(JSON.stringify({ type: "voice_event_failed", session: held.id, error: safeError(error) })));
    if (!restarting) {
      void this.finish(held, held.id, { reason: "error", detail: "media_crashed" }).catch(error => console.error(JSON.stringify({ type: "voice_finish_failed", session: held.id, error: safeError(error) })));
      return;
    }
    this.connect(held, transport);
  }

  /**
   * Discord stopped taking the session's credentials (`lost`, `credentials`): `voice.session.error`
   * (`credentials_needed`) goes out now, so the app sends OP 4 for the same channel again and PATCHes what Discord
   * answers within `reconnectGraceMs`; else the session ends (`credentials`).
   */
  private credentialsNeeded(held: Held, detail?: string) {
    const now = Date.now();
    void transaction(this.db, async sql => {
      const row = (await sql.query("select * from voice_sessions where id = $1", [held.id])).rows[0] as Row | undefined;
      if (row?.options.deliver.webhooks && row.state !== "ended") {
        await enqueueEvents(sql, [this.event(row, "voice.session.error", {
          code: "credentials_needed", detail: (detail ?? "credentials").slice(0, 200), restarting: true,
          waitMs: this.options.reconnectGraceMs ?? VOICE_LIMITS.reconnectGraceMs,
        }, `voice:${held.id}:error:${now}`)]);
      }
    }).then(() => this.options.kickWebhooks?.(), error => console.error(JSON.stringify({ type: "voice_event_failed", session: held.id, error: safeError(error) })));
  }

  /** Apply a row changed elsewhere: new credentials reconnect, other changes are read as they are. */
  private apply(held: Held, row: Row) {
    held.revision = row.revision;
    held.row = row;
    if (row.state === "ended") { void this.drop(held, true, "end"); return; }
    const credentials = this.credentials(row);
    const moved = JSON.stringify(credentials) !== JSON.stringify(held.credentials);
    held.credentials = credentials;
    held.media?.configure({ ignoreUserIds: row.options.ignoreUserIds });
    if (!moved) return;
    held.lost = undefined;
    if (held.media && credentials.endpoint !== null) held.media.update(credentials);
    else {
      void held.media?.close("error");
      held.media = undefined;
      const transport = this.options.transports[row.provider as typeof VOICE_PROVIDERS[number]];
      if (transport) this.connect(held, transport);
    }
  }

  /**
   * Stop holding a session: its connection closes, what its speakers said so far is cut (and still transcribed: the
   * session ended, or moves to another node), and released (`release`), any node may take it at once.
   */
  private async drop(held: Held, release: boolean, cut: "handoff" | "end" = "handoff") {
    if (this.held.get(held.id) !== held) return;
    this.held.delete(held.id);
    // Speech stops first (why: the session ended or moved), then the media cuts what its speakers said so far.
    held.speech?.close(cut);
    held.brain?.close();
    held.guard?.close();
    // What turn-taking did in this session, for tuning: likely ends spoken past (resumes) are speculation discarded.
    if (held.turnStats) {
      const { likelyEnds, resumes, turns } = held.turnStats;
      console.log(JSON.stringify({ type: "voice_turn_stats", session: held.id, turns, likelyEnds, resumes, discardRate: likelyEnds ? Math.round(resumes / likelyEnds * 1_000) / 1_000 : null, floor: held.floor.stats }));
    }
    this.waitingTurns.forget(held.id);
    const media = held.media;
    held.media = undefined;
    await media?.close(cut).catch(error => console.error(JSON.stringify({ type: "voice_media_close_failed", session: held.id, error: safeError(error) })));
    // Their live streams close once the cuts just committed have their transcripts.
    for (const live of held.live?.values() ?? []) { clearTimeout(live.idle); live.stream.close(true); }
    held.live?.clear();
    console.log(JSON.stringify({ type: "voice_session_released", session: held.id, node: this.options.node, epoch: held.claim.epoch, release }));
    if (release) await this.options.ownership?.release(held.claim).catch(() => {});
  }

  /** The connection is ready: the session is live, and the first time, `voice.session.started` goes out. */
  private async ready(held: Held) {
    const now = Date.now();
    await underClaim(this.db, held.claim, async sql => {
      const before = (await sql.query("select state, started_at, options from voice_sessions where id = $1 for update", [held.id])).rows[0];
      if (!before || before.state === "ended") return;
      const { rows } = await sql.query("update voice_sessions set state = 'live', started_at = coalesce(started_at, $2), updated_at = $2 where id = $1 returning *", [held.id, now]);
      held.row = rows[0];
      if (before.started_at === null && held.row.options.deliver.webhooks) {
        await enqueueEvents(sql, [this.event(held.row, "voice.session.started", {}, `voice:${held.id}:started`)]);
      }
    });
  }

  private async setState(held: Held, state: VoiceState) {
    await underClaim(this.db, held.claim, sql => sql.query("update voice_sessions set state = $2, updated_at = $3 where id = $1 and state <> 'ended'", [held.id, state, Date.now()]));
  }

  /**
   * A speaker's audio as they speak, to their live stream (opened at their first utterance, closed after a minute
   * without one). A stream that broke stays broken until the utterance is cut: its commit fails, and the utterance is
   * transcribed after, whole.
   */
  private liveAudio(held: Held, speaker: string, pcm: Uint8Array) {
    let live = held.live?.get(speaker);
    if (!live) {
      const { options } = held.row;
      // Its words so far go to the echo guard, which decides a barge-in pause sooner with them.
      const onEvent = (event: SttEvent) => {
        if (event.type === "partial" || event.type === "eager_end_of_turn") held.guard?.heard(speaker, event.text, false);
      };
      const opened = this.options.transcriber.live({ tenant: held.tenant, ...(options.keyScope ? { keyScope: options.keyScope } : {}) }, { ...(options.language ? { language: options.language } : {}), ...(options.prompt ? { prompt: options.prompt } : {}), ...(options.transcription?.keyterms ? { keyterms: options.transcription.keyterms } : {}), onEvent }, options.transcription?.providers);
      if (!opened) return;
      (held.live ??= new Map()).set(speaker, live = { ...opened, appended: 0 });
    }
    live.stream.append(pcm);
    live.appended += pcm.length;
    clearTimeout(live.idle);
    const current = live;
    live.idle = setTimeout(() => {
      if (held.live?.get(speaker) !== current) return;
      held.live.delete(speaker);
      current.stream.close(true);
    }, LIVE_LIMITS.idleMs);
    live.idle.unref?.();
  }

  /** An utterance was cut: transcribed and delivered after the speaker's previous one. */
  /** A turn is likely over: commit its speaker's stream now (more of it, if they go on, is committed with the cut). */
  private commitEarly(held: Held, speaker: string) {
    const live = held.live?.get(speaker);
    if (!live || live.stream.closed || !live.appended) return;
    const part = live.stream.commit();
    part.catch(() => {});
    live.early = live.early ? joined(live.early, part) : part;
    live.appended = 0;
    live.resumed = undefined;
  }

  /** An utterance too short to keep: its stream forgets it, and what was committed early of it. */
  private liveDrop(held: Held, speaker: string) {
    const live = held.live?.get(speaker);
    if (!live) return;
    live.stream.clear();
    live.appended = 0;
    live.early = undefined;
    live.resumed = undefined;
  }

  private cut(held: Held, cut: Cut) {
    const origin: Origin = { id: held.id, tenant: held.tenant, claim: held.claim, row: held.row };
    const key = `${held.id}:${cut.speaker}`;
    // Committed now, before the speaker's next words reach the stream.
    const live = cut.live ? held.live?.get(cut.speaker) : undefined;
    let committed: Committed | undefined;
    if (live) {
      // What was committed early, and what came after it: speech only if they spoke again, else the silence before the
      // cut (cleared, not sent).
      const early = live.early, resumed = live.resumed;
      live.early = undefined;
      live.resumed = undefined;
      const rest = !early || (resumed && live.appended) ? live.stream.commit() : undefined;
      if (!rest && live.appended) live.stream.clear();
      live.appended = 0;
      committed = { transcript: early && rest ? joined(early, rest) : (rest ?? early)!, platform: live.platform };
      committed.transcript.catch(() => {});
      // A broken stream is replaced at the speaker's next utterance.
      if (live.stream.closed) { clearTimeout(live.idle); held.live!.delete(cut.speaker); }
    }
    // A session that speaks times the turn, from the end of speech to its reply's first audio.
    const turn = held.speech ? new TurnClock(cut.endedAt, { session: held.id, tenant: held.tenant }).mark("turnCommit") : undefined;
    const job = (this.speakers.get(key) ?? Promise.resolve()).then(() => this.utterance(origin, cut, committed, turn)).catch(error =>
      console.error(JSON.stringify({ type: "voice_utterance_failed", session: held.id, error: safeError(error) })));
    this.speakers.set(key, job);
    this.pending.add(job);
    void job.finally(() => {
      this.pending.delete(job);
      if (this.speakers.get(key) === job) this.speakers.delete(key);
    });
  }

  /** A turn to transcribe on this node, or undefined after `waitMs` without one. */
  private async slot(waitMs: number): Promise<(() => void) | undefined> {
    const free = () => {
      this.transcribing--;
      this.slots.shift()?.();
    };
    if (this.transcribing < (this.options.transcriptionsPerNode ?? VOICE_LIMITS.transcriptionsPerNode)) {
      this.transcribing++;
      return free;
    }
    const turn = Promise.withResolvers<boolean>();
    const wake = () => { this.transcribing++; turn.resolve(true); };
    this.slots.push(wake);
    const timer = setTimeout(() => {
      const index = this.slots.indexOf(wake);
      if (index >= 0) { this.slots.splice(index, 1); turn.resolve(false); }
    }, waitMs);
    const given = await turn.promise;
    clearTimeout(timer);
    return given ? free : undefined;
  }

  /**
   * Transcribe an utterance and deliver it: the tenant's run limit first (past it the session ends, `budget`), then a
   * fresh lease, then the provider; its usage recorded as the session's subject's; its transcript counted and sent
   * (the webhook event in the same transaction as the count, the agent's prompt after).
   */
  private async utterance(origin: Origin, cut: Cut, committed?: Committed, turn?: TurnClock) {
    try { await this.transcribeAndDeliver(origin, cut, committed, turn); }
    finally {
      // A turn nothing took on (no transcript, a session gone, nothing that replies) ends here.
      if (turn && !turn.ended && !turn.path && !this.waitingTurns.holds(turn)) turn.end(turn.marks.transcript === undefined ? "error" : "no_reply");
    }
  }

  private async transcribeAndDeliver(origin: Origin, cut: Cut, committed?: Committed, turn?: TurnClock) {
    const free = await this.slot(VOICE_LIMITS.queueMs);
    if (!free) {
      console.error(JSON.stringify({ type: "voice_utterance_dropped", session: origin.id, reason: "queue", seconds: cut.seconds }));
      return;
    }
    let done: Transcribed;
    const { options } = origin.row;
    const started = Date.now();
    try {
      try { await this.options.admit(origin.tenant); }
      catch (error) {
        if ((error as HttpError).status !== 402) throw error;
        await this.endFor(origin, { reason: "budget", limit: "tenant" });
        return;
      }
      // The subject's credit: what the audio costs, held before it is sent (refused: the session ends).
      let hold: Awaited<ReturnType<VoiceCredit["hold"]>>;
      const { credit } = this.options;
      try {
        hold = options.subject !== undefined && credit
          ? await credit.hold(origin.tenant, options.subject, options.bucket ?? DEFAULT_BUCKET, this.options.transcriber.cost(cut.seconds, !!committed, options.transcription?.providers), "voice", { session: origin.id })
          : undefined;
      } catch (error) {
        if ((error as HttpError).code !== "END_USER_CREDIT") throw error;
        const { reason, bucket } = (error as HttpError).details ?? {};
        await this.endFor(origin, { reason: "budget", limit: "end_user", ...(typeof reason === "string" ? { endUserReason: reason } : {}), ...(typeof bucket === "string" ? { bucket } : {}) });
        return;
      }
      const bytes = oggOpus(cut.packets);
      try {
        await this.options.ownership?.whenFresh();
        const live = committed && await this.liveTranscript(origin, cut, committed);
        done = live ?? await this.options.transcriber.transcribe({ tenant: origin.tenant, ...(options.keyScope ? { keyScope: options.keyScope } : {}) }, { bytes, header: checkedAudio(bytes) },
          { ...(options.language ? { language: options.language } : {}), ...(options.prompt ? { prompt: options.prompt } : {}) }, AbortSignal.timeout(5 * 60_000));
      } catch (error) {
        await hold?.release().catch(() => {});
        const code = (error as HttpError).code;
        // No key any more (deleted), or no credit: nothing more can be transcribed.
        if (code === "TRANSCRIPTION_UNAVAILABLE") await this.endFor(origin, { reason: "error", detail: "no transcription key" });
        else if ((error as HttpError).status === 402) await this.endFor(origin, { reason: "budget", limit: "tenant" });
        else console.error(JSON.stringify({ type: "voice_transcription_failed", session: origin.id, seconds: cut.seconds, error: safeError(error) }));
        return;
      }
      // Settled with what it cost; a hold that cannot be settled expires, as a model call's does.
      await hold?.settle(done.usage.usage.cost.total as number).catch(error =>
        console.error(JSON.stringify({ type: "voice_credit_settle_failed", session: origin.id, error: safeError(error) })));
    } finally { free(); }
    const { transcript, usage } = done;
    // The words decide a barge-in pause this utterance made, if one is still open. An utterance that is the bot's own
    // speech coming back (echo) is still billed and sent to webhooks (marked echo, for apps to drop), but no agent hears
    // it, and no reply waits on it.
    const verdict = this.held.get(origin.id)?.guard?.heard(cut.speaker, transcript.text, true, cut.startedAt);
    const echo = verdict === "echo";
    // Said over the bot only to show they listen ("mm-hm"): delivered as such, and no agent hears it as a turn.
    const backchannel = verdict === "backchannel";
    // Whether it is the bot's turn (addressing): decided before the event is written, which says so. Echo and
    // backchannels are no one's turn.
    const floor = this.held.get(origin.id)?.claim === origin.claim ? this.held.get(origin.id)!.floor : undefined;
    const addressed: Addressed = floor && transcript.text && !echo && !backchannel ? floor.decide(cut.speaker, transcript.text, this.humans(origin.id)) : { addressed: true, reason: "always" };
    if (turn) {
      turn.mark("transcript");
      Object.assign(turn.info, { live: this.liveModel(transcript), sttModel: transcript.model });
      if (!transcript.text) turn.end("empty");
    }
    const identity = { ...(options.subject !== undefined ? { subject: options.subject } : {}), context: { ...options.context, voiceSession: origin.id } };
    this.options.record(origin.tenant, { ...usage, identity, ...(options.keyScope ? { keyScope: options.keyScope } : {}) });
    const usd = usage.usage.cost.total as number;
    const row = await transaction(this.db, async sql => {
      const { rows } = await sql.query(`
        update voice_sessions set utterances = utterances + 1, speech_seconds = speech_seconds + $2, cost = cost + $3,
          last_speech_at = greatest(coalesce(last_speech_at, 0), $4), updated_at = $5
        where id = $1 returning *`, [origin.id, transcript.seconds, Math.round(usd * 1_000_000), cut.endedAt, Date.now()]);
      const current = rows[0] as Row | undefined;
      if (current && transcript.text && current.options.deliver.webhooks) {
        await enqueueEvents(sql, [this.event(current, "voice.utterance", {
          speakerId: cut.speaker, seq: current.utterances, text: transcript.text, language: transcript.language ?? options.language ?? null,
          seconds: cut.seconds, startedAt: cut.startedAt, endedAt: cut.endedAt, ended: cut.ended, costUsd: usd, ...(echo ? { echo: true } : {}), ...(backchannel ? { backchannel: true } : {}),
          addressed: addressed.addressed, addressedBy: addressed.reason,
        }, `voice:${origin.id}:utterance:${current.utterances}`)]);
      }
      return current;
    });
    // The webhook goes now, not at the outbox's next scan: an app answering aloud waits on it.
    if (row && transcript.text && row.options.deliver.webhooks) this.options.kickWebhooks?.();
    if (turn && row) turn.info.seq = row.utterances;
    // A browser call's page sees each utterance as it is transcribed (it needs no webhook).
    if (row && transcript.text) this.held.get(origin.id)?.media?.notify?.({
      type: "utterance", speakerId: cut.speaker, seq: row.utterances, text: transcript.text, startedAt: cut.startedAt, endedAt: cut.endedAt, ended: cut.ended, ...(echo ? { echo: true } : {}), ...(backchannel ? { backchannel: true } : {}),
      ...(turn ? { turnCommitMs: turn.stages().turnCommit } : {}), transcriptMs: Math.max(0, Math.round(clock().now() - cut.endedAt)),
    });
    console.log(JSON.stringify({ type: "voice_utterance", session: origin.id, seq: row?.utterances, seconds: cut.seconds, billedSeconds: transcript.seconds, ended: cut.ended, empty: !transcript.text, ...(echo ? { echo: true } : {}), ...(backchannel ? { backchannel: true } : {}), ms: Date.now() - started, live: this.liveModel(transcript), speechEndToTextMs: clock().now() - cut.endedAt }));
    if (!row) return;
    const local = this.held.get(origin.id);
    if (local) local.row = { ...local.row, last_speech_at: row.last_speech_at, utterances: row.utterances };
    const agent = row.options.deliver.agent;
    if (!transcript.text || echo || backchannel) return;
    // Not the bot's turn: kept as context for the next one that is, and no reply is waited for.
    if (agent && !addressed.addressed) { floor?.overheard(cut.speaker, transcript.text); turn?.end("no_reply"); return; }
    const context = row.options.addressing?.mode === "addressed" ? floor?.takeContext() ?? [] : [];
    // A reply the session does not speak itself is the app's (POST …/speak) or a prompt's (speak): the turn waits for it.
    if (turn && !(agent && row.options.agentReplies && this.options.submitStreaming) && this.held.get(origin.id)?.claim === origin.claim) this.waitingTurns.wait(origin.id, turn);
    if (!agent) return;
    const request = {
      id: `voice_${origin.id.slice(3)}_${row.utterances}`, method: "prompt",
      params: {
        text: withContext(transcript.text, context), from: { id: cut.speaker },
        metadata: { voiceSession: origin.id, utterance: String(row.utterances), ...(addressed.reason !== "always" ? { addressedBy: addressed.reason } : {}) }, allowDisconnected: true,
      },
    };
    // The agent's reply is spoken as it is written: delivered and spoken apart from this speaker's next utterance.
    if (row.options.agentReplies && this.options.submitStreaming) {
      const job = this.speakReply(origin, agent, request, row.utterances, turn?.via("agent_reply")).catch(error => console.error(JSON.stringify({ type: "voice_reply_failed", session: origin.id, error: safeError(error) })));
      this.pending.add(job);
      void job.finally(() => this.pending.delete(job));
      return;
    }
    if (await this.deliver(origin, agent, request, row.utterances)) turn?.mark("delivered");
  }

  /** An utterance's live transcript and its usage, or undefined when its stream failed (it is then transcribed after). */
  private async liveTranscript(origin: Origin, cut: Cut, committed: Committed): Promise<Transcribed | undefined> {
    try {
      const transcript = await committed.transcript;
      return { transcript, usage: this.options.transcriber.liveUsage(transcript, await committed.platform) };
    } catch (error) {
      console.error(JSON.stringify({ type: "voice_live_transcription_failed", session: origin.id, seconds: cut.seconds, error: safeError(error) }));
      return undefined;
    }
  }

  /** Whether a transcript came from a live stream (which names the provider that served it). */
  private liveModel(transcript: Transcript) { return (transcript as LiveTranscript).provider !== undefined; }

  /** An utterance's prompt to the agent, tried a few times (its node moving, a queue full). */
  private async deliver(origin: Origin, agent: string, request: { id: string; method: string; params: Record<string, unknown> }, seq: number) {
    for (let attempt = 1; ; attempt++) {
      try { await this.options.submit(agent, origin.tenant, request); return true; }
      catch (error) {
        const status = (error as HttpError).status;
        // A deleted agent takes nothing more; anything else (its node moving, a queue full) may take it soon.
        if (status === 404 || status === 410 || attempt >= VOICE_LIMITS.submitAttempts) {
          console.error(JSON.stringify({ type: "voice_delivery_failed", session: origin.id, seq, status, error: safeError(error) }));
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }

  /**
   * Submit an utterance's prompt and speak the agent's reply as it is written (agentReplies): each sentence queued as
   * it is whole, markdown and code left out, at most REPLY_LIMITS.chars in all (the whole reply is the run's, as ever).
   * Speaking stops adding to the queue once the queue is stopped (barge-in, interrupt, DELETE) or the session moves.
   * If the reply cannot be streamed (the agent's node is moving), the prompt is delivered as usual, and not spoken.
   */
  private async speakReply(origin: Origin, agent: string, request: { id: string; method: string; params: Record<string, unknown> }, seq: number, turn?: TurnClock) {
    const held = this.held.get(origin.id);
    const speech = held?.claim === origin.claim ? held.speech : undefined;
    if (!held || !speech) { turn?.end("error"); await this.deliver(origin, agent, request, seq); return; }
    // One reply at a time: a reply to an earlier turn that is not yet heard is not said (this turn's reply follows it,
    // and the agent has both turns). One being heard goes on (barge-in decides about talking over it).
    const before = held.reply;
    if (before && !before.heard) {
      before.abort.abort();
      speech.cancel(item => item.reply?.requestId === before.requestId, "superseded");
      console.log(JSON.stringify({ type: "voice_reply_superseded", session: origin.id, by: request.id }));
    }
    const reply = { requestId: request.id, speaker: String((request.params.from as { id?: string } | undefined)?.id ?? ""), abort: new AbortController(), heard: false };
    held.reply = reply;
    let streamed = false;
    try {
      await this.sayAsWritten(held, speech, { agent, requestId: request.id }, {}, signal => this.options.submitStreaming!(agent, origin.tenant, request, signal), () => { streamed = true; }, turn, reply.abort.signal);
      // Answered: the conversation with its speaker goes on from now.
      if (!reply.abort.signal.aborted && reply.speaker) held.floor.answered(reply.speaker);
    } catch (error) {
      console.error(JSON.stringify({ type: "voice_reply_stream_failed", session: origin.id, status: (error as HttpError).status, error: safeError(error) }));
      turn?.end("error");
      // The prompt may not have reached the agent: deliver it as usual (the same id, so at most once).
      if (!streamed) await this.deliver(origin, agent, request, seq);
    }
  }

  /**
   * Say a run's text as it is written: each sentence queued as it is whole, markdown and code left out, at most
   * REPLY_LIMITS.chars in all. It stops adding to the queue once the queue is stopped (barge-in, interrupt, DELETE) or
   * the session moves. With `interrupt`, its first sentence stops what was being said. Throws what the stream throws.
   */
  private async sayAsWritten(held: Held, speech: SessionSpeech, reply: { agent: string; requestId: string }, how: { voice?: string; interrupt?: boolean },
    texts: (signal: AbortSignal) => AsyncIterable<string>, heard?: () => void, turn?: TurnClock, cancelled?: AbortSignal) {
    let generation = speech.generation, interrupt = how.interrupt === true, failed = false;
    const abort = new AbortController();
    cancelled?.addEventListener("abort", () => abort.abort(), { once: true });
    const spoken = new SpokenReply(text => {
      if (speech.generation !== generation || this.held.get(held.id) !== held) { abort.abort(); return; }
      // Every piece carries the turn: the first that plays (or the first that cannot) ends it.
      turn?.mark("firstPiece");
      speech.say({ id: speechId(), text, voice: how.voice ?? held.row.options.voice, queuedAt: Date.now(), reply, ...(turn ? { turn } : {}) }, interrupt);
      // Its own interruption bumped the generation: the sentences after it follow it.
      if (interrupt) { interrupt = false; generation = speech.generation; }
    });
    try {
      for await (const text of texts(abort.signal)) {
        heard?.();
        if (text) turn?.mark("llmFirstToken");
        spoken.push(text);
        if (abort.signal.aborted) break;
      }
      if (!abort.signal.aborted) spoken.end();
    } catch (error) {
      if (!abort.signal.aborted) { failed = true; throw error; }
    } finally {
      // Nothing was said: the reply failed, had nothing to speak, or what it was part of was stopped first.
      if (turn && turn.marks.firstPiece === undefined) turn.end(failed ? "error" : abort.signal.aborted ? "interrupted" : "no_reply");
    }
  }

  /** People in a session's call now (not the bot, not ignored users), when its media knows. */
  private humans(id: string) {
    const held = this.held.get(id);
    return held?.media?.others()?.filter(user => user !== held.credentials.userId && !held.row.options.ignoreUserIds.includes(user)).length;
  }

  /** End a session from an utterance's work: under the claim if this node still holds it as it did, else as anyone. */
  private async endFor(origin: Origin, ending: Ending) {
    const held = this.held.get(origin.id);
    await this.finish(held && held.claim === origin.claim ? held : undefined, origin.id, ending);
  }


  /** End sessions past their limits: their length, no speech for a while, no one else in the call, lost credentials. */
  private async limits(held: Held, now: number) {
    const { options } = held.row;
    const started = num(held.row.started_at) ?? num(held.row.created_at)!;
    const others = held.media?.others()?.filter(user => user !== held.credentials.userId && !options.ignoreUserIds.includes(user));
    if (others === undefined || others.length) held.emptySince = undefined;
    else held.emptySince ??= now;
    const ending: Ending | undefined =
      now - started >= options.maxMinutes * 60_000 ? { reason: "max_duration" }
        : now - (num(held.row.last_speech_at) ?? started) >= options.idleMinutes * 60_000 ? { reason: "idle" }
          : held.emptySince !== undefined && now - held.emptySince >= options.emptySeconds * 1000 ? { reason: "empty" }
            : held.lost && now - held.lost.at >= (this.options.reconnectGraceMs ?? VOICE_LIMITS.reconnectGraceMs)
              ? { reason: held.lost.reason, ...(held.lost.detail ? { detail: held.lost.detail } : {}) } : undefined;
    if (ending) await this.finish(held, held.id, ending);
  }

  /**
   * End a session: written once (the row ended, its grant dropped, `voice.session.ended` in the outbox), by its owner
   * under its claim (`held`) or by anyone (a DELETE). The owner's connection closes as it learns of it.
   */
  protected async finish(held: Held | undefined, id: string, ending: Ending): Promise<Row | undefined> {
    if (held) {
      if (held.ending) return undefined;
      held.ending = true;
    }
    const now = Date.now();
    const write = async (sql: Sql) => {
      const { ending: _previous, ...options } = (await sql.query("select options from voice_sessions where id = $1 for update", [id])).rows[0]?.options ?? {};
      const { rows } = await sql.query(`
        update voice_sessions set state = 'ended', end_reason = $2, ended_at = $3, updated_at = $3, sealed = null, revision = revision + 1, options = $4
        where id = $1 and state <> 'ended' returning *`, [id, ending.reason, now, JSON.stringify({ ...options, ...(ending.limit || ending.endUserReason ? { ending } : {}) })]);
      const row = rows[0] as Row | undefined;
      if (row?.options.deliver.webhooks) await enqueueEvents(sql, [this.event(row, "voice.session.ended", {
        reason: ending.reason, ...(ending.limit ? { limit: ending.limit } : {}), ...(ending.endUserReason ? { endUserReason: ending.endUserReason } : {}), ...(ending.bucket ? { bucket: ending.bucket } : {}),
        startedAt: num(row.started_at), endedAt: now, utterances: row.utterances, speechSeconds: row.speech_seconds, costUsd: Number(row.cost) / 1_000_000,
      }, `voice:${id}:ended`)]);
      return row;
    };
    let row: Row | undefined;
    try { row = held ? await underClaim(this.db, held.claim, write) : await transaction(this.db, write); }
    catch (error) { if (held) held.ending = false; throw error; }
    if (row) console.log(JSON.stringify({ type: "voice_session_ended", session: id, tenant: row.tenant, reason: ending.reason, ...(ending.limit ? { limit: ending.limit } : {}), ...(ending.detail ? { detail: ending.detail } : {}), node: this.options.node }));
    const local = held ?? this.held.get(id);
    if (local) void this.drop(local, true, "end");
    else await this.notify([id]).catch(() => {});
    return row;
  }

  /**
   * A session's realtime brain (src/voice/realtime/brain.ts), on the tenant's key for its provider (else the
   * platform's): what it needs of the session. Its responses are billed as speech (usage.recorded kind speech, the
   * model's tokens at its list price), its inputs' transcripts as transcriptions; voice.utterance and voice.speech.* go
   * out as for the cascade, with `brain: "realtime"`. ask_agent prompts deliver.agent, whose run is billed as any run.
   */
  private async brainOf(held: Held): Promise<RealtimeBrain> {
    const options = () => held.row.options;
    const realtime = options().realtime!;
    const provider = this.options.realtime?.providers[realtime.provider];
    if (!provider) throw new Error(`Realtime provider ${realtime.provider} is not enabled on this runtime`);
    if (!REALTIME_PRICES[`${provider.id}/${realtime.model}`]) throw new Error(`Realtime model ${provider.id}/${realtime.model} has no price configured`);
    const credentials = await this.options.realtime!.key(held.tenant, options().keyScope, provider.key);
    if (!credentials) throw new Error(`No ${provider.key} key for a realtime brain`);
    const agent = options().deliver.agent;
    const submit = agent && this.options.submitStreaming ? this.options.submitStreaming : undefined;
    const identity = () => ({ ...(options().subject !== undefined ? { subject: options().subject } : {}), context: { ...options().context, voiceSession: held.id } });
    const config = {
      model: realtime.model, voice: realtime.voice, transcribe: realtime.transcribe,
      instructions: realtimeInstructions(realtime.instructions, { agent: !!submit, group: held.row.provider !== "browser" }),
      tools: [...submit ? [ASK_AGENT] : [], STAY_SILENT],
      ...(options().language ? { language: options().language } : {}), ...(options().prompt ? { prompt: options().prompt } : {}),
    };
    const unnamed = new Map<string, string>();
    let asks = 0;
    const log = (type: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ type, session: held.id, node: this.options.node, ...fields }));
    const counted = (row: Row) => { held.row = { ...held.row, utterances: row.utterances, last_speech_at: row.last_speech_at, speeches: row.speeches, spoken_seconds: row.spoken_seconds, cost: row.cost, speech_seconds: row.speech_seconds }; };
    /** A change to the session's counts, and the event it makes (if any), in one transaction. */
    const write = (query: string, values: unknown[], event?: { type: "voice.utterance" | "voice.speech.started" | "voice.speech.ended"; key: string; data(row: Row): Record<string, unknown> }) =>
      transaction(this.db, async sql => {
        const row = (await sql.query(query, [held.id, ...values])).rows[0] as Row | undefined;
        if (!row) return undefined;
        counted(row);
        if (event && row.options.deliver.webhooks) await enqueueEvents(sql, [this.event(row, event.type, { ...event.data(row), brain: "realtime" }, event.key)]);
        return row;
      }).then(row => { if (row?.options.deliver.webhooks && event?.type === "voice.utterance") this.options.kickWebhooks?.(); },
        error => console.error(JSON.stringify({ type: "voice_realtime_write_failed", session: held.id, ...(event ? { event: event.type } : {}), error: safeError(error) })));
    const hooks: BrainHooks = {
      connect: events => provider.connect(config, credentials, events),
      player: () => held.media?.speaks ? held.media : undefined,
      resumeMedia: () => held.media?.resume(),
      humans: () => this.humans(held.id),
      name: speaker => {
        const given = options().speakers?.[speaker];
        if (given) return given;
        if (!unnamed.has(speaker)) unnamed.set(speaker, `Speaker ${unnamed.size + 1}`);
        return unnamed.get(speaker)!;
      },
      ...(submit ? {
        askAgent: async (request: string, speaker: string | undefined, signal: AbortSignal) => {
          const id = `voice_${held.id.slice(3)}_ask_${Date.now().toString(36)}${++asks}`;
          const name = speaker ? options().speakers?.[speaker] : undefined;
          let text = "";
          for await (const piece of submit(agent!, held.tenant, {
            id, method: "prompt",
            params: {
              text: `[A request from your voice in a live voice call${name ? `, asked by ${name}` : ""}. Do what it needs with your tools first; then answer in one to three plain spoken sentences (no markdown, lists, links or emoji), since your reply is read aloud]\n${request}`,
              ...(speaker ? { from: { id: speaker, ...(name ? { name } : {}) } } : {}), metadata: { voiceSession: held.id, via: "realtime" }, allowDisconnected: true,
            },
          }, signal)) text += piece;
          return text;
        },
      } : {}),
      admit: () => this.options.admit(held.tenant),
      hold: async usd => {
        const { subject, bucket } = options();
        return subject !== undefined && this.options.credit ? this.options.credit.hold(held.tenant, subject, bucket ?? DEFAULT_BUCKET, usd, "voice_realtime", { session: held.id }) : undefined;
      },
      budget: (limit, endUserReason, bucket) => {
        void this.finish(this.held.get(held.id) === held ? held : undefined, held.id, { reason: "budget", limit, ...(endUserReason ? { endUserReason } : {}), ...(bucket ? { bucket } : {}) })
          .catch(error => console.error(JSON.stringify({ type: "voice_finish_failed", session: held.id, error: safeError(error) })));
      },
      usage: ({ usage, costUsd, audioSeconds }) => {
        const { keyScope } = options();
        this.options.record(held.tenant, {
          provider: provider.id, model: realtime.model, kind: "speech", platform: credentials.platform, speeches: 1, audioSeconds, timestamp: Date.now(),
          usage: { input: usage.inputText + usage.inputAudio, output: usage.outputText + usage.outputAudio, cacheRead: usage.cachedText + usage.cachedAudio, cost: { total: costUsd } },
          identity: identity(), ...(keyScope ? { keyScope } : {}),
        });
        void write("update voice_sessions set cost = cost + $2, updated_at = $3 where id = $1 returning *", [Math.round(costUsd * 1_000_000), Date.now()]);
      },
      // A turn keeps the session from idling, and counts as an utterance when nothing transcribes it.
      turn: ({ endedAt }) => {
        void write(`update voice_sessions set last_speech_at = greatest(coalesce(last_speech_at, 0), $2)${realtime.transcribe ? "" : ", utterances = utterances + 1"}, updated_at = $3 where id = $1 returning *`, [endedAt, Date.now()]);
      },
      heard: heard => {
        const { keyScope } = options();
        if (heard.seconds > 0) this.options.record(held.tenant, {
          provider: provider.id, model: REALTIME_TRANSCRIPTION.model, kind: "transcription", platform: credentials.platform, transcriptions: 1, audioSeconds: Math.ceil(heard.seconds),
          usage: { cost: { total: heard.costUsd } }, timestamp: Date.now(), identity: identity(), ...(keyScope ? { keyScope } : {}),
        });
        if (!heard.text) return;
        held.media?.notify?.({ type: "utterance", speakerId: heard.speaker, text: heard.text, startedAt: heard.startedAt, endedAt: heard.endedAt, brain: "realtime" });
        void write("update voice_sessions set utterances = utterances + 1, speech_seconds = speech_seconds + $2, cost = cost + $3, updated_at = $4 where id = $1 returning *",
          [Math.ceil(heard.seconds), Math.round(heard.costUsd * 1_000_000), Date.now()], {
            type: "voice.utterance", key: `voice:${held.id}:utterance:rt:${heard.startedAt}:${heard.speaker}`,
            data: row => ({
              speakerId: heard.speaker, ...(heard.speakers.length > 1 ? { speakers: heard.speakers } : {}), seq: row.utterances, text: heard.text, language: options().language ?? null,
              seconds: Math.round((heard.endedAt - heard.startedAt) / 10) / 100, startedAt: heard.startedAt, endedAt: heard.endedAt, ended: "silence", costUsd: heard.costUsd,
              ...(heard.addressed ? { addressed: heard.addressed.addressed, addressedBy: heard.addressed.reason } : {}),
            }),
          });
      },
      spoke: spoke => {
        if (spoke.type === "started") {
          const startedAt = Date.now();
          const answers = spoke.turn ? { turn: { path: "realtime", stagesMs: spoke.turn.stages() } } : {};
          held.media?.notify?.({ type: "speech", state: "started", speechId: spoke.id, latencyMs: spoke.latencyMs, startedAt, ...answers });
          void write("select * from voice_sessions where id = $1", [], { type: "voice.speech.started", key: `voice:${held.id}:voice.speech.started:${spoke.id}`, data: () => ({ speechId: spoke.id, latencyMs: spoke.latencyMs, startedAt, ...answers }) });
          return;
        }
        held.media?.notify?.({ type: "speech", state: "ended", speechId: spoke.id, reason: spoke.reason, ...(spoke.by ? { by: spoke.by } : {}), seconds: spoke.seconds });
        // Its cost is the session's already (usage): the speech is counted here.
        void write("update voice_sessions set speeches = speeches + 1, spoken_seconds = spoken_seconds + $2, updated_at = $3 where id = $1 returning *", [spoke.seconds, Date.now()], {
          type: "voice.speech.ended", key: `voice:${held.id}:voice.speech.ended:${spoke.id}`,
          data: () => ({ speechId: spoke.id, reason: spoke.reason, ...(spoke.by ? { by: spoke.by } : {}), seconds: spoke.seconds, costUsd: spoke.costUsd }),
        });
      },
      failed: detail => {
        void this.finish(this.held.get(held.id) === held ? held : undefined, held.id, { reason: "error", detail })
          .catch(error => console.error(JSON.stringify({ type: "voice_finish_failed", session: held.id, error: safeError(error) })));
      },
      log,
    };
    const policy = interruption(options());
    return new RealtimeBrain({
      session: held.id, tenant: held.tenant, reference: `${provider.id}/${realtime.model}`, floor: held.floor, transcribed: realtime.transcribe,
      ...(provider.wordsAfterAnswer ? { wordsAfterAnswer: true } : {}),
      speculative: realtime.speculative && options().endOfTurn?.mode === "smart" && !!this.options.turnModels,
      ...(options().bargeIn !== false ? { bargeIn: policy } : {}),
    }, hooks);
  }

  /** An event about a session, for the tenant's webhook endpoints. */
  /** What a held session's speech needs: its connection, money checks, events and usage (voice-speech.ts). */
  private speechEffects(held: Held) {
    const synthesizer = this.options.synthesizer!;
    const options = () => held.row.options;
    // Who made a speech's audio, for its log lines: the chain's member that served, else (once its key was had) the
    // built-in provider; nothing when no provider began.
    const madeBy = (platform: boolean | undefined, served?: Served) => served ? { provider: served.provider, model: served.model }
      : platform !== undefined ? { provider: synthesizer.provider, model: synthesizer.model } : {};
    const write = (type: "voice.speech.started" | "voice.speech.ended", item: SpeechItem, data: Record<string, unknown>, counts?: { seconds: number; costUsd: number }) =>
      transaction(this.db, async sql => {
        const { rows } = counts
          ? await sql.query("update voice_sessions set speeches = speeches + 1, spoken_seconds = spoken_seconds + $2, cost = cost + $3, updated_at = $4 where id = $1 returning *", [held.id, counts.seconds, Math.round(counts.costUsd * 1_000_000), Date.now()])
          : await sql.query("select * from voice_sessions where id = $1", [held.id]);
        const row = rows[0] as Row | undefined;
        if (row?.options.deliver.webhooks) await enqueueEvents(sql, [this.event(row, type, { speechId: item.id, ...(item.reply ? { reply: item.reply } : {}), ...data }, `voice:${held.id}:${type}:${item.id}`)]);
      }).catch(error => console.error(JSON.stringify({ type: "voice_speech_event_failed", session: held.id, speech: item.id, error: safeError(error) })));
    return {
      player: (): Player | undefined => held.media?.speaks ? held.media : undefined,
      admit: () => this.options.admit(held.tenant),
      hold: async (usd: number, speech: string) => {
        const { subject, bucket } = options();
        return subject !== undefined && this.options.credit ? this.options.credit.hold(held.tenant, subject, bucket ?? DEFAULT_BUCKET, usd, "voice_speech", { session: held.id, speech }) : undefined;
      },
      fresh: async () => { await this.options.ownership?.whenFresh(); },
      credentials: () => synthesizer.credentials(held.tenant, options().keyScope),
      // Through a chain of providers when the session names one (speech.providers) or the runtime does (AGENT_VOICE_TTS);
      // otherwise OpenAI on the session's key, exactly as before chains existed.
      ...(synthesizer.options.chain && (options().speech?.providers?.length || synthesizer.options.chain.order.length) ? {
        speak: (input: SpeechInput, signal: AbortSignal, served: (who: Served) => void) => synthesizer.speak(
          { tenant: held.tenant, ...(options().keyScope ? { keyScope: options().keyScope } : {}) }, options().speech ?? {},
          { ...input, ...(options().language ? { language: options().language } : {}) }, signal, served),
        estimate: (text: string) => synthesizer.estimate(text, options().speech?.providers),
        cost: (who: Served, made: { characters: number; seconds: number }) => synthesizer.costOf(`${who.provider}/${who.model}`, made),
      } : {}),
      started: (item: SpeechItem, latencyMs: number, turn?: TurnClock, platform?: boolean, served?: Served) => {
        if (item.reply && held.reply?.requestId === item.reply.requestId) held.reply.heard = true;
        const startedAt = Date.now();
        // The turn this speech answers, when it is that turn's first audio: its stages (ms since the end of speech).
        const answers = turn ? { turn: { ...(turn.info.seq !== undefined ? { seq: turn.info.seq } : {}), path: turn.path ?? null, stagesMs: turn.stages() } } : {};
        console.log(JSON.stringify({ type: "voice_speech_started", session: held.id, speech: item.id, latencyMs, ...madeBy(platform, served) }));
        held.media?.notify?.({ type: "speech", state: "started", speechId: item.id, latencyMs, startedAt, ...(item.reply ? { reply: item.reply } : {}), ...answers });
        void write("voice.speech.started", item, { latencyMs, startedAt, ...answers });
      },
      ended: (item: SpeechItem, ending: SpeechEnding, platform: boolean | undefined, served?: Served) => {
        const { subject, context, keyScope } = options();
        held.media?.notify?.({ type: "speech", state: "ended", speechId: item.id, reason: ending.reason, ...(ending.by ? { by: ending.by } : {}), seconds: ending.seconds });
        console.log(JSON.stringify({ type: "voice_speech_ended", session: held.id, speech: item.id, reason: ending.reason, ...(ending.by ? { by: ending.by } : {}), seconds: ending.seconds, ...madeBy(platform, served), ...(ending.error ? { error: ending.error } : {}) }));
        if (ending.seconds > 0) {
          this.options.record(held.tenant, {
            provider: served?.provider ?? synthesizer.provider, model: served?.model ?? synthesizer.model, usage: { cost: { total: ending.costUsd } }, platform: !!platform, kind: "speech",
            speeches: 1, audioSeconds: ending.seconds, timestamp: Date.now(),
            identity: { ...(subject !== undefined ? { subject } : {}), context: { ...context, voiceSession: held.id } }, ...(keyScope ? { keyScope } : {}),
          });
        }
        void write("voice.speech.ended", item, {
          reason: ending.reason, ...(ending.by ? { by: ending.by } : {}), seconds: ending.seconds, costUsd: ending.costUsd,
        }, ending.seconds > 0 ? ending : undefined);
      },
      budget: (limit: "tenant" | "end_user", endUserReason?: string, bucket?: string) => {
        void this.finish(this.held.get(held.id) === held ? held : undefined, held.id, { reason: "budget", limit, ...(endUserReason ? { endUserReason } : {}), ...(bucket ? { bucket } : {}) })
          .catch(error => console.error(JSON.stringify({ type: "voice_finish_failed", session: held.id, error: safeError(error) })));
      },
    };
  }

  protected event(row: Row, type: "voice.session.started" | "voice.session.ended" | "voice.session.error" | "voice.utterance" | "voice.speech.started" | "voice.speech.ended", data: Record<string, unknown>, key: string): WebhookEvent {
    const { options } = row;
    return webhookEvent(type, row.tenant, {
      session: row.id, provider: row.provider, guildId: row.guild, channelId: row.channel, botUserId: row.bot_user,
      ...data, subject: options.subject ?? null, metadata: options.metadata,
    }, key);
  }

  /** Ended sessions past their retention, deleted at most once an hour. */
  private async prune(now: number) {
    if (now - this.prunedAt < PRUNE_EVERY_MS) return;
    this.prunedAt = now;
    await this.db.query("delete from voice_sessions where state = 'ended' and ended_at < $1", [now - VOICE_LIMITS.retentionDays * 86_400_000]);
  }
}

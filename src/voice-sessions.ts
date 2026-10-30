import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BROWSER_BOT } from "./voice-browser.ts";
import type { Accounts, Sealed } from "./accounts.ts";
import { transaction, type Db, type Sql } from "./db.ts";
import { HttpError } from "./http.ts";
import { clock } from "./node-context.ts";
import { identityInput } from "./identity.ts";
import { metricLine, safeError, writeMetricLine } from "./metrics.ts";
import { underClaim, type Claim, type Ownership } from "./ownership.ts";
import { checkedAudio, languageInput, type Transcribed, type Transcriber } from "./transcription.ts";
import { enqueueEvents, webhookEvent, type WebhookEvent } from "./webhooks.ts";
import type { UsageRecord } from "./client-sessions/state.ts";
import { oggOpus, type Cut } from "./voice-audio.ts";
import { inlineMedia, type Media, type MediaFactory, type MediaOptions } from "./voice/media.ts";
import { DEFAULT_VOICE } from "./speech.ts";
import { bucketInput, DEFAULT_BUCKET } from "./end-user-credits.ts";
import { DEFAULT_ADDRESSING, Floor, type AddressingPolicy } from "./voice/turns/floor.ts";
import { BARGE_IN_LIMITS, DEFAULT_BARGE_IN, type BargeInPolicy } from "./voice/echo-guard.ts";
import type { TurnModels } from "./voice/turns/inference.ts";
import { assemble, Recorder, RECORDING_LIMITS, type RecordedPacket, type RecordingFile, type RecordingTracks } from "./voice/recorder.ts";
import type { Storage } from "../shared/storage.ts";
import { RealtimeBrain, ASK_AGENT, STAY_SILENT, REALTIME_LIMITS, realtimeInstructions, type BrainHooks } from "./voice/realtime/brain.ts";
import { Jukebox, AUDIO_LIMITS, type AudioSource } from "./voice/jukebox.ts";
import { speechRequest, type SpeechService } from "./speech-api.ts";
import type { Outbound } from "./outbound.ts";
import { FILE_LIMITS } from "./limits.ts";
import { realtimePrice, REALTIME_PROVIDERS, REALTIME_TRANSCRIPTION, realtimeVoice, type RealtimeCredentials, type RealtimeProvider, type RealtimeProviderId } from "./voice/realtime/provider.ts";

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
 * stored only while the tenant records the call (a recording, below), and only until the recording's files expire.
 *
 * The owner's media cuts each speaker's audio into turns (src/voice/turns). A session's `brain` decides what comes of
 * them: `realtime` (the default), a speech-to-speech model (src/voice/realtime) that hears the call and answers aloud on
 * the tenant's key for its provider, asking deliver.agent (ask_agent) for anything beyond talk; or `listen`, muted, where
 * each utterance is transcribed after it is cut, as `POST /v1/transcriptions` would (the same provider, model and price),
 * and nothing answers. What people say goes out as `voice.utterance` events for the tenant's webhooks, what the bot says
 * as `voice.speech.*`; their usage is recorded as the session's subject's.
 *
 * A recording (POST …/recording) is the one way audio is kept: the owner's Recorder (src/voice/recorder.ts) takes every
 * packet its media hears and plays, writes it to object storage in chunks under its claim, and when the recording ends
 * (DELETE …/recording, its limits, the session's end) makes its files, kept `retentionHours`, and sends
 * `voice.recording.ended`. A session handed to another node goes on recording there into the same recording.
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
  /** A packet of the bot's own speech went out (as the listener gets it, in time): a recording keeps it. */
  played?(packet: Uint8Array): void;
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
  /** What it holds now, counted (streams, packets held, SSRCs tracked): a media worker's memory report names them. */
  sizes?(): Record<string, number>;
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
export type Ending = { reason: EndReason; limit?: "tenant" | "end_user"; endUserReason?: string; bucket?: string; detail?: string; error?: string };

/** A session's settings, as created (and some patched): stored as they are read back. */
export type VoiceOptions = {
  deliver: { agent?: string; webhooks: boolean };
  subject?: string; bucket?: string; context?: Record<string, unknown>; keyScope?: string;
  language?: string; prompt?: string;
  silenceMs: number; maxMinutes: number; idleMinutes: number; emptySeconds: number;
  ignoreUserIds: string[]; metadata: Record<string, unknown>;
  notice: string;
  /** A person talking over the bot stops its speech (after the echo guard: src/voice/echo-guard.ts); realtime only. */
  bargeIn?: boolean;
  /** With bargeIn: its timing, when the session set it (else DEFAULT_BARGE_IN). */
  interruption?: BargeInPolicy;
  /** The voice asked for (OpenAI's names: alloy, coral…), mapped to the realtime provider's (realtime.voice). */
  voice?: string;
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
   * What hears the call: a realtime brain (`realtime`, the default; its settings in `realtime`), or `listen`: muted,
   * each utterance transcribed and sent out, nothing answering. Sessions from before (a removed pipeline that spoke
   * replies through text to speech) have neither `listen` nor `realtime` settings: they end when taken.
   */
  brain?: "realtime" | "listen";
  /** With brain realtime: the speech-to-speech model's provider, model and voice, the bot's persona, and how it listens. */
  realtime?: RealtimeOptions;
  /** Speakers' names by user id, for the realtime brain's notes of who speaks (else "Speaker 1", "Speaker 2"…). */
  speakers?: Record<string, string>;
};
export type RealtimeOptions = {
  provider: RealtimeProviderId; model: string; voice: string; publicOwnerId?: string;
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
  perTenant: 50,
  /**
   * Sessions one node takes before leaving them to its peers (AGENT_VOICE_SESSIONS_PER_NODE), so a deploy's handoff
   * spreads them rather than the first new node taking every one. A session no peer took in `perNodeWaitMs` is taken
   * anyway: better a busy node than a call that never connects. Measured in production on 1 vCPU and 4 GiB: 60-150 MB
   * and 3-6% of a vCPU each. Each then has its own media worker (`MEDIA_HOST_DEFAULTS.maxWorkers`).
   */
  perNode: 15, perNodeWaitMs: 30_000,
  /** How long a connection that lost its credentials waits for new ones (PATCH) before the session ends. */
  reconnectGraceMs: 15_000,
  /** Utterances one node transcribes at once (listening sessions); one waiting longer than `queueMs` is dropped. */
  transcriptionsPerNode: 16,
  queueMs: 60_000,
  ignoreUserIds: 50,
  metadataBytes: 4_096,
  noticeChars: 500,
  promptChars: 1_000,
  /** A realtime brain's instructions (the bot's persona), and the speakers' names a session may give. */
  realtimeInstructionsChars: 8_000,
  speakers: 50, speakerNameChars: 40,
  /** Ended sessions are listed this long, then deleted. */
  retentionDays: 30,
});
/** A session whose media crashes this many times within `windowMs` ends (`error`, `media_crashed`). */
export const MEDIA_CRASHES = Object.freeze({ max: 3, windowMs: 5 * 60_000 });
const DEFAULT_NOTICE = "<@{bot}> is listening, transcribing speech and may speak in this channel. Audio is not stored.";
const LISTENING_NOTICE = "<@{bot}> is listening and transcribing speech in this channel. Audio is not stored.";
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
  /** Audio the bot played (POST …/audio): seconds heard, and tracks. */
  played_seconds?: string | number; tracks?: number;
  created_at: string | number; started_at: string | number | null; last_speech_at: string | number | null; ended_at: string | number | null; updated_at: string | number;
};
const num = (value: string | number | null) => value === null ? null : Number(value);

const RECORDING_ID = /^vr_[a-f0-9]{24}$/;
const RECORDING_NOTICE = "<@{bot}> is recording this voice channel: what is said here is saved as audio until the recording stops.";
/** Why a recording ended: asked (`stopped`), its limits, its session's end, or a failure to make its files. */
export type RecordingEnd = "stopped" | "max_duration" | "max_size" | "session_ended" | "error";
/** How long DELETE …/recording waits for the files before it answers the recording as it is (stopping). */
const RECORDING_STOP_WAIT_MS = 20_000;
/**
 * A recording still open when its session ended this long ago (its owner died before finishing it), or one left
 * finishing this long (its finisher died), is finished by any node's scan, from the chunks stored.
 */
const RECORDING_ORPHAN_MS = 60_000;
const RECORDING_STUCK_MS = 10 * 60_000;
const recordingPrefix = (tenant: string, id: string) => `recordings/${tenant}/${id}/`;

/** A row of voice_recordings. */
type RecordingRow = {
  id: string; tenant: string; session: string; state: "recording" | "stopping" | "finishing" | "ready" | "failed"; tracks: RecordingTracks;
  options: { maxMinutes: number; maxBytes: number; retentionHours: number; metadata?: Record<string, unknown> };
  chunks: string[]; bytes: string | number; started_at: string | number; ended_at: string | number | null; end_reason: string | null;
  seconds: string | number | null; files: RecordingFile[] | null; error: string | null; expires_at: string | number | null; updated_at: string | number;
};

/** A recording as the API shows it: `recording`, `stopping` (making its files), `ready` (its files) or `failed`. */
export function recordingView(row: RecordingRow) {
  return {
    id: row.id, session: row.session, state: row.state === "finishing" ? "stopping" as const : row.state, tracks: row.tracks,
    maxMinutes: row.options.maxMinutes, maxBytes: row.options.maxBytes, retentionHours: row.options.retentionHours, metadata: row.options.metadata ?? {},
    bytes: Number(row.bytes), startedAt: num(row.started_at)!, endedAt: num(row.ended_at), endReason: row.end_reason as RecordingEnd | null,
    seconds: row.seconds === null ? null : Number(row.seconds), files: row.files ?? [], ...(row.error ? { error: row.error } : {}), expiresAt: num(row.expires_at),
  };
}
export type RecordingView = ReturnType<typeof recordingView>;

/** A session as the API shows it: never its token or voice session id. */
export function sessionView(row: Row) {
  const { ending, ...options } = row.options;
  return {
    id: row.id, provider: row.provider,
    discord: { guildId: row.guild, channelId: row.channel, userId: row.bot_user },
    state: row.state, endReason: row.end_reason,
    ...(ending?.limit ? { limit: ending.limit } : {}), ...(ending?.endUserReason ? { endUserReason: ending.endUserReason } : {}),
    ...options,
    brain: options.brain === "listen" ? "listen" as const : "realtime" as const,
    ...(options.brain === "listen" ? {} : {
      bargeIn: options.bargeIn ?? true, voice: options.voice ?? DEFAULT_VOICE,
      ...(options.bargeIn ?? true ? { interruption: interruption(options) } : {}),
    }),
    endOfTurn: options.endOfTurn ?? { mode: "silence" as const, ...SMART_DEFAULTS },
    addressing: options.addressing ?? { ...DEFAULT_ADDRESSING },
    utterances: row.utterances, speechSeconds: row.speech_seconds, speeches: row.speeches ?? 0, spokenSeconds: Number(row.spoken_seconds ?? 0),
    tracks: row.tracks ?? 0, playedSeconds: Number(row.played_seconds ?? 0),
    costUsd: Number(row.cost) / 1_000_000,
    createdAt: num(row.created_at)!, startedAt: num(row.started_at), lastSpeechAt: num(row.last_speech_at), endedAt: num(row.ended_at),
  };
}
export type SessionView = ReturnType<typeof sessionView>;

/** A session's barge-in timing: what it set, else the defaults. */
export function interruption(options: Pick<VoiceOptions, "interruption">): BargeInPolicy {
  return { ...DEFAULT_BARGE_IN, ...options.interruption };
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
/** `bargeIn` as given: true, false, or {minMs, confirmMs, resumeMs} (barge-in on, with that timing). */
function bargeInInput(value: unknown): { on: boolean; policy?: BargeInPolicy } {
  if (value === undefined) return { on: true };
  if (typeof value === "boolean") return { on: value };
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "bargeIn must be true, false or {minMs, confirmMs, resumeMs}");
  only(value as Record<string, unknown>, "bargeIn", ["minMs", "confirmMs", "resumeMs"]);
  const given = value as Record<string, unknown>;
  const field = (name: "minMs" | "confirmMs" | "resumeMs") => integer(given[name], `bargeIn.${name}`, { default: DEFAULT_BARGE_IN[name], ...BARGE_IN_LIMITS[name] });
  return { on: true, policy: { minMs: field("minMs"), confirmMs: field("confirmMs"), resumeMs: field("resumeMs") } };
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
 * when the subject has nothing left in its bucket, and each response of the brain held before it is asked for and
 * settled with what it cost. Undefined answers: the tenant does not meter end users.
 */
export interface VoiceCredit {
  /** With `usd`, also refused when the subject cannot cover that much (a realtime brain's first response hold). */
  refusal(tenant: string, endUser: string, bucket: string): Promise<{ reason: string; message: string } | undefined>;
  /** Throws 402 END_USER_CREDIT (`details.reason`) when the subject has too little left to start work costing `usd`. */
  hold(tenant: string, endUser: string, bucket: string, usd: number, call: string, metadata?: Record<string, unknown>): Promise<{ settle(usd: number): Promise<void>; release(): Promise<void> } | undefined>;
}

export interface VoiceSessionsOptions {
  db: Db;
  /** Where recordings are kept (the node's object storage); without it, recording is refused. */
  storage?: Storage;
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
  /** Speech to text for listening sessions, as `POST /v1/transcriptions` makes it; without it, brain listen is refused. */
  transcriber?: Transcriber;
  /** Utterances one node transcribes at once (VOICE_LIMITS.transcriptionsPerNode). */
  transcriptionsPerNode?: number;
  /** Records the brain's usage (its speech, its inputs' transcription), as a model response's is (billing, usage.recorded). */
  record(tenant: string, usage: UsageRecord): void;
  /** Submit a prompt to an agent wherever it is served, yielding the text its run writes as it is written (ask_agent); without it, no ask_agent. */
  submitStreaming?(agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }, signal: AbortSignal): AsyncIterable<string>;
  /** How long ask_agent waits before asking again when the agent's host stopped under it (ASK_AGENT_RETRY_MS). */
  askAgentRetryMs?: number;
  /**
   * The node's turn-taking models (src/voice/turns: Silero VAD, Smart Turn), for sessions whose endOfTurn is smart (the
   * default when given); without them, sessions end turns on silence.
   */
  turnModels?: TurnModels;
  /** End users' credit; without it, sessions are billed to the tenant alone. */
  credit?: VoiceCredit;
  /**
   * Realtime brains: the providers this runtime offers (AGENT_VOICE_REALTIME, else OpenAI), and the
   * tenant's key for one (in a key scope), else the platform's (for OpenAI, with the platform's Azure deployment of `model`
   * to try first: azure-openai.ts); undefined when there is none.
   */
  realtime?: {
    providers: Partial<Record<RealtimeProviderId, RealtimeProvider>>;
    key(tenant: string, keyScope: string | undefined, provider: string, model?: string): Promise<RealtimeCredentials & { platform: boolean } | undefined>;
  };
  /** Live sessions per tenant (VOICE_LIMITS.perTenant). */
  perTenant?: (tenant: string) => number;
  perNode?: number;
  perNodeWaitMs?: number;
  /** Whether this node is short of memory (AGENT_MEMORY_HIGH_BYTES): it takes no sessions until it is not. */
  memoryHigh?: () => boolean;
  reconnectGraceMs?: number;
  /** What a voice server's host must match: Discord's (*.discord.media) unless a test serves its own. */
  endpoints?: RegExp;
  /** Send the webhook outbox now (Webhooks.kick): a voice event is waited on, by a bot that answers aloud. */
  kickWebhooks?(): void;
  /**
   * Text to speech, as POST /v1/speech makes it, for what the bot's code has it say (POST …/say) in the call's voice
   * (OpenAI's for an OpenAI brain, ElevenLabs' for an ElevenLabs one); without it, or for another brain, the model
   * reads the words out.
   */
  speech?: SpeechService;
  /** How audio URLs are read (POST …/audio): the outbound guard without the operator's allowed origins. Without it, only uploads play. */
  audioOutbound?: Outbound;
  /** Browser sessions' sockets: the secret their tokens are signed with, and where pages reach them. */
  browser?: { secret: string; url(session: string): string };
  /**
   * Where each session's media runs (src/voice/media.ts): given a provider's transport, its factory. By default on this
   * thread (`inlineMedia`).
   */
  media?(transport: VoiceTransport, provider: typeof VOICE_PROVIDERS[number]): MediaFactory;
}

/**
 * How long ask_agent waits before asking a second time when the agent's host stopped under its request: long enough
 * for the node giving it up to release it (stop, interrupt, unload), so the next ask finds its new owner.
 */
export const ASK_AGENT_RETRY_MS = 1_000;

/**
 * Whether ask_agent's request failed because the agent left the node serving it: its host stopped ("Agent stopped",
 * here or relayed by its owner as a 502) as the node retired or handed it off, or the owner asked no longer has it.
 */
export function agentMoved(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  const status = (error as { status?: unknown } | undefined)?.status;
  return message === "Agent stopped" && (status === undefined || status === 502) || status === 404 && message === "Unknown agent";
}

/** What an utterance's work needs of its session, fixed when it was cut: the session may move or end meanwhile. */
type Origin = { id: string; tenant: string; claim: Claim; row: Row };
/** A session this node holds: its claim, its media (its connection, its speakers' audio), and what its limits are measured from. */
type Held = {
  id: string; tenant: string; claim: Claim; revision: number; row: Row;
  credentials: VoiceCredentials; media?: Media;
  /** Since when the call has had no one else in it. */
  emptySince?: number;
  /** The connection lost its credentials (`lost`): when, and why, until new ones come. */
  lost?: { at: number; reason: "kicked" | "credentials" | "error"; detail?: string };
  ending?: boolean;
  /** When its media crashed lately (MEDIA_CRASHES): too many end the session. */
  crashes?: number[];
  /** When each speaker's current utterance began (speechStart), on this node's clock. */
  speechStarts?: Map<string, number>;
  /** Which turns are the bot's, and what was said around them (addressing). */
  floor: Floor;
  /** Smart turns' events counted (voice_turn_stats when the session is let go). */
  turnStats?: { likelyEnds: number; resumes: number; turns: number };
  /** The realtime brain that hears the call and answers; none for a listening session. */
  brain?: RealtimeBrain;
  /** The recording this node is making of the call, if any: its id and recorder. */
  recording?: { id: string; recorder: Recorder };
  /** Work on its recording (start, chunks, end), one at a time. */
  recordingWork?: Promise<void>;
  /** Audio the bot plays into the call (POST …/audio), once it has played any. */
  jukebox?: Jukebox;
};
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
  /** Listening sessions' utterances being transcribed, and the last of each speaker's (they go one at a time). */
  private readonly pending = new Set<Promise<void>>();
  private readonly speakers = new Map<string, Promise<void>>();
  private transcribing = 0;
  private readonly slots: (() => void)[] = [];

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
    const identity = identityInput({ subject: input.subject, context: input.context });
    const bucket = input.bucket === undefined ? undefined : bucketInput(input.bucket);
    const keyScope = input.keyScope === undefined ? undefined : text(input.keyScope, "keyScope", /^.{1,100}$/s, "a key scope's name");
    const language = languageInput(input.language);
    if (input.brain !== undefined && input.brain !== "realtime" && input.brain !== "listen") throw new HttpError(400, "brain must be realtime (the default) or listen");
    const listen = input.brain === "listen";
    // A browser session's socket gets every utterance itself.
    if (listen && !webhooks && !socket) throw new HttpError(400, "A listening session sends its utterances to webhooks: leave deliver.webhooks on");
    // Muted, nothing answers: answering's settings (speak, bargeIn, voice, addressing, realtime, speakers,
    // deliver.agent) are taken and ignored, so a client that sends them anyway still gets the muted session it asked for.
    // A realtime session speaks: `speak: true` (from before) is taken and changes nothing.
    if (!listen && input.speak !== undefined && input.speak !== true) throw new HttpError(400, "speak can only be true (a realtime session speaks), or left out; brain listen is a muted session");
    const prompt = input.prompt === undefined ? undefined : text(input.prompt, "prompt", new RegExp(`^[\\s\\S]{1,${VOICE_LIMITS.promptChars}}$`), `at most ${VOICE_LIMITS.promptChars} characters`);
    const bargeIn = listen ? { on: false } : bargeInInput(input.bargeIn);
    const voice = listen || input.voice === undefined ? DEFAULT_VOICE : text(input.voice, "voice", VOICE_NAME, "a voice's name, such as alloy, coral or verse");
    const notice = input.notice === undefined ? listen ? LISTENING_NOTICE : DEFAULT_NOTICE : text(input.notice, "notice", new RegExp(`^[\\s\\S]{1,${VOICE_LIMITS.noticeChars}}$`), `at most ${VOICE_LIMITS.noticeChars} characters`);
    const realtime = listen ? undefined : this.realtimeInput(input, voice);
    const speakers = listen ? undefined : speakersInput(input.speakers);
    const common = {
      deliver: { ...(agent && !listen ? { agent } : {}), webhooks },
      ...(identity?.subject !== undefined ? { subject: identity.subject } : {}), ...(bucket ? { bucket } : {}),
      ...(identity?.context ? { context: identity.context } : {}), ...(keyScope ? { keyScope } : {}),
      ...(language ? { language } : {}), ...(prompt ? { prompt } : {}),
      silenceMs: integer(input.silenceMs, "silenceMs", VOICE_LIMITS.silenceMs),
      maxMinutes: integer(input.maxMinutes, "maxMinutes", VOICE_LIMITS.maxMinutes),
      idleMinutes: integer(input.idleMinutes, "idleMinutes", VOICE_LIMITS.idleMinutes),
      emptySeconds: integer(input.emptySeconds, "emptySeconds", VOICE_LIMITS.emptySeconds),
      ignoreUserIds: ignored(input.ignoreUserIds), metadata: metadataInput(input.metadata), notice,
      endOfTurn: endOfTurnInput(input.endOfTurn, this.options.turnModels ? "smart" : "silence"),
    };
    if (!realtime) return { ...common, brain: "listen" };
    return {
      ...common, bargeIn: bargeIn.on, ...(bargeIn.policy ? { interruption: bargeIn.policy } : {}), voice,
      addressing: addressingInput(input.addressing), realtime, ...(speakers ? { speakers } : {}),
    };
  }

  /**
   * `realtime` as given: one of the runtime's providers, with its model, voice (the session's mapped to the provider's
   * when not given), persona and listening settings.
   */
  private realtimeInput(input: Record<string, unknown>, voice: string): RealtimeOptions {
    const providers = this.options.realtime?.providers ?? {};
    if (!Object.keys(providers).length) throw new HttpError(404, "Voice sessions need a realtime provider, and this runtime has none (AGENT_VOICE_REALTIME)");
    const given = input.realtime === undefined ? {} : object(input.realtime, "realtime");
    only(given, "realtime", ["provider", "model", "voice", "publicOwnerId", "instructions", "transcribe", "speculative"]);
    const id = (given.provider ?? Object.keys(providers)[0]) as string;
    const provider = providers[id as RealtimeProviderId];
    if (!provider) throw new HttpError(400, `realtime.provider must be one of this runtime's: ${Object.keys(providers).join(", ")}`);
    const model = given.model === undefined ? provider.defaultModel : given.model;
    if (typeof model !== "string" || !provider.models.includes(model)) throw new HttpError(400, `realtime.model must be one of ${provider.models.join(", ")}`);
    if (!realtimePrice(`${provider.id}/${model}`)) throw new HttpError(400, `Realtime model ${provider.id}/${model} has no price configured`, "REALTIME_UNPRICED");
    if (given.voice !== undefined && (typeof given.voice !== "string" || !(provider.customVoices ? /^[a-zA-Z0-9_-]{1,100}$/.test(given.voice) : provider.voices.includes(given.voice)))) throw new HttpError(400, `realtime.voice must be one of ${provider.id}'s: ${provider.voices.join(", ")}`);
    if (given.publicOwnerId !== undefined && (provider.id !== "elevenlabs" || typeof given.publicOwnerId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(given.publicOwnerId))) throw new HttpError(400, "realtime.publicOwnerId must be an ElevenLabs public owner ID");
    const instructions = given.instructions === undefined ? undefined : text(given.instructions, "realtime.instructions", new RegExp(`^[\\s\\S]{1,${VOICE_LIMITS.realtimeInstructionsChars}}$`), `at most ${VOICE_LIMITS.realtimeInstructionsChars} characters`);
    for (const flag of ["transcribe", "speculative"] as const) if (given[flag] !== undefined && typeof given[flag] !== "boolean") throw new HttpError(400, `realtime.${flag} must be true or false`);
    return {
      provider: provider.id, model, voice: given.voice !== undefined && !provider.customVoices ? given.voice as string : realtimeVoice(provider, (given.voice as string | undefined) ?? voice),
      ...(given.publicOwnerId !== undefined ? { publicOwnerId: given.publicOwnerId as string } : {}),
      ...(instructions ? { instructions } : {}), transcribe: given.transcribe !== false, speculative: !provider.ownsTurns && given.speculative !== false,
    };
  }

  /**
   * Start a session from the credentials the app forwarded: stored (the grant sealed), then taken and connected here
   * when this node can, else by a peer's scan. Answers the session with the notice the app must post.
   */
  async create(tenant: string, input: Record<string, unknown>) {
    only(input, "body", ["provider", "discord", "subject", "bucket", "context", "keyScope", "deliver", "language", "prompt", "silenceMs", "maxMinutes", "idleMinutes", "emptySeconds", "ignoreUserIds", "metadata", "notice", "speak", "bargeIn", "voice", "endOfTurn", "addressing", "brain", "realtime", "speakers"]);
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
    const listen = options.brain === "listen";
    if (listen && !this.options.transcriber) throw new HttpError(404, "Listening sessions (brain listen) are not enabled on this runtime");
    if (!listen && !this.options.transports[provider]?.speaks) throw new HttpError(404, "Voice sessions are not enabled on this runtime: its connections cannot speak");
    if (options.endOfTurn?.mode === "smart" && !this.options.turnModels) throw new HttpError(404, "Smart end of turn is not enabled on this runtime: use endOfTurn silence");
    if (options.deliver.agent && !await this.options.agentOwned(options.deliver.agent, tenant)) throw new HttpError(404, "Unknown agent in deliver.agent");
    await this.options.admit(tenant);
    const refused = options.subject !== undefined ? await this.options.credit?.refusal(tenant, options.subject, options.bucket ?? DEFAULT_BUCKET) : undefined;
    if (refused) throw new HttpError(402, refused.message, "END_USER_CREDIT", { endUser: options.subject, bucket: options.bucket ?? DEFAULT_BUCKET, reason: refused.reason });
    if (listen) {
      const transcriber = this.options.transcriber!;
      if (!await transcriber.options.key(tenant, options.keyScope, transcriber.provider)) {
        throw new HttpError(400, `A listening session transcribes with a key for ${transcriber.provider}: add one under Models & keys (PUT /v1/providers/${transcriber.provider}/key)${options.keyScope ? `, or to key scope ${options.keyScope}` : ""}`, "TRANSCRIPTION_UNAVAILABLE");
      }
    } else {
      const realtime = this.options.realtime!.providers[options.realtime!.provider]!;
      if (!await this.options.realtime!.key(tenant, options.keyScope, realtime.key)) {
        throw new HttpError(400, `Voice sessions on ${realtime.id} need a key for ${realtime.key}: add one under Models & keys (PUT /v1/providers/${realtime.key}/key)${options.keyScope ? `, or to key scope ${options.keyScope}` : ""}`, "REALTIME_UNAVAILABLE");
      }
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
    if (!this.stopped) {
      const taken = this.hasRoom(row, now) ? this.take(row) : this.notify([id]);
      void taken.catch(error => console.error(JSON.stringify({ type: "voice_take_failed", session: id, error: safeError(error) })));
    }
    return {
      ...sessionView(row), notice: { required: true, channelId: credentials.channelId, text: options.notice.replaceAll("{bot}", credentials.userId) },
      // How the app should have joined: un-muted when the bot speaks.
      join: { self_mute: listen, self_deaf: false },
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

  /** Stop what the bot is saying, and what it was going to: answers how many speeches that stopped. */
  async stopSpeaking(tenant: string, id: string) {
    const row = await this.row(tenant, id);
    if (row.options.brain === "listen") throw new HttpError(409, "This voice session listens and does not speak", "VOICE_SPEAK_DISABLED");
    if (row.state === "ended") return { stopped: 0 };
    const held = this.held.get(id);
    if (!held) throw new HttpError(503, "This voice session is moving between nodes; retry");
    return { stopped: held.brain?.stopSpeaking() ?? 0 };
  }

  /** The session, held here and speaking, for what the bot's code has it say or play. */
  private async speaker(tenant: string, id: string): Promise<Held & { brain: RealtimeBrain }> {
    const row = await this.row(tenant, id);
    if (row.options.brain === "listen") throw new HttpError(409, "This voice session listens and does not speak", "VOICE_SPEAK_DISABLED");
    if (row.state === "ended") throw new HttpError(409, "This voice session ended", "VOICE_SESSION_ENDED");
    const held = this.held.get(id);
    if (!held?.brain) throw new HttpError(503, "This voice session is moving between nodes; retry");
    return held as Held & { brain: RealtimeBrain };
  }

  /**
   * Have the bot say `text` (POST …/say): in its call's voice, after what it is saying and answers people wait for
   * (`interrupt`: cutting that off, now). Answers the speech's id (its voice.speech.* events') and how many are ahead.
   */
  async say(tenant: string, id: string, input: { text: string; interrupt?: boolean }) {
    const text = input.text.trim();
    if (!text) throw new HttpError(400, "text must say something");
    if (text.length > REALTIME_LIMITS.sayChars) throw new HttpError(400, `text must be at most ${REALTIME_LIMITS.sayChars} characters`);
    const held = await this.speaker(tenant, id);
    return held.brain.say(text, { interrupt: input.interrupt === true });
  }

  /** Have the bot speak up unprompted (POST …/prompt): its model answers `instructions` once the floor is free. */
  async prompt(tenant: string, id: string, input: { instructions: string; interrupt?: boolean }) {
    const instructions = input.instructions.trim();
    if (!instructions) throw new HttpError(400, "instructions must say something");
    if (instructions.length > REALTIME_LIMITS.promptChars) throw new HttpError(400, `instructions must be at most ${REALTIME_LIMITS.promptChars} characters`);
    const held = await this.speaker(tenant, id);
    return held.brain.prompt(instructions, { interrupt: input.interrupt === true });
  }

  /** Queue audio to play in the call (POST …/audio): an https URL, or bytes given. Answers the track and its place. */
  async play(tenant: string, id: string, input: { url?: string; bytes?: Uint8Array; title?: string; next?: boolean; volume?: number }) {
    let source: AudioSource;
    if (input.bytes) source = { bytes: input.bytes };
    else if (typeof input.url === "string") {
      if (!this.options.audioOutbound) throw new HttpError(404, "Playing audio from URLs is not enabled on this runtime");
      try { this.options.audioOutbound.check(input.url); }
      catch (error) { throw new HttpError(400, `url: ${(error as Error).message}`); }
      source = { url: input.url };
    } else throw new HttpError(400, "Give the audio: a url, or the file as the body");
    if (input.title !== undefined && input.title.length > AUDIO_LIMITS.titleChars) throw new HttpError(400, `title must be at most ${AUDIO_LIMITS.titleChars} characters`);
    const held = await this.speaker(tenant, id);
    return (held.jukebox ??= this.jukeboxOf(held)).add(source, input);
  }

  /** What plays and waits (GET …/audio). */
  async audio(tenant: string, id: string) {
    const held = await this.speaker(tenant, id);
    return held.jukebox?.state() ?? { playing: null, queue: [], volume: 0.5, paused: false };
  }

  /** Control what plays (PATCH …/audio): pause, resume, skip or stop (the queue too), and its volume. */
  async controlAudio(tenant: string, id: string, input: { action?: "pause" | "resume" | "skip" | "stop"; volume?: number }) {
    const held = await this.speaker(tenant, id);
    const jukebox = held.jukebox ??= this.jukeboxOf(held);
    if (input.volume !== undefined) jukebox.setVolume(input.volume);
    switch (input.action) {
      case "pause": return jukebox.pause();
      case "resume": return jukebox.resume();
      case "skip": return jukebox.skip();
      case "stop": return jukebox.stop();
      default: return jukebox.state();
    }
  }

  /**
   * A held session's jukebox: on its media, reading URLs through the outbound guard as they play. What plays keeps the
   * session from idling; each track's start and end go out as voice.audio.* events, and the seconds played are counted.
   */
  private jukeboxOf(held: Held): Jukebox {
    const outbound = this.options.audioOutbound;
    const log = (type: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ type, session: held.id, node: this.options.node, ...fields }));
    return new Jukebox({
      player: () => held.media?.speaks ? held.media : undefined,
      open: async (source, signal) => {
        if ("bytes" in source) return (async function* () { yield source.bytes; })();
        if (!outbound) throw new HttpError(404, "Playing audio from URLs is not enabled on this runtime");
        const address = new URL(source.url);
        const where = `${address.origin}${address.pathname}`.slice(0, 200);
        let response: Response;
        try {
          response = await outbound.fetch(address, { signal, stream: true, timeoutMs: FILE_LIMITS.urlMs, maxBytes: Number.POSITIVE_INFINITY, maxRedirects: FILE_LIMITS.urlRedirects });
        } catch (error) {
          if (signal.aborted) throw error;
          throw new HttpError(400, `Could not fetch ${where} (${safeError(error).slice(0, 200)})`);
        }
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new HttpError(400, `Could not fetch ${where} (HTTP ${response.status})`); }
        const body = response.body;
        // At most fileBytes of it: a stream ends there.
        return (async function* () {
          let bytes = 0;
          for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
            const room = AUDIO_LIMITS.fileBytes - bytes;
            if (room <= 0) break;
            bytes += chunk.byteLength;
            yield chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
          }
          await body.cancel().catch(() => {});
        })();
      },
      active: () => {
        const now = Date.now();
        void underClaim(this.db, held.claim, sql => sql.query("update voice_sessions set last_speech_at = greatest(coalesce(last_speech_at, 0), $2), updated_at = $2 where id = $1 and state <> 'ended'", [held.id, now]))
          .catch(error => log("voice_audio_write_failed", { error: safeError(error) }));
      },
      event: event => {
        const track = { trackId: event.track.id, title: event.track.title, source: event.track.source };
        const data = event.type === "started" ? track : { ...track, reason: event.reason, seconds: event.seconds, ...(event.error ? { error: event.error } : {}) };
        void transaction(this.db, async sql => {
          const query = event.type === "ended"
            ? sql.query("update voice_sessions set played_seconds = played_seconds + $2, tracks = tracks + $3, updated_at = $4 where id = $1 returning *", [held.id, event.seconds, event.seconds > 0 ? 1 : 0, Date.now()])
            : sql.query("select * from voice_sessions where id = $1", [held.id]);
          const row = (await query).rows[0] as Row | undefined;
          if (row?.options.deliver.webhooks) await enqueueEvents(sql, [this.event(row, `voice.audio.${event.type}`, data, `voice:${held.id}:audio.${event.type}:${event.track.id}`)]);
          if (row) held.row = { ...held.row, played_seconds: row.played_seconds, tracks: row.tracks };
        }).then(() => this.options.kickWebhooks?.(), error => log("voice_audio_event_failed", { error: safeError(error) }));
        held.media?.notify?.({ type: "audio", state: event.type, trackId: event.track.id, ...(event.type === "ended" ? { reason: event.reason } : {}) });
      },
      log,
    });
  }

  /** End a session (`requested`): answers it, and the OP 4 the app sends to leave the channel. */
  async end(tenant: string, id: string) {
    const row = await this.row(tenant, id);
    const ended = row.state === "ended" ? row : await this.finish(undefined, id, { reason: "requested" }) ?? await this.row(tenant, id);
    return { ...sessionView(ended), leave: { op: 4, d: { guild_id: ended.guild, channel_id: null, self_mute: false, self_deaf: false } } };
  }

  // Recordings --------------------------------------------------------------------

  /**
   * Start recording a session's call: one recording at a time a session, until it is stopped, reaches `maxMinutes` or
   * `maxBytes`, or the session ends. Its owner starts recording as it learns of it (at once, or on its notification).
   */
  async startRecording(tenant: string, id: string, input: Record<string, unknown>) {
    only(input, "body", ["tracks", "maxMinutes", "maxBytes", "retentionHours", "metadata"]);
    if (!this.options.storage) throw new HttpError(404, "Voice recordings are not enabled on this runtime");
    if (input.tracks !== undefined && input.tracks !== "mixed" && input.tracks !== "speakers") throw new HttpError(400, "tracks must be mixed (one file, the default) or speakers (a file each)");
    const options = {
      maxMinutes: integer(input.maxMinutes, "maxMinutes", RECORDING_LIMITS.maxMinutes),
      maxBytes: integer(input.maxBytes, "maxBytes", RECORDING_LIMITS.maxBytes),
      retentionHours: integer(input.retentionHours, "retentionHours", RECORDING_LIMITS.retentionHours),
      ...(input.metadata !== undefined ? { metadata: metadataInput(input.metadata) } : {}),
    };
    const session = await this.row(tenant, id);
    if (session.state === "ended") throw new HttpError(409, `This voice session ended (${session.end_reason})`, "VOICE_SESSION_ENDED");
    const now = Date.now();
    let row: RecordingRow;
    try {
      row = (await this.db.query(`
        insert into voice_recordings (id, tenant, session, state, tracks, options, started_at, updated_at) values ($1, $2, $3, 'recording', $4, $5, $6, $6) returning *`,
      [`vr_${randomBytes(12).toString("hex")}`, tenant, id, input.tracks ?? "mixed", JSON.stringify(options), now])).rows[0];
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      const active = (await this.db.query("select id from voice_recordings where session = $1 and state in ('recording', 'stopping', 'finishing')", [id])).rows[0];
      throw new HttpError(409, `This voice session is recording already (${active?.id ?? "a recording"}): stop it first`, "VOICE_RECORDING_EXISTS", active ? { recording: active.id } : undefined);
    }
    console.log(JSON.stringify({ type: "voice_recording_created", session: id, recording: row.id, tenant, tracks: row.tracks, node: this.options.node }));
    await this.changed(id);
    // People must know they are recorded: the app posts this in the voice channel's chat.
    return { ...recordingView(row), notice: { required: true as const, channelId: session.channel, text: RECORDING_NOTICE.replaceAll("{bot}", session.bot_user) } };
  }

  /**
   * Stop a session's recording: its owner writes what it holds and makes the files (or, with no owner, this node from
   * what is stored). Answers the recording once its files are made, or as it is after RECORDING_STOP_WAIT_MS
   * (`stopping`; `voice.recording.ended` says when they are).
   */
  async stopRecording(tenant: string, id: string) {
    const session = await this.row(tenant, id);
    const { rows } = await this.db.query("update voice_recordings set state = 'stopping', updated_at = $2 where session = $1 and state = 'recording' returning id", [id, Date.now()]);
    const recording = (rows[0] ?? (await this.db.query("select id from voice_recordings where session = $1 and state in ('stopping', 'finishing')", [id])).rows[0]) as { id: string } | undefined;
    if (!recording) throw new HttpError(409, "This voice session is not recording", "VOICE_NOT_RECORDING");
    // A session that ended a while ago has no owner left to finish it (one that just ended, its owner finishes).
    if (session.state === "ended" && Date.now() - num(session.ended_at)! >= RECORDING_ORPHAN_MS) await this.finishRecording(recording.id, "stopped");
    else if (session.state !== "ended") await this.changed(id);
    const deadline = Date.now() + RECORDING_STOP_WAIT_MS;
    for (;;) {
      const row = (await this.db.query("select * from voice_recordings where id = $1", [recording.id])).rows[0] as RecordingRow;
      if (row.state === "ready" || row.state === "failed" || Date.now() >= deadline) return recordingView(row);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  private async recordingRow(tenant: string, id: string): Promise<RecordingRow> {
    const row = RECORDING_ID.test(id) ? (await this.db.query("select * from voice_recordings where id = $1 and tenant = $2", [id, tenant])).rows[0] as RecordingRow | undefined : undefined;
    if (!row) throw new HttpError(404, "Unknown voice recording");
    return row;
  }

  async getRecording(tenant: string, id: string) { return recordingView(await this.recordingRow(tenant, id)); }

  /** One of a ready recording's files, by name. */
  async recordingFile(tenant: string, id: string, name: string): Promise<{ data: Uint8Array; contentType: string; name: string }> {
    const row = await this.recordingRow(tenant, id);
    const file = row.state === "ready" ? row.files?.find(entry => entry.name === name) : undefined;
    if (!file) throw new HttpError(404, row.state === "ready" ? `This recording has no file ${name}` : "This recording has no files yet");
    const data = await this.options.storage?.readBlob(`${recordingPrefix(row.tenant, row.id)}${file.name}`);
    if (!data) throw new HttpError(410, "This recording's files are no longer kept");
    return { data, contentType: file.contentType, name: file.name };
  }

  /** Delete a recording and its files now; one still recording is stopped first. */
  async deleteRecording(tenant: string, id: string) {
    const row = await this.recordingRow(tenant, id);
    if (row.state === "recording" || row.state === "stopping" || row.state === "finishing") throw new HttpError(409, "This recording is still going: stop it first", "VOICE_RECORDING_ACTIVE");
    await this.options.storage?.removeBlobs(recordingPrefix(row.tenant, row.id));
    await this.db.query("delete from voice_recordings where id = $1", [row.id]);
    return { id: row.id, deleted: true };
  }

  /** Run work on a held session's recording after what was asked before it. */
  private recordingWork(held: Held, work: () => Promise<void>): Promise<void> {
    const next = (held.recordingWork ?? Promise.resolve()).then(work).catch(error =>
      console.error(JSON.stringify({ type: "voice_recording_failed", session: held.id, recording: held.recording?.id ?? null, error: safeError(error) })));
    held.recordingWork = next;
    return next;
  }

  /**
   * The owner's side of a session's recording, as its row says: start (or, taken from another node, go on with) one
   * that records, end one asked to stop, and forget one gone (finished by another node, deleted).
   */
  private syncRecording(held: Held): Promise<void> {
    return this.recordingWork(held, async () => {
      if (this.held.get(held.id) !== held) return;
      // Read now, after the work before it (which may have ended the recording).
      const row = (await this.db.query("select * from voice_recordings where session = $1 and state in ('recording', 'stopping')", [held.id])).rows[0] as RecordingRow | undefined;
      if (row && !held.recording) {
        held.recording = {
          id: row.id,
          recorder: new Recorder({ startedAt: num(row.started_at)!, tracks: row.tracks, maxBytes: row.options.maxBytes, maxMinutes: row.options.maxMinutes, bytes: Number(row.bytes) }),
        };
        held.media?.configure({ record: true });
        console.log(JSON.stringify({ type: "voice_recording_started", session: held.id, recording: row.id, resumed: row.chunks.length > 0, node: this.options.node }));
      }
      if (row?.state === "stopping" && held.recording?.id === row.id) await this.endRecording(held, "stopped");
      else if (!row && held.recording) {
        held.recording.recorder.close();
        held.recording = undefined;
        held.media?.configure({ record: false });
      }
    });
  }

  /** Packets the media heard and played, into the recording: ended at its limits, written out as chunks fall due. */
  private recorded(held: Held, packets: RecordedPacket[]) {
    const recording = held.recording;
    if (!recording) return;
    recording.recorder.add(packets);
    const full = recording.recorder.full();
    if (full) void this.recordingWork(held, () => held.recording === recording ? this.endRecording(held, full) : Promise.resolve());
    else if (recording.recorder.due()) void this.recordingWork(held, () => held.recording === recording ? this.writeChunk(held, false) : Promise.resolve());
  }

  /**
   * What the recorder holds, written as a chunk and listed on its row under the claim (`final`: all of it, as it ends
   * or leaves this node). A chunk its row no longer takes (finished elsewhere) is deleted.
   */
  private async writeChunk(held: Held, final: boolean) {
    const recording = held.recording!;
    const chunk = recording.recorder.chunk(final);
    if (!chunk) return;
    const key = `${recordingPrefix(held.tenant, recording.id)}chunks/${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    await this.options.storage!.writeBlob(key, chunk);
    const listed = await underClaim(this.db, held.claim, sql => sql.query(`
      update voice_recordings set chunks = chunks || $2::jsonb, bytes = $3, updated_at = $4 where id = $1 and state in ('recording', 'stopping')`,
    [recording.id, JSON.stringify([key]), recording.recorder.bytes, Date.now()]));
    if (!listed.rowCount) await this.options.storage!.removeBlob(key).catch(() => {});
  }

  /** The owner ends its recording: the rest written, then its files made. */
  private async endRecording(held: Held, reason: RecordingEnd) {
    const recording = held.recording;
    if (!recording) return;
    // What could not be written is lost; the files are made from what was.
    try { await this.writeChunk(held, true); }
    catch (error) { console.error(JSON.stringify({ type: "voice_recording_write_failed", session: held.id, recording: recording.id, error: safeError(error) })); }
    finally {
      recording.recorder.close();
      held.recording = undefined;
      held.media?.configure({ record: false });
    }
    if (recording.recorder.dropped) console.log(JSON.stringify({ type: "voice_recording_dropped", session: held.id, recording: recording.id, packets: recording.recorder.dropped }));
    await this.finishRecording(recording.id, reason);
  }

  /** A held session's recording leaves this node (handoff): what it holds is written, for the next owner to go on. */
  private async leaveRecording(held: Held, write: boolean) {
    const recording = held.recording;
    if (!recording) return;
    try { if (write) await this.writeChunk(held, true); }
    finally {
      recording.recorder.close();
      held.recording = undefined;
    }
  }

  /**
   * Make a recording's files from its chunks, once (whoever moves it to `finishing` first): written to storage, the row
   * ready with them, `voice.recording.ended` in the outbox, the chunks deleted. A failure leaves it `failed`, saying so.
   */
  private async finishRecording(id: string, reason: RecordingEnd) {
    const now = Date.now();
    const claimed = (await this.db.query(`
      update voice_recordings set state = 'finishing', end_reason = coalesce(end_reason, $2), ended_at = coalesce(ended_at, $3), updated_at = $3
      where id = $1 and (state in ('recording', 'stopping') or (state = 'finishing' and updated_at < $4)) returning *`, [id, reason, now, now - RECORDING_STUCK_MS])).rows[0] as RecordingRow | undefined;
    if (!claimed) return;
    const storage = this.options.storage!;
    const prefix = recordingPrefix(claimed.tenant, claimed.id);
    const expiresAt = now + claimed.options.retentionHours * 3_600_000;
    let ready: { files: RecordingFile[]; seconds: number } | undefined, error: string | undefined;
    try {
      const chunks: Uint8Array[] = [];
      for (const key of claimed.chunks) {
        const chunk = await storage.readBlob(key);
        if (chunk) chunks.push(chunk);
      }
      const made = assemble(chunks, claimed.tracks);
      for (const file of made.files) await storage.writeBlob(`${prefix}${file.name}`, file.data);
      ready = { files: made.files.map(({ data: _data, ...file }) => file), seconds: made.seconds };
    } catch (failure) {
      error = safeError(failure).slice(0, 200);
      console.error(JSON.stringify({ type: "voice_recording_finish_failed", recording: id, error }));
    }
    const row = await transaction(this.db, async sql => {
      const done = (await sql.query(`
        update voice_recordings set state = $2, files = $3, seconds = $4, error = $5, end_reason = $6, expires_at = $7, updated_at = $8 where id = $1 and state = 'finishing' returning *`,
      [id, ready ? "ready" : "failed", ready ? JSON.stringify(ready.files) : null, ready?.seconds ?? null, error ?? null, ready ? claimed.end_reason : "error", expiresAt, Date.now()])).rows[0] as RecordingRow | undefined;
      const session = (await sql.query("select * from voice_sessions where id = $1", [claimed.session])).rows[0] as Row | undefined;
      if (done && session?.options.deliver.webhooks) await enqueueEvents(sql, [this.event(session, "voice.recording.ended", { recording: recordingView(done) }, `voice:${claimed.session}:recording:${id}`)]);
      return done;
    });
    for (const key of claimed.chunks) await storage.removeBlob(key).catch(() => {});
    this.options.kickWebhooks?.();
    console.log(JSON.stringify({ type: "voice_recording_ended", session: claimed.session, recording: id, reason: row?.end_reason ?? reason, state: row?.state ?? null, seconds: ready?.seconds ?? null, files: ready?.files.length ?? 0, bytes: Number(claimed.bytes), node: this.options.node }));
  }

  /**
   * Recordings in this node's scan: the held sessions' as their rows say (a lost notification), those past their limits
   * or with a chunk due; any left open by a session that ended without its owner finishing them, or stuck finishing.
   */
  private async scanRecordings(now: number) {
    if (!this.options.storage) return;
    const held = [...this.held.values()];
    if (held.length) {
      const { rows } = await this.db.query("select * from voice_recordings where session = any($1) and state in ('recording', 'stopping')", [held.map(entry => entry.id)]);
      const bySession = new Map((rows as RecordingRow[]).map(row => [row.session, row]));
      for (const entry of held) {
        const row = bySession.get(entry.id) ?? null;
        if (row?.id !== entry.recording?.id || row?.state === "stopping") void this.syncRecording(entry);
        else if (entry.recording) {
          const recording = entry.recording;
          const full = recording.recorder.full(now);
          if (full) void this.recordingWork(entry, () => entry.recording === recording ? this.endRecording(entry, full) : Promise.resolve());
          else if (recording.recorder.due(now)) void this.recordingWork(entry, () => entry.recording === recording ? this.writeChunk(entry, false) : Promise.resolve());
        }
      }
    }
    const { rows: orphans } = await this.db.query(`
      select r.id from voice_recordings r join voice_sessions s on s.id = r.session
      where (r.state in ('recording', 'stopping') and s.state = 'ended' and s.ended_at < $1) or (r.state = 'finishing' and r.updated_at < $2)`,
    [now - RECORDING_ORPHAN_MS, now - RECORDING_STUCK_MS]);
    for (const { id } of orphans) await this.finishRecording(id, "session_ended");
  }

  // Holding sessions --------------------------------------------------------------

  /** Whether this node should take `row` now, or leave it to its peers (`VOICE_LIMITS.perNode`). */
  private hasRoom(row: Row, now: number) {
    if (this.options.memoryHigh?.()) return false;
    const { perNode = VOICE_LIMITS.perNode, perNodeWaitMs = VOICE_LIMITS.perNodeWaitMs } = this.options;
    return this.held.size + this.taking.size < perNode || now - Number(row.updated_at) >= perNodeWaitMs;
  }

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
          if (!this.hasRoom(row, now)) continue;
          await this.take(row).catch(error => console.error(JSON.stringify({ type: "voice_take_failed", session: row.id, error: safeError(error) })));
        }
      }
      await this.scanRecordings(now).catch(error => console.error(JSON.stringify({ type: "voice_recording_scan_failed", error: safeError(error) })));
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
      else {
        if (row.revision !== held.revision) this.apply(held, row);
        await this.syncRecording(held);
      }
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
    // Its brain is made before it is held (`brain` is set below).
    const held = {
      id: current.id, tenant: current.tenant, claim: taken.claim, revision: current.revision, row: current, credentials: this.credentials(current),
      floor: new Floor(current.options.addressing ?? {}, () => clock().now()),
    } as Held;
    // A listening session has no brain; one from before realtime brains (its pipeline is gone) cannot go on.
    if (current.options.brain !== "listen") {
      const brain = current.options.realtime ? await this.brainOf(held).catch((error: unknown) => {
        console.error(JSON.stringify({ type: "voice_realtime_unavailable", session: held.id, error: safeError(error) }));
        return undefined;
      }) : undefined;
      if (!brain) {
        await ownership.release(taken.claim).catch(() => {});
        await this.finish(undefined, held.id, { reason: "error", detail: current.options.realtime ? "realtime_unavailable" : "brain_removed" }).catch(() => {});
        return;
      }
      held.brain = brain;
    }
    this.held.set(held.id, held);
    console.log(JSON.stringify({ type: "voice_session_acquired", session: held.id, node: this.options.node, epoch: taken.claim.epoch }));
    if (current.state === "live") await this.setState(held, "reconnecting").catch(() => {});
    this.connect(held, transport);
    // A recording it was making goes on here.
    if (this.options.storage) void this.syncRecording(held);
  }

  private credentials(row: Row): VoiceCredentials {
    const secret: Secret = JSON.parse(this.options.accounts.unseal(aad(row.id), row.sealed!));
    return { guildId: row.guild, channelId: row.channel, userId: row.bot_user, ...secret };
  }

  /** What a session's media needs of its settings. */
  private mediaOptions(held: Held): MediaOptions {
    const { options } = held.row;
    const policy = interruption(options);
    return {
      silenceMs: options.silenceMs, ignoreUserIds: options.ignoreUserIds, bargeIn: !!held.brain && options.bargeIn !== false,
      bargeInMinMs: policy.minMs, bargeInPause: policy.confirmMs > 0,
      // A brain hears each speaker's audio as it comes; a listening session transcribes each cut whole.
      live: !!held.brain,
      ...(options.endOfTurn ? { endOfTurn: options.endOfTurn } : {}),
      ...(held.recording ? { record: true } : {}),
    };
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
        held.brain?.speechStart(speaker);
      },
      // Barge-in: a person talked over the bot for minMs. The media already stopped what it plays, or paused it for
      // the brain's echo guard to decide.
      bargeIn: (speaker, speechMs) => { if (current()) held.brain?.bargeIn(speaker, speechMs, held.speechStarts?.get(speaker)); },
      speechProgress: (speaker, speechMs) => { if (current()) held.brain?.speechProgress(speaker, speechMs); },
      turn: event => {
        if (!current()) return;
        held.brain?.turnEvent(event);
        (held.turnStats ??= { likelyEnds: 0, resumes: 0, turns: 0 });
        if (event.type === "likely_end") held.turnStats.likelyEnds++;
        else if (event.type === "resume") held.turnStats.resumes++;
        else if (event.type === "turn_end") held.turnStats.turns++;
      },
      pcm: (speaker, pcm) => { if (current()) held.brain?.pcm(speaker, pcm); },
      drop: speaker => { if (current()) held.brain?.drop(speaker); },
      // A brain's turns are its own. A listening session transcribes each cut, even one of a media replaced or a
      // session let go (handoff, end): what was said is still sent.
      cut: cut => { if (held.brain) { if (current()) held.brain.cut(cut); } else this.listened(held, cut); },
      // A replaced media's last packets are the recording's too, and a closing one's (the recorder ends after it).
      recorded: packets => this.recorded(held, packets),
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
   * Stop holding a session: its brain stops, its connection closes, and it is released (`release`): any node may take it
   * at once.
   */
  private async drop(held: Held, release: boolean, cut: "handoff" | "end" = "handoff") {
    if (this.held.get(held.id) !== held) return;
    this.held.delete(held.id);
    held.brain?.close();
    held.jukebox?.close();
    // What turn-taking did in this session, for tuning: likely ends spoken past (resumes) are speculation discarded.
    if (held.turnStats) {
      const { likelyEnds, resumes, turns } = held.turnStats;
      console.log(JSON.stringify({ type: "voice_turn_stats", session: held.id, turns, likelyEnds, resumes, discardRate: likelyEnds ? Math.round(resumes / likelyEnds * 1_000) / 1_000 : null, floor: held.floor.stats }));
    }
    const media = held.media;
    held.media = undefined;
    await media?.close(cut).catch(error => console.error(JSON.stringify({ type: "voice_media_close_failed", session: held.id, error: safeError(error) })));
    // Its recording ends with the session, or is written out for the next owner (unless the claim is gone: fenced).
    if (held.recording || held.recordingWork) {
      await this.recordingWork(held, () => release && cut === "end" ? this.endRecording(held, "session_ended") : this.leaveRecording(held, release));
    }
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
   * A listening session's utterance was cut: transcribed and sent after the speaker's previous one. What it needs of
   * the session is fixed now: the session may move or end meanwhile.
   */
  private listened(held: Held, cut: Cut) {
    const origin: Origin = { id: held.id, tenant: held.tenant, claim: held.claim, row: held.row };
    const key = `${held.id}:${cut.speaker}`;
    const job = (this.speakers.get(key) ?? Promise.resolve()).then(() => this.transcribeCut(origin, cut)).catch(error =>
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
   * Transcribe a listening session's utterance and send it: the tenant's run limit first (past it the session ends,
   * `budget`), the subject's credit held, then a fresh lease, then the provider; its usage recorded as the session's
   * subject's; its transcript counted and sent (the webhook event in the same transaction as the count). An utterance
   * is at most once until its transcript is written (its audio lives only in the node's memory), at least once after.
   */
  private async transcribeCut(origin: Origin, cut: Cut) {
    const transcriber = this.options.transcriber;
    if (!transcriber) return;
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
          ? await credit.hold(origin.tenant, options.subject, options.bucket ?? DEFAULT_BUCKET, transcriber.cost(cut.seconds), "voice", { session: origin.id })
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
        done = await transcriber.transcribe({ tenant: origin.tenant, ...(options.keyScope ? { keyScope: options.keyScope } : {}) }, { bytes, header: checkedAudio(bytes) },
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
    const identity = { ...(options.subject !== undefined ? { subject: options.subject } : {}), context: { ...options.context, voiceSession: origin.id } };
    this.options.record(origin.tenant, { ...usage, identity, ...(options.keyScope ? { keyScope: options.keyScope } : {}) });
    const usd = usage.usage.cost.total as number;
    const row = await transaction(this.db, async sql => {
      const { rows } = await sql.query(`
        update voice_sessions set utterances = utterances + 1, speech_seconds = speech_seconds + $2, cost = cost + $3,
          last_speech_at = greatest(coalesce(last_speech_at, 0), $4), updated_at = $5
        where id = $1 returning *`, [origin.id, transcript.seconds, Math.round(usd * 1_000_000), Math.round(cut.endedAt), Date.now()]);
      const current = rows[0] as Row | undefined;
      if (current && transcript.text && current.options.deliver.webhooks) {
        await enqueueEvents(sql, [this.event(current, "voice.utterance", {
          speakerId: cut.speaker, seq: current.utterances, text: transcript.text, language: transcript.language ?? options.language ?? null,
          seconds: cut.seconds, startedAt: cut.startedAt, endedAt: cut.endedAt, ended: cut.ended, costUsd: usd, brain: "listen",
        }, `voice:${origin.id}:utterance:${current.utterances}`)]);
      }
      return current;
    });
    if (row && transcript.text && row.options.deliver.webhooks) this.options.kickWebhooks?.();
    // A browser call's page sees each utterance as it is transcribed (it needs no webhook).
    const local = this.held.get(origin.id);
    if (row && transcript.text) local?.media?.notify?.({ type: "utterance", speakerId: cut.speaker, seq: row.utterances, text: transcript.text, startedAt: cut.startedAt, endedAt: cut.endedAt, ended: cut.ended, brain: "listen" });
    if (row && local) local.row = { ...local.row, last_speech_at: row.last_speech_at, utterances: row.utterances };
    console.log(JSON.stringify({ type: "voice_utterance", session: origin.id, seq: row?.utterances, seconds: cut.seconds, billedSeconds: transcript.seconds, ended: cut.ended, empty: !transcript.text, ms: Date.now() - started }));
  }

  /** End a session from an utterance's work: under the claim if this node still holds it as it did, else as anyone. */
  private async endFor(origin: Origin, ending: Ending) {
    const held = this.held.get(origin.id);
    await this.finish(held && held.claim === origin.claim ? held : undefined, origin.id, ending);
  }

  /** People in a session's call now (not the bot, not ignored users), when its media knows. */
  private humans(id: string) {
    const held = this.held.get(id);
    return held?.media?.others()?.filter(user => user !== held.credentials.userId && !held.row.options.ignoreUserIds.includes(user)).length;
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
        reason: ending.reason, ...(ending.detail ? { detail: ending.detail } : {}), ...(ending.error ? { error: ending.error } : {}), ...(ending.limit ? { limit: ending.limit } : {}), ...(ending.endUserReason ? { endUserReason: ending.endUserReason } : {}), ...(ending.bucket ? { bucket: ending.bucket } : {}),
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
   * out with `brain: "realtime"`. ask_agent prompts deliver.agent, whose run is billed as any run.
   */
  private async brainOf(held: Held): Promise<RealtimeBrain> {
    const options = () => held.row.options;
    const realtime = options().realtime!;
    const provider = this.options.realtime?.providers[realtime.provider];
    if (!provider) throw new Error(`Realtime provider ${realtime.provider} is not enabled on this runtime`);
    if (!realtimePrice(`${provider.id}/${realtime.model}`)) throw new Error(`Realtime model ${provider.id}/${realtime.model} has no price configured`);
    const credentials = await this.options.realtime!.key(held.tenant, options().keyScope, provider.key, realtime.model);
    if (!credentials) throw new Error(`No ${provider.key} key for a realtime brain`);
    const agent = options().deliver.agent;
    const submit = agent && this.options.submitStreaming ? this.options.submitStreaming : undefined;
    const identity = () => ({ ...(options().subject !== undefined ? { subject: options().subject } : {}), context: { ...options().context, voiceSession: held.id } });
    const config = {
      model: realtime.model, voice: realtime.voice, publicOwnerId: realtime.publicOwnerId, transcribe: realtime.transcribe,
      instructions: realtimeInstructions(realtime.instructions, { agent: !!submit, group: held.row.provider !== "browser" }),
      tools: [...submit ? [ASK_AGENT] : [], STAY_SILENT],
      ...(options().language ? { language: options().language } : {}), ...(options().prompt ? { prompt: options().prompt } : {}),
      ...(options().bargeIn === false ? { interruptible: false } : {}),
    };
    const unnamed = new Map<string, string>();
    let asks = 0;
    // What the bot's code has it say, by text to speech in the call's voice: OpenAI's voices for an OpenAI brain,
    // ElevenLabs' for an ElevenLabs one, as POST /v1/speech makes and bills it (kind speech), on the session's subject.
    const tts = this.options.speech;
    const choice = provider.id === "openai" ? {} : provider.id === "elevenlabs" ? { providers: ["elevenlabs/eleven_flash_v2_5"], voices: { elevenlabs: realtime.voice } } : undefined;
    const speech: BrainHooks["synthesize"] = tts && choice ? async (text, signal, settled) => {
      const { keyScope, subject, bucket } = options();
      const made = await speechRequest(tts, held.tenant, {
        text, voice: provider.id === "openai" ? realtime.voice : DEFAULT_VOICE, format: "pcm", ...(keyScope ? { keyScope } : {}),
        ...(choice.providers ? { choice } : {}), identity: identity(), actor: `voice:${held.id}`,
        ...(subject !== undefined && this.options.credit ? { hold: (usd: number) => this.options.credit!.hold(held.tenant, subject, bucket ?? DEFAULT_BUCKET, usd, "voice_say", { session: held.id }) } : {}),
        settled: ({ costUsd }) => {
          settled(costUsd);
          if (costUsd > 0) void write("update voice_sessions set cost = cost + $2, updated_at = $3 where id = $1 returning *", [Math.round(costUsd * 1_000_000), Date.now()]);
        },
      }, signal);
      return made.body as unknown as AsyncIterable<Uint8Array>;
    } : undefined;
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
          const body = {
            id, method: "prompt",
            params: {
              text: `[A request from your voice in a live voice call${name ? `, asked by ${name}` : ""}. Do what it needs with your tools first; then answer in one to three plain spoken sentences (no markdown, lists, links or emoji), since your reply is read aloud]\n${request}`,
              ...(speaker ? { from: { id: speaker, ...(name ? { name } : {}) } } : {}), metadata: { voiceSession: held.id, via: "realtime" }, allowDisconnected: true,
            },
          };
          let text = "";
          try {
            for await (const piece of submit(agent!, held.tenant, body, signal)) text += piece;
          } catch (error) {
            // The agent's host stopped under the request (its node retiring or handing it off, as in a rollout): asked
            // once more, by the same id, it reaches the agent's next owner, which runs it (or answers it, if it ran).
            if (text || signal.aborted || !agentMoved(error)) throw error;
            log("voice_realtime_ask_agent_retry", { error: safeError(error) });
            await clock().sleep(this.options.askAgentRetryMs ?? ASK_AGENT_RETRY_MS, { signal });
            for await (const piece of submit(agent!, held.tenant, body, signal)) text += piece;
          }
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
        void write(`update voice_sessions set last_speech_at = greatest(coalesce(last_speech_at, 0), $2)${realtime.transcribe ? "" : ", utterances = utterances + 1"}, updated_at = $3 where id = $1 returning *`, [Math.round(endedAt), Date.now()]);
      },
      heard: heard => {
        const { keyScope } = options();
        if (heard.seconds > 0) this.options.record(held.tenant, {
          provider: provider.id, model: provider.ownsTurns ? realtime.model : REALTIME_TRANSCRIPTION.model, kind: "transcription", platform: credentials.platform, transcriptions: 1, audioSeconds: Math.ceil(heard.seconds),
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
          void write("select * from voice_sessions where id = $1", [], { type: "voice.speech.started", key: `voice:${held.id}:voice.speech.started:${spoke.id}`, data: () => ({ speechId: spoke.id, latencyMs: spoke.latencyMs, startedAt, ...answers, ...(spoke.say ? { source: "say" } : {}) }) });
          return;
        }
        held.media?.notify?.({ type: "speech", state: "ended", speechId: spoke.id, reason: spoke.reason, ...(spoke.by ? { by: spoke.by } : {}), seconds: spoke.seconds });
        // Its cost is the session's already (usage): the speech is counted here.
        void write("update voice_sessions set speeches = speeches + 1, spoken_seconds = spoken_seconds + $2, updated_at = $3 where id = $1 returning *", [spoke.seconds, Date.now()], {
          type: "voice.speech.ended", key: `voice:${held.id}:voice.speech.ended:${spoke.id}`,
          data: () => ({ speechId: spoke.id, reason: spoke.reason, ...(spoke.by ? { by: spoke.by } : {}), seconds: spoke.seconds, costUsd: spoke.costUsd, ...(spoke.say ? { source: "say" } : {}) }),
        });
      },
      failed: (detail, error) => {
        void this.finish(this.held.get(held.id) === held ? held : undefined, held.id, { reason: "error", detail, ...(error ? { error } : {}) })
          .catch(error => console.error(JSON.stringify({ type: "voice_finish_failed", session: held.id, error: safeError(error) })));
      },
      ...(speech ? { synthesize: speech } : {}),
      // Music the bot plays holds while it speaks.
      speaking: on => held.jukebox?.duck(on),
      log,
    };
    const policy = interruption(options());
    return new RealtimeBrain({
      session: held.id, tenant: held.tenant, reference: `${provider.id}/${realtime.model}`, floor: held.floor, transcribed: realtime.transcribe,
      ...(provider.wordsAfterAnswer ? { wordsAfterAnswer: true } : {}),
      ...(provider.ownsTurns ? { ownsTurns: true } : {}),
      speculative: !provider.ownsTurns && realtime.speculative && options().endOfTurn?.mode === "smart" && !!this.options.turnModels,
      ...(options().bargeIn !== false ? { bargeIn: policy } : {}),
    }, hooks);
  }

  /** An event about a session, for the tenant's webhook endpoints. */
  protected event(row: Row, type: "voice.session.started" | "voice.session.ended" | "voice.session.error" | "voice.utterance" | "voice.speech.started" | "voice.speech.ended" | "voice.recording.ended" | "voice.audio.started" | "voice.audio.ended", data: Record<string, unknown>, key: string): WebhookEvent {
    const { options } = row;
    return webhookEvent(type, row.tenant, {
      session: row.id, provider: row.provider, guildId: row.guild, channelId: row.channel, botUserId: row.bot_user,
      ...data, subject: options.subject ?? null, metadata: options.metadata,
    }, key);
  }

  /** Ended sessions and expired recordings past their retention, deleted at most once an hour. */
  private async prune(now: number) {
    if (now - this.prunedAt < PRUNE_EVERY_MS) return;
    this.prunedAt = now;
    await this.db.query("delete from voice_sessions where state = 'ended' and ended_at < $1", [now - VOICE_LIMITS.retentionDays * 86_400_000]);
    // Recordings past their retention: their files, then their rows.
    const { rows: expired } = await this.db.query("select id, tenant from voice_recordings where expires_at < $1 order by expires_at limit 1000", [now]);
    for (const { id, tenant } of expired as { id: string; tenant: string }[]) {
      await this.options.storage?.removeBlobs(recordingPrefix(tenant, id));
      await this.db.query("delete from voice_recordings where id = $1", [id]);
    }
  }
}

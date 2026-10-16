import { randomBytes } from "node:crypto";
import type { Accounts, Sealed } from "./accounts.ts";
import { transaction, type Db, type Sql } from "./db.ts";
import { HttpError } from "./http.ts";
import { identityInput } from "./identity.ts";
import { safeError } from "./metrics.ts";
import { underClaim, type Claim, type Ownership } from "./ownership.ts";
import { checkedAudio, languageInput, type Transcribed, type Transcriber } from "./transcription.ts";
import { enqueueEvents, webhookEvent, type WebhookEvent } from "./webhooks.ts";
import type { UsageRecord } from "./client-sessions.ts";
import { oggOpus, Segmenter, type Cut } from "./voice-audio.ts";
import { SessionSpeech, SPEECH_QUEUE, speechId, type Player, type SpeechEnding, type SpeechItem } from "./voice-speech.ts";
import { DEFAULT_VOICE, SPEECH_LIMITS, type Synthesizer } from "./speech.ts";
import { bucketInput, DEFAULT_BUCKET } from "./end-user-credits.ts";

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
  /** One Opus packet of `speaker`'s audio, as it arrived. */
  packet(speaker: string, packet: Uint8Array): void;
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
  /** Play speech (20 ms Opus packets at 48 kHz stereo); a transport that cannot speak has none. */
  play?: Player["play"];
  close(): void;
}
/** A voice service's connections (src/voice-discord.ts). */
export interface VoiceTransport {
  connect(credentials: VoiceCredentials, handlers: VoiceHandlers): VoiceConnection;
  /** Whether its connections can play speech (`play`). */
  speaks?: boolean;
}

export const VOICE_PROVIDERS = ["discord"] as const;
export type VoiceState = "connecting" | "live" | "reconnecting" | "ended";
export const END_REASONS = ["requested", "empty", "idle", "max_duration", "budget", "kicked", "credentials", "error"] as const;
export type EndReason = typeof END_REASONS[number];
/** Why a session ended, with what the reason needs: which limit for `budget`, a short detail for `error`. */
export type Ending = { reason: EndReason; limit?: "tenant" | "end_user"; endUserReason?: string; detail?: string };

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
  /** With speak: a person starting to talk stops the bot's speech. */
  bargeIn: boolean;
  /** With speak: the voice its speech is made in, unless a speech asks for another. */
  voice: string;
};

export const VOICE_LIMITS = Object.freeze({
  silenceMs: { default: 800, min: 200, max: 5_000 },
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
  /** Ended sessions are listed this long, then deleted. */
  retentionDays: 30,
});
const DEFAULT_NOTICE = "<@{bot}> is listening and transcribing speech in this channel. Audio is not stored.";
const SPEAKING_NOTICE = "<@{bot}> is listening, transcribing speech and may speak in this channel. Audio is not stored.";
const VOICE_NAME = /^[a-z][a-z0-9_-]{1,31}$/;
/** The voice notifications' channel: a session's id, changed on some node. */
export const VOICE_CHANNEL = "voice_sessions";
const PRUNE_EVERY_MS = 60 * 60_000;

const SNOWFLAKE = /^\d{1,20}$/;
const ID = /^vs_[a-f0-9]{24}$/;
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
    utterances: row.utterances, speechSeconds: row.speech_seconds, speeches: row.speeches ?? 0, spokenSeconds: Number(row.spoken_seconds ?? 0),
    costUsd: Number(row.cost) / 1_000_000,
    createdAt: num(row.created_at)!, startedAt: num(row.started_at), lastSpeechAt: num(row.last_speech_at), endedAt: num(row.ended_at),
  };
}
export type SessionView = ReturnType<typeof sessionView>;

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
  /** Whether the tenant has a key to transcribe with (in a key scope): checked before a session starts. */
  canTranscribe(tenant: string, keyScope: string | undefined): Promise<boolean>;
  /** Records a transcription's usage, as a model response's is (billing, usage.recorded). */
  record(tenant: string, usage: UsageRecord): void;
  /** Submit a request to an agent wherever it is served (an utterance's prompt). */
  submit(agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }): Promise<unknown>;
  transcriptionsPerNode?: number;
  /** End users' credit; without it, sessions are billed to the tenant alone. */
  credit?: VoiceCredit;
  /** Live sessions per tenant (VOICE_LIMITS.perTenant). */
  perTenant?: (tenant: string) => number;
  perNode?: number;
  reconnectGraceMs?: number;
  /** What a voice server's host must match: Discord's (*.discord.media) unless a test serves its own. */
  endpoints?: RegExp;
}

/** A session this node holds: its claim, its connection, and what its limits are measured from. */
type Held = {
  id: string; tenant: string; claim: Claim; revision: number; row: Row;
  credentials: VoiceCredentials; connection?: VoiceConnection;
  /** Since when the call has had no one else in it. */
  emptySince?: number;
  /** The connection lost its credentials (`lost`): when, and why, until new ones come. */
  lost?: { at: number; reason: "kicked" | "credentials" | "error"; detail?: string };
  ending?: boolean;
  segmenter: Segmenter;
  /** What the bot was asked to say, for a session that speaks. */
  speech?: SessionSpeech;
};
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
  private settings(input: Record<string, unknown>): VoiceOptions {
    const deliverGiven = input.deliver === undefined ? {} : object(input.deliver, "deliver");
    only(deliverGiven, "deliver", ["agent", "webhooks"]);
    const agent = deliverGiven.agent === undefined ? undefined : text(deliverGiven.agent, "deliver.agent", /^client_[a-f0-9]{40}$/, "an agent id");
    if (deliverGiven.webhooks !== undefined && typeof deliverGiven.webhooks !== "boolean") throw new HttpError(400, "deliver.webhooks must be true or false");
    const webhooks = deliverGiven.webhooks !== false;
    if (!agent && !webhooks) throw new HttpError(400, "deliver must send utterances somewhere: an agent, webhooks, or both");
    const identity = identityInput({ subject: input.subject, context: input.context });
    const bucket = input.bucket === undefined ? undefined : bucketInput(input.bucket);
    const keyScope = input.keyScope === undefined ? undefined : text(input.keyScope, "keyScope", /^.{1,100}$/s, "a key scope's name");
    const language = languageInput(input.language);
    const prompt = input.prompt === undefined ? undefined : text(input.prompt, "prompt", new RegExp(`^[\\s\\S]{1,${VOICE_LIMITS.promptChars}}$`), `at most ${VOICE_LIMITS.promptChars} characters`);
    if (input.speak !== undefined && typeof input.speak !== "boolean") throw new HttpError(400, "speak must be true or false");
    if (input.bargeIn !== undefined && typeof input.bargeIn !== "boolean") throw new HttpError(400, "bargeIn must be true or false");
    const speak = input.speak === true;
    if (!speak && (input.voice !== undefined || input.bargeIn !== undefined)) throw new HttpError(400, "voice and bargeIn are for a session that speaks (speak: true)");
    const voice = input.voice === undefined ? DEFAULT_VOICE : text(input.voice, "voice", VOICE_NAME, "a voice's name, such as alloy, coral or verse");
    const notice = input.notice === undefined ? speak ? SPEAKING_NOTICE : DEFAULT_NOTICE : text(input.notice, "notice", new RegExp(`^[\\s\\S]{1,${VOICE_LIMITS.noticeChars}}$`), `at most ${VOICE_LIMITS.noticeChars} characters`);
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
      speak, bargeIn: input.bargeIn !== false, voice,
    };
  }

  /**
   * Start a session from the credentials the app forwarded: stored (the grant sealed), then taken and connected here
   * when this node can, else by a peer's scan. Answers the session with the notice the app must post.
   */
  async create(tenant: string, input: Record<string, unknown>) {
    only(input, "body", ["provider", "discord", "subject", "bucket", "context", "keyScope", "deliver", "language", "prompt", "silenceMs", "maxMinutes", "idleMinutes", "emptySeconds", "ignoreUserIds", "metadata", "notice", "speak", "bargeIn", "voice"]);
    const provider = input.provider ?? "discord";
    if (provider !== "discord") throw new HttpError(400, `provider must be one of: ${VOICE_PROVIDERS.join(", ")}`);
    if (!this.options.transports[provider]) throw new HttpError(404, "Voice sessions are not enabled on this runtime");
    if (!this.options.accounts.canStoreKeys) throw new HttpError(503, "This runtime has no AGENT_SECRETS_KEY, so it cannot hold voice credentials");
    if (input.discord === undefined) throw new HttpError(400, "discord is required: guildId, channelId, userId, sessionId, endpoint and token");
    const credentials = discordInput(input.discord, this.endpoints()) as VoiceCredentials;
    const options = this.settings(input);
    if (options.speak && (!this.options.synthesizer || !this.options.transports[provider]?.speaks)) throw new HttpError(404, "Speaking is not enabled on this runtime");
    if (options.deliver.agent && !await this.options.agentOwned(options.deliver.agent, tenant)) throw new HttpError(404, "Unknown agent in deliver.agent");
    await this.options.admit(tenant);
    const refused = options.subject !== undefined ? await this.options.credit?.refusal(tenant, options.subject, options.bucket ?? DEFAULT_BUCKET) : undefined;
    if (refused) throw new HttpError(402, refused.message, "END_USER_CREDIT", { endUser: options.subject, bucket: options.bucket ?? DEFAULT_BUCKET, reason: refused.reason });
    if (!await this.options.canTranscribe(tenant, options.keyScope)) {
      throw new HttpError(400, `Voice sessions transcribe with an OpenAI key: add one under Models & keys (PUT /v1/providers/openai/key)${options.keyScope ? `, or to key scope ${options.keyScope}` : ""}`, "TRANSCRIPTION_UNAVAILABLE");
    }
    const id = `vs_${randomBytes(12).toString("hex")}`;
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
    };
  }

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
    only(input, "body", ["discord", "ignoreUserIds", "metadata"]);
    const changes = input.discord === undefined ? {} : discordInput(input.discord, this.endpoints(), true);
    const ignore = input.ignoreUserIds === undefined ? undefined : ignored(input.ignoreUserIds);
    const metadata = input.metadata === undefined ? undefined : metadataInput(input.metadata);
    const row = await transaction(this.db, async sql => {
      const current = await this.row(tenant, id, sql);
      const locked = (await sql.query("select * from voice_sessions where id = $1 for update", [current.id])).rows[0] as Row;
      if (locked.state === "ended") throw new HttpError(409, `This voice session ended (${locked.end_reason}); start a new one`, "VOICE_SESSION_ENDED");
      const secret: Secret = JSON.parse(this.options.accounts.unseal(aad(id), locked.sealed!));
      const next: Secret = { sessionId: changes.sessionId ?? secret.sessionId, endpoint: changes.endpoint === undefined ? secret.endpoint : changes.endpoint, token: changes.token ?? secret.token };
      const options = { ...locked.options, ...(ignore ? { ignoreUserIds: ignore } : {}), ...(metadata ? { metadata } : {}) };
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
    only(input, "body", ["text", "voice", "instructions", "interrupt"]);
    const textGiven = text(input.text, "text", new RegExp(`^[\\s\\S]{1,${SPEECH_LIMITS.textChars}}$`), `1 to ${SPEECH_LIMITS.textChars} characters`);
    if (!textGiven.trim()) throw new HttpError(400, "text must say something");
    const voice = input.voice === undefined ? undefined : text(input.voice, "voice", VOICE_NAME, "a voice's name, such as alloy, coral or verse");
    const instructions = input.instructions === undefined ? undefined : text(input.instructions, "instructions", new RegExp(`^[\\s\\S]{1,${SPEECH_LIMITS.instructionsChars}}$`), `at most ${SPEECH_LIMITS.instructionsChars} characters`);
    if (input.interrupt !== undefined && typeof input.interrupt !== "boolean") throw new HttpError(400, "interrupt must be true or false");
    const row = await this.row(tenant, id);
    if (row.state === "ended") throw new HttpError(409, `This voice session ended (${row.end_reason})`, "VOICE_SESSION_ENDED");
    if (!row.options.speak) throw new HttpError(409, "This voice session does not speak: start one with speak: true", "VOICE_SPEAK_DISABLED");
    const held = this.held.get(id);
    if (!held?.speech) throw new HttpError(503, "This voice session is moving between nodes; retry");
    if (held.speech.waiting >= SPEECH_QUEUE.max && !input.interrupt) throw new HttpError(429, `This voice session has ${SPEECH_QUEUE.max} speeches waiting; interrupt or wait`, "VOICE_SPEECH_QUEUE_FULL");
    const item: SpeechItem = { id: speechId(), text: textGiven, voice: voice ?? row.options.voice, ...(instructions ? { instructions } : {}), queuedAt: Date.now() };
    const position = held.speech.say(item, input.interrupt === true);
    console.log(JSON.stringify({ type: "voice_speech_queued", session: id, speech: item.id, chars: item.text.length, position, node: this.options.node }));
    return { speechId: item.id, session: id, state: "queued" as const, position, voice: item.voice, characters: item.text.length };
  }

  /** Stop what the bot is saying, and what it was going to: answers how many speeches that stopped. */
  async stopSpeaking(tenant: string, id: string) {
    const row = await this.row(tenant, id);
    if (!row.options.speak) throw new HttpError(409, "This voice session does not speak", "VOICE_SPEAK_DISABLED");
    if (row.state === "ended") return { stopped: 0 };
    const held = this.held.get(id);
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
      segmenter: new Segmenter({
        silenceMs: current.options.silenceMs, cut: cut => this.cut(held, cut),
        // Barge-in: a person starting to talk stops the bot.
        speech: () => { if (held.row.options.bargeIn && held.speech?.speaking) held.speech.stop("barge_in"); },
      }),
    };
    if (current.options.speak && this.options.synthesizer) held.speech = new SessionSpeech(this.options.synthesizer, this.speechEffects(held));
    this.held.set(held.id, held);
    console.log(JSON.stringify({ type: "voice_session_acquired", session: held.id, node: this.options.node, epoch: taken.claim.epoch }));
    if (current.state === "live") await this.setState(held, "reconnecting").catch(() => {});
    this.connect(held, transport);
  }

  private credentials(row: Row): VoiceCredentials {
    const secret: Secret = JSON.parse(this.options.accounts.unseal(aad(row.id), row.sealed!));
    return { guildId: row.guild, channelId: row.channel, userId: row.bot_user, ...secret };
  }

  private connect(held: Held, transport: VoiceTransport) {
    if (held.credentials.endpoint === null) return;
    const current = () => this.held.get(held.id) === held;
    const log = (type: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ type, session: held.id, node: this.options.node, epoch: held.claim.epoch, ...fields }));
    held.connection = transport.connect(held.credentials, {
      ready: () => {
        if (!current()) return;
        held.lost = undefined;
        log("voice_session_ready");
        void this.ready(held).catch(error => console.error(JSON.stringify({ type: "voice_ready_failed", session: held.id, error: safeError(error) })));
      },
      packet: (speaker, packet) => { if (current()) this.packet(held, speaker, packet); },
      broken: speaker => { if (current()) this.broken(held, speaker); },
      lost: (reason, detail) => {
        if (!current()) return;
        log("voice_session_lost", { reason, ...(detail ? { detail } : {}) });
        held.lost = { at: Date.now(), reason, ...(detail ? { detail } : {}) };
        held.connection?.close();
        held.connection = undefined;
        void this.setState(held, "reconnecting").catch(() => {});
      },
      diagnostic: (event, fields) => log(`voice_${event}`, fields),
    });
  }

  /** Apply a row changed elsewhere: new credentials reconnect, other changes are read as they are. */
  private apply(held: Held, row: Row) {
    held.revision = row.revision;
    held.row = row;
    if (row.state === "ended") { void this.drop(held, true, "end"); return; }
    const credentials = this.credentials(row);
    const moved = JSON.stringify(credentials) !== JSON.stringify(held.credentials);
    held.credentials = credentials;
    if (!moved) return;
    held.lost = undefined;
    if (held.connection && credentials.endpoint !== null) held.connection.update(credentials);
    else {
      held.connection?.close();
      held.connection = undefined;
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
    held.segmenter.flush(cut);
    held.speech?.close(cut);
    console.log(JSON.stringify({ type: "voice_session_released", session: held.id, node: this.options.node, epoch: held.claim.epoch, release }));
    held.connection?.close();
    held.connection = undefined;
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

  /** Audio from a speaker: what utterances are made of. The bot's own, and ignored users', is not listened to. */
  private packet(held: Held, speaker: string, packet: Uint8Array) {
    if (speaker === held.credentials.userId || held.row.options.ignoreUserIds.includes(speaker)) return;
    held.segmenter.packet(speaker, packet);
  }
  private broken(held: Held, speaker: string) { held.segmenter.broken(speaker); }

  /** An utterance was cut: transcribed and delivered after the speaker's previous one. */
  private cut(held: Held, cut: Cut) {
    const origin: Origin = { id: held.id, tenant: held.tenant, claim: held.claim, row: held.row };
    const key = `${held.id}:${cut.speaker}`;
    const job = (this.speakers.get(key) ?? Promise.resolve()).then(() => this.utterance(origin, cut)).catch(error =>
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
  private async utterance(origin: Origin, cut: Cut) {
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
          ? await credit.hold(origin.tenant, options.subject, options.bucket ?? DEFAULT_BUCKET, this.options.transcriber.cost(cut.seconds), "voice", { session: origin.id })
          : undefined;
      } catch (error) {
        if ((error as HttpError).code !== "END_USER_CREDIT") throw error;
        const reason = (error as HttpError).details?.reason;
        await this.endFor(origin, { reason: "budget", limit: "end_user", ...(typeof reason === "string" ? { endUserReason: reason } : {}) });
        return;
      }
      const bytes = oggOpus(cut.packets);
      try {
        await this.options.ownership?.whenFresh();
        done = await this.options.transcriber.transcribe({ tenant: origin.tenant, ...(options.keyScope ? { keyScope: options.keyScope } : {}) }, { bytes, header: checkedAudio(bytes) },
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
        where id = $1 returning *`, [origin.id, transcript.seconds, Math.round(usd * 1_000_000), cut.endedAt, Date.now()]);
      const current = rows[0] as Row | undefined;
      if (current && transcript.text && current.options.deliver.webhooks) {
        await enqueueEvents(sql, [this.event(current, "voice.utterance", {
          speakerId: cut.speaker, seq: current.utterances, text: transcript.text, language: transcript.language ?? options.language ?? null,
          seconds: cut.seconds, startedAt: cut.startedAt, endedAt: cut.endedAt, ended: cut.ended, costUsd: usd,
        }, `voice:${origin.id}:utterance:${current.utterances}`)]);
      }
      return current;
    });
    console.log(JSON.stringify({ type: "voice_utterance", session: origin.id, seq: row?.utterances, seconds: cut.seconds, billedSeconds: transcript.seconds, ended: cut.ended, empty: !transcript.text, ms: Date.now() - started }));
    if (!row) return;
    const local = this.held.get(origin.id);
    if (local) local.row = { ...local.row, last_speech_at: row.last_speech_at, utterances: row.utterances };
    const agent = row.options.deliver.agent;
    if (!agent || !transcript.text) return;
    const request = {
      id: `voice_${origin.id.slice(3)}_${row.utterances}`, method: "prompt",
      params: { text: transcript.text, from: { id: cut.speaker }, metadata: { voiceSession: origin.id, utterance: String(row.utterances) }, allowDisconnected: true },
    };
    for (let attempt = 1; ; attempt++) {
      try { await this.options.submit(agent, origin.tenant, request); return; }
      catch (error) {
        const status = (error as HttpError).status;
        // A deleted agent takes nothing more; anything else (its node moving, a queue full) may take it soon.
        if (status === 404 || status === 410 || attempt >= VOICE_LIMITS.submitAttempts) {
          console.error(JSON.stringify({ type: "voice_delivery_failed", session: origin.id, seq: row.utterances, status, error: safeError(error) }));
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
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
    const others = held.connection?.others()?.filter(user => user !== held.credentials.userId && !options.ignoreUserIds.includes(user));
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
        reason: ending.reason, ...(ending.limit ? { limit: ending.limit } : {}), ...(ending.endUserReason ? { endUserReason: ending.endUserReason } : {}),
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

  /** An event about a session, for the tenant's webhook endpoints. */
  /** What a held session's speech needs: its connection, money checks, events and usage (voice-speech.ts). */
  private speechEffects(held: Held) {
    const synthesizer = this.options.synthesizer!;
    const options = () => held.row.options;
    const write = (type: "voice.speech.started" | "voice.speech.ended", item: SpeechItem, data: Record<string, unknown>, counts?: { seconds: number; costUsd: number }) =>
      transaction(this.db, async sql => {
        const { rows } = counts
          ? await sql.query("update voice_sessions set speeches = speeches + 1, spoken_seconds = spoken_seconds + $2, cost = cost + $3, updated_at = $4 where id = $1 returning *", [held.id, counts.seconds, Math.round(counts.costUsd * 1_000_000), Date.now()])
          : await sql.query("select * from voice_sessions where id = $1", [held.id]);
        const row = rows[0] as Row | undefined;
        if (row?.options.deliver.webhooks) await enqueueEvents(sql, [this.event(row, type, { speechId: item.id, ...data }, `voice:${held.id}:${type}:${item.id}`)]);
      }).catch(error => console.error(JSON.stringify({ type: "voice_speech_event_failed", session: held.id, speech: item.id, error: safeError(error) })));
    return {
      player: () => held.connection?.play ? held.connection as Player : undefined,
      admit: () => this.options.admit(held.tenant),
      hold: async (usd: number, speech: string) => {
        const { subject, bucket } = options();
        return subject !== undefined && this.options.credit ? this.options.credit.hold(held.tenant, subject, bucket ?? DEFAULT_BUCKET, usd, "voice_speech", { session: held.id, speech }) : undefined;
      },
      fresh: async () => { await this.options.ownership?.whenFresh(); },
      credentials: () => synthesizer.credentials(held.tenant, options().keyScope),
      started: (item: SpeechItem, latencyMs: number) => {
        console.log(JSON.stringify({ type: "voice_speech_started", session: held.id, speech: item.id, latencyMs }));
        void write("voice.speech.started", item, { latencyMs });
      },
      ended: (item: SpeechItem, ending: SpeechEnding, platform: boolean | undefined) => {
        const { subject, context, keyScope } = options();
        console.log(JSON.stringify({ type: "voice_speech_ended", session: held.id, speech: item.id, reason: ending.reason, ...(ending.by ? { by: ending.by } : {}), seconds: ending.seconds, ...(ending.error ? { error: ending.error } : {}) }));
        if (ending.seconds > 0) {
          this.options.record(held.tenant, {
            provider: synthesizer.provider, model: synthesizer.model, usage: { cost: { total: ending.costUsd } }, platform: !!platform, kind: "speech",
            speeches: 1, audioSeconds: ending.seconds, timestamp: Date.now(),
            identity: { ...(subject !== undefined ? { subject } : {}), context: { ...context, voiceSession: held.id } }, ...(keyScope ? { keyScope } : {}),
          });
        }
        void write("voice.speech.ended", item, {
          reason: ending.reason, ...(ending.by ? { by: ending.by } : {}), seconds: ending.seconds, costUsd: ending.costUsd,
        }, ending.seconds > 0 ? ending : undefined);
      },
      budget: (limit: "tenant" | "end_user", endUserReason?: string) => {
        void this.finish(this.held.get(held.id) === held ? held : undefined, held.id, { reason: "budget", limit, ...(endUserReason ? { endUserReason } : {}) })
          .catch(error => console.error(JSON.stringify({ type: "voice_finish_failed", session: held.id, error: safeError(error) })));
      },
    };
  }

  protected event(row: Row, type: "voice.session.started" | "voice.session.ended" | "voice.utterance" | "voice.speech.started" | "voice.speech.ended", data: Record<string, unknown>, key: string): WebhookEvent {
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

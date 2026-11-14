import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { VoiceCall, VoiceCallCreated, VoiceCallInput, VoiceCallUpdate, VoiceTranscriptInput } from "./api-schemas.ts";
import type { UsageRecord } from "./client-sessions/state.ts";
import { transaction, type Db, type Sql } from "./db.ts";
import { bucketInput, DEFAULT_BUCKET } from "./end-user-credits.ts";
import { HttpError, parseJson } from "./http.ts";
import { identityInput } from "./identity.ts";
import { DEFAULT_VOICE } from "./speech.ts";
import { VOICE_LIMITS, type VoiceCredit } from "./voice-sessions.ts";
import { redactDetail } from "./voice-providers/socket.ts";
import { ASK_LIMITS, askAgent, TRANSCRIPT_CHARS, TRANSCRIPT_LINES } from "./voice/calls/bridge.ts";
import { ELEVENLABS_BUCKETS_MINUTES, terminationReasonToEnd, type ElevenLabsCalls } from "./voice/calls/elevenlabs.ts";
import type { OpenAICalls, Sideband, SidebandEvents } from "./voice/calls/openai.ts";
import { ASK_AGENT, ASK_FAILED, EMPTY_REPLY, EMPTY_REQUEST, lateFailure, lateReply, LATE_FAILURE, LATE_REPLY, PENDING, realtimeInstructions, STAY_SILENT } from "./voice/calls/prompts.ts";
import { NO_USAGE, realtimeCost, realtimePrice, realtimeVoice, type RealtimeUsage } from "./voice/realtime/provider.ts";
import { webhookEvent, type EventType, type WebhookEvent } from "./webhooks.ts";

export type VoiceCallOptions = {
  subject: string; bucket?: string; context?: Record<string, unknown>; keyScope?: string; metadata?: Record<string, unknown>;
  elevenlabsAgent?: string; transcript?: string[]; deadlineSettled?: boolean;
  speakers: Record<string, string>; maxMinutes: number; language?: string; instructions?: string;
};
export type VoiceCallsOptions = {
  db: Db; node: string;
  admit(tenant: string): Promise<void>;
  agentOwned(agent: string, tenant: string): Promise<boolean>;
  record(tenant: string, usage: UsageRecord): void;
  recordIn?(sql: Sql, tenant: string, usage: UsageRecord): Promise<void>;
  usageCommitted?(tenant: string): Promise<void>;
  submitStreaming(agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }, signal: AbortSignal): AsyncIterable<string>;
  credit?: VoiceCredit;
  creditEnabled?(tenant: string): Promise<boolean>;
  providers: { openai?: OpenAICalls; elevenlabs?: ElevenLabsCalls };
  key(tenant: string, keyScope: string | undefined, provider: string): Promise<{ apiKey: string; platform: boolean } | undefined>;
  perTenant(tenant: string): Promise<number>;
  liveSessions(tenant: string, sql?: Sql): Promise<number>;
  enqueue(events: WebhookEvent[], sql?: Sql): Promise<void>;
  kickWebhooks(): void;
  publicUrl: string;
  retiring?(): boolean;
  now?: () => number; sweepMs?: number; pendingMs?: number; lateMs?: number;
};

type Row = {
  id: string; tenant: string; agent: string; provider: VoiceCall["provider"]; model: string; voice: string;
  state: VoiceCall["state"]; end_reason: string | null; provider_call: string | null; options: VoiceCallOptions;
  hold: CallHold | null;
  turns: number; asks: number; audio_seconds: string; cost: number;
  started_at: Date | null; ended_at: Date | null;
  // The call's fixed end (start + maxMinutes). The sweeper renews the separate expiry in end_user_holds.
  expires_at: Date;
};
type CallHold = { id: string; endUser: string; bucket: string; usd: number; heldAt: number };
type Ending = { reason: string; detail?: string; limit?: "end_user"; endUserReason?: string; bucket?: string };
type Hold = Awaited<ReturnType<VoiceCredit["hold"]>>;
type ToolCall = Parameters<SidebandEvents["toolCall"]>[0];
type Live = {
  sideband: Sideband; platform: boolean; credit?: VoiceCredit; abort: AbortController;
  holds: Map<string, Promise<Hold>>; done: Set<string>; tools: Set<string>; heard: Set<string>;
  lines: string[]; seq: number; usage: Set<Promise<void>>;
};

// The per-response realtime credit hold in voice/realtime/brain.ts:56.
const HOLD_USD = 0.05;
const POST_CALL_GRACE_MS = 15 * 60_000;
let deadlineSettles = 0;

function equalSecret(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function view(row: Row): VoiceCall {
  const { id, state, provider, model, voice, agent, turns, asks, options } = row;
  return {
    id, state, provider, model, voice, agent, subject: options.subject, startedAt: row.started_at?.getTime() ?? null,
    endedAt: row.ended_at?.getTime() ?? null, expiresAt: row.expires_at.getTime(), maxMinutes: options.maxMinutes, reason: row.end_reason,
    turns, asks, audioSeconds: Number(row.audio_seconds), costUsd: Number(row.cost) / 1_000_000,
    metadata: options.metadata ?? {}, speakers: options.speakers,
  };
}

const detailOf = (error: unknown, key?: string) => redactDetail(error instanceof Error ? error.message : String(error), 300, key ? [key] : []);

export class VoiceCalls {
  private readonly live = new Map<string, Live>();
  private readonly creating = new Set<Promise<VoiceCallCreated>>();
  private readonly ending = new Map<string, Promise<VoiceCall>>();
  private timer?: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;
  private closing = false;
  private stopping?: Promise<void>;

  private readonly options: VoiceCallsOptions;

  constructor(options: VoiceCallsOptions) { this.options = options; }

  get size(): number { return this.live.size; }

  stats() { return { deadlineSettles }; }

  private now() { return this.options.now?.() ?? Date.now(); }

  start(): void {
    if (this.timer || this.closing) return;
    const tick = () => this.background("voice_call_sweep_failed", undefined, this.sweep());
    this.timer = setInterval(tick, this.options.sweepMs ?? 60_000);
    this.timer.unref();
    tick();
  }

  private checkRetiring() {
    if (this.closing || this.options.retiring?.()) throw new HttpError(503, "This node is retiring; retry", "NODE_RETIRING");
  }

  async create(tenant: string, input: VoiceCallInput): Promise<VoiceCallCreated> {
    this.checkRetiring();
    const creating = this.connect(tenant, input);
    this.creating.add(creating);
    try { return await creating; } finally { this.creating.delete(creating); }
  }

  private async connect(tenant: string, input: VoiceCallInput): Promise<VoiceCallCreated> {
    const { agent, provider: name, sdp, voice: requestedVoice, model: requestedModel, ...given } = input;
    if (!await this.options.agentOwned(agent, tenant)) throw new HttpError(404, "Unknown agent", "AGENT_NOT_FOUND");
    const provider = this.options.providers[name];
    if (!provider) throw new HttpError(400, `${name} calls are not available on this runtime`, "REALTIME_UNAVAILABLE");
    const model = requestedModel ?? provider.defaultModel;
    const validModel = name === "elevenlabs" ? /^[a-zA-Z0-9._-]{1,100}$/.test(model) : provider.models.includes(model);
    if (!validModel) throw new HttpError(400, name === "elevenlabs" ? "Invalid ElevenLabs realtime model" : `Unknown OpenAI realtime model: ${model}`, "REALTIME_MODEL");
    if (name === "elevenlabs" && requestedVoice !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(requestedVoice)) {
      throw new HttpError(400, "Invalid ElevenLabs voice ID", "REALTIME_VOICE");
    }
    const voice = realtimeVoice(provider, requestedVoice ?? DEFAULT_VOICE);
    if (name === "openai" && !realtimePrice(`openai/${model}`)) throw new HttpError(400, `No realtime price for openai/${model}`, "REALTIME_UNPRICED");
    identityInput(given);
    const options: VoiceCallOptions = {
      ...given, speakers: given.speakers ?? {},
      maxMinutes: name === "elevenlabs" ? Math.min(given.maxMinutes ?? 30, 30) : given.maxMinutes ?? VOICE_LIMITS.maxMinutes.default,
      ...(given.bucket !== undefined ? { bucket: bucketInput(given.bucket) } : {}),
    };
    const key = await this.options.key(tenant, options.keyScope, name);
    // v1 limitation: the post-call webhook and secret belong to an ElevenLabs workspace.
    // Tenant keys need their own webhook registration, which ElevenLabs supports by API.
    if (name === "elevenlabs" && key && !key.platform) {
      throw new HttpError(400, "ElevenLabs calls run on the platform's ElevenLabs key; your own key is not used for them yet", "REALTIME_UNAVAILABLE");
    }
    if (!key) throw new HttpError(400, name === "elevenlabs" ? "No platform ElevenLabs key for voice calls" :
      "No OpenAI key for voice calls: add one under Models & keys (PUT /v1/providers/openai/key)", "REALTIME_UNAVAILABLE");
    if (name === "openai" && !sdp) throw new HttpError(400, "sdp is required for OpenAI calls");
    await this.options.admit(tenant);
    const bucket = options.bucket ?? DEFAULT_BUCKET;
    const credit = !this.options.creditEnabled || await this.options.creditEnabled(tenant) ? this.options.credit : undefined;
    const refused = name === "openai" ? await credit?.refusal(tenant, options.subject, bucket) : undefined;
    if (refused) throw new HttpError(402, refused.message, "END_USER_CREDIT", { endUser: options.subject, bucket, reason: refused.reason });

    const id = `vc_${randomBytes(12).toString("hex")}`;
    await transaction(this.options.db, async sql => {
      // Share the existing session lock, so an in-flight Discord insert counts here.
      await sql.query("select pg_advisory_xact_lock(hashtext('voice-sessions:' || $1))", [tenant]);
      const limit = await this.options.perTenant(tenant);
      const sessions = await this.options.liveSessions(tenant, sql);
      const calls = (await sql.query("select count(*) as count from voice_calls where tenant = $1 and state <> 'ended'", [tenant])).rows[0].count;
      const live = sessions + Number(calls);
      if (live >= limit) throw new HttpError(429, `This account has ${live} live voice sessions, its limit: end one first`, "VOICE_SESSION_LIMIT", { limit });
      this.checkRetiring();
      const now = this.now();
      let hold: CallHold | undefined;
      if (name === "elevenlabs") {
        const price = realtimePrice(`elevenlabs/${model}`);
        if (!price || !("perMinute" in price)) throw new HttpError(400, `Realtime model elevenlabs/${model} has no price configured`, "REALTIME_UNPRICED");
        const cap = Math.min(given.maxMinutes ?? 30, 30);
        const candidates = ELEVENLABS_BUCKETS_MINUTES.filter(minutes => minutes <= cap).reverse();
        if (!candidates.length) throw new HttpError(400, "ElevenLabs calls require maxMinutes of at least 5");
        options.maxMinutes = candidates[0];
        if (credit) {
          if (!credit.settleHold || !credit.renew || !credit.release) throw new Error("Voice credit does not support durable holds");
          let refusal: HttpError | undefined;
          for (const minutes of candidates) {
            const usd = minutes * price.perMinute / 1_000_000;
            options.maxMinutes = minutes;
            try {
              const reservation = await credit.hold(tenant, options.subject, bucket, usd, "voice_elevenlabs", { session: id }, { now, sql, full: true });
              if (reservation) {
                if (!reservation.id) throw new Error("Voice credit returned no hold id");
                hold = { id: reservation.id, endUser: options.subject, bucket, usd, heldAt: now };
              }
              refusal = undefined;
              break;
            } catch (error) {
              if (!(error instanceof HttpError) || error.status !== 402) throw error;
              refusal = error;
            }
          }
          if (refusal) throw refusal;
        }
      }
      await sql.query(`insert into voice_calls (id, tenant, agent, provider, model, voice, state, options, expires_at, created_at, updated_at, hold)
        values ($1, $2, $3, $4, $5, $6, 'connecting', $7, $8, $9, $9, $10)`,
      [id, tenant, agent, name, model, voice, JSON.stringify(options), new Date(now + options.maxMinutes * 60_000), new Date(now), hold ?? null]);
    });

    if (name === "elevenlabs") return this.connectElevenLabs(id, this.options.providers.elevenlabs!, key.apiKey, model, voice, options);
    const openai = this.options.providers.openai!;
    // Events can arrive on open while the row is still being published.
    const ready = Promise.withResolvers<Live | undefined>();
    const afterLive = (type: string, work: (live: Live) => void | Promise<void>) => this.background(type, id, ready.promise.then(live => {
      if (live && !live.abort.signal.aborted) return work(live);
    }));
    let connected: Awaited<ReturnType<OpenAICalls["create"]>> | undefined;
    try {
      connected = await openai.create({
        sdp: sdp!, model, voice, instructions: realtimeInstructions(options.instructions ?? "", { agent: true, group: true }),
        language: options.language, tools: [ASK_AGENT, STAY_SILENT], apiKey: key.apiKey,
      }, {
        responseStarted: response => afterLive("voice_call_hold_failed", live => this.responseStarted(tenant, id, options, live, response)),
        responseDone: (response, outcome) => afterLive("voice_call_usage_failed", live => {
          const write = this.responseDone(tenant, id, model, options, live, response, outcome.usage);
          live.usage.add(write);
          return write.finally(() => { live.usage.delete(write); });
        }),
        heard: (item, text, seconds) => afterLive("voice_call_utterance_failed", live => this.heard(id, live, item, text, seconds)),
        said: () => {},
        toolCall: call => afterLive("voice_call_tool_failed", live => this.tool(id, live, call)),
        rateLimits: () => {},
        warning: (code, detail) => console.warn(JSON.stringify({ type: "voice_call_provider_warning", session: id, code, detail })),
        closed: (reason, detail) => afterLive("voice_call_finish_failed", async () => {
          if (reason === "error") await this.end(tenant, id, { reason, detail }, true);
        }),
      });
      const { callId, sdpAnswer, sideband } = connected;
      const row = await transaction(this.options.db, async sql => {
        const { rows } = await sql.query<Row>(`update voice_calls set state = 'live', node = $2, provider_call = $3, started_at = $4, updated_at = $4
          where id = $1 and state = 'connecting' returning *`, [id, this.options.node, callId, new Date(this.now())]);
        if (!rows[0]) throw new Error("The voice call ended while connecting");
        await this.enqueue(rows[0], "voice.session.started", {}, sql);
        return rows[0];
      });
      const live: Live = { sideband, platform: key.platform, credit, usage: new Set(), abort: new AbortController(), holds: new Map(), done: new Set(), tools: new Set(), heard: new Set(), lines: [], seq: 0 };
      this.live.set(id, live);
      ready.resolve(live);
      this.options.kickWebhooks();
      return { ...view(row), connect: { sdpAnswer } };
    } catch (error) {
      ready.resolve(undefined);
      const detail = detailOf(error, key.apiKey);
      if (connected) {
        connected.sideband.close();
        await openai.hangup(connected.callId, key.apiKey).catch(() => {});
      }
      await this.finish(id, { reason: "error", detail });
      throw new HttpError(502, detail, "REALTIME_FAILED");
    }
  }

  private async connectElevenLabs(id: string, provider: ElevenLabsCalls, apiKey: string, model: string, voice: string, options: VoiceCallOptions): Promise<VoiceCallCreated> {
    try {
      const { agentId } = await provider.provision({
        apiKey, model, voiceId: voice, language: options.language, maxMinutes: options.maxMinutes,
        instructions: realtimeInstructions(options.instructions, { agent: true, group: true }),
      });
      const connect = await provider.signedUrl({ apiKey, agentId });
      const row = await transaction(this.options.db, async sql => {
        const { rows } = await sql.query<Row>(`update voice_calls set state = 'live', provider_call = $2, started_at = $3, updated_at = $3,
          options = options || jsonb_build_object('elevenlabsAgent', $4::text)
          where id = $1 and state = 'connecting' returning *`, [id, connect.conversationId, new Date(this.now()), agentId]);
        if (!rows[0]) throw new Error("The voice call ended while connecting");
        await this.enqueue(rows[0], "voice.session.started", {}, sql);
        return rows[0];
      });
      this.options.kickWebhooks();
      return { ...view(row), connect };
    } catch (error) {
      const detail = detailOf(error, apiKey);
      const failed = await transaction(this.options.db, async sql => {
        const { rows } = await sql.query<Row>("select * from voice_calls where id = $1 and state = 'connecting' for update", [id]);
        if (!rows[0]) return;
        await this.releaseElevenLabs(rows[0], sql);
        await this.finishElevenLabs(sql, rows[0], "error", { detail });
        return rows[0];
      });
      if (failed) this.elevenLabsCommitted(failed);
      throw new HttpError(502, detail, "REALTIME_FAILED");
    }
  }

  private background(type: string, id: string | undefined, work: Promise<unknown>): void {
    void work.catch(error => console.error(JSON.stringify({ type, session: id, detail: detailOf(error) })));
  }

  private async row(tenant: string, id: string): Promise<Row> {
    const { rows } = await this.options.db.query<Row>("select * from voice_calls where id = $1 and tenant = $2", [id, tenant]);
    if (!rows[0]) throw new HttpError(404, "Voice call not found", "VOICE_CALL_NOT_FOUND");
    return rows[0];
  }

  async get(tenant: string, id: string): Promise<VoiceCall> { return view(await this.row(tenant, id)); }

  async list(tenant: string, filter: { state?: string; limit?: number }): Promise<VoiceCall[]> {
    if (filter.state !== undefined && filter.state !== "live" && filter.state !== "ended") throw new HttpError(400, "state must be live or ended");
    const limit = Math.min(100, Math.max(1, filter.limit ?? 50));
    const { rows } = await this.options.db.query<Row>(`select * from voice_calls where tenant = $1
      ${filter.state === "live" ? "and state <> 'ended'" : filter.state === "ended" ? "and state = 'ended'" : ""}
      order by created_at desc, id desc limit $2`, [tenant, limit]);
    return rows.map(view);
  }

  async update(tenant: string, id: string, patch: VoiceCallUpdate): Promise<VoiceCall> {
    const { rows } = await this.options.db.query<Row>(`update voice_calls set options = options || $3::jsonb, updated_at = $4
      where id = $1 and tenant = $2 returning *`, [id, tenant, JSON.stringify(patch), new Date(this.now())]);
    if (!rows[0]) throw new HttpError(404, "Voice call not found", "VOICE_CALL_NOT_FOUND");
    return view(rows[0]);
  }

  async end(tenant: string, id: string, by: Ending, providerClosed = false): Promise<VoiceCall> {
    const row = await this.row(tenant, id);
    if (row.state === "ended" && !providerClosed) return view(row);
    if (row.provider === "elevenlabs") {
      const { rows } = await this.options.db.query<Row>(`update voice_calls set state = 'ending', end_reason = $2, ended_at = $3, updated_at = $3
        where id = $1 and state = 'live' returning *`, [id, by.reason, new Date(this.now())]);
      return rows[0] ? view(rows[0]) : this.get(tenant, id);
    }
    const existing = this.ending.get(id);
    if (existing) return existing;
    const ending = this.hangup(row, by, providerClosed);
    this.ending.set(id, ending);
    try { return await ending; } finally { this.ending.delete(id); }
  }

  private async hangup(row: Row, by: Ending, providerClosed: boolean): Promise<VoiceCall> {
    const { rows } = await this.options.db.query<Row>(`update voice_calls set state = 'ending', updated_at = $2
      where id = $1 and state <> 'ended' ${providerClosed ? "and state <> 'ending'" : ""} returning *`, [row.id, new Date(this.now())]);
    const current = rows[0];
    if (!current) {
      // A peer is ending the call. Clean up this node's sideband without changing the peer's reason.
      if (providerClosed) await this.finish(row.id, by, true);
      return this.get(row.tenant, row.id);
    }
    try {
      if (current.provider_call) {
        const key = await this.options.key(current.tenant, current.options.keyScope, current.provider);
        if (!key || !this.options.providers.openai) throw new HttpError(502, "No OpenAI key for hanging up the voice call", "REALTIME_FAILED");
        try { await this.options.providers.openai.hangup(current.provider_call, key.apiKey); }
        catch (error) { throw new HttpError(502, detailOf(error, key.apiKey), "REALTIME_FAILED"); }
      }
    } catch (error) {
      if (!providerClosed) throw error;
      console.error(JSON.stringify({ type: "voice_call_hangup_failed", session: current.id, detail: detailOf(error) }));
    }
    await this.finish(current.id, by);
    return this.get(current.tenant, current.id);
  }

  /** The row transition owns the ended event. Each node still releases its own sideband and holds. */
  private async finish(id: string, by: Ending, providerClosed = false): Promise<void> {
    const live = this.live.get(id);
    if (live) {
      live.abort.abort();
      live.sideband.close();
      await Promise.allSettled(live.usage);
    }
    const row = await transaction(this.options.db, async sql => {
      const { rows } = await sql.query<Row>(`update voice_calls set state = 'ended', end_reason = $2, ended_at = $3, updated_at = $3
        where id = $1 and state <> 'ended' ${providerClosed ? "and state <> 'ending'" : ""} returning *`, [id, by.reason, new Date(this.now())]);
      if (rows[0]) {
        const { startedAt, endedAt, turns, asks, audioSeconds, costUsd } = view(rows[0]);
        await this.enqueue(rows[0], "voice.session.ended", { ...by, startedAt, endedAt, turns, asks, audioSeconds, costUsd }, sql);
      }
      return rows[0];
    });
    if (live && this.live.delete(id)) {
      const holds = [...live.holds.values()];
      live.holds.clear();
      await Promise.allSettled(holds.map(async pending => (await pending)?.release()));
    }
    if (row) this.options.kickWebhooks();
  }

  async transcript(tenant: string, id: string, input: VoiceTranscriptInput): Promise<{ seq: number }> {
    const seq = await transaction(this.options.db, async sql => {
      const { rows } = await sql.query<Row>("select * from voice_calls where id = $1 and tenant = $2 for update", [id, tenant]);
      const row = rows[0];
      if (!row) throw new HttpError(404, "Voice call not found", "VOICE_CALL_NOT_FOUND");
      if (row.provider === "openai") throw new HttpError(409, "This call's transcripts come from the provider", "VOICE_TRANSCRIPT_SIDEBAND");
      if (row.state !== "live") throw new HttpError(409, "The voice call is not live");
      const { speaker, text, seconds, startedAt, endedAt } = input;
      const name = Object.hasOwn(row.options.speakers, speaker) ? row.options.speakers[speaker] : speaker;
      const lines = `${name}: ${text}`.split(/\r?\n/).filter(Boolean).map(line => line.slice(-TRANSCRIPT_CHARS));
      const transcript = [...(row.options.transcript ?? []), ...lines].slice(-TRANSCRIPT_LINES);
      while (transcript.length > 1 && transcript.join("\n").length > TRANSCRIPT_CHARS) transcript.shift();
      const seq = row.turns + 1;
      await sql.query(`update voice_calls set turns = $2, audio_seconds = audio_seconds + $3,
        options = options || jsonb_build_object('transcript', $4::jsonb), updated_at = $5 where id = $1`,
      [id, seq, seconds ?? 0, JSON.stringify(transcript), new Date(this.now())]);
      await this.enqueue(row, "voice.utterance", { speakerId: speaker, text, seconds, startedAt, endedAt, reported: "client", seq }, sql);
      return seq;
    });
    this.options.kickWebhooks();
    return { seq };
  }

  async elevenLabsTool(name: string, body: { conversation_id?: unknown; request?: unknown } | null, secret: string | undefined) {
    const provider = this.options.providers.elevenlabs;
    if (!provider || !secret || typeof body?.conversation_id !== "string" || (name !== "ask_agent" && name !== "stay_silent")) return;
    const result = await transaction(this.options.db, async sql => {
      const { rows } = await sql.query<Row>(`select * from voice_calls
        where provider = 'elevenlabs' and provider_call = $1 and state = 'live' for update`, [body.conversation_id]);
      const row = rows[0];
      if (!row?.options.elevenlabsAgent) return;
      const agent = await provider.agentFor(row.options.elevenlabsAgent, sql);
      if (!agent || !equalSecret(Buffer.from(secret), Buffer.from(agent.toolSecret))) return;
      if (name === "stay_silent") return { ok: true } as const;
      const request = typeof body.request === "string" ? body.request : "";
      const asks = row.asks + 1;
      await sql.query("update voice_calls set asks = $2, options = options - 'transcript', updated_at = $3 where id = $1",
        [row.id, asks, new Date(this.now())]);
      await this.enqueue(row, "voice.agent.asked", { request: request.slice(0, ASK_LIMITS.requestChars) }, sql);
      return { row, asks, request };
    });
    if (!result || "ok" in result) return result;
    this.options.kickWebhooks();
    const { row, asks, request } = result;
    const { subject, bucket, transcript } = row.options;
    const creditEnabled = this.options.credit && (!this.options.creditEnabled || await this.options.creditEnabled(row.tenant));
    const payer = creditEnabled ? { endUser: subject, ...(bucket !== undefined ? { bucket } : {}) } : undefined;
    const answer = Promise.withResolvers<{ reply: string } | { error: string }>();
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      answer.resolve({ reply: PENDING });
    }, this.options.pendingMs ?? ASK_LIMITS.pendingMs);
    const signal = AbortSignal.timeout(this.options.lateMs ?? ASK_LIMITS.lateMs);
    this.background("voice_call_tool_failed", row.id, askAgent({
      submit: this.options.submitStreaming, agent: row.agent, tenant: row.tenant, call: row.id, n: asks,
      now: () => this.now(), transcript, payer,
    }, request, signal).then(async result => {
      clearTimeout(timer);
      const ok = result.outcome === "ok";
      const reply = result.reply || EMPTY_REPLY;
      if (!late) answer.resolve(ok ? { reply } : { error: result.outcome === "empty" ? EMPTY_REQUEST : ASK_FAILED });
      await this.enqueue(row, "voice.agent.replied", {
        outcome: result.outcome, ms: result.ms, late, replyChars: result.reply.length,
        ...(late && result.outcome !== "timeout" ? { reply: ok ? reply : ASK_FAILED } : {}),
      });
    }));
    return answer.promise;
  }

  async elevenLabsPostCall(raw: Buffer, signature: string | undefined): Promise<void> {
    const provider = this.options.providers.elevenlabs;
    if (!provider) throw new HttpError(404, "Unknown ElevenLabs agent");
    const event = parseJson(raw.toString("utf8"));
    const data = event?.data;
    const agentId = data?.agent_id;
    const agent = typeof agentId === "string" ? await provider.agentFor(agentId) : undefined;
    if (!agent) throw new HttpError(404, "Unknown ElevenLabs agent");
    const secret = await provider.webhookSecret(agent.keyHash);
    const fields = (signature ?? "").split(",").map(field => field.trim());
    const timestamp = fields.find(field => /^t=\d+$/.test(field))?.slice(2);
    const digest = fields.find(field => /^v0=[0-9a-f]{64}$/.test(field))?.slice(3);
    if (!secret || !timestamp || !digest || Math.abs(this.now() - Number(timestamp) * 1000) > 30 * 60_000 ||
      !equalSecret(Buffer.from(digest, "hex"), createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest())) {
      throw new HttpError(400, "Invalid ElevenLabs signature");
    }
    const type = event.type;
    if (type !== "post_call_transcription" && type !== "call_initiation_failure") {
      console.log(JSON.stringify({ type: "voice_call_webhook_ignored", eventType: typeof type === "string" ? type.slice(0, 100) : undefined }));
      return;
    }
    const conversationId = typeof data.conversation_id === "string" ? data.conversation_id : null;
    const duration = data.metadata?.call_duration_secs;
    const reportedSeconds = typeof duration === "number" && Number.isFinite(duration) ? Math.max(0, duration) : undefined;
    const lookup = [conversationId, agentId];
    const byConversation = `select * from voice_calls where provider = 'elevenlabs' and provider_call = $1
      and options->>'elevenlabsAgent' = $2`;
    // Resolve the provider duration before taking the row lock. Re-read the row before settling.
    const candidate = type === "post_call_transcription" && reportedSeconds === undefined
      ? (await this.options.db.query<Row>(byConversation + " and state <> 'ended'", lookup)).rows[0]
      : undefined;
    const conversation = candidate && await this.elevenLabsConversation(candidate);
    const result = await transaction(this.options.db, async sql => {
      const { rows } = await sql.query<Row>(byConversation + " for update", lookup);
      const row = rows[0];
      if (!row) {
        console.log(JSON.stringify({ type: "voice_call_unknown_conversation" }));
        return;
      }
      if (row.state === "ended") {
        if (row.options.deadlineSettled) console.log(JSON.stringify({ type: "voice_call_post_call_late", id: row.id }));
        return;
      }
      if (type === "call_initiation_failure") {
        await this.releaseElevenLabs(row, sql);
        const detail = typeof data.failure_reason === "string" ? detailOf(data.failure_reason) : undefined;
        await this.finishElevenLabs(sql, row, "error", { detail });
        return { row };
      }
      const seconds = reportedSeconds ?? conversation?.durationSeconds ??
        Math.max(0, ((row.ended_at?.getTime() ?? this.now()) - (row.started_at ?? row.expires_at).getTime()) / 1000);
      const source = reportedSeconds !== undefined ? undefined : conversation?.durationSeconds !== undefined ? "conversation" : "elapsed";
      const usage = await this.settleElevenLabs(sql, row, seconds, false);
      let turns = row.turns;
      if (turns === 0 && Array.isArray(data.transcript)) {
        for (const entry of data.transcript) {
          if (entry?.role !== "user" || typeof entry.message !== "string") continue;
          await this.enqueue(row, "voice.utterance", { text: entry.message, reported: "provider", seq: ++turns, secondsIntoCall: entry.time_in_call_secs }, sql);
        }
      }
      const termination = typeof data.metadata?.termination_reason === "string" ? data.metadata.termination_reason : conversation?.terminationReason ?? "";
      const reason = row.state === "ending" ? row.end_reason ?? "requested" : terminationReasonToEnd(termination);
      await this.finishElevenLabs(sql, row, reason, { turns, usage });
      return { row, usage, source };
    });
    if (result) {
      if (result.source) {
        const log = JSON.stringify({ type: "voice_call_duration_missing", id: result.row.id, source: result.source });
        if (result.source === "elapsed") console.warn(log);
        else console.info(log);
      }
      this.elevenLabsCommitted(result.row, result.usage);
    }
  }

  private async elevenLabsConversation(row: Row) {
    const provider = this.options.providers.elevenlabs;
    if (!provider || !row.provider_call) return;
    try {
      const key = await this.options.key(row.tenant, row.options.keyScope, "elevenlabs");
      if (key?.platform) return await provider.conversation(key.apiKey, row.provider_call);
    } catch {
      // Settlement falls back to the elapsed duration if the provider lookup fails.
    }
  }

  private async releaseElevenLabs(row: Row, sql: Sql) {
    if (!row.hold) return;
    const credit = this.options.credit;
    if (!credit?.release) throw new Error("Voice credit does not support durable holds");
    await credit.release(row.hold.id, sql);
  }

  private async settleElevenLabs(sql: Sql, row: Row, seconds: number, deadline: boolean): Promise<UsageRecord> {
    const cost = realtimeCost(`elevenlabs/${row.model}`, NO_USAGE, seconds);
    const hold = row.hold;
    const usd = Math.min(cost, hold?.usd ?? cost);
    const credit = this.options.credit;
    if (hold) {
      if (!credit?.settleHold) throw new Error("Voice credit does not support durable holds");
      await credit.settleHold(row.tenant, hold.endUser, hold.bucket, hold.id, Math.round(usd * 1_000_000),
        `voice_elevenlabs:${hold.id}`, { call: "voice_elevenlabs", session: row.id }, this.now(), sql);
    }
    const { bucket, subject, context } = row.options;
    const usage: UsageRecord = {
      provider: "elevenlabs", model: row.model, kind: "speech", platform: true, speeches: 1,
      audioSeconds: deadline ? seconds : Math.ceil(seconds), timestamp: this.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cost: { total: deadline ? usd : cost }, ...(deadline ? { settled: "deadline" } : {}) },
      bucket, identity: { subject, context: { ...context, voiceCall: row.id } },
    };
    await this.options.recordIn?.(sql, row.tenant, usage);
    return usage;
  }

  private async finishElevenLabs(sql: Sql, row: Row, reason: string, result: { detail?: string; turns?: number; usage?: UsageRecord; deadline?: boolean }) {
    const now = new Date(this.now());
    const { rows } = await sql.query<Row>(`update voice_calls set state = 'ended', end_reason = $2,
      ended_at = coalesce(ended_at, $3), updated_at = $3, turns = $4, audio_seconds = $5, cost = $6, hold = null,
      options = (options - 'transcript') || jsonb_build_object('deadlineSettled', $7::boolean)
      where id = $1 returning *`, [row.id, reason, now, result.turns ?? row.turns,
      result.usage?.audioSeconds ?? row.audio_seconds, Math.round((result.usage?.usage.cost.total ?? view(row).costUsd) * 1_000_000), result.deadline ?? false]);
    const { startedAt, endedAt, turns, asks, audioSeconds, costUsd } = view(rows[0]);
    await this.enqueue(rows[0], "voice.session.ended", { reason, detail: result.detail, startedAt, endedAt, turns, asks, audioSeconds, costUsd }, sql);
  }

  private elevenLabsCommitted(row: Row, usage?: UsageRecord) {
    this.options.kickWebhooks();
    if (!usage) return;
    if (!this.options.recordIn) this.options.record(row.tenant, usage);
    else if (this.options.usageCommitted) this.background("voice_call_usage_refresh_failed", row.id, this.options.usageCommitted(row.tenant));
  }

  private async sweepElevenLabs(now: number) {
    const deadline = new Date(now - POST_CALL_GRACE_MS);
    const { rows } = await this.options.db.query<Row>(`select * from voice_calls
      where provider = 'elevenlabs' and state <> 'ended' and (hold is not null or coalesce(ended_at, expires_at) < $1)`, [deadline]);
    for (const candidate of rows) {
      const { id } = candidate;
      try {
        const conversation = candidate.started_at && (candidate.ended_at ?? candidate.expires_at) < deadline
          ? await this.elevenLabsConversation(candidate) : undefined;
        const result = await transaction(this.options.db, async sql => {
          const { rows } = await sql.query<Row>("select * from voice_calls where id = $1 and state <> 'ended' for update", [id]);
          const row = rows[0];
          if (!row) return;
          const fixedEnd = row.ended_at ?? row.expires_at;
          if (fixedEnd >= deadline) {
            if (row.hold) await this.options.credit?.renew?.(row.tenant, row.hold.endUser, row.hold.id, now, sql);
            return;
          }
          if (!row.started_at) {
            await this.releaseElevenLabs(row, sql);
            await this.finishElevenLabs(sql, row, "error", { detail: "The call did not connect" });
            return { row };
          }
          if ((candidate.ended_at ?? candidate.expires_at) >= deadline) return;
          const elapsedSeconds = Math.max(0, (fixedEnd.getTime() - row.started_at.getTime()) / 1000);
          const source = conversation?.durationSeconds === undefined ? "elapsed" : "conversation";
          const usage = await this.settleElevenLabs(sql, row, conversation?.durationSeconds ?? elapsedSeconds, true);
          await this.finishElevenLabs(sql, row, row.ended_at ? row.end_reason ?? "requested" : "max_duration",
            { usage, deadline: true, detail: "settled at the deadline: no post-call report" });
          return { row, usage, elapsedSeconds, source };
        });
        if (!result) continue;
        if (result.usage) {
          deadlineSettles++;
          console.warn(JSON.stringify({ type: "voice_call_settled_deadline", id, usd: result.usage.usage.cost.total, elapsedSeconds: result.elapsedSeconds, source: result.source }));
        }
        this.elevenLabsCommitted(result.row, result.usage);
      } catch (error) {
        console.error(JSON.stringify({ type: "voice_call_expire_failed", session: id, detail: detailOf(error) }));
      }
    }
  }

  sweep(): Promise<void> {
    return this.sweeping ??= this.expire().finally(() => { this.sweeping = undefined; });
  }

  private async expire() {
    const now = this.now();
    await this.sweepElevenLabs(now);
    const { rows } = await this.options.db.query<Row>("select id, tenant from voice_calls where provider = 'openai' and state <> 'ended' and expires_at < $1", [new Date(now)]);
    await Promise.allSettled(rows.map(row => this.end(row.tenant, row.id, { reason: "max_duration" }).catch(error => {
      console.error(JSON.stringify({ type: "voice_call_expire_failed", session: row.id, detail: detailOf(error) }));
    })));
    await this.options.db.query("delete from voice_calls where state = 'ended' and ended_at < $1", [new Date(now - VOICE_LIMITS.retentionDays * 86_400_000)]);
  }

  stop(): Promise<void> { return this.close(); }

  close(): Promise<void> {
    return this.stopping ??= this.shutdown();
  }

  private async shutdown() {
    this.closing = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.creating, this.sweeping]);
    const { rows } = await this.options.db.query<Row>("select id, tenant from voice_calls where node = $1 and state <> 'ended'", [this.options.node]);
    await Promise.all(rows.map(async row => {
      try {
        await this.end(row.tenant, row.id, { reason: "restarted" });
      } catch (error) {
        await this.finish(row.id, { reason: "restarted", detail: detailOf(error) });
      }
      console.log(JSON.stringify({ type: "voice_call_restarted", session: row.id }));
    }));
  }

  private async enqueue(row: Row, type: EventType, data: Record<string, unknown>, sql?: Sql) {
    await this.options.enqueue([webhookEvent(type, row.tenant, {
      provider: row.provider, session: row.id, agent: row.agent, subject: row.options.subject, metadata: row.options.metadata ?? {}, ...data,
    })], sql);
    if (!sql) this.options.kickWebhooks();
  }

  private responseStarted(tenant: string, id: string, options: VoiceCallOptions, live: Live, response: string): void {
    const credit = live.credit;
    if (!credit || live.holds.has(response) || live.done.has(response)) return;
    const bucket = options.bucket ?? DEFAULT_BUCKET;
    const hold = credit.hold(tenant, options.subject, bucket, HOLD_USD, "voice_realtime", { session: id }).catch(error => {
      if (error instanceof HttpError && error.status === 402) {
        const endUserReason = error.details?.reason;
        const by: Ending = { reason: "budget", limit: "end_user", ...(typeof endUserReason === "string" ? { endUserReason } : {}), bucket };
        this.background("voice_call_budget_failed", id, this.end(tenant, id, by).catch(failure =>
          this.finish(id, { ...by, detail: detailOf(failure) })));
        return undefined;
      }
      throw error;
    });
    live.holds.set(response, hold);
    this.background("voice_call_hold_failed", id, hold);
  }

  private async responseDone(tenant: string, id: string, model: string, options: VoiceCallOptions, live: Live, response: string, usage: RealtimeUsage) {
    if (live.done.has(response)) return;
    live.done.add(response);
    const pending = live.holds.get(response);
    live.holds.delete(response);
    const costUsd = realtimeCost(`openai/${model}`, usage);
    const { bucket, subject, context, keyScope } = options;
    this.options.record(tenant, {
      provider: "openai", model, kind: "speech", platform: live.platform, speeches: 1, audioSeconds: usage.outputAudio / 20, timestamp: this.now(),
      usage: { input: usage.inputText + usage.inputAudio, output: usage.outputText + usage.outputAudio, cacheRead: usage.cachedText + usage.cachedAudio, cost: { total: costUsd } },
      bucket, identity: { subject, context: { ...context, voiceCall: id } }, ...(keyScope ? { keyScope } : {}),
    });
    // Submit the row update before waiting for the credit operation, so a concurrent end sees the turn.
    const update = this.options.db.query("update voice_calls set turns = turns + 1, cost = cost + $2, updated_at = $3 where id = $1",
      [id, Math.round(costUsd * 1_000_000), new Date(this.now())]);
    await Promise.all([update, pending?.then(hold => costUsd > 0 ? hold?.settle(costUsd) : hold?.release())]);
  }

  private async heard(id: string, live: Live, item: string, text: string, seconds: number) {
    if (live.heard.has(item)) return;
    live.heard.add(item);
    if (!text && !seconds) return;
    const seq = text ? ++live.seq : undefined;
    if (text) {
      for (const line of text.split(/\r?\n/).filter(Boolean).slice(-TRANSCRIPT_LINES)) {
        live.lines.push(line.slice(-TRANSCRIPT_CHARS));
      }
      live.lines = live.lines.slice(-TRANSCRIPT_LINES);
      while (live.lines.length > 1 && live.lines.join("\n").length > TRANSCRIPT_CHARS) live.lines.shift();
    }
    const { rows } = await this.options.db.query<Row>(`update voice_calls set audio_seconds = audio_seconds + $2, updated_at = $3
      where id = $1 and state <> 'ended' returning *`, [id, seconds, new Date(this.now())]);
    if (rows[0] && seq !== undefined) await this.enqueue(rows[0], "voice.utterance", { text, seconds, reported: "sideband", seq });
  }

  private async tool(id: string, live: Live, call: ToolCall) {
    if (live.tools.has(call.id)) return;
    live.tools.add(call.id);
    const { sideband } = live;
    if (call.name === "stay_silent") {
      sideband.toolResult(call.id, '{"ok":true}');
      return;
    }
    if (call.name !== "ask_agent") {
      sideband.toolResult(call.id, JSON.stringify({ error: `No tool named ${call.name}` }));
      sideband.respond();
      return;
    }
    const request = typeof call.args.request === "string" ? call.args.request : "";
    const transcript = live.lines;
    live.lines = [];
    const { rows } = await this.options.db.query<Row>(`update voice_calls set asks = asks + 1, updated_at = $2
      where id = $1 and state <> 'ended' returning *`, [id, new Date(this.now())]);
    const row = rows[0];
    if (!row || live.abort.signal.aborted) return;
    await this.enqueue(row, "voice.agent.asked", { request: request.slice(0, ASK_LIMITS.requestChars) });
    const { subject, bucket } = row.options;
    const payer = live.credit ? { endUser: subject, ...(bucket !== undefined ? { bucket } : {}) } : undefined;
    const signal = AbortSignal.any([live.abort.signal, AbortSignal.timeout(this.options.lateMs ?? ASK_LIMITS.lateMs)]);
    let late = false;
    const timer = setTimeout(() => {
      if (signal.aborted) return;
      late = true;
      sideband.toolResult(call.id, JSON.stringify({ pending: PENDING }));
      sideband.respond();
    }, this.options.pendingMs ?? ASK_LIMITS.pendingMs);
    const result = await askAgent({
      submit: this.options.submitStreaming, agent: row.agent, tenant: row.tenant, call: id, n: row.asks,
      now: () => this.now(), transcript, payer,
    }, request, signal).finally(() => clearTimeout(timer));
    if (live.abort.signal.aborted) return;
    const ok = result.outcome === "ok";
    const said = result.reply || EMPTY_REPLY;
    if (!late) {
      sideband.toolResult(call.id, JSON.stringify(ok ? { reply: said } : { error: result.outcome === "empty" ? EMPTY_REQUEST : ASK_FAILED }));
      sideband.respond();
    } else if (result.outcome !== "timeout") {
      sideband.note(ok ? lateReply(request, said) : lateFailure(request));
      sideband.respond(ok ? LATE_REPLY : LATE_FAILURE);
    }
    await this.enqueue(row, "voice.agent.replied", { outcome: result.outcome, ms: result.ms, late, replyChars: result.reply.length });
  }
}

import { randomBytes } from "node:crypto";
import type { VoiceCall, VoiceCallCreated, VoiceCallInput, VoiceCallUpdate } from "./api-schemas.ts";
import type { UsageRecord } from "./client-sessions/state.ts";
import { transaction, type Db, type Sql } from "./db.ts";
import { bucketInput, DEFAULT_BUCKET } from "./end-user-credits.ts";
import { HttpError } from "./http.ts";
import { identityInput } from "./identity.ts";
import { DEFAULT_VOICE } from "./speech.ts";
import { VOICE_LIMITS, type VoiceCredit } from "./voice-sessions.ts";
import { redactDetail } from "./voice-providers/socket.ts";
import { ASK_LIMITS, askAgent, TRANSCRIPT_CHARS, TRANSCRIPT_LINES } from "./voice/calls/bridge.ts";
import type { OpenAICalls, Sideband, SidebandEvents } from "./voice/calls/openai.ts";
import { ASK_AGENT, ASK_FAILED, EMPTY_REPLY, EMPTY_REQUEST, lateFailure, lateReply, LATE_FAILURE, LATE_REPLY, PENDING, realtimeInstructions, STAY_SILENT } from "./voice/calls/prompts.ts";
import { realtimeCost, realtimePrice, realtimeVoice, type RealtimeUsage } from "./voice/realtime/provider.ts";
import { webhookEvent, type EventType, type WebhookEvent } from "./webhooks.ts";

export type VoiceCallOptions = {
  subject: string; bucket?: string; context?: Record<string, unknown>; keyScope?: string; metadata?: Record<string, unknown>;
  speakers: Record<string, string>; maxMinutes: number; language?: string; instructions?: string;
};
export type VoiceCallsOptions = {
  db: Db; node: string;
  admit(tenant: string): Promise<void>;
  agentOwned(agent: string, tenant: string): Promise<boolean>;
  record(tenant: string, usage: UsageRecord): void;
  submitStreaming(agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }, signal: AbortSignal): AsyncIterable<string>;
  credit?: VoiceCredit;
  creditEnabled?(tenant: string): Promise<boolean>;
  providers: { openai?: OpenAICalls };
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
  turns: number; asks: number; audio_seconds: string; cost: number;
  started_at: Date | null; ended_at: Date | null; expires_at: Date;
};
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

function view(row: Row): VoiceCall {
  const { id, state, provider, model, voice, agent, turns, asks, options } = row;
  return {
    id, state, provider, model, voice, agent, subject: options.subject, startedAt: row.started_at?.getTime() ?? null,
    endedAt: row.ended_at?.getTime() ?? null, expiresAt: row.expires_at.getTime(), reason: row.end_reason,
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
    if (name === "elevenlabs") throw new HttpError(400, "ElevenLabs calls are not available yet", "REALTIME_UNAVAILABLE");
    const provider = this.options.providers.openai;
    if (!provider) throw new HttpError(400, "openai calls are not available on this runtime", "REALTIME_UNAVAILABLE");
    const model = requestedModel ?? provider.defaultModel;
    if (!provider.models.includes(model)) throw new HttpError(400, `Unknown OpenAI realtime model: ${model}`, "REALTIME_MODEL");
    const voice = realtimeVoice(provider, requestedVoice ?? DEFAULT_VOICE);
    if (!realtimePrice(`openai/${model}`)) throw new HttpError(400, `No realtime price for openai/${model}`, "REALTIME_UNPRICED");
    if (!sdp) throw new HttpError(400, "sdp is required for OpenAI calls");
    identityInput(given);
    const options: VoiceCallOptions = {
      ...given, speakers: given.speakers ?? {}, maxMinutes: given.maxMinutes ?? VOICE_LIMITS.maxMinutes.default,
      ...(given.bucket !== undefined ? { bucket: bucketInput(given.bucket) } : {}),
    };
    const key = await this.options.key(tenant, options.keyScope, name);
    if (!key) throw new HttpError(400, "No OpenAI key for voice calls: add one under Models & keys (PUT /v1/providers/openai/key)", "REALTIME_UNAVAILABLE");
    await this.options.admit(tenant);
    const bucket = options.bucket ?? DEFAULT_BUCKET;
    const credit = !this.options.creditEnabled || await this.options.creditEnabled(tenant) ? this.options.credit : undefined;
    const refused = await credit?.refusal(tenant, options.subject, bucket);
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
      await sql.query(`insert into voice_calls (id, tenant, agent, provider, model, voice, state, options, expires_at, created_at, updated_at)
        values ($1, $2, $3, $4, $5, $6, 'connecting', $7, $8, $9, $9)`,
      [id, tenant, agent, name, model, voice, JSON.stringify(options), new Date(now + options.maxMinutes * 60_000), new Date(now)]);
    });

    // Events can arrive on open while the row is still being published.
    const ready = Promise.withResolvers<Live | undefined>();
    const afterLive = (type: string, work: (live: Live) => void | Promise<void>) => this.background(type, id, ready.promise.then(live => {
      if (live && !live.abort.signal.aborted) return work(live);
    }));
    let connected: Awaited<ReturnType<OpenAICalls["create"]>> | undefined;
    try {
      connected = await provider.create({
        sdp, model, voice, instructions: realtimeInstructions(options.instructions ?? "", { agent: true, group: true }),
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
          if (reason !== "requested") await this.finish(id, { reason, detail }, true);
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
        await provider.hangup(connected.callId, key.apiKey).catch(() => {});
      }
      await this.finish(id, { reason: "error", detail });
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

  async end(tenant: string, id: string, by: Ending): Promise<VoiceCall> {
    const row = await this.row(tenant, id);
    if (row.state === "ended") return view(row);
    const existing = this.ending.get(id);
    if (existing) return existing;
    const ending = this.hangup(row, by);
    this.ending.set(id, ending);
    try { return await ending; } finally { this.ending.delete(id); }
  }

  private async hangup(row: Row, by: Ending): Promise<VoiceCall> {
    const { rows } = await this.options.db.query<Row>(`update voice_calls set state = 'ending', updated_at = $2
      where id = $1 and state <> 'ended' returning *`, [row.id, new Date(this.now())]);
    const current = rows[0];
    if (!current) return this.get(row.tenant, row.id);
    if (current.provider_call) {
      const key = await this.options.key(current.tenant, current.options.keyScope, current.provider);
      if (!key || !this.options.providers.openai) throw new HttpError(502, "No OpenAI key for hanging up the voice call", "REALTIME_FAILED");
      try { await this.options.providers.openai.hangup(current.provider_call, key.apiKey); }
      catch (error) { throw new HttpError(502, detailOf(error, key.apiKey), "REALTIME_FAILED"); }
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

  sweep(): Promise<void> {
    return this.sweeping ??= this.expire().finally(() => { this.sweeping = undefined; });
  }

  private async expire() {
    const now = this.now();
    const { rows } = await this.options.db.query<Row>("select id, tenant from voice_calls where state <> 'ended' and expires_at < $1", [new Date(now)]);
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
    if (text) {
      for (const line of text.split(/\r?\n/).filter(Boolean).slice(-TRANSCRIPT_LINES)) {
        live.lines.push(line.slice(-TRANSCRIPT_CHARS));
      }
      live.lines = live.lines.slice(-TRANSCRIPT_LINES);
      while (live.lines.length > 1 && live.lines.join("\n").length > TRANSCRIPT_CHARS) live.lines.shift();
    }
    const seq = ++live.seq;
    const { rows } = await this.options.db.query<Row>(`update voice_calls set audio_seconds = audio_seconds + $2, updated_at = $3
      where id = $1 and state <> 'ended' returning *`, [id, seconds, new Date(this.now())]);
    if (rows[0]) await this.enqueue(rows[0], "voice.utterance", { text, seconds, reported: "sideband", seq });
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

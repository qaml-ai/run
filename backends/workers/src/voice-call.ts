import { DurableObject } from "cloudflare:workers";
import { redactDetail } from "../../../src/voice-providers/socket.ts";
import type { Env } from "./agent-types.ts";
import { HttpError, errorFields } from "./errors.ts";
import { transaction, withSql } from "./postgres.ts";
import { mediaKey } from "./media-api.ts";
import { keyServices } from "./security-services.ts";
import { bucketInput, identityInput } from "./security-policy.ts";
import { publishPending } from "./webhooks.ts";
import { voiceJson, voiceNotFound } from "./voice-calls-api.ts";
import { enqueueVoiceEvent, type VoiceEvent } from "./voice/calls/events.ts";
import { openaiCalls, type Sideband, type SidebandEvents } from "./voice/calls/openai.ts";
import { type VoiceCall as Call, type VoiceCallInput, type VoiceCallUpdate, type VoiceTranscriptInput, VOICE_LIMITS } from "./voice/calls/schema.ts";
import { ASK_AGENT, ASK_FAILED, EMPTY_REPLY, EMPTY_REQUEST, lateFailure, lateReply, LATE_FAILURE, LATE_REPLY, PENDING, realtimeInstructions, STAY_SILENT } from "./voice/calls/prompts.ts";
import { streamVoiceReply } from "./voice/calls/ask.ts";
import { DEFAULT_BUCKET } from "./end-user-credits.ts";
import { REALTIME_VOICE_FOR } from "../../../src/voice/realtime/provider.ts";
import { admitVoiceUsage, recordVoiceUsage, voiceCredits, voicePrice, type VoiceCredits, type VoiceCharge } from "./voice/calls/money.ts";


type Ending = { reason: string; detail?: string; limit?: "end_user"; endUserReason?: string; bucket?: string };
type ToolAnswer = { ok: true } | { reply: string } | { error: string };
type Ask = { n: number; started: number; request: string; tool?: string; pending: boolean };
type Row = {
  call: Call; tenant: string; options: Omit<VoiceCallInput, "sdp">; providerCall?: string; providerAgent?: string;
  platform: boolean; payer: boolean; seq: number; noteSeq?: number; lines: string[]; noteAt?: number; ending?: Ending;
};
const PENDING_MS = 45_000;
const LATE_MS = 300_000;
const NOTE_MS = 2_000;

export class VoiceCall extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();
  private sideband?: Sideband;
  private readonly answers = new Map<number, PromiseWithResolvers<ToolAnswer>>();
  private readonly running = new Map<number, AbortController>();
  private readonly credits: VoiceCredits;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.credits = voiceCredits(env);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }

  private background(fn: () => Promise<unknown>) {
    this.ctx.waitUntil(this.serial(fn).catch(() => console.error("voice_call_operation_failed")));
  }

  private async row(tenant?: string) {
    const row = await this.ctx.storage.get<Row>("call");
    if (!row || (tenant !== undefined && row.tenant !== tenant)) throw voiceNotFound();
    return row;
  }

  private async save(row: Row) {
    await this.ctx.storage.put("call", row);
    await this.arm(row);
  }

  private openai() {
    return openaiCalls({ baseUrl: this.env.TEST_MODE === "1" ? this.env.MEDIA_BASE_URL : undefined });
  }

  private async event(row: Row, event: VoiceEvent, suffix: string, data: Record<string, unknown>) {
    await transaction(this.env, sql => enqueueVoiceEvent(sql, event, row.tenant, `${event}:${row.call.id}:${suffix}`,
      { provider: row.call.provider, session: row.call.id, agent: row.call.agent, subject: row.call.subject, metadata: row.call.metadata, ...data }));
    this.ctx.waitUntil(publishPending(this.env).catch(() => {}));
  }

  private async index(row: Row) {
    await withSql(this.env, sql => sql.query("update workers_voice_calls set state=$2,provider_call=$3 where id=$1",
      [row.call.id, row.call.state, row.providerCall ?? null]));
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/create") return await this.serial(async () => {
        const { id, tenant, options } = await request.json<{ id: string; tenant: string; options: VoiceCallInput }>();
        return this.create(id, tenant, options);
      });
      return await this.serial(async () => {
        const row = await this.row(request.headers.get("X-Voice-Tenant") ?? "");
        if (path === "/get") return voiceJson(row.call);
        if (path === "/update") {
          Object.assign(row.call, await request.json<VoiceCallUpdate>());
          await this.save(row);
          return voiceJson(row.call);
        }
        if (path === "/end") {
          const { reason = "requested" } = await request.json<{ reason?: string }>();
          return voiceJson(await this.end(row, { reason }));
        }
        if (path === "/transcript") return voiceJson(await this.transcript(row, await request.json<VoiceTranscriptInput>()), 202);
        throw voiceNotFound();
      });
    } catch (error) {
      if (error instanceof HttpError) return voiceJson({ error: error.message, code: error.code, ...errorFields(error), ...error.details }, error.status);
      throw error;
    }
  }

  private async create(id: string, tenant: string, input: VoiceCallInput) {
    if (await this.ctx.storage.get("call")) throw new HttpError(409, "Voice call already exists");
    const { sdp, ...options } = input;
    const { agent, provider, subject } = options;
    const services = await keyServices(this.env);
    const exists = await withSql(this.env, sql => sql.query("select 1 from agents where tenant=$1 and id=$2 and not revoked", [tenant, agent]));
    if (!exists.rowCount) throw new HttpError(404, "Unknown agent", "AGENT_NOT_FOUND");
    const openai = this.openai();
    if (provider !== "openai") throw new HttpError(400, "elevenlabs calls are not available on this runtime", "REALTIME_UNAVAILABLE");
    const model = options.model ?? openai.defaultModel;
    if (!openai.models.includes(model)) throw new HttpError(400, `Unknown OpenAI realtime model: ${model}`, "REALTIME_MODEL");
    const requested = options.voice ?? "alloy";
    const voice = [requested, REALTIME_VOICE_FOR[requested]].find(value => openai.voices.includes(value)) ?? openai.voices[0];
    if (!voicePrice(this.env, `openai/${model}`)) throw new HttpError(400, `No realtime price for openai/${model}`, "REALTIME_UNPRICED");
    identityInput(options);
    if (options.bucket !== undefined) options.bucket = bucketInput(options.bucket);
    const key = await mediaKey(this.env, tenant, options.keyScope, provider, services);
    if (!key?.apiKey) throw new HttpError(400, "No OpenAI key for voice calls: add one under Models & keys (PUT /v1/providers/openai/key)", "REALTIME_UNAVAILABLE");
    const maxMinutes = options.maxMinutes ?? VOICE_LIMITS.maxMinutes.default;
    const now = Date.now();
    const call: Call = { id, agent, provider, model, voice, subject, maxMinutes, state: "connecting",
      startedAt: null, endedAt: null, expiresAt: now + maxMinutes * 60_000, reason: null,
      turns: 0, asks: 0, audioSeconds: 0, costUsd: 0, speakers: options.speakers ?? {}, metadata: options.metadata ?? {} };
    const row: Row = { call, tenant, options, platform: key.platform, payer: await this.credits.enabled(tenant), seq: 0, lines: [] };
    await admitVoiceUsage(this.env, this.credits, row, services, true);
    await this.save(row);
    await transaction(this.env, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtext('voice-sessions:' || $1))", [tenant]);
      const limit = services.tenants.maxVoiceSessions(tenant) ?? Number(this.env.AGENT_VOICE_SESSIONS_PER_TENANT ?? VOICE_LIMITS.perTenant);
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid voice session limit");
      const live = Number((await sql.query("select count(*) from workers_voice_calls where tenant=$1 and state<>'ended'", [tenant])).rows[0].count);
      if (live >= limit) throw new HttpError(429, `This account has ${live} live voice sessions, its limit: end one first`, "VOICE_SESSION_LIMIT", { limit });
      await sql.query("insert into workers_voice_calls (id,tenant,agent,provider,state) values ($1,$2,$3,$4,'connecting')", [id, tenant, agent, provider]);
    }).catch(async error => {
      await this.ctx.storage.delete("call");
      await this.ctx.storage.deleteAlarm();
      throw error;
    });
    try {
      const connect = await openai.create({
        sdp: sdp!, model, voice, instructions: realtimeInstructions(options.instructions, { agent: true, group: true }),
        language: options.language, tools: [ASK_AGENT, STAY_SILENT], apiKey: key.apiKey,
      }, this.sidebandEvents());
      this.sideband = connect.sideband;
      row.providerCall = connect.callId;
      await this.started(row);
      return voiceJson({ ...call, connect: { sdpAnswer: connect.sdpAnswer } }, 201);
    } catch (error) {
      const detail = redactDetail(error instanceof Error ? error.message : String(error), 300, [key.apiKey]);
      await this.end(row, { reason: "error", detail }, true);
      throw new HttpError(502, detail, "REALTIME_FAILED");
    }
  }

  private async started(row: Row) {
    row.call.state = "live";
    row.call.startedAt = Date.now();
    await this.save(row);
    await this.index(row);
    await this.event(row, "voice.session.started", "", {});
  }

  private sidebandEvents(): SidebandEvents {
    return {
      responseStarted: id => this.background(async () => {
        const row = await this.row();
        if (row.call.state !== "live" || await this.ctx.storage.get(`response-start:${id}`) || await this.ctx.storage.get(`response:${id}`)) return;
        await this.ctx.storage.put(`response-start:${id}`, Date.now());
        try { await admitVoiceUsage(this.env, this.credits, row); }
        catch (error) {
          if (!(error instanceof HttpError) || error.status !== 402) throw error;
          const by: Ending = { reason: "budget" };
          if (error.code === "END_USER_CREDIT") Object.assign(by, { limit: "end_user", endUserReason: error.details?.reason, bucket: row.options.bucket ?? DEFAULT_BUCKET });
          await this.ctx.storage.put(`refused:${id}`, by);
        }
      }),
      responseDone: (id, { usage }) => this.background(async () => {
        const row = await this.row();
        if (row.call.state === "ended" || await this.ctx.storage.get(`response:${id}`)) return;
        const at = Date.now();
        const charge: VoiceCharge = { key: `voice_openai:${row.call.id}:${id}`,
          startedAt: await this.ctx.storage.get<number>(`response-start:${id}`) ?? at, at, usage, audioSeconds: usage.outputAudio / 20 };
        await this.ctx.storage.put(`charge:${id}`, charge);
        await this.arm(row);
        await this.settleResponse(row, id, charge);
      }),
      heard: (id, text, seconds) => this.background(async () => {
        const row = await this.row();
        if (row.call.state !== "live" || await this.ctx.storage.get(`heard:${id}`)) return;
        row.call.audioSeconds += seconds;
        if (text) await this.utterance(row, text, "unlabeled", { text, seconds, reported: "sideband" });
        await this.ctx.storage.put({ call: row, [`heard:${id}`]: true });
      }),
      said: (_id, text) => this.background(async () => {
        const row = await this.row();
        if (row.call.state === "live" && text) await this.queueNote(row, "assistant", text);
      }),
      toolCall: tool => this.background(async () => {
        if (!tool.id || await this.ctx.storage.get(`tool:${tool.id}`)) return;
        const row = await this.row();
        if (row.call.state !== "live") return;
        await this.ctx.storage.put(`tool:${tool.id}`, true);
        if (tool.name === "ask_agent") await this.ask(row, typeof tool.args.request === "string" ? tool.args.request : "", tool.id);
        else if (tool.name === "stay_silent") this.sideband?.toolResult(tool.id, '{"ok":true}');
        else {
          this.sideband?.toolResult(tool.id, JSON.stringify({ error: `No tool named ${tool.name}` }));
          this.sideband?.respond();
        }
      }),
      rateLimits: () => {},
      warning: () => {},
      closed: (_reason, detail) => this.background(async () => this.end(await this.row(), { reason: "error", detail }, true)),
    };
  }

  private async settleResponse(row: Row, id: string, charge: VoiceCharge) {
    if (!await this.ctx.storage.get(`response:${id}`)) {
      const cost = await recordVoiceUsage(this.env, this.credits, row, charge);
      row.call.turns++;
      row.call.costUsd += Math.round(cost * 1_000_000) / 1_000_000;
      await this.ctx.storage.put({ call: row, [`response:${id}`]: true });
    }
    const refused = await this.ctx.storage.get<Ending>(`refused:${id}`);
    if (refused && row.call.state === "live") await this.end(row, refused);
    await this.ctx.storage.delete([`charge:${id}`, `refused:${id}`, `response-start:${id}`]);
    await this.arm(row);
  }

  private async end(row: Row, by: Ending, providerClosed = false) {
    if (row.call.state === "ended") return row.call;
    if (row.call.state !== "ending") {
      row.call.state = "ending";
      row.ending = by;
      await this.save(row);
      await this.index(row);
    }
    if (row.providerCall) {
      try {
        const key = await mediaKey(this.env, row.tenant, row.options.keyScope, "openai", undefined, undefined, false);
        if (!key?.apiKey) throw new Error("No OpenAI key for hanging up the voice call");
        await this.openai().hangup(row.providerCall, key.apiKey);
      } catch (error) {
        if (!providerClosed) throw new HttpError(502, redactDetail(error instanceof Error ? error.message : String(error), 300), "REALTIME_FAILED");
      }
    }
    this.sideband?.close();
    this.sideband = undefined;
    return this.finish(row, row.ending ?? by);
  }

  private async finish(row: Row, by: Ending) {
    row.call.state = "ended";
    row.call.reason = by.reason;
    row.call.endedAt ??= Date.now();
    row.lines = [];
    const { startedAt, endedAt, turns, asks, audioSeconds, costUsd } = row.call;
    await this.event(row, "voice.session.ended", "", { ...by, startedAt, endedAt, turns, asks, audioSeconds, costUsd });
    await this.index(row);
    for (const controller of this.running.values()) controller.abort();
    await this.save(row);
    return row.call;
  }

  private async transcript(row: Row, input: VoiceTranscriptInput) {
    if (row.call.provider === "openai") throw new HttpError(409, "This call's transcripts come from the provider", "VOICE_TRANSCRIPT_SIDEBAND");
    if (row.call.state !== "live") throw new HttpError(409, "The voice call is not live");
    const { speaker, text, seconds, startedAt, endedAt } = input;
    const name = Object.hasOwn(row.call.speakers, speaker) ? row.call.speakers[speaker] : speaker;
    row.call.turns++;
    row.call.audioSeconds += seconds ?? 0;
    return this.utterance(row, text, name, { speakerId: speaker, text, seconds, startedAt, endedAt, reported: "client" });
  }

  private async utterance(row: Row, text: string, speaker: string, detail: Record<string, unknown>) {
    const seq = ++row.seq;
    const lines = (detail.reported === "client" ? `${speaker}: ${text}` : text).split(/\r?\n/).filter(Boolean);
    row.lines = [...row.lines, ...lines.map(line => line.slice(-2000))].slice(-20);
    while (row.lines.length > 1 && row.lines.join("\n").length > 2000) row.lines.shift();
    await this.queueNote(row, speaker, text);
    await this.event(row, "voice.utterance", String(seq), { ...detail, seq });
    return { seq };
  }

  private async queueNote(row: Row, speaker: string, text: string) {
    row.noteSeq = (row.noteSeq ?? 0) + 1;
    const id = String(row.noteSeq).padStart(12, "0");
    row.noteAt ??= Date.now() + NOTE_MS;
    await this.ctx.storage.put({ call: row, [`note:${id}`]: `[Voice call ${row.call.id}, ${speaker}] ${text}` });
    await this.arm(row);
  }

  private async flushNotes(row: Row) {
    let keys = await this.ctx.storage.get<string[]>("note-batch");
    if (!keys) {
      keys = [...(await this.ctx.storage.list({ prefix: "note:", limit: 100 })).keys()];
      if (keys.length) await this.ctx.storage.put("note-batch", keys);
    }
    if (keys.length) {
      const notes = await this.ctx.storage.get<string>(keys);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([row.call.id, keys])));
      const id = "voice_note_" + Buffer.from(digest).toString("hex");
      const owned = await withSql(this.env, sql => sql.query("select 1 from agents where tenant=$1 and id=$2 and not revoked", [row.tenant, row.call.agent]));
      if (owned.rowCount) await this.env.AGENTS.getByName(row.call.agent).note(row.tenant, id, [...notes.values()].join("\n"));
      await this.ctx.storage.delete([...keys, "note-batch"]);
    }
    row.noteAt = (await this.ctx.storage.list({ prefix: "note:", limit: 1 })).size ? Date.now() + NOTE_MS : undefined;
  }

  private async ask(row: Row, request: string, tool?: string, answer?: PromiseWithResolvers<ToolAnswer>) {
    const ask: Ask = { n: ++row.call.asks, started: Date.now(), request, tool, pending: false };
    const lines = row.lines;
    row.lines = [];
    await this.ctx.storage.put({ call: row, [`ask:${ask.n}`]: ask });
    await this.event(row, "voice.agent.asked", String(ask.n), { request: request.slice(0, 300) });
    if (answer) this.answers.set(ask.n, answer);
    const controller = new AbortController();
    this.running.set(ask.n, controller);
    await this.arm(row);
    const payer = await this.credits.enabled(row.tenant) ? { endUser: row.call.subject, bucket: row.options.bucket } : {};
    this.ctx.waitUntil(streamVoiceReply(this.env, row.call, ask, lines, payer, controller.signal).then(result =>
      this.serial(async () => this.reply(await this.row(), ask.n, result.outcome, result.reply)),
    ).catch(() => console.error("voice_call_ask_failed")));
  }

  private async reply(row: Row, n: number, outcome: "ok" | "empty" | "error" | "timeout", reply: string) {
    const key = `ask:${n}`;
    const ask = await this.ctx.storage.get<Ask>(key);
    if (!ask) return;
    this.running.get(n)?.abort();
    this.running.delete(n);
    const answer = this.answers.get(n);
    this.answers.delete(n);
    const ok = outcome === "ok";
    const said = reply || EMPTY_REPLY;
    const result = ok ? { reply: said } : { error: outcome === "empty" ? EMPTY_REQUEST : ASK_FAILED };
    if (row.call.state !== "ended") {
      if (!ask.pending) {
        answer?.resolve(result);
        if (ask.tool) {
          this.sideband?.toolResult(ask.tool, JSON.stringify(result));
          this.sideband?.respond();
        }
      } else if (ask.tool && outcome !== "timeout") {
        this.sideband?.note(ok ? lateReply(ask.request, said) : lateFailure(ask.request));
        this.sideband?.respond(ok ? LATE_REPLY : LATE_FAILURE);
      }
      await this.event(row, "voice.agent.replied", String(n), { outcome, ms: Date.now() - ask.started, late: ask.pending, replyChars: reply.length,
        ...(ask.pending && !ask.tool && outcome !== "timeout" ? { reply: ok ? said : ASK_FAILED } : {}) });
    } else answer?.resolve({ error: ASK_FAILED });
    await this.ctx.storage.delete(key);
    await this.arm(row);
  }

  private async arm(row: Row) {
    const { state, expiresAt } = row.call;
    const next = [row.noteAt ?? Infinity];
    if (state === "live" || state === "connecting") next.push(expiresAt);
    if (state === "ending") next.push(Date.now() + 1000);
    for (const ask of (await this.ctx.storage.list<Ask>({ prefix: "ask:" })).values()) next.push(ask.started + (ask.pending ? LATE_MS : PENDING_MS));
    if ((await this.ctx.storage.list({ prefix: "charge:", limit: 1 })).size) next.push(Date.now() + 1000);
    const at = Math.min(...next);
    if (Number.isFinite(at)) await this.ctx.storage.setAlarm(at);
    else await this.ctx.storage.deleteAlarm();
  }

  alarm() {
    return this.serial(async () => {
      try { await this.sweep(); }
      catch (error) {
        await this.ctx.storage.setAlarm(Date.now() + 5_000);
        throw error;
      }
    });
  }

  private async sweep() {
    const row = await this.ctx.storage.get<Row>("call");
    if (!row) return;
    const now = Date.now();
    if (row.noteAt !== undefined && row.noteAt <= now) {
      await this.flushNotes(row);
      await this.save(row);
    }
    for (const [key, ask] of await this.ctx.storage.list<Ask>({ prefix: "ask:" })) {
      if (now >= ask.started + LATE_MS || row.call.state === "ended") await this.reply(row, ask.n, "timeout", "");
      else if (!ask.pending && now >= ask.started + PENDING_MS) {
        await this.ctx.storage.put(key, { ...ask, pending: true });
        this.answers.get(ask.n)?.resolve({ reply: PENDING });
        if (ask.tool) {
          this.sideband?.toolResult(ask.tool, JSON.stringify({ pending: PENDING }));
          this.sideband?.respond();
        }
      }
    }
    for (const [key, charge] of await this.ctx.storage.list<VoiceCharge>({ prefix: "charge:" }))
      await this.settleResponse(row, key.slice("charge:".length), charge);
    if (row.call.state === "live" && row.call.provider === "openai" && !this.sideband && row.call.expiresAt > now)
      await this.end(row, { reason: "error", detail: "The realtime connection closed" }, true);
    if (row.call.state === "live" && row.call.expiresAt <= now) await this.end(row, { reason: "max_duration" }, true);
    if (row.call.state === "connecting" && row.call.expiresAt <= now)
      await this.finish(row, { reason: "error", detail: "The call did not connect" });
    if (row.call.state === "ending" && row.call.provider === "openai") await this.end(row, row.ending ?? { reason: "error" }, true);
    await this.arm(row);
  }
}

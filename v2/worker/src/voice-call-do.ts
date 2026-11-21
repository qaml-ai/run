import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import { redactDetail } from "../../../src/voice-providers/socket.ts";
import { NO_USAGE, REALTIME_VOICE_FOR, realtimePrice, type RealtimeUsage } from "../../../src/voice/realtime/provider.ts";
import { getAgentStub } from "./agent-do.ts";
import { getTenantStub } from "./tenant-do.ts";
import { ApiError, type Env, type RpcStub } from "./types.ts";
import { enqueueWebhookEvent } from "./webhooks.ts";
import {
  elevenlabsCalls,
  terminationReasonToEnd,
  VOICE_ELEVENLABS_INDEX_DO_NAME,
  type ElevenLabsPostCall,
} from "./voice/elevenlabs.ts";
import { openaiCalls, type Sideband, type SidebandEvents } from "./voice/openai.ts";
import {
  ASK_AGENT,
  ASK_FAILED,
  askPrompt,
  EMPTY_REPLY,
  EMPTY_REQUEST,
  LATE_FAILURE,
  LATE_REPLY,
  lateFailure,
  lateReply,
  PENDING,
  realtimeInstructions,
  STAY_SILENT,
} from "./voice/prompts.ts";
import {
  VOICE_LIMITS,
  type VoiceCall as Call,
  type VoiceCallInput,
  type VoiceCallUpdate,
  type VoiceTranscriptInput,
} from "./voice/schema.ts";

type Ending = { reason: string; detail?: string };
type ToolAnswer = { ok: true } | { reply: string } | { error: string };
type Ask = { n: number; started: number; request: string; tool?: string; pending: boolean };
type VoiceCharge = {
  key: string;
  startedAt: number;
  at: number;
  usage: RealtimeUsage;
  audioSeconds: number;
  deadline?: boolean;
  duration?: number;
};

type Row = {
  call: Call;
  tenant: string;
  v2AgentId: string;
  options: Omit<VoiceCallInput, "sdp">;
  providerCall?: string;
  providerAgent?: string;
  platform: boolean;
  seq: number;
  noteSeq?: number;
  lines: string[];
  noteAt?: number;
  ending?: Ending;
};

const PENDING_MS = 45_000;
const LATE_MS = 300_000;
const GRACE_MS = 900_000;
const NOTE_MS = 2_000;

export function getVoiceCallStub(env: Env, callId: string): RpcStub<VoiceCallDO> {
  if (!env.VOICE_CALL_DO) {
    throw new ApiError(503, "voice_unavailable", "Voice calls are not configured on this runtime");
  }
  return env.VOICE_CALL_DO.get(env.VOICE_CALL_DO.idFromName(callId)) as unknown as RpcStub<VoiceCallDO>;
}

export function equalVoiceSecret(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function voicePrice(env: Env, reference: string) {
  return realtimePrice(reference, env as unknown as NodeJS.ProcessEnv);
}

function computeVoiceCost(
  env: Env,
  provider: string,
  model: string,
  charge: VoiceCharge,
): number {
  const rate = voicePrice(env, `${provider}/${model}`);
  if (!rate) return 0;
  const { usage, audioSeconds, duration } = charge;
  if ("perMinute" in rate) {
    return ((duration ?? audioSeconds) * rate.perMinute) / 60 / 1_000_000;
  }
  return (
    Math.max(
      0,
      (usage.inputText - usage.cachedText) * rate.inputText +
        usage.cachedText * rate.cachedText +
        (usage.inputAudio - usage.cachedAudio) * rate.inputAudio +
        usage.cachedAudio * rate.cachedAudio +
        usage.outputText * rate.outputText +
        usage.outputAudio * rate.outputAudio,
    ) / 1e12
  );
}

export class VoiceCallDO extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();
  private sideband?: Sideband;
  private readonly answers = new Map<number, PromiseWithResolvers<ToolAnswer>>();
  private readonly running = new Map<number, AbortController>();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }

  private background(fn: () => Promise<unknown>): void {
    this.ctx.waitUntil(this.serial(fn).catch(() => console.error("voice_call_operation_failed")));
  }

  private async readRow(tenant?: string): Promise<Row> {
    const row = await this.ctx.storage.get<Row>("call");
    if (!row || (tenant !== undefined && row.tenant !== tenant)) {
      throw new ApiError(404, "voice_call_not_found", "Voice call not found");
    }
    return row;
  }

  private async save(row: Row): Promise<void> {
    await this.ctx.storage.put("call", row);
    await this.arm(row);
  }

  private openai() {
    return openaiCalls({ baseUrl: this.env.VOICE_OPENAI_BASE_URL });
  }

  private eleven(origin = "") {
    return elevenlabsCalls(this.env, origin);
  }

  private async emitEvent(row: Row, event: string, data: Record<string, unknown>): Promise<void> {
    await enqueueWebhookEvent(this.env, row.tenant, event, {
      provider: row.call.provider,
      session: row.call.id,
      agent: row.call.agent,
      subject: row.call.subject,
      metadata: row.call.metadata,
      ...data,
    });
  }

  private async syncIndex(row: Row): Promise<void> {
    await getTenantStub(this.env, row.tenant).updateVoiceCallIndex({
      id: row.call.id,
      state: row.call.state,
      providerCall: row.providerCall ?? null,
    });
    if (row.call.provider === "elevenlabs" && row.providerCall) {
      await getTenantStub(this.env, VOICE_ELEVENLABS_INDEX_DO_NAME).upsertElevenLabsConversation({
        providerCall: row.providerCall,
        callId: row.call.id,
        tenantId: row.tenant,
        state: row.call.state,
      });
    }
  }

  private async resolveProviderKey(
    tenant: string,
    provider: "openai" | "elevenlabs",
    keyScope?: string,
  ): Promise<{ apiKey: string; platform: boolean } | null> {
    const tenantStub = getTenantStub(this.env, tenant);
    const cred = await tenantStub.getProviderSecret(provider, keyScope);
    if (cred?.apiKey) return { apiKey: cred.apiKey, platform: false };
    if (keyScope) return null;
    const platformKey = provider === "openai" ? this.env.OPENAI_API_KEY : this.env.ELEVENLABS_API_KEY;
    if (platformKey) return { apiKey: platformKey, platform: true };
    return null;
  }

  private async recordCharge(row: Row, charge: VoiceCharge): Promise<number> {
    const { tenant, call } = row;
    const cost = computeVoiceCost(this.env, call.provider, call.model, charge);
    const inputTokens = charge.usage.inputText + charge.usage.inputAudio;
    const outputTokens = charge.usage.outputText + charge.usage.outputAudio;
    const tenantStub = getTenantStub(this.env, tenant);
    await tenantStub
      .settleUsage({
        refId: charge.key,
        model: `${call.provider}/${call.model}`,
        inputTokens,
        outputTokens,
        vmMs: 0,
        costUsd: row.platform ? cost : 0,
        note: `voice:${call.id}`,
      })
      .catch(() => {});
    await this.emitEvent(row, "usage.recorded", {
      agentId: row.v2AgentId,
      actor: call.subject,
      model: `${call.provider}/${call.model}`,
      kind: "speech",
      input: inputTokens,
      output: outputTokens,
      audioSeconds: charge.audioSeconds,
      cost: { usd: cost, source: "realtime" },
      context: { ...(row.options.context ?? {}), voiceCall: call.id },
    });
    return cost;
  }

  async createCall(input: {
    id: string;
    tenant: string;
    v2AgentId: string;
    options: VoiceCallInput;
    origin: string;
  }): Promise<{ call: Call; connect: { sdpAnswer: string } | { signedUrl: string; conversationId: string }; onceSecret?: boolean }> {
    return this.serial(async () => {
      if (await this.ctx.storage.get("call")) {
        throw new ApiError(409, "voice_call_exists", "Voice call already exists");
      }
      const { id, tenant, v2AgentId, origin } = input;
      const { sdp, ...options } = input.options;
      const { agent, provider, subject } = options;

      const openai = this.openai();
      const eleven = provider === "elevenlabs" ? this.eleven(origin) : undefined;
      const model = options.model ?? (eleven ?? openai).defaultModel;
      const validModel = eleven ? /^[a-zA-Z0-9._-]{1,100}$/.test(model) : openai.models.includes(model);
      if (!validModel) {
        throw new ApiError(
          400,
          "realtime_model",
          eleven ? "Invalid ElevenLabs realtime model" : `Unknown OpenAI realtime model: ${model}`,
        );
      }
      if (eleven && options.voice !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(options.voice)) {
        throw new ApiError(400, "realtime_voice", "Invalid ElevenLabs voice ID");
      }
      const requested = options.voice ?? "alloy";
      const voice = eleven
        ? eleven.voiceFor[requested] ?? requested
        : [requested, REALTIME_VOICE_FOR[requested]].find((value) => openai.voices.includes(value)) ?? openai.voices[0];

      if (!voicePrice(this.env, `${provider}/${model}`)) {
        throw new ApiError(
          400,
          "realtime_unpriced",
          eleven
            ? `Realtime model elevenlabs/${model} has no price configured`
            : `No realtime price for openai/${model}`,
        );
      }

      const key = await this.resolveProviderKey(tenant, provider, options.keyScope);
      if (eleven && key && !key.platform) {
        throw new ApiError(
          400,
          "realtime_unavailable",
          "ElevenLabs calls run on the platform's ElevenLabs key; your own key is not used for them yet",
        );
      }
      if (!key?.apiKey) {
        throw new ApiError(
          400,
          "realtime_unavailable",
          eleven
            ? "No platform ElevenLabs key for voice calls"
            : "No OpenAI key for voice calls: configure an OpenAI provider key",
        );
      }

      const maxMinutes = eleven
        ? Math.min(options.maxMinutes ?? 30, 30)
        : options.maxMinutes ?? VOICE_LIMITS.maxMinutes.default;
      const now = Date.now();
      const call: Call = {
        id,
        agent,
        provider,
        model,
        voice,
        subject,
        maxMinutes,
        state: "connecting",
        startedAt: null,
        endedAt: null,
        expiresAt: now + maxMinutes * 60_000,
        reason: null,
        turns: 0,
        asks: 0,
        audioSeconds: 0,
        costUsd: 0,
        speakers: options.speakers ?? {},
        metadata: options.metadata ?? {},
      };
      const row: Row = {
        call,
        tenant,
        v2AgentId,
        options,
        platform: key.platform,
        seq: 0,
        lines: [],
      };

      const limit = Number(this.env.AGENT_VOICE_SESSIONS_PER_TENANT ?? VOICE_LIMITS.perTenant);
      const reservation = await getTenantStub(this.env, tenant).reserveVoiceCall({
        id,
        agentId: v2AgentId,
        provider,
        limit: Number.isSafeInteger(limit) && limit >= 0 ? limit : VOICE_LIMITS.perTenant,
      });
      if (!reservation.ok) {
        throw new ApiError(429, "voice_session_limit", "Too many concurrent voice calls for this tenant");
      }

      await this.save(row);

      const instructions = realtimeInstructions(options.instructions, {
        agent: true,
        group: true,
        forYouFirst: provider === "elevenlabs",
      });

      try {
        if (eleven) {
          const provisioned = await eleven.provision({
            apiKey: key.apiKey,
            model,
            instructions,
            language: options.language,
            voiceId: voice,
          });
          const signed = await eleven.signedUrl({
            apiKey: key.apiKey,
            agentId: provisioned.agentId,
          });
          row.providerAgent = provisioned.agentId;
          row.providerCall = signed.conversationId;
          row.call.state = "live";
          row.call.startedAt = Date.now();
          await this.save(row);
          await this.syncIndex(row);
          await this.emitEvent(row, "voice.session.started", { startedAt: row.call.startedAt });
          return {
            call: row.call,
            connect: { signedUrl: signed.signedUrl, conversationId: signed.conversationId },
            onceSecret: true,
          };
        }

        const created = await openai.create(
          {
            sdp: sdp!,
            model,
            voice,
            instructions,
            language: options.language,
            interruptResponse: options.interruptResponse ?? true,
            tools: [ASK_AGENT, STAY_SILENT],
            apiKey: key.apiKey,
          },
          this.sidebandEvents(),
        );
        this.sideband = created.sideband;
        row.providerCall = created.callId;
        row.call.state = "live";
        row.call.startedAt = Date.now();
        await this.save(row);
        await this.syncIndex(row);
        await this.emitEvent(row, "voice.session.started", { startedAt: row.call.startedAt });
        return {
          call: row.call,
          connect: { sdpAnswer: created.sdpAnswer },
        };
      } catch (error) {
        const detail = redactDetail(error instanceof Error ? error.message : String(error), 300, [key.apiKey]);
        await this.finish(row, { reason: "error", detail });
        throw new ApiError(502, "realtime_failed", detail);
      }
    });
  }

  async getCall(tenant: string): Promise<Call> {
    return this.serial(async () => (await this.readRow(tenant)).call);
  }

  async updateCall(tenant: string, patch: VoiceCallUpdate): Promise<Call> {
    return this.serial(async () => {
      const row = await this.readRow(tenant);
      if (patch.speakers !== undefined) row.call.speakers = patch.speakers;
      if (patch.metadata !== undefined) row.call.metadata = patch.metadata;
      await this.save(row);
      return row.call;
    });
  }

  async endCall(tenant: string, reason = "requested"): Promise<Call> {
    return this.serial(async () => {
      const row = await this.readRow(tenant);
      return this.end(row, { reason });
    });
  }

  async recordTranscript(tenant: string, input: VoiceTranscriptInput): Promise<{ seq: number }> {
    return this.serial(async () => {
      const row = await this.readRow(tenant);
      if (row.call.provider === "openai") {
        throw new ApiError(409, "voice_transcript_sideband", "This call's transcripts come from the provider");
      }
      if (row.call.state !== "live") {
        throw new ApiError(409, "voice_call_not_live", "The voice call is not live");
      }
      const { speaker, text, seconds, startedAt, endedAt } = input;
      const name = Object.hasOwn(row.call.speakers, speaker) ? row.call.speakers[speaker] : speaker;
      row.call.turns++;
      row.call.audioSeconds += seconds ?? 0;
      const result = await this.utterance(row, text, name, {
        speakerId: speaker,
        text,
        seconds,
        startedAt,
        endedAt,
        reported: "client",
      });
      await this.save(row);
      return result;
    });
  }

  private sidebandEvents(): SidebandEvents {
    return {
      responseStarted: (id) =>
        this.background(async () => {
          await this.ctx.storage.put(`response-start:${id}`, Date.now());
        }),
      responseDone: (id, outcome) =>
        this.background(async () => {
          const row = await this.readRow();
          const at = Date.now();
          const charge: VoiceCharge = {
            key: `voice_realtime:${row.call.id}:${id}`,
            startedAt: (await this.ctx.storage.get<number>(`response-start:${id}`)) ?? at,
            at,
            usage: outcome.usage,
            audioSeconds: outcome.usage.outputAudio / 20,
          };
          await this.ctx.storage.put(`charge:${id}`, charge);
          await this.arm(row);
          await this.settleResponse(row, id, charge);
        }),
      heard: (id, text, seconds) =>
        this.background(async () => {
          const row = await this.readRow();
          if (row.call.state !== "live" || (await this.ctx.storage.get(`heard:${id}`))) return;
          row.call.audioSeconds += seconds;
          if (text) await this.utterance(row, text, "unlabeled", { text, seconds, reported: "sideband" });
          await this.ctx.storage.put({ call: row, [`heard:${id}`]: true });
        }),
      said: (_id, text) =>
        this.background(async () => {
          const row = await this.readRow();
          if (row.call.state === "live" && text) await this.queueNote(row, "assistant", text);
        }),
      toolCall: (tool) =>
        this.background(async () => {
          if (!tool.id || (await this.ctx.storage.get(`tool:${tool.id}`))) return;
          const row = await this.readRow();
          if (row.call.state !== "live") return;
          await this.ctx.storage.put(`tool:${tool.id}`, true);
          if (tool.name === "ask_agent") {
            await this.ask(row, typeof tool.args.request === "string" ? tool.args.request : "", tool.id);
          } else if (tool.name === "stay_silent") {
            this.sideband?.toolResult(tool.id, '{"ok":true}');
          } else {
            this.sideband?.toolResult(tool.id, JSON.stringify({ error: `No tool named ${tool.name}` }));
            this.sideband?.respond();
          }
        }),
      rateLimits: () => {},
      warning: () => {},
      closed: (_reason, detail) =>
        this.background(async () => {
          const row = await this.ctx.storage.get<Row>("call");
          if (row) await this.end(row, { reason: "error", detail }, true);
        }),
    };
  }

  private async settleResponse(row: Row, id: string, charge: VoiceCharge): Promise<void> {
    if (!(await this.ctx.storage.get(`response:${id}`))) {
      const cost = await this.recordCharge(row, charge);
      row.call.turns++;
      row.call.costUsd = Math.round((row.call.costUsd + cost) * 1_000_000) / 1_000_000;
      await this.ctx.storage.put({ call: row, [`response:${id}`]: true });
    }
    await this.ctx.storage.delete([`charge:${id}`, `response-start:${id}`]);
    await this.arm(row);
  }

  async elevenTool(tool: string, request: string, secret: string): Promise<ToolAnswer | undefined> {
    const answer = Promise.withResolvers<ToolAnswer>();
    const awaiting = await this.serial(async () => {
      const row = await this.ctx.storage.get<Row>("call");
      if (!row || row.call.state !== "live" || !row.providerAgent || (tool !== "ask_agent" && tool !== "stay_silent")) {
        return false;
      }
      const agent = await this.eleven().agentFor(row.providerAgent);
      if (!agent || !equalVoiceSecret(Buffer.from(secret), Buffer.from(agent.toolSecret))) {
        return false;
      }
      if (tool === "stay_silent") answer.resolve({ ok: true });
      else await this.ask(row, request, undefined, answer);
      return true;
    });
    if (awaiting) return answer.promise;
    return undefined;
  }

  async postCall(event: ElevenLabsPostCall): Promise<void> {
    return this.serial(async () => {
      const row = await this.ctx.storage.get<Row>("call");
      if (!row) return;
      const { data } = event;
      if (row.call.state === "ended" || row.providerAgent !== data.agent_id || row.providerCall !== data.conversation_id) {
        return;
      }
      if (event.type === "call_initiation_failure") {
        await this.finish(row, {
          reason: "error",
          detail: typeof data.failure_reason === "string" ? redactDetail(data.failure_reason, 300) : undefined,
        });
        return;
      }
      const reported = data.metadata?.call_duration_secs;
      const duration = typeof reported === "number" && Number.isFinite(reported) ? Math.max(0, reported) : undefined;
      const details = duration === undefined ? await this.conversation(row) : undefined;
      const seconds = duration ?? details?.durationSeconds ?? this.elapsed(row, Date.now());
      const termination =
        typeof data.metadata?.termination_reason === "string"
          ? data.metadata.termination_reason
          : details?.terminationReason ?? "";
      if (!row.call.turns && Array.isArray(data.transcript)) {
        for (const entry of data.transcript as Array<{ role?: string; message?: unknown; time_in_call_secs?: number }>) {
          if (entry?.role !== "user" || typeof entry.message !== "string") continue;
          row.call.turns++;
          await this.utterance(row, entry.message, "unlabeled", {
            text: entry.message,
            reported: "provider",
            secondsIntoCall: entry.time_in_call_secs,
          });
        }
      }
      await this.settleEleven(row, seconds, row.ending ?? { reason: terminationReasonToEnd(termination) });
    });
  }

  private elapsed(row: Row, end: number): number {
    return Math.max(0, ((row.call.endedAt ?? end) - (row.call.startedAt ?? row.call.expiresAt)) / 1000);
  }

  private async conversation(row: Row) {
    if (!row.providerCall) return undefined;
    try {
      const key = await this.resolveProviderKey(row.tenant, "elevenlabs", row.options.keyScope);
      if (key?.platform) return await this.eleven().conversation(key.apiKey, row.providerCall);
    } catch {
      // Fallback to elapsed duration
    }
    return undefined;
  }

  private async settleEleven(row: Row, seconds: number, by: Ending, deadline = false): Promise<void> {
    const at = Date.now();
    const chargeKey = "eleven-charge";
    let settlement = await this.ctx.storage.get<{ charge: VoiceCharge; by: Ending }>(chargeKey);
    if (!settlement) {
      settlement = {
        by,
        charge: {
          key: `voice_elevenlabs:${row.call.id}`,
          startedAt: row.call.startedAt ?? at,
          at,
          usage: { ...NO_USAGE },
          audioSeconds: deadline ? seconds : Math.ceil(seconds),
          duration: seconds,
          deadline,
        },
      };
      await this.ctx.storage.put(chargeKey, settlement);
      await this.arm(row);
    }
    await this.commitEleven(row, settlement);
  }

  private async commitEleven(row: Row, settlement: { charge: VoiceCharge; by: Ending }): Promise<void> {
    const cost = await this.recordCharge(row, settlement.charge);
    row.call.audioSeconds = settlement.charge.audioSeconds;
    row.call.costUsd = Math.round(cost * 1_000_000) / 1_000_000;
    await this.finish(row, settlement.by);
    await this.ctx.storage.delete("eleven-charge");
    await this.arm(row);
  }

  private async end(row: Row, by: Ending, providerClosed = false): Promise<Call> {
    if (row.call.state === "ended") return row.call;
    if (row.call.state !== "ending") {
      row.call.state = "ending";
      row.ending = by;
      if (row.call.provider === "elevenlabs") {
        row.call.reason = by.reason;
        row.call.endedAt = by.reason === "max_duration" ? row.call.expiresAt : Date.now();
      }
      await this.save(row);
      await this.syncIndex(row);
    }
    if (row.call.provider === "elevenlabs") return row.call;
    if (row.providerCall) {
      try {
        const key = await this.resolveProviderKey(row.tenant, "openai", row.options.keyScope);
        if (!key?.apiKey) throw new Error("No OpenAI key for hanging up the voice call");
        await this.openai().hangup(row.providerCall, key.apiKey);
      } catch (error) {
        if (!providerClosed) {
          throw new ApiError(
            502,
            "realtime_failed",
            redactDetail(error instanceof Error ? error.message : String(error), 300),
          );
        }
      }
    }
    this.sideband?.close();
    this.sideband = undefined;
    return this.finish(row, row.ending ?? by);
  }

  private async finish(row: Row, by: Ending): Promise<Call> {
    row.call.state = "ended";
    row.call.reason = by.reason;
    row.call.endedAt ??= Date.now();
    row.lines = [];
    const { startedAt, endedAt, turns, asks, audioSeconds, costUsd } = row.call;
    await this.emitEvent(row, "voice.session.ended", {
      ...by,
      startedAt,
      endedAt,
      turns,
      asks,
      audioSeconds,
      costUsd,
    });
    await this.syncIndex(row);
    for (const controller of this.running.values()) controller.abort();
    await this.save(row);
    return row.call;
  }

  private async utterance(
    row: Row,
    text: string,
    speaker: string,
    detail: Record<string, unknown>,
  ): Promise<{ seq: number }> {
    const seq = ++row.seq;
    const lines = (detail.reported === "client" ? `${speaker}: ${text}` : text).split(/\r?\n/).filter(Boolean);
    row.lines = [...row.lines, ...lines.map((line) => line.slice(-2000))].slice(-20);
    while (row.lines.length > 1 && row.lines.join("\n").length > 2000) row.lines.shift();
    await this.queueNote(row, speaker, text);
    await this.emitEvent(row, "voice.utterance", { ...detail, seq });
    return { seq };
  }

  private async queueNote(row: Row, speaker: string, text: string): Promise<void> {
    row.noteSeq = (row.noteSeq ?? 0) + 1;
    const id = String(row.noteSeq).padStart(12, "0");
    row.noteAt ??= Date.now() + NOTE_MS;
    await this.ctx.storage.put({ call: row, [`note:${id}`]: `[Voice call ${row.call.id}, ${speaker}] ${text}` });
    await this.arm(row);
  }

  private async flushNotes(row: Row): Promise<void> {
    const notes = await this.ctx.storage.list<string>({ prefix: "note:" });
    row.noteAt = undefined;
    if (!notes.size) return;
    const keys = [...notes.keys()];
    const text = [...notes.values()].join("\n");
    try {
      await getAgentStub(this.env, row.v2AgentId).appendPassiveNote(text, {
        voiceCall: row.call.id,
        via: "voice_note",
      });
      await this.ctx.storage.delete(keys);
    } catch {
      row.noteAt = Date.now() + 5_000;
    }
  }

  private async ask(
    row: Row,
    request: string,
    tool?: string,
    answer?: PromiseWithResolvers<ToolAnswer>,
  ): Promise<void> {
    const cleaned = request.trim();
    const n = ++row.call.asks;
    const started = Date.now();
    const ask: Ask = { n, started, request: cleaned, tool, pending: false };
    await this.ctx.storage.put({ call: row, [`ask:${n}`]: ask });
    if (answer) this.answers.set(n, answer);
    await this.arm(row);
    if (!cleaned) {
      await this.reply(row, n, "empty", "");
      return;
    }
    const controller = new AbortController();
    this.running.set(n, controller);
    const recent = row.lines.length ? `[Recent voice transcript]\n${row.lines.join("\n")}\n\n` : "";
    const prompt = recent + askPrompt(cleaned);
    const v2AgentId = row.v2AgentId;
    const subject = row.call.subject;
    const callId = row.call.id;
    const keyScope = row.options.keyScope;

    this.ctx.waitUntil(
      this.runAgentAsk({ v2AgentId, callId, n, prompt, actor: subject, keyScope }, controller.signal)
        .then((result) =>
          this.serial(async () => {
            const current = await this.ctx.storage.get<Row>("call");
            if (current) await this.reply(current, n, result.outcome, result.reply);
          }),
        )
        .catch(() => console.error("voice_call_ask_failed")),
    );
  }

  private async runAgentAsk(
    input: {
      v2AgentId: string;
      callId: string;
      n: number;
      prompt: string;
      actor: string;
      keyScope?: string;
    },
    signal: AbortSignal,
  ): Promise<{ outcome: "ok" | "error" | "timeout"; reply: string }> {
    try {
      const stub = getAgentStub(this.env, input.v2AgentId);
      const started = await stub.startRun({
        prompt: input.prompt,
        actor: input.actor,
        idempotencyKey: `voice-ask:${input.callId}:${input.n}`,
        whileRunning: "queue",
        wait: false,
        ...(input.keyScope ? { keyScope: input.keyScope } : {}),
      });
      const runId = started.id;
      let current = started;
      const deadline = Date.now() + LATE_MS;
      while (Date.now() < deadline && !signal.aborted) {
        if (current.status === "completed") {
          const text = (current.finalText ?? "").slice(0, 4000).trim();
          return { outcome: "ok", reply: text };
        }
        if (current.status === "failed" || current.status === "cancelled" || current.status === "input_required") {
          return { outcome: "error", reply: "" };
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (signal.aborted) break;
        current = await stub.getRun(runId);
      }
      return { outcome: signal.aborted ? "timeout" : "timeout", reply: "" };
    } catch {
      return { outcome: signal.aborted ? "timeout" : "error", reply: "" };
    }
  }

  private async reply(
    row: Row,
    n: number,
    outcome: "ok" | "empty" | "error" | "timeout",
    reply: string,
  ): Promise<void> {
    const key = `ask:${n}`;
    const ask = await this.ctx.storage.get<Ask>(key);
    if (!ask) return;
    this.running.get(n)?.abort();
    this.running.delete(n);
    const answer = this.answers.get(n);
    this.answers.delete(n);
    const ok = outcome === "ok";
    const said = reply || EMPTY_REPLY;
    const result: ToolAnswer = ok
      ? { reply: said }
      : { error: outcome === "empty" ? EMPTY_REQUEST : ASK_FAILED };
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
      await this.emitEvent(row, "voice.agent.replied", {
        ask: n,
        outcome,
        ms: Date.now() - ask.started,
        late: ask.pending,
        replyChars: reply.length,
        ...(ask.pending && !ask.tool && outcome !== "timeout" ? { reply: ok ? said : ASK_FAILED } : {}),
      });
    } else {
      answer?.resolve({ error: ASK_FAILED });
    }
    await this.ctx.storage.delete(key);
    await this.arm(row);
  }

  private async arm(row: Row): Promise<void> {
    const { state, expiresAt, endedAt } = row.call;
    const next = [row.noteAt ?? Infinity];
    if (state === "live" || state === "connecting") next.push(expiresAt);
    if (state === "ending") {
      next.push(row.call.provider === "elevenlabs" ? (endedAt ?? expiresAt) + GRACE_MS : Date.now() + 1000);
    }
    for (const ask of (await this.ctx.storage.list<Ask>({ prefix: "ask:" })).values()) {
      next.push(ask.started + (ask.pending ? LATE_MS : PENDING_MS));
    }
    if (
      (await this.ctx.storage.list({ prefix: "charge:", limit: 1 })).size ||
      (await this.ctx.storage.get("eleven-charge"))
    ) {
      next.push(Date.now() + 1000);
    }
    const at = Math.min(...next);
    if (Number.isFinite(at)) await this.ctx.storage.setAlarm(at);
    else await this.ctx.storage.deleteAlarm();
  }

  override alarm(): Promise<void> {
    return this.serial(async () => {
      try {
        await this.sweep();
      } catch (error) {
        await this.ctx.storage.setAlarm(Date.now() + 5_000);
        throw error;
      }
    });
  }

  private async sweep(): Promise<void> {
    const row = await this.ctx.storage.get<Row>("call");
    if (!row) return;
    const now = Date.now();
    if (row.noteAt !== undefined && row.noteAt <= now) {
      await this.flushNotes(row);
      await this.save(row);
    }
    for (const [key, ask] of await this.ctx.storage.list<Ask>({ prefix: "ask:" })) {
      if (now >= ask.started + LATE_MS || row.call.state === "ended") {
        await this.reply(row, ask.n, "timeout", "");
      } else if (!ask.pending && now >= ask.started + PENDING_MS) {
        await this.ctx.storage.put(key, { ...ask, pending: true });
        this.answers.get(ask.n)?.resolve({ reply: PENDING });
        if (ask.tool) {
          this.sideband?.toolResult(ask.tool, JSON.stringify({ pending: PENDING }));
          this.sideband?.respond();
        }
      }
    }
    for (const [key, charge] of await this.ctx.storage.list<VoiceCharge>({ prefix: "charge:" })) {
      await this.settleResponse(row, key.slice("charge:".length), charge);
    }
    if (row.call.state === "live" && row.call.provider === "openai" && !this.sideband && row.call.expiresAt > now) {
      await this.end(row, { reason: "error", detail: "The realtime connection closed" }, true);
    }
    if (row.call.state === "live" && row.call.expiresAt <= now) {
      await this.end(row, { reason: "max_duration" }, true);
    }
    if (row.call.state === "connecting" && row.call.expiresAt <= now) {
      await this.finish(row, { reason: "error", detail: "The call did not connect" });
    }
    const settlement = await this.ctx.storage.get<{ charge: VoiceCharge; by: Ending }>("eleven-charge");
    if (settlement) {
      if (row.call.state !== "ended") await this.commitEleven(row, settlement);
      else await this.ctx.storage.delete("eleven-charge");
    } else if (
      row.call.state === "ending" &&
      row.call.provider === "elevenlabs" &&
      (row.call.endedAt ?? row.call.expiresAt) + GRACE_MS <= now
    ) {
      const details = await this.conversation(row);
      await this.settleEleven(
        row,
        details?.durationSeconds ?? this.elapsed(row, row.call.expiresAt),
        { ...(row.ending ?? { reason: "max_duration" }), detail: "settled at the deadline: no post-call report" },
        true,
      );
    }
    if (row.call.state === "ending" && row.call.provider === "openai") {
      await this.end(row, row.ending ?? { reason: "error" }, true);
    }
    await this.arm(row);
  }
}

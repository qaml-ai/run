import type { Env } from "../../agent-types.ts";
import { admitAuxiliaryUsage, recordAuxiliaryUsage } from "../../auxiliary-usage.ts";
import { DEFAULT_BUCKET, EndUserCredits } from "../../end-user-credits.ts";
import { HttpError } from "../../errors.ts";
import { database, transaction, type Sql } from "../../postgres.ts";
import { admitMedia } from "../../media-api.ts";
import { keyServices, type KeyServices } from "../../security-services.ts";
import { publishPending } from "../../webhooks.ts";
import { realtimePrice, type RealtimeUsage } from "../../../../../src/voice/realtime/provider.ts";
import type { VoiceCall, VoiceCallInput } from "./schema.ts";

export type VoiceCredits = {
  enabled(tenant: string): Promise<boolean>;
  refusal(tenant: string, endUser: string, bucket: string): Promise<{ message: string; reason: string } | undefined>;
  debit(tenant: string, endUser: string, bucket: string, usd: number, key: string, metadata: Record<string, unknown>, options: { now: number; sql: Sql }): Promise<void>;
};

export function voiceCredits(env: Env & { VOICE_CREDITS?: VoiceCredits }): VoiceCredits {
  if (env.VOICE_CREDITS) return env.VOICE_CREDITS;
  const credits = new EndUserCredits(database(env));
  return {
    enabled: tenant => credits.enabled(tenant),
    refusal: (tenant, endUser, bucket) => credits.refusal(tenant, endUser, bucket),
    // TODO(files-model <- main #997): wire EndUserCredits.debit after regenerating the shared policy.
    async debit() { throw new Error("voice calls need EndUserCredits.debit from main"); },
  };
}

type VoicePayer = { tenant: string; call: VoiceCall; payer: boolean; platform: boolean; options: Omit<VoiceCallInput, "sdp"> };

export async function admitVoiceUsage(env: Env, credits: VoiceCredits, row: VoicePayer, configured?: KeyServices, create = false) {
  const { tenant, call: { agent, subject }, options } = row;
  const services = configured ?? await keyServices(env);
  await admitAuxiliaryUsage(env, { tenant, agent });
  if (create) await admitMedia(env, tenant, services);
  else {
    const refusal = await services.accounts.runLimit(tenant);
    if (refusal) throw typeof refusal === "string" ? new HttpError(402, refusal, "SPEND_LIMIT") : refusal;
  }
  const bucket = options.bucket ?? DEFAULT_BUCKET;
  const refused = await credits.refusal(tenant, subject, bucket);
  if (refused) throw new HttpError(402, refused.message, "END_USER_CREDIT", { endUser: subject, bucket, reason: refused.reason });
}

export function voicePrice(env: Env, reference: string) {
  return realtimePrice(reference, env as unknown as NodeJS.ProcessEnv);
}

export type VoiceCharge = {
  key: string; startedAt: number; at: number; usage: RealtimeUsage; audioSeconds: number;
  deadline?: boolean; duration?: number;
};

export async function recordVoiceUsage(env: Env, credits: VoiceCredits, row: VoicePayer, charge: VoiceCharge) {
  const { tenant, call: { id, agent, provider, model, subject }, options, platform, payer } = row;
  const { key, startedAt, at, usage, audioSeconds, deadline, duration } = charge;
  const rate = voicePrice(env, `${provider}/${model}`);
  if (!rate) throw new Error("Missing realtime price");
  const cost = "perMinute" in rate
    ? (duration ?? audioSeconds) * rate.perMinute / 60 / 1_000_000
    : Math.max(0, (usage.inputText - usage.cachedText) * rate.inputText + usage.cachedText * rate.cachedText
      + (usage.inputAudio - usage.cachedAudio) * rate.inputAudio + usage.cachedAudio * rate.cachedAudio
      + usage.outputText * rate.outputText + usage.outputAudio * rate.outputAudio) / 1e12;
  const services = await keyServices(env);
  await transaction(env, async sql => {
    if (!await recordAuxiliaryUsage(sql, { tenant, agent, callId: key, kind: "speech", startedAt }, { costUsd: cost, provider, model }, "agent")) return;
    if (payer) await credits.debit(tenant, subject, options.bucket ?? DEFAULT_BUCKET, cost, key,
      { call: provider === "elevenlabs" ? "voice_elevenlabs" : "voice_realtime", session: id }, { now: at, sql });
    await services.accounts.recordUsageIn(sql, tenant, agent, {
      provider, model, kind: "speech", platform, speeches: 1, audioSeconds, timestamp: at,
      usage: { input: usage.inputText + usage.inputAudio, output: usage.outputText + usage.outputAudio,
        cacheRead: usage.cachedText + usage.cachedAudio, cost: { total: cost }, ...(deadline ? { settled: "deadline" } : {}) },
      bucket: options.bucket, identity: { subject, context: { ...options.context, voiceCall: id } }, ...(options.keyScope ? { keyScope: options.keyScope } : {}),
    });
  });
  await services.accounts.usageCommitted(tenant);
  await publishPending(env);
  return cost;
}

import { AUDIO_LIMITS } from "../../../src/limits.ts";
import {
  checkedAudio,
  openaiTranscription,
  Transcriber,
  type Transcript,
} from "./media/transcription.ts";
import type { AgentIdentity, UsageRecord } from "./media/types.ts";
import type { MediaBindings } from "./media-api.ts";
import { mediaAzure } from "./media-azure.ts";
import {
  keyServices,
  type KeyEnv,
  type KeyServices,
} from "./security-services.ts";
import { database, transaction, withSql } from "./postgres.ts";
import {
  EndUserCredits,
  MICROS,
  creditError,
  lastCallMin,
} from "./end-user-credits.ts";
import {
  readAgentSpendLimit,
  remainingAgentSpend,
  runSpend,
} from "./agent-spend.ts";
import {
  admitAuxiliaryUsage,
  recordAuxiliaryUsage,
} from "./auxiliary-usage.ts";
import { publishPending } from "./webhooks.ts";
import { HttpError, errorStatus } from "./errors.ts";
import type { AttachedFile } from "./attachment-markers.ts";

export type AttachmentAudioScope = {
  tenant: string;
  agent: string;
  requestId: string;
  spendLimit?: number;
  budget?: number;
  keyScope?: string;
  identity?: AgentIdentity;
  actor?: string;
  bucket?: string;
};
type Env = MediaBindings & KeyEnv;
type Scope = AttachmentAudioScope & { callId: string; startedAt: number };
type CreditReservation = { id: string; endUser: string; bucket: string };
type CreditService = Pick<EndUserCredits, "reserve" | "settleHold" | "release">;
type Receipt = { scope: Scope; usage: UsageRecord; hold?: CreditReservation };
type Cached = {
  fingerprint: string;
  state: "pending" | "complete";
  transcript?: Transcript;
  untranscribed?: string;
  error?: { status: number; message: string; code: string };
};
type Host = {
  transcriber?: Transcriber;
  read?: (file: AttachedFile) => Promise<Uint8Array>;
  budget?: () => Promise<number>;
  admit?: () => Promise<void>;
  record?: (receipt: Receipt) => Promise<void>;
  credits?: CreditService;
};

async function recordAudio(
  env: Env,
  services: KeyServices,
  { scope, usage }: Receipt,
) {
  await transaction(env, async (sql) => {
    if (
      await recordAuxiliaryUsage(
        sql,
        { ...scope, kind: "transcription" },
        {
          costUsd: usage.usage.cost.total,
          provider: usage.provider,
          model: usage.model,
        },
      )
    )
      await services.accounts.recordUsageIn(sql, scope.tenant, scope.agent, {
        ...usage,
        requestId: scope.requestId,
        ...(scope.identity ? { identity: scope.identity } : {}),
        ...(scope.actor ? { actor: scope.actor } : {}),
        ...(scope.keyScope ? { keyScope: scope.keyScope } : {}),
      });
  });
  await services.accounts.usageCommitted(scope.tenant);
  await publishPending(env);
}

/** A known transcript and its charge survive a failed Postgres acknowledgement. */
export async function flushAttachmentTranscriptions(
  env: Env,
  storage: DurableObjectStorage,
  record?: Host["record"],
  credits?: CreditService,
) {
  const receipts = await storage.list<Receipt>({
    prefix: "transcription-billing:",
  });
  if (!receipts.size) return;
  const services = record ? undefined : await keyServices(env);
  for (const [key, receipt] of receipts) {
    if (record) await record(receipt);
    else await recordAudio(env, services!, receipt);
    if (receipt.hold) {
      const credit = credits ?? new EndUserCredits(database(env));
      const { id, endUser, bucket } = receipt.hold;
      await credit.settleHold(
        receipt.scope.tenant,
        endUser,
        bucket,
        id,
        Math.round(receipt.usage.usage.cost.total * MICROS),
        `transcription:${id}`,
        {
          call: "transcription",
          agent: receipt.scope.agent,
          requestId: receipt.scope.requestId,
        },
      );
    }
    await storage.delete(key);
  }
}

/** Source attachment transcription policy, using the shared media provider and billing journal. */
export async function transcribeAttachments(
  env: Env,
  storage: DurableObjectStorage,
  scope: AttachmentAudioScope,
  files: AttachedFile[],
  host: Host = {},
): Promise<AttachedFile[]> {
  const plain = files.map(({ transcribe: _transcribe, ...file }) => file);
  const chosen = files.flatMap((file, index) =>
    (file.transcribe ?? file.contentType.split(";")[0].startsWith("audio/"))
      ? [index]
      : [],
  );
  if (!chosen.length) return plain;
  await flushAttachmentTranscriptions(env, storage, host.record, host.credits);
  const services =
    host.transcriber && host.record && host.admit && host.budget
      ? undefined
      : await keyServices(env);
  const media =
    host.transcriber && host.admit ? undefined : await import("./media-api.ts");
  const transcriber =
    host.transcriber ??
    new Transcriber({
      provider: openaiTranscription({
        outbound: media!.mediaOutbound(env),
        baseUrl: env.MEDIA_BASE_URL,
      }),
      key: (tenant, keyScope, provider) =>
        media!.mediaKey(
          env,
          tenant,
          keyScope,
          provider,
          services,
          mediaAzure(env)?.transcriptionDeployment,
        ),
      price: () =>
        ({
          ...services!.accounts.billing.pricing,
          ...(env.TEST_MODE === "1"
            ? JSON.parse(env.MEDIA_PRICING ?? "{}")
            : {}),
        }).transcription,
    });
  const read =
    host.read ??
    (async (file) => {
      const { boundedBytes } = await import("./images.ts");
      const object = await env.BUCKET.get(file.key);
      if (!object) throw new HttpError(503, "Attached audio is missing");
      return boundedBytes(object.body, AUDIO_LIMITS.fileBytes);
    });
  const failed = (index: number, error: unknown) => {
    if (files[index].transcribe || errorStatus(error, 500) === 402) throw error;
    plain[index] = {
      ...plain[index],
      untranscribed: (error instanceof Error
        ? error.message
        : String(error)
      ).slice(0, 300),
    };
  };
  const audio: {
    index: number;
    header: ReturnType<typeof checkedAudio>;
    cacheKey: string;
    fingerprint: string;
  }[] = [];
  let seconds = 0;
  for (const [position, index] of chosen.entries()) {
    try {
      const file = files[index],
        cacheKey = `attachment-audio:${scope.requestId}:${index}`;
      const fingerprint = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              JSON.stringify([
                file.chunks,
                file.contentType,
                scope.keyScope,
                scope.identity,
                scope.actor,
                scope.bucket,
              ]),
            ),
          ),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const cached = await storage.get<Cached>(cacheKey);
      if (cached) {
        if (cached.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "Attached audio changed during a retry",
            "IDEMPOTENCY_CONFLICT",
          );
        if (cached.state === "pending")
          throw new HttpError(
            503,
            "The previous transcription has an unknown outcome; use a new request ID",
            "TRANSCRIPTION_UNCERTAIN",
          );
        if (cached.error)
          throw new HttpError(
            cached.error.status,
            cached.error.message,
            cached.error.code,
          );
        plain[index] = {
          ...plain[index],
          ...(cached.transcript ? { transcript: cached.transcript } : {}),
          ...(cached.untranscribed
            ? { untranscribed: cached.untranscribed }
            : {}),
        };
        continue;
      }
      if (position >= AUDIO_LIMITS.files)
        throw new HttpError(
          413,
          `At most ${AUDIO_LIMITS.files} audio files are transcribed for a message`,
          "AUDIO_TOO_LONG",
        );
      if (file.size > AUDIO_LIMITS.fileBytes)
        throw new HttpError(
          413,
          `${file.path} is larger than ${AUDIO_LIMITS.fileBytes} bytes, the most transcription takes`,
          "AUDIO_TOO_LARGE",
        );
      const header = checkedAudio(await read(file), file.path);
      if (seconds + header.seconds > AUDIO_LIMITS.messageSeconds)
        throw new HttpError(
          413,
          `At most ${AUDIO_LIMITS.messageSeconds} seconds of audio are transcribed for a message`,
          "AUDIO_TOO_LONG",
        );
      seconds += header.seconds;
      audio.push({ index, header, cacheKey, fingerprint });
    } catch (error) {
      failed(index, error);
    }
  }
  if (!audio.length) return plain;
  const budget = host.budget
    ? await host.budget()
    : Math.min(
        scope.budget ?? Infinity,
        remainingAgentSpend(
          await readAgentSpendLimit(env, scope.tenant, scope.agent),
        ),
        scope.spendLimit === undefined
          ? Infinity
          : scope.spendLimit -
              (await withSql(env, (sql) =>
                runSpend(sql, scope.tenant, scope.agent, scope.requestId),
              )),
      );
  const estimate = audio.reduce(
    (total, item) => total + transcriber.cost(item.header.seconds),
    0,
  );
  if (estimate > budget)
    throw new HttpError(
      402,
      `Transcribing this message's audio costs about $${estimate.toFixed(4)}, more than the $${Math.max(0, budget).toFixed(4)} left of this run's spend limit`,
      "SPEND_LIMIT",
    );
  const credits =
    host.credits ??
    (scope.identity?.subject ? new EndUserCredits(database(env)) : undefined);
  const holds = new Map<number, CreditReservation>();
  try {
    // Reserve every file before sending any. The deterministic IDs survive a
    // restart; a completed receipt owns its reservation until settleHold succeeds.
    if (credits && scope.identity?.subject)
      for (const [position, item] of audio.entries()) {
        const hash = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(
                JSON.stringify([
                  scope.tenant,
                  scope.agent,
                  scope.requestId,
                  item.index,
                ]),
              ),
            ),
          ),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        const bucket = scope.bucket ?? "default",
          endUser = scope.identity.subject;
        const want = Math.ceil(transcriber.cost(item.header.seconds) * MICROS);
        const reserved = await credits.reserve(scope.tenant, endUser, bucket, {
          id,
          want,
          min: position === audio.length - 1 ? lastCallMin(want) : want,
        });
        if (reserved?.refused) throw creditError(reserved.refused);
        if (reserved?.hold) holds.set(item.index, { id, endUser, bucket });
      }
    for (const item of audio) {
      const { index, cacheKey, fingerprint, header } = item;
      const call = {
        ...scope,
        callId: `${scope.requestId}:attachment:${index}`,
        startedAt: Date.now(),
      };
      try {
        if (host.admit) await host.admit();
        else {
          await admitAuxiliaryUsage(env, scope);
        }
        const bytes = await read(files[index]);
        await storage.put(cacheKey, { fingerprint, state: "pending" });
        let made;
        try {
          made = await transcriber.transcribe(
            scope,
            { bytes, header },
            {},
            AbortSignal.timeout(AUDIO_LIMITS.timeoutMs + 10_000),
          );
        } catch (error) {
          const saved = {
            status: errorStatus(error, 500),
            message: error instanceof Error ? error.message : String(error),
            code: (error as { code?: string }).code ?? "TRANSCRIPTION_FAILED",
          };
          await storage.put(cacheKey, {
            fingerprint,
            state: "complete",
            ...(files[index].transcribe || saved.status === 402
              ? { error: saved }
              : { untranscribed: saved.message.slice(0, 300) }),
          });
          throw error;
        }
        await storage.transaction(async (tx) => {
          await tx.put(cacheKey, {
            fingerprint,
            state: "complete",
            transcript: made.transcript,
          });
          await tx.put(`transcription-billing:${call.callId}`, {
            scope: call,
            usage: made.usage,
            ...(holds.has(index) ? { hold: holds.get(index) } : {}),
          });
        });
        holds.delete(index);
        plain[index] = { ...plain[index], transcript: made.transcript };
        // Leave a receipt in place if settling fails. A retry reuses its transcript.
        await flushAttachmentTranscriptions(env, storage, host.record, credits);
      } catch (error) {
        if (plain[index].transcript) throw error;
        failed(index, error);
      }
    }
  } finally {
    for (const hold of holds.values()) await credits!.release(hold.id);
  }
  return plain;
}

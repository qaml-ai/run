import { z } from "@hono/zod-openapi";

export const VOICE_LIMITS = { maxMinutes: { default: 240, min: 1, max: 720 }, perTenant: 50, metadataBytes: 4096, speakers: 50, speakerNameChars: 40 };

const callMetadata = z.record(z.string(), z.unknown()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= VOICE_LIMITS.metadataBytes, "metadata must be at most 4 KB of JSON");
const callSpeakers = z.record(z.string().min(1).max(100), z.string().min(1).max(VOICE_LIMITS.speakerNameChars))
  .refine(value => Object.keys(value).length <= VOICE_LIMITS.speakers, `speakers must name at most ${VOICE_LIMITS.speakers} users`);
export const VoiceCallInput = z.strictObject({
  agent: z.string().regex(/^client_[a-f0-9]{40}$/),
  provider: z.enum(["openai", "elevenlabs"]),
  model: z.string().optional(),
  voice: z.string().optional(),
  instructions: z.string().max(8_000).optional(),
  language: z.string().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i).optional(),
  subject: z.string().min(1).max(200).refine(value => !!value.trim(), "subject is required"),
  bucket: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  keyScope: z.string().min(1).max(100).optional(),
  maxMinutes: z.number().int().min(VOICE_LIMITS.maxMinutes.min).max(VOICE_LIMITS.maxMinutes.max).optional(),
  metadata: callMetadata.optional(),
  speakers: callSpeakers.optional(),
  sdp: z.string().min(1).max(64 * 1024).refine(value => Buffer.byteLength(value) <= 64 * 1024, "sdp must be at most 64 KB").optional(),
}).refine(value => value.provider !== "openai" || value.sdp !== undefined, { path: ["sdp"], message: "sdp is required for OpenAI calls" });
export type VoiceCallInput = z.output<typeof VoiceCallInput>;

export const VoiceCall = z.object({
  id: z.string(), state: z.enum(["connecting", "live", "ending", "ended"]), provider: z.enum(["openai", "elevenlabs"]),
  model: z.string(), voice: z.string(), agent: z.string(), subject: z.string(),
  startedAt: z.number().nullable(), endedAt: z.number().nullable(), expiresAt: z.number(), maxMinutes: z.number(), reason: z.string().nullable(),
  turns: z.number(), asks: z.number(), audioSeconds: z.number(), costUsd: z.number(),
  metadata: z.record(z.string(), z.unknown()), speakers: z.record(z.string(), z.string()),
});
export type VoiceCall = z.output<typeof VoiceCall>;

export const VoiceCallCreated = VoiceCall.extend({
  connect: z.union([z.object({ sdpAnswer: z.string() }), z.object({ signedUrl: z.string(), conversationId: z.string() })]),
});
export type VoiceCallCreated = z.output<typeof VoiceCallCreated>;

export const VoiceCallUpdate = z.strictObject({ speakers: callSpeakers.optional(), metadata: callMetadata.optional() });
export type VoiceCallUpdate = z.output<typeof VoiceCallUpdate>;
export const VoiceTranscriptInput = z.strictObject({
  speaker: z.string().min(1).max(100),
  text: z.string().min(1).max(4_000),
  seconds: z.number().min(0).max(600).optional(),
  startedAt: z.number().min(0).optional(),
  endedAt: z.number().min(0).optional(),
});
export type VoiceTranscriptInput = z.output<typeof VoiceTranscriptInput>;
export const VoiceCallEndInput = z.strictObject({ reason: z.string().max(100).optional() });
export const VoiceCallList = z.object({ calls: z.array(VoiceCall), next: z.string().optional() });

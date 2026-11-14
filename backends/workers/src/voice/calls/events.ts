import { enqueueEvents, webhookEvent, type EventType } from "../../webhook-policy.ts";
import type { Sql } from "../../postgres.ts";

export const VOICE_EVENTS = ["voice.session.started", "voice.session.ended", "voice.utterance", "voice.agent.asked", "voice.agent.replied"] as const;
export type VoiceEvent = typeof VOICE_EVENTS[number];

export function enqueueVoiceEvent(sql: Sql, type: VoiceEvent, tenant: string, key: string, data: Record<string, unknown>) {
  // TODO(files-model <- main #997): the generated EventType will cover all call events.
  return enqueueEvents(sql, [webhookEvent(type as EventType, tenant, data, key)]);
}

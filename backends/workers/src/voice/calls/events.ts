import { enqueueEvents, webhookEvent, type EventType } from "../../webhook-policy.ts";
import type { Sql } from "../../postgres.ts";

/** The call events, as the generated webhook registry names them (src/webhooks.ts EVENT_TYPES). */
export const VOICE_EVENTS = ["voice.session.started", "voice.session.ended", "voice.utterance", "voice.agent.asked", "voice.agent.replied"] as const satisfies readonly EventType[];
export type VoiceEvent = typeof VOICE_EVENTS[number];

export function enqueueVoiceEvent(sql: Sql, type: VoiceEvent, tenant: string, key: string, data: Record<string, unknown>) {
  return enqueueEvents(sql, [webhookEvent(type, tenant, data, key)]);
}

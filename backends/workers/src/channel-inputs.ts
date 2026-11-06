// Generated request schemas from src/api-schemas.ts; only OpenAPI annotations removed.
// Run node backends/workers/scripts/reuse-channels.mjs --check to check source drift.
import { z } from "zod";
const ChannelAccess = z.object({
    public: z.boolean().optional(),
    allow: z.array(z.string().trim().min(1).max(64)).max(1000).optional(),
});
const ChannelLimits = z.object({
    perSenderPerMinute: z.number().int().min(1).max(600).optional(),
    turnsPerDay: z.number().int().min(1).max(1000000).optional(),
});
const ChannelFilter = z.object({
    instructions: z.string().min(1).max(4000),
    criteria: z.object({ true: z.string().min(1).max(1000).optional(), false: z.string().min(1).max(1000).optional() }).strict().optional(),
    threshold: z.number().min(0).max(1).optional(),
}).strict();
const channelFields = {
    name: z.string().trim().min(1).max(120).optional(),
    credentials: z.record(z.string(), z.string().max(4096)).optional(),
    definition: z.string().optional(),
    access: ChannelAccess.optional(),
    limits: ChannelLimits.optional(),
    greeting: z.string().trim().min(1).max(4096).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    filter: ChannelFilter.nullable().optional(),
};
export const ChannelInput = z.object({ type: z.enum(["telegram", "slack", "github", "webhook", "email"]), ...channelFields });
export const ChannelUpdate = z.object(channelFields);
export const ChannelEventsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    outcome: z.enum(["passed", "filtered"]).optional(),
    before: z.string().optional(),
});

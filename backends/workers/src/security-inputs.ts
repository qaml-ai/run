// Generated request schemas from src/api-schemas.ts; only OpenAPI annotations removed.
import { z } from "zod";
const SEND_KEY = "Send {\"apiKey\": \"...\"} with the provider's API key";
export const KeyInput = z.object({
    apiKey: z.string({ error: SEND_KEY }).trim().min(1, SEND_KEY).max(4096, SEND_KEY).regex(/^\S+$/, SEND_KEY),
    verify: z.boolean().optional(),
    region: z.string().optional(),
}, { error: SEND_KEY });
export const TenantInput = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    tokenName: z.string().trim().min(1).max(80).default("api"),
}).strict();
export const TenantLimitsInput = z.object({
    maxStorageGb: z.number().min(0).max(1000000).nullable().optional(),
    maxBusyAgents: z.number().int().min(1).max(1000000).nullable().optional(),
    agentCreatesPerMinute: z.number().int().min(1).max(1000000).nullable().optional(),
    runsPerMinute: z.number().int().min(1).max(1000000).nullable().optional(),
    maxRunResponses: z.number().int().min(1).max(1000000).nullable().optional(),
    maxRunSeconds: z.number().int().min(1).max(31536000).nullable().optional(),
    codeCpuMs: z.number().int().min(1).max(30000).nullable().optional(),
    codeMaxTimeoutMs: z.number().int().min(1).max(120000).nullable().optional(),
    codeConcurrency: z.number().int().min(1).max(1000).nullable().optional(),
    computerLimit: z.number().int().min(1).max(64).nullable().optional(),
    decisionConcurrency: z.number().int().min(1).max(1000).nullable().optional(),
    codeEngine: z.null({ error: "codeEngine was removed with QuickJS: code runs on V8 only. Leave it out, or send null to clear one set before" }).optional(),
}).strict();

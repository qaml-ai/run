import { z } from "@hono/zod-openapi";

const SEND_KEY = "Send {\"apiKey\": \"...\"} with the provider's API key";
const SEND_TEXT = "Send {\"text\": \"...\"}";

export const ApiError = z.object({ error: z.string() }).openapi("Error");
export const Deleted = z.object({ deleted: z.literal(true) });

export const Me = z.object({
  tenant: z.string(),
  via: z.enum(["operator", "token", "console"]),
  login: z.string().optional().openapi({ description: "GitHub login, for console sessions" }),
  canStoreKeys: z.boolean(),
}).openapi("Me");

const KeyStatus = z.object({
  provider: z.string(),
  source: z.enum(["tenant", "admin"]),
  last4: z.string().optional(),
  setAt: z.number().optional(),
}).openapi("KeyStatus");

export const Provider = z.object({
  id: z.string(),
  models: z.number().int(),
  apiKey: z.boolean().openapi({ description: "Whether one API key is enough to use this provider" }),
  requires: z.string().optional().openapi({ description: "What the provider needs instead of an API key" }),
  key: KeyStatus.nullable(),
}).openapi("Provider");

export const KeyInput = z.object({
  apiKey: z.string({ error: SEND_KEY }).trim().min(1, SEND_KEY).max(4096, SEND_KEY).regex(/^\S+$/, SEND_KEY),
  verify: z.boolean().optional().openapi({ description: "false stores the key without checking it with the provider" }),
}, { error: SEND_KEY }).openapi("KeyInput");

export const KeySet = z.object({
  provider: z.string(),
  last4: z.string(),
  verification: z.object({ status: z.enum(["valid", "unverified", "invalid"]), detail: z.string().optional() }),
}).openapi("KeySet");

export const Model = z.object({
  id: z.string().openapi({ description: "Pass this as `model` when creating or configuring an agent", example: "anthropic/claude-sonnet-5" }),
  provider: z.string(),
  modelId: z.string(),
  name: z.string(),
  api: z.string(),
  reasoning: z.boolean(),
  input: z.array(z.string()),
  contextWindow: z.number(),
  maxTokens: z.number(),
  cost: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }).openapi({ description: "USD per million tokens" }),
  available: z.boolean().openapi({ description: "Whether this tenant has a key for the provider" }),
}).openapi("Model");

const ToolDefinition = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()).openapi({ description: "JSON Schema of the arguments" }),
  resultFormat: z.enum(["json", "content"]).optional(),
  exposure: z.enum(["direct", "codemode", "both"]).optional(),
  executionMode: z.enum(["sequential", "parallel"]).optional(),
}).openapi("ToolDefinition");

// Documentation only: sessionConfig validates provisioning, with the messages the SDKs rely on.
export const AgentInput = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  model: z.string().optional().openapi({ description: "A model id from GET /v1/models; the runtime default when omitted" }),
  systemPrompt: z.string().optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  tools: z.array(ToolDefinition).optional().openapi({ description: "Client tools; REST-created agents usually have none" }),
  initialMessages: z.array(z.unknown()).optional(),
}).openapi("AgentInput");

export const AgentCreated = z.looseObject({
  id: z.string(),
  token: z.string().openapi({ description: "The agent's scoped credential for /clients routes" }),
  expiresAt: z.number(),
}).openapi("AgentCreated");

export const AgentSummary = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  model: z.string(),
  connected: z.boolean(),
  running: z.boolean(),
  expiresAt: z.number(),
}).openapi("AgentSummary");

const Outcome = z.object({ result: z.unknown().optional(), error: z.string().optional(), uncertain: z.boolean().optional() }).openapi("Outcome");

export const RequestRecord = z.object({
  id: z.string(),
  method: z.enum(["prompt", "execute", "status", "abort", "history", "continue", "steer", "followUp", "configure"]),
  state: z.enum(["running", "completed"]),
  fingerprint: z.string(),
  startedAt: z.number().optional(),
  began: z.number().optional(),
  endedAt: z.number().optional(),
  prompt: z.string().optional(),
  code: z.string().optional(),
  outcome: Outcome.optional(),
}).openapi("RequestRecord");

const CallRecord = z.object({
  id: z.string(),
  toolCallId: z.string().optional(),
  requestId: z.string().optional(),
  createdAt: z.number().optional(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  deadline: z.number(),
  state: z.enum(["offered", "started", "completed", "cancelled", "uncertain"]),
  outcome: Outcome.optional(),
  lateOutcome: Outcome.optional(),
}).openapi("CallRecord");

export const AgentDetail = AgentSummary.extend({
  tools: z.array(ToolDefinition),
  systemPrompt: z.string(),
  cursor: z.number(),
  events: z.array(z.object({ id: z.number(), data: z.unknown() })),
  requests: z.array(RequestRecord),
  calls: z.array(CallRecord),
}).openapi("AgentDetail");

export const History = z.looseObject({ messages: z.array(z.unknown()) }).openapi("History");

export const PromptInput = z.object({
  text: z.string({ error: SEND_TEXT }).refine(text => !!text.trim(), SEND_TEXT),
  requestId: z.string().optional().openapi({ description: "Idempotency: retrying with the same id returns the same request" }),
}, { error: SEND_TEXT }).openapi("PromptInput");

// Documentation only: scheduleInput and Scheduler.create validate schedules.
export const ScheduleInput = z.object({
  text: z.string().optional().openapi({ description: "Prompt to deliver; give exactly one of text or code" }),
  code: z.string().optional().openapi({ description: "Code to run in the sandbox with the agent's tools" }),
  at: z.union([z.string(), z.number()]).optional().openapi({ description: "ISO time or epoch milliseconds" }),
  inSeconds: z.number().optional(),
  everySeconds: z.number().int().min(60).optional(),
}).openapi("ScheduleInput");

export const Schedule = z.object({
  id: z.string(),
  agent: z.string(),
  tenant: z.string(),
  text: z.string().optional(),
  code: z.string().optional(),
  dueAt: z.number(),
  everySeconds: z.number().optional(),
  createdAt: z.number(),
}).openapi("Schedule");

export const TokenInput = z.object({ name: z.string().openapi({ description: "1–80 characters" }) }).openapi("TokenInput");
export const Token = z.object({ id: z.string(), name: z.string(), prefix: z.string(), createdAt: z.number() }).openapi("Token");
export const TokenCreated = Token.extend({ token: z.string().openapi({ description: "The secret; shown only once" }) }).openapi("TokenCreated");

const Totals = z.object({ responses: z.number(), input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), cost: z.number() });
export const Usage = z.object({
  since: z.number(),
  totals: Totals,
  days: z.array(Totals.extend({ day: z.string(), model: z.string() })),
}).openapi("Usage");

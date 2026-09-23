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

export const Mount = z.object({
  volumeId: z.string(),
  path: z.string().openapi({ description: "Where the agent's file tools see the volume, e.g. /workspace" }),
  mode: z.enum(["ro", "rw"]),
  subpath: z.string().optional().openapi({ description: "Mount only this directory of the volume" }),
  notify: z.boolean().optional().openapi({ description: "Prompt the agent when others change files under this mount" }),
}).openapi("Mount");

// Documentation only: sessionConfig validates provisioning, with the messages the SDKs rely on.
export const AgentInput = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  model: z.string().optional().openapi({ description: "A model id from GET /v1/models; the runtime default when omitted" }),
  systemPrompt: z.string().optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  tools: z.array(ToolDefinition).optional().openapi({ description: "Client tools; REST-created agents usually have none" }),
  initialMessages: z.array(z.unknown()).optional(),
  ttlSeconds: z.number().int().nullable().optional().openapi({ description: "Agent lifetime: 60 to 31622400 seconds, or null to live until deleted. Default 86400." }),
  mounts: z.array(Mount).optional().openapi({ description: "Volumes for the agent's file tools; default: a new workspace volume at /workspace" }),
}).openapi("AgentInput");

export const AgentCreated = z.looseObject({
  id: z.string(),
  token: z.string().openapi({ description: "The agent's scoped credential for /clients routes" }),
  expiresAt: z.number().nullable(),
}).openapi("AgentCreated");

export const AgentSummary = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  model: z.string(),
  connected: z.boolean(),
  running: z.boolean(),
  expiresAt: z.number().nullable(),
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
  mounts: z.array(Mount),
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

const ChannelTemplate = z.object({
  model: z.string().optional().openapi({ description: "A model id from GET /v1/models; the runtime default when omitted" }),
  systemPrompt: z.string().trim().min(1).max(32_000).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  tools: z.array(ToolDefinition).max(64).optional().openapi({ description: "Client tools, answered by an application connected to each agent" }),
}).openapi("ChannelTemplate");
const ChannelAccess = z.object({
  public: z.boolean().optional().openapi({ description: "Let anyone message the channel; off by default" }),
  allow: z.array(z.string().trim().min(1).max(64)).max(1000).optional().openapi({ description: "Senders allowed in: user ids or @usernames" }),
});
const ChannelLimits = z.object({
  perSenderPerMinute: z.number().int().min(1).max(600).optional().openapi({ description: "Messages per sender per minute; default 10" }),
  turnsPerDay: z.number().int().min(1).max(1_000_000).optional().openapi({ description: "Agent turns per UTC day across the channel; default 1000" }),
});
const channelFields = {
  name: z.string().trim().min(1).max(120).optional(),
  credentials: z.record(z.string(), z.string().max(4096)).optional().openapi({ description: "Telegram: { botToken }. Stored encrypted and never returned" }),
  template: ChannelTemplate.optional().openapi({ description: "How each conversation's agent is created" }),
  access: ChannelAccess.optional(),
  limits: ChannelLimits.optional(),
  greeting: z.string().trim().min(1).max(4096).optional().openapi({ description: "Reply to /start" }),
};
export const ChannelInput = z.object({ type: z.enum(["telegram"]), ...channelFields, credentials: channelFields.credentials.unwrap() }).openapi("ChannelInput");
export const ChannelUpdate = z.object(channelFields).openapi("ChannelUpdate");
export const Channel = z.object({
  id: z.string(),
  tenant: z.string(),
  type: z.string(),
  name: z.string(),
  webhookUrl: z.string(),
  template: ChannelTemplate,
  access: z.object({ public: z.boolean(), allow: z.array(z.string()) }),
  limits: z.object({ perSenderPerMinute: z.number(), turnsPerDay: z.number() }),
  greeting: z.string().optional(),
  account: z.record(z.string(), z.string()).openapi({ description: "The bot's identity at the provider" }),
  credentials: z.record(z.string(), z.string()).openapi({ description: "Masked credentials" }),
  createdAt: z.number(),
  updatedAt: z.number(),
}).openapi("Channel");

export const MountsInput = z.object({ mounts: z.array(Mount) }).openapi("MountsInput");

export const VolumeInput = z.object({ name: z.string().optional() }).openapi("VolumeInput");
export const VolumeSummary = z.object({ id: z.string(), name: z.string(), createdAt: z.number() }).openapi("VolumeSummary");
export const Volume = VolumeSummary.extend({
  seq: z.number().openapi({ description: "Increases with every change to the volume" }),
  files: z.number(),
  bytes: z.number(),
  origin: z.object({ volume: z.string(), snapshot: z.string().optional(), seq: z.number() }).optional().openapi({ description: "What a fork was copied from" }),
}).openapi("Volume");
export const ForkInput = z.object({ name: z.string().optional(), snapshot: z.string().optional().openapi({ description: "Fork this snapshot instead of the current state" }) }).openapi("ForkInput");
export const Snapshot = z.object({ id: z.string(), volume: z.string(), name: z.string(), seq: z.number(), createdAt: z.number(), files: z.number(), bytes: z.number() }).openapi("Snapshot");
export const VolumeFile = z.object({ path: z.string(), version: z.number(), size: z.number(), updatedAt: z.number(), by: z.string().optional() }).openapi("VolumeFile");
export const FileList = z.object({ files: z.array(VolumeFile), next: z.string().optional().openapi({ description: "Pass as `after` for the next page" }) }).openapi("FileList");
export const Changes = z.object({
  seq: z.number(),
  changes: z.array(z.object({ seq: z.number(), path: z.string(), kind: z.enum(["write", "delete"]), version: z.number().optional(), size: z.number().optional(), by: z.string().optional(), at: z.number() })),
  gap: z.boolean().optional().openapi({ description: "Older changes are no longer kept; list the files instead" }),
}).openapi("Changes");

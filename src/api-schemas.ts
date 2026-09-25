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
  source: z.enum(["tenant", "admin", "platform"]).openapi({ description: "tenant: set by the tenant; admin: set by the runtime operator; platform: the platform's key, billed to prepaid credit" }),
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
  definition: z.string().optional().openapi({ description: "Make the agent from this definition (GET /v1/definitions). It supplies the model, system prompt, thinking level and tool sources; name, type, ttlSeconds, mounts and initialMessages given here override its defaults" }),
  name: z.string().optional(),
  type: z.string().optional(),
  model: z.string().optional().openapi({ description: "A model id from GET /v1/models; the runtime default when omitted" }),
  systemPrompt: z.string().optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  initialMessages: z.array(z.unknown()).optional(),
  ttlSeconds: z.number().int().nullable().optional().openapi({ description: "Agent lifetime: 60 to 31622400 seconds, or null to live until deleted. Default 86400." }),
  mounts: z.array(Mount).optional().openapi({ description: "Volumes for the agent's file tools; default: a new workspace volume at /workspace" }),
  subject: z.string().optional().openapi({ description: "Who the agent acts for (a user id in your app): the `sub` of the identity tokens its tool servers with auth \"runtime\" get. Set only here" }),
  context: z.record(z.string(), z.unknown()).optional().openapi({ description: "Claims your tool servers need (org, workspace, thread…), carried as `ctx` in its identity tokens; at most 4 KB. Set only here" }),
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


export const AgentDetail = AgentSummary.extend({
  definition: z.object({ id: z.string(), revision: z.number() }).optional().openapi({ description: "The definition the agent was made from, and the revision it has" }),
  tools: z.array(ToolDefinition),
  mounts: z.array(Mount),
  systemPrompt: z.string(),
  cursor: z.number(),
  events: z.array(z.object({ id: z.number(), data: z.unknown() })),
  requests: z.array(RequestRecord),
}).openapi("AgentDetail");

export const History = z.looseObject({ messages: z.array(z.unknown()) }).openapi("History");

export const PromptInput = z.object({
  text: z.string({ error: SEND_TEXT }).refine(text => !!text.trim(), SEND_TEXT),
  actor: z.string().optional().openapi({ description: "Who is acting in this turn (a user id in your app): `act` in its tools' identity tokens" }),
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

const Totals = z.object({
  responses: z.number(), input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), cost: z.number(),
  platformResponses: z.number().openapi({ description: "Responses that ran on a key that is not the tenant's own" }),
  platformCost: z.number().openapi({ description: "Their cost (USD, list prices); prepaid tenants pay it from credit" }),
});
export const Usage = z.object({
  since: z.number(),
  totals: Totals,
  days: z.array(Totals.extend({ day: z.string(), model: z.string(), kind: z.enum(["turn", "compaction"]).openapi({ description: "turn: the agent's own responses; compaction: summaries of older context" }) })),
}).openapi("Usage");

const ThinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DefinitionLimits = z.object({
  ttlSeconds: z.number().int().nullable().optional().openapi({ description: "Agent lifetime: 60 to 31622400 seconds, or null to live until deleted. Default 86400." }),
}).openapi("DefinitionLimits");
const definitionName = z.string().trim().min(1).max(120);
const SourceAuthInput = z.union([
  z.object({ type: z.literal("bearer"), token: z.string() }).openapi({ description: "A bearer token; stored encrypted and never returned" }),
  z.object({ type: z.literal("runtime") }).openapi({ description: "Each request carries a JWT the runtime signs (EdDSA, two minutes, audience the server's URL) naming the tenant, agent, subject, context and actor; verify it against /.well-known/jwks.json" }),
]).openapi("SourceAuthInput");
const SourceAuth = z.object({ type: z.enum(["bearer", "runtime"]) }).openapi("SourceAuth");
const mcpServerFields = {
  name: z.string().openapi({ description: "Its tools reach the model as <name>__<tool>: 1–32 letters and digits, single underscores between them" }),
  url: z.string().openapi({ description: "The server's Streamable HTTP (or older SSE) endpoint; https, on a public address" }),
  allowTools: z.array(z.string()).max(512).optional().openapi({ description: "Only these of its tools" }),
  denyTools: z.array(z.string()).max(512).optional().openapi({ description: "None of these of its tools" }),
  exposure: z.enum(["direct", "codemode", "both"]).optional().openapi({ description: "How the model calls its tools: directly, from js_exec (the default), or both" }),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional().openapi({ description: "Per call; default 60000" }),
  audience: z.string().optional().openapi({ description: "With auth \"runtime\": the tokens' aud, when not the server's url (behind a proxy, say)" }),
};
const McpServerInput = z.object({
  ...mcpServerFields,
  headers: z.record(z.string(), z.string()).optional().openapi({ description: "Sent with every request to the server; stored encrypted and never returned. Leave out with auth to keep the ones stored for a server of this name and origin" }),
  auth: SourceAuthInput.optional(),
}).openapi("McpServerInput");
const openApiFields = {
  name: z.string().openapi({ description: "Its operations reach the model as <name>__<operationId>: 1–32 letters and digits, single underscores between them" }),
  baseUrl: z.string().optional().openapi({ description: "Where requests go; default the spec's first server. https, on a public address" }),
  allowTools: z.array(z.string()).max(128).optional().openapi({ description: "Only these operations (by operationId); at most 128 in all" }),
  denyTools: z.array(z.string()).max(4096).optional().openapi({ description: "None of these operations" }),
  exposure: z.enum(["direct", "codemode", "both"]).optional().openapi({ description: "How the model calls its operations: directly, from js_exec (the default), or both" }),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional().openapi({ description: "Per call; default 30000" }),
  audience: z.string().optional().openapi({ description: "With auth \"runtime\": the tokens' aud, when not baseUrl (behind a proxy, say)" }),
};
const OpenApiInput = z.object({
  ...openApiFields,
  spec: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().openapi({ description: "The OpenAPI 3 document (JSON or YAML) as a URL, fetched each time the definition is saved, or the document itself. Leave out to keep a source's current operations" }),
  headers: z.record(z.string(), z.string()).optional().openapi({ description: "Sent with every request to the API; stored encrypted and never returned. Leave out with auth to keep the ones stored for a source of this name and origin" }),
  auth: SourceAuthInput.optional(),
}).openapi("OpenApiInput");
const OpenApi = z.object({
  ...openApiFields,
  spec: z.string().optional().openapi({ description: "The spec's URL; absent for a spec given inline" }),
  baseUrl: z.string(),
  tools: z.array(z.string()).openapi({ description: "The operations the agent gets, by name" }),
  headerNames: z.array(z.string()).optional(),
  auth: SourceAuth.optional(),
}).openapi("OpenApi");
const McpServer = z.object({
  ...mcpServerFields,
  headerNames: z.array(z.string()).optional().openapi({ description: "Headers the server gets; their values are never returned" }),
  auth: SourceAuth.optional(),
}).openapi("McpServer");
const definitionFields = {
  model: z.string().openapi({ description: "A model id from GET /v1/models; the runtime default when omitted" }),
  systemPrompt: z.string().trim().min(1).max(32_000),
  thinkingLevel: ThinkingLevel,
  limits: DefinitionLimits,
  mounts: z.array(Mount).max(16).openapi({ description: "Volumes for each agent's file tools; default: a new workspace volume per agent" }),
  builtins: z.array(z.enum(["web_fetch", "schedule"])).max(8).openapi({ description: "Tools the runtime answers itself: web_fetch reads a public page as text; schedule lets the agent set, list and cancel its own wake-ups" }),
  mcpServers: z.array(McpServerInput).max(16).openapi({ description: "Remote MCP servers whose tools the runtime calls for the agent" }),
  openApi: z.array(OpenApiInput).max(16).openapi({ description: "OpenAPI specs whose operations the runtime calls for the agent, as tools" }),
};
const optional = <T extends Record<string, z.ZodType>>(fields: T) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.optional()])) as { [K in keyof T]: z.ZodOptional<T[K]> };
const removable = <T extends Record<string, z.ZodType>>(fields: T) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.nullable().optional()])) as { [K in keyof T]: z.ZodOptional<z.ZodNullable<T[K]>> };
export const DefinitionInput = z.object({ name: definitionName, ...optional(definitionFields) }).openapi("DefinitionInput");
export const DefinitionUpdate = z.object({
  name: definitionName.optional(),
  ...removable(definitionFields),
  revision: z.number().int().optional().openapi({ description: "Only update the definition if it is still at this revision" }),
  apply: z.enum(["all"]).optional().openapi({ description: "Also reconfigure every live agent made from the definition to the new revision; each takes it between turns" }),
}).openapi("DefinitionUpdate", { description: "Fields given replace the stored ones; null removes one" });
export const Definition = z.object({
  id: z.string(),
  name: z.string(),
  revision: z.number().openapi({ description: "Increases with every change" }),
  ...optional(definitionFields),
  mcpServers: z.array(McpServer).optional(),
  openApi: z.array(OpenApi).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).openapi("Definition");
export const DefinitionUpdated = Definition.extend({
  applied: z.object({ accepted: z.array(z.string()), failed: z.array(z.object({ agent: z.string(), error: z.string() })) }).optional()
    .openapi({ description: "Agents that accepted the new revision (applied between their turns), and any that could not be reached" }),
}).openapi("DefinitionUpdated");
export const DefinitionAgent = z.object({ id: z.string(), revision: z.number() }).openapi("DefinitionAgent");

const ChannelTemplate = z.object({
  model: z.string().optional().openapi({ description: "A model id from GET /v1/models; the runtime default when omitted" }),
  systemPrompt: z.string().trim().min(1).max(32_000).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
}).openapi("ChannelTemplate");
const ChannelAccess = z.object({
  public: z.boolean().optional().openapi({ description: "Let anyone message the channel; off by default" }),
  allow: z.array(z.string().trim().min(1).max(64)).max(1000).optional().openapi({ description: "Senders allowed in: user ids, or @usernames (Telegram, Discord)" }),
});
const ChannelLimits = z.object({
  perSenderPerMinute: z.number().int().min(1).max(600).optional().openapi({ description: "Messages per sender per minute; default 10" }),
  turnsPerDay: z.number().int().min(1).max(1_000_000).optional().openapi({ description: "Agent turns per UTC day across the channel; default 1000" }),
});
const channelFields = {
  name: z.string().trim().min(1).max(120).optional(),
  credentials: z.record(z.string(), z.string().max(4096)).optional().openapi({ description: "Telegram: { botToken }. Slack: { botToken, signingSecret }. Discord: { botToken }. Stored encrypted and never returned" }),
  definition: z.string().optional().openapi({ description: "The definition each conversation's agent is made from (GET /v1/definitions)" }),
  template: ChannelTemplate.optional().openapi({ description: "Deprecated: give a definition instead. An inline template becomes a definition of the channel's own" }),
  access: ChannelAccess.optional(),
  limits: ChannelLimits.optional(),
  greeting: z.string().trim().min(1).max(4096).optional().openapi({ description: "Reply to /start (Telegram)" }),
};
export const ChannelInput = z.object({ type: z.enum(["telegram", "slack", "discord"]), ...channelFields, credentials: channelFields.credentials.unwrap() }).openapi("ChannelInput");
export const ChannelUpdate = z.object(channelFields).openapi("ChannelUpdate");
export const Channel = z.object({
  id: z.string(),
  tenant: z.string(),
  type: z.string(),
  name: z.string(),
  webhookUrl: z.string().optional().openapi({ description: "Where the service delivers messages. Telegram's is registered for you; paste Slack's into the app's Event Subscriptions. Discord channels have none: they connect to Discord's gateway" }),
  definition: z.string().optional().openapi({ description: "The definition each conversation's agent is made from" }),
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

const micros = (description: string) => z.number().int().openapi({ description: `${description}, in micro-USD (1 USD = 1000000)` });
export const LedgerEntry = z.object({
  id: z.number().int(),
  kind: z.enum(["grant", "purchase", "usage", "storage", "adjustment", "refund"]),
  amount: micros("Positive adds credit, negative spends it"),
  metadata: z.record(z.string(), z.unknown()).openapi({ description: "usage: tokens (micro-USD on platform keys) and activeMs; storage: day and bytes" }),
  createdAt: z.number(),
}).openapi("LedgerEntry");
export const Ledger = z.object({
  entries: z.array(LedgerEntry).openapi({ description: "Newest first" }),
  next: z.number().int().optional().openapi({ description: "Pass as `before` for the next page" }),
}).openapi("Ledger");
export const Billing = z.object({
  billing: z.enum(["prepaid", "none"]).openapi({ description: "prepaid: runs are paid from credit; none: not billed by the runtime" }),
  balance: micros("Credit left; at zero or below, runs are refused with 402"),
  freeCredit: z.boolean().openapi({ description: "Whether the tenant has only ever had free credit, which comes with tighter limits" }),
  checkout: z.boolean().openapi({ description: "Whether credit can be bought here (POST /v1/billing/checkout)" }),
  month: z.object({
    since: z.number(),
    grant: micros("Granted this UTC month"), purchase: micros("Bought"), usage: micros("Spent on model tokens and agent time"),
    storage: micros("Spent on storage"), adjustment: micros("Adjusted by the operator"), refund: micros("Refunded"),
  }),
  recent: z.array(LedgerEntry),
  rates: z.object({
    agentHour: micros("Per hour an agent spends in a turn, metered continuously"),
    storageGbMonth: micros("Per GB-month stored, charged daily"),
    purchaseFeeBps: z.number().int().openapi({ description: "Fee on credit purchases, in basis points" }),
    minPurchase: micros("Smallest purchase"), maxPurchase: micros("Largest purchase"),
  }).openapi({ description: "Model tokens are charged at the provider's list price when they run on the platform's keys" }),
}).openapi("Billing");
export const AdjustmentInput = z.object({
  tenant: z.string(),
  amount: z.number().int().refine(value => value !== 0 && Math.abs(value) <= 1e12, "amount must be a non-zero integer of micro-USD").openapi({ description: "Micro-USD to add (negative to remove)" }),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/).optional().openapi({ description: "Repeating an adjustment with the same key applies it once" }),
}).openapi("AdjustmentInput");
export const CheckoutInput = z.object({
  amountUsd: z.number().openapi({ description: "Credit to buy, in USD with at most two decimals; the fee is added on top", example: 10 }),
}).openapi("CheckoutInput");
export const Checkout = z.object({
  id: z.string().openapi({ description: "The Stripe Checkout session" }),
  url: z.string().openapi({ description: "Send the buyer here to pay" }),
  amount: micros("Credit bought"), fee: micros("Fee"), total: micros("Charged"),
}).openapi("Checkout");

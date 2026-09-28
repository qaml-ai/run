import { z } from "@hono/zod-openapi";
import { EVENT_TYPES } from "./webhooks.ts";

const SEND_KEY = "Send {\"apiKey\": \"...\"} with the provider's API key";
const SEND_TEXT = "Send {\"text\": \"...\"}";

export const ERROR_CODES = {
  INVALID_REQUEST: "400: the request is malformed or invalid", UNAUTHORIZED: "401: no valid token", PAYMENT_REQUIRED: "402", FORBIDDEN: "403: the token may not do this",
  NOT_FOUND: "404", CONFLICT: "409", GONE: "410", TOO_LARGE: "413", RATE_LIMITED: "429: retry after Retry-After", UNAVAILABLE: "503: retry after Retry-After", INTERNAL: "500",
  SPEND_LIMIT: "402: a spend limit (the agent's, or the tenant's monthly cap) is reached", INSUFFICIENT_CREDIT: "402: the tenant's prepaid credit is spent",
  IDEMPOTENCY_CONFLICT: "409: the Idempotency-Key or request id was used for another request", IDEMPOTENCY_IN_PROGRESS: "409: the first request with this Idempotency-Key is still running; retry",
  APPLICATION_CONNECTED: "409: another connection serves this agent's tools; connect with ?takeover=true to replace it",
  APPLICATION_NOT_CONNECTED: "409: this agent's tools need its application, and none is connected; connect it, or send allowDisconnected: true",
  REPLAY_GAP: "409: the Last-Event-ID is behind the buffer; read state (or ask for a snapshot) and continue from its cursor",
} as const;
export const ApiError = z.object({
  error: z.string().openapi({ description: "What went wrong, for people" }),
  code: z.string().openapi({ description: `What went wrong, for code: ${Object.entries(ERROR_CODES).map(([code, meaning]) => `${code} (${meaning})`).join("; ")}. Others may be added` }),
}).openapi("Error");
export const Deleted = z.object({ deleted: z.literal(true) });

export const Me = z.object({
  tenant: z.string(),
  via: z.enum(["operator", "token", "console"]),
  login: z.string().optional().openapi({ description: "GitHub login, for console sessions" }),
  canStoreKeys: z.boolean(),
  defaultModel: z.string().openapi({ description: "The model an agent gets when it names none, as provider/model-id", example: "anthropic/claude-sonnet-5" }),
}).openapi("Me");

const KeyStatus = z.object({
  provider: z.string(),
  source: z.enum(["tenant", "admin", "platform"]).openapi({ description: "tenant: set by the tenant; admin: set by the runtime operator; platform: the platform's key, billed to prepaid credit" }),
  last4: z.string().optional(),
  setAt: z.number().optional(),
}).openapi("KeyStatus");

const CustomModel = z.object({
  id: z.string().openapi({ description: "The model's id on the server; agents name it <provider>/<id>", example: "llama-4-scout" }),
  contextWindow: z.number().int().openapi({ description: "Its context window in tokens: compaction keeps each request within it" }),
  maxOutputTokens: z.number().int().optional().openapi({ description: "The most it writes in a reply; default 8,192, or half a smaller context window" }),
  input: z.array(z.enum(["text", "image"])).optional().openapi({ description: "[\"text\", \"image\"] for a model that sees images; default [\"text\"]" }),
  reasoning: z.boolean().optional().openapi({ description: "Whether it reasons (thinkingLevel applies)" }),
  pricing: z.object({ input: z.number(), output: z.number(), cacheRead: z.number().optional(), cacheWrite: z.number().optional() }).optional().openapi({ description: "USD per million tokens, for usage, spend limits and webhooks; none: free" }),
  compat: z.object({
    supportsDeveloperRole: z.boolean().optional(), supportsUsageInStreaming: z.boolean().optional(), supportsFinishReason: z.boolean().optional(), supportsReasoningEffort: z.boolean().optional(),
    maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
    thinkingFormat: z.enum(["openai", "openrouter", "deepseek", "together", "zai", "qwen", "qwen-chat-template"]).optional(),
  }).optional().openapi({ description: "Switches for a server that differs from OpenAI's: a developer role, usage in the stream (default true), reasoning_effort, the max tokens field, how thinking is asked for" }),
}).openapi("CustomModel");

export const CustomProviderInput = z.object({
  type: z.literal("openai-compatible").openapi({ description: "A server that speaks OpenAI Chat Completions (POST <baseUrl>/chat/completions)" }),
  baseUrl: z.string().openapi({ description: "Its API root, public and https (the outbound guard checks it when saved and at every call)", example: "https://api.example.com/v1" }),
  apiKey: z.string().nullable().optional().openapi({ description: "Sent as Authorization: Bearer; left out keeps the stored key, null removes it (a server that takes none)" }),
  headers: z.record(z.string(), z.string()).nullable().optional().openapi({ description: "Headers for each call, sealed like the key; left out keeps the stored ones, null removes them" }),
  models: z.array(CustomModel).min(1).max(200),
}).openapi("CustomProviderInput");

export const Provider = z.object({
  id: z.string(),
  kind: z.enum(["model", "search", "fetch"]).openapi({ description: "model: an LLM provider; search: a web search API, whose key the web_search built-in uses; fetch: a page renderer web_fetch uses for JavaScript-only pages" }),
  models: z.number().int(),
  apiKey: z.boolean().openapi({ description: "Whether one API key is enough to use this provider" }),
  requires: z.string().optional().openapi({ description: "What the provider needs instead of an API key" }),
  key: KeyStatus.nullable(),
  custom: z.object({
    type: z.literal("openai-compatible"), baseUrl: z.string(), headers: z.array(z.string()).optional().openapi({ description: "The names of its headers, never their values" }),
    models: z.array(CustomModel),
  }).optional().openapi({ description: "A provider of the tenant's own (PUT /v1/providers/{name}): where it is, and the models it declares" }),
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

export const KeyScopeEntryInput = z.object({
  apiKey: z.string().min(1).max(4096).optional().openapi({ description: "The provider's API key (for amazon-bedrock, a Bedrock API key, sent as a bearer token). Leave it out for a gateway at baseUrl that holds the key: no auth header is sent, only headers" }),
  baseUrl: z.string().optional().openapi({ description: "An HTTPS endpoint that replaces the provider's API root in each request: https://openrouter.ai/api/v1, https://api.anthropic.com or https://api.openai.com/v1 (an AI gateway's /openrouter, /anthropic or /openai); for other providers, the model's base URL", example: "https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openrouter" }),
  headers: z.record(z.string(), z.string()).optional().openapi({ description: "Extra headers for every call, sealed like the key, e.g. cf-aig-authorization" }),
  region: z.string().optional().openapi({ description: "amazon-bedrock only: the AWS region to call; read from baseUrl https://bedrock-runtime.<region>.amazonaws.com when left out", example: "us-west-2" }),
}).strict().openapi("KeyScopeEntryInput");
export const KeyScope = z.object({
  scope: z.string(),
  providers: z.array(z.object({
    provider: z.string(), last4: z.string().optional().openapi({ description: "Absent for an entry without a key" }), baseUrl: z.string().optional(), region: z.string().optional(),
    headers: z.array(z.string()).optional().openapi({ description: "The extra headers' names; never their values" }), setAt: z.number(),
  })),
}).openapi("KeyScope");

const eventTypes = z.array(z.enum(EVENT_TYPES)).openapi({ description: "The event types it receives: run.started, run.completed, run.failed, input.requested, input.resolved, usage.recorded" });
export const WebhookEndpointInput = z.object({
  url: z.string().openapi({ description: "An HTTPS URL that receives the events, each a POST signed per Standard Webhooks", example: "https://example.com/hooks/agents" }),
  events: eventTypes,
  description: z.string().max(500).optional(),
}).strict().openapi("WebhookEndpointInput");
export const WebhookEndpointUpdate = WebhookEndpointInput.partial().openapi("WebhookEndpointUpdate");
export const WebhookEndpoint = z.object({ id: z.string(), url: z.string(), events: eventTypes, description: z.string().optional(), createdAt: z.number() }).openapi("WebhookEndpoint");
const signingSecret = z.string().openapi({ description: "The Standard Webhooks signing secret (whsec_…); shown only this once" });
export const WebhookEndpointCreated = WebhookEndpoint.extend({ secret: signingSecret }).openapi("WebhookEndpointCreated");
export const WebhookSecret = z.object({ secret: signingSecret }).openapi("WebhookSecret");
export const UsageWebhookInput = z.object({ url: z.string().openapi({ description: "An HTTPS URL that receives each model response's usage", example: "https://example.com/hooks/agent-usage" }) }).strict().openapi("UsageWebhookInput");
export const UsageWebhook = z.object({ url: z.string(), createdAt: z.number() }).openapi("UsageWebhook");
export const UsageWebhookSet = z.object({ url: z.string(), secret: signingSecret.optional() }).openapi("UsageWebhookSet");

// Webhook events: documentation only; src/webhooks.ts, src/inputs.ts and ClientSessions.runEvent build them.
const envelope = <T extends string>(type: T, data: z.ZodType, description: string) => z.object({
  id: z.string().openapi({ description: "evt_…: the same each time the event is sent; dedupe by it", example: "evt_3f9c0a1b2c3d4e5f60718293" }),
  type: z.literal(type), created: z.number().openapi({ description: "When it happened, in Unix seconds" }), data,
}).openapi(`Event_${type.replace(".", "_")}`, { description });
const runFacts = {
  agentId: z.string(), requestId: z.string(),
  method: z.enum(["prompt", "continue", "resume", "execute"]),
  actor: z.string().optional(), metadata: z.record(z.string(), z.string()).optional().openapi({ description: "The metadata the message that started it carried" }),
};
const runUsage = z.object({ responses: z.number(), input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), costUsd: z.number() }).nullable()
  .openapi({ description: "The run's model responses on the node that ended it; null when it made none there" });
export const WebhookEvents = {
  "run.started": envelope("run.started", z.object({ ...runFacts, resumes: z.number().optional().openapi({ description: "Set when a node resumed a turn whose node was lost" }) }), "A run began"),
  "run.completed": envelope("run.completed", z.object({
    ...runFacts, usage: runUsage,
    stopped: z.enum(["input_required", "spend_limit"]).optional().openapi({ description: "Why it stopped early: waiting on input (inputIds), or a spend limit" }),
    inputIds: z.array(z.string()).optional(),
    replyIndex: z.number().optional().openapi({ description: "The final assistant message's index in the agent's history" }),
    messageCount: z.number().optional().openapi({ description: "Messages in the agent's history after it" }),
    steeredInto: z.string().optional().openapi({ description: "A prompt sent with whileRunning: steer that a running turn took: that turn's request" }),
  }), "A run ended without an error"),
  "run.failed": envelope("run.failed", z.object({
    ...runFacts, usage: runUsage, error: z.string(), uncertain: z.boolean().optional().openapi({ description: "A restart cut it short: its effects are unknown" }), steeredInto: z.string().optional(),
  }), "A run ended with an error: the runtime's, or the model's"),
  "input.requested": envelope("input.requested", z.object({
    agentId: z.string(), requestId: z.string(), inputId: z.string(), toolCallId: z.string(), kind: z.enum(["question", "approval", "form", "url"]), expiresAt: z.number(),
  }), "The agent asks a person for input; the run waits"),
  "input.resolved": envelope("input.resolved", z.object({
    agentId: z.string(), requestId: z.string(), inputId: z.string(), state: z.enum(["answered", "declined", "cancelled", "expired", "superseded"]),
  }), "An input settled"),
  "usage.recorded": envelope("usage.recorded", z.object({
    agentId: z.string(), requestId: z.string().nullable(), subject: z.string(), actor: z.string().nullable(), context: z.record(z.string(), z.unknown()), keyScope: z.string().nullable(),
    provider: z.string(), model: z.string(), kind: z.enum(["response", "compaction"]), input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(),
    reasoning: z.number().optional(), cost: z.object({ usd: z.number(), source: z.enum(["provider", "catalog"]) }), at: z.number(),
  }), "A model response's usage and cost"),
};

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

export const SpendLimitInput = z.object({ usd: z.number().min(0).max(1_000_000) }).strict().openapi("SpendLimitInput", {
  description: "The most the agent may spend on model calls (their token cost, compaction included) from when this is set: a new value starts counting from zero. At it, new prompts get 402 and a running turn ends with stopped \"spend_limit\"",
});

export const ModelHeaders = z.record(z.string(), z.string()).openapi("ModelHeaders", {
  description: "Non-secret headers sent on each of the agent's model calls, after a key scope entry's, e.g. cf-aig-metadata. At most 20 and 8 KB; never authorization, x-api-key, x-goog-api-key, cf-aig-authorization, chatgpt-account-id, x-agent-runtime-identity, x-amz-* or transport headers",
});

// Documentation only: sessionConfig validates provisioning, with the messages the SDKs rely on.
const Builtin = z.enum(["web_fetch", "web_search", "schedule", "ask_user"]).openapi("Builtin");
export const AgentInput = z.object({
  definition: z.string().optional().openapi({ description: "Make the agent from this definition (GET /v1/definitions). It supplies the model, system prompt, thinking level, fileTools and tool sources; name, type, ttlSeconds, mounts and initialMessages given here override its defaults. model, thinkingLevel and fileTools given here are the agent's own: applying the definition later keeps them. systemPrompt cannot be given with a definition; use systemPromptAppend" }),
  name: z.string().optional(),
  type: z.string().optional(),
  model: z.string().optional().openapi({ description: "A model id from GET /v1/models; the runtime default when omitted" }),
  systemPrompt: z.string().optional(),
  systemPromptAppend: z.string().max(32_000).optional().openapi({ description: "Text after the system prompt, e.g. per-conversation context. The agent's own: applying its definition replaces the prompt and keeps this" }),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  initialMessages: z.array(z.unknown()).optional(),
  fileTools: z.boolean().openapi({ description: "false: the model gets no file tools (read, write, edit, ls, glob, grep), only present_file; the mounts stay open to fs in js_exec, attachments and tool outputs. For applications with file tools of their own" }).optional(),
  ttlSeconds: z.number().int().nullable().optional().openapi({ description: "Agent lifetime: 60 to 31622400 seconds, or null to live until deleted. Default: until deleted for an agent made with an Idempotency-Key, 86400 for one made without" }),
  mounts: z.array(Mount).optional().openapi({ description: "Volumes for the agent's file tools; default: a new workspace volume at /workspace" }),
  subject: z.string().optional().openapi({ description: "Who the agent acts for (a user id in your app): the `sub` of the identity tokens its tool servers with auth \"runtime\" get. Set only here" }),
  context: z.record(z.string(), z.unknown()).optional().openapi({ description: "Claims your tool servers need (org, workspace, thread…), carried as `ctx` in its identity tokens; at most 4 KB. Set only here" }),
  builtins: z.array(Builtin).max(8).optional().openapi({ description: "Tools the runtime answers itself (web_fetch, web_search, schedule, ask_user), for an agent without a definition; one made from a definition has its definition's. An upsert without builtins leaves the agent none" }),
  keyScope: z.string().optional().openapi({ description: "A key scope (PUT /v1/key-scopes/{scope}/providers/{provider}) whose keys the agent's model calls use first, before the tenant's own", example: "org_abc123" }),
  spendLimit: SpendLimitInput.optional(),
  modelHeaders: ModelHeaders.optional(),
}).openapi("AgentInput");

export const AgentCreated = z.looseObject({
  id: z.string(),
  token: z.string().openapi({ description: "The agent's scoped credential for /clients routes" }),
  expiresAt: z.number().nullable(),
}).openapi("AgentCreated");

export const AgentSummary = z.object({
  id: z.string(),
  key: z.string().nullable().openapi({ description: "The key it was made with (an upsert's, or POST /v1/agents' Idempotency-Key); null for one made without" }),
  name: z.string().openapi({ description: "Its name; its id when it was given none" }),
  type: z.string(),
  model: z.string(),
  connected: z.boolean(),
  running: z.boolean(),
  expiresAt: z.number().nullable(),
  resume: z.object({ failures: z.number(), after: z.number() }).nullable().openapi({ description: "Loads of its unfinished work that failed, or found no room, and when the next may be tried: put off, doubling, at most an hour apart, never for good" }),
}).openapi("AgentSummary");

const Outcome = z.object({ result: z.unknown().optional(), error: z.string().optional(), uncertain: z.boolean().optional() }).openapi("Outcome");

export const RequestRecord = z.object({
  id: z.string(),
  method: z.enum(["prompt", "execute", "status", "abort", "continue", "steer", "configure", "resume"]).openapi({ description: "resume: the runtime continuing a turn that waited on human input, once its inputs settled" }),
  state: z.enum(["running", "completed"]),
  fingerprint: z.string(),
  startedAt: z.number().optional(),
  began: z.number().optional(),
  endedAt: z.number().optional(),
  prompt: z.string().optional(),
  code: z.string().optional(),
  suspension: z.string().optional().openapi({ description: "resume: the request whose turn waited on human input" }),
  metadata: z.record(z.string(), z.string()).optional().openapi({ description: "The metadata sent with the message" }),
  steeredInto: z.string().optional().openapi({ description: "A prompt with whileRunning: steer that a running turn took: that turn's request, whose outcome this shares" }),
  outcome: Outcome.optional().openapi({ description: "result.stopped is input_required when the turn waits on human input, listed in result.inputs" }),
  error: z.string().optional().openapi({ description: "An ended request's error, from its outcome: the runtime's (outcome.error) or the model's (outcome.result.error). Absent when it succeeded" }),
  stopped: z.enum(["input_required", "spend_limit"]).optional().openapi({ description: "Why an ended run stopped early (outcome.result.stopped)" }),
}).openapi("RequestRecord");

const Sender = z.strictObject({ id: z.string(), name: z.string().optional(), username: z.string().optional() });
export const Input = z.object({
  id: z.string(), agent: z.string(), tenant: z.string(),
  requestId: z.string().openapi({ description: "The run that suspended waiting on it" }),
  toolCallId: z.string(),
  kind: z.enum(["question", "approval", "form", "url"]).openapi({ description: "question: ask_user's questions; approval: a call the runtime or a tool wants approved; form: fields a tool asks for; url: a page a tool asks the user to open" }),
  message: z.string(),
  detail: z.record(z.string(), z.unknown()).openapi({ description: "question: { questions }; approval: { tool, source, arguments, argumentsHash }, built by the runtime from the real call; form: { requestedSchema }; url: { url, origin }" }),
  responders: z.object({ audience: z.array(z.string()).optional() }).openapi({ description: "Who may answer besides the definition's humanInput.approvers: by default the sender or actor whose message started the turn" }),
  state: z.enum(["pending", "answered", "declined", "cancelled", "expired", "superseded"]),
  answer: z.object({ action: z.enum(["accept", "decline", "cancel"]), content: z.unknown().optional(), by: z.record(z.string(), z.unknown()), at: z.number() }).optional(),
  createdAt: z.number(), expiresAt: z.number(),
}).openapi("Input");
export const AnswerInput = z.object({
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.unknown().optional().openapi({ description: "question: { answers: { \"<question>\": \"<label>\" | [\"<label>\"] | \"<own words>\" } }; form: the fields, checked against its schema; approval decline: { reason? }" }),
  from: Sender.optional().openapi({ description: "Who is answering, in your app: checked against the input's audience and approvers (403)" }),
  actor: z.string().optional().openapi({ description: "Who is answering (a user id in your app), when not from.id" }),
}).openapi("AnswerInput");
export const AnswerInputs = z.object({ answers: z.array(AnswerInput.extend({ id: z.string() })).min(1).max(100) }).openapi("AnswerInputs");
export const AnsweredAll = z.object({ inputs: z.array(Input), requests: z.array(RequestRecord).openapi({ description: "The runs resuming turns whose last input these answers settled" }) }).openapi("AnsweredAll");
export const Answered = z.object({ input: Input, request: RequestRecord.nullable().openapi({ description: "The run resuming the turn, once the suspension's last input settled; poll it like a prompt" }) }).openapi("Answered");


export const ToolSource = z.object({
  kind: z.enum(["channel", "application", "files", "builtin", "mcp", "openapi"]).openapi({ description: "channel: the channel's send_message; application: the tools your application answers; files: file tools over the agent's mounts; builtin, mcp, openapi: the definition's sources, which the runtime calls itself" }),
  name: z.string().openapi({ description: "The built-in's, MCP server's or OpenAPI source's name; the kind for the others" }),
  status: z.enum(["listed", "unlisted", "error"]).openapi({ description: "unlisted: an MCP server this node has not listed yet (see refresh); error: listing it failed, so the model has none of its tools" }),
  error: z.string().optional(),
  listedAt: z.number().optional().openapi({ description: "When an MCP server was last listed, or its listing failed" }),
  connected: z.boolean().optional().openapi({ description: "application: whether your application is connected to answer its tools" }),
  url: z.string().optional(),
  exposure: z.enum(["direct", "codemode", "both"]).optional().openapi({ description: "The source's configured exposure; each tool shows the one it has" }),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    exposure: z.enum(["direct", "codemode", "both"]).optional(),
    executionMode: z.enum(["sequential", "parallel"]).optional(),
    parameters: z.record(z.string(), z.unknown()).optional().openapi({ description: "JSON Schema of the arguments, with schemas=true" }),
    excluded: z.string().optional().openapi({ description: "Why the model does not get this tool (a name taken by an earlier source, or the catalog's limits); absent when it does" }),
  })),
}).openapi("ToolSource");

export const AgentDetail = AgentSummary.extend({
  definition: z.object({ id: z.string(), revision: z.number() }).optional().openapi({ description: "The definition the agent was made from, and the revision it has" }),
  tools: z.array(ToolDefinition).openapi({ description: "The tools your application declared, which it answers" }),
  toolSources: z.array(ToolSource).openapi({ description: "Every source of the agent's tools, in order of precedence, and what each offers the model" }),
  mounts: z.array(Mount),
  systemPrompt: z.string(),
  systemPromptAppend: z.string().optional(),
  fileTools: z.literal(false).optional().openapi({ description: "Present when the model gets no file tools but present_file" }),
  keyScope: z.string().nullable().openapi({ description: "The key scope its model calls take keys from first" }),
  modelHeaders: ModelHeaders.nullable(),
  builtins: z.array(Builtin).openapi({ description: "The tools the runtime answers itself: its own, or its definition's" }),
  spendLimit: z.object({ usd: z.number(), spent: z.number().openapi({ description: "Model spend since the limit was set" }) }).nullable(),
  cursor: z.number(),
  events: z.array(z.object({ id: z.number(), data: z.unknown() })),
  requests: z.array(RequestRecord),
}).openapi("AgentDetail");

export const SessionState = z.object({
  cursor: z.number().openapi({ description: "The agent's latest event id: a stream opened with it as Last-Event-ID continues from here" }),
  requests: z.array(RequestRecord).openapi({ description: "Recent requests (the running ones and the latest settled), with their outcomes" }),
  resume: z.object({ failures: z.number(), after: z.number() }).optional().openapi({ description: "For an agent no node holds, whose unfinished work's loads are put off: how many times, and until when" }),
}).openapi("SessionState");
export const EventPoll = z.object({
  cursor: z.number().openapi({ description: "Send as Last-Event-ID on the next poll" }),
  events: z.array(z.object({ id: z.number(), data: z.unknown() })),
}).openapi("EventPoll");

export const BrowserTokenInput = z.object({
  ttlSeconds: z.number().int().min(5).max(3600).optional().openapi({ description: "How long it lives: 5 to 3600 seconds, default 900. Nothing revokes it sooner" }),
  scopes: z.array(z.enum(["events", "state", "history", "inputs"])).optional().openapi({ description: "What it reads of the agent: GET /v1/agents/{id}/<scope>. Default all four" }),
  events: z.array(z.string()).max(64).optional().openapi({ description: "Only these event types (message_update, tool_execution_end, ...) reach it; default every one but the runtime's own (codemode, compaction_usage, spend_limit_reached). Outcomes (response) and snapshots always do, an outcome only as whether and why its run stopped" }),
  redact: z.array(z.enum(["usage.cost"])).optional().openapi({ description: "Fields it does not see: usage.cost, a response's provider cost, in messages, snapshots and history" }),
  subject: z.string().max(200).optional().openapi({ description: "Whom it is for, in your app (a user id)" }),
}).openapi("BrowserTokenInput");
export const BrowserToken = z.object({
  token: z.string().openapi({ description: "Send as Authorization: Bearer <token>, never in a URL" }),
  expiresAt: z.number(), agentId: z.string(), url: z.string().optional().openapi({ description: "Where the browser reaches the runtime" }),
}).openapi("BrowserToken");

export const History = z.looseObject({ messages: z.array(z.unknown()) }).openapi("History");
export const HistoryPage = z.object({
  entries: z.array(z.object({ index: z.number().openapi({ description: "The message's index in the agent's history" }), message: z.unknown() })).openapi({ description: "Whole turns, oldest first" }),
  next: z.number().nullable().openapi({ description: "Pass as before for the older page; null at the start of the history" }),
  total: z.number().openapi({ description: "Messages in the history, the running turn's included" }),
  split: z.literal(true).optional().openapi({ description: "One turn alone was larger than a page (about 4 MB), so this page starts inside it" }),
}).openapi("HistoryPage");

export const PromptInput = z.object({
  text: z.string({ error: SEND_TEXT }).refine(text => !!text.trim(), SEND_TEXT),
  actor: z.string().optional().openapi({ description: "Who is acting in this turn (a user id in your app): `act` in its tools' identity tokens" }),
  from: z.strictObject({
    id: z.string().openapi({ description: "The sender's id in your app; the model may rely on it" }),
    name: z.string().optional().openapi({ description: "Display name, chosen by the sender" }),
    username: z.string().optional().openapi({ description: "Handle, chosen by the sender" }),
  }).optional().openapi({ description: "Who sent this message. The model sees it in a block only the runtime can write; `from.id` is also the turn's actor unless `actor` is given" }),
  requestId: z.string().optional().openapi({ description: "Idempotency: retrying with the same id returns the same request. The user message records it, so a UI can match its own bubble" }),
  allowDisconnected: z.boolean().optional().openapi({ description: "Run even though the agent's tools need its application and none is connected (else 409 APPLICATION_NOT_CONNECTED): its calls then fail as not connected" }),
  whileRunning: z.enum(["queue", "steer"]).optional().openapi({ description: "What happens if the agent is working on a turn when this arrives. queue (default): it runs as the next turn. steer: the running turn takes it after its current step, and this request ends with that turn (steeredInto names it); if the turn ends first, it runs as a turn of its own. With no turn running, both start one" }),
  spendLimit: SpendLimitInput.optional().openapi({ description: "This run's own budget in USD: it ends before its next model request once it has spent this. The agent's spendLimit is unchanged and counts the run too" }),
  metadata: z.record(z.string(), z.string({ error: "metadata values must be strings" }), { error: "metadata must be an object of string values" }).optional().openapi({ description: "Your own key-value data about this message (its source, a client-side id): at most 16 keys of 1–64 characters, values of at most 512. Kept on the user message (history, events, snapshots) and the request, and sent with its run's webhook events; never shown to the model", example: { source: "web", clientMessageId: "m_123" } }),
  files: z.array(z.union([
    z.strictObject({ path: z.string().openapi({ description: "A file in the agent's mounts, e.g. one uploaded with PUT /v1/agents/{id}/uploads/{requestId}/{name}" }) }),
    z.strictObject({ name: z.string().optional(), data: z.string().openapi({ description: "The file's bytes, base64: at most 4 MiB across a message's inline files" }), contentType: z.string().optional() }),
  ])).optional().openapi({ description: "Attached files (at most 20): saved in the agent's workspace under uploads/<requestId>/, named in the message, and shown natively (images, PDFs) to models that take them" }),
}, { error: SEND_TEXT }).openapi("PromptInput");
export const Upload = z.object({
  path: z.string().openapi({ description: "Where the agent sees the file: attach it as {path}" }),
  version: z.number(), size: z.number(), updatedAt: z.number(), by: z.string().optional(), contentType: z.string(),
}).openapi("Upload");

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
  ttlSeconds: z.number().int().nullable().optional().openapi({ description: "Agent lifetime: 60 to 31622400 seconds, or null to live until deleted. Default: until deleted for an agent made with an Idempotency-Key, 86400 for one made without" }),
}).openapi("DefinitionLimits");
const definitionName = z.string().trim().min(1).max(120);
const SourceAuthInput = z.union([
  z.object({ type: z.literal("bearer"), token: z.string() }).openapi({ description: "A bearer token; stored encrypted and never returned" }),
  z.object({ type: z.literal("runtime") }).openapi({ description: "Each request carries a JWT the runtime signs (EdDSA, two minutes, audience the server's URL) naming the tenant, agent, subject, context and actor; verify it against /.well-known/jwks.json" }),
]).openapi("SourceAuthInput");
const SourceAuth = z.object({ type: z.enum(["bearer", "runtime"]) }).openapi("SourceAuth");
const approvalMode = z.enum(["never", "always"]);
const approvalFields = {
  default: z.enum(["never", "always", "destructive"]).optional().openapi({ description: "never (the default), always, or destructive: tools annotated destructiveHint (MCP), operations other than GET, HEAD and OPTIONS (OpenAPI)" }),
  tools: z.record(z.string(), approvalMode).optional().openapi({ description: "Per tool, by its own name: overrides the default" }),
};
const mcpServerFields = {
  name: z.string().openapi({ description: "Its tools reach the model as <name>__<tool>: 1–32 letters and digits, single underscores between them" }),
  url: z.string().openapi({ description: "The server's Streamable HTTP (or older SSE) endpoint; https, on a public address" }),
  allowTools: z.array(z.string()).max(512).optional().openapi({ description: "Only these of its tools" }),
  denyTools: z.array(z.string()).max(512).optional().openapi({ description: "None of these of its tools" }),
  exposure: z.enum(["direct", "codemode", "both"]).optional().openapi({ description: "How the model calls its tools: directly, from js_exec (the default), or both" }),
  timeoutMs: z.number().int().min(1_000).max(1_200_000).optional().openapi({ description: "How long a call may go without an answer; default 60000. Each progress notification the server sends restarts it, up to 1200000 in all" }),
  audience: z.string().optional().openapi({ description: "With auth \"runtime\": the tokens' aud, when not the server's url (behind a proxy, say)" }),
  approval: z.strictObject(approvalFields).optional().openapi({ description: "Which tools the user approves before each call. Those tools are declared to the model directly; an approved call carries _meta[\"agent-runtime/approval\"] and an approval claim in its identity token" }),
};
const McpServerInput = z.object({
  ...mcpServerFields,
  headers: z.record(z.string(), z.string()).optional().openapi({ description: "Sent with every request to the server; stored encrypted and never returned. Leave out with auth to keep the ones stored for a server of this name and origin" }),
  auth: SourceAuthInput.optional(),
}).openapi("McpServerInput");
const openApiFields = {
  name: z.string().openapi({ description: "Its operations reach the model as <name>__<operationId>: 1–32 letters and digits, single underscores between them" }),
  baseUrl: z.string().optional().openapi({ description: "Where requests go; default the spec's first server. https, on a public address" }),
  allowTools: z.array(z.string()).max(1024).optional().openapi({ description: "Only these operations (by operationId); at most 1024 in all" }),
  denyTools: z.array(z.string()).max(4096).optional().openapi({ description: "None of these operations" }),
  exposure: z.enum(["direct", "codemode", "both"]).optional().openapi({ description: "How the model calls its operations: directly, from js_exec (the default), or both" }),
  timeoutMs: z.number().int().min(1_000).max(1_200_000).optional().openapi({ description: "Per call; default 30000" }),
  audience: z.string().optional().openapi({ description: "With auth \"runtime\": the tokens' aud, when not baseUrl (behind a proxy, say)" }),
  approval: z.strictObject({ ...approvalFields, methods: z.array(z.enum(["GET", "PUT", "POST", "DELETE", "PATCH", "HEAD", "OPTIONS"])).optional().openapi({ description: "Operations of these methods, unless named in tools" }) }).optional()
    .openapi({ description: "Which operations the user approves before each call. They are declared to the model directly; with auth \"runtime\", an approved call's identity token carries an approval claim" }),
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
  fileTools: z.boolean().openapi({ description: "false: the model gets no file tools (read, write, edit, ls, glob, grep), only present_file; the mounts stay open to fs in js_exec, attachments and tool outputs. For applications with file tools of their own" }),
  limits: DefinitionLimits,
  mounts: z.array(Mount).max(16).openapi({ description: "Volumes for each agent's file tools; default: a new workspace volume per agent" }),
  builtins: z.array(Builtin).max(8).openapi({ description: "Tools the runtime answers itself: web_fetch reads a public page as text (rendering JavaScript-only pages through Firecrawl when a firecrawl key resolves); web_search searches the web through the first search provider with a key that answers (the tenant's own, else the platform's, billed per search at that provider's price); schedule lets the agent set, list and cancel its own wake-ups; ask_user lets the model ask the user questions, suspending its turn until they answer" }),
  webSearch: z.object({
    providers: z.array(z.enum(["exa", "brave", "parallel"])).min(1).max(3).openapi({ description: "The providers web_search tries, in order; each is skipped without a key, and the next is tried when one fails, times out or is rate limited", example: ["brave"] }),
  }).strict().openapi({ description: "Pin web_search to providers of your choosing instead of the runtime's order (exa, brave, parallel by default)" }),
  mcpServers: z.array(McpServerInput).max(64).openapi({ description: "Remote MCP servers whose tools the runtime calls for the agent" }),
  openApi: z.array(OpenApiInput).max(64).openapi({ description: "OpenAPI specs whose operations the runtime calls for the agent, as tools" }),
  humanInput: z.strictObject({
    expiresInSeconds: z.number().int().min(60).max(30 * 86_400).optional().openapi({ description: "How long an input waits for an answer: 7 days by default, at most 30, and never past the agent's own expiry" }),
    onExpire: z.enum(["close", "resume"]).optional().openapi({ description: "close (default): an expired input closes its call and the turn without the model; resume: the model is told and continues" }),
    approvers: z.array(z.string()).max(100).optional().openapi({ description: "Who may answer any input besides the person whose message started the turn: actors, or channel senders like slack:U0123" }),
  }).openapi({ description: "Questions, approvals and setup steps the agent's turns wait on" }),
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
export const ApplyResult = z.object({
  agent: z.string(),
  requestId: z.string().openapi({ description: "The agent's configure request: poll GET /v1/agents/{agent}/requests/{requestId} for a queued one's outcome" }),
  status: z.enum(["updated", "queued", "failed"]).openapi({ description: "updated: the agent has the revision; queued: it takes it between its turns; failed: see error" }),
  error: z.string().optional(),
}).openapi("ApplyResult");
export const DefinitionUpdated = Definition.extend({
  applied: z.array(ApplyResult).optional().openapi({ description: "With apply: \"all\", one entry per live agent made from the definition" }),
}).openapi("DefinitionUpdated");
export const DefinitionAgent = z.object({ id: z.string(), revision: z.number() }).openapi("DefinitionAgent");

export const ConfigureInput = z.object({
  requestId: z.string().min(1).optional(),
  model: z.string().optional().openapi({ description: "Model id from GET /v1/models" }),
  systemPrompt: z.string().min(1).max(32_000).optional(),
  systemPromptAppend: z.string().max(32_000).optional().openapi({ description: "Text after the system prompt; empty removes it" }),
  thinkingLevel: ThinkingLevel.optional(),
  keyScope: z.string().nullable().optional().openapi({ description: "The key scope its model calls take keys from first; null for the tenant's keys. Applying a definition keeps it" }),
  spendLimit: SpendLimitInput.nullable().optional().openapi({ description: "A new budget from now, applied at once, ahead of queued runs; null removes it" }),
  modelHeaders: ModelHeaders.nullable().optional().openapi({ description: "Replaces the agent's model headers; null or {} removes them" }),
  builtins: z.array(Builtin).max(8).optional().openapi({ description: "Replaces the agent's builtins; [] removes them. Not for an agent made from a definition, whose builtins are its definition's" }),
}).strict().refine(input => Object.keys(input).some(key => key !== "requestId"), "Give at least one configuration field").openapi("ConfigureInput", { description: "On an agent made from a definition, a model or thinkingLevel set here stays when the definition is applied; a systemPrompt set here is replaced by it" });

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
  definition: z.string().optional().openapi({ description: "The definition each conversation's agent is made from (GET /v1/definitions); a channel created without one gets an empty definition of its own" }),
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
export const VolumeFile = z.object({
  path: z.string(), version: z.number(), size: z.number(), updatedAt: z.number(), by: z.string().optional(),
  contentType: z.string().openapi({ description: "As uploaded (Content-Type), else sniffed from the file's first bytes and name" }),
}).openapi("VolumeFile");
export const LinkInput = z.object({
  path: z.string().openapi({ description: "The file's path in the volume" }),
  method: z.enum(["GET", "PUT"]).optional().openapi({ description: "GET (default) downloads the file; PUT uploads it, creating or replacing it" }),
  expiresIn: z.number().int().optional().openapi({ description: "Seconds the link works: 900 by default, at most 86400" }),
  maxBytes: z.number().int().optional().openapi({ description: "PUT: the largest upload it takes (default and at most 256 MiB)" }),
  contentType: z.string().optional().openapi({ description: "PUT: the upload's content type; an upload declaring another is refused" }),
}).openapi("LinkInput");
export const Link = z.object({
  url: z.string().openapi({ description: "Send the method to it, with no Authorization header" }),
  method: z.enum(["GET", "PUT"]), tenant: z.string(), volume: z.string(), path: z.string(), expiresAt: z.number(),
  maxBytes: z.number().optional(), contentType: z.string().optional(),
}).openapi("Link");
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
  metadata: z.record(z.string(), z.unknown()).openapi({ description: "usage: one entry per UTC hour (`hour`, its start), updated until the hour ends, with the hour's tokens (micro-USD on platform keys) and activeMs; storage: day and bytes" }),
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
    webSearch: z.object({ exa: micros("Per search Exa answers"), brave: micros("Per search Brave answers"), parallel: micros("Per search Parallel answers") }).openapi({ description: "Per web_search on the platform's key for the provider that answered" }),
    webRender: micros("Per page web_fetch has Firecrawl render on the platform's key"),
  }).openapi({ description: "Model tokens are charged at the provider's list price when they run on the platform's keys; tools.search's ranking by meaning at what its providers charge" }),
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

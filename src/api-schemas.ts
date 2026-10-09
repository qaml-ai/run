import { z } from "@hono/zod-openapi";
import { EVENT_TYPES } from "./webhooks.ts";

const SEND_KEY = "Send {\"apiKey\": \"...\"} with the provider's API key";
const SEND_TEXT = "Send {\"text\": \"...\"}, or attach audio to transcribe";
const TRANSCRIBE = z.boolean().optional().openapi({ description: "Whether this file is transcribed for the model (audio only): default true for audio (an audio/* content type), false for anything else. See the voice and audio guide" });

export const ERROR_CODES = {
  INVALID_REQUEST: "400: the request is malformed or invalid", UNAUTHORIZED: "401: no valid token", PAYMENT_REQUIRED: "402", FORBIDDEN: "403: the token may not do this",
  NOT_FOUND: "404", CONFLICT: "409", GONE: "410", TOO_LARGE: "413", RATE_LIMITED: "429: retry after Retry-After", UNAVAILABLE: "503: retry after Retry-After", DATABASE_RETRY: "503: the database refused the request for now (a conflict with another, or a statement timeout); retry after Retry-After", INTERNAL: "500",
  BUSY_AGENT_LIMIT: "429: the tenant has as many agents busy as it may (the body's busyAgents, a BusyAgents, says the limit, its usage tier and the next); retry after Retry-After",
  SPEND_LIMIT: "402: a spend limit (the agent's, or the tenant's monthly cap) is reached", INSUFFICIENT_CREDIT: "402: the tenant's prepaid credit is spent", STORAGE_LIMIT: "507: the tenant's storage limit would be passed; the body has limit and used, in bytes",
  IDEMPOTENCY_CONFLICT: "409: the Idempotency-Key or request id was used for another request", IDEMPOTENCY_IN_PROGRESS: "409: the first request with this Idempotency-Key is still running; retry",
  APPLICATION_CONNECTED: "409: another connection serves this agent's tools; connect with ?takeover=true to replace it",
  APPLICATION_NOT_CONNECTED: "409: this agent's tools need its application, and none is connected; connect it, or send allowDisconnected: true",
  REPLAY_GAP: "409: the Last-Event-ID is behind the buffer; read state (or ask for a snapshot) and continue from its cursor",
  AGENT_KEYLESS: "409: the agent was made without a key, so its credentials cannot be given again (GET /v1/agents/{id}/credentials)",
} as const;
export const ApiError = z.object({
  error: z.string().openapi({ description: "What went wrong, for people" }),
  code: z.string().openapi({ description: `What went wrong, for code: ${Object.entries(ERROR_CODES).map(([code, meaning]) => `${code} (${meaning})`).join("; ")}. Others may be added` }),
  limit: z.object({
    name: z.string().openapi({ description: "api_requests, auth_requests, signups, agent_creates or runs" }),
    scope: z.enum(["ip", "tenant"]),
    max: z.number().int(),
    windowSeconds: z.number().int(),
  }).optional().openapi({ description: "On a rate limit's 429: the limit reached. Retry-After says when to retry" }),
}).openapi("Error");
export const Deleted = z.object({ deleted: z.literal(true) });
export const SignedOut = z.object({ signedOut: z.number().int().openapi({ description: "How many console sessions ended" }) }).openapi("SignedOut");

export const Me = z.object({
  tenant: z.string(),
  via: z.enum(["operator", "token", "console", "oauth"]),
  login: z.string().optional().openapi({ description: "Who the tenant belongs to: the Google or sign-in address, or the GitHub login, it signed in with" }),
  name: z.string().optional().openapi({ description: "The person's display name, for console sessions signed in with Google or GitHub" }),
  signIn: z.enum(["github", "google", "password"]).optional().openapi({ description: "How a console session was signed in" }),
  canStoreKeys: z.boolean(),
  defaultModel: z.string().openapi({ description: "The model an agent of this tenant gets when it names none, as provider/model-id: the first of the runtime's defaults (Claude Sonnet 5.5 on Anthropic, OpenRouter, then Bedrock, ...) the tenant has a key for. An agent with a key scope counts the scope's keys too", example: "anthropic/claude-sonnet-5-5" }),
}).openapi("Me");

const KeyStatus = z.object({
  provider: z.string(),
  source: z.enum(["tenant", "admin", "platform"]).openapi({ description: "tenant: set by the tenant; admin: set by the runtime operator; platform: the platform's key, which a prepaid tenant pays for from credit (an admin tenant uses it unbilled, unless its entry sets platformKeys: false)" }),
  last4: z.string().optional(),
  setAt: z.number().optional(),
  region: z.string().optional().openapi({ description: "For the tenant's own amazon-bedrock key: the AWS region its calls go to" }),
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
  type: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]).openapi({ description: "The API the server speaks: openai-completions, OpenAI Chat Completions (POST <baseUrl>/chat/completions); openai-responses, OpenAI Responses (POST <baseUrl>/responses); anthropic-messages, Anthropic Messages (POST <baseUrl>/v1/messages)" }),
  baseUrl: z.string().openapi({ description: "Its API root, public and https (the outbound guard checks it when saved and at every call): with /v1 for the OpenAI APIs, without for Anthropic's", example: "https://api.example.com/v1" }),
  apiKey: z.string().nullable().optional().openapi({ description: "Sent as Authorization: Bearer (x-api-key for Anthropic Messages); left out keeps the stored key, null removes it (a server that takes none)" }),
  headers: z.record(z.string(), z.string()).nullable().optional().openapi({ description: "Headers for each call, sealed like the key; left out keeps the stored ones, null removes them" }),
  auth: z.enum(["x-api-key", "bearer"]).optional().openapi({ description: "anthropic-messages only: \"bearer\" sends the key as Authorization: Bearer, as some gateways and proxies take it, instead of x-api-key (the default). Saved again without it, x-api-key" }),
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
    type: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]), baseUrl: z.string(), auth: z.enum(["x-api-key", "bearer"]).openapi({ description: "How the key is sent" }), headers: z.array(z.string()).optional().openapi({ description: "The names of its headers, never their values" }),
    models: z.array(CustomModel),
  }).optional().openapi({ description: "A provider of the tenant's own (PUT /v1/providers/{name}) or of a key scope (PUT /v1/key-scopes/{scope}/model-providers/{name}): its API, where it is, and the models it declares" }),
}).openapi("Provider");

export const KeyInput = z.object({
  apiKey: z.string({ error: SEND_KEY }).trim().min(1, SEND_KEY).max(4096, SEND_KEY).regex(/^\S+$/, SEND_KEY),
  verify: z.boolean().optional().openapi({ description: "false stores the key without checking it with the provider" }),
  region: z.string().optional().openapi({ description: "amazon-bedrock only, and required for it: the AWS region its calls go to (the key is a Bedrock API key, sent as a bearer token)", example: "us-west-2" }),
}, { error: SEND_KEY }).openapi("KeyInput");

export const KeySet = z.object({
  provider: z.string(),
  last4: z.string(),
  region: z.string().optional(),
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
export const WebhookEndpoint = z.object({ id: z.string(), url: z.string(), events: eventTypes, description: z.string().optional(), createdAt: z.number(), setBy: z.string().nullable().openapi({ description: "Who last set where it sends: \"token:<API token id>\", \"oauth:<grant id>\", \"console\" or \"operator\"; null if set before this was recorded. Revoking that token lists it" }) }).openapi("WebhookEndpoint");
const signingSecret = z.string().openapi({ description: "The Standard Webhooks signing secret (whsec_…); shown only this once" });
export const WebhookEndpointCreated = WebhookEndpoint.extend({ secret: signingSecret }).openapi("WebhookEndpointCreated");
export const WebhookSecret = z.object({ secret: signingSecret }).openapi("WebhookSecret");
export const TelemetryInput = z.object({
  endpoint: z.string().optional().openapi({ description: "The OTLP/HTTP traces URL spans are POSTed to (https; a collector's base URL gets /v1/traces). Needed the first time", example: "https://api.honeycomb.io/v1/traces" }),
  headers: z.record(z.string(), z.string()).optional().openapi({ description: "Headers sent with each export (a collector's API key), stored encrypted and never shown again. Left out, the stored ones stay while the endpoint keeps its origin; {} removes them", example: { "x-honeycomb-team": "<key>" } }),
  protocol: z.enum(["http/protobuf", "http/json"]).optional().openapi({ description: "OTLP's encoding. Default http/protobuf" }),
  sampleRate: z.number().min(0).max(1).optional().openapi({ description: "The share of runs traced, from 0 to 1 (default 1). A run continuing a caller's traceparent follows its sampled flag instead" }),
  include: z.strictObject({
    content: z.boolean().optional().openapi({ description: "Export what people and models wrote: prompts, replies, tool arguments and results, inputs' questions, errors' messages. Default false" }),
  }).optional(),
}).strict().openapi("TelemetryInput", { description: "A field left out keeps its current value (its default the first time)" });
export const Telemetry = z.object({
  endpoint: z.string(), protocol: z.enum(["http/protobuf", "http/json"]), sampleRate: z.number(), include: z.object({ content: z.boolean() }),
  headers: z.array(z.string()).openapi({ description: "The names of the stored headers; their values are never returned" }),
  createdAt: z.number(), updatedAt: z.number(), setBy: z.string().nullable().openapi({ description: "Who last set where it sends: \"token:<API token id>\", \"oauth:<grant id>\", \"console\" or \"operator\"; null if set before this was recorded. Revoking that token lists it" }),
  status: z.object({
    lastExportAt: z.number().nullable().openapi({ description: "When a node last exported spans here (recorded at most once a minute)" }),
    lastError: z.string().nullable().openapi({ description: "Why the last export failed, since the last success: an HTTP status, or how the connection failed" }),
    lastErrorAt: z.number().nullable(),
  }),
}).openapi("Telemetry");
export const TelemetryTest = z.object({
  ok: z.boolean(), status: z.number().optional().openapi({ description: "The endpoint's HTTP status" }), error: z.string().optional(),
  traceId: z.string().openapi({ description: "The test span's trace, to look up in your backend" }), spanId: z.string(),
}).openapi("TelemetryTest");
export const UsageWebhookInput = z.object({ url: z.string().openapi({ description: "An HTTPS URL that receives each model response's usage", example: "https://example.com/hooks/agent-usage" }) }).strict().openapi("UsageWebhookInput");
export const UsageWebhook = z.object({ url: z.string(), createdAt: z.number(), setBy: z.string().nullable().openapi({ description: "Who last set where it sends: \"token:<API token id>\", \"oauth:<grant id>\", \"console\" or \"operator\"; null if set before this was recorded. Revoking that token lists it" }) }).openapi("UsageWebhook");
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
    stopped: z.enum(["input_required", "spend_limit", "turn_limit"]).optional().openapi({ description: "Why it stopped early: waiting on input (inputIds), a spend limit, or the run's own limits (turn_limit: its model responses or time, see runLimits)" }),
    limit: z.enum(["run", "agent", "tenant", "credit"]).optional().openapi({ description: "With stopped spend_limit, which limit stopped it: the run's own (spendLimit on the prompt), its agent's, the tenant's monthly cap, or the account's prepaid credit" }),
    inputIds: z.array(z.string()).optional(),
    replyIndex: z.number().optional().openapi({ description: "The final assistant message's index in the agent's history" }),
    messageCount: z.number().optional().openapi({ description: "Messages in the agent's history after it" }),
    steeredInto: z.string().optional().openapi({ description: "A prompt sent with whileRunning: steer that a running turn took: that turn's request" }),
  }), "A run ended without an error"),
  "run.failed": envelope("run.failed", z.object({
    ...runFacts, usage: runUsage, error: z.string(), code: z.string().optional().openapi({ description: "The failure's name, where it has one: cancelled (a stop cancelled it before it began), aborted, model_stream_stalled, turn_limit, spend_limit, output_missing..." }), uncertain: z.boolean().optional().openapi({ description: "A restart cut it short: its effects are unknown" }), steeredInto: z.string().optional(),
  }), "A run ended with an error: the runtime's, or the model's"),
  "input.requested": envelope("input.requested", z.object({
    agentId: z.string(), requestId: z.string(), inputId: z.string(), toolCallId: z.string(), kind: z.enum(["question", "approval", "form", "url"]), expiresAt: z.number(),
  }), "The agent asks a person for input; the run waits"),
  "input.resolved": envelope("input.resolved", z.object({
    agentId: z.string(), requestId: z.string(), inputId: z.string(), state: z.enum(["answered", "declined", "cancelled", "expired", "superseded"]),
  }), "An input settled"),
  "usage.recorded": envelope("usage.recorded", z.object({
    agentId: z.string().nullable().openapi({ description: "null for a transcription made with POST /v1/transcriptions, or images made with POST /v1/images, which no agent made" }), requestId: z.string().nullable(), subject: z.string().nullable(), actor: z.string().nullable(), context: z.record(z.string(), z.unknown()), keyScope: z.string().nullable(),
    provider: z.string(), model: z.string(), kind: z.enum(["response", "compaction", "transcription", "image"]).openapi({ description: "response: a model response of a run; compaction: a summary of older context; transcription: audio transcribed (audioSeconds of it; no tokens); image: images made (images of them; input is text and image tokens in, output image tokens out)" }), input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(),
    reasoning: z.number().optional(), audioSeconds: z.number().optional().openapi({ description: "For a transcription: the seconds of audio billed" }), images: z.number().optional().openapi({ description: "For images made: how many" }), cost: z.object({ usd: z.number(), source: z.enum(["provider", "catalog"]) }), at: z.number(),
  }), "A model response's usage and cost, a transcription's, or images'"),
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
  toolCallStreaming: z.union([z.boolean(), z.literal("unknown")]).openapi({ description: "Whether the model streams tool-call arguments as it writes them. true: toolcall_delta events arrived while the call was generated in every probe, so a client can render a section as it is written. false: the arguments came in one piece when the call was complete, in at least one probe, so streaming cannot be counted on. \"unknown\": not measured" }),
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
/** A mount as given: a volume, or the agent's own workspace. */
export const MountInput = z.union([Mount, z.strictObject({
  workspace: z.boolean(),
  path: z.string().optional().openapi({ description: "With true: where it is mounted, absolute and normalized (default /workspace), e.g. /scratch beside a project volume at /workspace", example: "/scratch" }),
}).openapi("WorkspaceMount", {
  description: "The agent's own workspace volume, where attachments, tool outputs and scratch files go. It is mounted at /workspace beside the mounts given (last) unless they leave it out: true places it at this position (at `path`), false leaves it out, and a mount given at /workspace takes its place",
})]).openapi("MountInput");

export const SpendLimitInput = z.object({ usd: z.number().min(0).max(1_000_000) }).strict().openapi("SpendLimitInput", {
  description: "The most the agent may spend on model calls (their token cost, compaction included) from when this is set: a new value starts counting from zero. At it, new prompts get 402 and a running turn ends with stopped \"spend_limit\"",
});

export const RunLimits = z.strictObject({
  maxResponses: z.number().int().min(1).max(1_000_000).optional().openapi({ description: "Model responses one run may make, compaction summaries included; default and at most the runtime's maximum (1,000 unless its operator set another)" }),
  maxSeconds: z.number().int().min(1).max(31_536_000).optional().openapi({ description: "Seconds one run may take from when it began; default and at most the runtime's maximum (7,200, 2 hours, unless its operator set another). A turn still inside a model request or tool call 60 seconds past it is aborted then, with stopped \"turn_limit\"" }),
  firstTokenSeconds: z.number().int().min(1).max(3_600).optional().openapi({ description: "Seconds one model request may wait for the model's first token (text, thinking or a tool call) before it fails as stalled and is retried; default the runtime's (120, or 300 for a reasoning model at thinkingLevel high and up)" }),
  idleSeconds: z.number().int().min(1).max(3_600).optional().openapi({ description: "Seconds a model response may go quiet once it streams before it fails as stalled and is retried; default the runtime's (45)" }),
}).openapi("RunLimits", {
  description: "The most one run may take, and how long its model requests may go quiet. At maxResponses or maxSeconds, the turn ends before its next model request, after the tool calls of the response that reached it, with stopped \"turn_limit\" and code turn_limit; send another message to continue. Values above the runtime's maximums count as those. A model request that stalls (firstTokenSeconds, idleSeconds) is retried like other transient provider errors; when retries run out the run fails with code model_stream_stalled",
});

export const MaxOutputTokens = z.number().int().min(1).openapi("MaxOutputTokens", {
  description: "The most the model writes in one response, at most its own maximum (maxTokens in GET /v1/models); default that maximum. A response that reaches it ends with stopReason \"length\". A Claude model on a thinking budget gets the budget on top; elsewhere reasoning counts toward it. Compaction summaries keep the runtime's own",
});
export const Temperature = z.number().min(0).max(2).openapi("Temperature", {
  description: "Sampling temperature, 0 to 2; default the provider's. Lower is more deterministic. 400 for a model that takes none: Claude Opus 4.7 and later, Sonnet 5.5 and Fable models, models that always reason (o-series, GPT-5), and any reasoning model at a thinkingLevel other than off. Compaction summaries keep the runtime's own",
});

export const ModelHeaders = z.record(z.string(), z.string()).openapi("ModelHeaders", {
  description: "Non-secret headers sent on each of the agent's model calls, after a key scope entry's, e.g. cf-aig-metadata. At most 20 and 8 KB; never authorization, x-api-key, x-goog-api-key, cf-aig-authorization, chatgpt-account-id, x-agent-runtime-identity, x-amz-* or transport headers",
});

// Documentation only: sessionConfig validates provisioning, with the messages the SDKs rely on.
const Builtin = z.enum(["web_fetch", "web_search", "schedule", "ask_user", "delegate", "generate_image", "agents"]).openapi("Builtin", { description: "agents: sub-agents in the background (spawn_agent, wait_agent, list_agents), with the delegate settings" });
const AgentTarget = z.union([
  z.string().openapi({ description: "A definition's key or id; the model sees it by that name" }),
  z.strictObject({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().openapi({ description: "What the model calls it; default: the definition's or agent's key" }),
    definition: z.string().optional().openapi({ description: "A definition's key or id" }),
    agent: z.string().optional().openapi({ description: "An existing agent's key. The agent keeps its history across calls; a definition makes a new child each call" }),
    description: z.string().max(1000).optional().openapi({ description: "What it is for, for the model; default: the definition's description" }),
  }),
]).openapi("AgentTarget");
export const DelegateSettings = z.strictObject({
  agents: z.array(AgentTarget).max(32).optional().openapi({ description: "Who the model may delegate to: definitions (a new child agent for each call) and existing agents by key" }),
  instructions: z.boolean().optional().openapi({ description: "Let the model start a child with instructions of its own instead, on its own model" }),
  maxDepth: z.number().int().min(1).max(5).optional().openapi({ description: "How deep delegation may go: a child is depth 1, its child depth 2. Default 2" }),
  maxParallel: z.number().int().min(1).max(16).optional().openapi({ description: "delegate calls of one run in flight at once (more wait their turn), and the agent's background sub-agents running at once (spawn_agent past it is refused). Default 4" }),
}).openapi("DelegateSettings", { description: "With the delegate or agents builtin: who the model may hand tasks to, and how deep and wide. See the multi-agent guide" });
export const AbortInput = z.strictObject({
  queued: z.enum(["cancel", "keep"]).optional().openapi({ description: "cancel (default): the runs queued behind the running one (prompts, steered messages not yet read, continues, executions) are cancelled too, each ending with code cancelled, so nothing runs after the stop. keep: only the running turn is stopped, and the next queued run starts" }),
  children: z.enum(["abort", "keep"]).optional().openapi({ description: "abort (default): the agent's running background sub-agents (spawn_agent) are aborted too, and their notifications follow with status aborted. keep: they go on" }),
}).openapi("AbortInput");
export const Aborted = z.object({
  aborted: z.literal(true),
  cancelled: z.array(z.string()).openapi({ description: "The ids of the queued runs the stop cancelled" }),
}).openapi("Aborted");
export const PromptInput = z.object({
  text: z.string({ error: SEND_TEXT }).optional().openapi({ description: "The message. It may be left out when the message attaches audio, whose transcript is then the message" }),
  actor: z.string().optional().openapi({ description: "Who is acting in this turn (a user id in your app): `act` in its tools' identity tokens" }),
  from: z.strictObject({
    id: z.string().openapi({ description: "The sender's id in your app; the model may rely on it" }),
    name: z.string().optional().openapi({ description: "Display name, chosen by the sender" }),
    username: z.string().optional().openapi({ description: "Handle, chosen by the sender" }),
  }).optional().openapi({ description: "Who sent this message. The model sees it in a block only the runtime can write; `from.id` is also the turn's actor unless `actor` is given" }),
  requestId: z.string().optional().openapi({ description: "Idempotency: retrying with the same id returns the same request. The user message records it, so a UI can match its own bubble" }),
  allowDisconnected: z.boolean().optional().openapi({ description: "Run even though the agent's tools need its application and none is connected (else 409 APPLICATION_NOT_CONNECTED): its calls then fail as not connected" }),
  whileRunning: z.enum(["queue", "steer"]).optional().openapi({ description: "What happens if the agent is working on a turn when this arrives. queue (default): it runs as the next turn. steer: the running turn takes it after its current step. The 202 says so at once (steer: \"accepted\"; \"queued\" when no turn could take it), and this request completes as soon as the turn takes the message (steeredInto names the turn, whose own request has its outcome; a steer_taken event marks it), so steered messages never wait for the turn's end, nor count against the agent's queue once taken. If the turn ends first, it runs as a turn of its own. With no turn running, both start one" }),
  spendLimit: SpendLimitInput.optional().openapi({ description: "This run's own budget in USD: it ends before its next model request once it has spent this. The agent's spendLimit is unchanged and counts the run too" }),
  runLimits: z.strictObject({ maxResponses: z.number().int().min(1).optional(), maxSeconds: z.number().int().min(1).optional() }).optional().openapi({ description: "This run's own limits: at most this many model responses, or seconds. They only lower the agent's runLimits and the runtime's; at one, the run ends with stopped \"turn_limit\"" }),
  output: z.strictObject({
    schema: z.record(z.string(), z.unknown()).openapi({ description: "A JSON Schema for an object (type: \"object\"; at most 64 KB)", example: { type: "object", properties: { sentiment: { type: "string", enum: ["positive", "neutral", "negative"] } }, required: ["sentiment"] } }),
  }).optional().openapi({ description: "Structured output: the agent ends this run by calling a final_output tool whose arguments are the schema, checked against it (a call that does not fit goes back to the model with what is wrong). The run's outcome.result.output is that object. A model that answers in text instead is asked once more, with a reminder; a run that still ends without an output fails with code output_missing. The tool stays declared until a prompt without output. Not with whileRunning: steer" }),
  history: z.enum(["full", "none"]).optional().openapi({ description: "What the model sees of the agent's history in this run. full (default): all of it. none: only the system prompt (instructions, tools) and this message, as a new conversation would, without making an agent. The run is still recorded in the history (its user message carries history: \"none\"), and later runs that do not say none see it. Not with whileRunning: steer" }),
  metadata: z.record(z.string(), z.string({ error: "metadata values must be strings" }), { error: "metadata must be an object of string values" }).optional().openapi({ description: "Your own key-value data about this message (its source, a client-side id): at most 16 keys of 1–64 characters, values of at most 512. Kept on the user message (history, events, snapshots) and the request, and sent with its run's webhook events; never shown to the model", example: { source: "web", clientMessageId: "m_123" } }),
  files: z.array(z.union([
    z.strictObject({ path: z.string().openapi({ description: "A file in the agent's mounts, e.g. one uploaded with PUT /v1/agents/{id}/uploads/{requestId}/{name}" }), transcribe: TRANSCRIBE }),
    z.strictObject({ name: z.string().optional(), data: z.string().openapi({ description: "The file's bytes, base64: at most 4 MiB across a message's inline files" }), contentType: z.string().optional(), transcribe: TRANSCRIBE }),
    z.strictObject({ url: z.string().openapi({ description: "An https URL the runtime fetches the file from (public addresses only; at most 64 MiB)" }), name: z.string().optional(), contentType: z.string().optional(), transcribe: TRANSCRIBE }),
  ])).optional().openapi({ description: "Attached files (at most 20): saved in the agent's workspace under uploads/<requestId>/, named in the message, and shown natively (images, PDFs) to models that take them. Audio is transcribed before the request is accepted, and the model reads the transcript" }),
}, { error: SEND_TEXT }).refine(prompt => !!prompt.text?.trim() || !!prompt.files?.length, SEND_TEXT).openapi("PromptInput");

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
const fileArguments = z.enum(["on", "off"]).openapi({ description: "Whether the model may send the agent's files to its tools ({\"$file\": path}), and the runtime saves files they link to. Default on with auth \"runtime\", off otherwise: another party's server could be sent any file the agent can read" });
const mcpServerFields = {
  name: z.string().openapi({ description: "Its tools reach the model as <name>__<tool>: 1–32 letters and digits, single underscores between them" }),
  url: z.string().openapi({ description: "The server's Streamable HTTP (or older SSE) endpoint; https, on a public address" }),
  allowTools: z.array(z.string()).max(512).optional().openapi({ description: "Only these of its tools" }),
  denyTools: z.array(z.string()).max(512).optional().openapi({ description: "None of these of its tools" }),
  exposure: z.enum(["direct", "codemode", "both"]).optional().openapi({ description: "How the model calls its tools: directly, from js_exec (the default), or both" }),
  timeoutMs: z.number().int().min(1_000).max(1_200_000).optional().openapi({ description: "How long a call may go without an answer; default 60000. Each progress notification the server sends restarts it, up to 1200000 in all" }),
  audience: z.string().optional().openapi({ description: "With auth \"runtime\": the tokens' aud, when not the server's url (behind a proxy, say): a URL on its origin, or a name that stays when the server moves, urn:camelrun:<tenant>:<name>" }),
  approval: z.strictObject(approvalFields).optional().openapi({ description: "Which tools the user approves before each call. Those tools are declared to the model directly; an approved call carries _meta[\"agent-runtime/approval\"] and an approval claim in its identity token" }),
  fileArguments: fileArguments.optional(),
};
const McpServerInput = z.object({
  ...mcpServerFields,
  headers: z.record(z.string(), z.string()).optional().openapi({ description: "Sent with every request to the server; stored encrypted and never returned. Leave out with auth to keep the ones stored for a server of this name and origin" }),
  auth: SourceAuthInput.optional(),
}).openapi("McpServerInput");
const McpServer = z.object({
  ...mcpServerFields,
  headerNames: z.array(z.string()).optional().openapi({ description: "Headers the server gets; their values are never returned" }),
  auth: SourceAuth.optional(),
}).openapi("McpServer");
/** An agent's or run's own MCP server: a definition's fields, but no credentials (see the tools guide). */
const InlineMcpServerInput = z.looseObject({
  ...mcpServerFields,
  auth: z.looseObject({ type: z.literal("runtime", { error: "An agent's or run's own MCP servers carry no credentials: give auth { type: \"runtime\" } or none, and no headers. A server that needs a token or headers goes in a definition" }) }).optional()
    .openapi({ description: "Each request carries a JWT the runtime signs, naming the tenant, agent, subject, context and actor (no definition); verify it against /.well-known/jwks.json. The only auth an agent's own server takes" }),
}).openapi("InlineMcpServerInput", { description: "An MCP server of the agent's (or run's) own, as a definition's is, but with no credentials: no headers and no bearer token (a 400 says to use a definition, which seals them once). Not listed when saved: a server that cannot be listed shows in a run's sourceErrors" });

export const AgentInput = z.object({
  mcp: z.object({ tools: z.array(z.unknown()) }).optional().openapi({ description: "The application's attached MCP server: its tools/list, whose tools the agent calls back through the application's connection. The SDKs send it" }),
  definition: z.string().optional().openapi({ description: "Make the agent from this definition (GET /v1/definitions). It supplies the model, system prompt, thinking level, fileTools and tool sources; name, type, ttlSeconds, mounts and initialMessages given here override its defaults. model, thinkingLevel, maxOutputTokens, temperature, fileTools, codeMode and runLimits given here are the agent's own: applying the definition later keeps them. systemPrompt cannot be given with a definition; use systemPromptAppend" }),
  name: z.string().optional(),
  type: z.string().optional(),
  model: z.string().optional().openapi({ description: "A model id from GET /v1/models; the runtime default when omitted" }),
  systemPrompt: z.string().optional(),
  systemPromptAppend: z.string().max(32_000).optional().openapi({ description: "Text after the system prompt, e.g. per-conversation context. The agent's own: applying its definition replaces the prompt and keeps this" }),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  maxOutputTokens: MaxOutputTokens.optional(),
  temperature: Temperature.optional(),
  initialMessages: z.array(z.unknown()).optional().openapi({ description: "History to begin with (a conversation from elsewhere): Pi user, assistant and toolResult messages, and compactionSummary messages, the last of which stands in for everything before it. Only when the agent is made; at most 16 MB of JSON. See the multi-user guide" }),
  importMessages: z.object({
    format: z.enum(["anthropic", "openai-responses", "openai-chat"]).openapi({ description: "anthropic: Messages API messages; openai-responses: Responses API input items; openai-chat: Chat Completions messages" }),
    messages: z.array(z.unknown()),
    model: z.string().optional().openapi({ description: "The model that wrote the assistant turns, as provider/model-id: its signed thinking or encrypted reasoning is sent back to that same model; any other model gets reasoning as text, or none", example: "anthropic/claude-sonnet-5" }),
  }).optional().openapi({ description: "History to begin with in another API's format, with its tool calls and results, converted to Pi messages (initialMessages; not both). Images must be base64 or data: URLs; system and developer messages are left out (the agent's prompt replaces them). Only when the agent is made" }),
  fileTools: z.boolean().openapi({ description: "false: the model gets no file tools (read, write, edit, ls, glob, grep), only present_file; the mounts stay open to fs in js_exec, attachments and tool outputs. For applications with file tools of their own" }).optional(),
  codeMode: z.boolean().openapi({ description: "false: no js_exec (code mode). The model calls every tool directly, and the system prompt carries only the runtime text those tools need: for an agent with no tools (with fileTools: false too, and no builtins or tool sources), only the application's instructions and a short note on who sent each message. For a tool-less agent, such as a classifier. Best set when the agent is made: changed later, its tools change, while a conversation under way keeps the runtime text it began with" }).optional(),
  ttlSeconds: z.number().int().nullable().optional().openapi({ description: "Agent lifetime: 60 to 31622400 seconds, or null to live until deleted. Default: until deleted for an agent made with an Idempotency-Key, 86400 for one made without" }),
  idleTtlSeconds: z.number().int().min(60).max(31_622_400).nullable().optional().openapi({ description: "Instead of ttlSeconds: the agent lives this long (60 to 31622400 seconds) from its latest run, so one in use is kept and one left idle expires. Not with ttlSeconds" }),
  mounts: z.array(MountInput).optional().openapi({ description: "Volumes for the agent's file tools. Its own workspace volume is at /workspace beside them unless they include {workspace: false} or a mount at /workspace; {workspace: true, path?} places it. The first is where relative paths resolve" }),
  remount: z.boolean().optional().openapi({ description: "An upsert of an existing agent: true sets the mounts given, between its turns, where other mounts are a 409" }),
  subject: z.string().optional().openapi({ description: "Who the agent acts for (a user id in your app): the `sub` of the identity tokens its tool servers with auth \"runtime\" get. Set only here" }),
  context: z.record(z.string(), z.unknown()).optional().openapi({ description: "Claims your tool servers need (org, workspace, thread…), carried as `ctx` in its identity tokens; at most 4 KB. Set only here" }),
  builtins: z.array(Builtin).max(8).optional().openapi({ description: "Tools the runtime answers itself (web_fetch, web_search, schedule, ask_user, delegate, generate_image, agents), for an agent without a definition; one made from a definition has its definition's. An upsert without builtins leaves the agent none" }),
  delegate: DelegateSettings.optional().openapi({ description: "With the delegate or agents builtin: who the agent may hand tasks to. Not with a definition, whose own it takes" }),
  mcpServers: z.array(InlineMcpServerInput).max(64).optional().openapi({ description: "Remote MCP servers whose tools the runtime calls for the agent, for an agent without a definition; one made from a definition has its definition's. No credentials: auth \"runtime\" or none. An upsert without mcpServers leaves the agent none" }),
  keyScope: z.string().optional().openapi({ description: "A key scope (PUT /v1/key-scopes/{scope}/providers/{provider}) whose keys the agent's model calls use first, before the tenant's own", example: "org_abc123" }),
  spendLimit: SpendLimitInput.optional(),
  runLimits: RunLimits.optional().openapi({ description: "The most one run may take (model responses, seconds); an agent from a definition gets the definition's unless this is given" }),
  modelHeaders: ModelHeaders.optional(),
  prompt: PromptInput.optional().openapi({ description: "A first prompt, as POST /v1/agents/{id}/prompt takes it, sent once the agent is made: it runs as soon as the agent has started, so a new conversation needs one call. Give it a requestId: a retry of the create (same Idempotency-Key) with the same requestId makes no second agent and sends no second prompt" }),
}).strict().openapi("AgentInput");


export const AgentSummary = z.object({
  id: z.string(),
  key: z.string().nullable().openapi({ description: "The key it was made with (an upsert's, or POST /v1/agents' Idempotency-Key); null for one made without" }),
  name: z.string().openapi({ description: "Its name; its id when it was given none" }),
  type: z.string(),
  model: z.string(),
  configHash: z.string().openapi({ description: "A hash of the agent's configuration as its upserts set it (model, instructions, tools, builtins, name…): an upsert of the same configuration gives the same hash, changes nothing and is not counted as an agent create. Opaque; compare it, never parse it. It may change once when the runtime changes how configurations are stored" }),
  connected: z.boolean().openapi({ description: "Whether an application serving its attached tools (an SDK's upsert with tools) is connected" }),
  running: z.boolean().openapi({ description: "Whether it is loaded in a runtime node's memory now, idle or not. It does not mean a turn is going: a request's state says that" }),
  expiresAt: z.number().nullable(),
  resume: z.object({ failures: z.number(), after: z.number() }).nullable().openapi({ description: "Loads of its unfinished work that failed, or found no room, and when the next may be tried: put off, doubling, at most an hour apart, never for good" }),
  parentAgentId: z.string().optional().openapi({ description: "For a child a delegate or spawn_agent call made: the agent whose run made it" }),
}).openapi("AgentSummary");

const Outcome = z.object({ result: z.unknown().optional(), error: z.string().optional(), uncertain: z.boolean().optional() }).openapi("Outcome");

/** Whether an agent is busy, from its run records: GET /v1/agents/{id}, its state and a status request all say the same. */
const Activity = z.object({
  busy: z.boolean().openapi({ description: "Whether the agent has a run open: one going (activeRun) or queued (queuedRuns). From its request records, as its state and a status request say it too" }),
  activeRun: z.string().nullable().openapi({ description: "The run that has begun and not ended, if any" }),
  queuedRuns: z.number().int().openapi({ description: "Runs accepted and waiting behind it (prompts, steered messages not yet read, continues, executions, resumes)" }),
});
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
  resumes: z.number().optional().openapi({ description: "Times a node resumed this run's turn after the node running it was lost (its calls in flight closed as of unknown outcome); at most 2" }),
  handoffs: z.array(z.object({ reason: z.enum(["retire", "drain"]), at: z.number() })).optional().openapi({ description: "Times a node leaving the cluster (retire: a newer deploy replaced it; drain: it was stopped) handed this run's turn off at a step boundary, and the next owner continued it with nothing lost. Not resumes" }),
  steeredInto: z.string().optional().openapi({ description: "A prompt with whileRunning: steer that a running turn took: that turn's request. This request completes as the turn takes the message; the turn's request has the turn's outcome (reply, output...)" }),
  steer: z.enum(["accepted", "queued"]).optional().openapi({ description: "A prompt with whileRunning: steer, as it was accepted: accepted, the running turn reads it after its current step; queued, no turn could take it, so it runs as a turn of its own" }),
  abortedAt: z.number().optional().openapi({ description: "When the agent was stopped while this run was going: it ends as aborted, and is never resumed elsewhere" }),
  outcome: Outcome.optional().openapi({ description: "result.code names a run's failure where it has a name: cancelled (a stop cancelled it before it began), aborted (stopped while it ran), model_stream_stalled (its model stopped answering, past every retry), turn_limit, spend_limit, agent_loop_limit (a sub-agent's notification landed without a turn: its chain reached its wake cap), output_missing, model_key_missing, model_key_invalid. result.stopped is input_required when the turn waits on human input, listed in result.inputs. A run's result also has reply, replyIndex, files, toolErrors and toolCalls: every tool call it made (the first 100), as {tool, toolCallId?, innerCallId?, ok, code?, agentId?} (agentId: the child a delegate or spawn_agent call ran), without arguments or results. result.output is a structured answer, for a prompt sent with output. result.usage.subagentCostUsd is what its children spent, and result.usage.imageCostUsd what its generate_image calls spent" }),
  error: z.string().optional().openapi({ description: "An ended request's error, from its outcome: the runtime's (outcome.error) or the model's (outcome.result.error). Absent when it succeeded" }),
  stopped: z.enum(["input_required", "spend_limit", "turn_limit", "agent_loop_limit"]).optional().openapi({ description: "Why an ended run stopped early (outcome.result.stopped)" }),
  status: z.enum(["completed", "input_required", "failed"]).optional().openapi({ description: "How an ended request ended (state says only that it ended): failed when it has an error or stopped at a spend or turn limit; input_required when it waits on people. Absent while running" }),
  trace: z.object({
    traceId: z.string(), spanId: z.string().openapi({ description: "The run's own span" }),
    parentSpanId: z.string().optional().openapi({ description: "The span it continues: the caller's traceparent, or the run a resume continues" }),
    sampled: z.boolean(),
  }).optional().openapi({ description: "A run's place in its trace, when the tenant exports telemetry (PUT /v1/telemetry)" }),
}).openapi("RequestRecord");
export const AgentCredentials = z.object({
  id: z.string(),
  token: z.string().openapi({ description: "The agent's scoped credential for /clients routes" }),
  expiresAt: z.number().nullable(),
  configHash: z.string().optional().openapi({ description: "The configuration it has (see AgentSummary.configHash)" }),
}).openapi("AgentCredentials");
export const AgentCreated = z.looseObject({
  id: z.string(),
  token: z.string().optional().openapi({ description: "The agent's scoped credential for /clients routes; absent for an OAuth access token's caller, which may not hold one" }),
  expiresAt: z.number().nullable(),
  configHash: z.string().openapi({ description: "The hash of the configuration this create or upsert asked for (see AgentSummary.configHash): the agent has it once `reconfigured` applies. The same as the agent's before: the upsert changed nothing, and was not counted as a create" }),
  reconfigured: RequestRecord.optional().openapi({ description: "An upsert of an existing agent: the configure request bringing it to this configuration between its turns" }),
  prompt: z.union([RequestRecord, z.object({ error: z.object({ status: z.number(), code: z.string(), message: z.string() }) })]).optional()
    .openapi({ description: "The first prompt's request, when one was given: accepted, or refused (spend limit, capacity, model) with why, the agent made regardless; send it again with POST /v1/agents/{id}/prompt" }),
  warnings: z.array(z.string()).optional().openapi({ description: "Builtins the agent has that its tenant cannot use yet, and how to fix it: web_search without a key for any of its search providers (add one with PUT /v1/providers/{provider}/key)" }),
}).openapi("AgentCreated");

const Sender = z.strictObject({ id: z.string(), name: z.string().optional(), username: z.string().optional() });

const RunInputPart = z.union([
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({ type: z.literal("file"), name: z.string().optional(), data: z.string().openapi({ description: "The file's bytes, base64: at most 4 MiB across a run's inline files" }), contentType: z.string().optional(), transcribe: TRANSCRIBE }),
  z.strictObject({ type: z.literal("file"), url: z.string().openapi({ description: "An https URL the runtime fetches the file from (public addresses only; at most 64 MiB)" }), name: z.string().optional(), contentType: z.string().optional(), transcribe: TRANSCRIBE }),
]).openapi("RunInputPart");
export const RunInput = z.strictObject({
  input: z.union([z.string(), z.array(RunInputPart).min(1)]).openapi({ description: "What the run is asked: text, or parts (text and files, inline or by URL). Files are saved in a workspace volume the run gets for them; audio is transcribed for the model" }),
  definition: z.string().optional().openapi({ description: "Take the configuration from this definition (its key or id; GET /v1/definitions): model, system prompt, thinking level, tool sources. Fields given here override it, as for an agent" }),
  model: z.string().optional().openapi({ description: "A model id from GET /v1/models; the runtime default when omitted" }),
  systemPrompt: z.string().optional(),
  systemPromptAppend: z.string().max(32_000).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  maxOutputTokens: MaxOutputTokens.optional(),
  temperature: Temperature.optional(),
  builtins: z.array(z.enum(["web_fetch", "web_search", "delegate", "generate_image"])).max(8).optional().openapi({ description: "Tools the runtime answers itself (generate_image gives the run a workspace for its images). Not schedule or ask_user: a run has no later and no one to ask" }),
  delegate: DelegateSettings.optional(),
  mcpServers: z.array(InlineMcpServerInput).max(64).optional().openapi({ description: "Remote MCP servers whose tools the run may call, as an agent's own: no credentials (auth \"runtime\" or none). A server that cannot be listed shows in sourceErrors" }),
  fileTools: z.boolean().optional().openapi({ description: "true: the run gets a workspace volume and file tools. Default: none, unless input has files" }),
  codeMode: z.boolean().optional().openapi({ description: "true: the model gets js_exec. Default: true when the run has tools (builtins, MCP servers, a definition, files), false for a tool-less run, whose model then sees only your instructions" }),
  mounts: z.array(Mount).optional().openapi({ description: "Existing volumes for the run's file tools" }),
  output: PromptInput.shape.output,
  keyScope: z.string().optional(),
  modelHeaders: ModelHeaders.optional(),
  spendLimit: SpendLimitInput.optional().openapi({ description: "The run's budget in USD: it ends before its next model request once it has spent this" }),
  runLimits: RunLimits.optional(),
  subject: z.string().optional().openapi({ description: "Who the run acts for (a user id in your app): `sub` in its tool servers' identity tokens" }),
  context: z.record(z.string(), z.unknown()).optional().openapi({ description: "Claims your tool servers need, as `ctx` in its identity tokens; at most 4 KB" }),
  actor: PromptInput.shape.actor,
  from: PromptInput.shape.from,
  metadata: PromptInput.shape.metadata,
  name: z.string().optional().openapi({ description: "A name for the run, in its traces" }),
  wait: z.union([z.boolean(), z.number().min(0)]).optional().openapi({ description: "Wait for the run to end before answering: true for up to 60 seconds, or a number of seconds (at most 60). It answers 200 with the ended run, or 202 with it still running when the wait ends. Default: answer at once, 202. ?wait=<seconds> does the same" }),
  retentionSeconds: z.number().int().min(60).max(7 * 86_400).optional().openapi({ description: "How long the run's result, events and messages are kept once it ends, before they are deleted: 60 to 604800 seconds. Default: the runtime's (86400)" }),
}).openapi("RunInput");
const RunFailure = z.object({
  code: z.string().openapi({ description: "Stable: model_error, runtime_error, output_missing, spend_limit, turn_limit, aborted…" }),
  message: z.string(),
  uncertain: z.boolean().optional().openapi({ description: "The runtime could not tell whether the run's work took effect" }),
}).openapi("RunFailure");
export const Run = z.object({
  id: z.string().openapi({ description: "run_…" }),
  status: z.enum(["running", "completed", "input_required", "failed"]).openapi({ description: "running until it ends; then completed, failed, or input_required (a tool asked for approval or input, which a run cannot wait on: it ends there)" }),
  text: z.string().openapi({ description: "The final reply's text (\"\" while running, or when it said nothing)" }),
  output: z.unknown().optional().openapi({ description: "For a run with output: the answer, which fits its schema" }),
  error: RunFailure.nullable(),
  usage: z.record(z.string(), z.unknown()).nullable().openapi({ description: "What its model calls used: responses, input, output, cacheRead, cacheWrite, costUsd (and subagentCostUsd, what its sub-agents spent; imageCostUsd, what its generate_image calls spent)" }),
  toolCalls: z.array(z.record(z.string(), z.unknown())),
  toolErrors: z.array(z.record(z.string(), z.unknown())),
  sourceErrors: z.array(z.record(z.string(), z.unknown())),
  files: z.array(z.record(z.string(), z.unknown())),
  metadata: z.record(z.string(), z.string()).optional(),
  createdAt: z.number().optional(),
  startedAt: z.number().optional().openapi({ description: "When it began running" }),
  endedAt: z.number().optional(),
  expiresAt: z.number().nullable().openapi({ description: "Once it ended: when its result, events and messages are deleted. null while it runs" }),
  resumes: z.number().optional().openapi({ description: "Times it was resumed after the node running it was lost (at most 2)" }),
  handoffs: z.array(z.object({ reason: z.enum(["retire", "drain"]), at: z.number() })).optional().openapi({ description: "Times a node leaving the cluster handed it to another at a step boundary, with nothing lost" }),
}).openapi("Run");
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

export const ForkedFrom = z.object({
  agentId: z.string().openapi({ description: "The agent it was forked from" }),
  atMessage: z.number().nullable().openapi({ description: "The history index of that agent's last message it began with; null: it began with none" }),
}).openapi("ForkedFrom");
export const AgentForkInput = z.object({
  key: z.string().optional().openapi({ description: "The fork's own key, like a create's Idempotency-Key (that header is taken too): a retry with it returns the same fork, and agents.get finds it. Default: a new key, as a create without one" }),
  name: z.string().optional().openapi({ description: "Default: the source's name, with (fork)" }),
  atMessage: z.union([z.number().int(), z.string()]).optional().openapi({ description: "Where the fork's history ends. A history index: that message, and the tool results that answer it. A request id: the whole turn that request ran. Default: the last turn that ended, never one still running or waiting on input (409 FORK_POINT_RUNNING for a message in such a turn)" }),
  ttlSeconds: z.number().int().nullable().optional().openapi({ description: "The fork's lifetime: 60 to 31622400 seconds, or null to live until deleted. Default: until deleted with a key, 86400 without" }),
  subject: z.string().optional().openapi({ description: "Who the fork acts for, instead of the source's subject (fixed once it is made, as at a create)" }),
  context: z.record(z.string(), z.unknown()).optional().openapi({ description: "Context for the fork's tool servers' identity tokens, instead of the source's (fixed once it is made, as at a create)" }),
  systemPromptAppend: z.string().max(32_000).optional().openapi({ description: "The fork's own text after the system prompt (e.g. its conversation's context), instead of the source's; \"\" removes it" }),
  modelHeaders: ModelHeaders.nullable().optional().openapi({ description: "The fork's own headers on each model call (e.g. its conversation for attribution), instead of the source's; null removes them" }),
}).openapi("AgentForkInput");
export const AgentForked = z.object({
  id: z.string(),
  token: z.string().optional().openapi({ description: "The fork's scoped credential for /clients routes; absent for an OAuth access token's caller, which may not hold one" }),
  expiresAt: z.number().nullable(),
  forkedFrom: ForkedFrom,
}).openapi("AgentForked");

export const AgentDetail = AgentSummary.extend({
  definition: z.object({ id: z.string(), revision: z.number() }).optional().openapi({ description: "The definition the agent was made from, and the revision it has" }),
  tools: z.array(ToolDefinition).openapi({ description: "The tools your application declared, which it answers" }),
  toolSources: z.array(ToolSource).openapi({ description: "Every source of the agent's tools, in order of precedence, and what each offers the model" }),
  mounts: z.array(Mount),
  systemPrompt: z.string(),
  systemPromptAppend: z.string().optional(),
  fileTools: z.literal(false).optional().openapi({ description: "Present when the model gets no file tools but present_file" }),
  codeMode: z.literal(false).optional().openapi({ description: "Present when the agent has no js_exec, and the model calls every tool directly" }),
  keyScope: z.string().nullable().openapi({ description: "The key scope its model calls take keys from first" }),
  modelHeaders: ModelHeaders.nullable(),
  builtins: z.array(Builtin).openapi({ description: "The tools the runtime answers itself: its own, or its definition's" }),
  delegate: DelegateSettings.nullable().openapi({ description: "Who it may delegate to, with the delegate or agents builtin" }),
  mcpServers: z.array(McpServer).openapi({ description: "Its remote MCP servers: its own, or its definition's (without credentials' values)" }),
  parentRunId: z.string().optional().openapi({ description: "For a child a delegate or spawn_agent call made: the run of parentAgentId that made it" }),
  spendLimit: z.object({ usd: z.number(), spent: z.number().openapi({ description: "Model spend since the limit was set" }) }).nullable(),
  runLimits: RunLimits.nullable().openapi({ description: "Its own run limits, as set; null: the runtime's" }),
  maxOutputTokens: MaxOutputTokens.nullable().openapi({ description: "The most its model writes in one response, as set; null: the model's maximum" }),
  temperature: Temperature.nullable().openapi({ description: "Its model's sampling temperature, as set; null: the provider's default" }),
  forkedFrom: ForkedFrom.optional().openapi({ description: "For a fork (POST /v1/agents/{id}/fork): the agent and message it was forked from" }),
  ...Activity.shape,
  cursor: z.number(),
  events: z.array(z.object({ id: z.number(), data: z.unknown() })),
  requests: z.array(RequestRecord),
}).openapi("AgentDetail");

export const SessionState = z.object({
  cursor: z.number().openapi({ description: "The agent's latest event id: a stream opened with it as Last-Event-ID continues from here" }),
  requests: z.array(RequestRecord).openapi({ description: "Recent requests (the running ones and the latest settled), with their outcomes" }),
  ...Activity.shape,
  resume: z.object({ failures: z.number(), after: z.number() }).optional().openapi({ description: "For an agent no node holds, whose unfinished work's loads are put off: how many times, and until when" }),
}).openapi("SessionState");
export const EventPoll = z.object({
  cursor: z.number().openapi({ description: "Send as Last-Event-ID on the next poll" }),
  events: z.array(z.object({ id: z.number(), data: z.unknown() })),
}).openapi("EventPoll");

export const BrowserTokenInput = z.object({
  ttlSeconds: z.number().int().min(5).max(3600).optional().openapi({ description: "How long it lives: 5 to 3600 seconds, default 900. Nothing revokes it sooner" }),
  scopes: z.array(z.enum(["events", "state", "history", "inputs", "children"])).optional().openapi({ description: "What it reads of the agent: GET /v1/agents/{id}/<scope>. Default events, state, history and inputs. children: it reads the same of the agent's background sub-agents (spawn_agent's), by their ids" }),
  events: z.array(z.string()).max(64).optional().openapi({ description: "Only these event types (message_update, tool_execution_end, ...) reach it; default every one but the runtime's own (codemode, compaction_usage, spend_limit_reached, turn_limit_reached). Outcomes (response) and snapshots always do, an outcome only as whether and why its run stopped" }),
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
export const Revoked = z.object({
  revoked: z.literal(true),
  left: z.array(z.object({ kind: z.enum(["webhook", "usage-webhook", "telemetry"]), id: z.string().optional(), url: z.string() })).openapi({ description: "The webhooks and trace export this credential last pointed somewhere, which keep sending: review them, and change or delete any you do not recognize" }),
}).openapi("Revoked");
export const Token = z.object({ id: z.string(), name: z.string(), prefix: z.string(), createdAt: z.number() }).openapi("Token");
export const OAuthGrant = z.object({
  id: z.string(), clientName: z.string().openapi({ description: "The name the application registered with" }),
  login: z.string().nullable().openapi({ description: "Who consented, when they signed in with GitHub" }),
  scope: z.string(), createdAt: z.number(), usedAt: z.number().nullable().openapi({ description: "When it last got tokens" }),
}).openapi("OAuthGrant");
export const TokenCreated = Token.extend({ token: z.string().openapi({ description: "The secret; shown only once" }) }).openapi("TokenCreated");

const Totals = z.object({
  responses: z.number(), input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), cost: z.number().openapi({ description: "Usage cost in USD: model calls use provider-reported cost or a catalog estimate, excluding model credit funding; tool-ranking costs already include their funding" }),
  platformResponses: z.number().openapi({ description: "Responses that ran on a key that is not the tenant's own" }),
  platformCost: z.number().openapi({ description: "Cost in USD on platform keys, including configured provider credit funding costs; prepaid tenants pay it from credit" }),
});
const TranscriptionFields = {
  language: z.string().optional().openapi({ description: "The audio's language, ISO 639-1 (en) or a locale (pt-BR); detected when left out" }),
  prompt: z.string().max(2_000).optional().openapi({ description: "Words and spellings to expect (names, jargon), or the conversation so far: a hint to the model, at most 2,000 characters" }),
  keyScope: z.string().optional().openapi({ description: "A key scope whose OpenAI key is used first, before the tenant's own" }),
  subject: z.string().optional().openapi({ description: "Who it is for (a user id in your app): usage.recorded's subject" }),
  context: z.record(z.string(), z.unknown()).optional().openapi({ description: "Your claims (org, workspace…), carried as usage.recorded's context; at most 4 KB" }),
  actor: z.string().optional().openapi({ description: "Who asked (a user id in your app): usage.recorded's actor" }),
};
export const TranscriptionInput = z.strictObject({
  data: z.string().optional().openapi({ description: "The audio's bytes, base64 (at most 25 MB decoded). Or send it as multipart/form-data, the audio in a part named file" }),
  url: z.string().optional().openapi({ description: "An https URL to fetch the audio from (public addresses only)" }),
  ...TranscriptionFields,
}).refine(input => (input.data === undefined) !== (input.url === undefined), "Send the audio as data (base64) or url, one of them").openapi("TranscriptionInput");
export const TranscriptionForm = z.object({
  file: z.any().openapi({ type: "string", format: "binary", description: "The audio: Ogg (Opus, Vorbis), WebM, MP3, M4A/MP4, WAV or FLAC; at most 25 MB and 30 minutes" }),
  language: TranscriptionFields.language, prompt: TranscriptionFields.prompt, keyScope: TranscriptionFields.keyScope,
  subject: TranscriptionFields.subject, context: z.string().optional().openapi({ description: "JSON of your claims, as context above" }), actor: TranscriptionFields.actor,
}).openapi("TranscriptionForm");
export const Transcription = z.object({
  text: z.string(),
  language: z.string().nullable().openapi({ description: "The language the provider heard (or was told), when it says" }),
  durationSeconds: z.number().openapi({ description: "Seconds of audio billed" }),
  model: z.string().openapi({ example: "openai/gpt-transcribe" }),
  costUsd: z.number().openapi({ description: "What it cost at the runtime's price: charged to prepaid credit when it ran on the platform's key" }),
}).openapi("Transcription");
const ImageSource = z.union([
  z.strictObject({ data: z.string().openapi({ description: "The image's bytes, base64" }) }),
  z.strictObject({ url: z.string().openapi({ description: "An https URL to fetch the image from (public addresses only)" }) }),
]);
const ImageFields = {
  prompt: z.string().min(1).max(32_000).openapi({ description: "What to make, or how to change the images given: at most 32,000 characters" }),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).optional().openapi({ description: "Square, landscape or portrait. Default 1024x1024" }),
  quality: z.enum(["low", "medium", "high"]).optional().openapi({ description: "Default medium. Higher quality costs more (see Pricing) and takes longer" }),
  format: z.enum(["png", "jpeg", "webp"]).optional().openapi({ description: "The images' format. Default png" }),
  background: z.enum(["transparent", "opaque"]).optional().openapi({ description: "transparent needs png or webp. Default: the model's choice" }),
  keyScope: TranscriptionFields.keyScope,
  volumeId: z.string().optional().openapi({ description: "Save the images into this volume of yours (under path) and answer their paths, instead of their bytes" }),
  path: z.string().max(1_000).optional().openapi({ description: "With volumeId: the directory to save them in. Default /images" }),
  subject: TranscriptionFields.subject, context: TranscriptionFields.context, actor: TranscriptionFields.actor,
};
export const ImageInput = z.strictObject({
  ...ImageFields,
  n: z.number().int().min(1).max(4).optional().openapi({ description: "How many images to make, 1 to 4. Default 1" }),
  images: z.array(ImageSource).max(4).optional().openapi({ description: "Images to edit (at most 4; PNG, JPEG or WebP, 25 MB each and 50 MB in all): the prompt says how to change or combine them" }),
  mask: ImageSource.optional().openapi({ description: "Where to edit the first image: transparent where it may change, an image with an alpha channel in its format and size" }),
}).openapi("ImageInput");
export const ImageForm = z.object({
  ...ImageFields,
  n: z.string().optional().openapi({ description: "How many images to make, 1 to 4" }),
  context: z.string().optional().openapi({ description: "JSON of your claims, as context in ImageInput" }),
  image: z.any().optional().openapi({ type: "string", format: "binary", description: "An image to edit; a part each, at most 4" }),
  mask: z.any().optional().openapi({ type: "string", format: "binary", description: "A mask for the first image" }),
}).openapi("ImageForm");
export const Images = z.object({
  images: z.array(z.object({
    contentType: z.string().openapi({ example: "image/png" }), width: z.number().optional(), height: z.number().optional(),
    data: z.string().optional().openapi({ description: "The image, base64 (without volumeId)" }),
    volumeId: z.string().optional(), path: z.string().optional().openapi({ description: "Where it was saved (with volumeId): read it with GET /v1/volumes/{id}/files/{path}" }),
    size: z.number().optional(), version: z.number().optional(),
  })),
  model: z.string().openapi({ example: "openai/gpt-image-2.5-flare" }),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).openapi({ description: "The tokens the provider billed: text and images in, images out" }),
  costUsd: z.number().openapi({ description: "What it cost at the runtime's price: charged to prepaid credit when it ran on the platform's key" }),
}).openapi("Images");

export const Usage = z.object({
  since: z.number(),
  totals: Totals,
  days: z.array(Totals.extend({ day: z.string(), model: z.string(), kind: z.enum(["turn", "compaction", "transcription", "image"]).openapi({ description: "turn: the agent's own responses; compaction: summaries of older context; transcription: audio transcribed (responses counts transcriptions); image: images made (responses counts images)" }) })),
}).openapi("Usage");

const ThinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DefinitionLimits = z.object({
  ttlSeconds: z.number().int().nullable().optional().openapi({ description: "Agent lifetime: 60 to 31622400 seconds, or null to live until deleted. Default: until deleted for an agent made with an Idempotency-Key, 86400 for one made without" }),
  idleTtlSeconds: z.number().int().min(60).max(31_622_400).nullable().optional().openapi({ description: "Instead of ttlSeconds: the agent lives this long (60 to 31622400 seconds) from its latest run, so one in use is kept and one left idle expires. Not with ttlSeconds" }),
}).openapi("DefinitionLimits");
const definitionName = z.string().trim().min(1).max(120);
const openApiFields = {
  name: z.string().openapi({ description: "Its operations reach the model as <name>__<operationId>: 1–32 letters and digits, single underscores between them" }),
  baseUrl: z.string().optional().openapi({ description: "Where requests go; default the spec's first server. https, on a public address" }),
  allowTools: z.array(z.string()).max(1024).optional().openapi({ description: "Only these operations (by operationId); at most 1024 in all" }),
  denyTools: z.array(z.string()).max(4096).optional().openapi({ description: "None of these operations" }),
  exposure: z.enum(["direct", "codemode", "both"]).optional().openapi({ description: "How the model calls its operations: directly, from js_exec (the default), or both" }),
  timeoutMs: z.number().int().min(1_000).max(1_200_000).optional().openapi({ description: "Per call; default 30000" }),
  audience: z.string().optional().openapi({ description: "With auth \"runtime\": the tokens' aud, when not baseUrl (behind a proxy, say): a URL on its origin, or a name that stays when the server moves, urn:camelrun:<tenant>:<name>" }),
  approval: z.strictObject({ ...approvalFields, methods: z.array(z.enum(["GET", "PUT", "POST", "DELETE", "PATCH", "HEAD", "OPTIONS"])).optional().openapi({ description: "Operations of these methods, unless named in tools" }) }).optional()
    .openapi({ description: "Which operations the user approves before each call. They are declared to the model directly; with auth \"runtime\", an approved call's identity token carries an approval claim" }),
  fileArguments: fileArguments.optional(),
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
const definitionFields = {
  description: z.string().trim().min(1).max(1000).openapi({ description: "What its agents are for, in a sentence or two: shown to models as the description of each agent's MCP tool (/v1/agents/{id}/mcp)" }),
  model: z.string().openapi({ description: "A model id from GET /v1/models; the runtime default when omitted" }),
  systemPrompt: z.string().trim().min(1).max(32_000),
  thinkingLevel: ThinkingLevel,
  maxOutputTokens: MaxOutputTokens,
  temperature: Temperature,
  fileTools: z.boolean().openapi({ description: "false: the model gets no file tools (read, write, edit, ls, glob, grep), only present_file; the mounts stay open to fs in js_exec, attachments and tool outputs. For applications with file tools of their own" }),
  codeMode: z.boolean().openapi({ description: "false: its agents get no js_exec and call every tool directly (AgentInput.codeMode)" }),
  limits: DefinitionLimits,
  runLimits: RunLimits,
  mounts: z.array(MountInput).max(16).openapi({ description: "Volumes for each agent's file tools, beside its own workspace at /workspace unless they include {workspace: false}" }),
  builtins: z.array(Builtin).max(8).openapi({ description: "Tools the runtime answers itself: web_fetch reads a public page as text (rendering JavaScript-only pages through Firecrawl when a firecrawl key resolves); web_search searches the web through the first search provider with a key that answers (the tenant's own, else the platform's, which a prepaid tenant pays for per search at that provider's price); schedule lets the agent set, list and cancel its own wake-ups; ask_user lets the model ask the user questions, suspending its turn until they answer; generate_image makes or edits an image (OpenAI's gpt-image-2.5-flare on the tenant's OpenAI key, else the platform's, billed per token) and saves it to the workspace" }),
  webSearch: z.object({
    providers: z.array(z.enum(["exa", "brave", "parallel"])).min(1).max(3).openapi({ description: "The providers web_search tries, in order; each is skipped without a key, and the next is tried when one fails, times out or is rate limited", example: ["brave"] }),
  }).strict().openapi({ description: "Pin web_search to providers of your choosing instead of the runtime's order (exa, brave, parallel by default)" }),
  mcpServers: z.array(McpServerInput).max(64).openapi({ description: "Remote MCP servers whose tools the runtime calls for the agent" }),
  openApi: z.array(OpenApiInput).max(64).openapi({ description: "OpenAPI specs whose operations the runtime calls for the agent, as tools" }),
  delegate: DelegateSettings,
  humanInput: z.strictObject({
    expiresInSeconds: z.number().int().min(60).max(30 * 86_400).optional().openapi({ description: "How long an input waits for an answer: 7 days by default, at most 30, and never past the agent's own expiry" }),
    onExpire: z.enum(["close", "resume"]).optional().openapi({ description: "close (default): an expired input closes its call and the turn without the model; resume: the model is told and continues" }),
    approvers: z.array(z.string()).max(100).optional().openapi({ description: "Who may answer any input besides the person whose message started the turn: actors, or channel senders like slack:U0123" }),
  }).openapi({ description: "Questions, approvals and setup steps the agent's turns wait on" }),
  applyOnUpdate: z.boolean().openapi({ description: "true: every save that makes a new revision (an upsert that changes it, or a PATCH) also applies it to every live agent made from the definition, as apply: \"all\" does, and answers with applied. Default false: only new agents get a new revision" }),
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
  warnings: z.array(z.string()).optional().openapi({ description: "On a save: builtins its agents could not use yet, and how to fix it: web_search without a key for any of its search providers (add one with PUT /v1/providers/{provider}/key), generate_image without an OpenAI key" }),
}).openapi("Definition");
export const ApplyResult = z.object({
  agent: z.string(),
  requestId: z.string().openapi({ description: "The agent's configure request: poll GET /v1/agents/{agent}/requests/{requestId} for a queued one's outcome" }),
  status: z.enum(["updated", "queued", "failed"]).openapi({ description: "updated: the agent has the revision; queued: it takes it between its turns; failed: see error" }),
  error: z.string().optional(),
}).openapi("ApplyResult");
export const DefinitionUpdated = Definition.extend({
  applied: z.array(ApplyResult).optional().openapi({ description: "With apply: \"all\", or applyOnUpdate on a save that made a new revision: one entry per live agent made from the definition" }),
}).openapi("DefinitionUpdated");
export const DefinitionAgent = z.object({ id: z.string(), revision: z.number() }).openapi("DefinitionAgent");

export const ConfigureInput = z.object({
  requestId: z.string().min(1).optional(),
  model: z.string().optional().openapi({ description: "Model id from GET /v1/models" }),
  systemPrompt: z.string().min(1).max(32_000).optional(),
  systemPromptAppend: z.string().max(32_000).optional().openapi({ description: "Text after the system prompt; empty removes it" }),
  thinkingLevel: ThinkingLevel.optional(),
  maxOutputTokens: MaxOutputTokens.nullable().optional().openapi({ description: "Replaces the most its model writes in one response; null removes it (the model's maximum)" }),
  temperature: Temperature.nullable().optional().openapi({ description: "Replaces its model's sampling temperature; null removes it (the provider's default). Refused (400) when the agent's model or thinking level, after this change, takes none" }),
  keyScope: z.string().nullable().optional().openapi({ description: "The key scope its model calls take keys from first; null for the tenant's keys. Applying a definition keeps it" }),
  spendLimit: SpendLimitInput.nullable().optional().openapi({ description: "A new budget from now, applied at once, ahead of queued runs; null removes it" }),
  runLimits: RunLimits.nullable().optional().openapi({ description: "Replaces the agent's run limits from its next run; null removes them (the runtime's apply). Set here on an agent from a definition, they stay when the definition is applied" }),
  modelHeaders: ModelHeaders.nullable().optional().openapi({ description: "Replaces the agent's model headers; null or {} removes them" }),
  builtins: z.array(Builtin).max(8).optional().openapi({ description: "Replaces the agent's builtins; [] removes them. Not for an agent made from a definition, whose builtins are its definition's" }),
  delegate: DelegateSettings.nullable().optional().openapi({ description: "Replaces who the agent may delegate to (with the delegate builtin); null removes it" }),
  mcpServers: z.array(InlineMcpServerInput).max(64).nullable().optional().openapi({ description: "Replaces the agent's own MCP servers; null or [] removes them. No credentials: auth \"runtime\" or none. Not for an agent made from a definition, whose servers are its definition's" }),
}).strict().refine(input => Object.keys(input).some(key => key !== "requestId"), "Give at least one configuration field").openapi("ConfigureInput", { description: "On an agent made from a definition, a model, thinkingLevel, maxOutputTokens, temperature or runLimits set here stays when the definition is applied; a systemPrompt set here is replaced by it" });

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
  credentials: z.record(z.string(), z.string().max(4096)).optional().openapi({ description: "Telegram: { botToken }. Slack: { botToken, signingSecret }. Discord: { botToken }. GitHub: { appId, privateKey, webhookSecret }. Webhook: { secret, replyUrl? }. Email: none. Required for every other type; stored encrypted and never returned" }),
  definition: z.string().optional().openapi({ description: "The definition each conversation's agent is made from (GET /v1/definitions); a channel created without one gets an empty definition of its own" }),
  access: ChannelAccess.optional(),
  limits: ChannelLimits.optional(),
  greeting: z.string().trim().min(1).max(4096).optional().openapi({ description: "Reply to /start (Telegram)" }),
  settings: z.record(z.string(), z.unknown()).optional().openapi({ description: "Configuration particular to the channel's type; types without any reject it. GitHub: { events, repos, ignoreDrafts, reply, authors, debounceSeconds }. Webhook: { signature, key, prompt, sender, filter, idPath, idHeader }. Email: { address?, fromName? }" }),
};
export const ChannelInput = z.object({ type: z.enum(["telegram", "slack", "discord", "github", "webhook", "email"]), ...channelFields }).openapi("ChannelInput");
export const ChannelUpdate = z.object(channelFields).openapi("ChannelUpdate");
export const Channel = z.object({
  id: z.string(),
  tenant: z.string(),
  type: z.string(),
  name: z.string(),
  webhookUrl: z.string().optional().openapi({ description: "Where the service delivers messages. Telegram's is registered for you; paste Slack's into the app's Event Subscriptions. Discord channels have none: they connect to Discord's gateway. Paste GitHub's into the app's Webhook URL" }),
  definition: z.string().optional().openapi({ description: "The definition each conversation's agent is made from" }),
  access: z.object({ public: z.boolean(), allow: z.array(z.string()) }),
  limits: z.object({ perSenderPerMinute: z.number(), turnsPerDay: z.number() }),
  greeting: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  account: z.record(z.string(), z.string()).openapi({ description: "The bot's identity at the provider" }),
  credentials: z.record(z.string(), z.string()).openapi({ description: "Masked credentials" }),
  createdAt: z.number(),
  updatedAt: z.number(),
}).openapi("Channel");

export const MountsInput = z.object({ mounts: z.array(MountInput) }).openapi("MountsInput");

export const VolumeInput = z.object({
  name: z.string().optional(),
  key: z.string().optional().openapi({ description: "Your name for the volume (1–200 letters, digits and ._:-): the first create with a key makes it, every later one answers with it (existing: true), for as long as it lives. A deleted one's key makes no other" }),
}).openapi("VolumeInput");
export const VolumeSummary = z.object({ id: z.string(), name: z.string(), createdAt: z.number() }).openapi("VolumeSummary");
export const Volume = VolumeSummary.extend({
  seq: z.number().openapi({ description: "Increases with every change to the volume" }),
  files: z.number(),
  bytes: z.number(),
  origin: z.object({ volume: z.string(), snapshot: z.string().optional(), seq: z.number() }).optional().openapi({ description: "What a fork was copied from" }),
}).openapi("Volume");
export const ForkInput = z.object({ name: z.string().optional(), snapshot: z.string().optional().openapi({ description: "Fork this snapshot instead of the current state" }) }).openapi("ForkInput");
const FileValue = z.object({
  uri: z.string().openapi({ description: "A URL to the file, bound to the call (GET /v1/files/{token}/{name}), or a data: URI" }),
  name: z.string(), mimeType: z.string(), size: z.number(),
  digest: z.object({ algorithm: z.literal("sha-256"), value: z.string().openapi({ description: "Hex" }) }).optional().openapi({ description: "Absent for files over 64 MiB" }),
}).openapi("FileValue", { description: "A file sent to a tool, as MCP SEP-2631 (draft) describes one" });
export const FileManifest = z.object({
  snapshot: z.string().openapi({ description: "The snapshot made for the call, which every URL here reads" }),
  root: z.string().openapi({ description: "The directory, as the agent names it" }),
  files: z.array(FileValue.extend({ path: z.string().openapi({ description: "Relative to root" }) })),
  archive: z.object({ uri: z.string(), mimeType: z.literal("application/gzip") }).openapi({ description: "Every file, as a tar.gz with paths relative to root" }),
}).openapi("FileManifest", { description: "A directory sent to a tool: its files as they were when the call was made" });
export const RestoreInput = z.strictObject({ snapshot: z.string().openapi({ description: "The snapshot (snap_…) to make the volume as" }) }).openapi("RestoreInput");
export const Restored = z.object({
  snapshot: z.string(), seq: z.number().openapi({ description: "The volume's seq after the restore" }),
  written: z.number().openapi({ description: "Files written back as the snapshot had them" }), removed: z.number().openapi({ description: "Files the snapshot did not have, removed" }),
}).openapi("Restored");
const Labels = z.record(z.string(), z.string()).openapi({ description: "Your own labels, e.g. {\"release\": \"v12\"}: at most 16, keys of 1–64 characters, values of at most 256" });
export const Snapshot = z.object({
  id: z.string(), volume: z.string(), name: z.string(), seq: z.number(), createdAt: z.number(), files: z.number(), bytes: z.number(),
  pinned: z.boolean().openapi({ description: "Kept until unpinned: publish's pruning passes it by, it counts against 10,000 pinned snapshots rather than the 100 others, and deleting it takes unpinning or force" }),
  labels: Labels,
}).openapi("Snapshot");
export const SnapshotInput = z.object({
  name: z.string().optional().openapi({ description: "1–120 characters; default seq <n>" }),
  pinned: z.boolean().optional(),
  labels: Labels.optional(),
  files: z.record(z.string(), z.union([z.string(), z.object({ data: z.string().openapi({ description: "Base64" }), contentType: z.string().optional() })])).optional()
    .openapi({ description: "A snapshot of these files (path to text, or {data} in base64) instead of the volume: the volume and its seq are untouched. At most 1,000 files and 16 MiB. For bringing in versions kept elsewhere" }),
}).openapi("SnapshotInput");
export const SnapshotMade = Snapshot.extend({
  contents: z.array(z.object({ path: z.string(), size: z.number(), sha256: z.string().openapi({ description: "Hex" }) })).optional()
    .openapi({ description: "A snapshot made from contents: each file as stored, to check against what was sent" }),
}).openapi("SnapshotMade");
export const SnapshotUpdate = z.object({ pinned: z.boolean().optional(), labels: Labels.optional().openapi({ description: "Replaces its labels" }) }).openapi("SnapshotUpdate");
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
  urlPath: z.string().openapi({ description: "The url's path on the runtime: for a proxy that serves the link at its own origin, in front of a runtime browsers cannot reach" }),
  method: z.enum(["GET", "PUT"]), tenant: z.string(), volume: z.string(), path: z.string(), expiresAt: z.number(),
  maxBytes: z.number().optional(), contentType: z.string().optional(),
}).openapi("Link");
export const FileList = z.object({ files: z.array(VolumeFile), next: z.string().optional().openapi({ description: "Pass as `after` for the next page" }) }).openapi("FileList");
export const FileContents = z.object({
  seq: z.number().openapi({ description: "The volume's change number the files were read at (the snapshot's, for a snapshot)" }),
  snapshot: z.string().optional(),
  files: z.array(z.object({
    path: z.string(), size: z.number(), version: z.number(), contentType: z.string(),
    sha256: z.string().openapi({ description: "Of the file's bytes, hex" }),
    text: z.string().optional().openapi({ description: "The contents, for a file that is UTF-8 text" }),
    data: z.string().optional().openapi({ description: "The contents base64, for any other file" }),
  })),
}).openapi("FileContents");
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
  metadata: z.record(z.string(), z.unknown()).openapi({ description: "usage: one entry per UTC hour (`hour`, its start), updated until the hour ends, with tokens (micro-USD on platform keys), funding (provider credit funding adjustment in micro-USD) and activeMs; storage: day and bytes" }),
  createdAt: z.number(),
}).openapi("LedgerEntry");
export const Ledger = z.object({
  entries: z.array(LedgerEntry).openapi({ description: "Newest first" }),
  next: z.number().int().optional().openapi({ description: "Pass as `before` for the next page" }),
}).openapi("Ledger");
export const BusyAgents = z.object({
  busy: z.number().int().optional().openapi({ description: "Agents busy now across the runtime: each has a run open (running or queued)" }),
  limit: z.number().int().openapi({ description: "How many may be busy at once; a run past it gets 429 BUSY_AGENT_LIMIT" }),
  source: z.enum(["tier", "tenant", "default"]).openapi({ description: "tier: the usage tier's (prepaid tenants, by what they have paid); tenant: set for this tenant by the operator; default: the deployment's" }),
  tier: z.string().optional().openapi({ description: "The usage tier, with source tier", example: "Tier 1" }),
  paid: micros("What the tenant has paid for credit, net of refunds (starting credit and adjustments do not count); with source tier").optional(),
  next: z.object({
    tier: z.string(), paid: micros("Paid in total that reaches it"), limit: z.number().int().openapi({ description: "Its busy-agent limit" }),
  }).optional().openapi({ description: "The next tier up, if any" }),
}).openapi("BusyAgents");
export const Billing = z.object({
  billing: z.enum(["prepaid", "none"]).openapi({ description: "prepaid: runs are paid from credit; none: not billed by the runtime" }),
  balance: micros("Credit left; at zero or below, runs are refused with 402"),
  purchased: micros("Credit bought over the account's life, net of refunds"),
  freeCredit: z.boolean().openapi({ description: "Whether the tenant has only ever had free credit, which comes with tighter limits" }),
  checkout: z.boolean().openapi({ description: "Whether credit can be bought here (POST /v1/billing/checkout)" }),
  busyAgents: BusyAgents.openapi({ description: "How many agents may be busy at once, and why: a tier moves up as soon as a payment lands" }),
  runsPerMinute: z.object({
    limit: z.number().int().openapi({ description: "Runs the account may start a minute" }),
    afterPurchase: z.number().int().nullable().optional().openapi({ description: "On free credit: what buying credit raises it to (null: no limit)" }),
  }).nullable().optional().openapi({ description: "The account's run rate limit; null when none applies" }),
  startingCredit: z.object({
    status: z.enum(["granted", "not_eligible", "not_granted", "not_applicable"]),
    amount: micros("The amount of starting credit actually awarded, independent of the current grant setting"),
    cardCheck: z.object({ amount: micros("Starting credit a card check would add") }).optional()
      .openapi({ description: "Present when verifying a card (POST /v1/billing/card-check) would unlock starting credit" }),
  }),
  month: z.object({
    since: z.number(),
    grant: micros("Granted this UTC month"), purchase: micros("Bought"), usage: micros("Spent on model tokens and agent time"),
    storage: micros("Spent on storage"), adjustment: micros("Adjusted by the operator"), refund: micros("Refunded"),
  }),
  recent: z.array(LedgerEntry),
  rates: z.object({
    agentHour: micros("Per hour an agent spends in a turn, metered continuously"),
    storageGbMonth: micros("Per GB-month stored, charged daily"),
    openrouterCreditMultiplier: z.number().nonnegative().openapi({ description: "Dollars paid per dollar of OpenRouter credit; applied to platform model calls and OpenRouter tool ranking, separately from the checkout fee" }),
    purchaseFeeBps: z.number().int().openapi({ description: "Fee on credit purchases, in basis points" }),
    minPurchase: micros("Smallest purchase"), maxPurchase: micros("Largest purchase"),
    webSearch: z.object({ exa: micros("Per search Exa answers"), brave: micros("Per search Brave answers"), parallel: micros("Per search Parallel answers") }).openapi({ description: "Per web_search on the platform's key for the provider that answered" }),
    webRender: micros("Per page web_fetch has Firecrawl render on the platform's key"),
    transcription: micros("Per minute of audio transcribed on the platform's OpenAI key (gpt-transcribe), billed per second"),
    image: z.object({ textInput: micros("Per million text tokens in"), imageInput: micros("Per million image tokens in (images to edit)"), output: micros("Per million image tokens out") }).openapi({ description: "Images made on the platform's OpenAI key (gpt-image-2.5-flare), per token as the provider bills" }),
  }).openapi({ description: "Model usage on platform keys passes through provider-reported cost (catalog estimate if unavailable) plus provider credit funding costs; tools.search's ranking by meaning is charged at cost" }),
}).openapi("Billing");
export const BillingAlertChoices = z.object({ low: z.boolean(), depleted: z.boolean(), problems: z.boolean(), receipts: z.boolean() });
export const BillingRecipient = z.object({ id: z.uuid(), email: z.email(), status: z.enum(["pending", "verified", "bounced", "unsubscribed"]), events: BillingAlertChoices });
export const BillingAlerts = z.object({ threshold: micros("Low-balance threshold"), emailEnabled: z.boolean(), recipients: z.array(BillingRecipient) });
export const BillingRecipientInput = z.object({ email: z.email().max(254), events: BillingAlertChoices.optional() });
export const BillingAlertThreshold = z.object({ thresholdUsd: z.number().min(0.01).max(500) });
export const BillingConfirmationInput = z.object({ token: z.string().max(100) });
export const BillingUnsubscribe = z.union([
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.enum(["ready", "unsubscribed"]), tenant: z.string(), email: z.string() }),
]);
export const BillingConfirmation = z.union([
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.enum(["ready", "confirmed"]), tenant: z.string(), email: z.email() }),
]);
export const AdjustmentInput = z.object({
  tenant: z.string(),
  amount: z.number().int().refine(value => value !== 0 && Math.abs(value) <= 1e12, "amount must be a non-zero integer of micro-USD").openapi({ description: "Micro-USD to add (negative to remove)" }),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/).optional().openapi({ description: "Repeating an adjustment with the same key applies it once" }),
}).openapi("AdjustmentInput");
export const StartingCreditGrantInput = z.object({
  tenant: z.string(),
  amountUsd: z.number().min(1).max(100).openapi({ description: "Starting credit to award in USD ($1–$100, whole cents), once per GitHub identity", example: 5 }),
  reason: z.string().trim().min(1).max(500).openapi({ description: "Private support audit note; never included in the tenant's ledger" }),
}).openapi("StartingCreditGrantInput");
export const BillingPortalInput = z.object({ flow: z.enum(["manage", "payment_method"]).default("manage"), resumeAutoTopup: z.boolean().optional() }).strict();
export const BillingPortal = z.object({ url: z.string() });
export const BillingPaymentMethod = z.object({
  portal: z.boolean(), customer: z.boolean(),
  card: z.object({ brand: z.string(), last4: z.string(), expMonth: z.number(), expYear: z.number() }).nullable(),
});
export const CheckoutInput = z.object({
  requestId: z.uuid().optional().openapi({ description: "Reuse this UUID when retrying the same purchase; a different amount needs a new UUID" }),
  amountUsd: z.number().openapi({ description: "Credit to buy, in USD with at most two decimals; the fee is added on top", example: 10 }),
}).openapi("CheckoutInput");
export const CardCheck = z.object({ url: z.string().openapi({ description: "Send the account holder here to verify a card; nothing is charged" }) }).openapi("CardCheck");
export const CardCheckConfirmInput = z.object({ session: z.string().openapi({ description: "The Checkout session id Stripe returned to the console" }) }).strict().openapi("CardCheckConfirmInput");
export const CardCheckOutcome = z.object({
  status: z.enum(["granted", "not_granted", "pending"]).openapi({ description: "granted: starting credit was added; not_granted: this card check added none; pending: Stripe has not finished the check" }),
  amount: micros("Starting credit added"),
}).openapi("CardCheckOutcome");
export const Checkout = z.object({
  id: z.string().openapi({ description: "The Stripe Checkout session" }),
  url: z.string().openapi({ description: "Send the buyer here to pay" }),
  amount: micros("Credit bought"), fee: micros("Fee"), total: micros("Charged"),
}).openapi("Checkout");


export const AutoTopupTerms = z.object({ thresholdUsd: z.number(), amountUsd: z.number(), monthlyLimitUsd: z.number() }).strict();
const AutoCard = z.object({ brand: z.string(), last4: z.string(), expMonth: z.number(), expYear: z.number() }).nullable();
export const AutoTopupQuote = z.object({ id: z.uuid(), version: z.string(), threshold: z.number(), amount: z.number(), fee: z.number(), total: z.number(), monthlyLimit: z.number(), card: AutoCard, immediate: z.boolean(), expiresAt: z.number() });
export const AutoTopup = z.object({ enabled: z.boolean(), state: z.enum(["off","on","processing","cancelling","action_required","paused_declined","paused_no_card","paused_expired","limit_reached","reconcile"]), version: z.number(), threshold: z.number(), amount: z.number(), fee: z.number(), total: z.number(), monthlyLimit: z.number(), usedThisPeriod: z.number(), held: z.number(), resetsAt: z.number(),
  attempt: z.object({ id: z.uuid(), state: z.string(), amount: z.number(), fee: z.number(), total: z.number(), card: AutoCard, invoiceUrl: z.string().nullable(), canRetry: z.boolean(), submitted: z.boolean() }).nullable() });
export const AutoTopupConsent = z.object({ quoteId: z.uuid(), version: z.string().length(64), consent: z.literal(true) }).strict();
export const AutoTopupRetry = z.object({ attemptId: z.uuid() }).strict();
export const AccountDeletionInput = z.object({
  confirm: z.string().openapi({ description: "The account's tenant id, as GET /v1/me gives it, to confirm deleting that account" }),
}).openapi("AccountDeletionInput");
export const AccountDeletion = z.object({
  tenant: z.string(),
  state: z.enum(["deleting", "deleted"]).openapi({ description: "deleting: the account no longer signs in or authenticates, and its data is being deleted; deleted: all of it is gone but the ledger, usage and payment records kept for accounting" }),
  requestedAt: z.number(),
  completedAt: z.number().nullable(),
  agents: z.number().int().optional().openapi({ description: "While deleting: agents not yet purged" }),
}).openapi("AccountDeletion");
export const TenantInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).openapi({ description: "The new tenant's id: lowercase letters, digits and dashes (max 40)", example: "lab-ts-chat" }),
  tokenName: z.string().trim().min(1).max(80).default("api").openapi({ description: "Name of the API token made with it" }),
}).strict().openapi("TenantInput");
export const TenantCreated = z.object({ tenant: z.string(), token: TokenCreated }).openapi("TenantCreated");
export const TenantLimitsInput = z.object({
  maxStorageGb: z.number().min(0).max(1_000_000).nullable().optional().openapi({ description: "GB (10^9 bytes) the tenant may store in all, in place of its plan's (1 GB on free credit, 100 GB once it has bought credit); null returns to the plan's" }),
  maxBusyAgents: z.number().int().min(1).max(1_000_000).nullable().optional().openapi({ description: "Agents the tenant may have busy at once across the runtime, in place of its usage tier's; null returns to the tier's" }),
  agentCreatesPerMinute: z.number().int().min(1).max(1_000_000).nullable().optional().openapi({ description: "Agents the tenant may create a minute, in place of its plan's (10 on free credit, else 60); null returns to the plan's" }),
  runsPerMinute: z.number().int().min(1).max(1_000_000).nullable().optional().openapi({ description: "Runs the tenant may start a minute, in place of its plan's (60 on free credit, else 600); null returns to the plan's" }),
  maxRunResponses: z.number().int().min(1).max(1_000_000).nullable().optional().openapi({ description: "Model responses one run of the tenant's agents may make, in place of the runtime's (1,000 by default); null returns to the runtime's" }),
  maxRunSeconds: z.number().int().min(1).max(31_536_000).nullable().optional().openapi({ description: "Seconds one run of the tenant's agents may take, in place of the runtime's (7,200 by default); null returns to the runtime's" }),
  codeCpuMs: z.number().int().min(1).max(30_000).nullable().optional().openapi({ description: "CPU milliseconds one js_exec execution may use, in place of the runtime's (2,000); null returns to the runtime's" }),
  codeMaxTimeoutMs: z.number().int().min(1).max(120_000).nullable().optional().openapi({ description: "The longest timeoutMs (wall time) a js_exec execution may ask for, in place of the runtime's (60,000); null returns to the runtime's" }),
  codeConcurrency: z.number().int().min(1).max(1_000).nullable().optional().openapi({ description: "js_exec executions the tenant may run at once on one node, in place of its plan's (2 on free credit, else 4); null returns to the plan's" }),
  codeEngine: z.null({ error: "codeEngine was removed with QuickJS: js_exec runs on V8 only. Leave it out, or send null to clear one set before" }).optional().openapi({ deprecated: true, description: "Removed with QuickJS: js_exec runs on V8 only. null clears an engine set before; any other value is refused" }),
}).strict().openapi("TenantLimitsInput");
export const TenantLimits = z.object({
  tenant: z.string(),
  limits: z.object({ maxStorageGb: z.number().optional(), maxBusyAgents: z.number().int().optional(), agentCreatesPerMinute: z.number().int().optional(), runsPerMinute: z.number().int().optional(), maxRunResponses: z.number().int().optional(), maxRunSeconds: z.number().int().optional(), codeCpuMs: z.number().int().optional(), codeMaxTimeoutMs: z.number().int().optional(), codeConcurrency: z.number().int().optional() }).openapi({ description: "The limits set for the tenant; those absent are its plan's" }),
}).openapi("TenantLimits");
export const TenantPasswordInput = z.object({
  email: z.string().max(254).openapi({ description: "The address the tenant signs in with; another tenant's is refused (409)", example: "reviewer@example.com" }),
  password: z.string().min(12).max(256).openapi({ description: "12 to 256 characters. Only its scrypt hash is kept" }),
}).strict().openapi("TenantPasswordInput");
export const TenantPassword = z.object({
  tenant: z.string(),
  email: z.string().nullable().openapi({ description: "The sign-in address, or null once the password is removed" }),
  signedOut: z.number().int().openapi({ description: "How many of the tenant's password sessions ended" }),
}).openapi("TenantPassword");
export const TenantLookup = z.object({
  tenant: z.string(),
  github: z.string().nullable(),
  googleEmail: z.string().nullable(),
  email: z.string().nullable().openapi({ description: "The address it signs in with a password, if any" }),
  createdAt: z.number(),
}).openapi("TenantLookup");

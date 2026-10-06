import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { AgentConfig, Credentials, RunLimits, ToolDefinition } from "./protocol.ts";
import { errorText } from "./protocol.ts";
import { enqueueEvents, usageCost, webhookEvent, type WebhookEvent } from "./webhooks.ts";
import { AgentSupervisor } from "./supervisor.ts";
import { platformUsage } from "./platform-pricing.ts";
import { configurationUpdate, type CustomProviders, type ModelEndpoints } from "./session-config.ts";
import { outputInput, validateDefinitions } from "./tool-policy.ts";
import { importedHistory, validateUserMessages } from "./history.ts";
import { forkCut, recordedMessages, type Backlog, type TranscriptRecord } from "./transcript.ts";
import { canonical } from "../shared/durable-json.ts";
import type { AppendLog } from "../shared/append-log.ts";
import { fileStorage, type Storage } from "../shared/storage.ts";
import { FRAME_BYTES, outcomeEnding, type ClientEvent, type Outcome, type RequestMethod, type RequestRecord, type TurnSnapshot } from "../shared/client-protocol.ts";
import { agentMetadata, type AgentMetadata } from "../shared/agent-metadata.ts";
import { scheduleInput, type Scheduler } from "./scheduler.ts";
import { errorCode, errorFields, errorHeaders, errorStatus, HttpError, readJson } from "./http.ts";
import { VolumeService, type Mount } from "./volumes.ts";
import { databaseUnavailable, type Db, type Sql } from "./db.ts";
import { LostClaim, underClaim, type Claim, type Ownership } from "./ownership.ts";
import type { BusyAgents } from "./busy-agents.ts";
import { deleteTail } from "./log-tail.ts";
import { OVERRIDES, type DefinitionRef } from "./definitions.ts";
import type { Sources, ToolSources } from "./tool-sources.ts";
import { builtinsInput } from "./builtins.ts";
import { callParams, contentResult, type McpResult } from "./mcp-results.ts";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AttachedServer } from "./attached.ts";
import { actorInput, type AgentIdentity, type TokenClaims } from "./identity.ts";
import { metadataInput, senderInput } from "./sender.ts";
import { callMeta, compose, jsonResult, TOOL_DEADLINES, timedOut, toolCallKey, ToolFailure, type RunToolCall, type ToolCallCode, type ToolError, defaultExposure, describeSources, fileServer, type Progress, type ToolCall, type ToolServer, type ToolSourceView } from "./tool-servers.ts";
import { searchTools, type Reranker, type SearchQuery } from "./tool-search.ts";
import { CodeGate, codeCapacity, type CodeLimits } from "./codemode.ts";
import { CODE_LIMITS } from "./limits.ts";
import { declaredType, FILE_LIMITS, fileResponse, safeName, validFileRef, type FileLinks, type FileRef } from "./files.ts";
import { fileRef } from "./inspect.ts";
import { resolve as resolveMount, type ToolContext, type WrittenFile } from "./volume-tools.ts";
import { HistoryIndex, type HistoryPage } from "./history-pages.ts";
import { answerInput, argumentsHash, expiresAt, INPUT_LIMITS, inputRequests, inputView, mayAnswer, resolution, type Answer, type Input, type Inputs, type InputRow, type Responder, type RetryPlan } from "./inputs.ts";
import { recordHandoff, recordStart, recordWatchRefused, safeError, Steps } from "./metrics.ts";
import { BackgroundSpans, inputSpans, RunSpans, type ToolSource, type Tracing } from "./telemetry.ts";
import { newSpanId, newTraceId, parseTraceparent, sampledAt } from "./otlp.ts";
import { definitionId, delegateSettings, delegateTool, MULTI_AGENT_LIMITS, PARENT_KEYS, SUBAGENT_EVENTS, type AgentTarget, type DelegateSettings } from "./multi-agent.ts";

/** Another live node owns this agent; the server forwards the request there. */
export class NotOwner extends HttpError {
  owner: string;
  constructor(owner: string) { super(503, `This agent is served by another node; retry`); this.owner = owner; }
}
type SessionConfig = Omit<AgentConfig, "id" | "directory" | "tools" | "apiKey">;
/** Rarely-changing session identity and configuration (a row in `agents`); rewritten only when it changes. */
interface SessionHeader {
  /** `expiresAt` null: the agent lives until it is deleted. */
  version: 3; id: string; digest: string; expiresAt: number | null; revoked: boolean;
  /** Owning tenant. */
  tenant: string;
  /** How many times its token was rotated (`rotateToken`): from the first, the token is derived from this, not its key. */
  tokenRotation?: number;
  metadata?: AgentMetadata; definitions: ToolDefinition[]; provisionHash: string; config: SessionConfig;
  /** Volumes the agent's file tools can reach; absent on sessions created before volumes existed. */
  mounts?: Mount[];
  /** A purged agent's tombstone keeps only its id, revoked (see `purge`): its other fields are gone, and nothing loads it again. */
  purged?: true;
  /** The definition and revision the agent was made from, or last had applied. */
  definition?: DefinitionRef;
  /** That revision's server-side tool sources, their secrets sealed under the definition. */
  sources?: Sources;
  /** Configuration the agent set itself (model, thinkingLevel), which applying its definition leaves. */
  overrides?: string[];
  /** Who the agent acts for, and context for its tool servers: set at creation by the tenant, never by the agent. */
  identity?: AgentIdentity;
  /** The key scope its model calls take keys from first (key-scopes.ts); set by the tenant, never by the agent. */
  keyScope?: string;
  /** The key it was made with (an upsert's, or a create's Idempotency-Key), shown in listings; none for one made without. */
  key?: string;
  /** sha256 of the application's tools as it last declared them (its tools/list as JSON): its ready event tells it, so it reconfigures only on a change. */
  toolsHash?: string;
  /** The agent it was forked from, and the index of the last message of that agent's history it began with (null: none). */
  forkedFrom?: ForkedFrom;
  /** A child its parent's delegate call made (multi-agent.ts): the parent agent, its run and call, and how deep in the chain it is. */
  parent?: { agentId: string; runId: string; toolCallId: string; depth: number };
}
export type ForkedFrom = { agentId: string; atMessage: number | null };
/**
 * An agent's own sources (one without a definition) once a configuration gives builtins or delegate: what it leaves out
 * stays, and the delegate settings go with their builtin (delegateSettings).
 */
function ownSources(current: Sources | undefined, given: { builtins?: unknown; delegate?: unknown }): Sources | undefined {
  const builtins = given.builtins !== undefined ? builtinsInput(given.builtins) as string[] : current?.builtins ?? [];
  const delegate = delegateSettings(builtins, given.delegate !== undefined ? given.delegate : builtins.includes("delegate") ? current?.delegate : undefined);
  const { builtins: _builtins, delegate: _delegate, ...rest } = current ?? {};
  const next: Sources = { ...rest, ...(builtins.length ? { builtins } : {}), ...(delegate ? { delegate } : {}) };
  return Object.keys(next).length ? next : undefined;
}
/** A child a delegate call of the running run is waiting on: the agent, its request, and whether the runtime made it (a named agent it did not). */
type Child = { agent: string; requestId: string; made: boolean; done?: boolean };
/**
 * Upserts of request records, appended as their state changes, and ended runs whose webhook event (`run.completed` or
 * `run.failed`) is written (`announced`). Journals from before tool calls were MCP also hold call records, which are skipped.
 */
type JournalRecord = { t: "request"; record: RequestRecord } | { t: "announced"; ids: string[] };
/** What a run's model responses (compaction summaries included) used, for its end's webhook event. */
type RunUsage = { responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
type ClientEnv = { Bindings: HttpBindings & { operatorTenant?: string }; Variables: { session: Session } };
type BufferedEvent = { id: number; bytes: number; data: ClientEvent };
/** What a running agent's history index lacks (its transcript's backlog). */
type HistoryTail = Pick<Backlog, "from" | "messages" | "turns">;
type Session = {
  header: SessionHeader;
  /** Revision of the stored header this node last read or wrote; writes are conditional on it. */
  revision?: number;
  claim?: Claim;
  requests: Map<string, RequestRecord>;
  /** The requests still running, so nothing scans every retained record. */
  running: Map<string, RequestRecord>;
  log: AppendLog<JournalRecord>;
  /** Streamed events live only in memory; durable state is recovered through /state. */
  cursor: number; events: BufferedEvent[]; eventBytes: number;
  /** The application's connection: its event stream, which carries its attached MCP server. */
  response?: ServerResponse; starting?: Promise<unknown>;
  /** Read-only subscribers (`/events?watch=1`): each gets every event, and none replaces another or the application's connection. */
  watchers: Set<ServerResponse>;
  /** Long polls waiting for the next event. */
  polls: Set<() => void>;
  /** Runs this node took over at load (queued by a drain, or a turn a dead node left): handed back, not failed, if it has no room (`handBack`). */
  inherited?: Set<string>;
  /** Its row says it has work open (`pending_runs`), as this node last wrote it. */
  pending?: boolean;
  /** It holds a busy slot (BusyAgents) on this node; `admitting` runs are being accepted, and `busyStep` orders taking and giving it up. */
  busy?: boolean; admitting?: number; busyStep?: Promise<unknown>;
  /** Given back for a node with room to take: nothing more runs here. */
  handedBack?: true;
  /** Being given up because this node is leaving (`park`, `handOffAll`): nothing more runs here, and a run cut off here stays open. */
  leaving?: true;
  /** What the running turn is doing: calling the model, or running the tool calls of its latest response (from its events). */
  step?: "model" | "tool";
  /** When this node began leaving while the turn ran, and what the turn was doing then: its hand-off's `boundaryWaitMs` and step kind. */
  handoffFrom?: { at: number; step: "model" | "tool" };
  /** The assistant message streaming now, as its latest message_update carried it. */
  partial?: unknown;
  /** What each running run's model responses used so far, for its end's webhook event. */
  usage?: Map<string, RunUsage>;
  /** Model runs' own spend limits (a prompt's `spendLimit`), in USD, by request id, while they run. */
  runLimits?: Map<string, number>;
  /** Writing the latest run's `run.started` event, which the event of its end waits for. */
  started?: Promise<void>;
  /** Whether the run in progress has its webhook events written: its tenant had an endpoint for them as it began. */
  announcing?: boolean;
  /** Tool sources that could not be listed when the agent's tools were built, for each run's outcome. */
  sourceErrors?: { kind: string; source: string; message: string }[];
  /** The running run's tool calls that did not complete, for its outcome. */
  toolErrors?: ToolError[];
  /** The running run's tool calls (the first OUTPUT_TOOL_CALLS), for its outcome. */
  toolCalls?: RunToolCall[];
  /** Prompts sent with `whileRunning: "steer"` that a running turn took, each with that turn's request: they end with it. */
  steered?: Map<string, string>;
  /** The model run in progress (prompt, continue, resume) and what its events have finished, for snapshots. */
  turn?: { requestId: string; start?: number; messages: unknown[]; count: number; bytes: number; truncated?: boolean };
  /** The application's attached MCP server, over the connection `response` is. */
  attached?: AttachedServer;
  /** Connections another replaced, kept open until the calls they have answer (see `retire`). */
  retiring?: Set<AttachedServer>;
  /** Tool calls to the application in flight: the agent is busy until they settle. */
  inflight: number;
  /** Which tool server answers each of the running agent's tools. */
  route?: Map<string, ToolServer>;
  /** The servers the running agent's tools were built from, and what each listed then. */
  servers?: ToolServer[];
  /** The tools its code reaches (not direct-only), which `tools.search` ranks. */
  searchable?: ToolDefinition[];
  /** Runs (prompt, execute, continue) execute one at a time, in the order accepted. */
  runs: Promise<void>;
  /** Runs that began on a lost node, queued here to resume their turn. */
  resuming: Set<string>;
  /** Runs marked completed whose outcome is not yet durable and published: still in flight. */
  settling: number;
  /** An execution began and its record may not be durable yet: `beforeEffect` makes it so, once. */
  beginning?: { durable?: Promise<void> };
  /** How the agent process found the interrupted turn when it started. */
  handoff?: { continue: true } | { finished: unknown };
  fault?: Error;
  /** A header write failed with the database unreachable, so the stored revision is unknown. */
  unsettled?: boolean;
  lastActive: number;
  /** Whether the agent's current model key is the platform's, not the tenant's own. */
  platformKey?: boolean;
  /** Whether the tenant pays for responses on the platform's keys (prepaid): they are priced from the catalog (`billable`). */
  catalogPriced?: boolean;
  /** Its spend limit and what it has spent since it was set (`agent_spend_limits`); null when it has none, undefined until read. */
  spend?: SpendLimit | null;
  /** Since when a run's active time has not been reported (`onActive`). */
  activeSince?: number;
  /** What the running run wrote and handed over with present_file, for its outcome. */
  outputs?: { files: Map<string, WrittenFile>; presented: (FileRef & { caption?: string })[] };
  /** In a `resume` run, how each answered call is run again, by tool call id. */
  retries?: Map<string, RetryPlan>;
  /** A channel's conversation: someone there answers the agent's inputs. */
  channel?: boolean;
  /** The running run's spans, when its trace is exported (telemetry.ts). */
  spans?: RunSpans;
  /** A compaction between runs, when its tenant exports telemetry. */
  background?: Promise<BackgroundSpans | undefined>;
  /** Where each of the running agent's tools comes from, for its tool calls' spans. */
  toolSources?: Map<string, ToolSource>;
  /** The children the running run's delegate calls wait on, by call id: an abort of the run aborts them. */
  children?: Map<string, Child>;
  /** The running run's delegate calls in flight, and those waiting for one to finish (its `maxParallel`). */
  delegating?: { active: number; waiting: (() => void)[] };
  /** What each running run's children spent, which its own spend limit counts. */
  childSpend?: Map<string, number>;
  /** What each running run's children in flight may still spend, held for them (`delegate`), and how many hold it. */
  childHeld?: Map<string, { usd: number; holders: number }>;
  /** Listeners on this agent's stream on this node: a parent relaying its child's events to its own (`subagent_event`). */
  taps?: Set<(data: ClientEvent) => void>;
  /** Runs an abort reached after they began but before the agent had them: they end without running (see `markAborted`). */
  aborted?: Set<string>;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const validSessionId = (value: string) => /^client_[a-f0-9]{40}$/.test(value);
const has = (object: object, key: string) => Object.hasOwn(object, key);
/** `resume` continues a turn that waited on human input; the runtime makes it when the last input settles. */
const RUN_METHODS = ["prompt", "execute", "continue", "resume"];
/** How far past its time limit a run may get before it is aborted, and twice this before its agent is stopped (`overrun`). */
const RUN_OVERRUN_MS = 60_000;
/**
 * Requests queued behind the agent's runs. Each keeps its params for as long as it may
 * run again on the agent's next owner: a run until it begins, and configuration (an
 * idempotent assignment) until it settles.
 */
const QUEUED_METHODS = [...RUN_METHODS, "configure"];
/** Runs that call the model; code executions do not, so spend limits leave them alone. */
const MODEL_RUNS = ["prompt", "continue"];
/** A running run's active time is reported at least this often. */
const ACTIVE_REPORT_MS = 60_000;
/** Resumes of one run's turn before it fails as uncertain, so a turn that kills its node cannot loop. Hand-offs at a step boundary are not resumes. */
const MAX_RESUMES = 2;
/** A run's latest hand-offs its record keeps (`handoffs`): one per deploy or drain it outlived. */
const MAX_HANDOFFS_KEPT = 20;
/** What a run handed off at a step boundary had gathered for its outcome, which its next owner takes over (`takeOver`). */
type Carried = { usage?: RunUsage; childSpend?: number; spendLimit?: number; toolCalls?: RunToolCall[]; toolErrors?: ToolError[]; files?: WrittenFile[]; presented?: (FileRef & { caption?: string })[] };
/** Notified, as `<node> <agent>`, when a node gives up an agent with runs open, or ends a dead peer's heartbeat: nodes sweep at once. */
export const ORPHANS_CHANNEL = "agent_runtime_orphans";
/** A model turn that began can continue from its transcript on another node; a code execution cannot. */
const resumable = (request: RequestRecord) => ["prompt", "continue", "resume"].includes(request.method) && !!request.began;
/** Requests an agent may have accepted but not finished, queued runs included. */
const MAX_OPEN_REQUESTS = 32;
const REQUEST_METHODS = [...RUN_METHODS, "status", "abort", "steer", "configure"];
/** A configuration's fields only an upsert (the tenant making the agent again with its key) sets: see `reconfiguration`. */
const UPSERT_KEYS = ["provisionHash", "name", "type", "tools", "fileTools", "toolsHash"];
/** A batch of answers from a request: `{ answers: [{ id, action, content?, from?, actor? }] }`. */
export const answerList = (body: any) => {
  if (!Array.isArray(body?.answers)) throw new HttpError(400, "Send { answers: [{ id, action, content?, from?, actor? }] }");
  return body.answers.map(({ id, ...answer }: any) => ({ id: String(id), body: answer }));
};
/** The id of the run that resumes a suspension: one per suspension, so every path that resumes it makes the same request. */
export const resumeId = (suspension: string) => `resume_${hash(suspension).slice(0, 40)}`;
/** Settled records kept for idempotent retries once the journal is folded. */
const RETAINED_SETTLED = 256;
const FOLD_AFTER_RECORDS = 2048;
const MAX_BUFFERED_EVENTS = 512;
/** Read-only subscribers (watchers and waiting polls) one agent's stream may have at once, by default; and a tenant's and a node's. */
const MAX_WATCHERS = 32;
const MAX_TENANT_WATCHERS = 1024;
const MAX_NODE_WATCHERS = 4096;
/** The longest a load of an agent with work left is put off (see `defer`). */
const MAX_RESUME_DELAY_MS = 60 * 60_000;
/** How often an idle watcher's agent is checked for an owner elsewhere, should its load's notice be missed. */
const IDLE_CHECK_MS = 20_000;
/** A long poll waits at most this long for an event. */
const MAX_POLL_WAIT_MS = 25_000;
/** Files written in one run that its outcome lists. */
const OUTPUT_FILES = 100;
const OUTPUT_TOOL_CALLS = 100;
/** How long a tool call waits for an application to reconnect before failing as not run. */
const RECONNECT_GRACE_MS = 3_000;
/**
 * What the model (and the run's toolErrors) hears of a call whose server disconnected after it was sent: in words it
 * can pass on to a person, never the transport's ("MCP error -32000: Connection closed").
 */
const CONNECTION_LOST = "The server running this tool disconnected during the call (it restarted or lost its connection), so the call may or may not have " +
  "taken effect. Check whether it did before trying it again; if you cannot check, tell the user it is unknown whether it went through.";
/** How long a replaced connection stays open for the tool calls it has to answer. */
const DRAIN_MS = 30_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** The most a snapshot's finished messages take; beyond it, a subscriber reads the turn from history. */
const TURN_SNAPSHOT_BYTES = 1_000_000;
/**
 * A message_update as its delta: Pi's event without the message it updates, which it carries on every
 * token (as `message`, as the delta's `partial`, and as done's `message` or error's `error`, which
 * message_end carries next). A client folds the message from its message_start and the deltas since;
 * a toolcall_start names its call (`id`, `name`), which only the message did.
 */
function deltaOf(event: any) {
  const { partial, message: _done, error: _error, ...delta } = event.assistantMessageEvent ?? {};
  // A tool call's id and name are only in the message at its start: they come along, as fields of their own.
  if (delta.type === "toolcall_start") {
    const call = partial?.content?.[delta.contentIndex];
    if (call?.type === "toolCall") Object.assign(delta, { id: call.id, name: call.name });
  }
  return { type: "message_update", assistantMessageEvent: delta };
}
/** Tool progress published per call at most this often. */
const PROGRESS_MS = 250;
/**
 * `publish` at most once per PROGRESS_MS, trailing: an update within the window replaces the one
 * waiting, which is published when the window ends. `onFlush` gets a function publishing the
 * waiting one now (before the call's result), after which nothing more is published.
 */
function throttled<T>(publish: (value: T) => void, onFlush: (flush: () => void) => void) {
  let last = 0, waiting: { value: T } | undefined, timer: ReturnType<typeof setTimeout> | undefined, done = false;
  const release = () => { timer = undefined; if (waiting) { const { value } = waiting; waiting = undefined; last = Date.now(); publish(value); } };
  onFlush(() => { clearTimeout(timer); release(); done = true; });
  return (value: T) => {
    if (done) return;
    const wait = last + PROGRESS_MS - Date.now();
    if (wait <= 0 && !timer) { last = Date.now(); publish(value); return; }
    waiting = { value };
    timer ??= setTimeout(release, Math.max(0, wait));
  };
}
/**
 * Who reads a stream other than its tenant or its agent's own application: a browser token's holder,
 * who sees each frame as `show` makes it (undefined: not at all), until `until` (ms), when it ends.
 */
export type StreamReader = { show(data: ClientEvent | TurnSnapshot): unknown; until: number };
const readers = new WeakMap<ServerResponse, StreamReader>();
/** Streams that asked for the agent's children's events (`?subagents=1`); the others never get them. */
const subagentReaders = new WeakSet<ServerResponse>();
const isSubagent = (data: ClientEvent | TurnSnapshot) => data.type === "event" && SUBAGENT_EVENTS.includes(data.event?.type);
/** Whether a request's client has gone: its connection closed before the response was written. */
const gone = (c: Context<ClientEnv>) => c.env.incoming.destroyed || c.env.outgoing.destroyed || !!c.env.outgoing.socket?.destroyed;
/** Write an SSE frame, cutting off a subscriber that does not keep up. */
function send(res: ServerResponse, frame: string) {
  if (res.destroyed) return;
  if (res.writableLength + Buffer.byteLength(frame) > 2 * FRAME_BYTES) res.destroy();
  else res.write(frame);
}

/**
 * A request's body straight from Node's request stream: reaching it through the Fetch
 * Request builds an undici Request and a web stream first, a noticeable part of a
 * small request's cost. The operator bridge hands its body on as a Request.
 */
const body = (c: Context<ClientEnv>) => c.env.operatorTenant === undefined && c.env.incoming ? c.env.incoming : c.req.raw.body;
const json = (c: Context, status: number, value: unknown) => c.json(value, status as ContentfulStatusCode, { "Cache-Control": "no-store" });
/** Never-expiring agents have `expiresAt: null`; a bare `<=` would treat null as 0, long expired. */
const expired = (expiresAt: number | null, now = Date.now()) => expiresAt !== null && expiresAt <= now;
const settled = (state: string) => state !== "running";
/** The key scope an agent has once `update` applies: the one it names (null for none), else its own. */
const scopeAfter = (header: SessionHeader, update: { keyScope?: unknown }) => Object.hasOwn(update, "keyScope") ? update.keyScope as string | null : header.keyScope;

/**
 * A request as callers see it: queued parameters stay internal, and an ended one's error, early stop and `status` are on
 * top. `state` says only whether it ended; `status` how, as the SDKs' runs say it: completed, input_required or failed.
 */
const visible = ({ params: _params, announce: _announce, handedOff: _handedOff, carried: _carried, ...record }: RequestRecord): RequestRecord => {
  if (record.state !== "completed") return record;
  const ending = outcomeEnding(record.outcome);
  const status = ending.error !== undefined || ending.stopped === "spend_limit" || ending.stopped === "turn_limit" ? "failed" : ending.stopped === "input_required" ? "input_required" : "completed";
  return { ...record, ...ending, status };
};

export interface ClientSessionOptions {
  secret: string; toolTimeoutMs?: number; ttlMs?: number; eventBytes?: number;
  /** Said after a run's `model_key_missing` error: where else this runtime takes keys (a self-host's environment). */
  modelKeyHint?: string;
  /** The most a snapshot takes, one frame (default FRAME_BYTES); tests make it small. */
  snapshotBytes?: number;
  /** Read-only subscribers (watchers and waiting polls) one agent's event stream may have at once (default 32), a tenant's agents on this node (1024), and this node (4096). */
  maxWatchers?: number; maxTenantWatchers?: number; maxNodeWatchers?: number;
  /** How often nodes sweep for agents with work left (`resumeOrphans`): the unit of a failed load's backoff. */
  orphanSweepMs?: number;
  /** A tenant's own bound on its read-only subscribers on this node, instead of `maxTenantWatchers`; read at each subscribe. */
  watcherLimitFor?: (tenant: string) => number | undefined;
  /** Headers and the tenant index. */
  db: Db;
  /** Single-host shorthand for `storage: fileStorage(root)`, where journals are kept. */
  root?: string;
  storage?: Storage;
  /** Key prefix for journals within `storage`. */
  prefix?: string;
  /** With ownership, each agent is served by one node at a time. */
  ownership?: Ownership;
  /**
   * The provider key an agent uses, resolved per tenant at process start; never persisted. `platform` keys are not the tenant's own.
   * With a key scope, or on the tenant's own provider, it is `SCOPE_KEY`, and each call resolves through `scopedKey`.
   */
  apiKeyFor?: (tenant: string, provider: string, keyScope?: string) => Promise<ProviderKey | string | undefined> | ProviderKey | string | undefined;
  /**
   * One model call's credentials for an agent with a key scope, or on the tenant's own provider: the scope's entry, else
   * the provider's own, else the tenant's key, else (prepaid) the platform's.
   */
  /** Whether `tenant` pays for responses on the platform's keys, priced from the catalog; an unbilled tenant's are as reported. */
  catalogPriced?: (tenant: string) => Promise<boolean>;
  scopedKey?: (tenant: string, keyScope: string | undefined, provider: string) => Promise<(Credentials & { platform: boolean }) | undefined>;
  /** The tenant's own model endpoints (tenants file), which its agents' models may name. */
  modelEndpoints?: (tenant: string) => ModelEndpoints;
  /** The tenant's own OpenAI-compatible providers (model-providers.ts), which its agents' models may name. */
  /** The custom providers an agent of `tenant` in `keyScope` resolves models from (the scope's, then the tenant's). */
  customProviders?: (tenant: string, keyScope?: string | null) => Promise<CustomProviders>;
  /** An identity token for `audience` (the runtime's signer), for model calls to a tenant's own endpoint. */
  modelToken?: (audience: string, claims: TokenClaims) => Promise<string>;
  /** At most this many hosted agents per tenant at once on this node, for a tenant `agentLimitFor` gives none (default: no per-tenant limit). */
  maxAgentsPerTenant?: number;
  /** A tenant's own limit, overriding `maxAgentsPerTenant`; read at each start, so changes apply to the next one. */
  agentLimitFor?: (tenant: string) => Promise<number | undefined> | number | undefined;
  /** Busy agents per tenant across the fleet: a run takes a slot, and a tenant at its limit gets 429 BUSY_AGENT_LIMIT. */
  busyAgents?: BusyAgents;
  /** Stop an agent's process, and unload its session, after this long without activity. */
  idleMs?: number;
  retry?: AgentConfig["retry"];
  /** Durable wake-ups for agents (`/clients/:id/schedules`). */
  scheduler?: Scheduler;
  /**
   * Why a tenant may not spend more on models (a reached monthly cap). Checked when a model run is
   * accepted (402), when it starts, and after each model response in a turn that would continue.
   */
  spendLimit?: (tenant: string) => Promise<Refusal | undefined>;
  /**
   * The most one run of a tenant's agents may take, whatever its agent asks (`runLimits`): model responses (compaction
   * summaries count) and seconds from when it began; Infinity for no limit. Default 1,000 responses and 2 hours (`RUN_LIMITS`).
   */
  runLimitsFor?: (tenant: string) => Promise<Required<RunLimits>>;
  /** A tenant's js_exec limits: CPU per execution, the longest timeoutMs, and executions at once on this node. Default `CODE_LIMITS`. */
  codeLimitsFor?: (tenant: string) => Promise<CodeLimits>;
  /** js_exec executions this node runs at once for tenants with a concurrency limit, together; default `codeCapacity`. */
  codeCapacity?: number;
  /** Why a tenant may not start any run, code executions included (spent prepaid credit). Checked when a run is accepted and when it starts. */
  creditLimit?: (tenant: string) => Promise<Refusal | undefined>;
  /** Count a run the tenant starts against its rate limit; throws (429) past it. Checked when a run is accepted, not for retries. */
  runRate?: (tenant: string) => Promise<void>;
  /** Called with each finished assistant message that reports token usage, and each compaction summary's. */
  onUsage?: (tenant: string, agentId: string, message: UsageRecord) => void;
  /** Whether the tenant has a webhook endpoint for run events; without it, runs write none. */
  runEvents?: (tenant: string) => Promise<boolean>;
  /** Called with time an agent spent in runs (model calls and tool execution), at least every minute while one runs. */
  onActive?: (tenant: string, agentId: string, ms: number) => void;
  hooks?: SessionHooks;
  /** Volumes: new agents get mounts (a workspace by default) and file tools over them. */
  volumes?: VolumeService;
  /** Signs links to the agent's files (`POST /clients/:id/links`, `present_file`). */
  links?: FileLinks;
  /** A definition's current configuration, to apply to an agent made from it (`configure` with `definition`). */
  definitionFor?: (tenant: string, id: string) => Promise<DefinitionConfig>;
  /** Tools the runtime calls itself (MCP servers), from the agent's definition. */
  sources?: ToolSources;
  /** Stages that order `tools.search` results by meaning, fused with keyword ranking (AGENT_TOOL_SEARCH). */
  rerankers?: Reranker[];
  /** Human input (questions, approvals, setup steps) that suspended turns wait on; without it, tools cannot ask. */
  inputs?: Inputs;
  /** Trace export: runs of a tenant that has it set record their spans here. */
  tracing?: Tracing;
  /** Submit a request to an agent on whichever node serves it (resuming a suspension that expired). */
  submit?: (agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }) => Promise<RequestRecord>;
  /**
   * Make an agent for the delegate builtin, as POST /v1/agents does with `params` and `key`, linked to the run that made it
   * (`parent`). Without it, agents cannot delegate.
   */
  createAgent?: (tenant: string, params: Record<string, unknown>, key: string, parent: NonNullable<SessionHeader["parent"]>) => Promise<{ id: string }>;
  /** One of an agent's requests on whichever node serves it, once it settles or `waitMs` passes (see `awaitRequest`). */
  requestAnywhere?: (agent: string, tenant: string, requestId: string, waitMs: number, signal?: AbortSignal) => Promise<RequestRecord | undefined>;
}
/** A definition resolved for an agent: its revision, agent configuration, client tools and tool sources. */
export type DefinitionConfig = { id: string; revision: number; config: Pick<AgentConfig, "model" | "systemPrompt" | "thinkingLevel" | "fileTools" | "runLimits">; sources?: Sources; description?: string };
/** One model response's usage; `kind` separates compaction summaries from the agent's turns. */
/**
 * A model response's usage, a web tool's call (`searches`: web searches, `renders`: pages web_fetch had
 * rendered), or tool search's ranking by meaning (`toolSearch`: `toolSearches` searches, none for
 * embedding a catalog ahead of them), with its cost in `usage.cost.total`.
 */
export type UsageRecord = {
  provider?: string; model?: string; usage: any; timestamp?: number; kind?: "turn" | "compaction"; platform?: boolean; searches?: number; renders?: number; toolSearch?: boolean; toolSearches?: number;
  /** For a model response: the run it was in, who acted in it, whom the agent acts for, and its key scope (for usage webhooks). */
  requestId?: string; actor?: string; identity?: AgentIdentity; keyScope?: string;
};
/** Why runs are refused: a message (402), or an error with its own status. */
export type Refusal = string | HttpError;
/** An agent's spend limit (USD), what it has spent since, and when it was set. */
type SpendLimit = { usd: number; spent: number; setAt: number };
/** `spendLimit` as given: `{usd}`, or null to remove it. */
export function spendInput(value: unknown): number | null {
  if (value === null) return null;
  const usd = (value as { usd?: unknown } | undefined)?.usd;
  if (!value || typeof value !== "object" || Object.keys(value).some(key => key !== "usd") || typeof usd !== "number" || !Number.isFinite(usd) || usd < 0 || usd > 1_000_000) {
    throw new HttpError(400, "spendLimit must be {usd} with usd a number from 0 to 1000000, or null");
  }
  return usd;
}
const dollars = (usd: number) => `$${Number(usd.toFixed(6))}`;
/** The runtime's default maximums for one run, which an agent's own `runLimits` may lower (ClientSessionsOptions.runLimitsFor). */
export const RUN_LIMITS: Readonly<Required<RunLimits>> = Object.freeze({ maxResponses: 1_000, maxSeconds: 2 * 3_600 });
const duration = (seconds: number) => {
  const [count, unit] = seconds % 3_600 === 0 ? [seconds / 3_600, "hour"] : seconds % 60 === 0 ? [seconds / 60, "minute"] : [seconds, "second"];
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
};
/** A model response's cost as the runtime counts it. */
const responseCost = (usage: any) => usageCost(usage).usd;
/** A provider key and whether it is the platform's rather than the tenant's own. */
export type ProviderKey = { key: string; platform: boolean };
/** An agent, and this node's claim on it: hooks write what the agent owns under it. */
export type AgentRef = { id: string; tenant: string; claim?: Claim };
/** Runtime features layered on agents (channels): they observe runs and may answer tools themselves. */
export interface SessionHooks {
  runStarted?(agent: AgentRef, record: RequestRecord): void;
  /** After the run's outcome is durable, on the node that ran it. */
  runEnded?(agent: AgentRef, record: RequestRecord): void;
  /** Tools the feature answers for the agent (a channel's send_message); they take precedence over all others. */
  server?(agent: AgentRef): Promise<ToolServer | undefined>;
  /** Where a run's turn came from, passed to every tool it calls (as `_meta` to MCP servers). */
  origin?(agent: AgentRef, requestId?: string): Promise<Record<string, unknown> | undefined>;
}

/**
 * SSE carries streamed events; POST mutations use persistent request/call IDs.
 * Sessions load lazily and unload when idle, so only active agents use memory.
 */
export class ClientSessions {
  readonly sessions = new Map<string, Session>();
  private readonly loading = new Map<string, Promise<Session | undefined>>();
  readonly supervisor: AgentSupervisor;
  readonly options: ClientSessionOptions;
  readonly storage: Storage;
  readonly db: Db;
  readonly heartbeat: ReturnType<typeof setInterval>;
  /** Agents' history in pages. */
  readonly historyIndex: HistoryIndex;
  /** Turns to run js_exec on this node, shared fairly among tenants. */
  readonly codeGate: CodeGate;
  private closed = false;
  /** Set while the node drains or retires: runs that have not begun stay queued for the next owner. */
  draining = false;
  private releasing = false;
  /** Set while this node leaves the cluster with a peer to take its work (`handOffTurns`): running turns stop at their next step boundary. */
  private handingOff?: { reason: "retire" | "drain"; since: number };
  /** Agents being given up as this node leaves (`park`, `handOffAll`): in flight until they are released. */
  private readonly leavingWork = new Set<Promise<void>>();

  constructor(supervisor: AgentSupervisor, options: ClientSessionOptions) {
    if (!options.storage && !options.root) throw new Error("ClientSessions needs storage or root");
    this.supervisor = supervisor;
    this.options = options;
    this.db = options.db;
    this.storage = options.storage ?? fileStorage(options.root!);
    this.historyIndex = new HistoryIndex(this.db, this.storage);
    this.codeGate = new CodeGate(options.codeCapacity ?? codeCapacity());
    this.heartbeat = setInterval(() => this.tick(), Math.min(5000, Math.max(50, Math.floor((options.idleMs ?? 5 * 60_000) / 2))));
    this.heartbeat.unref();
    options.ownership?.onFence(() => { for (const session of [...this.sessions.values()]) void this.lost(session); });
  }

  private journalKey(id: string) { return `${this.options.prefix ?? ""}${id}.journal`; }

  private async readHeader(id: string): Promise<{ value: SessionHeader; revision: number } | undefined> {
    if (!validSessionId(id)) return undefined;
    const row = (await this.db.query("select header, revision from agents where id = $1", [id])).rows[0];
    return row && { value: row.header, revision: row.revision };
  }

  /**
   * Write the header with the columns listings use: a create, or an update
   * conditional on the revision this node holds and on its ownership claim.
   */
  private async writeHeader(session: Session) {
    if (session.fault) throw session.fault;
    const header = session.header;
    const columns = [header.id, header.tenant, JSON.stringify(header), header.metadata?.name ?? header.id, header.metadata?.type ?? "general",
      `${header.config.model.provider}/${header.config.model.id}`, header.expiresAt, header.revoked];
    try {
      const { rows } = session.revision === undefined
        ? await this.db.query(`
            insert into agents (id, tenant, header, name, type, model, expires_at, revoked, revision) values ($1, $2, $3, $4, $5, $6, $7, $8, 1)
            on conflict (id) do nothing returning revision`, columns)
        // The ownership row is locked (FOR SHARE) as in a journal append, so a takeover waits for this write instead of racing it.
        : await this.db.query(`
            with owner as (select from actor_owners where actor = $1 and session = $10 and epoch = $11 for share)
            update agents set tenant = $2, header = $3, name = $4, type = $5, model = $6, expires_at = $7, revoked = $8, revision = revision + 1
            where id = $1 and (revision = $9 or ($12 and revision = $9 + 1)) and ($10::uuid is null or exists (select from owner))
            returning revision`, [...columns, session.revision, session.claim?.session ?? null, session.claim?.epoch ?? null, !!session.unsettled]);
      if (!rows[0]) throw new Error("Another node changed this agent; it moved");
      session.revision = rows[0].revision;
      session.unsettled = false;
    } catch (error) {
      // The database was unreachable, so the write may or may not have landed: answer 503, and let the next
      // update go over either revision. While this node's claim holds, only it writes here.
      if (databaseUnavailable(error)) {
        if (session.revision !== undefined) session.unsettled = true;
        throw error;
      }
      this.fail(session, error);
      throw session.fault;
    }
  }

  /** The live owner of an agent when it is another node (or, while draining, a peer to take it); undefined when this node serves it. */
  async ownerElsewhere(id: string): Promise<string | undefined> {
    const ownership = this.options.ownership;
    if (!ownership || this.sessions.has(id)) return undefined;
    const owner = await ownership.route(id);
    return owner !== ownership.node ? owner : undefined;
  }

  private load(id: string): Promise<Session | undefined> {
    const loaded = this.sessions.get(id);
    if (loaded) return Promise.resolve(loaded);
    let loading = this.loading.get(id);
    if (!loading) {
      loading = this.read(id).finally(() => this.loading.delete(id));
      this.loading.set(id, loading);
    }
    return loading;
  }

  private async read(id: string): Promise<Session | undefined> {
    const stored = await this.readHeader(id);
    if (!stored || stored.value.purged) return undefined;
    // Take ownership before reading the journal, so no other node appends meanwhile.
    const ownership = this.options.ownership;
    let claim: Claim | undefined;
    if (ownership) {
      const acquired = await ownership.acquire(id);
      if ("owner" in acquired) throw new NotOwner(acquired.owner);
      claim = acquired.claim;
    }
    try { return await this.loadOwned(id, claim); }
    catch (error) { if (claim) await ownership!.release(claim).catch(() => {}); throw error; }
  }

  private async loadOwned(id: string, claim?: Claim): Promise<Session | undefined> {
    // Re-read after acquiring: the previous owner may have written since.
    const stored = await this.readHeader(id);
    if (!stored || stored.value.purged) return undefined;
    const header = stored.value;
    const log = this.storage.log<JournalRecord>(this.journalKey(id), claim);
    const session: Session = {
      header, revision: stored.revision, claim, requests: new Map(), running: new Map(), log,
      cursor: await this.startCursor(id, claim), events: [], eventBytes: 0, watchers: new Set(), polls: new Set(), inflight: 0, runs: Promise.resolve(), resuming: new Set(), settling: 0, lastActive: Date.now(),
    };
    for (const record of await log.read()) this.apply(session, record);
    if (header.version !== 3 || header.id !== id) throw new Error("Invalid client session header");
    // Loading means no process anywhere owns the session, so nothing it recorded is still running.
    // Queued runs that never began are safe to run now. A turn that began resumes from its
    // transcript, a bounded number of times; anything else that began has an unknown outcome.
    const queued: RequestRecord[] = [];
    const resumed: RequestRecord[] = [];
    for (const request of [...session.running.values()]) {
      if (request.params !== undefined) queued.push(request);
      // Counted when the resumed run begins (see `run`), so a load that fails, or hands the agent back, spends none.
      // A turn handed off at a step boundary lost nothing and is not a resume: it always goes on.
      else if (resumable(request) && (request.handedOff || (request.resumes ?? 0) < MAX_RESUMES)) resumed.push(request);
      else this.upsertRequest(session, { ...request, state: "completed", endedAt: Date.now(), outcome: { error: "The runtime restarted during this request", uncertain: true }, ...(RUN_METHODS.includes(request.method) ? { announce: true as const } : {}) });
    }
    await log.flush(true);
    if (claim && !this.options.ownership!.holds(claim)) throw new HttpError(503, "This node lost ownership of the agent; retry");
    this.sessions.set(id, session);
    this.loaded(session);
    session.inherited = new Set([...resumed, ...queued].map(record => record.id));
    for (const record of resumed) { session.resuming.add(record.id); this.enqueue(session, record, undefined); }
    for (const record of queued.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) this.enqueue(session, record, record.params);
    // Runs that ended without their event written (the node stopped first, or the write failed): written now.
    const unannounced = [...session.requests.values()].filter(record => record.announce);
    if (unannounced.length) void this.announce(session, unannounced);
    return session;
  }

  private apply(session: Session, entry: JournalRecord) {
    if (entry.t === "request") this.track(session, entry.record);
    else if (entry.t === "announced") {
      for (const id of entry.ids) {
        const record = session.requests.get(id);
        if (record?.announce) { const { announce: _, ...rest } = record; session.requests.set(id, rest); }
      }
    }
  }

  /**
   * A run's webhook event, with an id each rewrite keeps: `run.started`, or as it ended, `run.completed` (with how it
   * stopped, if early, and its answer's index in history) or `run.failed` (the runtime's error, or the model's). Ids and
   * key facts only: a receiver reads the rest from the request, history or inputs.
   */
  private runEvent(session: Session, record: RequestRecord, usage?: RunUsage): WebhookEvent {
    const { id: agentId, tenant } = session.header;
    const base = { agentId, requestId: record.id, method: record.method, ...(record.actor ? { actor: record.actor } : {}), ...(record.metadata ? { metadata: record.metadata } : {}) };
    if (record.state === "running") return webhookEvent("run.started", tenant, { ...base, ...(record.resumes ? { resumes: record.resumes } : {}) }, `run.started:${agentId}:${record.id}`);
    const outcome = record.outcome ?? { error: "No outcome was recorded" };
    const result = (outcome.result ?? {}) as { stopped?: string; inputs?: { id: string }[]; replyIndex?: number; messages?: number };
    const { error } = outcomeEnding(outcome);
    const ended = { ...base, ...(record.steeredInto ? { steeredInto: record.steeredInto } : {}), usage: usage ?? null };
    const key = `run.ended:${agentId}:${record.id}`;
    if (error !== undefined) return webhookEvent("run.failed", tenant, { ...ended, error, ...(outcome.uncertain ? { uncertain: true } : {}) }, key);
    return webhookEvent("run.completed", tenant, {
      ...ended, ...(result.stopped ? { stopped: result.stopped } : {}), ...(result.inputs?.length ? { inputIds: result.inputs.map(input => input.id) } : {}),
      ...(typeof result.replyIndex === "number" ? { replyIndex: result.replyIndex } : {}), ...(typeof result.messages === "number" ? { messageCount: result.messages } : {}),
    }, key);
  }

  /** Write ended runs' webhook events, then journal that they are written; a failure leaves them for the agent's next run or load. */
  private async announce(session: Session, records: RequestRecord[], usage?: Map<string, RunUsage>) {
    try {
      await session.started;
      await enqueueEvents(this.db, records.map(record => this.runEvent(session, record, usage?.get(record.id))));
    } catch (error) {
      console.error(JSON.stringify({ type: "run_event_failed", agent: session.header.id, error: safeError(error) }));
      return;
    }
    if (this.sessions.get(session.header.id) !== session || session.fault) return;
    const entry: JournalRecord = { t: "announced", ids: records.map(record => record.id) };
    this.apply(session, entry);
    session.log.append(entry);
    this.commitLater(session);
  }

  private snapshot(session: Session): JournalRecord[] {
    return [
      ...[...session.requests.values()].map(record => ({ t: "request" as const, record })),
    ];
  }

  private track(session: Session, record: RequestRecord) {
    session.requests.set(record.id, record);
    if (record.state === "running") session.running.set(record.id, record);
    else if (session.running.delete(record.id) && session.busy) this.releaseBusy(session);
  }

  /**
   * Take a busy slot for the agent unless it holds one: 429 BUSY_AGENT_LIMIT when its tenant is at its
   * limit, unless `force` (work accepted before: a run taken over, a resumed turn) takes it regardless.
   */
  private holdBusy(session: Session, force = false) {
    const busy = this.options.busyAgents;
    if (!busy) return Promise.resolve();
    return this.busyStep(session, async () => {
      if (session.busy) return;
      const refused = await busy.hold(session.header.tenant, session.header.id, force);
      if (refused) throw refused;
      session.busy = true;
    });
  }

  /** Give the agent's busy slot up once it has no run open or being accepted (`unloading`: it is leaving this node). */
  private releaseBusy(session: Session, unloading = false) {
    const busy = this.options.busyAgents;
    if (!busy) return Promise.resolve();
    return this.busyStep(session, async () => {
      if (!session.busy || (!unloading && (session.admitting || [...session.running.values()].some(record => RUN_METHODS.includes(record.method))))) return;
      session.busy = false;
      // Kept on failure, so a later release (at the latest, the unload) tries again.
      try { await busy.release(session.header.id); }
      catch (error) { session.busy = true; throw error; }
    }).catch(error => console.error(JSON.stringify({ type: "busy_release_failed", agent: session.header.id, error: safeError(error) })));
  }

  /** Steps that take or give up the agent's busy slot, one at a time in order. */
  private busyStep(session: Session, step: () => Promise<void>) {
    const next = (session.busyStep ?? Promise.resolve()).catch(() => {}).then(step);
    session.busyStep = next;
    return next;
  }
  private upsertRequest(session: Session, record: RequestRecord) {
    this.track(session, record);
    session.log.append({ t: "request", record });
    return record;
  }

  /** Write appended journal records. Durable flushes gate acknowledgements and side effects. */
  private async commit(session: Session, durable: boolean) {
    if (session.fault) throw session.fault;
    try { await session.log.flush(durable); }
    catch (error) { this.fail(session, error); throw session.fault; }
  }
  private commitLater(session: Session) { void this.commit(session, false).catch(() => {}); }

  private fail(session: Session, error: unknown) {
    if (session.fault) return;
    // A failed disk commit must never turn into a successful retry from memory.
    session.fault = new Error(`Session persistence failed: ${errorText(error)}`);
    this.endStreams(session, true);
    this.closeAttached(session);
  }

  /**
   * Drop old settled records once the journal is long, keeping recent ones for idempotent retries.
   * The appended count starts over with each load, so an agent that wakes often but briefly is
   * folded by how many records it holds.
   */
  private async fold(session: Session) {
    if (session.log.appendedSinceRewrite < FOLD_AFTER_RECORDS && session.requests.size < 4 * RETAINED_SETTLED) return;
    const prune = <T extends { id: string; state: string }>(records: Map<string, T>, at: (record: T) => number) => {
      const old = [...records.values()].filter(record => settled(record.state)).sort((a, b) => at(a) - at(b));
      for (const record of old.slice(0, Math.max(0, old.length - RETAINED_SETTLED))) records.delete(record.id);
    };
    prune(session.requests, record => record.endedAt ?? record.startedAt ?? 0);
    try { await session.log.rewrite(() => this.snapshot(session)); }
    catch (error) { this.fail(session, error); }
  }

  private publish(session: Session, data: ClientEvent) {
    if (this.closed || session.fault) return;
    if (data.type === "event" && (session.spans || this.options.tracing)) this.traceEvent(session, data.requestId, data.event);
    const nested = isSubagent(data);
    // A message_update is its delta alone; the runtime keeps the latest message it updates, for snapshots.
    if (data.type === "event") {
      const inner = data.event;
      if (inner?.type === "message_update") { session.partial = inner.message; data = { ...data, event: deltaOf(inner) }; }
      else if (inner?.type === "message_start" && inner.message?.role === "assistant") session.partial = inner.message;
      else if (inner?.type === "message_end") session.partial = undefined;
    }
    const sent = data;
    let text = JSON.stringify(data);
    const oversized = Buffer.byteLength(text) > FRAME_BYTES;
    // A child's event too large to relay is left out: its own stream and history have it.
    if (oversized && nested) return;
    if (oversized) {
      // Control outcomes remain in the journal; oversized display events are explicit gaps, which say what they were.
      const was = data.type === "event" ? data.event?.type : data.type;
      data = { type: "event", requestId: data.type === "event" ? data.requestId : "", event: { type: "event_omitted", reason: "Event exceeded transport limit", ...(was ? { was } : {}) } };
      text = JSON.stringify(data);
    }
    const event: BufferedEvent = { id: ++session.cursor, bytes: Buffer.byteLength(text), data };
    session.events.push(event);
    session.eventBytes += event.bytes;
    session.lastActive = Date.now();
    const limit = this.options.eventBytes ?? 2 * 1024 * 1024;
    while (session.events.length > 1 && (session.events.length > MAX_BUFFERED_EVENTS || session.eventBytes > limit)) session.eventBytes -= session.events.shift()!.bytes;
    this.follow(session, sent, text, oversized);
    const frame = `id: ${event.id}\ndata: ${text}\n\n`;
    for (const res of this.streams(session)) {
      if (nested && !subagentReaders.has(res)) continue;
      const reader = readers.get(res);
      if (!reader) { send(res, frame); continue; }
      const shown = reader.show(data);
      if (shown !== undefined) send(res, shown === data ? frame : `id: ${event.id}\ndata: ${JSON.stringify(shown)}\n\n`);
    }
    for (const wake of [...session.polls]) wake();
    for (const tap of session.taps ?? []) tap(sent);
  }

  /** Keep the running turn as its events fold, for snapshots: the messages its run finished, from the run's start to its response. */
  private follow(session: Session, data: ClientEvent, text: string, oversized: boolean) {
    const turn = session.turn;
    if (!turn) return;
    if (data.type === "response" && data.id === turn.requestId) { session.turn = undefined; session.partial = undefined; return; }
    if (data.type !== "event" || data.requestId !== turn.requestId) return;
    const type = data.event?.type;
    if (type === "turn_opened") turn.start ??= data.event.index;
    // A response taken back (a retry, or a compaction on overflow) gives up its place, as it does for a subscriber folding the stream.
    if (type === "message_retracted" && turn.count) {
      turn.count--;
      if (!turn.truncated) turn.messages.pop();
    }
    if (type !== "message_end") return;
    // How many messages the run finished, whether or not the snapshot can carry them.
    turn.count++;
    turn.bytes += oversized ? FRAME_BYTES : text.length;
    // A snapshot is one frame: a turn too large for one is read from history instead.
    if (turn.truncated || turn.bytes > TURN_SNAPSHOT_BYTES) { turn.truncated = true; turn.messages = []; }
    else turn.messages.push(data.event.message);
  }

  /** The running turn as of the latest event, for a subscriber that asked for one and has nothing to replay from. */
  private turnSnapshot(session: Session): TurnSnapshot {
    const turn = session.turn;
    const snapshot: TurnSnapshot = { type: "snapshot", cursor: session.cursor, requestId: turn?.requestId ?? null, turn: turn ? {
      start: turn.start ?? null, count: turn.count, messages: turn.messages, partial: session.partial ?? null, ...(turn.truncated ? { truncated: true as const } : {}),
    } : null };
    // Too large for one frame: the finished messages go first (they are in history), then the streaming message.
    const frame = this.options.snapshotBytes ?? FRAME_BYTES;
    if (snapshot.turn && Buffer.byteLength(JSON.stringify(snapshot)) > frame) snapshot.turn = { ...snapshot.turn, messages: [], truncated: true };
    if (snapshot.turn && Buffer.byteLength(JSON.stringify(snapshot)) > frame) snapshot.turn = { ...snapshot.turn, partial: null };
    return snapshot;
  }

  /**
   * Take a read-only subscriber's place (a watcher's, or a waiting poll's), within the agent's, its tenant's and
   * this node's bounds (429 past them); the function returned gives it back, once.
   */
  private hold(tenant: string, subscribers: number) {
    const reject = (scope: "agent" | "tenant" | "node") => {
      recordWatchRefused(scope, tenant);
      return new HttpError(429, `This ${scope} has too many event stream subscribers; retry later`);
    };
    if (subscribers >= (this.options.maxWatchers ?? MAX_WATCHERS)) throw reject("agent");
    if ((this.tenantWatching.get(tenant) ?? 0) >= (this.options.watcherLimitFor?.(tenant) ?? this.options.maxTenantWatchers ?? MAX_TENANT_WATCHERS)) throw reject("tenant");
    if (this.watching >= (this.options.maxNodeWatchers ?? MAX_NODE_WATCHERS)) throw reject("node");
    this.watching++;
    this.tenantWatching.set(tenant, (this.tenantWatching.get(tenant) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.watching--;
      const left = this.tenantWatching.get(tenant)! - 1;
      if (left) this.tenantWatching.set(tenant, left); else this.tenantWatching.delete(tenant);
    };
  }
  private watching = 0;
  /** Event stream subscribers held on this node (a metric: node_load). */
  get watchers() { return this.watching; }
  private readonly tenantWatching = new Map<string, number>();
  /** Each watcher's agent, and its place (given back when it closes) and token expiry. */
  private readonly watches = new WeakMap<ServerResponse, { agent: string; release: () => void; expiry?: ReturnType<typeof setTimeout> }>();
  /**
   * Watchers and waiting polls of agents no node has loaded: they hold a socket and a place, and no
   * session, claim or journal read. The agent's next load takes them up (here) or ends them (elsewhere,
   * told by `loadedElsewhere`, or found by `tick`'s check of who owns it), so they reconnect to its owner.
   */
  private readonly idle = new Map<string, { tenant: string; watchers: Set<ServerResponse>; polls: Set<() => void>; checked: number }>();

  /** A watcher closed: out of its agent's session or idle entry, and its place given back. */
  private unwatch(res: ServerResponse) {
    const watch = this.watches.get(res);
    if (!watch) return;
    this.watches.delete(res);
    this.sessions.get(watch.agent)?.watchers.delete(res);
    const entry = this.idle.get(watch.agent);
    entry?.watchers.delete(res);
    if (entry && !entry.watchers.size && !entry.polls.size) this.idle.delete(watch.agent);
    clearTimeout(watch.expiry);
    watch.release();
  }

  /**
   * The cursor a loaded session starts from: where its last owner stopped cleanly (nothing was
   * published since, so a subscriber holding it resumes without a gap), else above any id an earlier
   * process can have used. Marked unclean before any event, so a crash of this one never reuses an id.
   */
  private async startCursor(id: string, claim: Claim | undefined) {
    const row = (await this.db.query("select last_cursor, cursor_clean from agents where id = $1", [id])).rows[0];
    const stored = row?.last_cursor === null || row?.last_cursor === undefined ? undefined : Number(row.last_cursor);
    const cursor = row?.cursor_clean && stored !== undefined ? stored : Math.max(Date.now() * 1000, (stored ?? 0) + 1);
    await underClaim(this.db, claim, sql => sql.query("update agents set cursor_clean = false where id = $1", [id]));
    return cursor;
  }

  /**
   * The cursor of an agent no node has loaded, for its idle watchers: where its last owner stopped
   * cleanly; for one that stopped otherwise, a cursor above any it used, recorded as clean while no
   * node owns it (a load after takes it up). Undefined when a node owns it now: ask that node.
   */
  private async idleCursor(id: string): Promise<number | undefined> {
    const row = (await this.db.query("select last_cursor, cursor_clean from agents where id = $1", [id])).rows[0];
    if (row?.cursor_clean && row.last_cursor !== null) return Number(row.last_cursor);
    const { rows } = await this.db.query(`
      update agents set last_cursor = greatest($2::bigint, coalesce(last_cursor, 0) + 1), cursor_clean = true
      where id = $1 and not cursor_clean and not exists (
        select from actor_owners o join runtime_nodes n on n.node = o.node and n.session = o.session and n.expires_at > now() where o.actor = $1)
      returning last_cursor`, [id, Date.now() * 1000]);
    if (rows[0]) return Number(rows[0].last_cursor);
    const again = (await this.db.query("select last_cursor, cursor_clean from agents where id = $1", [id])).rows[0];
    return again?.cursor_clean && again.last_cursor !== null ? Number(again.last_cursor) : undefined;
  }

  /** A session loaded here: it takes up its idle watchers and polls, and other nodes end theirs (they reconnect here). */
  private loaded(session: Session) {
    const id = session.header.id;
    const entry = this.idle.get(id);
    if (entry) {
      this.idle.delete(id);
      for (const res of entry.watchers) session.watchers.add(res);
      for (const wake of [...entry.polls]) wake();
    }
    const node = this.options.ownership?.node;
    if (node) void this.db.query("select pg_notify('agent_runtime_loaded', $1)", [`${node} ${id}`]).catch(() => {});
  }

  /** Another node loaded an agent: end the idle watchers and polls this node holds for it, so they reconnect to it. */
  loadedElsewhere(id: string) {
    const entry = this.idle.get(id);
    if (!entry) return;
    this.idle.delete(id);
    for (const res of entry.watchers) res.end();
    for (const wake of [...entry.polls]) wake();
  }

  /**
   * A watcher or poll of an agent: on its session when loaded here (or loading), else registered idle,
   * without loading it. `header` is the agent's, already authorized.
   */
  private async watchAgent(c: Context<ClientEnv>, header: SessionHeader, kind: "watch" | "poll", reader?: StreamReader): Promise<Response> {
    const id = header.id;
    const live = async () => {
      const session = await this.load(id);
      if (!session) throw new HttpError(404, "Unknown agent");
      if (session.fault) throw session.fault;
      return kind === "poll" ? this.poll(c, session, reader) : this.subscribe(c, session, "watch", reader);
    };
    if (this.sessions.has(id) || this.loading.has(id) || this.closed) return live();
    const cursor = await this.idleCursor(id);
    // Loaded meanwhile, here or on another node (whose stream this one does not have): take the loaded path, or retry there.
    if (this.sessions.has(id) || this.loading.has(id)) return live();
    if (cursor === undefined) throw new HttpError(503, "This agent is being loaded; retry");
    if (gone(c)) return RESPONSE_ALREADY_SENT;
    const raw = c.req.header("last-event-id") ?? "0";
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new HttpError(400, "Invalid event cursor");
    const after = Number(raw);
    const asked = c.req.query("snapshot") === "1";
    // Nothing runs, and nothing happened after `cursor`: a subscriber at it (or new) is caught up; any other missed events.
    const gap = after !== 0 && after !== cursor;
    if (gap && !asked) throw new HttpError(409, "REPLAY_GAP: recover from session state");
    const snapshot: TurnSnapshot | undefined = asked && (after === 0 || gap) ? { type: "snapshot", cursor, requestId: null, turn: null } : undefined;
    const shown = (data: TurnSnapshot) => reader ? reader.show(data) : data;
    // Its place first: an entry is made only for a subscriber that has one.
    const existing = this.idle.get(id);
    const release = this.hold(header.tenant, existing ? existing.watchers.size + existing.polls.size : 0);
    const idle = existing ?? { tenant: header.tenant, watchers: new Set<ServerResponse>(), polls: new Set<() => void>(), checked: Date.now() };
    if (!existing) this.idle.set(id, idle);
    if (kind === "poll") {
      const wait = Number(c.req.query("wait") ?? 0);
      if (!snapshot && Number.isFinite(wait) && wait > 0) {
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); idle.polls.delete(done); c.env.outgoing.off("close", done); resolve(); };
          const timer = setTimeout(done, Math.max(0, Math.min(wait * 1000, MAX_POLL_WAIT_MS, reader ? reader.until - Date.now() : Infinity)));
          idle.polls.add(done);
          c.env.outgoing.once("close", done);
        });
      }
      release();
      if (!idle.watchers.size && !idle.polls.size && this.idle.get(id) === idle) this.idle.delete(id);
      return json(c, 200, { cursor, events: snapshot ? [{ id: cursor, data: shown(snapshot) }] : [] });
    }
    const res = c.env.outgoing;
    const expiry = reader ? setTimeout(() => res.end(), Math.max(0, reader.until - Date.now())) : undefined;
    expiry?.unref();
    if (reader) readers.set(res, reader);
    idle.watchers.add(res);
    this.watches.set(res, { agent: id, release, expiry });
    res.on("close", () => this.unwatch(res));
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    res.write(`event: ready\ndata: ${JSON.stringify({ version: 5, agentId: id, watch: true })}\n\n`);
    if (snapshot) send(res, `id: ${cursor}\ndata: ${JSON.stringify(shown(snapshot))}\n\n`);
    return RESPONSE_ALREADY_SENT;
  }

  /** Every open event stream of the agent: the application's connection and its watchers. */
  private streams(session: Session) {
    return session.response ? [session.response, ...session.watchers] : [...session.watchers];
  }

  /** Close every event stream (`destroy`: cut off, not ended cleanly), and answer waiting polls, so subscribers reconnect. */
  private endStreams(session: Session, destroy = false) {
    for (const res of this.streams(session)) if (destroy) res.destroy(); else res.end();
    for (const wake of [...session.polls]) wake();
  }

  /**
   * The application's connection is replaced (a takeover, or a new process while the old one drains): it takes no new
   * calls, and stays open, up to DRAIN_MS, until the calls it has are answered, so a deploy loses none. Then it hears
   * it was replaced, and closes.
   */
  private retire(session: Session) {
    const res = session.response, attached = session.attached;
    session.response = undefined;
    session.attached = undefined;
    const replaced = () => { if (res && !res.destroyed) res.end(`event: closed\ndata: ${JSON.stringify({ reason: "replaced" })}\n\n`); };
    if (!attached || attached.res !== res) { replaced(); void attached?.close(); return; }
    attached.draining = true;
    (session.retiring ??= new Set()).add(attached);
    void attached.settled(DRAIN_MS).then(() => {
      session.retiring?.delete(attached);
      replaced();
      void attached.close();
    });
  }

  /** Close the application's connection and those still draining: their calls in flight end as unknown. */
  private closeAttached(session: Session) {
    for (const attached of [...session.retiring ?? []]) void attached.close();
    session.retiring?.clear();
    void session.attached?.close();
  }

  /**
   * What a subscriber reads after its cursor (its `Last-Event-ID`): the buffered events after it.
   * Cursor 0 is a new subscriber, which takes whatever is buffered; any other must be contiguous
   * with the buffer, or the events between are gone: 409, and the subscriber recovers from state
   * and history. A subscriber that asks for a snapshot (`?snapshot=1`) gets one of the running turn
   * instead, for cursor 0 and a gap, then what follows: updates it did not see from the start are
   * deltas it could not fold.
   */
  private replay(session: Session, raw = "0", snapshot = false): { cursor: number; snapshot?: TurnSnapshot; events: BufferedEvent[] } {
    if (!/^\d+$/.test(raw)) throw new HttpError(400, "Invalid event cursor");
    const cursor = Number(raw);
    if (!Number.isSafeInteger(cursor)) throw new HttpError(400, "Invalid event cursor");
    const first = session.events[0]?.id ?? session.cursor + 1;
    const gap = cursor > session.cursor || cursor < first - 1;
    if (snapshot && (cursor === 0 || gap)) return { cursor: session.cursor, snapshot: this.turnSnapshot(session), events: [] };
    if (cursor !== 0 && gap) throw new HttpError(409, "REPLAY_GAP: recover from session state");
    return { cursor, events: session.events.filter(event => event.id > cursor) };
  }

  /**
   * Open an event stream: the application's (`attach`), which carries its attached MCP server and
   * replaces the connection before it, or a read-only watcher, which never replaces another and is
   * never replaced. Every stream gets every event from its own cursor on (see `replay`).
   */
  private async subscribe(c: Context<ClientEnv>, session: Session, mode: "attach" | "watch", reader?: StreamReader) {
    // One application serves an agent's tools at a time: another is refused, unless it takes over (or names the connection
    // it held, reconnecting). A connection that serves no tools (it never answered MCP's initialize) holds nothing, nor
    // does one that no longer answers a ping (a half-open socket the server has not seen close).
    const held = mode === "attach" && session.attached?.accepting && session.attached.initialized ? session.attached : undefined;
    if (held && c.req.query("takeover") !== "true" && c.req.header("x-agent-connection") !== held.id && await held.answers()) {
      throw new HttpError(409, "APPLICATION_CONNECTED: another connection serves this agent's tools; reconnect with ?takeover=true to replace it");
    }
    // Gone while the request was authorized and its agent loaded: its close has fired already, so nothing
    // registered from here would ever be released. (No await follows, so it cannot close unseen after this.)
    if (gone(c)) return RESPONSE_ALREADY_SENT;
    // A watcher gets a snapshot where it cannot replay, unless it opts out (snapshot=0). The application's connection
    // asks for one (the SDKs do): relays that read its events as they come, and not snapshots, rely on the 409.
    const asked = mode === "watch" ? c.req.query("snapshot") !== "0" : c.req.query("snapshot") === "1";
    const { snapshot, events } = this.replay(session, c.req.header("last-event-id"), asked);
    const release = mode === "watch" ? this.hold(session.header.tenant, session.watchers.size + session.polls.size) : undefined;
    const res = c.env.outgoing;
    if (c.req.query("subagents") === "1") subagentReaders.add(res);
    let ready: Record<string, unknown> = { version: 5, agentId: session.header.id };
    // A reader's stream ends as its token expires: it reconnects with a fresh one, so access changes apply within a token's life.
    const expiry = reader ? setTimeout(() => res.end(), Math.max(0, reader.until - Date.now())) : undefined;
    expiry?.unref();
    if (reader) readers.set(res, reader);
    if (mode === "watch") {
      session.watchers.add(res);
      this.watches.set(res, { agent: session.header.id, release: release!, expiry });
      res.on("close", () => this.unwatch(res));
      ready = { ...ready, watch: true };
    } else {
      this.retire(session);
      session.response = res;
      res.on("close", () => { if (session.response === res) session.response = undefined; });
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    if (mode === "attach") {
      // Each connection is a new MCP session with the application's attached server; `connection` names it.
      const attached = new AttachedServer(res);
      ready = { ...ready, connection: attached.id, ...(session.header.toolsHash ? { toolsHash: session.header.toolsHash } : {}) };
      session.attached = attached;
    }
    res.write(`event: ready\ndata: ${JSON.stringify(ready)}\n\n`);
    if (snapshot) send(res, `id: ${snapshot.cursor}\ndata: ${JSON.stringify(reader ? reader.show(snapshot) : snapshot)}\n\n`);
    for (const event of events) {
      if (res.destroyed) break;
      if (isSubagent(event.data) && !subagentReaders.has(res)) continue;
      const shown = reader ? reader.show(event.data) : event.data;
      if (shown !== undefined) send(res, `id: ${event.id}\ndata: ${JSON.stringify(shown)}\n\n`);
    }
    return RESPONSE_ALREADY_SENT;
  }

  /**
   * One read of the stream for clients that cannot hold it open: the buffered events after the
   * cursor, as JSON, and the cursor to poll from next. With `wait` (seconds, at most 25) and nothing
   * buffered yet, it answers when the next event arrives or the wait ends. With `snapshot=1`, as for
   * a stream: a snapshot where there is nothing to replay from.
   */
  private async poll(c: Context<ClientEnv>, session: Session, reader?: StreamReader) {
    if (gone(c)) return RESPONSE_ALREADY_SENT;
    const raw = c.req.header("last-event-id");
    // As a watcher: a snapshot by default, where there is nothing to replay from; snapshot=0 opts out.
    const asked = c.req.query("snapshot") !== "0";
    const wait = Number(c.req.query("wait") ?? 0);
    if (!Number.isFinite(wait) || wait < 0) throw new HttpError(400, "wait is a number of seconds");
    let read = this.replay(session, raw, asked);
    if (!read.snapshot && !read.events.length && wait > 0 && !this.closed && !session.fault) {
      // A waiting poll holds a subscriber's place, as a watcher does.
      const release = this.hold(session.header.tenant, session.watchers.size + session.polls.size);
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); session.polls.delete(done); c.env.outgoing.off("close", done); release(); resolve(); };
        const timer = setTimeout(done, Math.max(0, Math.min(wait * 1000, MAX_POLL_WAIT_MS, reader ? reader.until - Date.now() : Infinity)));
        session.polls.add(done);
        c.env.outgoing.once("close", done);
      });
      read = this.replay(session, raw, asked);
    }
    const { cursor, snapshot, events } = read;
    const shown = (data: ClientEvent | TurnSnapshot) => reader ? reader.show(data) : data;
    const nested = c.req.query("subagents") === "1";
    return json(c, 200, {
      cursor: events.at(-1)?.id ?? (cursor || session.cursor),
      events: [...snapshot ? [{ id: snapshot.cursor, data: shown(snapshot) }] : [], ...events.flatMap(({ id, data }) => {
        if (isSubagent(data) && !nested) return [];
        const visible = shown(data);
        return visible === undefined ? [] : [{ id, data: visible }];
      })],
    });
  }

  private busy(session: Session) {
    return !!session.starting || session.settling > 0 || session.inflight > 0 || session.running.size > 0;
  }

  /** The tenant's agents on this node but `id`: hosted, starting, or with a slot reserved (a create not yet loaded). */
  private tenantAgents(tenant: string, id?: string) {
    const ids = new Set<string>();
    for (const session of this.sessions.values()) {
      const other = session.header.id;
      if (session.header.tenant === tenant && (this.supervisor.agents.has(other) || this.supervisor.starting.has(other))) ids.add(other);
    }
    for (const [other, owner] of this.supervisor.reserved) if (owner === tenant) ids.add(other);
    if (id) ids.delete(id);
    return ids.size;
  }

  /** The least recently active idle agent hosted here (but `id`) that `filter` takes: one to stop to make room. */
  private idleAgent(filter: (session: Session) => boolean, id?: string) {
    return [...this.sessions.values()]
      .filter(session => session.header.id !== id && this.supervisor.agents.has(session.header.id) && !this.busy(session) && filter(session))
      .sort((a, b) => a.lastActive - b.lastActive)[0];
  }

  /** The agent quota a tenant has on this node, and where it comes from. */
  private async quota(tenant: string) {
    const own = await this.options.agentLimitFor?.(tenant);
    return { quota: own ?? this.options.maxAgentsPerTenant, source: own !== undefined ? "tenant" : "default" };
  }

  /** Whether `makeRoom` could make room for an agent of `tenant` now, without making it: the same checks, changing nothing. */
  private async canReserve(tenant: string) {
    const { quota } = await this.quota(tenant);
    if (quota && this.tenantAgents(tenant) >= quota && !this.idleAgent(session => session.header.tenant === tenant)) return false;
    return !this.supervisor.full || !!this.idleAgent(() => true);
  }

  /**
   * Make room to start `starting`'s agent, and reserve its slot: first within its
   * tenant's quota, so one tenant cannot take every slot, then on the host. Only
   * idle agents are stopped, least recently active first. Agents still starting
   * count, and the last check and the reservation happen with no await between
   * them, so concurrent starts cannot together pass either limit. The slot is
   * held until the supervisor starts the agent or `unreserve` gives it back.
   */
  private async makeRoom(id: string, tenant: string) {
    const { quota, source } = await this.quota(tenant);
    const evict = async (idle: Session | undefined) => { if (idle) await this.supervisor.stop(idle.header.id); return !!idle; };
    const reject = (status: 429 | 503, limit: string, value: number, message: string) => {
      console.log(JSON.stringify({ type: "quota_rejected", level: "info", tenant, agent: id, limit, value, source: limit === "agentsPerTenant" ? source : "node", status }));
      return new HttpError(status, message);
    };
    for (;;) {
      if (this.supervisor.reserved.has(id) || this.supervisor.agents.has(id) || this.supervisor.starting.has(id)) return;
      if (quota && this.tenantAgents(tenant, id) >= quota) {
        if (!await evict(this.idleAgent(session => session.header.tenant === tenant, id))) throw reject(429, "agentsPerTenant", quota, `This tenant already has ${quota} agents running; retry when one finishes`);
        continue;
      }
      if (this.supervisor.reserve(id, tenant)) return;
      if (!await evict(this.idleAgent(() => true, id))) throw reject(503, "agentsPerNode", this.supervisor.options.maxAgents ?? 8, "Agent capacity reached; retry when another agent is idle");
    }
  }

  private async apiKey(session: Session, provider: string, keyScope: string | undefined): Promise<{ key?: string; platform: boolean }> {
    const resolved = await this.options.apiKeyFor?.(session.header.tenant, provider, keyScope);
    return typeof resolved === "object" ? resolved : { key: resolved, platform: false };
  }

  private ensureStarted(session: Session) {
    if (this.closed || session.header.revoked) return Promise.reject(new HttpError(410, "Session closed"));
    if (session.fault) return Promise.reject(session.fault);
    session.lastActive = Date.now();
    if (this.supervisor.agents.has(session.header.id) && !session.starting) return Promise.resolve();
    const id = session.header.id;
    const steps = new Steps();
    return session.starting ??= (async () => {
      await steps.time("room", this.makeRoom(id, session.header.tenant));
      // Read before any response is counted against it.
      await steps.time("spend", this.spendOf(session));
      const [{ key: apiKey, platform }, priced] = await steps.time("key", Promise.all([this.apiKey(session, session.header.config.model.provider, session.header.keyScope), this.options.catalogPriced?.(session.header.tenant)]));
      session.platformKey = platform;
      session.catalogPriced = !!priced;
      // Its tool servers are listed (remote MCP servers connected to) before its host starts.
      const definitions = await steps.time("tools", this.toolset(session));
      const { cpuMs, maxTimeoutMs } = await this.codeLimits(session.header.tenant);
      const result = await steps.time("init", this.supervisor.start(session.header.id, { ...session.header.config, apiKey, mounts: (session.header.mounts ?? []).map(({ path, mode }) => ({ path, mode })), ...(this.options.retry ? { retry: this.options.retry } : {}), ...(session.resuming.size ? { resume: true } : {}), tenant: session.header.tenant, codeLimits: { cpuMs, maxTimeoutMs } }, {
        definitions,
        codeSlot: async signal => this.codeGate.acquire(session.header.tenant, (await this.codeLimits(session.header.tenant)).concurrent, signal),
        runLimit: async () => {
          const limited = await this.agentSpendLimit(session) ?? this.runSpendLimit(session) ?? await this.options.spendLimit?.(session.header.tenant);
          if (limited) return { stopped: "spend_limit" as const, message: typeof limited === "string" ? limited : limited.message };
          const turn = await this.turnLimit(session);
          if (turn) return { stopped: "turn_limit" as const, message: turn };
          // This node is leaving: the turn stops at this step boundary, and its next owner continues it (`park`).
          return this.handingOff ? { stopped: "handoff" as const, message: `This node is leaving the cluster (${this.handingOff.reason}); the turn continues on another` } : undefined;
        },
        call: (name, args, signal, context) => this.callTool(session, { name, args, signal, ...context }),
        file: ref => this.fileData(session, ref),
        modelAuth: () => this.modelAuth(session),
        fs: (op, args, signal) => this.fsCall(session, op, args, signal),
        search: query => this.searchTools(session, query),
        background: event => this.backgroundEvent(session, event),
        history: {
          // One whose create failed before writing its row begins it now, and is indexed from its log.
          indexed: async () => (await this.historyIndex.indexed(id)) ?? (await this.historyIndex.begin(id), 0),
          write: chunk => this.historyIndex.write(id, session.claim, chunk),
        },
      }, session.claim));
      // Bootstrap history has been imported into the transcript; keep only one authority.
      if (session.header.config.initialMessages !== undefined) {
        delete session.header.config.initialMessages;
        await this.writeHeader(session);
      }
      session.handoff = result.resume;
      // A turn handed off at a step boundary lost nothing: it simply goes on here.
      const handed = [...session.resuming].map(id => session.requests.get(id)).find(record => record?.handedOff);
      if (result.resume && "continue" in result.resume && handed) this.publish(session, { type: "event", requestId: "", event: { type: "turn_resumed", handoff: handed.handoffs?.at(-1)?.reason ?? "retire", reason: "The node running this turn left the cluster; it continues here from the step it finished" } });
      else if (result.resume && "continue" in result.resume) this.publish(session, { type: "event", requestId: "", event: { type: "turn_resumed", reason: "The node running this turn was lost; it continues here, with unresolved tool calls marked unknown" } });
      else if (result.recovered) this.publish(session, { type: "event", requestId: "", event: { type: "turn_recovered", reason: "The runtime restarted during a turn; unresolved tool calls were marked unknown" } });
      // Starting can take longer than the idle timeout; the agent is fresh, not idle.
      session.lastActive = Date.now();
      recordStart(steps, { tenant: session.header.tenant, agent: id });
      return result;
    })().catch(error => { recordStart(steps, { tenant: session.header.tenant, agent: id, error: safeError(error) }); throw error; })
      .finally(() => { session.starting = undefined; this.supervisor.unreserve(id); });
  }

  /**
   * The agent's tool servers in order of precedence: the runtime feature's (a channel's
   * send_message), the application's attached server, file tools over its mounts, then its
   * definition's built-ins, OpenAPI specs and remote MCP servers.
   */
  private async servers(session: Session, tools: ToolDefinition[], sources: Sources | undefined, fileTools: boolean | undefined): Promise<ToolServer[]> {
    const header = session.header;
    const tenant = header.tenant;
    const agent: AgentRef = { id: header.id, tenant, claim: session.claim };
    const feature = await this.options.hooks?.server?.(agent);
    session.channel = !!feature;
    const volumes = this.options.volumes;
    const view = (kind: ToolSourceView["kind"], server: ToolServer, extra: Partial<ToolSourceView> = {}): ToolServer =>
      ({ ...server, sources: async () => [{ kind, name: kind, status: "listed", ...extra, tools: await server.tools() }] });
    const multiAgent = this.multiAgentServer(session, sources);
    const definition = header.definition;
    return [
      ...feature ? [view("channel", feature)] : [],
      { tools: () => defaultExposure(tools), call: call => this.callAttached(session, call), sources: async () => [{ kind: "application", name: "application", status: "listed", connected: !!session.attached?.open, tools: defaultExposure(tools) }] },
      ...volumes && header.mounts?.length ? [view("files", fileServer(volumes.definitions().filter(tool => fileTools !== false || tool.name === "present_file"), ({ name, args, signal }) => volumes.tool(this.toolContext(session), name, args, signal)))] : [],
      ...multiAgent ? [multiAgent] : [],
      ...sources && this.options.sources ? [this.options.sources.server({ tenant, agent: header.id, ...(definition ? { definition: definition.id } : {}), claim: session.claim, ...(header.identity ? { identity: header.identity } : {}), mounts: header.mounts ?? [], onWrite: this.toolContext(session).onWrite }, sources)] : [],
    ];
  }

  /**
   * What the agent's file tools act as: its tenant, mounts and current model. A run's writes and
   * presented files are collected for its outcome; a presented file is also an event on the
   * agent's stream, with a signed download link, as soon as it is presented.
   */
  private toolContext(session: Session): ToolContext {
    const header = session.header;
    return {
      tenant: header.tenant, agent: header.id, mounts: header.mounts ?? [], model: () => session.header.config.model,
      onWrite: file => {
        const files = session.outputs?.files;
        if (files && (files.has(file.path) || files.size < OUTPUT_FILES)) files.set(file.path, file);
      },
      onPresent: (file, volumePath) => {
        const outputs = session.outputs;
        if (!outputs) throw new Error("Files can be presented only during a run");
        if (outputs.presented.length >= FILE_LIMITS.attachments) throw new Error(`At most ${FILE_LIMITS.attachments} files can be presented in a run`);
        outputs.presented.push(file);
        const request = [...session.running.values()].find(record => RUN_METHODS.includes(record.method) && record.began);
        const link = this.options.links?.sign({ tenant: header.tenant, volume: file.volume, path: volumePath, method: "GET" });
        this.publish(session, { type: "event", requestId: request?.id ?? "", event: { type: "file_presented", file, ...(link ? { url: link.url, expiresAt: link.expiresAt } : {}) } });
      },
    };
  }

  /**
   * The agent's tools from its servers (see `servers`), or from the ones `next` gives it (a configuration it is about to
   * take). Records the route, and the servers for `toolSources`.
   */
  private async toolset(session: Session, next: { tools?: ToolDefinition[]; sources?: Sources; fileTools?: boolean } = {}) {
    const { header } = session;
    const servers = await this.servers(session, next.tools ?? header.definitions, "sources" in next ? next.sources : header.sources, "fileTools" in next ? next.fileTools : header.config.fileTools);
    const { tools: definitions, route } = await compose(servers);
    session.route = route;
    session.servers = servers;
    // Sources that could not be listed (down, or refusing their credentials): the model has none of their tools, so each run's outcome says so.
    const views = (await Promise.all(servers.map(server => server.sources?.({ refresh: false }).catch(() => []) ?? []))).flat();
    // Served tools are MCP sources the runtime calls with its identity tokens.
    const served = new Set((("sources" in next ? next.sources : header.sources)?.mcpServers ?? []).filter(spec => spec.auth?.type === "runtime").map(spec => spec.name));
    session.toolSources = new Map(views.flatMap(view => view.tools.map(tool => [tool.name, view.kind === "application" ? "attached" : view.kind === "mcp" && served.has(view.name) ? "served" : view.kind] as const)));
    session.sourceErrors = views.flatMap(view => view.status === "error" ? [{ kind: view.kind, source: view.name, message: view.error ?? "Could not be listed" }] : []);
    session.searchable = definitions.filter(tool => tool.exposure !== "direct");
    // Rerankers that index the catalog (embeddings) start now, so the first search need not wait; the agent's tenant pays for it at cost.
    for (const stage of this.options.rerankers ?? []) stage.warm?.(session.searchable, usd => this.toolSearchUsage(session, usd, 0));
    return definitions;
  }

  /**
   * What each of a tenant's agent's tool sources offers, and which tools its model gets. A running
   * agent shows the lists its tools were built from; otherwise MCP servers show what this node last
   * listed, or `unlisted`. `refresh` lists every MCP server now, connecting to it: what the servers
   * offer at this moment, which a running agent takes at its next start or reconfiguration.
   */
  async toolSources(id: string, tenant: string, options: { refresh?: boolean; schemas?: boolean } = {}) {
    const session = (await this.owns(id, tenant)) ? await this.load(id) : undefined;
    if (!session) throw new HttpError(404, "Agent not found");
    const servers = this.supervisor.agents.has(id) && session.servers ? session.servers : await this.servers(session, session.header.definitions, session.header.sources, session.header.config.fileTools);
    const sources = (await Promise.all(servers.map(server => server.sources?.({ refresh: options.refresh }) ?? [])));
    return describeSources(sources.flat(), options.schemas);
  }

  /**
   * Answer one of the agent's tool calls through the server that lists it, once the run's start is
   * durable. A tool that asks for human input (MCP's `input_required`, or the runtime's approval
   * policy and ask_user in that form) suspends the call instead (`suspend`). In a `resume` run, a
   * call the person answered runs again with their answers, and only with the same arguments.
   */
  private async callTool(session: Session, call: ToolCall) {
    let code: ToolCallCode | undefined;
    // A direct call's span is made from its events; a call from js_exec's code has one of its own, under js_exec's.
    const spans = session.spans, started = Date.now();
    const innerSpan = spans && call.innerCallId ? newSpanId() : undefined;
    let answer: Awaited<ReturnType<ClientSessions["answerToolCall"]>> | undefined;
    try {
      answer = await this.answerToolCall(session, spans ? { ...call, traceparent: spans.traceparent(call.toolCallId, innerSpan) } : call);
      code = "inputRequired" in answer ? "input_required" : "isError" in answer && answer.isError ? "tool_error" : undefined;
      return answer;
    } catch (error) {
      code = call.signal.aborted ? "aborted" : error instanceof ToolFailure ? error.code : "failed";
      throw error;
    } finally {
      if (innerSpan) spans!.innerCall(call, innerSpan, started, Date.now(), code, answer);
      // Listed in the run's outcome (`toolCalls`), ids only: its arguments and result are in history.
      const calls = session.toolCalls ??= [];
      // A delegate call names the child agent it ran.
      const child = call.name === "delegate" && call.toolCallId && !call.innerCallId ? session.children?.get(call.toolCallId)?.agent : undefined;
      if (calls.length < OUTPUT_TOOL_CALLS) calls.push({ tool: call.name, ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}), ...(call.innerCallId ? { innerCallId: call.innerCallId } : {}), ok: !code, ...(code ? { code } : {}), ...(child ? { agentId: child } : {}) });
    }
  }

  private async answerToolCall(session: Session, call: ToolCall) {
    const server = session.route?.get(call.name);
    if (!server) throw new Error(`Unknown tool ${call.name}`);
    const request = [...session.running.values()].find(r => RUN_METHODS.includes(r.method) && r.began);
    const plan = call.toolCallId && !call.innerCallId ? session.retries?.get(call.toolCallId) : undefined;
    if (plan && plan.argumentsHash !== argumentsHash(call.name, call.args)) throw new Error("These are not the arguments the user answered for; the call did not run");
    const origin = await this.options.hooks?.origin?.({ id: session.header.id, tenant: session.header.tenant, claim: session.claim }, request?.id);
    await this.beforeEffect(session);
    // A server's progress reaches the event stream as an update of the model's tool call (js_exec's, for a call from code),
    // at most one per PROGRESS_MS: the latest of a burst is published at its window's end, and before the call's result.
    let progressed: (() => void) | undefined;
    const onProgress = call.toolCallId ? throttled(({ progress, total, message }: Progress) => this.publish(session, { type: "event", requestId: request?.id ?? "", event: {
      type: "tool_execution_update", toolCallId: call.toolCallId, toolName: call.innerCallId ? "js_exec" : call.name,
      partialResult: { content: [{ type: "text", text: message ?? `${progress}${total !== undefined ? `/${total}` : ""}` }], details: { type: "progress", tool: call.name, ...(call.innerCallId ? { innerCallId: call.innerCallId } : {}), progress, ...(total !== undefined ? { total } : {}), ...(message !== undefined ? { message } : {}) } },
    } }), flush => { progressed = flush; }) : undefined;
    let result: McpResult;
    try {
      result = await this.recordingFailures(session, call, () => server.call({
        ...call, ...(request ? { run: request.id } : {}), ...(origin ? { origin } : {}), ...(request?.actor ? { actor: request.actor } : {}), ...(onProgress ? { onProgress } : {}),
        ...(call.toolCallId ? { idempotencyKey: toolCallKey(session.header.id, call.messageIndex, call.toolCallId, call.innerCallId) } : {}),
        ...(plan?.approval ? { approval: { input: plan.approval.input, by: this.approver(plan.approval.by), at: plan.approval.at } } : {}),
        ...(plan?.inputResponses ? { inputResponses: plan.inputResponses } : {}), ...(plan?.requestState !== undefined ? { requestState: plan.requestState } : {}),
        ...(this.humanSurface(session) ? { elicit: true } : {}),
      }));
    } catch (error) {
      progressed?.();
      // MCP's older form of a URL step (-32042): the user opens each URL, then the call is retried.
      const elicitations = error instanceof McpError && error.code === -32042 ? (error.data as { elicitations?: unknown[] } | undefined)?.elicitations : undefined;
      if (!Array.isArray(elicitations) || !elicitations.length) throw error;
      result = { resultType: "input_required", inputRequests: Object.fromEntries(elicitations.map((params, index) => [`url_${index}`, { method: "elicitation/create", params: { ...params as object, mode: "url" } }])) };
    }
    progressed?.();
    if (result.resultType === "input_required") return this.suspend(session, call, request, result);
    const content = contentResult(result, server.returnsFiles);
    // The model learns who answered, and how long ago: it should check what may have changed meanwhile.
    if (plan) content.content.push({ type: "text", text: plan.note });
    return content;
  }

  /**
   * Run a tool call, recording in the run's outcome (`toolErrors`) why it did not complete, if it did not: so a
   * caller sees a call that timed out, found no application connected, or could not reach its server, and not only the model.
   */
  private async recordingFailures<T>(session: Session, call: ToolCall, work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (call.signal.aborted || (error instanceof McpError && error.code === -32042)) throw error;
      const failure = error instanceof ToolFailure ? error
        : error instanceof McpError && error.code === ErrorCode.RequestTimeout ? new ToolFailure("timeout", `${error.message}. Its outcome is unknown: it may or may not have taken effect.`, true)
        : error instanceof McpError && error.code === ErrorCode.ConnectionClosed ? new ToolFailure("connection_lost", CONNECTION_LOST, true)
        : /^Could not connect to MCP server|MCP server .* (?:failed|refused|answered)/.test(errorText(error)) ? new ToolFailure("source_unavailable", errorText(error))
        : new ToolFailure("failed", errorText(error));
      (session.toolErrors ??= []).push({ tool: call.name, ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}), ...(call.innerCallId ? { innerCallId: call.innerCallId } : {}),
        code: failure.code, ...(failure.outcomeUnknown ? { outcomeUnknown: true } : {}), message: failure.message });
      throw failure;
    }
  }

  /**
   * The delegate tool of an agent whose sources enable it (multi-agent.ts), answered here rather than by a tool source: a
   * delegate call's child is an agent of its own.
   */
  private multiAgentServer(session: Session, sources: Sources | undefined): ToolServer | undefined {
    const delegate = sources?.builtins?.includes("delegate") ? sources.delegate : undefined;
    if (!delegate) return undefined;
    const tools = async () => [delegateTool(delegate, await this.targetDescriptions(session.header.tenant, delegate.agents ?? []))];
    return {
      tools,
      sources: async () => (await tools()).map((tool): ToolSourceView => ({ kind: "builtin", name: tool.name, status: "listed", tools: [tool] })),
      call: async call => {
        if (call.name === "delegate") return this.delegate(session, delegate, call);
        throw new Error(`Unknown tool ${call.name}`);
      },
    };
  }

  /** What each definition target is for, as its definition describes it, for the tools' descriptions. */
  private async targetDescriptions(tenant: string, targets: AgentTarget[]) {
    const found = new Map<string, string>();
    await Promise.all(targets.filter(target => target.definition !== undefined && !target.description).map(async target => {
      const id = definitionId(tenant, target.definition!);
      const description = await this.options.definitionFor?.(tenant, id).then(definition => definition.description, () => undefined);
      if (description) found.set(id, description);
    }));
    return (target: AgentTarget) => target.definition !== undefined ? found.get(definitionId(tenant, target.definition)) : undefined;
  }

  /** The agent's run that has begun: the one its tool calls are made in. */
  private runningRun(session: Session) {
    return [...session.running.values()].find(record => RUN_METHODS.includes(record.method) && record.began);
  }

  /**
   * A delegate call: a child agent on the task, and its answer. The child is a real agent, made from a definition target or
   * with the model's instructions (a named target is an existing agent, with its own history), keyed by this call, and its
   * prompt's request id is the call's too: made again (a turn resumed on another node), the call finds the same child and run
   * and collects its answer, never running it twice. Children count against the tenant's busy agents, spend and run rate as
   * any agent does; the parent's spend limits bound theirs and are charged with what they spent; a chain is at most `maxDepth`
   * deep, and at most `maxParallel` of a run's calls are in flight at once (the rest wait).
   */
  private async delegate(session: Session, settings: DelegateSettings, call: ToolCall): Promise<McpResult> {
    const { header } = session;
    const tenant = header.tenant;
    const run = this.runningRun(session);
    const { createAgent, submit } = this.options;
    if (!createAgent || !submit) throw new Error("Delegation is not enabled on this runtime");
    if (!run || !call.toolCallId || call.innerCallId || !call.idempotencyKey) throw new Error("delegate is called directly, not from js_exec");
    const toolCallId = call.toolCallId;
    const { agent: name, instructions, task, output: schema } = call.args as { agent?: string; instructions?: string; task?: unknown; output?: unknown };
    const target = name === undefined ? undefined : settings.agents?.find(entry => entry.name === name);
    if (name !== undefined && !target) throw new Error(`There is no agent ${name} to delegate to`);
    if (instructions !== undefined && !settings.instructions) throw new Error("Name an agent to delegate to: instructions of your own are not allowed here");
    if ((target === undefined) === (instructions === undefined)) throw new Error(settings.instructions && settings.agents?.length ? "Name an agent to delegate to, or give instructions: one of them" : settings.instructions ? "Give the sub-agent's instructions" : "Name an agent to delegate to");
    if (typeof task !== "string" || !task.trim()) throw new Error("Give the task to delegate");
    const output = schema === undefined ? undefined : outputInput({ schema });
    // Where this run is in its chain: the prompt that started it says so, if a delegate call sent it (signed by the runtime).
    const place = this.delegation(header.id, run.id, run.metadata);
    const depth = place.depth + 1;
    const maxDepth = Math.min(place.maxDepth, settings.maxDepth ?? MULTI_AGENT_LIMITS.maxDepth);
    if (depth > maxDepth) throw new Error(`Delegation has reached its depth limit of ${maxDepth}: do this task yourself`);
    const chain = [...place.chain, header.id];
    await this.delegationSlot(session, settings.maxParallel ?? MULTI_AGENT_LIMITS.maxParallel, call.signal);
    let untap: (() => void) | undefined;
    let child: Child | undefined;
    let held: number | undefined;
    try {
      const key = `delegate-${call.idempotencyKey}`;
      const requestId = `delegate_${call.idempotencyKey}`;
      const made = target?.agent === undefined;
      let agent = made ? this.agentId(tenant, key) : await this.agentByKey(tenant, target!.agent!);
      if (!agent) throw new Error(`The agent ${target!.name} does not exist`);
      if (chain.includes(agent)) throw new Error(`${target!.name} is already working on this task's chain: delegating to it would wait on itself`);
      // Made again (a resumed turn): the same child and request, with the answer it has or will have.
      let record = await this.requestOf(agent, tenant, requestId, 0, call.signal).catch(error => { if ((error as HttpError).status === 404) return undefined; throw error; });
      if (!record) {
        if (made) {
          const web = (header.sources?.builtins ?? []).filter(builtin => builtin === "web_search" || builtin === "web_fetch");
          // An inline child has its parent's model: as it is (its endpoint too), or by name on the tenant's own providers, which take only names.
          const { provider, id: modelId } = header.config.model;
          const named = Object.hasOwn(this.options.modelEndpoints?.(tenant) ?? {}, provider) || Object.hasOwn(await this.options.customProviders?.(tenant, header.keyScope) ?? {}, provider);
          agent = (await createAgent(tenant, {
            ...target?.definition !== undefined ? { definition: definitionId(tenant, target.definition) } : {
              model: named ? `${provider}/${modelId}` : header.config.model, systemPrompt: instructions, ...web.length ? { builtins: web } : {},
            },
            name: target?.name ?? "subagent", type: "subagent", ttlSeconds: MULTI_AGENT_LIMITS.childTtlSeconds,
            // It acts for whom its parent acts, with the same keys.
            ...header.identity?.subject !== undefined ? { subject: header.identity.subject } : {}, ...header.identity?.context ? { context: header.identity.context } : {},
            ...header.keyScope ? { keyScope: header.keyScope } : {},
          }, key, { agentId: header.id, runId: run.id, toolCallId, depth })).id;
        }
      }
      child = { agent, requestId, made };
      (session.children ??= new Map()).set(toolCallId, child);
      const at = { toolCallId, agentId: agent, requestId };
      const end = (status: string, error?: string) => this.publish(session, { type: "event", requestId: run.id, event: { type: "subagent_end", ...at, status, ...(error ? { error } : {}) } });
      this.publish(session, { type: "event", requestId: run.id, event: { type: "subagent_start", ...at, name: target?.name ?? "subagent", depth } });
      // Listening before the child's run is sent, so its first events are relayed too.
      untap = this.relay(session, run.id, at);
      if (!record) {
        try {
          const budget = await this.holdBudget(session, run.id);
          held = budget;
          if (budget !== undefined && budget <= 0) throw new Error("This run has no budget left for a sub-agent: its spend limit is reached");
          record = await submit(agent, tenant, { id: requestId, method: "prompt", params: {
            text: task, ...output ? { output } : {}, ...budget !== undefined ? { spendLimit: { usd: budget } } : {}, ...run.actor ? { actor: run.actor } : {},
            // The child's run joins the parent's trace, under this call's span (not part of the request's fingerprint).
            ...call.traceparent ? { traceparent: call.traceparent } : {},
            metadata: { [PARENT_KEYS.agent]: header.id, [PARENT_KEYS.run]: run.id, [PARENT_KEYS.toolCall]: toolCallId, [PARENT_KEYS.depth]: String(depth), [PARENT_KEYS.maxDepth]: String(maxDepth), [PARENT_KEYS.chain]: chain.join(","),
              [PARENT_KEYS.signature]: this.delegationSignature(agent, requestId, String(depth), String(maxDepth), chain.join(",")) },
          } });
        } catch (error) {
          // Refused (the tenant's busy agents, its spend, the child's own limits): the call fails with why.
          child.done = true;
          end("failed", errorText(error));
          throw error;
        }
      }
      const finished = record.state === "completed" ? record : await this.childOutcome(agent, tenant, requestId, call.signal).catch(error => {
        // The parent's run stopped waiting (aborted, or its node stopping): its stream says the child is no longer followed.
        if (call.signal.aborted) end("failed", "The parent's run stopped waiting for it");
        throw error;
      });
      child.done = true;
      const result = (finished.outcome?.result ?? {}) as { reply?: string; output?: unknown; usage?: { costUsd?: number; subagentCostUsd?: number } | null };
      // What the child spent counts against this agent's spend limit and this run's.
      const cost = (result.usage?.costUsd ?? 0) + (result.usage?.subagentCostUsd ?? 0);
      if (cost > 0) {
        this.spent(session, cost);
        (session.childSpend ??= new Map()).set(run.id, (session.childSpend.get(run.id) ?? 0) + cost);
      }
      const status = finished.status ?? "failed";
      end(status, finished.error);
      const value = {
        agentId: agent, requestId, status, ...(result.reply ? { text: result.reply } : {}), ...(result.output !== undefined ? { output: result.output } : {}),
        ...(finished.error ? { error: finished.error } : {}), ...(finished.stopped ? { stopped: finished.stopped } : {}),
      };
      return { ...jsonResult(value), ...(status === "completed" ? {} : { isError: true }) };
    } finally {
      untap?.();
      // What the child spent is in `childSpend` by now: its hold goes.
      if (held !== undefined) this.releaseBudget(session, run.id, held);
      this.releaseDelegation(session);
    }
  }

  /**
   * The spend limit a delegate call's child gets, held for it until it ends (`releaseBudget`): an even share of what the
   * run may still spend that no other child in flight holds, split among this run's calls in flight that hold none yet.
   * So parallel children together never get more than the parent has left. Undefined when the run has no limit.
   */
  private async holdBudget(session: Session, runId: string) {
    const left = await this.budgetLeft(session, runId);
    if (left === undefined) return undefined;
    const held = (session.childHeld ??= new Map()).get(runId) ?? { usd: 0, holders: 0 };
    const sharing = Math.max(1, (session.delegating?.active ?? 1) - held.holders);
    const share = Math.max(0, left - held.usd) / sharing;
    session.childHeld.set(runId, { usd: held.usd + share, holders: held.holders + 1 });
    return share;
  }

  private releaseBudget(session: Session, runId: string, usd: number) {
    const held = session.childHeld?.get(runId);
    if (!held) return;
    if (held.holders <= 1) session.childHeld!.delete(runId);
    else session.childHeld!.set(runId, { usd: Math.max(0, held.usd - usd), holders: held.holders - 1 });
  }

  /**
   * Where run `runId` of agent `agentId` is in a delegation chain: as its prompt's metadata says when the runtime signed
   * it for that agent and run (a delegate call's child run), else at a chain's start. Metadata is the caller's to send,
   * so a caller that names the same keys cannot set its run's depth, raise its limit or hide the chain.
   */
  private delegation(agentId: string, runId: string, metadata: Record<string, string> | undefined): { depth: number; maxDepth: number; chain: string[] } {
    const start = { depth: 0, maxDepth: MULTI_AGENT_LIMITS.depthCeiling, chain: [] };
    const depth = metadata?.[PARENT_KEYS.depth], maxDepth = metadata?.[PARENT_KEYS.maxDepth], chain = metadata?.[PARENT_KEYS.chain] ?? "", signature = metadata?.[PARENT_KEYS.signature];
    if (depth === undefined || maxDepth === undefined || typeof signature !== "string") return start;
    const expected = Buffer.from(this.delegationSignature(agentId, runId, depth, maxDepth, chain));
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), expected)) return start;
    return { depth: Number(depth), maxDepth: Number(maxDepth), chain: chain.split(",").filter(Boolean) };
  }

  private delegationSignature(agentId: string, runId: string, depth: string, maxDepth: string, chain: string) {
    return createHmac("sha256", this.options.secret).update(`delegation-v1:${agentId}:${runId}:${depth}:${maxDepth}:${chain}`).digest("hex");
  }

  /** Wait until one of the running run's delegate calls may go: at most `max` are in flight at once. */
  private async delegationSlot(session: Session, max: number, signal: AbortSignal) {
    const slots = session.delegating ??= { active: 0, waiting: [] };
    while (slots.active >= max) {
      signal.throwIfAborted();
      await new Promise<void>(resolve => { slots.waiting.push(resolve); signal.addEventListener("abort", () => resolve(), { once: true }); });
    }
    signal.throwIfAborted();
    slots.active++;
  }
  private releaseDelegation(session: Session) {
    const slots = session.delegating;
    if (!slots) return;
    slots.active--;
    // Each waiter looks again: one takes the slot, the rest wait on.
    for (const wake of slots.waiting.splice(0)) wake();
  }

  /** The tenant's live agent made with `key`, if there is one. */
  private async agentByKey(tenant: string, key: string): Promise<string | undefined> {
    const { rows } = await this.db.query("select id from agents where tenant = $1 and header->>'key' = $2 and not revoked and (expires_at is null or expires_at > $3) order by id limit 1", [tenant, key, Date.now()]);
    return rows[0]?.id;
  }

  /** What the running run may still spend, within its own spend limit and its agent's; undefined when neither has one. */
  private async budgetLeft(session: Session, runId: string) {
    const spend = await this.spendOf(session);
    const own = session.runLimits?.get(runId);
    const left = Math.min(spend ? spend.usd - spend.spent : Infinity, own !== undefined ? own - (session.usage?.get(runId)?.costUsd ?? 0) - (session.childSpend?.get(runId) ?? 0) : Infinity);
    return Number.isFinite(left) ? Math.max(0, left) : undefined;
  }

  /** An agent's request, here or on the node serving it (see `awaitRequest`). */
  private requestOf(agent: string, tenant: string, requestId: string, waitMs: number, signal?: AbortSignal) {
    return this.options.requestAnywhere ? this.options.requestAnywhere(agent, tenant, requestId, waitMs, signal) : this.awaitRequest(agent, tenant, requestId, waitMs, signal);
  }

  /** Wait for a child's request to settle, wherever the child is served, riding out its moves between nodes. */
  private async childOutcome(agent: string, tenant: string, requestId: string, signal: AbortSignal): Promise<RequestRecord> {
    for (let delay = 250; ;) {
      signal.throwIfAborted();
      let record: RequestRecord | undefined;
      try { record = await this.requestOf(agent, tenant, requestId, MAX_POLL_WAIT_MS, signal); }
      catch (error) {
        signal.throwIfAborted();
        const status = (error as HttpError).status;
        if (status === 404 || status === 410) throw new Error("The sub-agent was deleted before it answered");
        // The child is moving between nodes, or its node has no room yet: ask again shortly.
        await sleep(delay);
        delay = Math.min(delay * 2, 5_000);
        continue;
      }
      if (!record) throw new Error("The sub-agent no longer has this task's request");
      if (record.state === "completed") return record;
      delay = 250;
    }
  }

  /** Relay a child's events of its request to this agent's stream as `subagent_event`, while the child runs on this node. Returns the undo. */
  private relay(session: Session, runId: string, at: { toolCallId: string; agentId: string; requestId: string }) {
    const child = this.sessions.get(at.agentId);
    if (!child) return undefined;
    // Streamed text is left out: a child's progress is its finished messages, tool calls and its own children.
    const tap = (data: ClientEvent) => {
      if (data.type !== "event" || data.requestId !== at.requestId || data.event?.type === "message_update") return;
      this.publish(session, { type: "event", requestId: runId, event: { type: "subagent_event", agentId: at.agentId, toolCallId: at.toolCallId, event: data.event } });
    };
    (child.taps ??= new Set()).add(tap);
    return () => { child.taps?.delete(tap); };
  }

  /** Mark the run that has begun as aborted, so it does not start if the agent does not have it yet (see `execute`). */
  private markAborted(session: Session) {
    const run = this.runningRun(session);
    if (run) (session.aborted ??= new Set()).add(run.id);
  }

  /**
   * Abort the children the running run's delegate calls wait on: an abort or a delete of this agent cascades to them. A named
   * agent is aborted only while it runs this run's request, never another's.
   */
  private abortChildren(session: Session) {
    const submit = this.options.submit;
    const children = [...session.children?.values() ?? []].filter(child => !child.done);
    if (!submit || !children.length) return;
    const tenant = session.header.tenant;
    for (const child of children) {
      void (async () => {
        if (!child.made) {
          const record = await this.requestOf(child.agent, tenant, child.requestId, 0);
          if (record?.state !== "running" || !record.began) return;
        }
        await submit(child.agent, tenant, { id: `abort-${randomUUID()}`, method: "abort", params: {} });
      })().catch(error => console.error(JSON.stringify({ type: "subagent_abort_failed", agent: session.header.id, child: child.agent, error: safeError(error) })));
    }
  }

  /**
   * One of a tenant's agent's requests once it settles, or as it is after `waitMs` (at most 25 s): a delegate call's wait for its
   * child, from this node or another's. It loads the agent here, which resumes work a lost node left. Undefined: no such request.
   */
  async awaitRequest(id: string, tenant: string, requestId: string, waitMs: number, signal?: AbortSignal): Promise<RequestRecord | undefined> {
    if (!await this.owns(id, tenant)) throw new HttpError(404, "Unknown agent");
    await this.roomFor(id);
    const session = await this.load(id);
    if (!session) throw new HttpError(404, "Unknown agent");
    const until = Date.now() + Math.min(waitMs, MAX_POLL_WAIT_MS);
    for (;;) {
      const record = session.requests.get(requestId);
      if (!record) return undefined;
      if (record.state === "completed" || Date.now() >= until || this.closed || session.fault || this.sessions.get(id) !== session || signal?.aborted) return visible(record);
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); session.polls.delete(done); signal?.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, until - Date.now());
        session.polls.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  /**
   * Whether the agent has someone to ask: a channel's conversation, a definition that set up human
   * input (humanInput, ask_user), or an application connected to its stream. Only then may its
   * tools' servers ask for input (MCP's elicitation capability).
   */
  private humanSurface(session: Session) {
    const sources = session.header.sources;
    return !!(sources?.humanInput || sources?.builtins?.includes("ask_user") || session.channel || session.attached?.open);
  }

  /** Who approved a call, as tools are told: ids only, never names a person chose. */
  private approver(by: Responder) {
    return { ...(by.via ? { via: by.via } : {}), ...(by.from ? { from: by.from.id } : {}), ...(by.actor ? { actor: by.actor } : {}) };
  }

  /**
   * Suspend a tool call on the input its tool asked for: each request becomes an input (approvals
   * shown as the runtime sees the call, never as the model or tool describes it), announced on the
   * agent's stream, and the call returns open for the agent to leave waiting. Code in js_exec cannot
   * wait for days, so a call from there fails, pointing the model at a direct call.
   */
  private async suspend(session: Session, call: ToolCall, request: RequestRecord | undefined, result: McpResult) {
    const inputs = this.options.inputs;
    let requests = inputRequests(result);
    const approval = requests.every(entry => entry.kind === "approval");
    if (!call.toolCallId || call.innerCallId || !request || !inputs) throw new Error(`${call.name} needs the user's ${approval ? "approval" : "input"}: call ${call.name} directly, not from js_exec`);
    const header = session.header;
    const hashed = argumentsHash(call.name, call.args);
    const shown = JSON.stringify(call.args);
    requests = requests.map(entry => entry.kind !== "approval" ? entry : {
      ...entry, message: `Allow ${call.name} to run?`,
      // The call's arguments as it has them; past INPUT_LIMITS.arguments of JSON, the start of that JSON instead.
      detail: { ...entry.detail, tool: call.name, source: call.name.includes("__") ? call.name.split("__")[0] : header.definitions.some(tool => tool.name === call.name) ? "application" : "runtime",
        ...shown.length > INPUT_LIMITS.arguments ? { argumentsPreview: `${shown.slice(0, INPUT_LIMITS.arguments)}…` } : { arguments: call.args }, argumentsHash: hashed },
    });
    const rows = await inputs.create({
      agent: header.id, tenant: header.tenant, requestId: request.id, toolCallId: call.toolCallId,
      responders: request.actor ? { audience: [request.actor] } : {}, expiresAt: expiresAt(header.sources?.humanInput, header.expiresAt),
      tool: call.name, argumentsHash: hashed, ...(typeof result.requestState === "string" ? { requestState: result.requestState } : {}),
    }, requests, session.claim);
    for (const row of rows) this.publish(session, { type: "event", requestId: request.id, event: { type: "input_required", input: inputView(row) } });
    return { content: [{ type: "text", text: "Waiting for the user's input." }], inputRequired: true };
  }

  /**
   * Settle every input the agent waits on, as the runtime: a new message supersedes them (the agent
   * closes their calls itself when it takes the message), and an abort cancels them, closing the
   * turn with a `resume` run that does not call the model.
   */
  private async cancelInputs(session: Session, reason: "aborted" | "superseded") {
    const inputs = this.options.inputs;
    if (!inputs) return;
    const settled: InputRow[] = [];
    for (const input of await inputs.pending(session.header.id)) {
      const done = await inputs.settle(input.id, { action: "cancel", by: { system: reason }, at: Date.now() }, reason === "aborted" ? "cancelled" : "superseded");
      if (done) settled.push(done);
    }
    for (const input of settled) this.resolved(session, input);
    if (reason === "aborted") for (const suspension of new Set(settled.map(input => input.requestId))) await this.resumeSettled(session, suspension);
  }

  private resolved(session: Session, input: InputRow) {
    this.publish(session, { type: "event", requestId: input.requestId, event: { type: "input_resolved", id: input.id, state: input.state, by: input.answer?.by } });
  }

  /** Queue the run that resumes a suspension once none of its inputs is pending; idempotent per suspension. Returns its record, if any. */
  private async resumeSettled(session: Session, suspension: string): Promise<RequestRecord | undefined> {
    const rows = await this.options.inputs!.forRequest(session.header.id, suspension);
    if (!rows.length || rows.some(row => row.state === "pending")) return undefined;
    return (await this.accept(session, { id: resumeId(suspension), method: "resume", params: { suspension } }, true)).record;
  }

  /** A tenant's agent's inputs (`state`: pending, say), newest first. */
  async inputsFor(id: string, tenant: string, state?: string) {
    if (!this.options.inputs) return [];
    return (await this.options.inputs.list(tenant, { agent: id, ...(state ? { state } : {}) })).map(inputView);
  }

  /**
   * Answer a tenant's agent's inputs, all of them or none, on any node. An input settles once: the
   * same answer again is 200, a different one 409. Whoever a request names (`from`, `actor`) must be
   * among those who may answer (403). The last answer of a suspension queues its `resume` run on the
   * node serving the agent, returned in `requests`.
   */
  async answer(id: string, tenant: string, answers: { id: string; body: any }[], via: Responder["via"] = "api"): Promise<{ status: 200 | 202; inputs: Input[]; requests: RequestRecord[] }> {
    const inputs = this.options.inputs;
    if (!inputs) throw new HttpError(404, "Unknown agent");
    const { header } = await this.headerFor(id, tenant);
    if (!answers.length || answers.length > 100 || new Set(answers.map(entry => entry.id)).size !== answers.length) throw new HttpError(400, "Answer 1 to 100 different inputs");
    const checked: { input: InputRow; answer: Answer }[] = [];
    for (const { id: inputId, body } of answers) {
      const input = await inputs.get(inputId);
      if (!input || input.agent !== id) throw new HttpError(404, `Unknown input ${inputId}`);
      let by: Responder;
      try { by = { via, ...(body?.from !== undefined ? { from: senderInput(body.from) } : {}), ...(body?.actor !== undefined ? { actor: actorInput(body.actor) } : {}) }; }
      catch (error) { throw new HttpError(400, errorText(error)); }
      if (!mayAnswer(input, by, header.sources?.humanInput?.approvers)) throw new HttpError(403, "This person may not answer this input");
      checked.push({ input, answer: { ...answerInput(input, body), by, at: Date.now() } });
    }
    const settled = checked.every(({ input }) => input.state === "pending") ? await inputs.settleAll(checked.map(({ input, answer }) => ({ id: input.id, answer }))) : undefined;
    const suspensions = [...new Set(checked.map(({ input }) => input.requestId))];
    if (!settled) {
      // Settled already: a retry of these answers is 200; anything else conflicts, showing what was recorded.
      const current = await Promise.all(checked.map(({ input }) => inputs.get(input.id))) as InputRow[];
      const same = current.every((row, index) => row.answer && !row.answer.by.system && row.answer.action === checked[index].answer.action && canonical(row.answer.content ?? null) === canonical(checked[index].answer.content ?? null));
      if (!same) throw Object.assign(new HttpError(409, current.length === 1 ? `This input is already ${current[0].state}` : "An input is already settled"), { input: current.length === 1 ? inputView(current[0]) : current.map(inputView) });
      return { status: 200, inputs: current.map(inputView), requests: await this.resumeAnywhere(id, tenant, suspensions) };
    }
    // Announced here when this node serves the agent; otherwise its resume run announces them.
    const local = this.sessions.get(id);
    if (local) for (const input of settled) this.resolved(local, input);
    return { status: 202, inputs: settled.map(inputView), requests: await this.resumeAnywhere(id, tenant, suspensions) };
  }

  /** Resume each of these suspensions none of whose inputs is pending, on the node serving the agent; idempotent per suspension. */
  private async resumeAnywhere(agent: string, tenant: string, suspensions: string[]) {
    const submit = this.options.submit ?? ((agent, tenant, request) => this.submit(agent, tenant, request));
    const requests: RequestRecord[] = [];
    for (const suspension of suspensions) {
      if ((await this.options.inputs!.forRequest(agent, suspension)).some(row => row.state === "pending")) continue;
      requests.push(await submit(agent, tenant, { id: resumeId(suspension), method: "resume", params: { suspension } }));
    }
    return requests;
  }

  /** A tenant's inputs across its agents, newest first: the inbox of what waits on someone. */
  async inbox(tenant: string, state?: string) {
    return this.options.inputs ? (await this.options.inputs.list(tenant, state ? { state } : {})).map(inputView) : [];
  }

  /**
   * Expire inputs past their time, on any node: each suspension whose last input expired is resumed
   * on the node serving its agent, which closes the turn (or, with `onExpire: "resume"`, asks the model).
   */
  async expireInputs(now = Date.now()) {
    const inputs = this.options.inputs;
    if (!inputs) return;
    for (let batch; (batch = await inputs.due(now)).length;) {
      const suspensions = new Map<string, InputRow>();
      for (const input of batch) {
        const expired = await inputs.settle(input.id, { action: "cancel", by: { system: "expired" }, at: Date.now() }, "expired");
        if (expired) suspensions.set(`${expired.agent} ${expired.requestId}`, expired);
      }
      for (const input of suspensions.values()) {
        await this.resumeAnywhere(input.agent, input.tenant, [input.requestId])
          .catch(error => console.error(JSON.stringify({ type: "input_expiry_failed", agent: input.agent, error: errorText(error) })));
      }
      if (batch.length < 100) break;
    }
  }

  /**
   * An upsert's target for an existing agent: a `configure` request's parameters carrying the whole configuration
   * asked for, and its provision hash. It is queued whether or not the agent has it already (an earlier upsert may be
   * queued), so the last upsert wins; when it runs, what the agent already has is left (see `upsertChanges`). What
   * configuration cannot change (who it acts for, its definition, its mounts) is refused now; initialMessages only
   * apply when an agent is made.
   */
  private reconfiguration(header: SessionHeader, definitions: ToolDefinition[], config: Omit<AgentConfig, "id" | "directory" | "tools" | "apiKey">, metadata: AgentMetadata,
    mounts: unknown, origin: { definition: DefinitionRef } | undefined, identity: AgentIdentity | undefined, provisionHash: string, own: Pick<Sources, "builtins" | "delegate"> = {}) {
    const differs = (a: unknown, b: unknown) => canonical(a ?? null) !== canonical(b ?? null);
    const fixed = [
      ...differs(header.identity?.subject, identity?.subject) ? ["subject"] : [], ...differs(header.identity?.context, identity?.context) ? ["context"] : [],
      ...(header.definition?.id ?? null) !== (origin?.definition.id ?? null) ? ["definition"] : [],
      ...mounts !== undefined && differs((header.mounts ?? []).map(({ volumeId, path, mode }) => ({ volumeId, path, mode })), (mounts as { volumeId: string; path: string; mode?: string }[]).map(({ volumeId, path, mode }) => ({ volumeId, path, mode: mode ?? "rw" }))) ? ["mounts"] : [],
    ];
    if (fixed.length) throw new HttpError(409, `An existing agent's ${fixed.join(", ")} cannot change; delete it (DELETE /v1/agents/${header.id}) or use another idempotency key`);
    return {
      provisionHash, model: `${config.model.provider}/${config.model.id}`, thinkingLevel: config.thinkingLevel ?? "off",
      systemPromptAppend: config.systemPromptAppend ?? "", fileTools: config.fileTools !== false, runLimits: config.runLimits ?? null, name: metadata.name ?? null, type: metadata.type ?? null,
      // Only a definition's own fields are the agent's: the rest follow its definition.
      ...origin ? {} : { systemPrompt: config.systemPrompt ?? null, modelHeaders: config.modelHeaders ?? null, tools: definitions, builtins: own.builtins ?? [], delegate: own.delegate ?? null },
    };
  }

  /** Of an upsert's target, the fields the agent does not have already. */
  private upsertChanges(header: SessionHeader, target: Record<string, any>) {
    const differs = (a: unknown, b: unknown) => canonical(a ?? null) !== canonical(b ?? null);
    const current = header.config;
    const changes: Record<string, unknown> = {};
    if (target.model !== undefined && target.model !== `${current.model.provider}/${current.model.id}`) changes.model = target.model;
    if (target.thinkingLevel !== undefined && target.thinkingLevel !== (current.thinkingLevel ?? "off")) changes.thinkingLevel = target.thinkingLevel;
    if (target.systemPromptAppend !== undefined && target.systemPromptAppend !== (current.systemPromptAppend ?? "")) changes.systemPromptAppend = target.systemPromptAppend;
    if (target.fileTools !== undefined && target.fileTools !== (current.fileTools !== false)) changes.fileTools = target.fileTools;
    if ("systemPrompt" in target && differs(current.systemPrompt, target.systemPrompt)) changes.systemPrompt = target.systemPrompt;
    if ("modelHeaders" in target && differs(current.modelHeaders, target.modelHeaders)) changes.modelHeaders = target.modelHeaders;
    if ("runLimits" in target && differs(current.runLimits, target.runLimits)) changes.runLimits = target.runLimits;
    if (target.tools !== undefined && differs(header.definitions, target.tools)) changes.tools = target.tools;
    if (target.builtins !== undefined && differs(header.sources?.builtins ?? [], target.builtins)) changes.builtins = target.builtins;
    if (target.delegate !== undefined && differs(header.sources?.delegate, target.delegate)) changes.delegate = target.delegate;
    return changes;
  }

  /** The id of the agent `create` makes for a tenant's idempotency key. */
  agentId(tenant: string, key: string) {
    return `client_${hash(`${tenant}:${key}`).slice(0, 40)}`;
  }

  /**
   * Provision an agent, idempotently per `key`. An agent made from a definition records it
   * (`origin.definition`), and `origin.provision` stands for its configuration in the
   * idempotency check, so a retry after the definition changed returns the same agent.
   */
  async create(definitions: ToolDefinition[], config: Omit<AgentConfig, "id" | "directory" | "tools">, given: string | undefined, metadata: AgentMetadata = {}, tenant: string, ttlMs?: number | null, mounts?: unknown, origin?: { definition: DefinitionRef; provision: unknown; overrides?: string[]; sources?: Sources }, identity?: AgentIdentity, access: { keyScope?: string; spendLimit?: number; toolsHash?: string; builtins?: string[]; delegate?: DelegateSettings; parent?: SessionHeader["parent"]; fork?: { id: string; from: ForkedFrom; records: TranscriptRecord[] } } = {}, steps = new Steps()): Promise<{ id: string; token: string; expiresAt: number | null; [status: string]: unknown }> {
    metadata = agentMetadata(metadata);
    validateDefinitions(definitions);
    // The caller's key, shown in listings; an agent made without one gets a key nothing else knows.
    const key = given ?? randomUUID();
    if (!validId(key)) throw new HttpError(400, "Invalid provisioning idempotency key");
    const { id, token, existing } = await steps.time("lookup", this.keyed(tenant, key));
    // A fork's volume was made for the id its key had a moment ago: another generation now (it was deleted meanwhile) is a retry.
    if (access.fork && access.fork.id !== id) throw new HttpError(503, "The fork's key changed agents while it was made; retry");
    const { apiKey: _key, ...safeConfig } = config;
    const own = { ...(access.builtins?.length ? { builtins: access.builtins } : {}), ...(access.delegate ? { delegate: access.delegate } : {}) };
    const provisionHash = hash(canonical({ ...origin ? { definition: origin.provision } : { definitions, config: safeConfig, ...(Object.keys(metadata).length ? { metadata } : {}), ...(mounts !== undefined ? { mounts } : {}), ...own }, ...(identity ? { identity } : {}) }));
    // The same key for an existing agent updates it: create or reconfigure (the last upsert wins).
    const changes = (header: SessionHeader) => ({ reconfigure: { ...this.reconfiguration(header, definitions, safeConfig, metadata, mounts, origin, identity, provisionHash, own), ...(access.toolsHash ? { toolsHash: access.toolsHash } : {}) } });
    // An agent's own sources are its builtins (and their settings); one made from a definition has the definition's.
    const sources: Sources | undefined = origin ? origin.sources : own.builtins ? own : undefined;
    if (existing) {
      if (existing.value.tenant !== tenant) throw new HttpError(409, "Idempotency key belongs to another tenant");
      const changed = changes(existing.value);
      if (await steps.time("route", this.ownerElsewhere(id))) return { id, token, expiresAt: existing.value.expiresAt, running: true, ...changed };
    }
    // A key with no agent a moment ago needs no second read: unless a create here is making it, this one does.
    let session = existing || this.sessions.has(id) || this.loading.has(id) ? await steps.time("load", this.load(id)) : undefined;
    // Another create of this agent on this node is provisioning it: wait for what it makes. Two at once
    // would each take the claim, and the second acquire's new epoch would fence the first out.
    while (!session && this.loading.has(id)) session = await steps.time("load", this.load(id));
    let created = false;
    let changed = {};
    if (session) {
      if (session.header.tenant !== tenant) throw new HttpError(409, "Idempotency key belongs to another tenant");
      if (session.header.revoked || expired(session.header.expiresAt)) throw new HttpError(410, "Session expired or revoked");
      changed = changes(session.header);
    } else {
      // Loads and creates of this agent here wait for this one (see `load`).
      const provisioned = Promise.withResolvers<Session | undefined>();
      this.loading.set(id, provisioned.promise);
      const settle = (made?: Session) => {
        provisioned.resolve(made);
        if (this.loading.get(id) === provisioned.promise) this.loading.delete(id);
      };
      let claim: Claim | undefined;
      try {
        // Capacity is reserved before anything is persisted: an agent refused for it leaves nothing behind.
        await steps.time("room", this.makeRoom(id, tenant));
        const granted = this.options.volumes ? await steps.time("mounts", this.options.volumes.mountsFor(tenant, id, mounts)) : undefined;
        const ownership = this.options.ownership;
        if (ownership) {
          const acquired = await steps.time("claim", ownership.acquire(id));
          if ("owner" in acquired) throw new NotOwner(acquired.owner);
          claim = acquired.claim;
        }
        session = {
          header: { version: 3, id, tenant, digest: hash(token), expiresAt: ttlMs === null ? null : Date.now() + (ttlMs ?? this.options.ttlMs ?? 24 * 60 * 60 * 1000), revoked: false, metadata, definitions, config: safeConfig, provisionHash, ...(granted ? { mounts: granted } : {}), ...(origin ? { definition: origin.definition } : {}), ...(sources ? { sources } : {}), ...(origin?.overrides?.length ? { overrides: origin.overrides } : {}), ...(identity ? { identity } : {}), ...(access.keyScope ? { keyScope: access.keyScope } : {}), ...(access.toolsHash ? { toolsHash: access.toolsHash } : {}), ...(given !== undefined ? { key: given } : {}), ...(access.fork ? { forkedFrom: access.fork.from } : {}), ...(access.parent ? { parent: access.parent } : {}) },
          claim, requests: new Map(), running: new Map(), log: this.storage.log<JournalRecord>(this.journalKey(id), claim),
          cursor: Date.now() * 1000, events: [], eventBytes: 0, watchers: new Set(), polls: new Set(), inflight: 0, runs: Promise.resolve(), resuming: new Set(), settling: 0, lastActive: Date.now(),
        };
        // FileRefs its initial messages or a fork's history carry are its own now: their chunks are pinned to it before it
        // exists, so there is never an agent without them (a pin left by a create that failed only keeps chunks stored).
        const refs = [...safeConfig.initialMessages ?? [], ...access.fork ? recordedMessages(access.fork.records) : []].flatMap(message => Array.isArray((message as { content?: unknown }).content) ? (message as { content: unknown[] }).content.filter(validFileRef) : []);
        if (refs.length && this.options.volumes) await this.options.volumes.pin(tenant, id, refs.flatMap(ref => ref.chunks));
        // A fork's history is its transcript before it exists, written under its claim.
        if (access.fork) await steps.time("history", this.supervisor.seed(id, access.fork.records, claim));
        // A conditional create: if a concurrent request made this agent first, retry as a load. A new agent's history is
        // indexed from its first message (a fork's copy, too, once it starts: until then a page reads its log); beginning
        // its index is idempotent, so it goes alongside.
        const seeded = access.fork?.from.atMessage == null ? 0 : access.fork.from.atMessage + 1;
        await Promise.all([steps.time("header", this.writeHeader(session)), steps.time("index", this.historyIndex.begin(id, seeded))]);
        this.sessions.set(id, session);
        created = true;
        settle(session);
        await Promise.all([
          granted && steps.time("watch", this.options.volumes!.watch(id, tenant, [], granted, claim)),
          access.spendLimit !== undefined && steps.time("spend", this.setSpendLimit(session, access.spendLimit)),
        ]);
      } catch (error) {
        settle();
        if (!created) {
          this.supervisor.unreserve(id);
          if (claim) await this.options.ownership!.release(claim).catch(() => {});
          if (session?.fault?.message.includes("moved")) return this.create(definitions, config, key, metadata, tenant, ttlMs, mounts, origin, identity, access, steps);
          throw error;
        }
        await this.discard(session!);
        throw error;
      }
    }
    // Creating records the agent: its host starts in the background, so the response does not wait on listing its tool
    // servers, and a prompt sent meanwhile waits on the same start. A start that fails is only logged: the agent exists,
    // and its next request starts it again, answering with the error if it recurs.
    if (created) void this.ensureStarted(session).catch(error => {
      if (!session.header.revoked) console.error(JSON.stringify({ type: "agent_start_failed", agent: id, tenant, error: safeError(error) }));
    });
    return { id, token, expiresAt: session.header.expiresAt, ...changed };
  }

  /**
   * An agent's token: derived from its tenant and key (with the key's generation) until it is rotated, then from its
   * id and how many times it was, so rotating makes a new one even for an agent made without a key.
   */
  private agentToken(tenant: string, scoped: string, id: string, rotation = 0) {
    return createHmac("sha256", this.options.secret).update(rotation ? `client-rotated:${tenant}:${id}:${rotation}` : `client-v2:${tenant}:${scoped}`).digest("hex");
  }

  /**
   * A new token for a tenant's agent: the old one stops working at once, here and on every node (they check the header
   * this writes), and connections made with it (the application's, event streams) are closed. Applications reconnect
   * with the new one, which `credentials` gives from now on.
   */
  async rotateToken(id: string, tenant: string): Promise<{ id: string; token: string; expiresAt: number | null }> {
    const session = (await this.owns(id, tenant)) ? await this.load(id) : undefined;
    if (!session || session.header.tenant !== tenant) throw new HttpError(404, "Unknown agent");
    const rotation = (session.header.tokenRotation ?? 0) + 1;
    const token = this.agentToken(tenant, "", id, rotation);
    session.header.tokenRotation = rotation;
    session.header.digest = hash(token);
    await this.writeHeader(session);
    this.retire(session);
    this.endStreams(session);
    console.log(JSON.stringify({ type: "agent_token_rotated", agent: id, tenant, rotation }));
    return { id, token, expiresAt: session.header.expiresAt };
  }

  /**
   * The agent a tenant's key names now: its id and token, and its stored header unless this node holds it. A key whose
   * agent was deleted or expired names a fresh one: the next generation of the key, with an id and token of its own, so
   * the old agent's id is never reused and its token never works again.
   */
  private async keyed(tenant: string, key: string): Promise<{ id: string; token: string; existing?: { value: SessionHeader } }> {
    for (let generation = 0; ; generation++) {
      // Idempotency keys are per tenant.
      const scoped = `${key}${generation ? `#${generation}` : ""}`;
      const id = this.agentId(tenant, scoped);
      // A deleted or expired agent (a tombstone once purged) is never loaded again; one another node serves only needs its header.
      const existing = this.sessions.has(id) ? undefined : await this.readHeader(id);
      const header = this.sessions.get(id)?.header ?? existing?.value;
      if (!header || !(header.revoked || expired(header.expiresAt))) return { id, token: this.agentToken(tenant, scoped, id, header?.tokenRotation), existing };
    }
  }

  /**
   * A new agent with `source`'s configuration and a copy of its history and workspace (POST /v1/agents/:id/fork), on
   * the node serving `source`. Its history is the source's transcript as its log holds it (every record a turn
   * committed, wherever the source runs) up to the fork point (see `forkCut`): records of its own, sharing nothing
   * mutable with the source, whose FileRefs are pinned to it. Its workspace volume is a fork of the source's, as it is
   * now; other mounts are the same volumes. Not copied: schedules, channels, inputs, requests and spend so far. Who it
   * acts for (`identity`), its prompt addition and its model headers may be its own. With a key, a retry returns the same fork; a key naming
   * another agent is refused.
   */
  async fork(sourceId: string, tenant: string, input: { key?: string; name?: string; atMessage?: number | string; ttlMs?: number | null; identity?: AgentIdentity; systemPromptAppend?: string; modelHeaders?: Record<string, string> | null }, steps = new Steps()) {
    const source = this.sessions.get(sourceId)?.header ?? (await this.readHeader(sourceId))?.value;
    if (!source || source.tenant !== tenant || source.revoked || source.purged || expired(source.expiresAt)) throw new HttpError(404, "Unknown agent");
    const key = input.key ?? randomUUID();
    if (!validId(key)) throw new HttpError(400, "Invalid fork key");
    const made = await steps.time("lookup", this.keyed(tenant, key));
    const found = this.sessions.get(made.id)?.header ?? made.existing?.value;
    const answer = (header: SessionHeader) => {
      if (header.tenant !== tenant || header.forkedFrom?.agentId !== sourceId) throw new HttpError(409, "This key names another agent, not a fork of this one; use another key");
      return { id: header.id, token: made.token, expiresAt: header.expiresAt, forkedFrom: header.forkedFrom };
    };
    if (found) return answer(found);
    let records = await steps.time("history", this.supervisor.records(sourceId));
    // History given at create is imported when the agent first starts: one that has not yet holds it in its configuration.
    if (!records.length && source.config.initialMessages?.length) records = [{ t: "reset", ...importedHistory(source.config.initialMessages) }];
    const cut = forkCut(records, input.atMessage);
    const from: ForkedFrom = { agentId: sourceId, atMessage: cut.through };
    // The source's own workspace is forked for the fork, under the id its workspace has; shared volumes stay shared.
    let mounts: Mount[] | undefined = source.mounts;
    const workspace = VolumeService.workspaceOf(sourceId);
    if (this.options.volumes && mounts?.some(mount => mount.volumeId === workspace)) {
      const into = VolumeService.workspaceOf(made.id);
      await steps.time("volume", this.options.volumes.call(workspace, tenant, "fork", { name: "workspace", into }));
      mounts = mounts.map(mount => mount.volumeId === workspace ? { ...mount, volumeId: into } : mount);
    }
    const spend = (await this.db.query("select usd from agent_spend_limits where agent = $1", [sourceId])).rows[0];
    const { initialMessages: _initial, ...config } = {
      ...source.config, ...(input.systemPromptAppend !== undefined ? { systemPromptAppend: input.systemPromptAppend } : {}),
      ...(input.modelHeaders !== undefined ? { modelHeaders: input.modelHeaders ?? undefined } : {}),
    };
    const identity = input.identity ? { ...source.identity, ...input.identity } : source.identity;
    const name = input.name ?? (source.metadata?.name && `${source.metadata.name} (fork)`.slice(0, 120));
    const created = await this.create(source.definitions, config as Omit<AgentConfig, "id" | "directory" | "tools">, key, { ...source.metadata, ...(name ? { name } : {}) }, tenant, input.ttlMs, mounts,
      source.definition && { definition: source.definition, provision: { fork: source.provisionHash }, overrides: source.overrides, sources: source.sources }, identity,
      { keyScope: source.keyScope, ...(spend ? { spendLimit: Number(spend.usd) } : {}), toolsHash: source.toolsHash, ...source.definition ? {} : { builtins: source.sources?.builtins, delegate: source.sources?.delegate }, fork: { id: made.id, from, records: cut.records } }, steps);
    // Made meanwhile by a retry: whatever it holds is the fork.
    if (created.reconfigure) return answer(this.sessions.get(created.id)?.header ?? (await this.readHeader(created.id))!.value);
    return { id: created.id, token: created.token, expiresAt: created.expiresAt, forkedFrom: from };
  }

  /**
   * Undo a create whose agent never started: its header, tail rows and whatever
   * starting wrote go, and its claim is released. Best effort; what is left is an
   * agent a retry with the same key loads and starts.
   */
  private async discard(session: Session) {
    const id = session.header.id;
    this.supervisor.unreserve(id);
    try {
      await this.supervisor.stop(id);
      if (this.sessions.get(id) === session) this.sessions.delete(id);
      await session.log.close();
      // Under the claim, so a retry that took the agent on another node keeps what it wrote.
      const deleted = await underClaim(this.db, session.claim, async sql => {
        const { rowCount } = await sql.query("delete from agents where id = $1 and revision = $2 and not revoked", [id, session.revision]);
        if (rowCount) await this.purgeData(id, sql);
        return !!rowCount;
      });
      if (deleted && session.header.mounts?.length) await this.options.volumes?.watch(id, session.header.tenant, session.header.mounts, [], session.claim);
    } catch (error) {
      console.error(JSON.stringify({ type: "agent_discard_failed", agent: id, error: errorText(error) }));
    } finally {
      if (session.claim) await this.options.ownership!.release(session.claim).catch(() => {});
    }
  }

  /** Delete everything an agent stored: its journal, its transcript (and local directory), and their tail rows. */
  private async purgeData(id: string, sql: Sql) {
    await this.storage.removeLog(this.journalKey(id));
    await this.supervisor.purge(id);
    await this.historyIndex.remove(id, sql);
    await deleteTail(sql, id, [this.journalKey(id), AgentSupervisor.transcriptKey(id)]);
  }

  /** A tenant's live agents. `running` covers agents served by any node. */
  async list(tenant: string) {
    const { rows } = await this.db.query(`
      select a.id, a.header->>'key' as key, a.name, a.type, a.model, a.expires_at, a.resume_failures, a.resume_after, a.header->'parent'->>'agentId' as parent, n.node is not null as served from agents a
      left join actor_owners o on o.actor = a.id
      left join runtime_nodes n on n.node = o.node and n.session = o.session and n.expires_at > now()
      where a.tenant = $1 and not a.revoked and (a.expires_at is null or a.expires_at > $2) order by a.id`, [tenant, Date.now()]);
    return rows.map(row => {
      const local = this.sessions.get(row.id);
      const response = local?.response;
      const running = this.supervisor.agents.has(row.id) || (!local && row.served);
      return { id: row.id as string, key: row.key as string | null, name: row.name as string, type: row.type as string, model: row.model as string, connected: !!response && !response.destroyed, running: running as boolean, expiresAt: row.expires_at as number | null,
        resume: row.resume_failures ? { failures: row.resume_failures as number, after: Number(row.resume_after) } : null, ...(row.parent ? { parentAgentId: row.parent as string } : {}) };
    });
  }

  /** Whether `id` is one of `tenant`'s live agents (one read, not a listing). */
  async owns(id: string, tenant: string) {
    if (!validSessionId(id)) return false;
    const { rowCount } = await this.db.query("select 1 from agents where id = $1 and tenant = $2 and not revoked and (expires_at is null or expires_at > $3)", [id, tenant, Date.now()]);
    return !!rowCount;
  }

  /**
   * An existing agent's credentials, by its id or the key it was made with, without touching its configuration (an
   * upsert would set it to what the caller passes). The token is the one `create` gave: derived from the key and its
   * generation, so only an agent made with a key has one to give again; or, once rotated (`rotateToken`), the latest.
   */
  async credentials(tenant: string, ref: string): Promise<{ id: string; token: string; expiresAt: number | null }> {
    // By id alone: a purged agent's tombstone keeps only its id, and still holds its key's generation.
    const live = async (id: string) => (await this.db.query("select tenant, header->>'key' as key, (header->>'tokenRotation')::int as rotation, expires_at, revoked from agents where id = $1", [id])).rows[0] as { tenant: string | null; key: string | null; rotation: number | null; expires_at: number | null; revoked: boolean } | undefined;
    const alive = (row: { tenant: string | null; expires_at: number | null; revoked: boolean }) => row.tenant === tenant && !row.revoked && !expired(row.expires_at === null ? null : Number(row.expires_at));
    const found = (id: string, scoped: string, row: { rotation: number | null; expires_at: number | null }) =>
      ({ id, token: this.agentToken(tenant, scoped, id, row.rotation ?? 0), expiresAt: row.expires_at === null ? null : Number(row.expires_at) });
    if (validSessionId(ref)) {
      const row = await live(ref);
      if (row && alive(row)) {
        if (row.rotation) return found(ref, "", row);
        if (!row.key) throw new HttpError(409, "AGENT_KEYLESS: this agent was made without a key, so its token is only what its create answered");
        // Its generation: the key's agents before it were deleted or expired.
        for (let generation = 0; generation < 10_000; generation++) {
          const scoped = `${row.key}${generation ? `#${generation}` : ""}`;
          if (this.agentId(tenant, scoped) === ref) return found(ref, scoped, row);
        }
      }
    }
    if (validId(ref)) {
      for (let generation = 0; ; generation++) {
        const scoped = `${ref}${generation ? `#${generation}` : ""}`, id = this.agentId(tenant, scoped);
        const row = await live(id);
        if (!row) break;
        if (alive(row)) return found(id, scoped, row);
      }
    }
    throw new HttpError(404, "No agent has this id or key");
  }

  async inspect(id: string, tenant: string) {
    const metadata = (await this.owns(id, tenant)) ? (await this.list(tenant)).find(agent => agent.id === id) : undefined;
    const session = metadata && await this.load(id);
    if (!metadata || !session) throw new HttpError(404, "Agent not found");
    const definition = session.header.definition && { id: session.header.definition.id, revision: session.header.definition.revision };
    return { ...metadata, ...(definition ? { definition } : {}), tools: session.header.definitions, systemPrompt: session.header.config.systemPrompt ?? "",
      ...(session.header.config.systemPromptAppend ? { systemPromptAppend: session.header.config.systemPromptAppend } : {}),
      ...(session.header.config.fileTools === false ? { fileTools: false } : {}), mounts: session.header.mounts ?? [], keyScope: session.header.keyScope ?? null, modelHeaders: session.header.config.modelHeaders ?? null,
      builtins: session.header.sources?.builtins ?? [], delegate: session.header.sources?.delegate ?? null,
      ...(session.header.parent ? { parentAgentId: session.header.parent.agentId, parentRunId: session.header.parent.runId } : {}),
      spendLimit: await this.spendOf(session).then(spend => spend && { usd: spend.usd, spent: spend.spent }), runLimits: session.header.config.runLimits ?? null,
      ...(session.header.forkedFrom ? { forkedFrom: session.header.forkedFrom } : {}),
      cursor: session.cursor, events: session.events.map(({ id, data }) => ({ id, data })), requests: [...session.requests.values()].map(visible) };
  }

  /**
   * One of a tenant's agent's requests (`GET /v1/agents/:id/requests/:requestId`). With `wait` (seconds, at most 25)
   * and the request still running, it answers once it settles or the wait ends, woken as the events poll is.
   */
  async requestFor(c: Context, id: string, tenant: string, requestId: string) {
    const session = (await this.owns(id, tenant)) ? await this.load(id) : undefined;
    if (!session) throw new HttpError(404, "Agent not found");
    return this.settled(c as Context<ClientEnv>, session, requestId);
  }

  /** A request as its record says, waiting first (`?wait=<seconds>`, at most 25) while it runs. */
  private async settled(c: Context<ClientEnv>, session: Session, requestId: string) {
    const wait = Number(c.req.query("wait") ?? 0);
    if (!Number.isFinite(wait) || wait < 0) throw new HttpError(400, "wait is a number of seconds");
    const until = Date.now() + Math.min(wait * 1000, MAX_POLL_WAIT_MS);
    for (;;) {
      const record = session.requests.get(requestId);
      if (!record) throw new HttpError(404, "Unknown request");
      // Settled, out of time, or the session is no longer here to wake it: as it is now (the caller asks again).
      if (record.state === "completed" || Date.now() >= until || this.closed || session.fault || this.sessions.get(session.header.id) !== session || gone(c)) return json(c, 200, visible(record));
      // A waiting request holds a subscriber's place, as a waiting events poll does.
      const release = this.hold(session.header.tenant, session.watchers.size + session.polls.size);
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); session.polls.delete(done); c.env.outgoing.off("close", done); release(); resolve(); };
        const timer = setTimeout(done, until - Date.now());
        session.polls.add(done);
        c.env.outgoing.once("close", done);
      });
    }
  }

  /**
   * A tenant's watcher on one of its agents' event streams (or, with `?poll=1`, one poll of it):
   * what `/clients/:id/events?watch=1` gives a holder of the agent's token, for a server that keeps
   * no per-agent tokens. `c.env.outgoing` is the raw response the stream is written to.
   */
  async watchFor(c: Context, id: string, tenant: string, reader?: StreamReader) {
    const header = (await this.owns(id, tenant)) ? this.sessions.get(id)?.header ?? (await this.readHeader(id))?.value : undefined;
    if (!header || header.purged) throw new HttpError(404, "Unknown agent");
    return this.watchAgent(c as Context<ClientEnv>, header, c.req.query("poll") === "1" ? "poll" : "watch", reader);
  }

  /**
   * An agent as its MCP endpoint (agent-mcp.ts) shows it, while it lives: its tenant, what it is called and the
   * definition it is made from, and whether `authorization` carries its own token, as its `/clients/:id` routes check.
   * Read without loading it.
   */
  async mcpView(id: string, authorization: string) {
    const header = this.sessions.get(id)?.header ?? (await this.readHeader(id))?.value;
    if (!header || header.revoked || header.purged || expired(header.expiresAt)) return undefined;
    const own = authorization.startsWith("Bearer ") && timingSafeEqual(Buffer.from(hash(authorization.slice(7)), "hex"), Buffer.from(header.digest, "hex"));
    return { tenant: header.tenant, own, name: header.metadata?.name ?? header.key, definition: header.definition?.id };
  }

  /** A tenant's view of one agent's request state and stream cursor (`/clients/:id/state`). */
  async stateFor(id: string, tenant: string) {
    if (!await this.owns(id, tenant)) throw new HttpError(404, "Unknown agent");
    if (this.unloaded(id)) {
      // Its cursor is where a stream of it picks up (see `idleCursor`); undefined: a node has just taken it.
      const cursor = await this.idleCursor(id);
      if (cursor !== undefined && this.unloaded(id)) return { cursor, requests: await this.storedRequests(id), ...await this.resumeState(id) };
    }
    const session = await this.load(id);
    if (!session) throw new HttpError(404, "Unknown agent");
    return { cursor: session.cursor, requests: [...session.requests.values()].map(visible) };
  }

  /** A tenant's view of one agent's history; undefined when the agent is not theirs. */
  async agentHistory(id: string, tenant: string) {
    if (!await this.owns(id, tenant)) return undefined;
    // An agent no node has loaded is read from storage, not loaded for it (see `unloaded`).
    if (this.unloaded(id)) return { messages: await this.supervisor.history(id) };
    const session = await this.load(id);
    return session && this.history(session);
  }

  /**
   * Whether this node neither holds nor is loading an agent: then, with no owner elsewhere (whose
   * requests the server forwards there), it runs nowhere, and reads of it come from storage. A tab
   * opening, or a watcher recovering from a gap, then costs no load, and ends no other node's watchers.
   */
  private unloaded(id: string) { return !this.sessions.has(id) && !this.loading.has(id); }

  /**
   * Whether an agent has work no node is doing: runs open (`pending_runs`, marked as its first opens and
   * cleared by an unload with none) and no live owner, as a node that died or drained leaves them.
   * Only a load resumes them: an acting request's (a prompt, an application connecting), or a sweep's.
   */
  private async workLeft(id: string) {
    const { rows } = await this.db.query(`
      select a.tenant from agents a where a.id = $1 and a.pending_runs and not exists (
        select from actor_owners o join runtime_nodes n on n.node = o.node and n.session = o.session and n.expires_at > now() where o.actor = a.id)`, [id]);
    return rows[0]?.tenant as string | undefined;
  }

  /**
   * An acting request loads an unloaded agent, which resumes its open work; without room here for that
   * work, it is asked to retry (to reach a node with room) rather than loaded here only to be handed back.
   */
  private async roomFor(id: string) {
    if (!this.options.ownership || !this.unloaded(id)) return;
    const tenant = await this.workLeft(id);
    if (tenant && !await this.canReserve(tenant)) throw new HttpError(503, "No room on this node for this agent's unfinished work; retry");
  }

  /**
   * A sweep's load of an agent with work left failed: the next is put off by the sweep's interval, doubling,
   * at most an hour, never for good. A window counts once, however many nodes met it; a run of the work
   * that begins starts the count over.
   */
  private async deferResume(id: string, error: unknown) {
    const now = Date.now();
    const { rows } = await this.db.query(`update agents set resume_failures = resume_failures + 1,
        resume_after = $2 + least($3 * power(2, least(resume_failures, 30))::bigint, $4)
      where id = $1 and (resume_after is null or resume_after <= $2) returning resume_failures`,
      [id, now, this.sweepMs, MAX_RESUME_DELAY_MS]).catch(() => ({ rows: [] as { resume_failures: number }[] }));
    if (rows[0]) console.error(JSON.stringify({ type: "agent_resume_failed", agent: id, failures: rows[0].resume_failures, error: safeError(error) }));
  }
  private get sweepMs() { return this.options.orphanSweepMs || 30_000; }

  /**
   * Give an agent back that this node took over but has no room to run (it had room when it loaded it,
   * and lost it since): its runs stay open, and sweeps leave it for an interval, to a node with room.
   */
  private async handBack(session: Session) {
    if (session.handedBack) return;
    session.handedBack = true;
    this.idleWatchers(session);
    session.response?.end();
    await this.db.query("update agents set resume_after = $2 where id = $1", [session.header.id, Date.now() + this.sweepMs]).catch(() => {});
    await this.unload(session);
  }

  /**
   * Load agents with work left (see `workLeft`), as many as this node has room for, so their runs resume
   * even when no one acts on them. Every node sweeps; taking ownership decides which loads each.
   */
  async resumeOrphans(limit = 10) {
    if (this.closed || this.draining || this.supervisor.full) return 0;
    const { rows } = await this.db.query(`
      select a.id, a.tenant from agents a
      where a.pending_runs and not a.revoked and a.purged_at is null and (a.expires_at is null or a.expires_at > $1)
        and (a.resume_after is null or a.resume_after <= $1)
        and not exists (select from actor_owners o join runtime_nodes n on n.node = o.node and n.session = o.session and n.expires_at > now() where o.actor = a.id)
      order by random() limit $2`, [Date.now(), limit]);
    let loaded = 0;
    for (const { id, tenant } of rows) {
      if (this.sessions.has(id) || this.loading.has(id) || !await this.canReserve(tenant)) continue;
      try { if (await this.load(id)) loaded++; }
      catch (error) { if (!(error instanceof NotOwner)) await this.deferResume(id, error); }
    }
    if (loaded) console.log(JSON.stringify({ type: "agents_resumed", count: loaded }));
    return loaded;
  }

  /**
   * Sweep now (see `resumeOrphans`): for the interval's sweep, and when work was just left without an owner
   * (a node released agents with runs open, or a dead node's heartbeat was ended). One sweep at a time; one
   * asked for while another runs runs after it, so work freed meanwhile is not missed.
   */
  resumeSoon(): Promise<void> {
    if (this.resuming) { this.resumeAgain = true; return this.resuming; }
    return this.resuming = (async () => {
      try {
        do { this.resumeAgain = false; await this.resumeOrphans(); } while (this.resumeAgain && !this.closed && !this.draining);
      } catch (error) { console.error(JSON.stringify({ type: "orphan_sweep_failed", error: safeError(error) })); }
      finally { this.resuming = undefined; }
    })();
  }
  private resuming?: Promise<void>;
  private resumeAgain = false;

  /** A put-off load of an agent's work, as its state and listing show it: how many times it failed, and until when. */
  private async resumeState(id: string) {
    const row = (await this.db.query("select resume_failures, resume_after from agents where id = $1", [id])).rows[0];
    return row?.resume_failures ? { resume: { failures: row.resume_failures as number, after: Number(row.resume_after) } } : {};
  }

  /** The requests an unloaded agent's journal keeps, as its session would show them. */
  private async storedRequests(id: string) {
    const requests = new Map<string, RequestRecord>();
    for (const entry of await this.storage.log<JournalRecord>(this.journalKey(id)).read()) if (entry.t === "request") requests.set(entry.record.id, entry.record);
    return [...requests.values()].map(visible);
  }

  /** Abort the running turn of a tenant's agent. Returns false when the agent is not theirs. */
  async abortAgent(id: string, tenant: string) {
    if (!await this.owns(id, tenant)) return false;
    if (this.options.inputs) {
      const session = await this.load(id);
      if (session) await this.cancelInputs(session, "aborted");
    }
    await this.sessions.get(id)?.starting?.catch(() => {});
    const session = this.sessions.get(id);
    if (session) { this.markAborted(session); this.abortChildren(session); }
    if (this.supervisor.agents.has(id)) await this.supervisor.request(id, "abort");
    return true;
  }

  /**
   * A tenant's key for `provider` changed: stop that tenant's idle agents using it
   * so their next request starts with the new key. Busy agents keep their key
   * until their turn ends and they go idle.
   */
  async providerKeyChanged(tenant: string, provider: string) {
    for (const session of this.sessions.values()) {
      if (session.header.tenant !== tenant || session.header.config.model.provider !== provider) continue;
      if (this.supervisor.agents.has(session.header.id) && !this.busy(session)) await this.supervisor.stop(session.header.id);
    }
  }

  /**
   * Replace a tenant's agent's mounts. Access checks use them at once; an idle agent
   * restarts so its prompt describes them (a busy one picks them up next start).
   */
  async setMounts(id: string, tenant: string, requested: unknown) {
    const session = (await this.owns(id, tenant)) ? await this.load(id) : undefined;
    if (!session) throw new HttpError(404, "Unknown agent");
    if (!this.options.volumes) throw new HttpError(404, "Volumes are not enabled on this runtime");
    const mounts = await this.options.volumes.mountsFor(tenant, id, requested ?? []);
    await this.options.volumes.watch(id, tenant, session.header.mounts ?? [], mounts, session.claim);
    session.header.mounts = mounts;
    await this.writeHeader(session);
    if (this.supervisor.agents.has(id) && !this.busy(session)) await this.supervisor.stop(id);
    return mounts;
  }

  /** Revoke a tenant's agent, stop it and unload it; the purge sweep, started now, then deletes its data. */
  async destroyAgent(id: string, tenant: string) {
    if (!await this.owns(id, tenant)) return false;
    await this.delete(id);
    return true;
  }

  private async delete(id: string) {
    await this.remove(id);
    await this.supervisor.stop(id);
    const session = this.sessions.get(id);
    if (session?.header.revoked && !session.unsettled) await this.unload(session);
    this.purgeSoon();
  }

  /**
   * A page of the agent's history (see HistoryIndex.page): settled messages from their chunks, and
   * what the running agent has not indexed yet from it.
   */
  private async historyPage(session: Session | { header: { id: string }; unloaded: true }, query: { before?: string; limit?: string }): Promise<HistoryPage> {
    const before = query.before === undefined ? undefined : Number(query.before);
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw new HttpError(400, "before is a message index");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, "limit is 1 to 500 messages");
    const id = session.header.id;
    // An agent still starting answers nothing yet: wait for it (or, should it fail, read the log).
    if (!("unloaded" in session)) await session.starting?.catch(() => {});
    let tail = !("unloaded" in session) && this.supervisor.agents.has(id) ? await this.supervisor.request(id, "historyTail") as HistoryTail | null : undefined;
    if (!tail) {
      // The index should have every message the agent's runs reported, or the running agent the rest. An index
      // behind (a stop that could not write its last chunks), none yet (an agent from before the index, until its next
      // start), a running agent keeping no backlog, or work its last owner never unloaded (a node that died: what its
      // runs reported died with it): the rest is read from its log, whole, as a full history read does. Nothing is
      // indexed here; an agent's own process indexes from where its index ends.
      const indexed = await this.historyIndex.indexed(id);
      const reported = "unloaded" in session ? await this.historyIndex.reported(id) : Math.max(0, ...[...session.requests.values()].map(record => Number((record.outcome?.result as { messages?: unknown } | undefined)?.messages) || 0));
      const orphaned = "unloaded" in session && !!(await this.db.query("select 1 from agents where id = $1 and pending_runs", [id])).rowCount;
      if (tail === null || indexed === undefined || indexed < reported || orphaned) tail = await this.supervisor.backlog(id, indexed ?? 0);
    }
    return this.historyIndex.page(id, { before, limit }, tail ?? undefined);
  }

  /** A tenant's view of a page of one agent's history. */
  async historyPageFor(id: string, tenant: string, query: { before?: string; limit?: string }) {
    if (!await this.owns(id, tenant)) throw new HttpError(404, "Unknown agent");
    if (this.unloaded(id)) return this.historyPage({ header: { id }, unloaded: true }, query);
    const session = await this.load(id);
    if (!session) throw new HttpError(404, "Unknown agent");
    return this.historyPage(session, query);
  }

  /** The transcript, from the live agent when it runs, otherwise straight from its log. */
  private async history(session: Session) {
    // An agent still starting answers nothing yet: wait for it (or, should it fail, read the log).
    await session.starting?.catch(() => {});
    if (this.supervisor.agents.has(session.header.id)) return this.supervisor.request(session.header.id, "history");
    return { messages: await this.supervisor.history(session.header.id) };
  }

  /**
   * `/clients/:id/...`, mounted before operator authentication: every route needs the
   * agent's scoped token. `operatorTenant` is set only by the authenticated operator
   * bridge, which may submit requests to that tenant's own agents without the token.
   */
  readonly app = this.routes();

  private routes() {
    const app = new Hono<ClientEnv>();
    const agent = "/clients/:id{client_[a-f0-9]{40}}";
    app.use(`${agent}/*`, async (c, next) => {
      const operator = c.env.operatorTenant;
      // Authenticate against the small header before loading the journal.
      const header = this.sessions.get(c.req.param("id")!)?.header ?? (await this.readHeader(c.req.param("id")!))?.value;
      const authorization = c.req.header("authorization") ?? "";
      // A tombstone has no token to check.
      if (header?.purged) throw new HttpError(410, "Session expired or revoked");
      if (!header || c.req.header("origin") || (operator !== undefined && header.tenant !== operator) || (operator === undefined && (!authorization.startsWith("Bearer ") || !timingSafeEqual(Buffer.from(hash(authorization.slice(7)), "hex"), Buffer.from(header.digest, "hex"))))) throw new HttpError(401, "Unauthorized");
      if (header.revoked || expired(header.expiresAt)) throw new HttpError(410, "Session expired or revoked");
      // A watcher or a poll does not load the agent (see `watchAgent`).
      if (operator === undefined && c.req.method === "GET" && c.req.path === `/clients/${header.id}/events` && (c.req.query("watch") === "1" || c.req.query("poll") === "1")) {
        return this.watchAgent(c, header, c.req.query("poll") === "1" ? "poll" : "watch");
      }
      await this.roomFor(header.id);
      const session = await this.load(header.id);
      if (!session) throw new HttpError(401, "Unauthorized");
      if (session.fault) throw session.fault;
      session.lastActive = Date.now();
      if (operator !== undefined && !(c.req.method === "POST" && c.req.path === `/clients/${header.id}/requests`)) throw new HttpError(403, "Operator bridge only accepts requests");
      c.set("session", session);
      await next();
    });
    app.post(`${agent}/metadata`, async c => {
      const session = c.var.session;
      session.header.metadata = agentMetadata(await readJson(body(c), 4096));
      await this.writeHeader(session);
      return json(c, 200, session.header.metadata);
    });
    app.delete(agent, async c => {
      await this.delete(c.var.session.header.id);
      return json(c, 200, { stopped: true });
    });
    // SSE is written straight to the socket: backpressure and replacement need the raw response.
    app.get(`${agent}/events`, c => this.subscribe(c, c.var.session, "attach"));
    app.get(`${agent}/schedules`, async c => json(c, 200, await this.scheduler().list(c.var.session.header.id)));
    app.post(`${agent}/schedules`, async c => {
      const scheduler = this.scheduler();
      const tenant = c.var.session.header.tenant;
      let input;
      try { input = scheduleInput(await readJson(body(c), 64 * 1024)); } catch (error) { throw new HttpError(400, errorText(error)); }
      try { return json(c, 201, await scheduler.create({ agent: c.var.session.header.id, tenant, ...input }, c.var.session.claim)); } catch (error) { if (error instanceof LostClaim) throw error; throw new HttpError(400, errorText(error)); }
    });
    app.delete(`${agent}/schedules/:schedule`, async c => {
      if (!await this.scheduler().remove(c.var.session.header.id, c.req.param("schedule"), c.var.session.claim)) throw new HttpError(404, "Unknown schedule");
      return json(c, 200, { deleted: true });
    });
    // With `limit` or `before`, a page of whole turns; without, the whole transcript.
    app.get(`${agent}/history`, async c => {
      const { before, limit } = c.req.query();
      return json(c, 200, before !== undefined || limit !== undefined ? await this.historyPage(c.var.session, { before, limit }) : await this.history(c.var.session));
    });
    // The agent's files by the paths it sees them at (/workspace/...), for applications holding its token.
    app.get(`${agent}/files`, async c => {
      const { path, glob, after, limit } = c.req.query();
      const session = c.var.session;
      const target = this.mounted(session, path ?? session.header.mounts?.[0]?.path ?? "/");
      const listing = await this.options.volumes!.call(target.mount.volumeId, session.header.tenant, "list", {
        path: target.path, ...(glob ? { glob } : {}), ...(after ? { after: this.mounted(session, after).path } : {}), ...(limit ? { limit: Number(limit) } : {}),
      });
      return json(c, 200, { files: listing.files.map(({ chunks: _chunks, path, ...file }: { chunks: string[]; path: string }) => ({ path: target.show(path), ...file })), ...(listing.next ? { next: target.show(listing.next) } : {}) });
    });
    const filePath = (c: Context) => `/${new URL(c.req.url).pathname.split("/files/").slice(1).join("/files/").split("/").map(decodeURIComponent).join("/")}`;
    app.get(`${agent}/files/*`, async c => {
      const session = c.var.session;
      const target = this.mounted(session, filePath(c));
      const entry = await this.options.volumes!.call(target.mount.volumeId, session.header.tenant, "stat", { path: target.path });
      if (entry.type !== "file") throw new HttpError(404, `${filePath(c)} is a directory`);
      return fileResponse(this.options.volumes!, session.header.tenant, entry, c.req.header("range"));
    });
    app.put(`${agent}/files/*`, async c => {
      const session = c.var.session;
      const target = this.mounted(session, filePath(c), true);
      const { chunks: _chunks, path, ...entry } = await this.options.volumes!.put(session.header.tenant, target.mount.volumeId, target.path, body(c) as AsyncIterable<Uint8Array>, { contentType: c.req.header("content-type") });
      return json(c, 201, { path: target.show(path), ...entry });
    });
    app.post(`${agent}/links`, async c => json(c, 201, this.signLink(c.var.session, await readJson(body(c), 4096))));
    // A file for request `:request` to attach by the path this answers with; the body streams to storage.
    app.put(`${agent}/uploads/:request/:name`, async c => json(c, 201, await this.upload(c.var.session, c.req.param("request"), c.req.param("name"), body(c) as AsyncIterable<Uint8Array>, c.req.header("content-type"))));
    app.get(`${agent}/state`, c => {
      const session = c.var.session;
      return json(c, 200, { cursor: session.cursor, requests: [...session.requests.values()].map(visible) });
    });
    app.post(`${agent}/requests`, async c => {
      const request = await readJson(body(c), FRAME_BYTES);
      // A W3C traceparent header: the run continues the caller's trace.
      const traceparent = c.req.header("traceparent");
      if (traceparent && request?.params && typeof request.params === "object" && request.params.traceparent === undefined) request.params.traceparent = traceparent;
      const { status, record } = await this.accept(c.var.session, request);
      return json(c, status, record);
    });
    app.get(`${agent}/requests/:request`, c => this.settled(c, c.var.session, c.req.param("request")));
    // The application's JSON-RPC messages to the runtime, on the connection it names.
    app.post(`${agent}/mcp`, async c => {
      // The current connection's, or a replaced one's still answering the calls it has.
      const named = c.req.header("x-agent-connection"), session = c.var.session;
      const attached = session.attached?.id === named ? session.attached : [...session.retiring ?? []].find(connection => connection.id === named);
      if (!attached?.open) throw new HttpError(409, "Not the agent's current connection; reconnect");
      const message = await readJson(body(c), FRAME_BYTES);
      for (const entry of Array.isArray(message) ? message : [message]) attached.receive(entry);
      return json(c, 202, { accepted: true });
    });
    app.get(`${agent}/inputs`, async c => json(c, 200, await this.inputsFor(c.var.session.header.id, c.var.session.header.tenant, c.req.query("state"))));
    app.post(`${agent}/inputs/:input`, async c => {
      const session = c.var.session;
      const { status, inputs, requests } = await this.answer(session.header.id, session.header.tenant, [{ id: c.req.param("input"), body: await readJson(body(c), 256 * 1024) }], "agent");
      return json(c, status, { input: inputs[0], request: requests[0] ?? null });
    });
    app.post(`${agent}/inputs`, async c => {
      const session = c.var.session;
      const { status, ...answered } = await this.answer(session.header.id, session.header.tenant, answerList(await readJson(body(c), 1024 * 1024)), "agent");
      return json(c, status, answered);
    });
    app.all(`${agent}/*`, () => { throw new HttpError(404, "Unknown client route"); });
    app.all("/clients/*", () => { throw new HttpError(401, "Unauthorized"); });
    app.onError((error, c) => {
      const status = errorStatus(error, 500);
      for (const [name, value] of Object.entries(errorHeaders(error))) c.header(name, value);
      return json(c, status, { error: errorText(error), code: errorCode(error, status), ...errorFields(error) });
    });
    return app;
  }

  private scheduler() {
    if (!this.options.scheduler) throw new HttpError(404, "Unknown client route");
    return this.options.scheduler;
  }

  /**
   * Accept an idempotent request: 200 with the existing record for a retried ID,
   * or 202 once the new record is durable and the work has started.
   */
  private async accept(session: Session, body: any, trusted = false): Promise<{ status: 200 | 202; record: RequestRecord }> {
    if (!validId(body?.id) || !REQUEST_METHODS.includes(body.method) || !body.params || typeof body.params !== "object" || Array.isArray(body.params)) throw new HttpError(400, "Invalid request");
    // Only the runtime resumes a suspension, once its inputs have settled.
    if (body.method === "resume" && (!trusted || Object.keys(body.params).length !== 1 || !validId(body.params.suspension))) throw new HttpError(400, "Answer the agent's inputs to resume its turn");
    // Applying a definition reads the tenant's definitions, so only the tenant may ask for it, not the agent's own token.
    const applying = body.method === "configure" && body.params.definition !== undefined;
    // Which keys an agent calls models with, and how much it may spend, are the tenant's to choose, never the agent's own.
    for (const key of ["keyScope", "spendLimit", "runLimits", "modelHeaders", "builtins", "delegate", ...UPSERT_KEYS]) if (body.method === "configure" && !trusted && Object.hasOwn(body.params, key)) throw new HttpError(403, `Only the tenant can change an agent's ${key}`);
    const spendLimit = body.method === "configure" && Object.hasOwn(body.params, "spendLimit") ? spendInput(body.params.spendLimit) : undefined;
    if (applying && (!trusted || !this.options.definitionFor || Object.keys(body.params).length !== 1 || typeof body.params.definition?.id !== "string")) throw new HttpError(400, "Apply a definition with PATCH /v1/definitions/<id> and apply: \"all\"");
    try {
      if (body.method === "configure" && !applying) {
        const { spendLimit: _limit, provisionHash: _hash, name: _name, type: _type, toolsHash: _tools, builtins, delegate, ...update } = body.params;
        configurationUpdate(update, this.options.modelEndpoints?.(session.header.tenant), await this.options.customProviders?.(session.header.tenant, scopeAfter(session.header, update)));
        const own = builtins !== undefined || delegate !== undefined;
        if (own && session.header.definition) throw new HttpError(400, "This agent's builtins come from its definition; change them there");
        // An upsert gives the whole of them, which `execute` checks as it applies them; a change of some is checked now.
        if (own && body.params.provisionHash === undefined) ownSources(session.header.sources, { builtins, delegate });
      }
      // Assistant and tool-result history is runtime-owned; callers may only add user input.
      if (["prompt", "steer"].includes(body.method) && body.params.message !== undefined) validateUserMessages(Array.isArray(body.params.message) ? body.params.message : [body.params.message]);
    } catch (error) { throw new HttpError(400, errorText(error)); }
    // Whether a run may go ahead with no application connected is the caller's choice now, not part of what it asks.
    // So is the trace it continues: a retry from another span of the caller's is the same request.
    const { allowDisconnected, traceparent, ...asked } = body.params;
    if (allowDisconnected !== undefined && typeof allowDisconnected !== "boolean") throw new HttpError(400, "allowDisconnected is true or false");
    body = { ...body, params: asked };
    const fingerprint = hash(canonical({ method: body.method, params: body.params }));
    const existing = () => {
      const record = session.requests.get(body.id);
      if (record && record.fingerprint !== fingerprint) throw new HttpError(409, "Request ID reused with different arguments", "IDEMPOTENCY_CONFLICT");
      return record;
    };
    // A retried ID returns the committed record, including its outcome after a lost ack.
    const retried = existing();
    if (retried) return { status: 200, record: visible(retried) };
    if (session.running.size >= MAX_OPEN_REQUESTS) throw new HttpError(429, "Too many requests queued for this agent");
    // A spend limit applies at once, ahead of queued runs, so an application can set an allowance and then prompt.
    if (spendLimit !== undefined) await this.setSpendLimit(session, spendLimit);
    const isRun = RUN_METHODS.includes(body.method);
    // Who is acting in a run is recorded apart from what the agent is asked to do.
    let actor: string | undefined;
    let { actor: rawActor, ...params } = body.params;
    if (spendLimit !== undefined) delete params.spendLimit;
    if (rawActor !== undefined && !isRun) throw new HttpError(400, "actor is only for runs (prompt, continue, execute)");
    const isMessage = ["prompt", "steer"].includes(body.method);
    if (params.from !== undefined && !isMessage) throw new HttpError(400, "from is only for messages (prompt, steer)");
    if (params.metadata !== undefined && !isMessage) throw new HttpError(400, "metadata is only for messages (prompt, steer)");
    if (params.images !== undefined) throw new HttpError(400, "Attach images as files: files: [{ name, data (base64), contentType }]");
    if (params.whileRunning !== undefined && (body.method !== "prompt" || !["queue", "steer"].includes(params.whileRunning))) throw new HttpError(400, "whileRunning is queue or steer, for a prompt");
    // A run's own budget: it only ever lowers what the run may spend, so whoever may run the agent may set it.
    if (params.spendLimit !== undefined && (!MODEL_RUNS.includes(body.method) || spendInput(params.spendLimit) === null)) throw new HttpError(400, "spendLimit is {usd}, for a model run (prompt, continue)");
    // An output schema shapes the turn a prompt starts: a steer joins one already running.
    if (params.output !== undefined && (body.method !== "prompt" || params.whileRunning === "steer")) throw new HttpError(400, "output is for a prompt that starts its own turn (not whileRunning: steer)");
    if (params.whileRunning === "queue") delete params.whileRunning;
    // A message records the request that sent it, so an application can match it to its own.
    if (isMessage) params.requestId = body.id;
    try {
      if (params.output !== undefined) params.output = outputInput(params.output);
      if (params.from !== undefined) params.from = senderInput(params.from);
      if (params.metadata !== undefined) params.metadata = metadataInput(params.metadata);
      // The sender acts, unless the application names someone else.
      actor = actorInput(rawActor) ?? (isRun ? params.from?.id : undefined);
      // A resumed turn acts for whoever the suspended one did.
      if (body.method === "resume") actor = session.requests.get(params.suspension)?.actor;
    } catch (error) { throw new HttpError(400, errorText(error)); }
    if (isRun && body.method !== "resume") await this.options.runRate?.(session.header.tenant);
    const limited = body.method === "resume" ? undefined : await this.runLimit(session, body.method);
    if (limited) throw limited;
    const trace = isRun ? await this.traceFor(session, traceparent, body.method === "resume" ? session.requests.get(params.suspension)?.trace : undefined) : undefined;
    // A run makes its agent busy: it takes one of the tenant's busy slots across the fleet (429 at the limit), held
    // until the agent has no run open. A resume continues a turn already accepted. Until the request is taken, the
    // slot is kept for it (`admitting`) even if the agent's other runs end meanwhile.
    const admitting = RUN_METHODS.includes(body.method);
    if (admitting) {
      session.admitting = (session.admitting ?? 0) + 1;
      try { await this.holdBusy(session, body.method === "resume"); }
      catch (error) { session.admitting!--; this.releaseBusy(session); throw error; }
    }
    try {
      // A run of an agent whose tools its application answers needs that application connected: refused now, rather
      // than a turn whose calls cannot run. An application reconnecting (a process restarting) has a moment to arrive.
      if (["prompt", "continue", "execute"].includes(body.method) && !allowDisconnected && session.header.definitions.length && !await this.applicationConnected(session)) {
        if (existing()) return { status: 200, record: visible(existing()!) };
        throw new HttpError(409, "APPLICATION_NOT_CONNECTED: this agent's tools are answered by its application, and none is connected. Connect it: upsert the agent with its tools in a process that stays up (TypeScript agents.upsert(key, { tools }), Python agents.upsert(key, tools=[…]); lower down, connectAgent or connect_agent), or send allowDisconnected: true (allow_disconnected=True) to run anyway");
      }
      const queued = QUEUED_METHODS.includes(body.method);
      // Status and aborts need no process; queued requests start it (if at all) when their turn comes.
      if (!queued && !["status", "abort"].includes(body.method)) await this.ensureStarted(session);
      // Concurrent retries may have waited on the same process startup.
      const raced = existing();
      if (raced) return { status: 200, record: visible(raced) };
      // Attached files are saved and referenced before the request is: its params keep references, never bytes.
      if (["prompt", "steer"].includes(body.method) && params.files !== undefined) {
        params = { ...params, files: await this.attach(session, body.id, params.files) };
        const again = existing();
        if (again) return { status: 200, record: visible(again) };
      }
      // Work is open: marked before the request is taken (a failed write takes nothing, so a retry starts afresh) and before
      // it is durable, so a node dying with it leaves it for another's sweep (see `resumeOrphans`).
      // One write per busy spell: the mark stays until an unload with nothing open clears it.
      if (queued && !session.pending) {
        await underClaim(this.db, session.claim, sql => sql.query("update agents set pending_runs = true where id = $1 and not pending_runs", [session.header.id]));
        session.pending = true;
        // A retry of the same id may have been taken while this waited.
        const again = existing();
        if (again) return { status: 200, record: visible(again) };
      }
      const record = this.upsertRequest(session, {
        startedAt: Date.now(), ...(body.method === "prompt" && typeof body.params.text === "string" ? { prompt: body.params.text } : {}),
        ...(body.method === "execute" && typeof body.params.code === "string" ? { code: body.params.code } : {}),
        id: body.id, method: body.method, fingerprint, state: "running", ...(queued ? { params } : {}), ...(actor ? { actor } : {}), ...(params.metadata ? { metadata: params.metadata } : {}),
        ...(body.method === "resume" ? { suspension: params.suspension } : {}), ...(trace ? { trace } : {}),
      });
      await this.commit(session, true);
      if (queued) this.enqueue(session, record, params);
      else void this.run(session, record, params);
      if (params.whileRunning === "steer") await this.steerTurn(session, params);
      return { status: 202, record: visible(record) };
    } finally {
      if (admitting) { session.admitting!--; this.releaseBusy(session); }
    }
  }

  /**
   * A run's place in a trace, if its tenant exports telemetry: a `resume` continues the run it resumes; another run
   * continues the caller's `traceparent` (sampled as the caller decided), or starts a trace sampled at the tenant's rate.
   */
  private async traceFor(session: Session, traceparent: unknown, continues?: RequestRecord["trace"]): Promise<RequestRecord["trace"]> {
    const settings = await this.options.tracing?.settings(session.header.tenant).catch(() => undefined);
    if (!settings) return undefined;
    if (continues) return { traceId: continues.traceId, spanId: newSpanId(), parentSpanId: continues.spanId, sampled: continues.sampled };
    const parent = parseTraceparent(traceparent);
    const traceId = parent?.traceId ?? newTraceId();
    return { traceId, spanId: newSpanId(), ...(parent ? { parentSpanId: parent.spanId } : {}), sampled: parent ? parent.sampled : sampledAt(traceId, settings.sampleRate) };
  }

  /** The spans of a run whose trace is sampled, while its tenant exports telemetry. */
  private async spansFor(session: Session, record: RequestRecord): Promise<RunSpans | undefined> {
    const tracing = this.options.tracing;
    const settings = record.trace?.sampled ? await tracing?.settings(session.header.tenant).catch(() => undefined) : undefined;
    if (!tracing || !settings || !record.trace) return undefined;
    const { tenant, id, metadata } = session.header;
    return new RunSpans({
      tenant, agent: { id, ...(metadata?.name ? { name: metadata.name } : {}) }, request: record, trace: record.trace, content: settings.content,
      model: () => session.header.config.model, toolSource: name => session.toolSources?.get(name) ?? "runtime",
      record: span => tracing.record(tenant, span),
    });
  }

  /** An event, to the spans of the run it belongs to, or of the compaction between runs it is part of. */
  private traceEvent(session: Session, requestId: string, event: any) {
    const at = Date.now();
    if (event?.background === true) {
      if (event.type === "compaction_start") session.background = this.options.tracing?.settings(session.header.tenant).then(settings => {
        if (!settings || Math.random() >= settings.sampleRate) return undefined;
        const tracing = this.options.tracing!, tenant = session.header.tenant;
        return new BackgroundSpans({ tenant, agentId: session.header.id, content: settings.content, model: () => session.header.config.model, record: span => tracing.record(tenant, span) });
      }, () => undefined);
      void session.background?.then(spans => spans?.event(event, at));
      if (event.type === "compaction_end") session.background = undefined;
      return;
    }
    const spans = session.spans;
    if (spans && (requestId === spans.requestId || requestId === "")) spans.event(event, at);
  }

  /**
   * Offer a prompt sent with `whileRunning: "steer"` to the running turn, if any. The prompt is queued
   * already: if the turn takes it (its message ends in the turn's events), it ends with that turn;
   * if not (the turn ended first, or stopped), the agent drops it and it runs as a turn of its own.
   */
  private async steerTurn(session: Session, params: Record<string, unknown>) {
    if (!session.turn) return;
    try { await this.supervisor.request(session.header.id, "steer", params); }
    catch { /* Not running after all: the queued prompt runs. */ }
  }

  /**
   * Where a request's attachments go: `uploads/<request>/<name>` in the agent's /workspace mount,
   * else its first writable one. Requests have their own directories, so names only collide within one.
   */
  private uploadTarget(session: Pick<Session, "header">, requestId: string, name: string) {
    const mounts = session.header.mounts ?? [];
    const mount = mounts.find(entry => entry.path === "/workspace" && entry.mode === "rw") ?? mounts.find(entry => entry.mode === "rw");
    if (!this.options.volumes || !mount) throw new HttpError(400, "Attaching files needs a writable mount, like the default /workspace");
    if (!validId(requestId)) throw new HttpError(400, "Invalid request id");
    return resolveMount(mounts, `${mount.path}/uploads/${requestId}/${safeName(name)}`)!;
  }

  /** Save an attachment for request `requestId` ahead of it (the SDKs upload files this way, then reference them by path). */
  async upload(session: Pick<Session, "header">, requestId: string, name: string, source: Uint8Array | AsyncIterable<Uint8Array>, contentType?: string) {
    const target = this.uploadTarget(session, requestId, name);
    const { chunks: _chunks, path, ...entry } = await this.options.volumes!.put(session.header.tenant, target.mount.volumeId, target.path, source, { contentType, by: session.header.id });
    return { path: target.show(path), ...entry };
  }

  /** A signed link to a file in the agent's mounts (`POST /clients/:id/links`, `POST /v1/agents/:id/links`): as a volume link, by the agent's path. */
  private signLink(session: Pick<Session, "header">, input: any) {
    const method = input?.method ?? "GET";
    if (method !== "GET" && method !== "PUT") throw new HttpError(400, "method must be GET or PUT");
    const target = this.mounted(session, input?.path, method === "PUT");
    if (!this.options.links) throw new HttpError(404, "Links are not enabled on this runtime");
    const contentType = input.contentType === undefined ? undefined : declaredType(input.contentType);
    if (input.contentType !== undefined && !contentType) throw new HttpError(400, "contentType must be a specific content type");
    const { tenant: _tenant, volume: _volume, path: _path, ...link } = this.options.links.sign({ tenant: session.header.tenant, volume: target.mount.volumeId, path: target.path, method, expiresIn: input.expiresIn, ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}), ...(contentType ? { contentType } : {}) });
    return { ...link, path: target.show(target.path) };
  }

  /** A tenant's signed link to a file of its agent's, as the agent would sign it (`POST /v1/agents/:id/links`). */
  async agentLink(id: string, tenant: string, input: unknown) {
    return this.signLink(await this.headerFor(id, tenant), input);
  }

  /** A path as the agent sees it, resolved to its mount (writable, for `write`). */
  private mounted(session: Pick<Session, "header">, path: unknown, write = false) {
    if (!this.options.volumes) throw new HttpError(404, "Volumes are not enabled on this runtime");
    let target;
    try { target = resolveMount(session.header.mounts ?? [], path); } catch (error) { throw new HttpError(400, errorText(error)); }
    if (!target) throw new HttpError(400, "Name a path inside one of the agent's mounts");
    if (write && target.mount.mode !== "rw") throw new HttpError(403, `${target.mount.path} is mounted read-only`);
    return target;
  }

  /** `upload` for a tenant's agent (REST API, channels). */
  async uploadFor(id: string, tenant: string, requestId: string, name: string, source: AsyncIterable<Uint8Array>, contentType?: string) {
    return this.upload(await this.headerFor(id, tenant), requestId, name, source, contentType);
  }

  /** A file in a tenant's agent's mounts, as a reference (channels' send_message). */
  async fileFor(id: string, tenant: string, path: string) {
    return this.pathRef(await this.headerFor(id, tenant), path);
  }

  /** A signed download link to a file in a tenant's agent's mounts. */
  async linkFor(id: string, tenant: string, path: string, expiresIn?: number) {
    const session = await this.headerFor(id, tenant);
    const target = this.mounted(session, path);
    if (!this.options.links) throw new HttpError(404, "Links are not enabled on this runtime");
    return this.options.links.sign({ tenant, volume: target.mount.volumeId, path: target.path, method: "GET", expiresIn });
  }

  /** What file work needs of an agent (its mounts), on any node: files are volumes, which any node reaches. */
  private async headerFor(id: string, tenant: string): Promise<Pick<Session, "header">> {
    const header = (await this.owns(id, tenant)) ? this.sessions.get(id)?.header ?? (await this.readHeader(id))?.value : undefined;
    if (!header || header.purged) throw new HttpError(404, "Unknown agent");
    return { header };
  }

  /** A file already in the agent's mounts, as a reference. */
  private async pathRef(session: Pick<Session, "header">, path: string): Promise<FileRef> {
    const volumes = this.options.volumes;
    if (!volumes) throw new HttpError(400, "Volumes are not enabled on this runtime");
    const tenant = session.header.tenant;
    let target;
    try { target = resolveMount(session.header.mounts ?? [], path); } catch (error) { throw new HttpError(400, errorText(error)); }
    if (!target) throw new HttpError(400, "Attach a file, not /");
    const entry = await volumes.call(target.mount.volumeId, tenant, "stat", { path: target.path }).catch(error => { throw (error as HttpError).status === 404 ? new HttpError(400, `${target.show(target.path)} does not exist`) : error; });
    if (entry.type !== "file") throw new HttpError(400, `${target.show(target.path)} is a directory`);
    return fileRef(volumes, tenant, session.header.id, target.mount.volumeId, target.show(entry.path), { ...entry, contentType: await volumes.contentType(tenant, entry.path, entry) });
  }

  /**
   * A message's attachments as file references: files already in the agent's mounts ({path}), and
   * small files sent inline ({name, data: base64, contentType?}), saved first.
   * Everything is checked before anything is saved.
   */
  private async attach(session: Session, requestId: string, inputs: unknown): Promise<FileRef[]> {
    if (!Array.isArray(inputs)) throw new HttpError(400, "files must be an array");
    if (inputs.length > FILE_LIMITS.attachments) throw new HttpError(400, `At most ${FILE_LIMITS.attachments} files can be attached to a message`);
    let inline = 0;
    const names = new Set<string>();
    const checked = inputs.map((input, index) => {
      if (input && typeof input === "object" && Object.keys(input).length === 1 && typeof input.path === "string") return { path: input.path as string };
      const { name, data, contentType, ...rest } = input ?? {};
      if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || Object.keys(rest).length || (name !== undefined && typeof name !== "string") || (contentType !== undefined && typeof contentType !== "string")) {
        throw new HttpError(400, "An attached file is {path} (a file in the agent's mounts) or {name, data (base64), contentType?}");
      }
      inline += Math.floor(data.length * 3 / 4);
      if (inline > FILE_LIMITS.inlineBytes) throw new HttpError(413, `Inline files are limited to ${FILE_LIMITS.inlineBytes} bytes in all; upload larger ones first and attach them by path`);
      // Two files of one name in a request become name, name-2, ...
      const base = safeName(name, `attachment-${index + 1}`);
      let unique = base;
      for (let n = 2; names.has(unique); n++) unique = base.replace(/(\.[^.]*)?$/, extension => `-${n}${extension}`);
      names.add(unique);
      return { name: unique, data, contentType: contentType as string | undefined };
    });
    const volumes = this.options.volumes;
    if (checked.length && !volumes) throw new HttpError(400, "Volumes are not enabled on this runtime");
    const tenant = session.header.tenant;
    const refs: FileRef[] = [];
    for (const input of checked) {
      if ("path" in input) refs.push(await this.pathRef(session, input.path as string));
      else {
        const target = this.uploadTarget(session, requestId, input.name);
        const saved = await volumes!.put(tenant, target.mount.volumeId, target.path, Buffer.from(input.data, "base64"), { contentType: input.contentType, by: session.header.id });
        refs.push(await fileRef(volumes!, tenant, session.header.id, target.mount.volumeId, target.show(saved.path), { ...saved, contentType: saved.contentType! }));
      }
    }
    return refs;
  }

  /** js_exec's `fs`: the file tools over the agent's mounts, durable before any effect like any other tool call. */
  private async fsCall(session: Session, op: string, args: Record<string, unknown>, signal: AbortSignal) {
    if (!this.options.volumes || !session.header.mounts?.length) throw new Error("This agent has no volumes mounted");
    if (!["readFile", "writeFile", "stat", "list", "remove"].includes(op)) throw new Error("Unknown fs call");
    await this.beforeEffect(session);
    return this.options.volumes.tool(this.toolContext(session), `fs.${op}`, args, signal);
  }

  /**
   * Credentials for one model call: for the agent's tenant's own endpoint, a token with the claims its tool
   * servers' tokens have, for the turn's actor; else its key scope's current key for the model's provider.
   */
  private async modelAuth(session: Session): Promise<Credentials> {
    const { header } = session;
    const endpoint = this.endpoint(session);
    if (endpoint && this.options.modelToken) {
      const actor = [...session.running.values()].find(record => RUN_METHODS.includes(record.method) && record.began)?.actor;
      return { identity: true, apiKey: await this.options.modelToken(endpoint.baseUrl, {
        tenant: header.tenant, agent: header.id, ...(header.definition ? { definition: header.definition.id } : {}), ...(header.identity ? { identity: header.identity } : {}), ...(actor ? { actor } : {}),
      }) };
    }
    const provider = header.config.model.provider;
    if (!this.options.scopedKey) throw new Error("This agent's model takes no per-call credentials");
    const resolved = await this.options.scopedKey(header.tenant, header.keyScope, provider);
    if (!resolved && !header.keyScope) throw new Error(`The ${provider} provider is gone: set it again with PUT /v1/providers/${provider}, or move this agent to another model`);
    if (!resolved) throw new Error(`No ${provider} API key is configured for key scope ${header.keyScope} or this tenant; set one with PUT /v1/key-scopes/${header.keyScope}/providers/${provider}`);
    const { platform, ...credentials } = resolved;
    session.platformKey = platform;
    return credentials;
  }

  /** The tenant's own endpoint the agent's model is on, if it is. */
  private endpoint(session: Session) {
    const endpoints = this.options.modelEndpoints?.(session.header.tenant);
    const { provider } = session.header.config.model;
    return endpoints && Object.hasOwn(endpoints, provider) ? endpoints[provider] : undefined;
  }

  /** A referenced file's bytes for the agent's model request, as base64 (only sizes a model can be shown). */
  private async fileData(session: Session, ref: unknown) {
    if (!validFileRef(ref) || ref.size > Math.max(FILE_LIMITS.imageBytes, FILE_LIMITS.documentBytes) || !this.options.volumes) throw new Error("Invalid file reference");
    return (await this.options.volumes.readRange(session.header.tenant, ref, 0, ref.size)).toString("base64");
  }

  /** Submit a request to a tenant's agent on the tenant's behalf (REST API and console). */
  async submit(id: string, tenant: string, body: { id: string; method: string; params: Record<string, unknown> }) {
    if (await this.owns(id, tenant)) await this.roomFor(id);
    const session = (await this.owns(id, tenant)) ? await this.load(id) : undefined;
    if (!session) throw new HttpError(404, "Unknown agent");
    if (session.fault) throw session.fault;
    session.lastActive = Date.now();
    return (await this.accept(session, body, true)).record;
  }

  private async execute(session: Session, record: RequestRecord, params: any, method: RequestMethod = record.method) {
    const id = session.header.id;
    // Managed channel prompts queue behind definition changes; a failed change must not run old tools.
    if (record.method === "prompt" && params.requiredDefinition !== undefined && params.requiredDefinition !== session.header.definition?.id) {
      throw new HttpError(409, "The server configuration has not applied to this conversation; retry after applying it");
    }
    // An agent still starting answers nothing yet: wait for it (should it fail, it is not running).
    await session.starting?.catch(() => {});
    const live = this.supervisor.agents.has(id);
    if (record.method === "status" && !live) return { running: false };
    // Aborting a suspended turn cancels its inputs: the turn is closed without the model. Its children are aborted too.
    if (record.method === "abort") { this.markAborted(session); this.abortChildren(session); await this.cancelInputs(session, "aborted"); }
    if (record.method === "abort" && !live) return { aborted: false, running: false };
    if (record.method === "configure") {
      const applied = params.definition !== undefined ? await this.definitionUpdate(session, params.definition) : undefined;
      // An upsert's own fields (see `reconfiguration`): what the agent is called, and the configuration it now matches.
      // Of its target, only what the agent does not have already is applied.
      const { provisionHash, name, type, toolsHash: declared, ...asked } = params;
      // The hash of the tools as the application declared them: given by an upsert, else of a configure's own mcp.tools.
      const toolsHash = declared ?? (asked.mcp?.tools !== undefined ? hash(JSON.stringify(asked.mcp.tools)) : undefined);
      const { builtins, delegate, ...given } = provisionHash !== undefined ? this.upsertChanges(session.header, asked) : asked;
      // The agent's own builtins and their settings (an agent from a definition has the definition's): its sources, with the tools they offer.
      const reSourced = builtins !== undefined || delegate !== undefined;
      const sources = reSourced ? ownSources(session.header.sources, { builtins, delegate }) : session.header.sources;
      const changed = provisionHash === undefined || reSourced || Object.keys(given).length > 0 || (name !== undefined && name !== (session.header.metadata?.name ?? null)) || (type !== undefined && type !== (session.header.metadata?.type ?? null));
      const { keyScope, ...update } = (applied?.update ?? configurationUpdate(given, this.options.modelEndpoints?.(session.header.tenant), await this.options.customProviders?.(session.header.tenant, scopeAfter(session.header, given)))) as ReturnType<typeof configurationUpdate> & { fileTools?: boolean };
      // A new model may belong to another provider, and a new key scope has keys of its own: the agent needs that provider's key.
      const resolved = update.model || keyScope !== undefined ? await this.apiKey(session, (update.model ?? session.header.config.model).provider, keyScope === undefined ? session.header.keyScope : keyScope ?? undefined) : undefined;
      const apiKey = resolved?.key;
      if (resolved && this.options.apiKeyFor && !apiKey) throw new Error(`No ${(update.model ?? session.header.config.model).provider} API key is configured for this tenant; set one with PUT /v1/providers/${(update.model ?? session.header.config.model).provider}/key`);
      // An agent that is not running takes its new configuration when it next starts.
      const result = !Object.keys(update).length && !keyScope && keyScope !== null && !reSourced ? { configured: true } : live ? await this.supervisor.request(id, "configure", {
        ...update, ...apiKey ? { apiKey } : {},
        // Replacing the application's tools keeps the runtime's own.
        ...update.tools || "fileTools" in update || reSourced ? { tools: await this.toolset(session, { ...update.tools ? { tools: update.tools } : {}, sources: applied ? applied.sources : sources, ..."fileTools" in update ? { fileTools: update.fileTools } : {} }) } : {},
      }) : { configured: true };
      const { tools, ...config } = update;
      if (resolved && live) session.platformKey = resolved.platform;
      if (keyScope) session.header.keyScope = keyScope; else if (keyScope === null) delete session.header.keyScope;
      if (tools !== undefined) session.header.definitions = tools;
      session.header.config = { ...session.header.config, ...config };
      if (reSourced) { if (sources) session.header.sources = sources; else delete session.header.sources; }
      if (applied) {
        session.header.definition = applied.definition;
        if (applied.sources) session.header.sources = applied.sources; else delete session.header.sources;
      } else if (session.header.definition) {
        // A model or thinking level configured directly is the agent's own from then on.
        const overrides = new Set([...session.header.overrides ?? [], ...OVERRIDES.filter(key => (update as Record<string, unknown>)[key] !== undefined)]);
        if (overrides.size) session.header.overrides = [...overrides];
      }
      if (provisionHash !== undefined) session.header.provisionHash = provisionHash;
      if (toolsHash !== undefined) session.header.toolsHash = toolsHash;
      if (name !== undefined || type !== undefined) {
        const metadata = { ...session.header.metadata, ...name !== undefined ? { name } : {}, ...type !== undefined ? { type } : {} };
        session.header.metadata = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== null)) as AgentMetadata;
      }
      await this.writeHeader(session);
      return provisionHash !== undefined ? { ...result, changed } : result;
    }
    if (record.method === "resume") params = await this.resumeParams(session, record.suspension!);
    // The run's own budget is the runtime's to keep (runSpendLimit), not the agent's.
    if (params?.spendLimit !== undefined) {
      const { spendLimit, ...rest } = params;
      (session.runLimits ??= new Map()).set(record.id, spendLimit.usd);
      params = rest;
    }
    // Aborted since it began, before the agent had it: an abort sent to the agent now would find nothing to stop.
    if (session.aborted?.delete(record.id)) throw new Error("The run was aborted");
    try {
      return await this.supervisor.request(id, method, params, RUN_METHODS.includes(record.method)
      ? event => {
          // Failed calls report zero usage; count only responses the provider completed.
          // Responses through the tenant's own endpoint count under it: `chiridion/openrouter/<model>`.
          const via = this.endpoint(session) ? `${session.header.config.model.provider}/` : "";
          const { identity, keyScope } = session.header;
          const run = { requestId: record.id, ...(record.actor ? { actor: record.actor } : {}), ...(identity ? { identity } : {}), ...(keyScope ? { keyScope } : {}) };
          if (event?.type === "message_end" && event.message?.role === "assistant" && event.message.usage && event.message.stopReason !== "error") {
            const chars = event.message.stopReason === "aborted" ? JSON.stringify(event.message.content ?? []).length : undefined;
            const usage = this.billable(session, event.message.usage, event.message.provider, event.message.model, chars);
            this.options.onUsage?.(session.header.tenant, id, { ...event.message, usage, ...run, provider: via + event.message.provider, platform: !!session.platformKey });
            this.spent(session, responseCost(usage));
            this.tally(session, record.id, usage);
          }
          if (event?.type === "compaction_usage" && event.usage) {
            this.tally(session, record.id, this.compactionUsage(session, event, run));
          }
          // A prompt steered into this turn has been taken: it ends with the turn.
          const taken = event?.type === "message_end" && event.message?.role === "user" ? event.message.requestId : undefined;
          if (taken && taken !== record.id && session.running.get(taken)?.method === "prompt") (session.steered ??= new Map()).set(taken, record.id);
          // What the turn is doing, for a hand-off's step kind: a model call, until its response's tool calls run.
          if (event?.type === "turn_start") session.step = "model";
          else if (event?.type === "tool_execution_start") session.step = "tool";
          this.publish(session, { type: "event", requestId: record.id, event });
        } : undefined);
    } finally { session.retries = undefined; }
  }

  /**
   * What a `resume` run tells its agent: each suspended call's result (an answer, or why there is
   * none), or that it runs again (`session.retries` says how), and whether to close the turn
   * without the model: every input closed by the runtime (expired, unless the definition says to
   * resume, or cancelled by an abort).
   */
  private async resumeParams(session: Session, suspension: string) {
    const inputs = this.options.inputs!;
    const rows = await inputs.forRequest(session.header.id, suspension);
    if (rows.some(row => row.state === "pending")) throw new Error("Inputs of this turn are still waiting for an answer");
    // The waits, in the trace of the run that asked.
    const asked = session.requests.get(suspension)?.trace;
    if (asked?.sampled && this.options.tracing) {
      const tracing = this.options.tracing, tenant = session.header.tenant;
      void tracing.settings(tenant).then(settings => {
        if (settings) for (const span of inputSpans(rows, { tenant, agentId: session.header.id, requestId: suspension, trace: asked, content: settings.content })) tracing.record(tenant, span);
      }, () => {});
    }
    // Inputs settled away from this node (expired, or answered in a channel) are announced here, on the agent's stream.
    for (const row of rows) if (row.state === "expired" || row.answer?.by.via === "channel") this.resolved(session, row);
    const onExpire = session.header.sources?.humanInput?.onExpire;
    const calls: { toolCallId: string; result?: unknown; retry?: true }[] = [];
    session.retries = new Map();
    for (const toolCallId of new Set(rows.map(row => row.toolCallId))) {
      const resolved = resolution(rows.filter(row => row.toolCallId === toolCallId), row => inputs.requestState(row));
      if ("retry" in resolved) { session.retries.set(toolCallId, resolved.retry); calls.push({ toolCallId, retry: true }); }
      else calls.push({ toolCallId, result: resolved.result });
    }
    const close = rows.every(row => row.answer?.by.system && !(row.answer.by.system === "expired" && onExpire === "resume"));
    return { calls, close };
  }

  /** The configuration an agent takes from its definition's current revision; tools added at creation stay. */
  private async definitionUpdate(session: Session, target?: { id: string }) {
    const current = session.header.definition;
    if (!current) throw new Error("This agent was not made from a definition");
    const id = target?.id ?? current.id;
    const resolved = await this.options.definitionFor!(session.header.tenant, id);
    // The attached server's tools stay, as does the agent's own configuration; the tools list is rebuilt with the definition's sources.
    const config = Object.fromEntries(Object.entries(resolved.config).filter(([key]) => !session.header.overrides?.includes(key))) as Partial<DefinitionConfig["config"]>;
    return { update: { ...config, tools: session.header.definitions }, definition: { id, revision: resolved.revision }, sources: resolved.sources };
  }

  /** Finish a run whose node was lost: continue its turn, or take the answer it had already reached. */
  private async resume(session: Session, record: RequestRecord): Promise<Outcome> {
    const handoff = session.handoff;
    session.handoff = undefined;
    if (handoff && "continue" in handoff) return { result: await this.execute(session, record, {}, "continue") };
    if (handoff) return { result: handoff.finished };
    // A resume whose turn never became active did nothing yet: it runs again from its inputs.
    if (record.method === "resume") return { result: await this.execute(session, record, {}) };
    return { error: "The runtime restarted during this request", uncertain: true };
  }

  /** Queue a run behind the agent's earlier runs; a busy agent never rejects work. */
  private enqueue(session: Session, record: RequestRecord, params: unknown) {
    session.runs = session.runs.then(() => this.run(session, record, params)).catch(() => {});
  }

  private async run(session: Session, record: RequestRecord, params: unknown) {
    let value: Outcome;
    let continued: Pick<RequestRecord, "handedOff" | "carried"> | undefined;
    try {
      if (QUEUED_METHODS.includes(record.method) && (this.closed || this.draining || session.fault || session.handedBack || session.requests.get(record.id)?.state !== "running")) return;
      // Decided once per run, so it has both its events or neither: an endpoint made meanwhile gets the next run's.
      if (RUN_METHODS.includes(record.method)) session.announcing = await (this.options.runEvents?.(session.header.tenant) ?? false);
      // Configuration keeps its params when it begins: the next owner replays one that was interrupted.
      if (record.method === "configure") record = this.upsertRequest(session, { ...record, began: Date.now() });
      if (RUN_METHODS.includes(record.method)) {
        // A run queued behind the one that reached the cap never begins; a resumed turn is stopped by the host.
        if (!session.resuming.has(record.id)) {
          const limited = await this.runLimit(session, record.method);
          if (limited) throw limited;
        }
        try {
          // Accepted already (here, or by a node it was taken over from): it takes its busy slot regardless of the limit.
          await this.holdBusy(session, true);
          await this.ensureStarted(session);
        } catch (error) {
          // No room here for a run this node took over: another node with room takes it (see `handBack`).
          if (this.options.ownership && session.inherited?.has(record.id) && [429, 503].includes((error as { status?: number }).status ?? 0)) { await this.handBack(session); return; }
          throw error;
        }
        if (this.draining || session.handedBack) return;
        // Work taken over runs: any put-off loads of it are over.
        if (session.inherited?.delete(record.id)) void this.db.query("update agents set resume_failures = 0, resume_after = null where id = $1 and resume_failures > 0", [session.header.id]).catch(() => {});
        // Durable before any side effect: after a crash this run is "began", never repeated.
        const { params: _params, handedOff, carried, ...rest } = session.requests.get(record.id)!;
        // A turn handed off at a step boundary goes on as it was: not a resume, and its time limit counts from its first begin.
        continued = session.resuming.has(record.id) && handedOff ? { handedOff, carried } : undefined;
        record = this.upsertRequest(session, { ...rest, began: continued && rest.began ? rest.began : Date.now(), ...(session.resuming.has(record.id) && !continued ? { resumes: (rest.resumes ?? 0) + 1 } : {}) });
        // Code has no effect outside its sandbox until it calls a tool, and every tool call
        // makes this record durable first (`beforeEffect`; the application's tools do it when
        // their call is recorded, which is appended after it). So an execution needs no commit of its
        // own here: one that crashes before a tool call is simply run again.
        if (record.method === "execute") session.beginning = {};
        else await this.commit(session, true);
        this.hook("runStarted", session, record);
        session.spans = record.trace?.sampled ? await this.spansFor(session, record) : undefined;
        if (session.announcing) {
          session.started = enqueueEvents(this.db, [this.runEvent(session, record)])
            .catch(error => console.error(JSON.stringify({ type: "run_event_failed", agent: session.header.id, error: safeError(error) })));
        }
        if (record.method !== "execute") session.turn = { requestId: record.id, messages: [], count: 0, bytes: 0 };
      }
      if (RUN_METHODS.includes(record.method)) {
        session.activeSince = Date.now();
        session.outputs = { files: new Map(), presented: [] };
        session.toolErrors = undefined;
        session.toolCalls = undefined;
        session.children = undefined;
        session.step = undefined;
        if (continued) this.takeOver(session, record, continued);
      }
      // A new message supersedes inputs still waiting: the agent closes their calls before it reads it.
      if (record.method === "prompt") await this.cancelInputs(session, "superseded");
      value = session.resuming.delete(record.id) ? await this.resume(session, record) : { result: await this.execute(session, record, params) };
      // The files the run wrote and presented, so an application can fetch them (agent.files).
      const outputs = session.outputs;
      if (RUN_METHODS.includes(record.method) && outputs && (outputs.files.size || outputs.presented.length) && value.result && typeof value.result === "object") {
        value = { result: { ...value.result, ...(outputs.files.size ? { files: [...outputs.files.values()] } : {}), ...(outputs.presented.length ? { presented: outputs.presented } : {}) } };
      }
      // Tool calls that did not complete, so a caller sees them too (the model saw each as its call's error).
      if (RUN_METHODS.includes(record.method) && session.toolErrors?.length && value.result && typeof value.result === "object") value = { result: { ...value.result, toolErrors: session.toolErrors } };
      // Every tool call the run made, so a caller sees what it did without reading history.
      if (RUN_METHODS.includes(record.method) && session.toolCalls?.length && value.result && typeof value.result === "object") value = { result: { ...value.result, toolCalls: session.toolCalls } };
      if (RUN_METHODS.includes(record.method) && session.sourceErrors?.length && value.result && typeof value.result === "object") value = { result: { ...value.result, sourceErrors: session.sourceErrors } };
      // What its model responses used on this node (a turn resumed after its node was lost counts from the resume), and what its children spent.
      if (RUN_METHODS.includes(record.method) && value.result && typeof value.result === "object") {
        const usage = session.usage?.get(record.id), children = session.childSpend?.get(record.id);
        value = { result: { ...value.result, usage: usage || children ? { ...usage ?? { responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, ...children ? { subagentCostUsd: children } : {} } : null } };
      }
      const failed = value.result as { code?: string; error?: string } | undefined;
      if (failed?.code === "model_key_missing" && this.options.modelKeyHint) value = { result: { ...failed, error: `${failed.error} ${this.options.modelKeyHint}` } };
      // A suspended turn's outcome lists what it waits on.
      if ((value.result as { stopped?: string } | undefined)?.stopped === "input_required" && this.options.inputs) {
        const inputs = (await this.options.inputs.forRequest(session.header.id, record.id)).filter(row => row.state === "pending").map(inputView);
        value = { result: { ...value.result as object, inputs } };
      }
    }
    catch (error) { value = { error: errorText(error) }; }
    if (RUN_METHODS.includes(record.method)) session.outputs = undefined;
    this.reportActive(session, false);
    session.beginning = undefined;
    // Cut off here as this node leaves (`handOffAll`): the run stays open for the next owner.
    if (this.closed || session.fault || session.leaving || session.requests.get(record.id)?.state !== "running") return;
    // Stopped at a step boundary as this node leaves: the next owner continues it.
    if (RUN_METHODS.includes(record.method) && (value.result as { handedOff?: unknown } | undefined)?.handedOff) return this.park(session, record, value.result as Record<string, unknown>);
    const { params: _params, ...finished } = record;
    // Until the response is published, a drain or release must not close the stream and drop it.
    session.settling++;
    try {
      const run = RUN_METHODS.includes(record.method);
      const announcing = run && !!session.announcing;
      const completed = this.upsertRequest(session, { ...finished, state: "completed", outcome: value, endedAt: Date.now(), ...(announcing ? { announce: true as const } : {}) });
      session.runLimits?.delete(record.id);
      session.childSpend?.delete(record.id);
      session.aborted?.delete(record.id);
      const steered = this.endSteered(session, record.id, value, announcing);
      try { await this.commit(session, true); }
      catch { return; /* The fault is reported to every later request. */ }
      if (run) {
        this.hook("runEnded", session, completed);
        const usage = session.usage;
        session.usage = undefined;
        // With this run's event (and those of prompts steered into it), any an earlier failure left.
        const unannounced = [...session.requests.values()].filter(request => request.announce);
        if (unannounced.length) void this.announce(session, unannounced, usage);
      }
      session.lastActive = Date.now();
      this.publish(session, { type: "response", id: record.id, outcome: value });
      for (const id of steered) this.publish(session, { type: "response", id, outcome: value });
      if (run && completed.trace?.sampled) {
        // A run that never began (refused at a limit, or failed starting) has a span too.
        const spans = session.spans?.requestId === record.id ? session.spans : await this.spansFor(session, completed);
        if (session.spans === spans) session.spans = undefined;
        spans?.end(value, completed);
      }
    } finally { session.settling--; }
    await this.fold(session);
  }

  /** Count a model response's usage toward the webhook event of its run's end. */
  private tally(session: Session, requestId: string, usage: any) {
    const total = (session.usage ??= new Map()).get(requestId) ?? { responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
    session.usage.set(requestId, {
      responses: total.responses + 1, input: total.input + (usage.input ?? 0), output: total.output + (usage.output ?? 0),
      cacheRead: total.cacheRead + (usage.cacheRead ?? 0), cacheWrite: total.cacheWrite + (usage.cacheWrite ?? 0), costUsd: total.costUsd + responseCost(usage),
    });
  }

  /** Complete the prompts steered into the turn `turn` with its outcome; their queued runs then do nothing. */
  private endSteered(session: Session, turn: string, outcome: Outcome, announcing: boolean) {
    const ended: string[] = [];
    for (const [id, into] of session.steered ?? []) {
      if (into !== turn) continue;
      session.steered!.delete(id);
      const queued = session.running.get(id);
      if (!queued) continue;
      const { params: _params, ...rest } = queued;
      this.upsertRequest(session, { ...rest, state: "completed", outcome, endedAt: Date.now(), steeredInto: turn, ...(announcing ? { announce: true as const } : {}) });
      ended.push(id);
    }
    return ended;
  }

  /** The agent's spend limit, read once per load; its owner keeps it current. */
  private async spendOf(session: Session) {
    if (session.spend === undefined) {
      const row = (await this.db.query("select usd, spent, set_at from agent_spend_limits where agent = $1", [session.header.id])).rows[0];
      session.spend ??= row ? { usd: Number(row.usd), spent: Number(row.spent), setAt: Number(row.set_at) } : null;
    }
    return session.spend;
  }

  /**
   * A response's usage as it is billed: on a platform key of a tenant that pays for it, priced from the runtime's catalog,
   * never from the agent's stored model; one that reported no usage is charged an estimate, and logged. An unbilled
   * tenant's (an admin tenant's) is as the provider reported it, as its usage events say.
   */
  private billable(session: Session, usage: any, provider: string, model: string, abortedChars?: number) {
    if (!session.platformKey || !session.catalogPriced) return usage;
    const priced = platformUsage(usage, provider, model, abortedChars === undefined ? undefined : { chars: abortedChars });
    if (priced.estimated || !priced.known) {
      console.log(JSON.stringify({ type: "platform_usage_untrusted", tenant: session.header.tenant, agent: session.header.id, provider, model, estimated: priced.estimated, known: priced.known, aborted: abortedChars !== undefined, usd: priced.usage.cost.total }));
    }
    return priced.usage;
  }

  /** Give the agent a budget of `usd` from now (null: none). A new value starts counting from zero. */
  private async setSpendLimit(session: Session, usd: number | null) {
    const id = session.header.id, setAt = Date.now();
    if (usd === null) await this.db.query("delete from agent_spend_limits where agent = $1", [id]);
    else await this.db.query("insert into agent_spend_limits (agent, usd, spent, set_at) values ($1, $2, 0, $3) on conflict (agent) do update set usd = excluded.usd, spent = 0, set_at = excluded.set_at", [id, usd, setAt]);
    session.spend = usd === null ? null : { usd, spent: 0, setAt };
  }

  /**
   * A compaction summary's usage, billed like a response: to the tenant (`onUsage`, kind compaction) and against the
   * agent's spend limit. One made in the background belongs to no run (`run` has no requestId). Returns the usage billed.
   */
  private compactionUsage(session: Session, event: any, run: Record<string, unknown>) {
    const usage = this.billable(session, event.usage, event.provider, event.model);
    // Responses through the tenant's own endpoint count under it: `chiridion/openrouter/<model>`.
    const via = this.endpoint(session) ? `${session.header.config.model.provider}/` : "";
    this.options.onUsage?.(session.header.tenant, session.header.id, { ...event, usage, ...run, provider: via + event.provider, kind: "compaction", platform: !!session.platformKey });
    this.spent(session, responseCost(usage));
    return usage;
  }

  /** Events of a compaction made between runs: billed here, as no run's stream carries them, and shown on the agent's stream. */
  private backgroundEvent(session: Session, event: any) {
    if (event?.type === "compaction_usage" && event.usage) {
      const { identity, keyScope } = session.header;
      this.compactionUsage(session, event, { ...(identity ? { identity } : {}), ...(keyScope ? { keyScope } : {}) });
    }
    this.publish(session, { type: "event", requestId: "", event });
  }

  /** Count a model response's cost against the agent's spend limit, if it has one. */
  private spent(session: Session, cost: number) {
    const spend = session.spend;
    if (!spend || !(cost > 0)) return;
    spend.spent += cost;
    // Only the owner writes, and a limit set since is not charged: every write adds to the current one's count.
    void this.db.query("update agent_spend_limits set spent = spent + $2 where agent = $1 and set_at = $3", [session.header.id, cost, spend.setAt])
      .catch(error => console.error(JSON.stringify({ type: "agent_spend_write_failed", agent: session.header.id, error: errorText(error) })));
  }

  /** The tenant's js_exec limits. */
  private async codeLimits(tenant: string): Promise<CodeLimits> {
    return await this.options.codeLimitsFor?.(tenant) ?? { cpuMs: CODE_LIMITS.cpuMs, maxTimeoutMs: CODE_LIMITS.maxTimeoutMs, concurrent: CODE_LIMITS.concurrent };
  }

  /** Why the agent may not spend more on models: it has reached its own spend limit. */
  private async agentSpendLimit(session: Session): Promise<string | undefined> {
    const spend = await this.spendOf(session);
    if (!spend || spend.spent < spend.usd) return undefined;
    return `This agent has reached its spend limit of ${dollars(spend.usd)} (${dollars(spend.spent)} spent since it was set); raise it with PATCH /v1/agents/${session.header.id}/configuration {"spendLimit": {"usd": …}}`;
  }

  /** Why the running run may not spend more: it has spent its own limit (`runLimits`). */
  private runSpendLimit(session: Session): string | undefined {
    for (const [id, usd] of session.runLimits ?? []) {
      const spent = (session.usage?.get(id)?.costUsd ?? 0) + (session.childSpend?.get(id) ?? 0);
      if (session.running.has(id) && spent >= usd) return `This run has reached its spend limit of ${dollars(usd)} (${dollars(spent)} spent)`;
    }
    return undefined;
  }

  /**
   * Why the running run may not make another model request: it has made as many responses, or run as long, as the
   * agent's `runLimits` allow, within the runtime's. Counted on this node: a turn resumed after its node was lost
   * counts again from its resume.
   */
  private async turnLimit(session: Session): Promise<string | undefined> {
    const run = [...session.running.values()].find(record => RUN_METHODS.includes(record.method) && record.began);
    if (!run) return undefined;
    const most = await this.options.runLimitsFor?.(session.header.tenant) ?? RUN_LIMITS, own = session.header.config.runLimits ?? {};
    const maxResponses = Math.min(own.maxResponses ?? most.maxResponses, most.maxResponses);
    const maxSeconds = Math.min(own.maxSeconds ?? most.maxSeconds, most.maxSeconds);
    const responses = session.usage?.get(run.id)?.responses ?? 0;
    if (responses >= maxResponses) return `This run stopped at its limit of ${maxResponses} model responses. Send another message to continue`;
    if (Date.now() - run.began! >= maxSeconds * 1000) return `This run stopped at its time limit of ${duration(maxSeconds)}. Send another message to continue`;
    return undefined;
  }

  /** Why a run may not start: a model run's spend limit (a monthly cap or spent credit), or for any run, spent credit. */
  private async runLimit(session: Session, method: string): Promise<HttpError | undefined> {
    const tenant = session.header.tenant;
    const refused = (refusal: Refusal | undefined, code: string) => typeof refusal === "string" ? new HttpError(402, refusal, code) : refusal;
    if (MODEL_RUNS.includes(method)) return refused(await this.agentSpendLimit(session) ?? await this.options.spendLimit?.(tenant), "SPEND_LIMIT");
    if (RUN_METHODS.includes(method)) return refused(await this.options.creditLimit?.(tenant), "INSUFFICIENT_CREDIT");
    return undefined;
  }

  /** Report the running run's active time so far; `running` keeps counting from now. */
  private reportActive(session: Session, running: boolean, now = Date.now()) {
    if (session.activeSince === undefined) return;
    const ms = now - session.activeSince;
    session.activeSince = running ? now : undefined;
    try { this.options.onActive?.(session.header.tenant, session.header.id, ms); }
    catch (error) { console.error(JSON.stringify({ type: "active_report_failed", error: errorText(error) })); }
  }

  /** Make a pending execution's start durable before anything outside its sandbox acts for it. */
  private async beforeEffect(session: Session) {
    const beginning = session.beginning;
    if (beginning) await (beginning.durable ??= this.commit(session, true));
  }

  private hook(name: "runStarted" | "runEnded", session: Session, record: RequestRecord) {
    try { this.options.hooks?.[name]?.({ id: session.header.id, tenant: session.header.tenant, claim: session.claim }, record); }
    catch (error) { console.error(JSON.stringify({ type: "session_hook_failed", hook: name, error: safeError(error) })); }
  }

  /**
   * Call a tool on the application's attached server, as on any MCP server. With no application
   * connected (after a short wait for one reconnecting) the call fails without running; a call the
   * connection or deadline cut short has an unknown outcome. After a crash, the turn's transcript
   * says the same: a tool call without a result is closed as unknown, never sent again.
   */
  /**
   * A `tools.search` query over the agent's code-mode tools; a rerank stage that fails is logged and
   * left out. Ranking by meaning is platform usage at what its providers charged: the tenant pays
   * the runtime, never with its own keys, so which provider serves it stays the runtime's choice.
   */
  private searchTools(session: Session, query: SearchQuery) {
    return searchTools(session.searchable ?? [], query, {
      rerankers: this.options.rerankers ?? [],
      onError: (error, stage) => console.error(JSON.stringify({ type: "tool_search_rerank_failed", reranker: stage.kind, agent: session.header.id, error: safeError(error) })),
      onRanked: ({ cost }) => this.toolSearchUsage(session, cost, 1),
    });
  }

  private toolSearchUsage(session: Session, usd: number, searches: number) {
    this.options.onUsage?.(session.header.tenant, session.header.id, {
      provider: "runtime", model: "tool_search", usage: { cost: { total: usd } }, platform: true, toolSearch: true, toolSearches: searches,
    });
  }

  private async callAttached(session: Session, { name, args, signal, toolCallId, innerCallId, idempotencyKey, origin, actor, onProgress, approval, inputResponses, requestState, elicit }: ToolCall): Promise<McpResult> {
    const attached = await this.attachedServer(session, signal);
    if (!attached) throw new ToolFailure("not_connected", "No application is connected to answer this tool call; it did not run");
    // The tool's own deadline, else the runtime's; each progress notification restarts it, up to TOOL_DEADLINES.maxTotalMs.
    const timeout = session.header.definitions.find(tool => tool.name === name)?.timeoutMs ?? this.options.toolTimeoutMs ?? TOOL_DEADLINES.attachedMs;
    // Who the call is for, as an identity token would say (the same claims): the connection is the
    // application's own, so it needs no signature, and a tool reads it the same way either way.
    const header = session.header;
    const identity = {
      tenant: header.tenant, agent: header.id, sub: header.identity?.subject ?? header.id,
      ...(header.definition ? { definition: header.definition.id } : {}), ...(header.identity?.context ? { ctx: header.identity.context } : {}),
      ...(actor ? { act: actor } : {}), ...(origin ? { origin } : {}), ...(approval ? { approval } : {}),
    };
    const _meta = {
      "agent-runtime/callId": randomUUID(), "agent-runtime/identity": identity, ...callMeta({ toolCallId, innerCallId, idempotencyKey, origin, actor }),
      ...(approval ? { "agent-runtime/approval": approval } : {}),
    };
    session.inflight++;
    try {
      return await attached.track(() => attached.client.request({ method: "tools/call", params: callParams(name, args, _meta, { inputResponses, requestState, elicit }) } as never, CallToolResultSchema,
        { signal, timeout, maxTotalTimeout: Math.max(timeout, TOOL_DEADLINES.maxTotalMs), resetTimeoutOnProgress: true, onprogress: progress => onProgress?.(progress) })) as McpResult;
    } catch (error) {
      if (!signal.aborted && error instanceof McpError && error.code === ErrorCode.RequestTimeout) throw timedOut(timeout);
      if (!signal.aborted && error instanceof McpError && error.code === ErrorCode.ConnectionClosed) {
        throw new ToolFailure("connection_lost", CONNECTION_LOST, true);
      }
      throw error;
    } finally { session.inflight--; }
  }

  /** Whether an application serves the agent's tools, waiting briefly for one that is reconnecting. */
  private async applicationConnected(session: Session) {
    for (const until = Date.now() + RECONNECT_GRACE_MS; ;) {
      if (session.attached?.accepting && session.attached.initialized) return true;
      if (Date.now() >= until || this.closed || session.fault) return false;
      await sleep(50);
    }
  }

  /** The attached server once its MCP session is up, waiting briefly for an application that is reconnecting. */
  private async attachedServer(session: Session, signal: AbortSignal) {
    for (const until = Date.now() + RECONNECT_GRACE_MS; ;) {
      const attached = session.attached;
      if (attached?.accepting && await attached.ready.then(() => true, () => false) && attached.accepting) return attached;
      if (Date.now() >= until || signal.aborted || this.closed || session.fault) return undefined;
      await sleep(50);
    }
  }

  async remove(id: string) {
    // An agent already revoked, and not held here to write it again, is never loaded.
    if (!this.sessions.has(id) && !this.loading.has(id)) {
      const stored = await this.readHeader(id);
      if (!stored || stored.value.revoked) return;
    }
    const session = await this.load(id);
    // A revocation whose write may not have landed is written again.
    if (!session || (session.header.revoked && !session.unsettled)) return;
    session.header.revoked = true;
    await this.writeHeader(session);
    this.abortChildren(session);
    await this.interrupt(session, "Session revoked");
    this.endStreams(session);
    await this.releaseVolumes(session.header, session.claim);
  }

  /** A deleted agent stops watching its mounts, and its own workspace goes with it; shared volumes stay. */
  private async releaseVolumes(header: SessionHeader, claim: Claim | undefined) {
    const volumes = this.options.volumes;
    const mounts = header.mounts ?? [];
    if (!volumes || !mounts.length) return;
    const id = header.id, tenant = header.tenant;
    try {
      await volumes.watch(id, tenant, mounts, [], claim);
      const workspace = VolumeService.workspaceOf(id);
      if (mounts.some(mount => mount.volumeId === workspace)) await volumes.call(workspace, tenant, "delete");
    } catch (error) {
      if ((error as { status?: number }).status !== 404) console.error(JSON.stringify({ type: "agent_volumes_release_failed", agent: id, error: errorText(error) }));
    }
  }

  /**
   * Settle in-flight work. With `handOff`, runs stay for the next owner: queued ones
   * run there, and turns that began resume there from the transcript.
   */
  private async interrupt(session: Session, reason: string, handOff = false) {
    for (const request of [...session.running.values()]) {
      const queued = request.params !== undefined || session.resuming.has(request.id);
      if (handOff && (queued || resumable(request))) continue;
      const { params: _params, ...rest } = request;
      this.upsertRequest(session, { ...rest, state: "completed", endedAt: Date.now(), outcome: queued ? { error: reason } : { error: reason, uncertain: true } });
    }
    // The running run's spans: ended here with it, or left for the node that takes its turn over (the run's own span is that node's).
    const spans = session.spans;
    session.spans = undefined;
    const ended = spans && session.requests.get(spans.requestId);
    if (ended?.state === "completed") spans!.end(ended.outcome, ended);
    else spans?.abandon(reason);
    // Tool calls in flight end as unknown: the connection they were on is closed.
    this.closeAttached(session);
    await this.commit(session, true);
  }

  /**
   * Purge deleted and expired agents that no live node holds, `limit` at a time;
   * returns how many were purged. Everything the agent stored goes: its journal and
   * transcript (segments, snapshots, blobs), tail rows, local directory, schedules,
   * channel bindings, email threads and volume watches. The row stays as a tombstone with only the
   * agent's id (no tenant, token hash or model), so its id is never reused and requests for it get 404 or 410;
   * its idempotency key makes a fresh agent (see `create`). Nodes claim agents with FOR UPDATE SKIP LOCKED and a
   * lease, so they share the work; every step is idempotent, and an agent whose
   * purge failed or whose node died is claimed again once the lease lapses.
   */
  async purge(limit = 50): Promise<number> { return (await this.purgeBatch(limit)).purged; }

  private async purgeBatch(limit: number) {
    const { rows } = await this.db.query(`
      update agents set purge_claimed_until = now() + interval '5 minutes'
      where id in (
        select a.id from agents a
        where a.purged_at is null and (a.revoked or a.expires_at <= $1)
          and (a.purge_claimed_until is null or a.purge_claimed_until < now())
          and not exists (select 1 from actor_owners o join runtime_nodes n on n.node = o.node and n.session = o.session and n.expires_at > now() where o.actor = a.id)
        order by a.id limit $2 for update skip locked)
      returning id, header`, [Date.now(), limit]);
    let purged = 0;
    const queue = [...rows] as { id: string; header: SessionHeader }[];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let row; (row = queue.shift());) {
        try { if (await this.purgeAgent(row.id, row.header)) purged++; }
        catch (error) { console.error(JSON.stringify({ type: "agent_purge_failed", agent: row.id, error: errorText(error) })); }
      }
    }));
    if (purged) console.log(JSON.stringify({ type: "agents_purged", count: purged }));
    return { claimed: rows.length, purged };
  }

  /** Run the sweep until nothing is left to purge; a sweep already running here picks up new work itself. */
  sweep(): Promise<void> {
    return this.sweeping ??= (async () => {
      try { while (!this.closed && (await this.purgeBatch(50)).claimed > 0); }
      catch (error) { console.error(JSON.stringify({ type: "agent_purge_sweep_failed", error: errorText(error) })); }
      finally { this.sweeping = undefined; }
    })();
  }
  private sweeping?: Promise<void>;
  private purgeSoon() { if (!this.closed) void this.sweep(); }

  private async purgeAgent(id: string, header: SessionHeader): Promise<boolean> {
    // Held here (a single host without ownership, or a revocation not yet unloaded) or taken by
    // another node since: the claim's lease lapses and a later sweep tries again.
    if (this.sessions.has(id) || this.loading.has(id) || this.supervisor.agents.has(id) || this.supervisor.starting.has(id)) return false;
    const ownership = this.options.ownership;
    let claim: Claim | undefined;
    if (ownership) {
      const acquired = await ownership.acquire(id).catch(() => undefined);
      if (!acquired || "owner" in acquired) return false;
      claim = acquired.claim;
    }
    try {
      // Revoking released the agent's volumes; one that expired unrevoked still holds them.
      if (!header.revoked) await this.releaseVolumes(header, claim);
      // Under the claim: a node that stalled past its lease finds the claim gone and leaves the purge to whoever took it.
      await underClaim(this.db, claim, async sql => {
        await this.purgeData(id, sql);
        await sql.query("delete from schedules where agent = $1", [id]);
        // Its email threads' metadata (addresses, subject, Message-IDs) goes with the conversations it answered.
        await sql.query("delete from email_messages m using channel_conversations c where c.agent = $1 and m.channel = c.channel and m.conversation = c.conversation", [id]);
        await sql.query("delete from email_threads t using channel_conversations c where c.agent = $1 and t.channel = c.channel and t.conversation = c.conversation", [id]);
        await sql.query("delete from channel_agents where agent = $1", [id]);
        await sql.query("delete from channel_conversations where agent = $1", [id]);
        await sql.query("delete from volume_watchers where agent = $1", [id]);
        await sql.query("delete from agent_inputs where agent = $1", [id]);
        await sql.query("delete from agent_spend_limits where agent = $1", [id]);
        // Its FileRefs are gone with its transcript: their chunks may be collected (storage-gc.ts).
        await sql.query("delete from chunk_pins where agent = $1", [id]);
        // The id alone stays taken: it is derived from the tenant and key, so a tombstone blocks its reuse without naming either.
        const tombstone = { version: 3, id, revoked: true, purged: true };
        await sql.query("update agents set header = $2, tenant = '', name = $1, type = 'general', model = '', expires_at = null, revoked = true, purged_at = $3, purge_claimed_until = null where id = $1",
          [id, JSON.stringify(tombstone), Date.now()]);
      });
      return true;
    } finally {
      if (claim) await ownership!.release(claim).catch(() => {});
    }
  }

  /** Requests being worked on: runs that began, until their outcome is published, and other open requests; not queued runs or resumes. */
  inFlight() {
    let count = this.leavingWork.size;
    for (const session of this.sessions.values()) count += this.working(session);
    return count;
  }

  /**
   * This node leaves the cluster, with a peer to take its work (`retire`: a newer deploy replaced it; `drain`: it was
   * stopped), or (undefined) stays after all. While it leaves, each running turn finishes only the step it is in (the
   * model call, or the tool calls of the latest response, all of them) and stops at that boundary, before its next model
   * call (the host asks `runLimit` there); the agent is then handed off at once (`park`), and the next owner continues the
   * turn from its transcript with nothing lost. Queued runs and idle agents (one waiting on human input, say) move as
   * `releaseIdle` gives them up.
   */
  handOffTurns(reason: "retire" | "drain" | undefined) {
    if (!reason) {
      this.handingOff = undefined;
      for (const session of this.sessions.values()) session.handoffFrom = undefined;
      return;
    }
    if (this.handingOff) return;
    const now = Date.now();
    this.handingOff = { reason, since: now };
    for (const session of this.sessions.values()) if (session.turn) session.handoffFrom = { at: now, step: session.step ?? "model" };
  }

  /**
   * Give up every agent still working here, mid-step: a retiring node at its cap (AGENT_RETIRE_MAX_MS), whose turns
   * outlasted it. As a drain's end does: their turns resume on the next owner, with the calls they had in flight
   * closed as of unknown outcome.
   */
  async handOffAll() {
    await Promise.all([...this.sessions.values()].filter(session => this.working(session) || session.inflight).map(session => this.leave(session)));
  }

  /**
   * A turn its agent stopped at a step boundary as this node leaves (`handOffTurns`): it stays open, marked handed off
   * with what it gathered for its outcome so far, and the agent is given up at once, for a peer to continue the turn.
   */
  private async park(session: Session, record: RequestRecord, result: Record<string, unknown>) {
    const now = Date.now();
    const leaving = this.handingOff ?? { reason: "drain" as const, since: now };
    const from = session.handoffFrom ?? { at: leaving.since, step: session.step ?? "tool" };
    session.handoffFrom = undefined;
    const id = record.id;
    const listed = (key: string) => Array.isArray(result[key]) && (result[key] as unknown[]).length ? { [key]: result[key] } : {};
    const carried: Carried = {
      ...listed("files"), ...listed("presented"), ...listed("toolCalls"), ...listed("toolErrors"),
      ...(session.usage?.has(id) ? { usage: session.usage.get(id) } : {}),
      ...(session.childSpend?.has(id) ? { childSpend: session.childSpend.get(id) } : {}),
      ...(session.runLimits?.has(id) ? { spendLimit: session.runLimits.get(id) } : {}),
    };
    const { params: _params, ...rest } = session.requests.get(id)!;
    this.upsertRequest(session, {
      ...rest, handedOff: { step: from.step, boundaryWaitMs: Math.max(0, now - from.at), ...(this.options.ownership ? { from: this.options.ownership.node } : {}) },
      handoffs: [...rest.handoffs ?? [], { reason: leaving.reason, at: now }].slice(-MAX_HANDOFFS_KEPT), ...(Object.keys(carried).length ? { carried } : {}),
    });
    try { await this.commit(session, true); }
    catch { return; /* Faulted: the next owner recovers the turn from storage, as after a crash. */ }
    session.usage?.delete(id);
    session.childSpend?.delete(id);
    session.runLimits?.delete(id);
    session.turn = undefined;
    session.partial = undefined;
    // The run's span is its next owner's to end.
    session.spans?.abandon("The turn was handed off to another node");
    session.spans = undefined;
    void this.leave(session);
  }

  /** A handed-off turn's next owner takes over what it had gathered for its outcome, and logs the hand-off (`turn_handed_off`). */
  private takeOver(session: Session, record: RequestRecord, { handedOff, carried }: Pick<RequestRecord, "handedOff" | "carried">) {
    const taken = (carried ?? {}) as Carried;
    if (taken.usage) (session.usage ??= new Map()).set(record.id, taken.usage);
    if (taken.childSpend) (session.childSpend ??= new Map()).set(record.id, taken.childSpend);
    if (taken.spendLimit !== undefined) (session.runLimits ??= new Map()).set(record.id, taken.spendLimit);
    if (taken.toolCalls?.length) session.toolCalls = taken.toolCalls;
    if (taken.toolErrors?.length) session.toolErrors = taken.toolErrors;
    for (const file of taken.files ?? []) session.outputs?.files.set(file.path, file);
    session.outputs?.presented.push(...taken.presented ?? []);
    const last = record.handoffs?.at(-1);
    recordHandoff({
      tenant: session.header.tenant, agent: session.header.id, request: record.id, reason: last?.reason ?? "retire", step: handedOff?.step ?? "tool",
      boundaryWaitMs: handedOff?.boundaryWaitMs ?? 0, latencyMs: last ? Math.max(0, Date.now() - last.at) : 0, handoffs: record.handoffs?.length ?? 1, ...(handedOff?.from ? { from: handedOff.from } : {}),
    });
  }

  /**
   * Give an agent up as this node leaves: its process stopped first, so no turn goes past what is handed off and the
   * next owner never shares the transcript with a live process; runs left open for the next owner (a turn cut off
   * mid-step resumes there, its calls in flight unknown); then released, and its streams closed after the release,
   * so subscribers reconnect to that owner.
   */
  private leave(session: Session): Promise<void> {
    if (session.leaving) return Promise.resolve();
    session.leaving = true;
    const work: Promise<void> = (async () => {
      await this.supervisor.stop(session.header.id, { flush: false }).catch(() => {});
      try { await this.interrupt(session, "The runtime stopped during this request", true); }
      catch { /* Already faulted; the next load recovers conservatively from storage. */ }
      await this.unload(session);
      this.endStreams(session);
    })().finally(() => this.leavingWork.delete(work));
    this.leavingWork.add(work);
    return work;
  }

  private working(session: Session) {
    let count = (session.starting ? 1 : 0) + session.settling;
    for (const request of session.running.values()) {
      if (request.began ? !session.resuming.has(request.id) : !QUEUED_METHODS.includes(request.method)) count++;
    }
    return count;
  }

  /**
   * Give up every agent with nothing running, leaving queued runs for its next owner,
   * and close its stream after the release so the client reconnects to that owner.
   */
  async releaseIdle() {
    if (this.releasing) return;
    this.releasing = true;
    try {
      const idle = [...this.sessions.values()].filter(session => !this.working(session) && !session.inflight);
      // Their history is indexed together first, under one deadline, not one stop at a time.
      await this.supervisor.flush(idle.map(session => session.header.id));
      for (const session of idle) {
        if (this.working(session) || session.inflight) continue;
        await this.supervisor.stop(session.header.id, { flush: false }).catch(() => {});
        await this.unload(session);
        this.endStreams(session);
      }
      // Idle watchers reconnect to a node that stays.
      for (const id of [...this.idle.keys()]) this.loadedElsewhere(id);
    } finally { this.releasing = false; }
  }

  /** Expire sessions, keep SSE alive, and release idle agents' processes and memory. */
  private tick() {
    const now = Date.now();
    const idleMs = this.options.idleMs ?? 5 * 60_000;
    for (const session of this.sessions.values()) {
      const id = session.header.id;
      // An agent still starting (being made, say) expires at the next tick after: stopping it now would fail its start.
      if (!session.header.revoked && expired(session.header.expiresAt, now) && !session.starting) {
        void this.remove(id).then(() => this.supervisor.stop(id)).catch(() => {});
        continue;
      }
      for (const res of this.streams(session)) send(res, ": heartbeat\n\n");
      // A replaced connection still answering its calls is kept alive too, or its client would think the stream dead.
      for (const attached of session.retiring ?? []) send(attached.res, ": heartbeat\n\n");
      if (session.activeSince !== undefined && now - session.activeSince >= ACTIVE_REPORT_MS) this.reportActive(session, true, now);
      void this.overrun(session, now).catch(() => {});
      if (this.busy(session) || now - session.lastActive < idleMs) continue;
      if (this.supervisor.agents.has(id)) void this.supervisor.stop(id).catch(() => {});
      else if (!session.response && !session.fault) {
        // Nothing is running and no application is connected: everything needed later is in storage. Its watchers
        // stay, idle (see `idle`); its polls answer, and poll again idle.
        this.idleWatchers(session);
        void this.unload(session);
      }
    }
    for (const [id, entry] of this.idle) {
      for (const res of entry.watchers) send(res, ": heartbeat\n\n");
      // Should a load's notice be missed (the listening connection was down), who owns the agent says it too.
      const ownership = this.options.ownership;
      if (!ownership || now - entry.checked < IDLE_CHECK_MS) continue;
      entry.checked = now;
      void ownership.route(id).then(owner => { if (owner && owner !== ownership.node && !this.sessions.has(id)) this.loadedElsewhere(id); }).catch(() => {});
    }
  }

  /**
   * A run past its time limit (`runLimitsFor`'s maxSeconds) by `RUN_OVERRUN_MS` is aborted, and its agent stopped by
   * twice that: the limit is otherwise checked only between model requests, and a turn stuck inside one
   * step would hold its agent (and its busy slot) forever. The next start closes the interrupted turn.
   */
  private async overrun(session: Session, now: number) {
    const run = [...session.running.values()].find(record => RUN_METHODS.includes(record.method) && record.began);
    if (!run || now - run.began! < RUN_OVERRUN_MS) return;
    const { maxSeconds } = await this.options.runLimitsFor?.(session.header.tenant) ?? RUN_LIMITS;
    const over = now - run.began! - maxSeconds * 1000;
    const id = session.header.id;
    if (over < RUN_OVERRUN_MS || !this.supervisor.agents.has(id) || !session.running.has(run.id)) return;
    console.error(JSON.stringify({ type: "run_overrun", agent: id, request: run.id, maxSeconds, overMs: over }));
    if (over < 2 * RUN_OVERRUN_MS) await this.supervisor.request(id, "abort");
    else await this.supervisor.stop(id, { flush: false });
  }

  /** A session unloading keeps its watchers, idle, and answers its polls. */
  private idleWatchers(session: Session) {
    const id = session.header.id;
    if (session.watchers.size) {
      let entry = this.idle.get(id);
      if (!entry) { entry = { tenant: session.header.tenant, watchers: new Set(), polls: new Set(), checked: Date.now() }; this.idle.set(id, entry); }
      for (const res of session.watchers) entry.watchers.add(res);
      session.watchers.clear();
    }
    for (const wake of [...session.polls]) wake();
  }

  /** Drop a session from memory and give up ownership so any node can serve it next. */
  private async unload(session: Session) {
    if (this.sessions.get(session.header.id) === session) this.sessions.delete(session.header.id);
    await session.log.close().catch(() => {});
    // A revoked agent's logs are never read again.
    if (session.header.revoked) await underClaim(this.db, session.claim, sql => deleteTail(sql, session.header.id)).catch(() => {});
    // What its runs reported, so a page of it unloaded knows whether its index is behind (see `historyPage`).
    const reported = Math.max(0, ...[...session.requests.values()].map(record => Number((record.outcome?.result as { messages?: unknown } | undefined)?.messages) || 0));
    await this.db.query("update agent_history_index set reported = greatest(reported, $2) where agent = $1", [session.header.id, reported]).catch(() => {});
    // Nothing is published after this: the next owner goes on from this cursor.
    // Runs still open (queued ones a drain leaves for the next owner) keep it marked for a sweep to load; none clears the mark.
    await underClaim(this.db, session.claim, sql => sql.query("update agents set last_cursor = $2, cursor_clean = true, pending_runs = $3 where id = $1",
      [session.header.id, session.cursor, session.running.size > 0])).catch(() => {});
    // Runs left open are its next owner's to count.
    await this.releaseBusy(session, true);
    if (session.claim) await this.options.ownership!.release(session.claim).catch(() => {});
    // Runs left open (a drain's or a retirement's): peers sweep at once rather than at their next interval.
    const node = this.options.ownership?.node;
    if (node && session.running.size && !session.handedBack) void this.db.query("select pg_notify($1, $2)", [ORPHANS_CHANNEL, `${node} ${session.header.id}`]).catch(() => {});
  }

  /** This node fenced itself: another node may already be serving the agent, so stop writing, stop the agent, forget it. */
  private async lost(session: Session) {
    // Its busy row named the fenced session, so it no longer counts.
    session.busy = false;
    session.spans?.abandon("This node lost ownership of the agent");
    session.spans = undefined;
    this.fail(session, new Error("This node lost ownership of the agent"));
    this.endStreams(session, true);
    if (this.sessions.get(session.header.id) === session) this.sessions.delete(session.header.id);
    // Its claim is gone, so it could write no chunk: its next owner's start catches up.
    await this.supervisor.stop(session.header.id, { flush: false }).catch(() => {});
  }

  async close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    // A sweep stops after its batch; agents it claimed but did not reach are taken again once the lease lapses.
    await this.sweeping;
    // Agents being handed off already finish leaving first.
    await Promise.all(this.leavingWork);
    // Every agent's settled turns are indexed together, under one deadline, before they stop one at a time.
    await this.supervisor.flush([...this.sessions.keys()]);
    for (const session of [...this.sessions.values()]) {
      // Stopped first, so no turn advances past what is handed off, and the next owner never shares the transcript with a live process.
      await this.supervisor.stop(session.header.id, { flush: false }).catch(() => {});
      try { await this.interrupt(session, "The runtime stopped during this request", true); }
      catch { /* Already faulted; the next load recovers conservatively from storage. */ }
      await this.unload(session);
      // Closed after release, so the client's reconnect finds the next owner rather than this node.
      this.endStreams(session);
    }
    for (const id of [...this.idle.keys()]) this.loadedElsewhere(id);
  }
}

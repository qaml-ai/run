import { createHash } from "node:crypto";
import type { AttemptAck, ModelAttemptHook } from "../model-attempt.ts";
import type { EndUserCredits } from "../end-user-credits.ts";
import type { ServerResponse } from "node:http";
import type { HttpBindings } from "@hono/node-server";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentConfig, Credentials, RunLimits, ToolDefinition } from "../protocol.ts";
import type { CustomProviders, ModelEndpoints } from "../session-config.ts";
import type { AppendLog } from "../../shared/append-log.ts";
import type { Storage } from "../../shared/storage.ts";
import { outcomeEnding, type ClientEvent, type RequestRecord } from "../../shared/client-protocol.ts";
import type { AgentMetadata } from "../../shared/agent-metadata.ts";
import type { Scheduler } from "../scheduler.ts";
import type { HttpError } from "../http.ts";
import type { RateLimitState } from "../rate-limits.ts";
import type { VolumeService, Mount } from "../volumes.ts";
import type { Db } from "../db.ts";
import type { Claim, Ownership } from "../ownership.ts";
import type { BusyAgents } from "../busy-agents.ts";
import type { DefinitionRef } from "../definitions.ts";
import type { Sources, ToolSources } from "../tool-sources.ts";
import type { AttachedServer } from "../attached.ts";
import type { AgentIdentity, TokenClaims } from "../identity.ts";
import type { RunToolCall, ToolError, ToolServer } from "../tool-servers.ts";
import type { Reranker } from "../tool-search.ts";
import type { CodeLimits } from "../codemode.ts";
import type { FileLinks, FileRef } from "../files.ts";
import type { Transcriber } from "../transcription.ts";
import type { Imager } from "../images.ts";
import type { Decider } from "../decisions.ts";
import type { Outbound } from "../outbound.ts";
import type { WrittenFile } from "../volume-tools.ts";
import type { Inputs, RetryPlan } from "../inputs.ts";
/** Where a tool comes from. */
export type ToolSource = "attached" | "served" | "mcp" | "openapi" | "builtin" | "files" | "channel" | "runtime";

export const validSessionId = (value: string) => /^client_[a-f0-9]{40}$/.test(value);

export type SessionConfig = Omit<AgentConfig, "id" | "directory" | "tools" | "apiKey">;
/** Rarely-changing session identity and configuration (a row in `agents`); rewritten only when it changes. */
export interface SessionHeader {
  /** `expiresAt` null: the agent lives until it is deleted. `idleTtlMs`: it moves on with each run (`stillUsed`). */
  version: 3; id: string; digest: string; expiresAt: number | null; revoked: boolean; idleTtlMs?: number;
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
  /** The bucket of its end user's credit its runs spend from, unless a run names its own (end-user-credits.ts); set by the tenant, never by the agent. */
  bucket?: string;
  /**
   * The bucket the tenant's latest run of it named (a prompt's `bucket`): the one its runs that name none (a schedule's,
   * a sub-agent's notice, a channel's or a voice session's message) spend from, where it has no `bucket` of its own.
   */
  runBucket?: string;
  /** The key it was made with (an upsert's, or a create's Idempotency-Key), shown in listings; none for one made without. */
  key?: string;
  /** sha256 of the application's tools as it last declared them (its tools/list as JSON): its ready event tells it, so it reconfigures only on a change. */
  toolsHash?: string;
  /** The agent it was forked from, and the index of the last message of that agent's history it began with (null: none). */
  forkedFrom?: ForkedFrom;
  /** A child its parent's delegate call made (multi-agent.ts): the parent agent, its run and call, and how deep in the chain it is. */
  parent?: { agentId: string; runId: string; toolCallId: string; depth: number };
  /**
   * A stateless run's single-use session (POST /v1/runs): hidden from the agents list, its one prompt's request is the run.
   * Once the run ends its data is kept `retentionMs`, then purged as an expired agent's is. `fingerprint`: the request
   * that made it, so its Idempotency-Key with another request is refused.
   */
  run?: RunSettings;
}
export type RunSettings = { retentionMs: number; fingerprint: string };
/** A stateless run's id (`run_<hex>`) for its session's (`client_<hex>`), and back: one hex, so routing finds its owner. */
export const runIdOf = (sessionId: string) => `run_${sessionId.slice("client_".length)}`;
export const runSessionOf = (runId: string) => /^run_[a-f0-9]{40}$/.test(runId) ? `client_${runId.slice("run_".length)}` : undefined;
export type ForkedFrom = { agentId: string; atMessage: number | null };
/** A child a delegate call of the running run is waiting on: the agent, its request, and whether the runtime made it (a named agent it did not). */
export type Child = { agent: string; requestId: string; made: boolean; done?: boolean };
/**
 * Upserts of request records, appended as their state changes, and ended runs whose webhook event (`run.completed` or
 * `run.failed`) is written (`announced`). Journals from before tool calls were MCP also hold call records, which are skipped.
 */
export type JournalRecord = { t: "request"; record: RequestRecord } | { t: "announced"; ids: string[] };
/** What a run's model responses (compaction summaries included) used, for its end's webhook event. */
export type RunUsage = { responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
export type ClientEnv = { Bindings: HttpBindings & { operatorTenant?: string }; Variables: { session: Session } };
export type BufferedEvent = { id: number; bytes: number; data: ClientEvent };
export type Session = {
  header: SessionHeader;
  /** Revision of the stored header this node last read or wrote; writes are conditional on it. */
  revision?: number;
  /** The header write in flight (`writeHeader`): the next waits for it, so two never race on one revision. */
  headerWrite?: Promise<void>;
  claim?: Claim;
  requests: Map<string, RequestRecord>;
  /** The requests still running, so nothing scans every retained record. */
  running: Map<string, RequestRecord>;
  /** The version of each file the agent last read or wrote with its file tools (volume-tools.ts `seen`), on this node. */
  seen?: Map<string, number>;
  log: AppendLog<JournalRecord>;
  /** Streamed events live only in memory; durable state is recovered through /state. */
  cursor: number; events: BufferedEvent[]; eventBytes: number;
  /**
   * The highest event id reserved for this owner (`reserveEvents`), and the next block's reservation while it is made.
   * Events past the reservation wait in `held`, in order, until it is extended.
   */
  reserved: number; reserving?: Promise<void>; held?: ClientEvent[];
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
  /** Requests taken whose record is not durable yet, by id: a retry of one waits for it (see `submit`). */
  accepting?: Map<string, Promise<void>>;
  /** Requests whose files are being saved and transcribed, by id: a retry with the same arguments waits for the same work, so audio is transcribed (and billed) once. */
  attaching?: Map<string, { fingerprint: string; files: Promise<(FileRef & { cost?: number })[]> }>;
  /** Given back for a node with room to take: nothing more runs here. */
  handedBack?: true;
  /** Being given up because this node is leaving (`park`, `handOffAll`): nothing more runs here, and a run cut off here stays open. */
  leaving?: true;
  /** What the running turn is doing: calling the model, or running the tool calls of its latest response (from its events). */
  step?: "model" | "tool";
  /** The assistant message streaming now, as its latest message_update carried it. */
  partial?: unknown;
  /** What each running run's model responses used so far, for its end's webhook event. */
  usage?: Map<string, RunUsage>;
  /** Model runs' own spend limits (a prompt's `spendLimit`), in USD, by request id, while they run. */
  runLimits?: Map<string, number>;
  /** Model runs' own run limits (a prompt's `runLimits`: model responses and seconds), by request id, while they run. */
  runCaps?: Map<string, RunLimits>;
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
  /** The mounts the running agent started with, which its prompt describes: when they change, its next run starts it again. */
  hosted?: Mount[];
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
  /** The journal's last turn, ended before this load (agent-host `endedTurn`): for a resumed run that never recorded its end. */
  ended?: { requests: string[]; calls: string[]; finished: unknown };
  fault?: Error;
  /** A header write failed with the database unreachable, so the stored revision is unknown. */
  unsettled?: boolean;
  lastActive: number;
  /** Clear the sweep backoff after this load has held until here. */
  sweepResetAt?: number;
  /** Whether the agent's current model key is the platform's, not the tenant's own. */
  platformKey?: boolean;
  /** Whether the tenant pays for responses on the platform's keys (prepaid): they are priced from the catalog (`billable`). */
  catalogPriced?: boolean;
  /** Whether a run of it falling back to the default bucket was said (`bucketOf`), since it was loaded. */
  defaultBucketSaid?: boolean;
  /** Its spend limit and what it has spent since it was set (`agent_spend_limits`); null when it has none, undefined until read. */
  spend?: SpendLimit | null;
  /** Spend counted that no journal entry has carried yet (`spent`), for the next to write (`entryEffect`). */
  unwritten?: number;
  /** Since when a run's active time has not been reported (`onActive`). */
  activeSince?: number;
  /** What the running run wrote and handed over with present_file, for its outcome. */
  outputs?: { files: Map<string, WrittenFile>; presented: (FileRef & { caption?: string })[] };
  /** In a `resume` run, how each answered call is run again, by tool call id. */
  retries?: Map<string, RetryPlan>;
  /** A channel's conversation: someone there answers the agent's inputs. */
  channel?: boolean;
  /** Where each of the running agent's tools comes from. */
  toolSources?: Map<string, ToolSource>;
  computerRevision?: string;
  /** The children the running run's calls started, by call id, which its tool calls name (an abort finds them by their rows: `stopDelegates`). */
  children?: Map<string, Child>;
  /** A stop waiting for the delegate children it aborted to end (`stopDelegates`): a run ending meanwhile waits too, so its usage counts them. */
  stoppingChildren?: Promise<void>;
  /** The running run's delegate calls in flight, and those waiting for one to finish (its `maxParallel`). */
  delegating?: { active: number; waiting: (() => void)[] };
  /** What each running run's children spent, which its own spend limit counts. */
  childSpend?: Map<string, number>;
  /** What each running run's generate_image calls spent, which its own spend limit counts. */
  imageSpend?: Map<string, number>;
  /** What each running run's decide calls spent, which its own spend limit counts. */
  decisionSpend?: Map<string, number>;
  /** What each running run's children in flight may still spend, held for them (`delegate`), and how many hold it. */
  childHeld?: Map<string, { usd: number; holders: number }>;
  /** Listeners on this agent's stream on this node: a parent relaying its child's events to its own (`subagent_event`). */
  taps?: Set<(data: ClientEvent) => void>;
  /** Runs an abort reached after they began but before the agent had them: they end without running (see `markAborted`). */
  aborted?: Set<string>;
  /** A resumed turn waiting for its durable backoff; an abort wakes it to settle immediately. */
  resumeWait?: AbortController;
  /** The spawn_agent call writing its child's row: the next waits, so the running children's count holds (`childRow`). */
  spawning?: Promise<void>;
  /** A background child's share of the spend limit being worked out (childShare), one at a time. */
  sharing?: Promise<void>;
  /** The send_message calls of each running run, by request id: at most MULTI_AGENT_LIMITS.messagesPerRun. */
  messagesSent?: Map<string, Set<string>>;
};
/** What a run handed off at a step boundary had gathered for its outcome, which its next owner takes over (`takeOver`). */
export type Carried = { usage?: RunUsage; childSpend?: number; imageSpend?: number; decisionSpend?: number; spendLimit?: number; runLimits?: RunLimits; toolCalls?: RunToolCall[]; toolErrors?: ToolError[]; files?: WrittenFile[]; presented?: (FileRef & { caption?: string })[] };
export interface ClientSessionOptions {
  secret: string; toolTimeoutMs?: number; ttlMs?: number; eventBytes?: number;
  /** Event ids reserved at a time (default EVENT_BLOCK); tests set fewer, to reserve often. */
  eventBlock?: number;
  /** Said after a run's `model_key_missing` error: where else this runtime takes keys (a self-host's environment). */
  modelKeyHint?: string;
  /** The most a snapshot takes, one frame (default FRAME_BYTES); tests make it small. */
  snapshotBytes?: number;
  /** Read-only subscribers (watchers and waiting polls) one agent's event stream may have at once (default 32), a tenant's agents on this node (1024), and this node (4096). */
  maxWatchers?: number; maxTenantWatchers?: number; maxNodeWatchers?: number;
  /** How often nodes sweep for agents with work left (`resumeOrphans`): the unit of a failed load's backoff. */
  orphanSweepMs?: number;
  maxResumes?: number;
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
  /** Models a provider's content filter blocks wrongly, each with the same model elsewhere (model.ts `contentFilterFallbacks`). */
  contentFilterFallbacks?: Map<string, Model<Api>>;
  /** How long a model request may go quiet before it fails as stalled (model-stream.ts); an agent's runLimits may set its own. */
  streamTimeouts?: AgentConfig["streamTimeouts"];
  contextRangeMaxBytes?: number;
  /** How far past its time limit a run may get before it is aborted (twice this: its agent stopped); RUN_OVERRUN_MS by default. */
  runOverrunMs?: number;
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
  runLimitsFor?: (tenant: string) => Promise<Required<Pick<RunLimits, "maxResponses" | "maxSeconds">>>;
  /** A tenant's js_exec limits: CPU per execution, the longest timeoutMs, and executions at once on this node. Default `CODE_LIMITS`. */
  codeLimitsFor?: (tenant: string) => Promise<CodeLimits>;
  /** js_exec executions this node runs at once for tenants with a concurrency limit, together (AGENT_CODE_WORKERS_MAX, default 16). */
  codeCapacity?: number;
  /** Why a tenant may not start any run, code executions included (spent prepaid credit). Checked when a run is accepted and when it starts. */
  creditLimit?: (tenant: string) => Promise<Refusal | undefined>;
  /**
   * Count a run the tenant starts against its rate limit; throws (429) past it. Checked when a run is accepted, not for
   * retries. Where the tenant then stands (X-RateLimit-* on the answer), when a limit applies.
   */
  runRate?: (tenant: string) => Promise<RateLimitState | undefined | void>;
  /** Durable accounting acknowledgment before each provider dispatch and terminal response (and its end user's hold, as it streams). */
  modelAttempt?: (tenant: string, agent: string, platform: boolean, catalogPriced: boolean, event: Parameters<ModelAttemptHook>[0]) => Promise<boolean | AttemptAck>;
  /**
   * The tenant's own users' credit (end-user-credits.ts): runs of an agent with a subject spend their end user's, in the
   * run's bucket. Its model calls hold and settle through `modelAttempt`; audio and images hold here; runs are refused
   * (402 END_USER_CREDIT) and turns stopped at a step boundary when the end user has nothing left.
   */
  endUsers?: EndUserCredits;
  /** Called with each finished assistant message that reports token usage, and each compaction summary's. */
  onUsage?: (tenant: string, agentId: string, message: UsageRecord) => void;
  /** Whether the tenant has a webhook endpoint for run events; without it, runs write none. */
  runEvents?: (tenant: string) => Promise<boolean>;
  /** Called with time an agent spent in runs (model calls and tool execution), at least every minute while one runs. */
  onActive?: (tenant: string, agentId: string, ms: number) => void;
  hooks?: SessionHooks;
  /** Volumes: new agents get mounts (a workspace by default) and file tools over them. */
  volumes?: VolumeService;
  /** Transcribes audio attached to messages (transcription.ts); without it, audio is attached as any file is. */
  transcriber?: Transcriber;
  /** Makes images for the generate_image builtin (images.ts); without it, the builtin has no tool. */
  imager?: Imager;
  /** Answers the decide builtin (decisions.ts); without it, the builtin has no tool. */
  decider?: Decider;
  /** Fetches files attached by URL ({url}): the public internet only. Without it, files cannot be attached by URL. */
  outbound?: Outbound;
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
  /** Submit a request to an agent on whichever node serves it (resuming a suspension that expired). */
  submit?: (agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }) => Promise<RequestRecord>;
  /**
   * Make an agent for the delegate builtin, as POST /v1/agents does with `params` and `key`, linked to the run that made it
   * (`parent`). Without it, agents cannot delegate.
   */
  createAgent?: (tenant: string, params: Record<string, unknown>, key: string, parent: NonNullable<SessionHeader["parent"]>) => Promise<{ id: string }>;
  /** Delete a tenant's agent on whichever node serves it: a deleted parent's children the runtime made. */
  deleteAgent?: (agent: string, tenant: string) => Promise<unknown>;
  /** One of an agent's requests on whichever node serves it, once it settles or `waitMs` passes (see `awaitRequest`). */
  requestAnywhere?: (agent: string, tenant: string, requestId: string, waitMs: number, signal?: AbortSignal) => Promise<RequestRecord | undefined>;
  /** How often to sweep for children's endings not delivered (`sweepChildren`); MULTI_AGENT_LIMITS.sweepMs by default. */
  childSweepMs?: number;
  /** Turns sub-agent notifications may start per chain root and hour; MULTI_AGENT_LIMITS.wakesPerHour by default. */
  wakesPerHour?: number;
}
/** A definition resolved for an agent: its revision, agent configuration, client tools and tool sources. */
export type DefinitionConfig = { id: string; revision: number; config: Pick<AgentConfig, "model" | "systemPrompt" | "thinkingLevel" | "fileTools" | "codeMode" | "runLimits" | "maxOutputTokens" | "temperature" | "dataCollection" | "language">; sources?: Sources; description?: string };
/** One model response's usage; `kind` separates compaction summaries from the agent's turns. */
/**
 * A model response's usage, a web tool's call (`searches`: web searches, `renders`: pages web_fetch had
 * rendered), tool search's ranking by meaning (`toolSearch`: `toolSearches` searches, none for
 * embedding a catalog ahead of them), audio transcribed (kind `transcription`: `audioSeconds` of it), or
 * images made (kind `image`: `images` of them, their tokens in `usage`), or decisions (kind `decision`: `decisions` answered),
 * with its cost in `usage.cost.total`.
 */
export type UsageRecord = {
  provider?: string; model?: string; usage: any; timestamp?: number; kind?: "turn" | "compaction" | "transcription" | "image" | "speech" | "decision"; platform?: boolean; searches?: number; renders?: number; toolSearch?: boolean; toolSearches?: number;
  transcriptions?: number; audioSeconds?: number; images?: number; speeches?: number;
  /** Kind `decision`: questions answered (decisions.ts). */
  decisions?: number;
  /** Already persisted beside a Pi journal response. */
  durableReceipt?: boolean;
  /** For a model response: the run it was in, who acted in it, whom the agent acts for, and its key scope (for usage webhooks). */
  requestId?: string; actor?: string; identity?: AgentIdentity; keyScope?: string;
};
/** Why runs are refused: a message (402), or an error with its own status. */
export type Refusal = string | HttpError;
/** An agent's spend limit (USD), what it has spent since, and when it was set. */
export type SpendLimit = { usd: number; spent: number; setAt: number };
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
/** `resume` continues a turn that waited on human input; the runtime makes it when the last input settles. */
export const RUN_METHODS = ["prompt", "execute", "continue", "resume"];
/** Runs that call the model; code executions do not, so spend limits leave them alone. */
export const MODEL_RUNS = ["prompt", "continue"];
/**
 * A request as callers see it: queued parameters stay internal, and an ended one's error, early stop and `status` are on
 * top. `state` says only whether it ended; `status` how, as the SDKs' runs say it: completed, input_required or failed.
 */
export const visible = ({ params: _params, announce: _announce, handedOff: _handedOff, carried: _carried, notice: _notice, landOnly: _landOnly, ...record }: RequestRecord): RequestRecord => {
  if (record.state !== "completed") return record;
  const ending = outcomeEnding(record.outcome);
  const status = ending.error !== undefined || ending.stopped === "spend_limit" || ending.stopped === "turn_limit" || ending.stopped === "agent_loop_limit" ? "failed" : ending.stopped === "input_required" ? "input_required" : "completed";
  return { ...record, ...ending, status };
};

/**
 * How a failed run failed, as a short class and never its text (which can quote a provider or the user): its stop
 * (spend_limit, turn_limit, agent_loop_limit), the runtime's code (aborted, resume_limit, model_stream_stalled…), or
 * runtime_restart, runtime_error or model_error. Undefined for a run that did not fail.
 */
export function failureClass(record: Pick<RequestRecord, "outcome">): string | undefined {
  const ending = outcomeEnding(record.outcome);
  if (ending.stopped && ending.stopped !== "input_required") return ending.stopped;
  if (ending.error === undefined) return undefined;
  const code = (record.outcome?.result as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(code)) return code;
  if (record.outcome?.error !== undefined) return record.outcome.uncertain ? "runtime_restart" : "runtime_error";
  return "model_error";
}

/** The agent's run that has begun: the one its tool calls are made in. */
export function runningRun(session: Session) {
  return [...session.running.values()].find(record => RUN_METHODS.includes(record.method) && record.began);
}

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);

/**
 * Whether an agent is busy, from its request records alone: the one source every view of it (GET /v1/agents/{id}, its
 * state, a `status` request) reads, so they never disagree. Busy while any run is open, running or queued; `activeRun`
 * is the run that has begun, and `queuedRuns` how many wait behind it.
 */
export function activityOf(records: Iterable<RequestRecord>) {
  let activeRun: string | null = null, queuedRuns = 0;
  for (const record of records) {
    if (record.state !== "running" || !RUN_METHODS.includes(record.method)) continue;
    if (record.began) activeRun = record.id; else queuedRuns++;
  }
  return { busy: activeRun !== null || queuedRuns > 0, activeRun, queuedRuns };
}

/** Never-expiring agents have `expiresAt: null`; a bare `<=` would treat null as 0, long expired. */
export const expired = (expiresAt: number | null, now = Date.now()) => expiresAt !== null && expiresAt <= now;

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { AgentConfig, Credentials, ToolDefinition } from "./protocol.ts";
import { errorText } from "./protocol.ts";
import { enqueueEvents, usageCost, webhookEvent, type WebhookEvent } from "./webhooks.ts";
import { AgentSupervisor } from "./supervisor.ts";
import { configurationUpdate, type ModelEndpoints } from "./session-config.ts";
import { validateDefinitions } from "./tool-policy.ts";
import { validateUserMessages } from "./history.ts";
import type { Backlog } from "./transcript.ts";
import { canonical } from "../shared/durable-json.ts";
import type { AppendLog } from "../shared/append-log.ts";
import { fileStorage, type Storage } from "../shared/storage.ts";
import { FRAME_BYTES, type ClientEvent, type Outcome, type RequestMethod, type RequestRecord, type TurnSnapshot } from "../shared/client-protocol.ts";
import { agentMetadata, type AgentMetadata } from "../shared/agent-metadata.ts";
import { scheduleInput, type Scheduler } from "./scheduler.ts";
import { errorStatus, HttpError, readJson } from "./http.ts";
import { VolumeService, type Mount } from "./volumes.ts";
import { databaseUnavailable, type Db, type Sql } from "./db.ts";
import { LostClaim, underClaim, type Claim, type Ownership } from "./ownership.ts";
import { deleteTail } from "./log-tail.ts";
import { OVERRIDES, type DefinitionRef } from "./definitions.ts";
import type { Sources, ToolSources } from "./tool-sources.ts";
import { callParams, contentResult, type McpResult } from "./mcp-results.ts";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AttachedServer } from "./attached.ts";
import { actorInput, type AgentIdentity, type TokenClaims } from "./identity.ts";
import { metadataInput, senderInput } from "./sender.ts";
import { callMeta, compose, TOOL_DEADLINES, timedOut, toolCallKey, ToolFailure, type ToolError, defaultExposure, describeSources, fileServer, type Progress, type ToolCall, type ToolServer, type ToolSourceView } from "./tool-servers.ts";
import { searchTools, type Reranker, type SearchQuery } from "./tool-search.ts";
import { declaredType, FILE_LIMITS, fileResponse, safeName, validFileRef, type FileLinks, type FileRef } from "./files.ts";
import { fileRef } from "./inspect.ts";
import { resolve as resolveMount, type ToolContext, type WrittenFile } from "./volume-tools.ts";
import { HistoryIndex, type HistoryPage } from "./history-pages.ts";
import { answerInput, argumentsHash, expiresAt, inputRequests, inputView, mayAnswer, resolution, type Answer, type Input, type Inputs, type InputRow, type Responder, type RetryPlan } from "./inputs.ts";

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
  metadata?: AgentMetadata; definitions: ToolDefinition[]; provisionHash: string; config: SessionConfig;
  /** Volumes the agent's file tools can reach; absent on sessions created before volumes existed. */
  mounts?: Mount[];
  /** A purged agent's tombstone keeps only its identity (see `purge`): nothing loads it again. */
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
  /** Made with a history index (history-pages.ts); agents made before it have none, and are never indexed. */
  history?: true;
}
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
  /** Given back for a node with room to take: nothing more runs here. */
  handedBack?: true;
  /** The assistant message streaming now, as its latest message_update carried it. */
  partial?: unknown;
  /** What each running run's model responses used so far, for its end's webhook event. */
  usage?: Map<string, RunUsage>;
  /** Writing the latest run's `run.started` event, which the event of its end waits for. */
  started?: Promise<void>;
  /** Whether the run in progress has its webhook events written: its tenant had an endpoint for them as it began. */
  announcing?: boolean;
  /** The running run's tool calls that did not complete, for its outcome. */
  toolErrors?: ToolError[];
  /** Prompts sent with `whileRunning: "steer"` that a running turn took, each with that turn's request: they end with it. */
  steered?: Map<string, string>;
  /** The model run in progress (prompt, continue, resume) and what its events have finished, for snapshots. */
  turn?: { requestId: string; start?: number; messages: unknown[]; count: number; bytes: number; truncated?: boolean };
  /** The application's attached MCP server, over the connection `response` is. */
  attached?: AttachedServer;
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
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const validSessionId = (value: string) => /^client_[a-f0-9]{40}$/.test(value);
const has = (object: object, key: string) => Object.hasOwn(object, key);
/** `resume` continues a turn that waited on human input; the runtime makes it when the last input settles. */
const RUN_METHODS = ["prompt", "execute", "continue", "resume"];
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
/** Resumes of one run's turn before it fails as uncertain, so a turn that kills its node cannot loop. */
const MAX_RESUMES = 2;
/** A model turn that began can continue from its transcript on another node; a code execution cannot. */
const resumable = (request: RequestRecord) => ["prompt", "continue", "resume"].includes(request.method) && !!request.began;
/** Requests an agent may have accepted but not finished, queued runs included. */
const MAX_OPEN_REQUESTS = 32;
const REQUEST_METHODS = [...RUN_METHODS, "status", "abort", "history", "steer", "followUp", "configure"];
/** A configuration's fields only an upsert (the tenant making the agent again with its key) sets: see `reconfiguration`. */
const UPSERT_KEYS = ["provisionHash", "name", "type", "tools", "fileTools"];
/** A batch of answers from a request: `{ answers: [{ id, action, content?, from?, actor? }] }`. */
export const answerList = (body: any) => {
  if (!Array.isArray(body?.answers)) throw new HttpError(400, "Send { answers: [{ id, action, content?, from?, actor? }] }");
  return body.answers.map(({ id, ...answer }: any) => ({ id: String(id), body: answer }));
};
/** The id of the run that resumes a suspension: one per suspension, so every path that resumes it makes the same request. */
const resumeId = (suspension: string) => `resume_${hash(suspension).slice(0, 40)}`;
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
/** How long a tool call waits for an application to reconnect before failing as not run. */
const RECONNECT_GRACE_MS = 3_000;
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
/** A request as callers see it: queued parameters stay internal. */
const visible = ({ params: _params, announce: _announce, ...record }: RequestRecord): RequestRecord => record;

export interface ClientSessionOptions {
  secret: string; toolTimeoutMs?: number; ttlMs?: number; eventBytes?: number;
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
   * With a key scope it is `SCOPE_KEY`, and each call resolves through `scopedKey`.
   */
  apiKeyFor?: (tenant: string, provider: string, keyScope?: string) => Promise<ProviderKey | string | undefined> | ProviderKey | string | undefined;
  /** One model call's credentials for an agent with a key scope: the scope's entry, else the tenant's key, else (prepaid) the platform's. */
  scopedKey?: (tenant: string, keyScope: string, provider: string) => Promise<(Credentials & { platform: boolean }) | undefined>;
  /** The tenant's own model endpoints (tenants file), which its agents' models may name. */
  modelEndpoints?: (tenant: string) => ModelEndpoints;
  /** An identity token for `audience` (the runtime's signer), for model calls to a tenant's own endpoint. */
  modelToken?: (audience: string, claims: TokenClaims) => Promise<string>;
  /** At most this many hosted agents per tenant at once on this node (default: no per-tenant limit). */
  maxAgentsPerTenant?: number;
  /** A tenant's own limit, overriding `maxAgentsPerTenant`; read at each start, so changes apply to the next one. */
  agentLimitFor?: (tenant: string) => Promise<number | undefined> | number | undefined;
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
  /** Why a tenant may not start any run, code executions included (spent prepaid credit). Checked when a run is accepted and when it starts. */
  creditLimit?: (tenant: string) => Promise<Refusal | undefined>;
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
  /** Submit a request to an agent on whichever node serves it (resuming a suspension that expired). */
  submit?: (agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }) => Promise<RequestRecord>;
}
/** A definition resolved for an agent: its revision, agent configuration, client tools and tool sources. */
export type DefinitionConfig = { id: string; revision: number; config: Pick<AgentConfig, "model" | "systemPrompt" | "thinkingLevel" | "fileTools">; sources?: Sources };
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
  private closed = false;
  /** Set while the node drains or retires: runs that have not begun stay queued for the next owner. */
  draining = false;
  private releasing = false;

  constructor(supervisor: AgentSupervisor, options: ClientSessionOptions) {
    if (!options.storage && !options.root) throw new Error("ClientSessions needs storage or root");
    this.supervisor = supervisor;
    this.options = options;
    this.db = options.db;
    this.storage = options.storage ?? fileStorage(options.root!);
    this.historyIndex = new HistoryIndex(this.db, this.storage);
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
      else if (resumable(request) && (request.resumes ?? 0) < MAX_RESUMES) resumed.push(request);
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
    const result = (outcome.result ?? {}) as { error?: string | null; stopped?: string; inputs?: { id: string }[]; replyIndex?: number; messages?: number };
    const error = outcome.error ?? (typeof result.error === "string" ? result.error : undefined);
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
      console.error(JSON.stringify({ type: "run_event_failed", agent: session.header.id, error: errorText(error) }));
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
    else session.running.delete(record.id);
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
    void session.attached?.close();
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
      const reader = readers.get(res);
      if (!reader) { send(res, frame); continue; }
      const shown = reader.show(data);
      if (shown !== undefined) send(res, shown === data ? frame : `id: ${event.id}\ndata: ${JSON.stringify(shown)}\n\n`);
    }
    for (const wake of [...session.polls]) wake();
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
    if (snapshot.turn && Buffer.byteLength(JSON.stringify(snapshot)) > FRAME_BYTES) snapshot.turn = { ...snapshot.turn, messages: [], truncated: true };
    if (snapshot.turn && Buffer.byteLength(JSON.stringify(snapshot)) > FRAME_BYTES) snapshot.turn = { ...snapshot.turn, partial: null };
    return snapshot;
  }

  /**
   * Take a read-only subscriber's place (a watcher's, or a waiting poll's), within the agent's, its tenant's and
   * this node's bounds (429 past them); the function returned gives it back, once.
   */
  private hold(tenant: string, subscribers: number) {
    const reject = (scope: string) => new HttpError(429, `${scope} has too many event stream subscribers; retry later`);
    if (subscribers >= (this.options.maxWatchers ?? MAX_WATCHERS)) throw reject("This agent");
    if ((this.tenantWatching.get(tenant) ?? 0) >= (this.options.watcherLimitFor?.(tenant) ?? this.options.maxTenantWatchers ?? MAX_TENANT_WATCHERS)) throw reject("This tenant");
    if (this.watching >= (this.options.maxNodeWatchers ?? MAX_NODE_WATCHERS)) throw reject("This node");
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
  private subscribe(c: Context<ClientEnv>, session: Session, mode: "attach" | "watch", reader?: StreamReader) {
    // Gone while the request was authorized and its agent loaded: its close has fired already, so nothing
    // registered from here would ever be released. (No await follows, so it cannot close unseen after this.)
    if (gone(c)) return RESPONSE_ALREADY_SENT;
    const { snapshot, events } = this.replay(session, c.req.header("last-event-id"), c.req.query("snapshot") === "1");
    const release = mode === "watch" ? this.hold(session.header.tenant, session.watchers.size + session.polls.size) : undefined;
    const res = c.env.outgoing;
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
      session.response?.end();
      session.response = res;
      res.on("close", () => { if (session.response === res) session.response = undefined; });
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    if (mode === "attach") {
      // Each connection is a new MCP session with the application's attached server; `connection` names it.
      const attached = new AttachedServer(res);
      ready = { ...ready, connection: attached.id };
      void session.attached?.close();
      session.attached = attached;
    }
    res.write(`event: ready\ndata: ${JSON.stringify(ready)}\n\n`);
    if (snapshot) send(res, `id: ${snapshot.cursor}\ndata: ${JSON.stringify(reader ? reader.show(snapshot) : snapshot)}\n\n`);
    for (const event of events) {
      if (res.destroyed) break;
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
    const asked = c.req.query("snapshot") === "1";
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
    return json(c, 200, {
      cursor: events.at(-1)?.id ?? (cursor || session.cursor),
      events: [...snapshot ? [{ id: snapshot.cursor, data: shown(snapshot) }] : [], ...events.flatMap(({ id, data }) => {
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
    return session.starting ??= (async () => {
      await this.makeRoom(id, session.header.tenant);
      // Read before any response is counted against it.
      await this.spendOf(session);
      const { key: apiKey, platform } = await this.apiKey(session, session.header.config.model.provider, session.header.keyScope);
      session.platformKey = platform;
      const result = await this.supervisor.start(session.header.id, { ...session.header.config, apiKey, mounts: (session.header.mounts ?? []).map(({ path, mode }) => ({ path, mode })), ...(this.options.retry ? { retry: this.options.retry } : {}), ...(session.resuming.size ? { resume: true } : {}) }, {
        definitions: await this.toolset(session),
        spendLimit: async () => {
          const limited = await this.agentSpendLimit(session) ?? await this.options.spendLimit?.(session.header.tenant);
          return typeof limited === "string" ? limited : limited?.message;
        },
        call: (name, args, signal, context) => this.callTool(session, { name, args, signal, ...context }),
        file: ref => this.fileData(session, ref),
        modelAuth: () => this.modelAuth(session),
        fs: (op, args, signal) => this.fsCall(session, op, args, signal),
        search: query => this.searchTools(session, query),
        history: {
          // An agent from before the index has none, and keeps no backlog: its pages come from its log (see `historyPage`).
          // One made with it whose create failed before writing its row begins it now.
          indexed: async () => (await this.historyIndex.indexed(id)) ?? (session.header.history ? (await this.historyIndex.begin(id), 0) : null),
          write: chunk => this.historyIndex.write(id, session.claim, chunk),
        },
      }, session.claim);
      // Bootstrap history has been imported into the transcript; keep only one authority.
      if (session.header.config.initialMessages !== undefined) {
        delete session.header.config.initialMessages;
        await this.writeHeader(session);
      }
      session.handoff = result.resume;
      if (result.resume && "continue" in result.resume) this.publish(session, { type: "event", requestId: "", event: { type: "turn_resumed", reason: "The node running this turn was lost; it continues here, with unresolved tool calls marked unknown" } });
      else if (result.recovered) this.publish(session, { type: "event", requestId: "", event: { type: "turn_recovered", reason: "The runtime restarted during a turn; unresolved tool calls were marked unknown" } });
      // Starting can take longer than the idle timeout; the agent is fresh, not idle.
      session.lastActive = Date.now();
      return result;
    })().finally(() => { session.starting = undefined; this.supervisor.unreserve(id); });
  }

  /**
   * The agent's tool servers in order of precedence: the runtime feature's (a channel's
   * send_message), the application's attached server, file tools over its mounts, then its
   * definition's built-ins, OpenAPI specs and remote MCP servers.
   */
  private async servers(session: Session, tools = session.header.definitions, sources = session.header.sources, fileTools = session.header.config.fileTools): Promise<ToolServer[]> {
    const header = session.header;
    const tenant = header.tenant;
    const agent: AgentRef = { id: header.id, tenant, claim: session.claim };
    const feature = await this.options.hooks?.server?.(agent);
    session.channel = !!feature;
    const volumes = this.options.volumes;
    const view = (kind: ToolSourceView["kind"], server: ToolServer, extra: Partial<ToolSourceView> = {}): ToolServer =>
      ({ ...server, sources: async () => [{ kind, name: kind, status: "listed", ...extra, tools: await server.tools() }] });
    return [
      ...feature ? [view("channel", feature)] : [],
      { tools: () => defaultExposure(tools), call: call => this.callAttached(session, call), sources: async () => [{ kind: "application", name: "application", status: "listed", connected: !!session.attached?.open, tools: defaultExposure(tools) }] },
      ...volumes && header.mounts?.length ? [view("files", fileServer(volumes.definitions().filter(tool => fileTools !== false || tool.name === "present_file"), ({ name, args, signal }) => volumes.tool(this.toolContext(session), name, args, signal)))] : [],
      ...sources && header.definition && this.options.sources ? [this.options.sources.server({ tenant, agent: header.id, definition: header.definition.id, claim: session.claim, ...(header.identity ? { identity: header.identity } : {}), mounts: header.mounts ?? [], onWrite: this.toolContext(session).onWrite }, sources)] : [],
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

  /** The agent's tools from its servers (see `servers`). Records the route, and the servers for `toolSources`. */
  private async toolset(session: Session, tools = session.header.definitions, sources = session.header.sources, fileTools = session.header.config.fileTools) {
    const servers = await this.servers(session, tools, sources, fileTools);
    const { tools: definitions, route } = await compose(servers);
    session.route = route;
    session.servers = servers;
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
    const servers = this.supervisor.agents.has(id) && session.servers ? session.servers : await this.servers(session);
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
        ...(call.toolCallId ? { idempotencyKey: toolCallKey(session.header.id, call.toolCallId, call.innerCallId) } : {}),
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
        : error instanceof McpError && error.code === ErrorCode.ConnectionClosed ? new ToolFailure("connection_lost", `${error.message}. Its outcome is unknown: it may or may not have taken effect.`, true)
        : /^Could not connect to MCP server|MCP server .* (?:failed|refused|answered)/.test(errorText(error)) ? new ToolFailure("source_unavailable", errorText(error))
        : new ToolFailure("failed", errorText(error));
      (session.toolErrors ??= []).push({ tool: call.name, ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}), ...(call.innerCallId ? { innerCallId: call.innerCallId } : {}),
        code: failure.code, ...(failure.outcomeUnknown ? { outcomeUnknown: true } : {}), message: failure.message });
      throw failure;
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
      detail: { ...entry.detail, tool: call.name, source: call.name.includes("__") ? call.name.split("__")[0] : header.definitions.some(tool => tool.name === call.name) ? "application" : "runtime", arguments: shown.length > 4000 ? `${shown.slice(0, 4000)}…` : shown, argumentsHash: hashed },
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
   * What an upsert changes on an existing agent: a `configure` request's parameters bringing its configuration to the
   * one asked for, and its provision hash, so the same upsert again changes nothing. What configuration cannot change
   * (who it acts for, its definition, its mounts) is refused; initialMessages only apply when an agent is made.
   */
  private reconfiguration(header: SessionHeader, definitions: ToolDefinition[], config: Omit<AgentConfig, "id" | "directory" | "tools" | "apiKey">, metadata: AgentMetadata,
    mounts: unknown, origin: { definition: DefinitionRef } | undefined, identity: AgentIdentity | undefined, provisionHash: string) {
    const differs = (a: unknown, b: unknown) => canonical(a ?? null) !== canonical(b ?? null);
    const fixed = [
      ...differs(header.identity?.subject, identity?.subject) ? ["subject"] : [], ...differs(header.identity?.context, identity?.context) ? ["context"] : [],
      ...(header.definition?.id ?? null) !== (origin?.definition.id ?? null) ? ["definition"] : [],
      ...mounts !== undefined && differs((header.mounts ?? []).map(({ volumeId, path, mode }) => ({ volumeId, path, mode })), (mounts as { volumeId: string; path: string; mode?: string }[]).map(({ volumeId, path, mode }) => ({ volumeId, path, mode: mode ?? "rw" }))) ? ["mounts"] : [],
    ];
    if (fixed.length) throw new HttpError(409, `An existing agent's ${fixed.join(", ")} cannot change; delete it (DELETE /v1/agents/${header.id}) or use another idempotency key`);
    const current = header.config;
    const update: Record<string, unknown> = { provisionHash };
    // Only a definition's own fields are the agent's: the rest follow its definition.
    if (differs(current.model, config.model)) update.model = `${config.model.provider}/${config.model.id}`;
    if (current.thinkingLevel !== config.thinkingLevel && (current.thinkingLevel ?? "off") !== (config.thinkingLevel ?? "off")) update.thinkingLevel = config.thinkingLevel ?? "off";
    if ((current.systemPromptAppend ?? "") !== (config.systemPromptAppend ?? "")) update.systemPromptAppend = config.systemPromptAppend ?? "";
    if ((current.fileTools !== false) !== (config.fileTools !== false)) update.fileTools = config.fileTools !== false;
    if (!origin) {
      if (differs(current.systemPrompt, config.systemPrompt)) update.systemPrompt = config.systemPrompt ?? null;
      if (differs(current.modelHeaders, config.modelHeaders)) update.modelHeaders = config.modelHeaders ?? null;
      if (differs(header.definitions, definitions)) update.tools = definitions;
    }
    if ((header.metadata?.name ?? null) !== (metadata.name ?? null)) update.name = metadata.name ?? null;
    if ((header.metadata?.type ?? null) !== (metadata.type ?? null)) update.type = metadata.type ?? null;
    return update;
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
  async create(definitions: ToolDefinition[], config: Omit<AgentConfig, "id" | "directory" | "tools">, key: string = randomUUID(), metadata: AgentMetadata = {}, tenant: string, ttlMs?: number | null, mounts?: unknown, origin?: { definition: DefinitionRef; provision: unknown; overrides?: string[]; sources?: Sources }, identity?: AgentIdentity, access: { keyScope?: string; spendLimit?: number } = {}): Promise<{ id: string; token: string; expiresAt: number | null; [status: string]: unknown }> {
    metadata = agentMetadata(metadata);
    validateDefinitions(definitions);
    if (!validId(key)) throw new HttpError(400, "Invalid provisioning idempotency key");
    // A key whose agent was deleted or expired makes a fresh one: the next generation of the key, with an id and token
    // of its own, so the old agent's id is never reused and its token never works again.
    let id: string, scoped: string, existing: { value: SessionHeader } | undefined;
    for (let generation = 0; ; generation++) {
      // Idempotency keys are per tenant.
      scoped = `${tenant}:${key}${generation ? `#${generation}` : ""}`;
      id = this.agentId(tenant, `${key}${generation ? `#${generation}` : ""}`);
      // A deleted or expired agent (a tombstone once purged) is never loaded again; one another node serves only needs its header.
      existing = this.sessions.has(id) ? undefined : await this.readHeader(id);
      const header = this.sessions.get(id)?.header ?? existing?.value;
      if (!header || !(header.revoked || expired(header.expiresAt))) break;
    }
    const token = createHmac("sha256", this.options.secret).update(`client-v2:${scoped}`).digest("hex");
    const { apiKey: _key, ...safeConfig } = config;
    const provisionHash = hash(canonical({ ...origin ? { definition: origin.provision } : { definitions, config: safeConfig, ...(Object.keys(metadata).length ? { metadata } : {}), ...(mounts !== undefined ? { mounts } : {}) }, ...(identity ? { identity } : {}) }));
    // The same key with another configuration updates the agent: create or reconfigure.
    const changes = (header: SessionHeader) => header.provisionHash === provisionHash ? {} : { reconfigure: this.reconfiguration(header, definitions, safeConfig, metadata, mounts, origin, identity, provisionHash) };
    if (existing) {
      if (existing.value.tenant !== tenant) throw new HttpError(409, "Idempotency key belongs to another tenant");
      const changed = changes(existing.value);
      if (await this.ownerElsewhere(id)) return { id, token, expiresAt: existing.value.expiresAt, running: true, ...changed };
    }
    let session = await this.load(id);
    // Another create of this agent on this node is provisioning it: wait for what it makes. Two at once
    // would each take the claim, and the second acquire's new epoch would fence the first out.
    while (!session && this.loading.has(id)) session = await this.load(id);
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
        await this.makeRoom(id, tenant);
        const granted = this.options.volumes ? await this.options.volumes.mountsFor(tenant, id, mounts) : undefined;
        const ownership = this.options.ownership;
        if (ownership) {
          const acquired = await ownership.acquire(id);
          if ("owner" in acquired) throw new NotOwner(acquired.owner);
          claim = acquired.claim;
        }
        session = {
          header: { version: 3, id, tenant, digest: hash(token), expiresAt: ttlMs === null ? null : Date.now() + (ttlMs ?? this.options.ttlMs ?? 24 * 60 * 60 * 1000), revoked: false, metadata, definitions, config: safeConfig, provisionHash, ...(granted ? { mounts: granted } : {}), ...(origin ? { definition: origin.definition } : {}), ...(origin?.sources ? { sources: origin.sources } : {}), ...(origin?.overrides?.length ? { overrides: origin.overrides } : {}), ...(identity ? { identity } : {}), ...(access.keyScope ? { keyScope: access.keyScope } : {}), history: true },
          claim, requests: new Map(), running: new Map(), log: this.storage.log<JournalRecord>(this.journalKey(id), claim),
          cursor: Date.now() * 1000, events: [], eventBytes: 0, watchers: new Set(), polls: new Set(), inflight: 0, runs: Promise.resolve(), resuming: new Set(), settling: 0, lastActive: Date.now(),
        };
        // A conditional create: if a concurrent request made this agent first, retry as a load.
        await this.writeHeader(session);
        // A new agent's history is indexed from its first message; only agents from before the index have none.
        await this.historyIndex.begin(id);
        this.sessions.set(id, session);
        created = true;
        settle(session);
        if (granted) await this.options.volumes!.watch(id, tenant, [], granted, claim);
        if (access.spendLimit !== undefined) await this.setSpendLimit(session, access.spendLimit);
      } catch (error) {
        settle();
        if (!created) {
          this.supervisor.unreserve(id);
          if (claim) await this.options.ownership!.release(claim).catch(() => {});
          if (session?.fault?.message.includes("moved")) return this.create(definitions, config, key, metadata, tenant, ttlMs, mounts, origin, identity, access);
          throw error;
        }
        await this.discard(session!);
        throw error;
      }
    }
    try {
      await this.ensureStarted(session);
      const status = await this.supervisor.request(id, "status");
      return { id, token, expiresAt: session.header.expiresAt, ...status, ...changed };
    } catch (error) {
      // From the caller's view creation is atomic: an agent that never started is gone, so a retry with the same key starts afresh.
      if (created) await this.discard(session);
      throw error;
    }
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
      select a.id, a.name, a.type, a.model, a.expires_at, a.resume_failures, a.resume_after, n.node is not null as served from agents a
      left join actor_owners o on o.actor = a.id
      left join runtime_nodes n on n.node = o.node and n.session = o.session and n.expires_at > now()
      where a.tenant = $1 and not a.revoked and (a.expires_at is null or a.expires_at > $2) order by a.id`, [tenant, Date.now()]);
    return rows.map(row => {
      const local = this.sessions.get(row.id);
      const response = local?.response;
      const running = this.supervisor.agents.has(row.id) || (!local && row.served);
      return { id: row.id as string, name: row.name as string, type: row.type as string, model: row.model as string, connected: !!response && !response.destroyed, running: running as boolean, expiresAt: row.expires_at as number | null,
        resume: row.resume_failures ? { failures: row.resume_failures as number, after: Number(row.resume_after) } : null };
    });
  }

  /** Whether `id` is one of `tenant`'s live agents (one read, not a listing). */
  async owns(id: string, tenant: string) {
    if (!validSessionId(id)) return false;
    const { rowCount } = await this.db.query("select 1 from agents where id = $1 and tenant = $2 and not revoked and (expires_at is null or expires_at > $3)", [id, tenant, Date.now()]);
    return !!rowCount;
  }

  async inspect(id: string, tenant: string) {
    const metadata = (await this.owns(id, tenant)) ? (await this.list(tenant)).find(agent => agent.id === id) : undefined;
    const session = metadata && await this.load(id);
    if (!metadata || !session) throw new HttpError(404, "Agent not found");
    const definition = session.header.definition && { id: session.header.definition.id, revision: session.header.definition.revision };
    return { ...metadata, ...(definition ? { definition } : {}), tools: session.header.definitions, systemPrompt: session.header.config.systemPrompt ?? "",
      ...(session.header.config.systemPromptAppend ? { systemPromptAppend: session.header.config.systemPromptAppend } : {}),
      ...(session.header.config.fileTools === false ? { fileTools: false } : {}), mounts: session.header.mounts ?? [], keyScope: session.header.keyScope ?? null, modelHeaders: session.header.config.modelHeaders ?? null,
      spendLimit: await this.spendOf(session).then(spend => spend && { usd: spend.usd, spent: spend.spent }),
      cursor: session.cursor, events: session.events.map(({ id, data }) => ({ id, data })), requests: [...session.requests.values()].map(visible) };
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
    if (rows[0]) console.error(JSON.stringify({ type: "agent_resume_failed", agent: id, failures: rows[0].resume_failures, error: errorText(error) }));
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
   * what the running agent has not indexed yet from it. An agent never indexed (it predates the
   * index) is indexed now, from its log, once.
   */
  private async historyPage(session: Session | { header: { id: string }; unloaded: true }, query: { before?: string; limit?: string }): Promise<HistoryPage> {
    const before = query.before === undefined ? undefined : Number(query.before);
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw new HttpError(400, "before is a message index");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, "limit is 1 to 500 messages");
    const id = session.header.id;
    // An agent still starting answers nothing yet: wait for it (or, should it fail, read the log).
    if (!("unloaded" in session)) await session.starting?.catch(() => {});
    let tail = !("unloaded" in session) && this.supervisor.agents.has(id) ? await this.supervisor.request(id, "historyTail" as RequestMethod) as HistoryTail | null : undefined;
    if (!tail) {
      // The index should have every message the agent's runs reported, or the running agent the rest. An agent
      // without one (made before the index), one behind (a stop that could not write its last chunks), or a running
      // agent keeping no backlog: the rest is read from its log, whole, as a full history read does. Nothing is
      // indexed here; an agent's own process indexes from where its index ends, and one without an index never is.
      const indexed = await this.historyIndex.indexed(id);
      const reported = "unloaded" in session ? await this.historyIndex.reported(id) : Math.max(0, ...[...session.requests.values()].map(record => Number((record.outcome?.result as { messages?: unknown } | undefined)?.messages) || 0));
      if (tail === null || indexed === undefined || indexed < reported) tail = await this.supervisor.backlog(id, indexed ?? 0);
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
    app.post(`${agent}/links`, async c => {
      const session = c.var.session;
      const input = await readJson(body(c), 4096);
      const method = input?.method ?? "GET";
      if (method !== "GET" && method !== "PUT") throw new HttpError(400, "method must be GET or PUT");
      const target = this.mounted(session, input?.path, method === "PUT");
      if (!this.options.links) throw new HttpError(404, "Links are not enabled on this runtime");
      const contentType = input.contentType === undefined ? undefined : declaredType(input.contentType);
      if (input.contentType !== undefined && !contentType) throw new HttpError(400, "contentType must be a specific content type");
      const { tenant: _tenant, volume: _volume, path: _path, ...link } = this.options.links.sign({ tenant: session.header.tenant, volume: target.mount.volumeId, path: target.path, method, expiresIn: input.expiresIn, ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}), ...(contentType ? { contentType } : {}) });
      return json(c, 201, { ...link, path: target.show(target.path) });
    });
    // A file for request `:request` to attach by the path this answers with; the body streams to storage.
    app.put(`${agent}/uploads/:request/:name`, async c => json(c, 201, await this.upload(c.var.session, c.req.param("request"), c.req.param("name"), body(c) as AsyncIterable<Uint8Array>, c.req.header("content-type"))));
    app.get(`${agent}/state`, c => {
      const session = c.var.session;
      return json(c, 200, { cursor: session.cursor, requests: [...session.requests.values()].map(visible) });
    });
    app.post(`${agent}/requests`, async c => {
      const { status, record } = await this.accept(c.var.session, await readJson(body(c), FRAME_BYTES));
      return json(c, status, record);
    });
    app.get(`${agent}/requests/:request`, c => {
      const record = c.var.session.requests.get(c.req.param("request"));
      if (!record) throw new HttpError(404, "Unknown request");
      return json(c, 200, visible(record));
    });
    // The application's JSON-RPC messages to the runtime, on the connection it names.
    app.post(`${agent}/mcp`, async c => {
      const attached = c.var.session.attached;
      if (!attached?.open || c.req.header("x-agent-connection") !== attached.id) throw new HttpError(409, "Not the agent's current connection; reconnect");
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
    app.onError((error, c) => json(c, errorStatus(error, 500), { error: errorText(error), ...((error as { input?: unknown }).input ? { input: (error as { input?: unknown }).input } : {}) }));
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
    for (const key of ["keyScope", "spendLimit", "modelHeaders", ...UPSERT_KEYS]) if (body.method === "configure" && !trusted && Object.hasOwn(body.params, key)) throw new HttpError(403, `Only the tenant can change an agent's ${key}`);
    const spendLimit = body.method === "configure" && Object.hasOwn(body.params, "spendLimit") ? spendInput(body.params.spendLimit) : undefined;
    if (applying && (!trusted || !this.options.definitionFor || Object.keys(body.params).length !== 1 || typeof body.params.definition?.id !== "string")) throw new HttpError(400, "Apply a definition with PATCH /v1/definitions/<id> and apply: \"all\"");
    try {
      if (body.method === "configure" && !applying) { const { spendLimit: _limit, provisionHash: _hash, name: _name, type: _type, ...update } = body.params; configurationUpdate(update, this.options.modelEndpoints?.(session.header.tenant)); }
      // Assistant and tool-result history is runtime-owned; callers may only add user input.
      if (["prompt", "steer", "followUp"].includes(body.method) && body.params.message !== undefined) validateUserMessages(Array.isArray(body.params.message) ? body.params.message : [body.params.message]);
    } catch (error) { throw new HttpError(400, errorText(error)); }
    const fingerprint = hash(canonical({ method: body.method, params: body.params }));
    const existing = () => {
      const record = session.requests.get(body.id);
      if (record && record.fingerprint !== fingerprint) throw new HttpError(409, "Request ID reused with different arguments");
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
    const isMessage = ["prompt", "steer", "followUp"].includes(body.method);
    if (params.from !== undefined && !isMessage) throw new HttpError(400, "from is only for messages (prompt, steer, followUp)");
    if (params.metadata !== undefined && !isMessage) throw new HttpError(400, "metadata is only for messages (prompt, steer, followUp)");
    if (params.whileRunning !== undefined && (body.method !== "prompt" || !["queue", "steer"].includes(params.whileRunning))) throw new HttpError(400, "whileRunning is queue or steer, for a prompt");
    if (params.whileRunning === "queue") delete params.whileRunning;
    // A message records the request that sent it, so an application can match it to its own.
    if (isMessage) params.requestId = body.id;
    try {
      if (params.from !== undefined) params.from = senderInput(params.from);
      if (params.metadata !== undefined) params.metadata = metadataInput(params.metadata);
      // The sender acts, unless the application names someone else.
      actor = actorInput(rawActor) ?? (isRun ? params.from?.id : undefined);
      // A resumed turn acts for whoever the suspended one did.
      if (body.method === "resume") actor = session.requests.get(params.suspension)?.actor;
    } catch (error) { throw new HttpError(400, errorText(error)); }
    const limited = body.method === "resume" ? undefined : await this.runLimit(session, body.method);
    if (limited) throw typeof limited === "string" ? new HttpError(402, limited) : limited;
    const queued = QUEUED_METHODS.includes(body.method);
    // Reads and aborts need no process; queued requests start it (if at all) when their turn comes.
    if (!queued && !["history", "status", "abort"].includes(body.method)) await this.ensureStarted(session);
    // Concurrent retries may have waited on the same process startup.
    const raced = existing();
    if (raced) return { status: 200, record: visible(raced) };
    // Attached files are saved and referenced before the request is: its params keep references, never bytes.
    if (["prompt", "steer", "followUp"].includes(body.method) && (params.files !== undefined || params.images !== undefined)) {
      const { files, images, ...rest } = params;
      params = { ...rest, files: await this.attach(session, body.id, files, images) };
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
      ...(body.method === "resume" ? { suspension: params.suspension } : {}),
    });
    await this.commit(session, true);
    if (queued) this.enqueue(session, record, params);
    else void this.run(session, record, params);
    if (params.whileRunning === "steer") await this.steerTurn(session, params);
    return { status: 202, record: visible(record) };
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
    return fileRef(volumes, tenant, target.mount.volumeId, target.show(entry.path), { ...entry, contentType: await volumes.contentType(tenant, entry.path, entry) });
  }

  /**
   * A message's attachments as file references: files already in the agent's mounts ({path}), and
   * small files sent inline ({name, data: base64, contentType?}, and legacy `images`), saved first.
   * Everything is checked before anything is saved.
   */
  private async attach(session: Session, requestId: string, files: unknown = [], images: unknown = []): Promise<FileRef[]> {
    if (!Array.isArray(files) || !Array.isArray(images)) throw new HttpError(400, "files must be an array");
    const inputs = [...files, ...images.map((image, index) => ({ name: `image-${index + 1}.${String(image?.mimeType ?? "").split("/")[1] ?? "png"}`, data: image?.data, contentType: image?.mimeType }))];
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
        refs.push(await fileRef(volumes!, tenant, target.mount.volumeId, target.show(saved.path), { ...saved, contentType: saved.contentType! }));
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
    if (!header.keyScope || !this.options.scopedKey) throw new Error("This agent's model takes no per-call credentials");
    const resolved = await this.options.scopedKey(header.tenant, header.keyScope, provider);
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
    const live = this.supervisor.agents.has(id);
    if (record.method === "history") return this.history(session);
    if (record.method === "status" && !live) return { running: false };
    // Aborting a suspended turn cancels its inputs: the turn is closed without the model.
    if (record.method === "abort") await this.cancelInputs(session, "aborted");
    if (record.method === "abort" && !live) return { aborted: false, running: false };
    if (record.method === "configure") {
      const applied = params.definition !== undefined ? await this.definitionUpdate(session) : undefined;
      // An upsert's own fields (see `reconfiguration`): what the agent is called, and the configuration it now matches.
      const { provisionHash, name, type, ...given } = params;
      const { keyScope, ...update } = (applied?.update ?? configurationUpdate(given, this.options.modelEndpoints?.(session.header.tenant))) as ReturnType<typeof configurationUpdate> & { fileTools?: boolean };
      // A new model may belong to another provider, and a new key scope has keys of its own: the agent needs that provider's key.
      const resolved = update.model || keyScope !== undefined ? await this.apiKey(session, (update.model ?? session.header.config.model).provider, keyScope === undefined ? session.header.keyScope : keyScope ?? undefined) : undefined;
      const apiKey = resolved?.key;
      if (resolved && this.options.apiKeyFor && !apiKey) throw new Error(`No ${(update.model ?? session.header.config.model).provider} API key is configured for this tenant; set one with PUT /v1/providers/${(update.model ?? session.header.config.model).provider}/key`);
      // An agent that is not running takes its new configuration when it next starts.
      const result = live ? await this.supervisor.request(id, "configure", {
        ...update, ...apiKey ? { apiKey } : {},
        // Replacing the application's tools keeps the runtime's own.
        ...update.tools || "fileTools" in update ? { tools: await this.toolset(session, update.tools ?? session.header.definitions, applied ? applied.sources : session.header.sources, "fileTools" in update ? update.fileTools : session.header.config.fileTools) } : {},
      }) : { configured: true };
      const { tools, ...config } = update;
      if (resolved && live) session.platformKey = resolved.platform;
      if (keyScope) session.header.keyScope = keyScope; else if (keyScope === null) delete session.header.keyScope;
      if (tools !== undefined) session.header.definitions = tools;
      session.header.config = { ...session.header.config, ...config };
      if (applied) {
        session.header.definition = applied.definition;
        if (applied.sources) session.header.sources = applied.sources; else delete session.header.sources;
      } else if (session.header.definition) {
        // A model or thinking level configured directly is the agent's own from then on.
        const overrides = new Set([...session.header.overrides ?? [], ...OVERRIDES.filter(key => (update as Record<string, unknown>)[key] !== undefined)]);
        if (overrides.size) session.header.overrides = [...overrides];
      }
      if (provisionHash !== undefined) session.header.provisionHash = provisionHash;
      if (name !== undefined || type !== undefined) {
        const metadata = { ...session.header.metadata, ...name !== undefined ? { name } : {}, ...type !== undefined ? { type } : {} };
        session.header.metadata = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== null)) as AgentMetadata;
      }
      await this.writeHeader(session);
      return result;
    }
    if (record.method === "resume") params = await this.resumeParams(session, record.suspension!);
    try {
      return await this.supervisor.request(id, method, params, RUN_METHODS.includes(record.method)
      ? event => {
          // Failed calls report zero usage; count only responses the provider completed.
          // Responses through the tenant's own endpoint count under it: `chiridion/openrouter/<model>`.
          const via = this.endpoint(session) ? `${session.header.config.model.provider}/` : "";
          const { identity, keyScope } = session.header;
          const run = { requestId: record.id, ...(record.actor ? { actor: record.actor } : {}), ...(identity ? { identity } : {}), ...(keyScope ? { keyScope } : {}) };
          if (event?.type === "message_end" && event.message?.role === "assistant" && event.message.usage && event.message.stopReason !== "error") {
            this.options.onUsage?.(session.header.tenant, id, { ...event.message, ...run, provider: via + event.message.provider, platform: !!session.platformKey });
            this.spent(session, responseCost(event.message.usage));
            this.tally(session, record.id, event.message.usage);
          }
          if (event?.type === "compaction_usage" && event.usage) {
            this.options.onUsage?.(session.header.tenant, id, { ...event, ...run, provider: via + event.provider, kind: "compaction", platform: !!session.platformKey });
            this.spent(session, responseCost(event.usage));
            this.tally(session, record.id, event.usage);
          }
          // A prompt steered into this turn has been taken: it ends with the turn.
          const taken = event?.type === "message_end" && event.message?.role === "user" ? event.message.requestId : undefined;
          if (taken && taken !== record.id && session.running.get(taken)?.method === "prompt") (session.steered ??= new Map()).set(taken, record.id);
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
  private async definitionUpdate(session: Session) {
    const current = session.header.definition;
    if (!current) throw new Error("This agent was not made from a definition");
    const resolved = await this.options.definitionFor!(session.header.tenant, current.id);
    // The attached server's tools stay, as does the agent's own configuration; the tools list is rebuilt with the definition's sources.
    const config = Object.fromEntries(Object.entries(resolved.config).filter(([key]) => !session.header.overrides?.includes(key))) as Partial<DefinitionConfig["config"]>;
    return { update: { ...config, tools: session.header.definitions }, definition: { ...current, revision: resolved.revision }, sources: resolved.sources };
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
          if (limited) throw typeof limited === "string" ? new HttpError(402, limited) : limited;
        }
        try { await this.ensureStarted(session); }
        catch (error) {
          // No room here for a run this node took over: another node with room takes it (see `handBack`).
          if (this.options.ownership && session.inherited?.has(record.id) && [429, 503].includes((error as { status?: number }).status ?? 0)) { await this.handBack(session); return; }
          throw error;
        }
        if (this.draining || session.handedBack) return;
        // Work taken over runs: any put-off loads of it are over.
        if (session.inherited?.delete(record.id)) void this.db.query("update agents set resume_failures = 0, resume_after = null where id = $1 and resume_failures > 0", [session.header.id]).catch(() => {});
        // Durable before any side effect: after a crash this run is "began", never repeated.
        const { params: _params, ...rest } = session.requests.get(record.id)!;
        record = this.upsertRequest(session, { ...rest, began: Date.now(), ...(session.resuming.has(record.id) ? { resumes: (rest.resumes ?? 0) + 1 } : {}) });
        // Code has no effect outside its sandbox until it calls a tool, and every tool call
        // makes this record durable first (`beforeEffect`; the application's tools do it when
        // their call is recorded, which is appended after it). So an execution needs no commit of its
        // own here: one that crashes before a tool call is simply run again.
        if (record.method === "execute") session.beginning = {};
        else await this.commit(session, true);
        this.hook("runStarted", session, record);
        if (session.announcing) {
          session.started = enqueueEvents(this.db, [this.runEvent(session, record)])
            .catch(error => console.error(JSON.stringify({ type: "run_event_failed", agent: session.header.id, error: errorText(error) })));
        }
        if (record.method !== "execute") session.turn = { requestId: record.id, messages: [], count: 0, bytes: 0 };
      }
      if (RUN_METHODS.includes(record.method)) {
        session.activeSince = Date.now();
        session.outputs = { files: new Map(), presented: [] };
        session.toolErrors = undefined;
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
    if (this.closed || session.fault || session.requests.get(record.id)?.state !== "running") return;
    const { params: _params, ...finished } = record;
    // Until the response is published, a drain or release must not close the stream and drop it.
    session.settling++;
    try {
      const run = RUN_METHODS.includes(record.method);
      const announcing = run && !!session.announcing;
      const completed = this.upsertRequest(session, { ...finished, state: "completed", outcome: value, endedAt: Date.now(), ...(announcing ? { announce: true as const } : {}) });
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

  /** Give the agent a budget of `usd` from now (null: none). A new value starts counting from zero. */
  private async setSpendLimit(session: Session, usd: number | null) {
    const id = session.header.id, setAt = Date.now();
    if (usd === null) await this.db.query("delete from agent_spend_limits where agent = $1", [id]);
    else await this.db.query("insert into agent_spend_limits (agent, usd, spent, set_at) values ($1, $2, 0, $3) on conflict (agent) do update set usd = excluded.usd, spent = 0, set_at = excluded.set_at", [id, usd, setAt]);
    session.spend = usd === null ? null : { usd, spent: 0, setAt };
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

  /** Why the agent may not spend more on models: it has reached its own spend limit. */
  private async agentSpendLimit(session: Session): Promise<string | undefined> {
    const spend = await this.spendOf(session);
    if (!spend || spend.spent < spend.usd) return undefined;
    return `This agent has reached its spend limit of ${dollars(spend.usd)} (${dollars(spend.spent)} spent since it was set); raise it with PATCH /v1/agents/${session.header.id}/configuration {"spendLimit": {"usd": …}}`;
  }

  /** Why a run may not start: a model run's spend limit (a monthly cap or spent credit), or for any run, spent credit. */
  private async runLimit(session: Session, method: string) {
    const tenant = session.header.tenant;
    if (MODEL_RUNS.includes(method)) return await this.agentSpendLimit(session) ?? this.options.spendLimit?.(tenant);
    if (RUN_METHODS.includes(method)) return this.options.creditLimit?.(tenant);
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
    catch (error) { console.error(JSON.stringify({ type: "session_hook_failed", hook: name, error: errorText(error) })); }
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
      onError: (error, stage) => console.error(JSON.stringify({ type: "tool_search_rerank_failed", reranker: stage.kind, agent: session.header.id, error: errorText(error) })),
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
      return await attached.client.request({ method: "tools/call", params: callParams(name, args, _meta, { inputResponses, requestState, elicit }) } as never, CallToolResultSchema,
        { signal, timeout, maxTotalTimeout: Math.max(timeout, TOOL_DEADLINES.maxTotalMs), resetTimeoutOnProgress: true, onprogress: progress => onProgress?.(progress) }) as McpResult;
    } catch (error) {
      if (!signal.aborted && error instanceof McpError && error.code === ErrorCode.RequestTimeout) throw timedOut(timeout);
      if (!signal.aborted && error instanceof McpError && error.code === ErrorCode.ConnectionClosed) {
        throw new ToolFailure("connection_lost", `${error.message}, after the call was sent to the application. Its outcome is unknown: it may or may not have taken effect.`, true);
      }
      throw error;
    } finally { session.inflight--; }
  }

  /** The attached server once its MCP session is up, waiting briefly for an application that is reconnecting. */
  private async attachedServer(session: Session, signal: AbortSignal) {
    for (const until = Date.now() + RECONNECT_GRACE_MS; ;) {
      const attached = session.attached;
      if (attached?.open && await attached.ready.then(() => true, () => false) && attached.open) return attached;
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
    // Tool calls in flight end as unknown: the connection they were on is closed.
    void session.attached?.close();
    await this.commit(session, true);
  }

  /**
   * Purge deleted and expired agents that no live node holds, `limit` at a time;
   * returns how many were purged. Everything the agent stored goes: its journal and
   * transcript (segments, snapshots, blobs), tail rows, local directory, schedules,
   * channel bindings and volume watches. The row stays as a tombstone with only the
   * agent's identity, so its id is never reused and requests for it get 404 or 410;
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
        await sql.query("delete from channel_agents where agent = $1", [id]);
        await sql.query("delete from channel_conversations where agent = $1", [id]);
        await sql.query("delete from volume_watchers where agent = $1", [id]);
        await sql.query("delete from agent_inputs where agent = $1", [id]);
        await sql.query("delete from agent_spend_limits where agent = $1", [id]);
        const tombstone = { version: 3, id, tenant: header.tenant, digest: header.digest, expiresAt: header.expiresAt, revoked: true, provisionHash: header.provisionHash, purged: true };
        await sql.query("update agents set header = $2, name = $1, type = 'general', revoked = true, purged_at = $3, purge_claimed_until = null where id = $1",
          [id, JSON.stringify(tombstone), Date.now()]);
      });
      return true;
    } finally {
      if (claim) await ownership!.release(claim).catch(() => {});
    }
  }

  /** Requests being worked on: runs that began, until their outcome is published, and other open requests; not queued runs or resumes. */
  inFlight() {
    let count = 0;
    for (const session of this.sessions.values()) count += this.working(session);
    return count;
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
      if (!session.header.revoked && expired(session.header.expiresAt, now)) {
        void this.remove(id).then(() => this.supervisor.stop(id)).catch(() => {});
        continue;
      }
      for (const res of this.streams(session)) send(res, ": heartbeat\n\n");
      if (session.activeSince !== undefined && now - session.activeSince >= ACTIVE_REPORT_MS) this.reportActive(session, true, now);
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
    if (session.claim) await this.options.ownership!.release(session.claim).catch(() => {});
  }

  /** This node fenced itself: another node may already be serving the agent, so stop writing, stop the agent, forget it. */
  private async lost(session: Session) {
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

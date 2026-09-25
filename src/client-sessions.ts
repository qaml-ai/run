import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { AgentConfig, ToolDefinition } from "./protocol.ts";
import { errorText } from "./protocol.ts";
import { AgentSupervisor } from "./supervisor.ts";
import { configurationUpdate } from "./session-config.ts";
import { validateDefinitions } from "./tool-policy.ts";
import { validateUserMessages } from "./history.ts";
import { canonical } from "../shared/durable-json.ts";
import type { AppendLog } from "../shared/append-log.ts";
import { fileStorage, type Storage } from "../shared/storage.ts";
import { FRAME_BYTES, type ClientEvent, type Outcome, type RequestMethod, type RequestRecord } from "../shared/client-protocol.ts";
import { agentMetadata, type AgentMetadata } from "../shared/agent-metadata.ts";
import { DEFAULT_TENANT } from "./tenants.ts";
import { scheduleInput, type Scheduler } from "./scheduler.ts";
import { errorStatus, HttpError, readJson } from "./http.ts";
import { VolumeService, type Mount } from "./volumes.ts";
import { databaseUnavailable, type Db, type Sql } from "./db.ts";
import { LostClaim, underClaim, type Claim, type Ownership } from "./ownership.ts";
import { deleteTail } from "./log-tail.ts";
import type { DefinitionRef } from "./definitions.ts";
import type { Sources, ToolSources } from "./tool-sources.ts";
import { contentResult, type McpResult } from "./mcp-results.ts";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AttachedServer } from "./attached.ts";
import { actorInput, type AgentIdentity } from "./identity.ts";
import { compose, defaultExposure, valueServer, type ToolCall, type ToolServer } from "./tool-servers.ts";

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
  /** Owning tenant; absent on sessions created before tenants existed (the default tenant). */
  tenant?: string;
  metadata?: AgentMetadata; definitions: ToolDefinition[]; provisionHash: string; config: SessionConfig;
  /** Volumes the agent's file tools can reach; absent on sessions created before volumes existed. */
  mounts?: Mount[];
  /** A purged agent's tombstone keeps only its identity (see `purge`): nothing loads it again. */
  purged?: true;
  /** The definition and revision the agent was made from, or last had applied. */
  definition?: DefinitionRef;
  /** That revision's server-side tool sources, their secrets sealed under the definition. */
  sources?: Sources;
  /** Who the agent acts for, and context for its tool servers: set at creation by the tenant, never by the agent. */
  identity?: AgentIdentity;
}
/** Upserts of request records, appended as their state changes. Journals from before tool calls were MCP also hold call records, which are skipped. */
type JournalRecord = { t: "request"; record: RequestRecord };
type ClientEnv = { Bindings: HttpBindings & { operatorTenant?: string }; Variables: { session: Session } };
type BufferedEvent = { id: number; bytes: number; data: ClientEvent };
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
  response?: ServerResponse; starting?: Promise<unknown>;
  /** The application's attached MCP server, over the connection `response` is. */
  attached?: AttachedServer;
  /** Tool calls to the application in flight: the agent is busy until they settle. */
  inflight: number;
  /** Which tool server answers each of the running agent's tools. */
  route?: Map<string, ToolServer>;
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
  /** Since when a run's active time has not been reported (`onActive`). */
  activeSince?: number;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const validSessionId = (value: string) => /^client_[a-f0-9]{40}$/.test(value);
const has = (object: object, key: string) => Object.hasOwn(object, key);
const RUN_METHODS = ["prompt", "execute", "continue"];
/** Runs that call the model; code executions do not, so spend limits leave them alone. */
const MODEL_RUNS = ["prompt", "continue"];
/** A running run's active time is reported at least this often. */
const ACTIVE_REPORT_MS = 60_000;
/** Resumes of one run's turn before it fails as uncertain, so a turn that kills its node cannot loop. */
const MAX_RESUMES = 2;
/** A model turn that began can continue from its transcript on another node; a code execution cannot. */
const resumable = (request: RequestRecord) => ["prompt", "continue"].includes(request.method) && !!request.began;
/** Requests an agent may have accepted but not finished, queued runs included. */
const MAX_OPEN_REQUESTS = 32;
const REQUEST_METHODS = [...RUN_METHODS, "status", "abort", "history", "steer", "followUp", "configure"];
/** Settled records kept for idempotent retries once the journal is folded. */
const RETAINED_SETTLED = 256;
const FOLD_AFTER_RECORDS = 2048;
const MAX_BUFFERED_EVENTS = 512;
/** How long a tool call waits for an application to reconnect before failing as not run. */
const RECONNECT_GRACE_MS = 3_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
const visible = ({ params: _params, ...record }: RequestRecord): RequestRecord => record;

export interface ClientSessionOptions {
  secret: string; toolTimeoutMs?: number; ttlMs?: number; eventBytes?: number;
  /** Headers and the tenant index. */
  db: Db;
  /** Single-host shorthand for `storage: fileStorage(root)`, where journals are kept. */
  root?: string;
  storage?: Storage;
  /** Key prefix for journals within `storage`. */
  prefix?: string;
  /** With ownership, each agent is served by one node at a time. */
  ownership?: Ownership;
  /** Fallback provider key when `apiKeyFor` is absent (single-tenant hosts and tests). */
  apiKey?: string;
  /** The provider key an agent uses, resolved per tenant at process start; never persisted. `platform` keys are not the tenant's own. */
  apiKeyFor?: (tenant: string, provider: string) => Promise<ProviderKey | string | undefined> | ProviderKey | string | undefined;
  /** At most this many hosted agents per tenant at once on this node (default: no per-tenant limit). */
  maxAgentsPerTenant?: number;
  /** @deprecated The older name of `maxAgentsPerTenant`. */
  maxProcessesPerTenant?: number;
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
  /** Called with time an agent spent in runs (model calls and tool execution), at least every minute while one runs. */
  onActive?: (tenant: string, agentId: string, ms: number) => void;
  hooks?: SessionHooks;
  /** Volumes: new agents get mounts (a workspace by default) and file tools over them. */
  volumes?: VolumeService;
  /** A definition's current configuration, to apply to an agent made from it (`configure` with `definition`). */
  definitionFor?: (tenant: string, id: string) => Promise<DefinitionConfig>;
  /** Tools the runtime calls itself (MCP servers), from the agent's definition. */
  sources?: ToolSources;
}
/** A definition resolved for an agent: its revision, agent configuration, client tools and tool sources. */
export type DefinitionConfig = { id: string; revision: number; config: Pick<AgentConfig, "model" | "systemPrompt" | "thinkingLevel">; sources?: Sources };
/** One model response's usage; `kind` separates compaction summaries from the agent's turns. */
export type UsageRecord = { provider?: string; model?: string; usage: any; timestamp?: number; kind?: "turn" | "compaction"; platform?: boolean };
/** Why runs are refused: a message (402), or an error with its own status. */
export type Refusal = string | HttpError;
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
    const columns = [header.id, header.tenant ?? DEFAULT_TENANT, JSON.stringify(header), header.metadata?.name ?? header.id, header.metadata?.type ?? "general",
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
      // Cursors restart above any cursor from an earlier process, so clients see a gap, never a repeat.
      cursor: Date.now() * 1000, events: [], eventBytes: 0, inflight: 0, runs: Promise.resolve(), resuming: new Set(), settling: 0, lastActive: Date.now(),
    };
    for (const record of await log.read()) this.apply(session, record);
    if (header.version !== 3 || header.id !== id) throw new Error("Invalid client session header");
    // Loading means no process anywhere owns the session, so nothing it recorded is still running.
    // Queued runs that never began are safe to run now. A turn that began resumes from its
    // transcript, a bounded number of times; anything else that began has an unknown outcome.
    const queued: RequestRecord[] = [];
    const resumed: RequestRecord[] = [];
    for (const request of [...session.running.values()]) {
      if (RUN_METHODS.includes(request.method) && !request.began && request.params !== undefined) queued.push(request);
      else if (resumable(request) && (request.resumes ?? 0) < MAX_RESUMES) {
        resumed.push(this.upsertRequest(session, { ...request, resumes: (request.resumes ?? 0) + 1 }));
      } else this.upsertRequest(session, { ...request, state: "completed", endedAt: Date.now(), outcome: { error: "The runtime restarted during this request", uncertain: true } });
    }
    await log.flush(true);
    if (claim && !this.options.ownership!.holds(claim)) throw new HttpError(503, "This node lost ownership of the agent; retry");
    this.sessions.set(id, session);
    for (const record of resumed) { session.resuming.add(record.id); this.enqueue(session, record, undefined); }
    for (const record of queued.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) this.enqueue(session, record, record.params);
    return session;
  }

  private apply(session: Session, entry: JournalRecord) {
    if (entry.t === "request") this.track(session, entry.record);
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
    session.response?.destroy();
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
    let text = JSON.stringify(data);
    if (Buffer.byteLength(text) > FRAME_BYTES) {
      // Control outcomes remain in the journal; oversized display events are explicit gaps.
      data = { type: "event", requestId: "", event: { type: "event_omitted", reason: "Event exceeded transport limit" } };
      text = JSON.stringify(data);
    }
    const event: BufferedEvent = { id: ++session.cursor, bytes: Buffer.byteLength(text), data };
    session.events.push(event);
    session.eventBytes += event.bytes;
    session.lastActive = Date.now();
    const limit = this.options.eventBytes ?? 2 * 1024 * 1024;
    while (session.events.length > 1 && (session.events.length > MAX_BUFFERED_EVENTS || session.eventBytes > limit)) session.eventBytes -= session.events.shift()!.bytes;
    const res = session.response;
    if (res && !res.destroyed) {
      const frame = `id: ${event.id}\ndata: ${text}\n\n`;
      if (res.writableLength + Buffer.byteLength(frame) > 2 * FRAME_BYTES) res.destroy();
      else res.write(frame);
    }
  }

  private busy(session: Session) {
    return !!session.starting || session.settling > 0 || session.inflight > 0 || session.running.size > 0;
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
    const tenantOf = (session: Session) => session.header.tenant ?? DEFAULT_TENANT;
    const hosted = (session: Session) => this.supervisor.agents.has(session.header.id);
    const live = (filter: (session: Session) => boolean) => [...this.sessions.values()]
      .filter(session => session.header.id !== id && hosted(session) && filter(session));
    // The tenant's agents on this node: hosted, starting, or with a slot reserved (a create not yet loaded).
    const tenantCount = () => {
      const ids = new Set<string>();
      for (const session of this.sessions.values()) {
        const other = session.header.id;
        if (tenantOf(session) === tenant && (this.supervisor.agents.has(other) || this.supervisor.starting.has(other))) ids.add(other);
      }
      for (const [other, owner] of this.supervisor.reserved) if ((owner ?? DEFAULT_TENANT) === tenant) ids.add(other);
      ids.delete(id);
      return ids.size;
    };
    const evictIdle = async (candidates: Session[]) => {
      const idle = candidates.filter(session => !this.busy(session)).sort((a, b) => a.lastActive - b.lastActive)[0];
      if (idle) await this.supervisor.stop(idle.header.id);
      return !!idle;
    };
    const own = await this.options.agentLimitFor?.(tenant);
    const quota = own ?? this.options.maxAgentsPerTenant ?? this.options.maxProcessesPerTenant;
    const source = own !== undefined ? "tenant" : "default";
    const sameTenant = (session: Session) => tenantOf(session) === tenant;
    const reject = (status: 429 | 503, limit: string, value: number, message: string) => {
      console.log(JSON.stringify({ type: "quota_rejected", level: "info", tenant, agent: id, limit, value, source: limit === "agentsPerTenant" ? source : "node", status }));
      return new HttpError(status, message);
    };
    for (;;) {
      if (this.supervisor.reserved.has(id) || this.supervisor.agents.has(id) || this.supervisor.starting.has(id)) return;
      if (quota && tenantCount() >= quota) {
        if (!await evictIdle(live(sameTenant))) throw reject(429, "agentsPerTenant", quota, `This tenant already has ${quota} agents running; retry when one finishes`);
        continue;
      }
      if (this.supervisor.reserve(id, tenant)) return;
      if (!await evictIdle(live(() => true))) throw reject(503, "agentsPerNode", this.supervisor.options.maxAgents ?? 8, "Agent capacity reached; retry when another agent is idle");
    }
  }

  private async apiKey(session: Session, provider: string): Promise<{ key?: string; platform: boolean }> {
    const resolved = this.options.apiKeyFor ? await this.options.apiKeyFor(session.header.tenant ?? DEFAULT_TENANT, provider) : this.options.apiKey;
    return typeof resolved === "object" ? resolved : { key: resolved, platform: false };
  }

  private ensureStarted(session: Session) {
    if (this.closed || session.header.revoked) return Promise.reject(new HttpError(410, "Session closed"));
    if (session.fault) return Promise.reject(session.fault);
    session.lastActive = Date.now();
    if (this.supervisor.agents.has(session.header.id) && !session.starting) return Promise.resolve();
    const id = session.header.id;
    return session.starting ??= (async () => {
      await this.makeRoom(id, session.header.tenant ?? DEFAULT_TENANT);
      const { key: apiKey, platform } = await this.apiKey(session, session.header.config.model.provider);
      session.platformKey = platform;
      const result = await this.supervisor.start(session.header.id, { ...session.header.config, apiKey, ...(this.options.retry ? { retry: this.options.retry } : {}), ...(session.resuming.size ? { resume: true } : {}) }, {
        definitions: await this.toolset(session),
        spendLimit: async () => {
          const limited = await this.options.spendLimit?.(session.header.tenant ?? DEFAULT_TENANT);
          return typeof limited === "string" ? limited : limited?.message;
        },
        call: (name, args, signal, context) => this.callTool(session, { name, args, signal, ...(context ? { toolCallId: context.toolCallId } : {}) }),
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
   * The agent's tools, from its tool servers in order of precedence: the runtime feature's
   * (a channel's send_message), the application's attached server, file tools over its
   * mounts, then its definition's built-ins and remote MCP servers. Records the route.
   */
  private async toolset(session: Session, tools = session.header.definitions, sources = session.header.sources) {
    const header = session.header;
    const tenant = header.tenant ?? DEFAULT_TENANT;
    const agent: AgentRef = { id: header.id, tenant, claim: session.claim };
    const feature = await this.options.hooks?.server?.(agent);
    const volumes = this.options.volumes;
    const servers: ToolServer[] = [
      ...feature ? [feature] : [],
      { tools: () => defaultExposure(tools), call: call => this.callAttached(session, call) },
      ...volumes && header.mounts?.length ? [valueServer(volumes.definitions(header.mounts, []), ({ name, args, signal }) => volumes.tool({ tenant, agent: header.id, mounts: header.mounts ?? [] }, name, args, signal))] : [],
      ...sources && header.definition && this.options.sources ? [this.options.sources.server({ tenant, agent: header.id, definition: header.definition.id, claim: session.claim, ...(header.identity ? { identity: header.identity } : {}) }, sources)] : [],
    ];
    const { tools: definitions, route } = await compose(servers);
    session.route = route;
    return definitions;
  }

  /** Answer one of the agent's tool calls through the server that lists it, once the run's start is durable. */
  private async callTool(session: Session, call: ToolCall) {
    const server = session.route?.get(call.name);
    if (!server) throw new Error(`Unknown tool ${call.name}`);
    const request = [...session.running.values()].find(r => RUN_METHODS.includes(r.method) && r.began);
    const origin = await this.options.hooks?.origin?.({ id: session.header.id, tenant: session.header.tenant ?? DEFAULT_TENANT, claim: session.claim }, request?.id);
    await this.beforeEffect(session);
    return contentResult(await server.call({ ...call, ...(origin ? { origin } : {}), ...(request?.actor ? { actor: request.actor } : {}) }));
  }

  /** The id of the agent `create` makes for a tenant's idempotency key. */
  agentId(tenant: string, key: string) {
    return `client_${hash(tenant === DEFAULT_TENANT ? key : `${tenant}:${key}`).slice(0, 40)}`;
  }

  /**
   * Provision an agent, idempotently per `key`. An agent made from a definition records it
   * (`origin.definition`), and `origin.provision` stands for its configuration in the
   * idempotency check, so a retry after the definition changed returns the same agent.
   */
  async create(definitions: ToolDefinition[], config: Omit<AgentConfig, "id" | "directory" | "tools">, key: string = randomUUID(), metadata: AgentMetadata = {}, tenant = DEFAULT_TENANT, ttlMs?: number | null, mounts?: unknown, origin?: { definition: DefinitionRef; provision: unknown; sources?: Sources }, identity?: AgentIdentity): Promise<{ id: string; token: string; expiresAt: number | null; [status: string]: unknown }> {
    metadata = agentMetadata(metadata);
    validateDefinitions(definitions);
    if (!validId(key)) throw new HttpError(400, "Invalid provisioning idempotency key");
    // Idempotency keys are per tenant; the default tenant keeps its pre-tenant IDs and tokens.
    const scoped = tenant === DEFAULT_TENANT ? key : `${tenant}:${key}`;
    const id = this.agentId(tenant, key);
    const token = createHmac("sha256", this.options.secret).update(`client-v2:${scoped}`).digest("hex");
    const { apiKey: _key, ...safeConfig } = config;
    const provisionHash = hash(canonical({ ...origin ? { definition: origin.provision } : { definitions, config: safeConfig, ...(Object.keys(metadata).length ? { metadata } : {}), ...(mounts !== undefined ? { mounts } : {}) }, ...(identity ? { identity } : {}) }));
    // A deleted or expired agent (a tombstone once purged) is never loaded again; one another node serves only needs its header.
    const existing = this.sessions.has(id) ? undefined : await this.readHeader(id);
    if (existing) {
      if ((existing.value.tenant ?? DEFAULT_TENANT) !== tenant) throw new HttpError(409, "Idempotency key belongs to another tenant");
      if (existing.value.provisionHash !== provisionHash) throw new HttpError(409, "Idempotency key reused with different configuration");
      if (existing.value.revoked || expired(existing.value.expiresAt)) throw new HttpError(410, "Session expired or revoked");
      if (await this.ownerElsewhere(id)) return { id, token, expiresAt: existing.value.expiresAt, running: true };
    }
    let session = await this.load(id);
    // Another create of this agent on this node is provisioning it: wait for what it makes. Two at once
    // would each take the claim, and the second acquire's new epoch would fence the first out.
    while (!session && this.loading.has(id)) session = await this.load(id);
    let created = false;
    if (session) {
      if ((session.header.tenant ?? DEFAULT_TENANT) !== tenant) throw new HttpError(409, "Idempotency key belongs to another tenant");
      if (session.header.provisionHash !== provisionHash) throw new HttpError(409, "Idempotency key reused with different configuration");
      if (session.header.revoked || expired(session.header.expiresAt)) throw new HttpError(410, "Session expired or revoked");
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
          header: { version: 3, id, ...(tenant === DEFAULT_TENANT ? {} : { tenant }), digest: hash(token), expiresAt: ttlMs === null ? null : Date.now() + (ttlMs ?? this.options.ttlMs ?? 24 * 60 * 60 * 1000), revoked: false, metadata, definitions, config: safeConfig, provisionHash, ...(granted ? { mounts: granted } : {}), ...(origin ? { definition: origin.definition } : {}), ...(origin?.sources ? { sources: origin.sources } : {}), ...(identity ? { identity } : {}) },
          claim, requests: new Map(), running: new Map(), log: this.storage.log<JournalRecord>(this.journalKey(id), claim),
          cursor: Date.now() * 1000, events: [], eventBytes: 0, inflight: 0, runs: Promise.resolve(), resuming: new Set(), settling: 0, lastActive: Date.now(),
        };
        // A conditional create: if a concurrent request made this agent first, retry as a load.
        await this.writeHeader(session);
        this.sessions.set(id, session);
        created = true;
        settle(session);
        if (granted) await this.options.volumes!.watch(id, tenant, [], granted, claim);
      } catch (error) {
        settle();
        if (!created) {
          this.supervisor.unreserve(id);
          if (claim) await this.options.ownership!.release(claim).catch(() => {});
          if (session?.fault?.message.includes("moved")) return this.create(definitions, config, key, metadata, tenant, ttlMs, mounts, origin, identity);
          throw error;
        }
        await this.discard(session!);
        throw error;
      }
    }
    try {
      await this.ensureStarted(session);
      const status = await this.supervisor.request(id, "status");
      return { id, token, expiresAt: session.header.expiresAt, ...status };
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
      if (deleted && session.header.mounts?.length) await this.options.volumes?.watch(id, session.header.tenant ?? DEFAULT_TENANT, session.header.mounts, [], session.claim);
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
    await deleteTail(sql, id, [this.journalKey(id), AgentSupervisor.transcriptKey(id)]);
  }

  /** A tenant's live agents. `running` covers agents served by any node. */
  async list(tenant: string) {
    const { rows } = await this.db.query(`
      select a.id, a.name, a.type, a.model, a.expires_at, n.node is not null as served from agents a
      left join actor_owners o on o.actor = a.id
      left join runtime_nodes n on n.node = o.node and n.session = o.session and n.expires_at > now()
      where a.tenant = $1 and not a.revoked and (a.expires_at is null or a.expires_at > $2) order by a.id`, [tenant, Date.now()]);
    return rows.map(row => {
      const local = this.sessions.get(row.id);
      const response = local?.response;
      const running = this.supervisor.agents.has(row.id) || (!local && row.served);
      return { id: row.id as string, name: row.name as string, type: row.type as string, model: row.model as string, connected: !!response && !response.destroyed, running: running as boolean, expiresAt: row.expires_at as number | null };
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
    return { ...metadata, ...(definition ? { definition } : {}), tools: session.header.definitions, systemPrompt: session.header.config.systemPrompt ?? "", mounts: session.header.mounts ?? [],
      cursor: session.cursor, events: session.events.map(({ id, data }) => ({ id, data })), requests: [...session.requests.values()].map(visible) };
  }

  /** A tenant's view of one agent's history; undefined when the agent is not theirs. */
  async agentHistory(id: string, tenant: string) {
    const session = (await this.owns(id, tenant)) ? await this.load(id) : undefined;
    return session && this.history(session);
  }

  /** Abort the running turn of a tenant's agent. Returns false when the agent is not theirs. */
  async abortAgent(id: string, tenant: string) {
    if (!await this.owns(id, tenant)) return false;
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
      if ((session.header.tenant ?? DEFAULT_TENANT) !== tenant || session.header.config.model.provider !== provider) continue;
      if (this.supervisor.agents.has(session.header.id) && !this.busy(session)) await this.supervisor.stop(session.header.id);
    }
  }

  /**
   * Replace a tenant's agent's mounts. Access checks use them at once; an idle agent
   * restarts so its file tools describe them (a busy one picks them up next start).
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

  /** The transcript, from the live agent when it runs, otherwise straight from its log. */
  private async history(session: Session) {
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
      if (!header || c.req.header("origin") || (operator !== undefined && (header.tenant ?? DEFAULT_TENANT) !== operator) || (operator === undefined && (!authorization.startsWith("Bearer ") || !timingSafeEqual(Buffer.from(hash(authorization.slice(7)), "hex"), Buffer.from(header.digest, "hex"))))) throw new HttpError(401, "Unauthorized");
      if (header.revoked || expired(header.expiresAt)) throw new HttpError(410, "Session expired or revoked");
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
    app.get(`${agent}/events`, c => {
      const session = c.var.session;
      const rawCursor = c.req.header("last-event-id") ?? "0";
      if (!/^\d+$/.test(rawCursor)) throw new HttpError(400, "Invalid event cursor");
      const cursor = Number(rawCursor);
      if (!Number.isSafeInteger(cursor)) throw new HttpError(400, "Invalid event cursor");
      // Cursor 0 means a new client: it takes whatever is buffered. Anything else must be contiguous.
      const first = session.events[0]?.id ?? session.cursor + 1;
      if (cursor !== 0 && (cursor > session.cursor || cursor < first - 1)) throw new HttpError(409, "REPLAY_GAP: recover from session state");
      const res = c.env.outgoing;
      session.response?.end();
      session.response = res;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      // Each connection is a new MCP session with the application's attached server; `connection` names it.
      const attached = new AttachedServer(res);
      res.write(`event: ready\ndata: ${JSON.stringify({ version: 4, agentId: session.header.id, connection: attached.id })}\n\n`);
      void session.attached?.close();
      session.attached = attached;
      for (const event of session.events) if (event.id > cursor) {
        const frame = `id: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`;
        if (res.writableLength + Buffer.byteLength(frame) > 2 * FRAME_BYTES) { res.destroy(); break; }
        res.write(frame);
      }
      res.on("close", () => { if (session.response === res) session.response = undefined; });
      return RESPONSE_ALREADY_SENT;
    });
    app.get(`${agent}/schedules`, async c => json(c, 200, await this.scheduler().list(c.var.session.header.id)));
    app.post(`${agent}/schedules`, async c => {
      const scheduler = this.scheduler();
      const tenant = c.var.session.header.tenant ?? DEFAULT_TENANT;
      let input;
      try { input = scheduleInput(await readJson(body(c), 64 * 1024)); } catch (error) { throw new HttpError(400, errorText(error)); }
      try { return json(c, 201, await scheduler.create({ agent: c.var.session.header.id, tenant, ...input }, c.var.session.claim)); } catch (error) { if (error instanceof LostClaim) throw error; throw new HttpError(400, errorText(error)); }
    });
    app.delete(`${agent}/schedules/:schedule`, async c => {
      if (!await this.scheduler().remove(c.var.session.header.id, c.req.param("schedule"), c.var.session.claim)) throw new HttpError(404, "Unknown schedule");
      return json(c, 200, { deleted: true });
    });
    app.get(`${agent}/history`, async c => json(c, 200, await this.history(c.var.session)));
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
    app.all(`${agent}/*`, () => { throw new HttpError(404, "Unknown client route"); });
    app.all("/clients/*", () => { throw new HttpError(401, "Unauthorized"); });
    app.onError((error, c) => json(c, errorStatus(error, 500), { error: errorText(error) }));
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
    // Applying a definition reads the tenant's definitions, so only the tenant may ask for it, not the agent's own token.
    const applying = body.method === "configure" && body.params.definition !== undefined;
    if (applying && (!trusted || !this.options.definitionFor || Object.keys(body.params).length !== 1 || typeof body.params.definition?.id !== "string")) throw new HttpError(400, "Apply a definition with PATCH /v1/definitions/<id> and apply: \"all\"");
    try {
      if (body.method === "configure" && !applying) configurationUpdate(body.params);
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
    const isRun = RUN_METHODS.includes(body.method);
    // Who is acting in a run is recorded apart from what the agent is asked to do.
    let actor: string | undefined;
    const { actor: rawActor, ...params } = body.params;
    if (rawActor !== undefined && !isRun) throw new HttpError(400, "actor is only for runs (prompt, continue, execute)");
    try { actor = actorInput(rawActor); } catch (error) { throw new HttpError(400, errorText(error)); }
    const limited = await this.runLimit(session, body.method);
    if (limited) throw typeof limited === "string" ? new HttpError(402, limited) : limited;
    // Reads, aborts and applied definitions never need a process; runs start it when their turn comes.
    if (!isRun && !applying && !["history", "status", "abort"].includes(body.method)) await this.ensureStarted(session);
    // Concurrent retries may have waited on the same process startup.
    const raced = existing();
    if (raced) return { status: 200, record: visible(raced) };
    const record = this.upsertRequest(session, {
      startedAt: Date.now(), ...(body.method === "prompt" && typeof body.params.text === "string" ? { prompt: body.params.text } : {}),
      ...(body.method === "execute" && typeof body.params.code === "string" ? { code: body.params.code } : {}),
      id: body.id, method: body.method, fingerprint, state: "running", ...(isRun ? { params } : {}), ...(actor ? { actor } : {}),
    });
    await this.commit(session, true);
    // A definition is applied between runs, when the agent is not busy.
    if (isRun || applying) this.enqueue(session, record, params);
    else void this.run(session, record, params);
    return { status: 202, record: visible(record) };
  }

  /** Submit a request to a tenant's agent on the tenant's behalf (REST API and console). */
  async submit(id: string, tenant: string, body: { id: string; method: string; params: Record<string, unknown> }) {
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
    if (record.method === "abort" && !live) return { aborted: false, running: false };
    if (record.method === "configure") {
      const applied = params.definition !== undefined ? await this.definitionUpdate(session) : undefined;
      const update = applied?.update ?? configurationUpdate(params);
      // A new model may belong to another provider: the agent needs that provider's key.
      const resolved = update.model ? await this.apiKey(session, update.model.provider) : undefined;
      const apiKey = resolved?.key;
      if (update.model && this.options.apiKeyFor && !apiKey) throw new Error(`No ${update.model.provider} API key is configured for this tenant; set one with PUT /v1/providers/${update.model.provider}/key`);
      // An agent that is not running takes its new configuration when it next starts.
      const result = live || params.definition === undefined ? await this.supervisor.request(id, "configure", {
        ...update, ...apiKey ? { apiKey } : {},
        // Replacing the application's tools keeps the runtime's own.
        ...update.tools ? { tools: await this.toolset(session, update.tools, applied ? applied.sources : session.header.sources) } : {},
      }) : { configured: true };
      const { tools, ...config } = update;
      if (resolved && live) session.platformKey = resolved.platform;
      if (tools !== undefined) session.header.definitions = tools;
      session.header.config = { ...session.header.config, ...config };
      if (applied) {
        session.header.definition = applied.definition;
        if (applied.sources) session.header.sources = applied.sources; else delete session.header.sources;
      }
      await this.writeHeader(session);
      return result;
    }
    return this.supervisor.request(id, method, params, RUN_METHODS.includes(record.method)
      ? event => {
          // Failed calls report zero usage; count only responses the provider completed.
          if (event?.type === "message_end" && event.message?.role === "assistant" && event.message.usage && event.message.stopReason !== "error") {
            this.options.onUsage?.(session.header.tenant ?? DEFAULT_TENANT, id, { ...event.message, platform: !!session.platformKey });
          }
          if (event?.type === "compaction_usage" && event.usage) this.options.onUsage?.(session.header.tenant ?? DEFAULT_TENANT, id, { ...event, kind: "compaction", platform: !!session.platformKey });
          this.publish(session, { type: "event", requestId: record.id, event });
        } : undefined);
  }

  /** The configuration an agent takes from its definition's current revision; tools added at creation stay. */
  private async definitionUpdate(session: Session) {
    const current = session.header.definition;
    if (!current) throw new Error("This agent was not made from a definition");
    const resolved = await this.options.definitionFor!(session.header.tenant ?? DEFAULT_TENANT, current.id);
    // The attached server's tools stay; the tools list is rebuilt with the definition's sources.
    return { update: { ...resolved.config, tools: session.header.definitions }, definition: { ...current, revision: resolved.revision }, sources: resolved.sources };
  }

  /** Finish a run whose node was lost: continue its turn, or take the answer it had already reached. */
  private async resume(session: Session, record: RequestRecord): Promise<Outcome> {
    const handoff = session.handoff;
    session.handoff = undefined;
    if (handoff && "continue" in handoff) return { result: await this.execute(session, record, {}, "continue") };
    if (handoff) return { result: handoff.finished };
    return { error: "The runtime restarted during this request", uncertain: true };
  }

  /** Queue a run behind the agent's earlier runs; a busy agent never rejects work. */
  private enqueue(session: Session, record: RequestRecord, params: unknown) {
    session.runs = session.runs.then(() => this.run(session, record, params)).catch(() => {});
  }

  private async run(session: Session, record: RequestRecord, params: unknown) {
    let value: Outcome;
    try {
      if (RUN_METHODS.includes(record.method)) {
        if (this.closed || this.draining || session.fault || session.requests.get(record.id)?.state !== "running") return;
        // A run queued behind the one that reached the cap never begins; a resumed turn is stopped by the host.
        if (!session.resuming.has(record.id)) {
          const limited = await this.runLimit(session, record.method);
          if (limited) throw typeof limited === "string" ? new HttpError(402, limited) : limited;
        }
        await this.ensureStarted(session);
        if (this.draining) return;
        // Durable before any side effect: after a crash this run is "began", never repeated.
        const { params: _params, ...rest } = session.requests.get(record.id)!;
        record = this.upsertRequest(session, { ...rest, began: Date.now() });
        // Code has no effect outside its sandbox until it calls a tool, and every tool call
        // makes this record durable first (`beforeEffect`; the application's tools do it when
        // their call is recorded, which is appended after it). So an execution needs no commit of its
        // own here: one that crashes before a tool call is simply run again.
        if (record.method === "execute") session.beginning = {};
        else await this.commit(session, true);
        this.hook("runStarted", session, record);
      }
      if (RUN_METHODS.includes(record.method)) session.activeSince = Date.now();
      value = session.resuming.delete(record.id) ? await this.resume(session, record) : { result: await this.execute(session, record, params) };
    }
    catch (error) { value = { error: errorText(error) }; }
    this.reportActive(session, false);
    session.beginning = undefined;
    if (this.closed || session.fault || session.requests.get(record.id)?.state !== "running") return;
    const { params: _params, ...finished } = record;
    // Until the response is published, a drain or release must not close the stream and drop it.
    session.settling++;
    try {
      const completed = this.upsertRequest(session, { ...finished, state: "completed", outcome: value, endedAt: Date.now() });
      try { await this.commit(session, true); }
      catch { return; /* The fault is reported to every later request. */ }
      if (RUN_METHODS.includes(record.method)) this.hook("runEnded", session, completed);
      session.lastActive = Date.now();
      this.publish(session, { type: "response", id: record.id, outcome: value });
    } finally { session.settling--; }
    await this.fold(session);
  }

  /** Why a run may not start: a model run's spend limit (a monthly cap or spent credit), or for any run, spent credit. */
  private async runLimit(session: Session, method: string) {
    const tenant = session.header.tenant ?? DEFAULT_TENANT;
    if (MODEL_RUNS.includes(method)) return this.options.spendLimit?.(tenant);
    if (RUN_METHODS.includes(method)) return this.options.creditLimit?.(tenant);
    return undefined;
  }

  /** Report the running run's active time so far; `running` keeps counting from now. */
  private reportActive(session: Session, running: boolean, now = Date.now()) {
    if (session.activeSince === undefined) return;
    const ms = now - session.activeSince;
    session.activeSince = running ? now : undefined;
    try { this.options.onActive?.(session.header.tenant ?? DEFAULT_TENANT, session.header.id, ms); }
    catch (error) { console.error(JSON.stringify({ type: "active_report_failed", error: errorText(error) })); }
  }

  /** Make a pending execution's start durable before anything outside its sandbox acts for it. */
  private async beforeEffect(session: Session) {
    const beginning = session.beginning;
    if (beginning) await (beginning.durable ??= this.commit(session, true));
  }

  private hook(name: "runStarted" | "runEnded", session: Session, record: RequestRecord) {
    try { this.options.hooks?.[name]?.({ id: session.header.id, tenant: session.header.tenant ?? DEFAULT_TENANT, claim: session.claim }, record); }
    catch (error) { console.error(JSON.stringify({ type: "session_hook_failed", hook: name, error: errorText(error) })); }
  }

  /**
   * Call a tool on the application's attached server, as on any MCP server. With no application
   * connected (after a short wait for one reconnecting) the call fails without running; a call the
   * connection or deadline cut short has an unknown outcome. After a crash, the turn's transcript
   * says the same: a tool call without a result is closed as unknown, never sent again.
   */
  private async callAttached(session: Session, { name, args, signal, toolCallId, origin, actor }: ToolCall): Promise<McpResult> {
    const attached = await this.attachedServer(session, signal);
    if (!attached) throw new Error("No application is connected to answer this tool call; it did not run");
    const timeout = this.options.toolTimeoutMs ?? 15_000;
    const _meta = { "agent-runtime/callId": randomUUID(), ...(toolCallId ? { "agent-runtime/toolCallId": toolCallId } : {}), ...(origin ? { "agent-runtime/origin": origin } : {}), ...(actor ? { "agent-runtime/actor": actor } : {}) };
    session.inflight++;
    try {
      return await attached.client.callTool({ name, arguments: args, _meta }, undefined, { signal, timeout, maxTotalTimeout: timeout }) as McpResult;
    } catch (error) {
      if (!signal.aborted && error instanceof McpError && [ErrorCode.ConnectionClosed, ErrorCode.RequestTimeout].includes(error.code)) {
        throw new Error(`${error.message}, after the call was sent to the application. Its outcome is unknown: it may or may not have taken effect.`);
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
    session.response?.end();
    await this.releaseVolumes(session.header, session.claim);
  }

  /** A deleted agent stops watching its mounts, and its own workspace goes with it; shared volumes stay. */
  private async releaseVolumes(header: SessionHeader, claim: Claim | undefined) {
    const volumes = this.options.volumes;
    const mounts = header.mounts ?? [];
    if (!volumes || !mounts.length) return;
    const id = header.id, tenant = header.tenant ?? DEFAULT_TENANT;
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
      const queued = RUN_METHODS.includes(request.method) && (!request.began || session.resuming.has(request.id));
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
   * agent's identity, so its id and idempotency key are never reused and requests
   * for it get 404 or 410. Nodes claim agents with FOR UPDATE SKIP LOCKED and a
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
        const tombstone = { version: 3, id, ...(header.tenant ? { tenant: header.tenant } : {}), digest: header.digest, expiresAt: header.expiresAt, revoked: true, provisionHash: header.provisionHash, purged: true };
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
      if (request.began ? !session.resuming.has(request.id) : !RUN_METHODS.includes(request.method)) count++;
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
      for (const session of [...this.sessions.values()]) {
        if (this.working(session) || session.inflight) continue;
        await this.supervisor.stop(session.header.id).catch(() => {});
        await this.unload(session);
        session.response?.end();
      }
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
      if (session.response && !session.response.write(": heartbeat\n\n")) session.response.destroy();
      if (session.activeSince !== undefined && now - session.activeSince >= ACTIVE_REPORT_MS) this.reportActive(session, true, now);
      if (this.busy(session) || now - session.lastActive < idleMs) continue;
      if (this.supervisor.agents.has(id)) void this.supervisor.stop(id).catch(() => {});
      else if (!session.response && !session.fault) {
        // Nothing is connected or running: everything needed later is in storage.
        void this.unload(session);
      }
    }
  }

  /** Drop a session from memory and give up ownership so any node can serve it next. */
  private async unload(session: Session) {
    if (this.sessions.get(session.header.id) === session) this.sessions.delete(session.header.id);
    await session.log.close().catch(() => {});
    // A revoked agent's logs are never read again.
    if (session.header.revoked) await underClaim(this.db, session.claim, sql => deleteTail(sql, session.header.id)).catch(() => {});
    if (session.claim) await this.options.ownership!.release(session.claim).catch(() => {});
  }

  /** This node fenced itself: another node may already be serving the agent, so stop writing, stop the agent, forget it. */
  private async lost(session: Session) {
    this.fail(session, new Error("This node lost ownership of the agent"));
    session.response?.destroy();
    if (this.sessions.get(session.header.id) === session) this.sessions.delete(session.header.id);
    await this.supervisor.stop(session.header.id).catch(() => {});
  }

  async close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    // A sweep stops after its batch; agents it claimed but did not reach are taken again once the lease lapses.
    await this.sweeping;
    for (const session of [...this.sessions.values()]) {
      // Stopped first, so no turn advances past what is handed off, and the next owner never shares the transcript with a live process.
      await this.supervisor.stop(session.header.id).catch(() => {});
      try { await this.interrupt(session, "The runtime stopped during this request", true); }
      catch { /* Already faulted; the next load recovers conservatively from storage. */ }
      await this.unload(session);
      // Closed after release, so the client's reconnect finds the next owner rather than this node.
      session.response?.end();
    }
  }
}

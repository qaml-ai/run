import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { END_USER_CREDIT } from "./model-attempt.ts";
import { bucketInput } from "./end-user-credits.ts";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { AgentConfig, ToolDefinition } from "./protocol.ts";
import { errorText, CONTEXT_RANGE_MAX_BYTES, CONTEXT_TOO_LARGE, NOT_MIGRATED, PERSISTENCE_FAILED } from "./protocol.ts";
import { enqueueEvents, webhookEvent, type WebhookEvent } from "./webhooks.ts";
import { AgentSupervisor } from "./supervisor.ts";
import { withCatalogPrices } from "./pi-catalog.ts";
import { configurationRefusal, configurationUpdate, runLimitsInput } from "./session-config.ts";
import { outputInput } from "./tool-policy.ts";
import { importedHistory, validateUserMessages } from "./history.ts";
import { convertToLlm, createCompactionSummaryMessage } from "./pi-harness/messages.ts";
import { canonical } from "../shared/durable-json.ts";
import type { CommitEffect } from "../shared/append-log.ts";
import { fileStorage, type Storage } from "../shared/storage.ts";
import { FRAME_BYTES, outcomeEnding, type ClientEvent, type Outcome, type RequestMethod, type RequestRecord, type TurnSnapshot } from "../shared/client-protocol.ts";
import { agentMetadata, type AgentMetadata } from "../shared/agent-metadata.ts";
import { scheduleInput } from "./scheduler.ts";
import { errorCode, errorFields, errorHeaders, errorStatus, HttpError, readJson } from "./http.ts";
import { rateLimitHeaders, type RateLimitState } from "./rate-limits.ts";
import { VolumeService } from "./volumes.ts";
import { databaseRetryable, databaseUnavailable, type Db, type Sql } from "./db.ts";
import { NotOwner, LostClaim, underClaim, type Claim } from "./ownership.ts";
import { deleteTail } from "./log-tail.ts";
import type { DefinitionRef } from "./definitions.ts";
import type { McpServerSpec, Sources } from "./tool-sources.ts";
import { actorInput, type AgentIdentity } from "./identity.ts";
import { metadataInput, senderInput } from "./sender.ts";
import { CodeGate, DEFAULT_CODE_CAPACITY } from "./codemode.ts";
import { fileResponse, type FileRef } from "./files.ts";
import { chunksOf, HistoryIndex, PAGE_BYTES, type HistoryPage } from "./history-pages.ts";
import { inputView, resolution, type Input, type Responder } from "./inputs.ts";
import { recordBillingFailure, recordHandoff, recordStart, safeError, Steps } from "./metrics.ts";
import { inputSpans } from "./telemetry.ts";
import { PARENT_KEYS, type DelegateSettings } from "./multi-agent.ts";
import { clock, random } from "./node-context.ts";
import { always, reachable, sometimes } from "./assert.ts";
import * as tools from "./client-sessions/tools.ts";
import * as configuration from "./client-sessions/configuration.ts";
import * as events from "./client-sessions/events.ts";
import * as spend from "./client-sessions/spend.ts";
import * as delegation from "./client-sessions/delegation.ts";
import * as childSessions from "./client-sessions/children.ts";
import * as humanInput from "./client-sessions/inputs.ts";
import { dollars } from "./client-sessions/spend.ts";
import { historyNoneIgnored } from "./history-none.ts";
import { type SessionHeader, type RunSettings, runIdOf, type ForkedFrom, type JournalRecord, type RunUsage, type ClientEnv, type BufferedEvent, type HistoryTail, type Session, type Carried, type ClientSessionOptions, type UsageRecord, RUN_METHODS, MODEL_RUNS, validSessionId, hash, validId, expired, activityOf, visible, runningRun, failureClass } from "./client-sessions/state.ts";

const has = (object: object, key: string) => Object.hasOwn(object, key);

/** How far past its time limit a run may get before it is aborted, and twice this before its agent is stopped (`overrun`). */
const RUN_OVERRUN_MS = 60_000;
/**
 * Requests queued behind the agent's runs. Each keeps its params for as long as it may
 * run again on the agent's next owner: a run until it begins, and configuration (an
 * idempotent assignment) until it settles.
 */
const QUEUED_METHODS = [...RUN_METHODS, "configure"];
/** Queued runs a stop cancels (`stop`): what callers asked for. A `resume` closes a suspended turn, and is the runtime's. */
const CANCELLABLE = ["prompt", "continue", "execute"];
const CANCELLED = "Cancelled: the agent was stopped before this run began";
/** A sub-agent's notification an abort reached before its turn: it lands without one (`stop`). */
const STOPPED_NOTICE = { stopped: "aborted", message: "The agent was stopped: this notification is in its history, but no turn ran" };

/** A running run's active time is reported at least this often. */
const ACTIVE_REPORT_MS = 60_000;
/** Resumes of one run's turn before it fails with resume_limit, so a turn that kills its node cannot loop. Hand-offs at a step boundary are not resumes. */
export const MAX_RESUMES = 2;
/**
 * How many times a run's start (its busy slot, its agent's process, its run events' setting) is tried when the
 * database refuses it for now or cannot be reached, or the node answers 503: the run stays queued meanwhile, its place
 * kept, waiting RUN_START_BACKOFF_MS, doubling, with jitter, between tries (about a minute and a quarter in all). Past
 * that it fails with the last cause; any other error fails it at once.
 */
export const RUN_START_ATTEMPTS = 5;
const RUN_START_BACKOFF_MS = 5_000;
const transientStart = (error: unknown) => databaseRetryable(error) || databaseUnavailable(error) || (error as { status?: number }).status === 503;
/** A run's latest hand-offs its record keeps (`handoffs`): one per deploy or drain it outlived. */
const MAX_HANDOFFS_KEPT = 20;

/** Notified, as `<node> <agent>`, when a node gives up an agent with runs open, or ends a dead peer's heartbeat: nodes sweep at once. */
export const ORPHANS_CHANNEL = "agent_runtime_orphans";

/** A model turn that began can continue from its transcript on another node; a code execution cannot. */
const resumable = (request: RequestRecord) => ["prompt", "continue", "resume"].includes(request.method) && !!request.began;
/**
 * What a load does with a request its journal left running (no process anywhere runs it now): a queued one (its params
 * kept: it never began, or it is configuration) runs; a model turn that began resumes from its transcript, up to
 * the configured limit (default MAX_RESUMES), then ends `resume_limit` (a step-boundary hand-off does not count); anything else that began has an unknown outcome, and
 * ends `uncertain`. A run the agent was stopped in (`abortedAt`) is never resumed nor run: it ends `aborted`.
 */
export function loadDecision(request: RequestRecord, maxResumes = MAX_RESUMES): "queued" | "resume" | "resume_limit" | "uncertain" | "aborted" {
  if (request.abortedAt !== undefined) return "aborted";
  if (request.params !== undefined) return "queued";
  // Counted when the resumed run begins (see `run`), so a load that fails, or hands the agent back, spends none.
  // A turn handed off at a step boundary lost nothing and is not a resume: it always goes on.
  if (resumable(request)) return request.handedOff || (request.resumes ?? 0) < maxResumes ? "resume" : "resume_limit";
  return "uncertain";
}

/** Requests an agent may have accepted but not finished, queued runs included. */
const MAX_OPEN_REQUESTS = 32;
const REQUEST_METHODS = [...RUN_METHODS, "status", "abort", "steer", "configure"];
/** A configuration's fields only an upsert (the tenant making the agent again with its key) sets: see `reconfiguration`. */
const UPSERT_KEYS = ["provisionHash", "name", "type", "tools", "fileTools", "codeMode", "toolsHash"];

/** Settled records kept for idempotent retries once the journal is folded. */
const RETAINED_SETTLED = 256;
const FOLD_AFTER_RECORDS = 2048;

/** The longest a load of an agent with work left is put off (see `defer`). */
const MAX_RESUME_DELAY_MS = 60 * 60_000;
/** How long a loaded agent must stay up before its sweep backoff clears. */
const RESUME_HELD_MS = 2 * 60_000;
/** How often an idle watcher's agent is checked for an owner elsewhere, should its load's notice be missed. */
const IDLE_CHECK_MS = 20_000;

/** A finished run's reply text, if it has one. */
function replyText(record: RequestRecord) {
  const reply = (record.outcome?.result as { reply?: unknown } | undefined)?.reply;
  return typeof reply === "string" ? reply : "";
}

/**
 * A request's body straight from Node's request stream: reaching it through the Fetch
 * Request builds an undici Request and a web stream first, a noticeable part of a
 * small request's cost. The operator bridge hands its body on as a Request.
 */
const body = (c: Context<ClientEnv>) => c.env.operatorTenant === undefined && c.env.incoming ? c.env.incoming : c.req.raw.body;
const json = (c: Context, status: number, value: unknown) => c.json(value, status as ContentfulStatusCode, { "Cache-Control": "no-store" });
const settled = (state: string) => state !== "running";

/**
 * SSE carries streamed events; POST mutations use persistent request/call IDs.
 * Sessions load lazily and unload when idle, so only active agents use memory.
 */
export class ClientSessions {
  readonly sessions = new Map<string, Session>();
  private readonly loading = new Map<string, Promise<Session | undefined>>();
  /** Concurrent deletes must wait for the same cancellation before any caller stops the host. */
  private readonly removing = new Map<string, Promise<void>>();
  readonly supervisor: AgentSupervisor;
  readonly options: ClientSessionOptions;
  readonly storage: Storage;
  readonly db: Db;
  readonly heartbeat: ReturnType<typeof setInterval>;
  /** Agents' history in pages. */
  readonly historyIndex: HistoryIndex;
  /** Turns to run js_exec on this node, shared fairly among tenants. */
  readonly codeGate: CodeGate;
  private readonly eventContext: events.EventContext;
  private readonly spendContext: spend.SpendContext;
  private readonly delegationContext: delegation.DelegationContext;
  private readonly childrenContext: childSessions.ChildrenContext;
  private readonly inputsContext: humanInput.InputContext;
  private readonly toolsContext: tools.ToolsContext;
  private readonly configurationContext: configuration.ConfigurationContext;
  private closed = false;
  /** Set while the node drains or retires: runs that have not begun stay queued for the next owner. */
  draining = false;
  private releasing = false;
  /** Set while this node leaves the cluster with a peer to take its work (`handOffTurns`): running turns stop at their next step boundary. */
  private handingOff?: { reason: "retire" | "drain" | "memory"; since: number };
  /** Agents being given up as this node leaves (`park`, `handOffAll`): in flight until they are released. */
  private readonly leavingWork = new Set<Promise<void>>();
  /** Stateless runs' sessions being made here, whose slots are reserved before their header is: not the tenant's agents. */
  private readonly creatingRuns = new Set<string>();

  constructor(supervisor: AgentSupervisor, options: ClientSessionOptions) {
    if (!options.storage && !options.root) throw new Error("ClientSessions needs storage or root");
    this.supervisor = supervisor;
    this.options = options;
    this.db = options.db;
    this.eventContext = {
      options, db: this.db, sessions: this.sessions, idle: this.idle,
      state: { watching: 0, tenantWatching: new Map(), watches: new WeakMap() },
      isClosed: () => this.closed, isLoading: id => this.loading.has(id), load: id => this.load(id),
      publish: (session, data) => this.publish(session, data), replay: (session, raw, snapshot) => this.replay(session, raw, snapshot),
      idleCursor: id => this.idleCursor(id),
    };
    this.storage = options.storage ?? fileStorage(options.root!);
    this.historyIndex = new HistoryIndex(this.db, this.storage);
    this.spendContext = {
      options, db: this.db, supervisor, sessions: this.sessions, historyIndex: this.historyIndex,
      apiKey: (session, provider, keyScope) => configuration.resolveApiKey(this.configurationContext, session, provider, keyScope),
      counted: (session, cost) => this.counted(session, cost), spent: (session, cost) => this.spent(session, cost),
      agentSpendLimit: session => this.agentSpendLimit(session), toolContext: session => tools.toolContext(this.toolsContext, session),
      spendOf: session => this.spendOf(session), spendWrite: (session, cost) => this.spendWrite(session, cost),
    };
    this.delegationContext = {
      options, db: this.db, sessions: this.sessions, spendContext: this.spendContext,
      agentId: (tenant, key) => this.agentId(tenant, key),
      awaitRequest: (agent, tenant, requestId, waitMs, signal) => this.awaitRequest(agent, tenant, requestId, waitMs, signal),
      submit: (agent, tenant, request) => this.submit(agent, tenant, request),
      publish: (session, data) => this.publish(session, data), spent: (session, cost) => this.spent(session, cost),
    };
    this.childrenContext = {
      ...this.delegationContext, state: { sweepingChildren: false },
      isClosed: () => this.closed, isDraining: () => this.draining,
      upsertRequest: (session, record) => this.upsertRequest(session, record),
      commit: (session, durable) => this.commit(session, durable),
      startStep: (session, record, work) => this.startStep(session, record, work),
    };
    this.inputsContext = {
      options, sessions: this.sessions, publish: (session, data) => this.publish(session, data),
      accept: (session, body, trusted) => this.accept(session, body, trusted),
      headerFor: (id, tenant) => this.headerFor(id, tenant),
      submit: (agent, tenant, request) => this.submit(agent, tenant, request),
    };
    this.toolsContext = {
      options, supervisor, eventContext: this.eventContext, spendContext: this.spendContext,
      delegationContext: this.delegationContext, childrenContext: this.childrenContext, inputsContext: this.inputsContext,
      owns: (id, tenant) => this.owns(id, tenant), load: id => this.load(id),
      headerFor: (id, tenant) => this.headerFor(id, tenant), writeHeader: session => this.writeHeader(session),
      publish: (session, data) => this.publish(session, data), beforeEffect: session => this.beforeEffect(session),
      leased: (session, signal) => this.leased(session, signal), endUserCharge: (agent, usage) => this.endUserCharge(agent, usage),
    };
    this.configurationContext = {
      options, db: this.db, supervisor, storage: this.storage, sessions: this.sessions, loading: this.loading,
      creatingRuns: this.creatingRuns, historyIndex: this.historyIndex,
      get eventBlock() { return options.eventBlock ?? events.EVENT_BLOCK; },
      toolsContext: this.toolsContext, spendContext: this.spendContext, delegationContext: this.delegationContext,
      load: id => this.load(id), readHeader: id => this.readHeader(id), writeHeader: session => this.writeHeader(session),
      ownerElsewhere: id => this.ownerElsewhere(id), makeRoom: (id, tenant, run) => this.makeRoom(id, tenant, run),
      journalKey: id => this.journalKey(id), seedFork: (id, claim, fork) => this.seedFork(id, claim, fork),
      setSpendLimit: (session, usd) => this.setSpendLimit(session, usd), ensureStarted: session => this.ensureStarted(session),
      discard: session => this.discard(session), owns: (id, tenant) => this.owns(id, tenant),
      busy: session => this.busy(session), spendOf: session => this.spendOf(session),
    };
    this.codeGate = new CodeGate(options.codeCapacity ?? DEFAULT_CODE_CAPACITY);
    this.heartbeat = setInterval(() => this.tick(), Math.min(5000, Math.max(50, Math.floor((options.idleMs ?? 5 * 60_000) / 2))));
    this.heartbeat.unref();
    options.ownership?.onFence(() => { for (const session of [...this.sessions.values()]) void this.lost(session); });
    options.ownership?.onStale(() => this.supervisor.interrupt());
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
   * Writes of one session go one at a time: two at once (a rotation and an upsert's
   * configure, say) would both be conditional on the same revision, and the one that
   * lost would read as another node having moved the agent, faulting it. Each writes
   * the header as it is when its turn comes, so the later one carries both changes.
   */
  private writeHeader(session: Session): Promise<void> {
    const write = (session.headerWrite ?? Promise.resolve()).catch(() => {}).then(() => this.writeHeaderNow(session));
    session.headerWrite = write;
    void write.finally(() => { if (session.headerWrite === write) session.headerWrite = undefined; }).catch(() => {});
    return write;
  }

  private async writeHeaderNow(session: Session) {
    if (session.fault) throw session.fault;
    const header = session.header;
    const columns = [header.id, header.tenant, JSON.stringify(header), header.metadata?.name ?? header.id, header.metadata?.type ?? "general",
      `${header.config.model.provider}/${header.config.model.id}`, header.expiresAt, header.revoked];
    try {
      const { rows } = session.revision === undefined
        ? await this.db.query(`
            insert into agents (id, tenant, header, name, type, model, expires_at, revoked, revision, reserved_cursor) values ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9)
            on conflict (id) do nothing returning revision`, [...columns, session.reserved])
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
      this.fail(session, error, "header");
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

  private load(id: string, sweep = false): Promise<Session | undefined> {
    const loaded = this.sessions.get(id);
    if (loaded) return Promise.resolve(loaded);
    let loading = this.loading.get(id);
    if (!loading) {
      loading = this.read(id, sweep).finally(() => this.loading.delete(id));
      this.loading.set(id, loading);
    } else if (!sweep) {
      // A shared sweep may decline its reservation after another node moved the deadline.
      // Acting requests still load the agent, without the sweep's backoff.
      return loading.then(session => session ?? this.load(id));
    }
    return loading;
  }

  private async read(id: string, sweep: boolean): Promise<Session | undefined> {
    if (!sweep) {
      const stored = await this.readHeader(id);
      if (!stored || stored.value.purged) return undefined;
    }
    // A closed node loads nothing: it would hold the agent with no one to run or release it (`close` has unloaded its agents).
    if (this.closed) throw new HttpError(503, "This node is stopping; retry");
    // Take ownership before reading the journal, so no other node appends meanwhile.
    const ownership = this.options.ownership;
    let claim: Claim | undefined;
    if (ownership) {
      const acquired = await ownership.acquire(id);
      if ("owner" in acquired) throw new NotOwner(acquired.owner);
      claim = acquired.claim;
    }
    try {
      if (sweep) {
        // Reserve before reading the header or journal: a load that kills the node leaves no error to back off on.
        const reserved = await underClaim(this.db, claim, sql => sql.query(`update agents set sweep_failures = sweep_failures + 1,
            sweep_after = $2 + least($3 * power(2, least(sweep_failures, 30))::bigint, $4)
          where id = $1 and (sweep_after is null or sweep_after <= $2)`, [id, Date.now(), this.sweepMs, MAX_RESUME_DELAY_MS]));
        if (!reserved.rowCount) {
          if (claim) await ownership!.release(claim);
          return undefined;
        }
      }
      const session = await this.loadOwned(id, claim);
      if (!session && claim) await ownership!.release(claim);
      return session;
    }
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
      ...await this.startCursor(id, claim), events: [], eventBytes: 0, watchers: new Set(), polls: new Set(), inflight: 0, runs: Promise.resolve(), resuming: new Set(), settling: 0, lastActive: Date.now(),
    };
    for (const record of await log.read()) this.apply(session, record);
    if (header.version !== 3 || header.id !== id) throw new Error("Invalid client session header");
    // Loading means no process anywhere owns the session, so nothing it recorded is still running.
    // Queued runs that never began are safe to run now. A turn that began resumes from its
    // journal, a bounded number of times; anything else that began has an unknown outcome.
    const queued: RequestRecord[] = [];
    const resumed: RequestRecord[] = [];
    const decisions = [...session.running.values()].map(request => ({ request, decision: loadDecision(request, this.options.maxResumes) }));
    // A model turn that began ends here, with no host to end it (past its resumes, or stopped before its node was lost): the
    // turn it left open is settled in its journal first, as the agent's next start would, so the run is never seen to
    // end before its turn has (a fork, a history page). A failed write fails the load, which leaves the run to the next.
    if (decisions.some(({ request, decision }) => (decision === "aborted" || decision === "uncertain" || decision === "resume_limit") && resumable(request)) && !decisions.some(({ decision }) => decision === "resume")) {
      await spend.closeTurn(this.spendContext, session);
    }
    for (const { request, decision } of decisions) {
      if (decision === "queued") queued.push(request);
      else if (decision === "resume") resumed.push(request);
      // Stopped before its node was lost: it ends as the stop left it, never resumed.
      else if (decision === "aborted") {
        const { params: _params, ...rest } = request;
        this.upsertRequest(session, { ...rest, state: "completed", endedAt: Date.now(), outcome: { result: { error: "The run was aborted", code: "aborted" } }, ...(RUN_METHODS.includes(request.method) ? { announce: true as const } : {}) });
      }
      else if (decision === "resume_limit") {
        const resumes = request.resumes ?? 0;
        this.upsertRequest(session, { ...request, state: "completed", endedAt: Date.now(), outcome: { result: { code: "resume_limit", error: `This turn exhausted its ${resumes} node-loss resumes and was not resumed again` } }, announce: true });
        console.error(JSON.stringify({ type: "turn_resume_limit", agent: id, tenant: header.tenant, resumes }));
      }
      else this.upsertRequest(session, { ...request, state: "completed", endedAt: Date.now(), outcome: { error: "The runtime restarted during this request", uncertain: true }, ...(RUN_METHODS.includes(request.method) ? { announce: true as const } : {}) });
    }
    await log.flush(true);
    const ended = decisions.filter(({ decision }) => !["queued", "resume"].includes(decision)).map(({ request }) => session.requests.get(request.id)!);
    if (!resumed.length) await this.resetResumes(session);
    if (claim && !this.options.ownership!.holds(claim)) throw new HttpError(503, "This node lost ownership of the agent; retry");
    if (this.closed) throw new HttpError(503, "This node is stopping; retry");
    if (!queued.length && !resumed.length) await this.resetSweep(session);
    this.sessions.set(id, session);
    if (queued.length || resumed.length) session.sweepResetAt = Date.now() + RESUME_HELD_MS;
    events.loaded(this.eventContext, session);
    for (const record of ended) {
      this.publish(session, { type: "response", id: record.id, outcome: record.outcome! });
      if (RUN_METHODS.includes(record.method)) {
        this.hook("runEnded", session, record);
        if ((/^(?:spawn|msg)_/.test(record.id) && record.metadata?.[PARENT_KEYS.agent]) || record.id.startsWith("resume_")) void childSessions.childEnded(this.childrenContext, id, visible(record)).catch(error => console.error(JSON.stringify({ type: "child_notice_failed", child: id, error: safeError(error) })));
        if (session.header.run && record.id === runIdOf(id)) void this.runEnded(session);
      }
    }
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
    const result = (outcome.result ?? {}) as { stopped?: string; inputs?: { id: string }[]; replyIndex?: number; messages?: number; code?: unknown; limit?: unknown; reason?: unknown; bucket?: unknown; endUser?: unknown; servedModel?: string; modelError?: object };
    const { error } = outcomeEnding(outcome);
    const ended = { ...base, ...(record.steeredInto ? { steeredInto: record.steeredInto } : {}), usage: usage ?? null, ...(result.servedModel ? { servedModel: result.servedModel } : {}) };
    const key = `run.ended:${agentId}:${record.id}`;
    // Its code, where the run's outcome has one: `cancelled` (a stop cancelled it before it began), `aborted`, `model_stream_stalled`...
    // And how its model call failed, where it did (errorClass, providerStatus, retryable, model).
    // A limit's: which (limit), and for an end user's credit why (reason), whose (endUser) and which bucket.
    const coded = Object.fromEntries((["code", "limit", "reason", "bucket", "endUser"] as const).flatMap(name => typeof result[name] === "string" ? [[name, result[name]]] : []));
    if (error !== undefined) return webhookEvent("run.failed", tenant, { ...ended, error, ...coded, ...(outcome.error === undefined ? result.modelError : {}), ...(outcome.uncertain ? { uncertain: true } : {}) }, key);
    return webhookEvent("run.completed", tenant, {
      ...ended, ...(result.stopped ? { stopped: result.stopped } : {}), ...(result.inputs?.length ? { inputIds: result.inputs.map(input => input.id) } : {}),
      ...(typeof result.replyIndex === "number" ? { replyIndex: result.replyIndex } : {}), ...(typeof result.messages === "number" ? { messageCount: result.messages } : {}),
    }, key);
  }

  /**
   * A run its model's provider refused for credit (a 402, a quota used up), counted by whose key: the platform's account
   * (or a key the operator set for the tenant) running dry is ours to top up; a tenant's own key, or its endpoint (a
   * gateway answering for its own users' credit), is the tenant's. Not a run its end user's own credit stopped
   * (stopped: spend_limit), which never reached the provider.
   */
  private countBilling(session: Session, record: RequestRecord) {
    const failure = record.outcome?.result as { error?: unknown; stopped?: string; modelError?: { errorClass?: string } } | undefined;
    if (failure?.modelError?.errorClass !== "billing" || !failure.error || failure.stopped) return;
    const keyOwner = spend.endpoint(this.spendContext, session) ? "endpoint" : session.platformKey ? "platform" : "tenant";
    recordBillingFailure({ tenant: session.header.tenant, keyOwner, provider: session.header.config.model.provider });
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

  /**
   * Give the agent's busy slot up once it has no run open or being accepted (`unloading`: it is leaving this node).
   * `ending`: a run that has finished but is not yet marked so, which no longer keeps the agent busy.
   */
  private releaseBusy(session: Session, unloading = false, ending?: string) {
    const busy = this.options.busyAgents;
    if (!busy) return Promise.resolve();
    return this.busyStep(session, async () => {
      if (!session.busy || (!unloading && (session.admitting || [...session.running.values()].some(record => record.id !== ending && RUN_METHODS.includes(record.method))))) return;
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
    catch (error) { this.fail(session, error, "journal"); throw session.fault; }
  }
  private commitLater(session: Session) { void this.commit(session, false).catch(() => {}); }

  /** Fault the session: what it holds is no longer known to be stored. With `store` (the write that failed), the agent is given up too. */
  private fail(session: Session, error: unknown, store?: "journal" | "header" | "transcript") {
    if (session.fault) return;
    // A failed disk commit must never turn into a successful retry from memory. Retryable: the agent is given up, and
    // the next load goes on from what was stored.
    const text = errorText(error);
    session.resumeWait?.abort();
    session.fault = new HttpError(503, text.startsWith(PERSISTENCE_FAILED) ? text : `${PERSISTENCE_FAILED}: ${text}`);
    events.endStreams(session, true);
    events.closeAttached(session);
    if (store) this.releaseFaulted(session, store, error);
  }

  /**
   * Give up an agent whose session faulted while this node still holds it, as a drain does (`leave`), so the next load,
   * here or on a peer, goes on from its journal: a turn that began resumes there (at most MAX_RESUMES times). Sweeps
   * leave it for an interval first, so a database that keeps failing its writes is not retried in a loop; a load that
   * fails backs off as any does (`deferResume`), and a lease that lapses meanwhile fences instead (`lost`).
   */
  private releaseFaulted(session: Session, store: string, error: unknown) {
    const id = session.header.id;
    if (this.closed || session.leaving || this.sessions.get(id) !== session) return;
    if (session.claim && !this.options.ownership!.holds(session.claim)) return;
    console.error(JSON.stringify({ type: "session_fault_released", agent: id, store, running: session.running.size, error: safeError(error) }));
    void (async () => {
      await this.db.query("update agents set resume_after = greatest(coalesce(resume_after, 0), $2) where id = $1", [id, Date.now() + this.sweepMs]).catch(() => {});
      await this.leave(session);
    })();
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
    catch (error) { this.fail(session, error, "journal"); }
  }

  private publish(session: Session, data: ClientEvent) {
    if (this.closed || session.fault) return;
    // Past the ids reserved, events wait for the next block, and any after them with them, so they keep their order.
    if (session.held || session.cursor >= session.reserved) {
      (session.held ??= []).push(data);
      events.reserveEvents(this.eventContext, session);
      return;
    }
    if (data.type === "event" && (session.spans || this.options.tracing)) events.traceEvent(this.eventContext, session, data.requestId, data.event);
    const nested = events.isSubagent(data);
    // A message_update is its delta alone; the runtime keeps the latest message it updates, for snapshots.
    if (data.type === "event") {
      const inner = data.event;
      if (inner?.type === "message_update") { session.partial = inner.message; data = { ...data, event: events.deltaOf(inner) }; }
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
    if (session.reserved - session.cursor <= this.eventBlock / 2) events.reserveEvents(this.eventContext, session);
    session.events.push(event);
    session.eventBytes += event.bytes;
    session.lastActive = Date.now();
    const limit = this.options.eventBytes ?? 2 * 1024 * 1024;
    while (session.events.length > 1 && (session.events.length > events.MAX_BUFFERED_EVENTS || session.eventBytes > limit)) session.eventBytes -= session.events.shift()!.bytes;
    events.follow(session, sent, text, oversized);
    const frame = `id: ${event.id}\ndata: ${text}\n\n`;
    for (const res of events.streams(session)) {
      if (nested && !events.subagentReaders.has(res)) continue;
      const reader = events.readers.get(res);
      if (!reader) { events.send(res, frame); continue; }
      const shown = reader.show(data);
      if (shown !== undefined) events.send(res, shown === data ? frame : `id: ${event.id}\ndata: ${JSON.stringify(shown)}\n\n`);
    }
    for (const wake of [...session.polls]) wake();
    for (const tap of session.taps ?? []) tap(sent);
  }

  /** Event stream subscribers held on this node (a metric: node_load). */
  get watchers() { return this.eventContext.state.watching; }

  /**
   * Watchers and waiting polls of agents no node has loaded: they hold a socket and a place, and no
   * session, claim or journal read. The agent's next load takes them up (here) or ends them (elsewhere,
   * told by `loadedElsewhere`, or found by `tick`'s check of who owns it), so they reconnect to its owner.
   */
  private readonly idle = new Map<string, { tenant: string; watchers: Set<ServerResponse>; polls: Set<() => void>; checked: number }>();

  private get eventBlock() { return this.options.eventBlock ?? events.EVENT_BLOCK; }

  /**
   * The cursor a loaded session starts from (`startingCursor`): where its last owner stopped cleanly
   * (nothing was published since, so a subscriber holding it resumes without a gap), else above every
   * id reserved. Marked unclean, and its first block of ids reserved, before any event, under the
   * claim: a crash of this owner never lets a successor reuse an id it published.
   */
  private async startCursor(id: string, claim: Claim | undefined): Promise<{ cursor: number; reserved: number }> {
    return underClaim(this.db, claim, async sql => {
      const row = (await sql.query("select last_cursor, cursor_clean, reserved_cursor from agents where id = $1 for update", [id])).rows[0];
      const cursor = events.startingCursor(row && events.storedCursor(row), Date.now());
      const reserved = Math.max(cursor + this.eventBlock, Number(row?.reserved_cursor ?? 0));
      await sql.query("update agents set cursor_clean = false, reserved_cursor = $2 where id = $1", [id, reserved]);
      return { cursor, reserved };
    });
  }

  /**
   * The cursor of an agent no node has loaded, for its idle watchers: where its last owner stopped
   * cleanly; for one that stopped otherwise, a cursor above any it used, recorded as clean while no
   * node owns it (a load after takes it up). Undefined when a node owns it now: ask that node.
   */
  private async idleCursor(id: string): Promise<number | undefined> {
    const row = (await this.db.query("select last_cursor, cursor_clean from agents where id = $1", [id])).rows[0];
    if (row?.cursor_clean && row.last_cursor !== null) return Number(row.last_cursor);
    // Above every id reserved, as `startingCursor` starts.
    const { rows } = await this.db.query(`
      update agents set last_cursor = greatest($2::bigint, greatest(coalesce(last_cursor, 0), coalesce(reserved_cursor, 0)) + 1), cursor_clean = true
      where id = $1 and not cursor_clean and not exists (
        select from actor_owners o join runtime_nodes n on n.node = o.node and n.session = o.session and n.expires_at > now() where o.actor = $1)
      returning last_cursor`, [id, Date.now() * 1000]);
    if (rows[0]) return Number(rows[0].last_cursor);
    const again = (await this.db.query("select last_cursor, cursor_clean from agents where id = $1", [id])).rows[0];
    return again?.cursor_clean && again.last_cursor !== null ? Number(again.last_cursor) : undefined;
  }

  /** Another node loaded an agent (or this one is leaving): end the idle watchers and polls this node holds for it, so they reconnect to it. */
  loadedElsewhere(id: string, reason: events.ReconnectReason = "moved") {
    const entry = this.idle.get(id);
    if (!entry) return;
    this.idle.delete(id);
    for (const res of entry.watchers) if (!res.destroyed) res.end(events.reconnectFrame(reason));
    for (const wake of [...entry.polls]) wake();
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
    if (snapshot && (cursor === 0 || gap)) return { cursor: session.cursor, snapshot: events.turnSnapshot(this.eventContext, session), events: [] };
    if (cursor !== 0 && gap) throw new HttpError(409, "REPLAY_GAP: recover from session state");
    return { cursor, events: session.events.filter(event => event.id > cursor) };
  }

  private busy(session: Session) {
    return !!session.starting || session.settling > 0 || session.inflight > 0 || session.running.size > 0;
  }

  /**
   * The tenant's agents on this node but `id`: hosted, starting, or with a slot reserved (a create not yet loaded). Stateless
   * runs are not agents here: each is busy while it is hosted, so the tenant's busy limit bounds them.
   */
  private tenantAgents(tenant: string, id?: string) {
    const ids = new Set<string>();
    for (const session of this.sessions.values()) {
      const other = session.header.id;
      if (session.header.tenant === tenant && !session.header.run && (this.supervisor.agents.has(other) || this.supervisor.starting.has(other))) ids.add(other);
    }
    for (const [other, owner] of this.supervisor.reserved) if (owner === tenant && !this.sessions.get(other)?.header.run && !this.creatingRuns.has(other)) ids.add(other);
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
    return !this.supervisor.memoryHigh && (!this.supervisor.full || !!this.idleAgent(() => true));
  }

  /**
   * Make room to start `starting`'s agent, and reserve its slot: first within its
   * tenant's quota, so one tenant cannot take every slot, then on the host. Only
   * idle agents are stopped, least recently active first. Agents still starting
   * count, and the last check and the reservation happen with no await between
   * them, so concurrent starts cannot together pass either limit. The slot is
   * held until the supervisor starts the agent or `unreserve` gives it back.
   */
  private async makeRoom(id: string, tenant: string, run = false) {
    // A stateless run takes no place in its tenant's quota of agents (see `tenantAgents`), only one on the node.
    const { quota, source } = run ? { quota: undefined, source: "default" } : await this.quota(tenant);
    const evict = async (idle: Session | undefined) => { if (idle) await this.supervisor.stop(idle.header.id); return !!idle; };
    const reject = (status: 429 | 503, limit: string, value: number, message: string) => {
      console.log(JSON.stringify({ type: "quota_rejected", level: "info", tenant, agent: id, limit, value, source: limit === "agentsPerTenant" ? source : "node", status }));
      // The node's own limits (its count, its memory), which a peer with room does not share (see `run`).
      return Object.assign(new HttpError(status, message), status === 503 ? { nodeFull: true } : {});
    };
    for (;;) {
      if (this.supervisor.reserved.has(id) || this.supervisor.agents.has(id) || this.supervisor.starting.has(id)) return;
      // Short of memory: one idle agent goes, which frees some once collected, and this start is refused (or handed to a
      // peer, `run`). Stopping every idle agent for one start would not free memory any sooner.
      if (this.supervisor.memoryHigh) {
        await evict(this.idleAgent(() => true, id));
        throw reject(503, "memory", Math.round(process.memoryUsage.rss() / 1_048_576), "This node is short of memory; retry");
      }
      if (quota && this.tenantAgents(tenant, id) >= quota) {
        if (!await evict(this.idleAgent(session => session.header.tenant === tenant, id))) throw reject(429, "agentsPerTenant", quota, `This tenant already has ${quota} agents running; retry when one finishes`);
        continue;
      }
      if (this.supervisor.reserve(id, tenant)) return;
      if (!await evict(this.idleAgent(() => true, id))) throw reject(503, "agentsPerNode", this.supervisor.options.maxAgents ?? 8, "Agent capacity reached; retry when another agent is idle");
    }
  }

  /** Start the agent's host, unless it runs. */
  private ensureStarted(session: Session): Promise<any> {
    if (this.closed || session.header.revoked) return Promise.reject(new HttpError(410, "Session closed"));
    if (session.fault) return Promise.reject(session.fault);
    session.lastActive = Date.now();
    const id = session.header.id;
    if (this.supervisor.agents.has(id) && !session.starting) return Promise.resolve();
    const steps = new Steps();
    return session.starting ??= (async () => {
      await steps.time("room", this.makeRoom(id, session.header.tenant, !!session.header.run));
      // Read before any response is counted against it.
      await steps.time("spend", this.spendOf(session));
      const [{ key: apiKey, platform }, priced] = await steps.time("key", Promise.all([configuration.resolveApiKey(this.configurationContext, session, session.header.config.model.provider, session.header.keyScope), this.options.catalogPriced?.(session.header.tenant)]));
      session.platformKey = platform;
      session.catalogPriced = !!priced;
      // Its tool servers are listed (remote MCP servers connected to) before its host starts.
      session.hosted = session.header.mounts ?? [];
      session.computerRevision = await this.options.sources?.computerRevision(session.header.tenant, session.header.id);
      const definitions = await steps.time("tools", tools.toolset(this.toolsContext, session));
      const { cpuMs, maxTimeoutMs } = await spend.codeLimits(this.spendContext, session.header.tenant);
      // Lost or given up while it got ready (its node fenced, or is leaving): it starts nothing. A host started now would
      // serve an owner that is gone, and whoever loads the agent next would find it and take it for theirs, still starting.
      if (session.fault || session.leaving) throw session.fault ?? new Error("Agent stopped");
      const result = await steps.time("init", this.supervisor.start(session.header.id, { ...session.header.config, model: withCatalogPrices(session.header.config.model), apiKey, mounts: VolumeService.markWorkspace(session.header.id, session.header.mounts ?? []).map(({ path, mode, workspace }) => ({ path, mode, ...workspace ? { workspace } : {} })), ...(this.options.retry ? { retry: this.options.retry } : {}), ...(this.options.streamTimeouts ? { streamTimeouts: this.options.streamTimeouts } : {}), contextRangeMaxBytes: this.options.contextRangeMaxBytes, ...(session.resuming.size ? { resume: true } : {}), tenant: session.header.tenant, codeLimits: { cpuMs, maxTimeoutMs } }, {
        definitions,
        codeSlot: async signal => this.codeGate.acquire(session.header.tenant, (await spend.codeLimits(this.spendContext, session.header.tenant)).concurrent, signal),
        runLimit: async () => {
          // Which limit stopped it: the run's, the agent's, or the tenant's (its monthly cap, a message; its credit, a 402).
          const agentLimit = await this.agentSpendLimit(session);
          const runLimit = agentLimit === undefined ? spend.runSpendLimit(session) : undefined;
          const tenantLimit = agentLimit === undefined && runLimit === undefined ? await this.options.spendLimit?.(session.header.tenant) : undefined;
          const limited = agentLimit ?? runLimit ?? tenantLimit;
          if (limited) return { stopped: "spend_limit" as const, message: typeof limited === "string" ? limited : limited.message, limit: agentLimit ? "agent" as const : runLimit ? "run" as const : typeof tenantLimit === "string" ? "tenant" as const : "credit" as const };
          const turn = await spend.turnLimit(this.spendContext, session);
          if (turn) return { stopped: "turn_limit" as const, message: turn };
          // Its end user has nothing left for its next model request: stopped here, rather than refused at the request.
          const payer = spend.modelPayer(this.spendContext, session, runningRun(session));
          const broke = payer && await this.options.endUsers?.refusal(session.header.tenant, payer.id, payer.bucket);
          if (broke) return { stopped: "spend_limit" as const, message: broke.message, limit: "end_user" as const, code: END_USER_CREDIT, reason: broke.reason, bucket: broke.bucket, endUser: broke.endUser };
          // This node is leaving: the turn stops at this step boundary, and its next owner continues it (`park`).
          return this.handingOff ? { stopped: "handoff" as const, message: `This node is leaving the cluster (${this.handingOff.reason}); the turn continues on another` } : undefined;
        },
        call: (name, args, signal, context) => tools.callTool(this.toolsContext, session, { name, args, signal, ...context }),
        file: ref => tools.fileData(this.toolsContext, session, ref),
        modelAuth: () => configuration.modelAuth(this.configurationContext, session),
        modelAttempt: async event => {
          if (event.type === "begin" && session.header.revoked) return Promise.reject(new Error("Session revoked"));
          const run = runningRun(session);
          const { identity, keyScope } = session.header;
          // Who pays is the runtime's to say, never the host's: the agent's subject, from its run's bucket.
          const payer = event.type === "begin" ? spend.modelPayer(this.spendContext, session, run) : undefined;
          const { endUser: _given, ...asked } = event as Extract<typeof event, { type: "begin" }>;
          const scoped = event.type === "begin" ? { ...asked, ...(payer ? { endUser: payer } : {}), context: { ...(run ? { requestId: run.id, actor: run.actor } : {}), ...(identity ? { identity } : {}), ...(keyScope ? { keyScope } : {}) } } : event;
          const tracked = await this.options.modelAttempt?.(session.header.tenant, session.header.id, !!session.platformKey, !!session.catalogPriced, scoped) ?? false;
          // Persisting a begin may span a database outage; recheck ownership before dispatch.
          if (event.type === "begin") {
            if (session.header.revoked) throw new Error("Session revoked");
            await this.leased(session);
          }
          return tracked;
        },
        fs: (op, args, signal) => tools.fsCall(this.toolsContext, session, op, args, signal),
        search: async query => { await this.leased(session); return tools.searchTools(this.toolsContext, session, query); },
        lease: () => this.leased(session),
        background: event => this.backgroundEvent(session, event),
        committing: entry => spend.entryEffect(this.spendContext, session, entry),
        history: {
          // One whose create failed before writing its row begins it now, and is indexed from its log.
          indexed: async () => (await this.historyIndex.indexed(id)) ?? (await this.historyIndex.begin(id), 0),
          write: chunk => this.historyIndex.write(id, session.claim, chunk),
        },
      }, session.claim));
      // Init can recover native responses through committing without emitting their old message_end events.
      await spend.refreshSpend(this.spendContext, session);
      // Bootstrap history has been imported into the journal; keep only one authority.
      if (session.header.config.initialMessages !== undefined) {
        delete session.header.config.initialMessages;
        await this.writeHeader(session);
      }
      session.handoff = result.resume;
      session.ended = result.ended;
      // A turn handed off at a step boundary lost nothing: it simply goes on here.
      const handed = [...session.resuming].map(id => session.requests.get(id)).find(record => record?.handedOff);
      if (result.resume && "continue" in result.resume && handed) this.publish(session, { type: "event", requestId: "", event: { type: "turn_resumed", handoff: handed.handoffs?.at(-1)?.reason ?? "retire", reason: "The node running this turn left the cluster; it continues here from the step it finished" } });
      else if (result.resume && "continue" in result.resume) this.publish(session, { type: "event", requestId: "", event: { type: "turn_resumed", reason: "The node running this turn was lost; it continues here, with unresolved tool calls marked unknown" } });
      else if (result.recovered) this.publish(session, { type: "event", requestId: "", event: { type: "turn_recovered", reason: "The runtime restarted during a turn; unresolved tool calls were marked unknown" } });
      // Starting can take longer than the idle timeout; the agent is fresh, not idle.
      session.lastActive = Date.now();
      recordStart(steps, { tenant: session.header.tenant, agent: id });
      return result;
    })().catch(error => {
      recordStart(steps, { tenant: session.header.tenant, agent: id, error: safeError(error) });
      // Its history is only in the legacy format (agent-host.ts `open`): the caller is told why it cannot run.
      const text = errorText(error);
      if (text.startsWith(`${CONTEXT_TOO_LARGE}: `)) throw new HttpError(409, text.slice(CONTEXT_TOO_LARGE.length + 2), CONTEXT_TOO_LARGE);
      if (text.includes(NOT_MIGRATED)) throw new HttpError(409, text.slice(text.indexOf(NOT_MIGRATED)), NOT_MIGRATED);
      throw error;
    })
      .finally(() => { session.starting = undefined; this.supervisor.unreserve(id); });
  }

  /**
   * What each of a tenant's agent's tool sources offers, and which tools its model gets. A running
   * agent shows the lists its tools were built from; otherwise MCP servers show what this node last
   * listed, or `unlisted`. `refresh` lists every MCP server now, connecting to it: what the servers
   * offer at this moment, which a running agent takes at its next start or reconfiguration.
   */
  async toolSources(id: string, tenant: string, options: { refresh?: boolean; schemas?: boolean } = {}) { return tools.toolSources(this.toolsContext, id, tenant, options); }

  /**
   * Sweep for children whose ending was not delivered, on any node: rows whose ending is recorded, and running rows not
   * checked for a while, whose child's request is asked after (its node may have been lost as the run ended). Claimed a
   * batch at a time (`skip locked`), so nodes sweeping together share the work. A delegate child's row is its own case
   * (`sweepDelegate`): its answer goes to its call, never as a notification.
   */
  async sweepChildren(now = Date.now()) { return childSessions.sweepChildren(this.childrenContext, now); }

  /** Whether `child` is one of `parent`'s background sub-agents (a browser token's `children` scope). */
  async isChildOf(child: string, parent: string) { return childSessions.isChildOf(this.childrenContext, child, parent); }

  /** Mark the run that has begun as aborted, so it does not start if the agent does not have it yet (see `execute`). */
  private markAborted(session: Session) {
    const run = runningRun(session);
    if (run) (session.aborted ??= new Set()).add(run.id);
    session.resumeWait?.abort();
  }

  /**
   * Stop the agent (an abort): its running run ends, aborted, and unless `queued` is "keep", every run queued behind it
   * that has not begun is cancelled, each ending with code `cancelled` and a `run_cancelled` event, as are the messages
   * the agent holds for its turn (steers), so nothing runs after the stop. A `resume` that closes a suspended turn
   * without the model (an abort queues one) and configuration still go ahead. The running run is marked aborted durably
   * first (`abortedAt`), so no node resumes it should this one be lost before it ends. Returns the cancelled runs' ids.
   */
  private async stop(session: Session, queued: "cancel" | "keep" = "cancel", children: "abort" | "keep" = "abort"): Promise<string[]> {
    const id = session.header.id;
    const announcing = queued === "cancel" && await (this.options.runEvents?.(session.header.tenant) ?? false);
    const now = Date.now();
    const run = runningRun(session);
    if (run && run.abortedAt === undefined) this.upsertRequest(session, { ...run, abortedAt: now });
    const cancelled: RequestRecord[] = [];
    let kept = false;
    if (queued === "cancel") {
      for (const record of [...session.running.values()]) {
        if (record.began || !CANCELLABLE.includes(record.method)) continue;
        // A sub-agent's notification (or message to its parent) is the runtime's, sent once: it is not cancelled, but
        // lands without a turn, so what the sub-agent said stays in history.
        const notice = (record.params as { notice?: { metadata?: { to?: string } } } | undefined)?.notice;
        if (notice && notice.metadata?.to !== "child") {
          this.upsertRequest(session, { ...record, landOnly: STOPPED_NOTICE });
          reachable("an abort reached a notification queued behind the turn, which lands without one");
          kept = true;
          continue;
        }
        const { params: _params, ...rest } = record;
        cancelled.push(this.upsertRequest(session, { ...rest, state: "completed", endedAt: now, outcome: { result: { error: CANCELLED, code: "cancelled" } }, ...(announcing ? { announce: true as const } : {}) }));
      }
    }
    // The cancelled runs' slot (when nothing else holds the agent busy) is free before they are seen to end.
    if (cancelled.length) await this.releaseBusy(session);
    if (run || cancelled.length || kept) await this.commit(session, true);
    for (const record of cancelled) {
      this.publish(session, { type: "event", requestId: record.id, event: { type: "run_cancelled", reason: "stopped" } });
      this.publish(session, { type: "response", id: record.id, outcome: record.outcome! });
    }
    const unannounced = cancelled.filter(record => record.announce);
    if (unannounced.length) void this.announce(session, unannounced);
    this.markAborted(session);
    const delegates = delegation.stopDelegates(this.delegationContext, session);
    if (children === "abort") childSessions.abortBackground(this.childrenContext, session);
    if (this.supervisor.agents.has(id)) await this.supervisor.request(id, "abort", queued === "cancel" ? { clearQueued: true } : {});
    // The stop answers once its delegate children have ended (or STOP_CHILDREN_MS passed): it never says stopped while they run.
    await delegates;
    return cancelled.map(record => record.id);
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
    const until = Date.now() + Math.min(waitMs, events.MAX_POLL_WAIT_MS);
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

  /** A tenant's agent's inputs (`state`: pending, say), newest first. */
  async inputsFor(id: string, tenant: string, state?: string) { return humanInput.inputsFor(this.inputsContext, id, tenant, state); }

  /**
   * Answer a tenant's agent's inputs, all of them or none, on any node. An input settles once: the
   * same answer again is 200, a different one 409. Whoever a request names (`from`, `actor`) must be
   * among those who may answer (403). The last answer of a suspension queues its `resume` run on the
   * node serving the agent, returned in `requests`.
   */
  async answer(id: string, tenant: string, answers: { id: string; body: any }[], via: Responder["via"] = "api"): Promise<{ status: 200 | 202; inputs: Input[]; requests: RequestRecord[] }> { return humanInput.answer(this.inputsContext, id, tenant, answers, via); }

  /** A tenant's inputs across its agents, newest first: the inbox of what waits on someone. */
  async inbox(tenant: string, state?: string) { return humanInput.inbox(this.inputsContext, tenant, state); }

  /**
   * Expire inputs past their time, on any node: each suspension whose last input expired is resumed
   * on the node serving its agent, which closes the turn (or, with `onExpire: "resume"`, asks the model).
   */
  async expireInputs(now = Date.now()) { return humanInput.expireInputs(this.inputsContext, now); }

  /** The id of the agent `create` makes for a tenant's idempotency key. */
  agentId(tenant: string, key: string) { return configuration.agentId(tenant, key); }

  /**
   * Provision an agent, idempotently per `key`. An agent made from a definition records it
   * (`origin.definition`), and `origin.provision` stands for its configuration in the
   * idempotency check, so a retry after the definition changed returns the same agent.
   */
  async create(definitions: ToolDefinition[], config: Omit<AgentConfig, "id" | "directory" | "tools">, given: string | undefined, metadata: AgentMetadata = {}, tenant: string, ttlMs?: number | null, mounts?: unknown, origin?: { definition: DefinitionRef; provision: unknown; overrides?: string[]; sources?: Sources }, identity?: AgentIdentity, access: { keyScope?: string; spendLimit?: number; bucket?: string; toolsHash?: string; remount?: boolean; idleTtlMs?: number; builtins?: string[]; delegate?: DelegateSettings; mcpServers?: McpServerSpec[]; parent?: SessionHeader["parent"]; fork?: { id: string; from: ForkedFrom; messages: AgentMessage[]; turns: number[]; model: Message[] }; admit?: (unchanged: boolean) => Promise<unknown>; run?: RunSettings } = {}, steps = new Steps()): Promise<{ id: string; token: string; expiresAt: number | null; [status: string]: unknown }> { return configuration.create(this.configurationContext, definitions, config, given, metadata, tenant, ttlMs, mounts, origin, identity, access, steps); }

  /**
   * A new token for a tenant's agent: the old one stops working at once, here and on every node (they check the header
   * this writes), and connections made with it (the application's, event streams) are closed. Applications reconnect
   * with the new one, which `credentials` gives from now on.
   */
  async rotateToken(id: string, tenant: string): Promise<{ id: string; token: string; expiresAt: number | null }> { return configuration.rotateToken(this.configurationContext, id, tenant); }

  /**
   * A fork's history before it exists, under its claim: its copied messages in its history index (again from where a
   * create of it that failed left them), then its journal, whose history starts after them, its model from `model`.
   */
  private async seedFork(id: string, claim: Claim | undefined, fork: { messages: AgentMessage[]; turns: number[]; model: Message[] }) {
    let indexed = (await this.historyIndex.indexed(id)) ?? 0;
    for (const chunk of chunksOf({ from: 0, messages: fork.messages, sizes: fork.messages.map(message => JSON.stringify(message).length), turns: fork.turns })) {
      if (chunk.start + chunk.messages.length <= indexed) continue;
      indexed = await this.historyIndex.write(id, claim, chunk, { creating: true });
      if (indexed !== chunk.start + chunk.messages.length) throw new Error(`The fork's history index ends at ${indexed}, not ${chunk.start + chunk.messages.length}`);
    }
    const requests = fork.messages.flatMap(message => message.role === "user" && (message as { requestId?: string }).requestId ? [(message as { requestId?: string }).requestId!] : []);
    await this.supervisor.seed(id, { before: fork.messages.length, requests, model: fork.model }, claim);
  }

  /**
   * A new agent with `source`'s configuration and a copy of its history and workspace (POST /v1/agents/:id/fork), on
   * the node serving `source`. Its history is the source's as its index and journal hold it (every message a turn
   * committed, wherever the source runs) up to the fork point (`journalForkCut`), and its model context Pi's as of
   * there (raw history before Pi's retained head): copies of its own, sharing nothing mutable with the source, whose
   * FileRefs are pinned to it. Its workspace volume is a fork of the source's, as it is
   * now; other mounts are the same volumes. Not copied: schedules, channels, inputs, requests and spend so far. Who it
   * acts for (`identity`), its prompt addition and its model headers may be its own. With a key, a retry returns the same fork; a key naming
   * another agent is refused.
   */
  async fork(sourceId: string, tenant: string, input: { key?: string; name?: string; atMessage?: number | string; ttlMs?: number | null; identity?: AgentIdentity; systemPromptAppend?: string; modelHeaders?: Record<string, string> | null }, steps = new Steps()) {
    const source = this.sessions.get(sourceId)?.header ?? (await this.readHeader(sourceId))?.value;
    if (!source || source.tenant !== tenant || source.revoked || source.purged || expired(source.expiresAt)) throw new HttpError(404, "Unknown agent");
    const key = input.key ?? randomUUID();
    if (!validId(key)) throw new HttpError(400, "Invalid fork key");
    const made = await steps.time("lookup", configuration.keyed(this.configurationContext, tenant, key));
    const found = this.sessions.get(made.id)?.header ?? made.existing?.value;
    const answer = (header: SessionHeader) => {
      if (header.tenant !== tenant || header.forkedFrom?.agentId !== sourceId) throw new HttpError(409, "This key names another agent, not a fork of this one; use another key");
      return { id: header.id, token: made.token, expiresAt: header.expiresAt, forkedFrom: header.forkedFrom };
    };
    if (found) return answer(found);
    // Cut from the source's journal (pi-durable/fork.ts): its history, and Pi's context as of the cut.
    const indexed = (await this.historyIndex.indexed(sourceId)) ?? 0;
    let cut = await steps.time("history", this.supervisor.journalFork(sourceId, indexed, count => this.historyIndex.messages(sourceId, count), input.atMessage));
    // A source that never started has no journal: its history is what it was created with, if anything.
    if (!cut) {
      const { messages, compaction } = source.config.initialMessages?.length ? importedHistory(source.config.initialMessages) : { messages: [], compaction: undefined };
      const count = input.atMessage === undefined ? messages.length : typeof input.atMessage === "number" && Number.isSafeInteger(input.atMessage) && input.atMessage >= 0 && input.atMessage < messages.length ? input.atMessage + 1 : -1;
      if (count < 0) throw new HttpError(400, `atMessage is a history index from 0 to ${messages.length - 1}`, "FORK_POINT_INVALID");
      const kept = messages.slice(0, count);
      // Its summary, if it covers no more than the fork keeps, then what follows it.
      const summary = compaction && compaction.cut <= count ? [createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, new Date(compaction.at).toISOString()) as AgentMessage] : [];
      cut = { through: count ? count - 1 : null, messages: kept, turns: kept.flatMap((message, index) => message.role === "user" && kept[index - 1]?.role !== "user" ? [index] : []),
        model: convertToLlm([...summary, ...kept.slice(summary.length ? compaction!.cut : 0)]),
        ...(compaction && count < compaction.cut ? { fromHistory: true as const } : {}) };
    }
    if (cut.fromHistory) console.log(JSON.stringify({ type: "fork_from_history", agent: sourceId, at: cut.through, messageCount: cut.messages.length }));
    const from: ForkedFrom = { agentId: sourceId, atMessage: cut.through };
    // The source's own workspace is forked for the fork, under the id its workspace has; shared volumes stay shared.
    let mounts: unknown[] | undefined = source.mounts;
    const workspace = VolumeService.workspaceOf(sourceId);
    if (this.options.volumes && source.mounts) {
      const into = VolumeService.workspaceOf(made.id);
      if (source.mounts.some(mount => mount.volumeId === workspace)) await steps.time("volume", this.options.volumes.call(workspace, tenant, "fork", { name: "workspace", into }));
      // Given as the source's were, so the fork's workspace is where the source's is, and there is none if it had none.
      mounts = VolumeService.given(made.id, source.mounts.map(mount => mount.volumeId === workspace ? { ...mount, volumeId: into } : mount));
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
      { keyScope: source.keyScope, ...(spend ? { spendLimit: Number(spend.usd) } : {}), toolsHash: source.toolsHash, ...source.definition ? {} : { builtins: source.sources?.builtins, delegate: source.sources?.delegate, mcpServers: source.sources?.mcpServers, ...(source.sources?.decide !== undefined ? { decide: source.sources.decide } : {}) }, fork: { id: made.id, from, messages: cut.messages, turns: cut.turns, model: cut.model } }, steps);
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
    // Its children's rows go with it; a child's own row stays for its parent, whose next sweep hears it is gone.
    await sql.query("delete from agent_children where parent = $1", [id]);
    await this.storage.removeLog(this.journalKey(id));
    await this.supervisor.purge(id, sql);
    await this.historyIndex.remove(id, sql);
    await deleteTail(sql, id, [this.journalKey(id), AgentSupervisor.transcriptKey(id)]);
  }

  /** A tenant's live agents (not its stateless runs' sessions). `running` covers agents served by any node. */
  async list(tenant: string) { return (await configuration.list(this.configurationContext, tenant)).agents; }
  /** GET /v1/agents: filtered, and a page of them with `limit` (`next` when there are more). */
  async page(tenant: string, query: configuration.AgentListQuery) { return configuration.list(this.configurationContext, tenant, query); }

  /**
   * Whether `id` is one of `tenant`'s live agents (one read, not a listing); with `agentsOnly`, not a stateless run's
   * session, which the agents API does not show.
   */
  async owns(id: string, tenant: string, agentsOnly = false) {
    if (!validSessionId(id)) return false;
    const { rowCount } = await this.db.query(`select 1 from agents where id = $1 and tenant = $2 and not revoked and (expires_at is null or expires_at > $3)${agentsOnly ? " and header->'run' is null" : ""}`, [id, tenant, Date.now()]);
    return !!rowCount;
  }

  /**
   * An existing agent's credentials, by its id or the key it was made with, without touching its configuration (an
   * upsert would set it to what the caller passes). The token is the one `create` gave: derived from the key and its
   * generation, so only an agent made with a key has one to give again; or, once rotated (`rotateToken`), the latest.
   */
  async credentials(tenant: string, ref: string): Promise<{ id: string; token: string; expiresAt: number | null; configHash?: string }> { return configuration.credentials(this.configurationContext, tenant, ref); }

  async inspect(id: string, tenant: string) { return configuration.inspect(this.configurationContext, id, tenant); }

  /**
   * One of a tenant's agent's requests (`GET /v1/agents/:id/requests/:requestId`). With `wait` (seconds, at most 25)
   * and the request still running, it answers once it settles or the wait ends, woken as the events poll is.
   */
  async requestFor(c: Context, id: string, tenant: string, requestId: string) {
    const session = (await this.owns(id, tenant)) ? await this.load(id) : undefined;
    if (!session) throw new HttpError(404, "Agent not found");
    return events.settled(this.eventContext, c as Context<ClientEnv>, session, requestId);
  }

  /**
   * A tenant's watcher on one of its agents' event streams (or, with `?poll=1`, one poll of it):
   * what `/clients/:id/events?watch=1` gives a holder of the agent's token, for a server that keeps
   * no per-agent tokens. `c.env.outgoing` is the raw response the stream is written to.
   */
  async watchFor(c: Context, id: string, tenant: string, reader?: events.StreamReader) {
    const header = (await this.owns(id, tenant)) ? this.sessions.get(id)?.header ?? (await this.readHeader(id))?.value : undefined;
    if (!header || header.purged) throw new HttpError(404, "Unknown agent");
    return events.watchAgent(this.eventContext, c as Context<ClientEnv>, header, c.req.query("poll") === "1" ? "poll" : "watch", reader);
  }

  /** A tenant's stateless run's session header (`id`: the session's), or 404. */
  private async runHeader(id: string, tenant: string) {
    const header = (await this.owns(id, tenant)) ? this.sessions.get(id)?.header ?? (await this.readHeader(id))?.value : undefined;
    if (!header?.run || header.purged) throw new HttpError(404, "Unknown run");
    return header;
  }

  /**
   * A tenant's stateless run (`id`: its session's) and its request, once it ends or `waitMs` passes (at most 25 s). A run
   * that ended is read from storage where no node holds it; one still open is waited on where it is loaded, or loaded here
   * (which resumes it, if the node running it was lost).
   */
  async runRecord(id: string, tenant: string, waitMs = 0, signal?: AbortSignal): Promise<{ header: SessionHeader; record: RequestRecord }> {
    const header = await this.runHeader(id, tenant);
    const requestId = runIdOf(id);
    if (this.unloaded(id)) {
      const stored = (await this.storedRequests(id)).find(record => record.id === requestId);
      if (stored && (stored.state === "completed" || waitMs <= 0)) return { header, record: stored };
    }
    const record = await this.awaitRequest(id, tenant, requestId, waitMs, signal);
    if (!record) throw new HttpError(404, "Unknown run");
    return { header: this.sessions.get(id)?.header ?? header, record };
  }

  /**
   * A tenant's stateless run's event stream: its events after `Last-Event-ID` (or a snapshot, as a watcher gets one),
   * ending with its response. A run that ended where no node holds it any more answers with its response alone.
   */
  async runEvents(c: Context, id: string, tenant: string) {
    const header = await this.runHeader(id, tenant);
    const requestId = runIdOf(id);
    if (this.unloaded(id)) {
      const ended = (await this.storedRequests(id)).find(record => record.id === requestId && record.state === "completed");
      if (ended) {
        const res = (c as Context<ClientEnv>).env.outgoing;
        const cursor = await this.idleCursor(id) ?? 0;
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        res.write(`event: ready\ndata: ${JSON.stringify({ version: 5, runId: requestId, watch: true })}\n\n`);
        res.end(`id: ${cursor}\ndata: ${JSON.stringify({ type: "response", id: requestId, outcome: ended.outcome })}\n\n`);
        return RESPONSE_ALREADY_SENT;
      }
    }
    return events.watchAgent(this.eventContext, c as Context<ClientEnv>, header, "watch");
  }

  /**
   * An agent as its MCP endpoint (agent-mcp.ts) shows it, while it lives: its tenant, what it is called and the
   * definition it is made from, and whether `authorization` carries its own token, as its `/clients/:id` routes check.
   * Read without loading it.
   */
  async mcpView(id: string, authorization: string) {
    const header = this.sessions.get(id)?.header ?? (await this.readHeader(id))?.value;
    if (!header || header.revoked || header.purged || header.run || expired(header.expiresAt)) return undefined;
    const own = authorization.startsWith("Bearer ") && timingSafeEqual(Buffer.from(hash(authorization.slice(7)), "hex"), Buffer.from(header.digest, "hex"));
    return { tenant: header.tenant, own, name: header.metadata?.name ?? header.key, definition: header.definition?.id };
  }

  /** A tenant's view of one agent's request state and stream cursor (`/clients/:id/state`). */
  async stateFor(id: string, tenant: string) {
    if (!await this.owns(id, tenant)) throw new HttpError(404, "Unknown agent");
    if (this.unloaded(id)) {
      // Its cursor is where a stream of it picks up (see `idleCursor`); undefined: a node has just taken it.
      const cursor = await this.idleCursor(id);
      if (cursor !== undefined && this.unloaded(id)) {
        const requests = await this.storedRequests(id);
        return { cursor, requests, ...activityOf(requests), ...await this.resumeState(id) };
      }
    }
    const session = await this.load(id);
    if (!session) throw new HttpError(404, "Unknown agent");
    return { cursor: session.cursor, requests: [...session.requests.values()].map(visible), ...activityOf(session.running.values()) };
  }

  /** A tenant's view of one agent's history; undefined when the agent is not theirs. */
  async agentHistory(id: string, tenant: string) {
    if (!await this.owns(id, tenant)) return undefined;
    // An agent no node has loaded is read from storage, not loaded for it (see `unloaded`).
    if (this.unloaded(id)) return { messages: await this.unloadedHistory(id, tenant) };
    const session = await this.load(id);
    return session && this.history(session);
  }

  /** An unloaded agent's full history: its index's chunks, and the journal after them. */
  private async unloadedHistory(id: string, _tenant: string) {
    return this.supervisor.history(id, count => this.historyIndex.messages(id, count));
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
   * at most an hour. A window counts once, however many nodes met it. Beginning a resumed run
   * preserves the backoff; only ending a run or beginning new work resets it.
   */
  private async deferResume(id: string, error: unknown) {
    const now = Date.now();
    const { rows } = await this.db.query(`update agents set resume_failures = resume_failures + 1,
        resume_after = $2 + least($3 * power(2, least(resume_failures, 30))::bigint, $4)
      where id = $1 and (resume_after is null or resume_after <= $2) returning resume_failures`,
      [id, now, this.sweepMs, MAX_RESUME_DELAY_MS]).catch(() => ({ rows: [] as { resume_failures: number }[] }));
    if (rows[0]) console.error(JSON.stringify({ type: "agent_resume_failed", agent: id, failures: rows[0].resume_failures, error: safeError(error) }));
  }
  private resetSweep(session: Session) {
    session.sweepResetAt = undefined;
    return underClaim(this.db, session.claim, sql => sql.query("update agents set sweep_failures = 0, sweep_after = null where id = $1 and (sweep_failures <> 0 or sweep_after is not null)", [session.header.id]));
  }
  private resetResumes(session: Session) {
    return underClaim(this.db, session.claim, sql => sql.query("update agents set turn_resumes = 0, resume_failures = 0, resume_after = null where id = $1 and (turn_resumes <> 0 or resume_failures <> 0 or resume_after is not null)", [session.header.id]));
  }
  private get sweepMs() { return this.options.orphanSweepMs || 30_000; }

  /**
   * Give an agent back that this node took over but has no room to run (it had room when it loaded it,
   * and lost it since): its runs stay open, and sweeps leave it for an interval, to a node with room.
   */
  private async handBack(session: Session) {
    if (session.handedBack) return;
    session.handedBack = true;
    events.idleWatchers(this.eventContext, session);
    if (session.response && !session.response.destroyed) session.response.end(events.reconnectFrame("moved"));
    await this.db.query("update agents set resume_after = $2 where id = $1", [session.header.id, Date.now() + this.sweepMs]).catch(() => {});
    await this.unload(session);
  }

  /**
   * Load agents with work left (see `workLeft`), as many as this node has room for, so their runs resume
   * even when no one acts on them. Every node sweeps; taking ownership decides which loads each.
   */
  async resumeOrphans(limit = 10) {
    if (this.closed || this.draining || this.supervisor.full || this.supervisor.memoryHigh) return 0;
    const { rows } = await this.db.query(`
      select a.id, a.tenant from agents a
      where a.pending_runs and not a.revoked and a.purged_at is null and (a.expires_at is null or a.expires_at > $1)
        and (a.resume_after is null or a.resume_after <= $1)
        and (a.sweep_after is null or a.sweep_after <= $1)
        and not exists (select from actor_owners o join runtime_nodes n on n.node = o.node and n.session = o.session and n.expires_at > now() where o.actor = a.id)
      order by random() limit $2`, [Date.now(), limit]);
    const loaded: string[] = [];
    for (const { id, tenant } of rows) {
      if (this.sessions.has(id) || this.loading.has(id) || !await this.canReserve(tenant)) continue;
      try { if (await this.load(id, true)) loaded.push(id); }
      catch (error) { if (!(error instanceof NotOwner)) await this.deferResume(id, error); }
    }
    if (loaded.length) console.log(JSON.stringify({ type: "agents_resumed", count: loaded.length, agents: loaded }));
    return loaded.length;
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
  /**
   * Stop a tenant's agent (`stop`): its running turn, and unless `queued` is "keep", the runs queued behind it. Returns
   * the cancelled runs' ids, or false when the agent is not theirs.
   */
  async abortAgent(id: string, tenant: string, queued: "cancel" | "keep" = "cancel", children: "abort" | "keep" = "abort"): Promise<false | { cancelled: string[] }> {
    if (!await this.owns(id, tenant)) return false;
    const session = await this.load(id);
    if (!session) return false;
    await session.starting?.catch(() => {});
    const cancelled = await this.stop(session, queued, children);
    if (this.options.inputs) await humanInput.cancelInputs(this.inputsContext, session, "aborted");
    return { cancelled };
  }

  /**
   * Reset an idle agent's Pi context (POST /v1/agents/:id/context/reset): its host is stopped if it runs, and a new
   * checkpoint (its system message, a summary, its last `keepMessages` history messages) is written to its journal
   * without loading the context it replaces (pi-durable/reset.ts). Its history and history index stay as they were.
   * Refused (409 AGENT_BUSY) while a run is open or queued; queued behind nothing, a run sent meanwhile waits for it.
   */
  async resetContext(id: string, tenant: string, input: { summary?: string; keepMessages?: number }) {
    if (!await this.owns(id, tenant)) throw new HttpError(404, "Agent not found");
    const session = await this.load(id);
    if (!session) throw new HttpError(404, "Agent not found");
    await session.starting?.catch(() => {});
    // A run open or queued (a run just ended may still be publishing its response: that is no reason to refuse).
    if (session.running.size) throw new HttpError(409, "A run is active or queued on this agent; abort it or wait for it to end, then reset", "AGENT_BUSY");
    const reset = session.runs.then(async () => {
      // Its host holds the context it loaded: it starts again from the reset one.
      if (this.supervisor.agents.has(id) || this.supervisor.starting.has(id)) await this.supervisor.stop(id);
      return this.supervisor.resetContext(id, session.claim, { ...input, limit: this.options.contextRangeMaxBytes ?? CONTEXT_RANGE_MAX_BYTES, settled: (end, from) => this.historyIndex.messages(id, end, from) }).catch(error => {
        // Started again meanwhile (a steer or a configuration starts it at once): its host has the context now.
        if (errorText(error) === "Agent is running") throw new HttpError(409, "The agent started while it was being reset; try again", "AGENT_BUSY");
        throw error;
      });
    });
    session.runs = reset.then(() => {}, () => {});
    const result = await reset;
    console.log(JSON.stringify({ type: "context_reset", agent: id, tenant, keepMessages: input.keepMessages ?? 0, ...result ? { keptMessages: result.keptMessages, bytesBefore: result.before.bytes, bytesAfter: result.after.bytes } : { empty: true } }));
    return result ? { reset: true as const, keptMessages: result.keptMessages, before: result.before, after: result.after }
      : { reset: false as const, keptMessages: 0, before: { entries: 0, bytes: 0 }, after: { entries: 0, bytes: 0 } };
  }

  /** Whether an agent's legacy log is empty, listed rather than read (legacy coverage's Storage check). */
  legacyLogEmpty(id: string): Promise<boolean> { return this.supervisor.legacyLogEmpty(id); }

  /**
   * A tenant's key for `provider` changed: stop that tenant's idle agents using it
   * so their next request starts with the new key. Busy agents keep their key
   * until their turn ends and they go idle.
   */
  async providerKeyChanged(tenant: string, provider: string) { return configuration.providerKeyChanged(this.configurationContext, tenant, provider); }

  /**
   * Replace a tenant's agent's mounts: they apply from its next tool call (see `remount`).
   */
  async setMounts(id: string, tenant: string, requested: unknown) { return tools.setMounts(this.toolsContext, id, tenant, requested); }

  /** Revoke a tenant's agent, stop it and unload it; the purge sweep, started now, then deletes its data. */
  async destroyAgent(id: string, tenant: string, agentsOnly = false) {
    if (!await this.owns(id, tenant, agentsOnly)) return false;
    // The children the runtime made for it go with it (their own, in turn); named agents it started stay, aborted.
    const made = (await this.db.query("select distinct child from agent_children where parent = $1 and made", [id])).rows.map(row => row.child as string);
    await this.delete(id);
    for (const child of made) {
      await (this.options.deleteAgent ?? ((agent, tenant) => this.destroyAgent(agent, tenant)))(child, tenant)
        .catch(error => { if ((error as HttpError).status !== 404) console.error(JSON.stringify({ type: "subagent_delete_failed", agent: id, child, error: safeError(error) })); });
    }
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
  private async historyPage(session: Session | { header: { id: string; tenant: string }; unloaded: true }, query: { before?: string; limit?: string; maxBytes?: string }): Promise<HistoryPage> {
    const before = query.before === undefined ? undefined : Number(query.before);
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const maxBytes = query.maxBytes === undefined ? undefined : Number(query.maxBytes);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw new HttpError(400, "before is a message index");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, "limit is 1 to 500 messages");
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 16_384 || maxBytes > PAGE_BYTES)) throw new HttpError(400, `maxBytes is 16384 to ${PAGE_BYTES} bytes`);
    const id = session.header.id;
    // An agent still starting answers nothing yet: wait for it (or, should it fail, read the log).
    if (!("unloaded" in session)) await session.starting?.catch(() => {});
    let tail = !("unloaded" in session) && this.supervisor.agents.has(id) ? await this.liveRead(id, "historyTail") as HistoryTail | null | undefined : undefined;
    // Without a running agent to answer (or one whose journal does not hold all the index lacks), what the index lacks
    // is read from the journal, beside its owner: an index behind (a stop that could not write its last chunks), none yet,
    // or work its last owner never indexed (a node that died). Nothing is indexed here; an agent's own process indexes
    // from where its index ends.
    if (!tail) tail = await this.supervisor.journalBacklog(id, (await this.historyIndex.indexed(id)) ?? 0, (end, from) => this.historyIndex.messages(id, end, from));
    return this.historyIndex.page(id, { before, limit, maxBytes }, tail ?? undefined);
  }

  /** A tenant's view of a page of one agent's history. */
  async historyPageFor(id: string, tenant: string, query: { before?: string; limit?: string; maxBytes?: string }) {
    if (!await this.owns(id, tenant)) throw new HttpError(404, "Unknown agent");
    if (this.unloaded(id)) return this.historyPage({ header: { id, tenant }, unloaded: true }, query);
    const session = await this.load(id);
    if (!session) throw new HttpError(404, "Unknown agent");
    return this.historyPage(session, query);
  }

  /** The agent's full history: its index's chunks, and its journal after them, read beside it when it runs. */
  private async history(session: Session) {
    // An agent still starting answers nothing yet: wait for it (it may retire its host transcript as it starts).
    await session.starting?.catch(() => {});
    return { messages: await this.supervisor.history(session.header.id, count => this.historyIndex.messages(session.header.id, count)) };
  }

  /**
   * A read of the agent's running host; undefined when it stopped while answering (a run that just ended stops its
   * agent, an idle one is unloaded): its log, read beside it, has what it held, so the read is not failed for that.
   */
  private async liveRead(id: string, method: "historyTail") {
    try { return await this.supervisor.request(id, method); }
    catch (error) {
      if (this.supervisor.agents.has(id)) throw error;
      return undefined;
    }
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
        return events.watchAgent(this.eventContext, c, header, c.req.query("poll") === "1" ? "poll" : "watch");
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
    app.get(`${agent}/events`, c => events.subscribe(this.eventContext, c, c.var.session, "attach"));
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
    // With `limit`, `before` or `maxBytes`, a page; without, the whole transcript.
    app.get(`${agent}/history`, async c => {
      const { before, limit, maxBytes } = c.req.query();
      return json(c, 200, before !== undefined || limit !== undefined || maxBytes !== undefined ? await this.historyPage(c.var.session, { before, limit, maxBytes }) : await this.history(c.var.session));
    });
    // The agent's files by the paths it sees them at (/workspace/...), for applications holding its token.
    app.get(`${agent}/files`, async c => {
      const { path, glob, after, limit } = c.req.query();
      const session = c.var.session;
      const target = tools.mounted(this.toolsContext, session, path ?? session.header.mounts?.[0]?.path ?? "/");
      const listing = await this.options.volumes!.call(target.mount.volumeId, session.header.tenant, "list", {
        path: target.path, ...(glob ? { glob } : {}), ...(after ? { after: tools.mounted(this.toolsContext, session, after).path } : {}), ...(limit ? { limit: Number(limit) } : {}),
      });
      return json(c, 200, { files: listing.files.map(({ chunks: _chunks, path, ...file }: { chunks: string[]; path: string }) => ({ path: target.show(path), ...file })), ...(listing.next ? { next: target.show(listing.next) } : {}) });
    });
    const filePath = (c: Context) => `/${new URL(c.req.url).pathname.split("/files/").slice(1).join("/files/").split("/").map(decodeURIComponent).join("/")}`;
    app.get(`${agent}/files/*`, async c => {
      const session = c.var.session;
      const target = tools.mounted(this.toolsContext, session, filePath(c));
      const entry = await this.options.volumes!.call(target.mount.volumeId, session.header.tenant, "stat", { path: target.path });
      if (entry.type !== "file") throw new HttpError(404, `${filePath(c)} is a directory`);
      return fileResponse(this.options.volumes!, session.header.tenant, entry, c.req.header("range"));
    });
    app.put(`${agent}/files/*`, async c => {
      const session = c.var.session;
      const target = tools.mounted(this.toolsContext, session, filePath(c), true);
      const { chunks: _chunks, path, ...entry } = await this.options.volumes!.put(session.header.tenant, target.mount.volumeId, target.path, body(c) as AsyncIterable<Uint8Array>, { contentType: c.req.header("content-type") });
      return json(c, 201, { path: target.show(path), ...entry });
    });
    app.post(`${agent}/links`, async c => json(c, 201, tools.signLink(this.toolsContext, c.var.session, await readJson(body(c), 4096))));
    // A file for request `:request` to attach by the path this answers with; the body streams to storage.
    app.put(`${agent}/uploads/:request/:name`, async c => json(c, 201, await this.upload(c.var.session, c.req.param("request"), c.req.param("name"), body(c) as AsyncIterable<Uint8Array>, c.req.header("content-type"))));
    app.get(`${agent}/state`, c => {
      const session = c.var.session;
      return json(c, 200, { cursor: session.cursor, requests: [...session.requests.values()].map(visible), ...activityOf(session.running.values()) });
    });
    app.post(`${agent}/requests`, async c => {
      const request = await readJson(body(c), FRAME_BYTES);
      // A W3C traceparent header: the run continues the caller's trace.
      const traceparent = c.req.header("traceparent");
      if (traceparent && request?.params && typeof request.params === "object" && request.params.traceparent === undefined) request.params.traceparent = traceparent;
      const { status, record, rate } = await this.accept(c.var.session, request);
      for (const [name, value] of Object.entries(rateLimitHeaders(rate))) c.header(name, value);
      return json(c, status, record);
    });
    app.get(`${agent}/requests/:request`, c => events.settled(this.eventContext, c, c.var.session, c.req.param("request")));
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
      const { status, ...answered } = await this.answer(session.header.id, session.header.tenant, humanInput.answerList(await readJson(body(c), 1024 * 1024)), "agent");
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
  private async accept(session: Session, body: any, trusted = false): Promise<{ status: 200 | 202; record: RequestRecord; rate?: RateLimitState }> {
    if (!validId(body?.id) || !REQUEST_METHODS.includes(body.method) || !body.params || typeof body.params !== "object" || Array.isArray(body.params)) throw new HttpError(400, "Invalid request");
    // Only the runtime resumes a suspension, once its inputs have settled.
    if (body.method === "resume" && (!trusted || Object.keys(body.params).length !== 1 || !validId(body.params.suspension))) throw new HttpError(400, "Answer the agent's inputs to resume its turn");
    // Applying a definition reads the tenant's definitions, so only the tenant may ask for it, not the agent's own token.
    const applying = body.method === "configure" && body.params.definition !== undefined;
    // Which keys an agent calls models with, and how much it may spend, are the tenant's to choose, never the agent's own.
    for (const key of ["keyScope", "spendLimit", "bucket", "runLimits", "modelHeaders", "dataCollection", "builtins", "delegate", "mcpServers", "decide", "mounts", ...UPSERT_KEYS]) if (body.method === "configure" && !trusted && Object.hasOwn(body.params, key)) throw new HttpError(403, `Only the tenant can change an agent's ${key}`);
    const spendLimit = body.method === "configure" && Object.hasOwn(body.params, "spendLimit") ? spend.spendInput(body.params.spendLimit) : undefined;
    // Which of its end user's buckets the agent's runs spend from: the tenant's to say, applied at once, as a spend limit is.
    const agentBucket = body.method === "configure" && Object.hasOwn(body.params, "bucket") ? body.params.bucket === null ? null : bucketInput(body.params.bucket) : undefined;
    // A run's own bucket, likewise the tenant's alone: an agent's token choosing one could spend another bucket's allowance.
    if (body.method !== "configure" && body.params.bucket !== undefined && (!trusted || !MODEL_RUNS.includes(body.method))) {
      throw new HttpError(trusted ? 400 : 403, trusted ? "bucket is for a model run (prompt, continue)" : "Only the tenant can choose a run's bucket");
    }
    if (applying && (!trusted || !this.options.definitionFor || Object.keys(body.params).length !== 1 || typeof body.params.definition?.id !== "string")) throw new HttpError(400, "Apply a definition with PATCH /v1/definitions/<id> and apply: \"all\"");
    try {
      if (body.method === "configure" && !applying) {
        const { spendLimit: _limit, bucket: _bucket, provisionHash: _hash, name: _name, type: _type, toolsHash: _tools, mounts: _mounts, builtins, delegate, mcpServers, decide, ...update } = body.params;
        const checked = configurationUpdate(update, this.options.modelEndpoints?.(session.header.tenant), await this.options.customProviders?.(session.header.tenant, configuration.scopeAfter(session.header, update)));
        // A model, thinking level, maxOutputTokens or temperature that leaves the agent asking its model for what it refuses is refused now.
        const refusal = configurationRefusal(session.header.config, checked);
        if (refusal) throw new Error(refusal);
        const own = builtins !== undefined || delegate !== undefined || mcpServers !== undefined || decide !== undefined;
        if (own && session.header.definition) throw new HttpError(400, `This agent's ${mcpServers !== undefined ? "MCP servers" : "builtins"} come from its definition; change them there`);
        // An upsert gives the whole of them, which `execute` checks as it applies them; a change of some is checked now.
        if (own && body.params.provisionHash === undefined) configuration.ownSources(session.header.sources, { builtins, delegate, mcpServers, decide }, configuration.inlineServers(this.configurationContext, session.header.tenant));
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
    // A retried ID returns the committed record, including its outcome after a lost ack. One still being taken is
    // answered once its record is durable: answered sooner, a write that then failed would lose a request the retry
    // was told was taken (its failure answers the retry too).
    const taken = async (record: RequestRecord) => {
      const pending = session.accepting?.get(record.id);
      sometimes(!!pending, "a retry waited for its request's record to be durable");
      if (pending) await pending;
      return { status: 200 as const, record: visible(session.requests.get(record.id) ?? record) };
    };
    const retried = existing();
    sometimes(!!retried, "a request sent again with its id got the first one's record");
    if (retried) return taken(retried);
    if (session.running.size >= MAX_OPEN_REQUESTS) throw new HttpError(429, "Too many requests queued for this agent");
    // A spend limit applies at once, ahead of queued runs, so an application can set an allowance and then prompt.
    if (spendLimit !== undefined) await this.setSpendLimit(session, spendLimit);
    if (agentBucket !== undefined && (session.header.bucket ?? null) !== agentBucket) {
      if (agentBucket === null) delete session.header.bucket;
      else session.header.bucket = agentBucket;
      await this.writeHeader(session);
    }
    const isRun = RUN_METHODS.includes(body.method);
    // An agent that lives while it is used lives on from each run it is sent.
    if (isRun) await this.stillUsed(session);
    // Who is acting in a run is recorded apart from what the agent is asked to do.
    let actor: string | undefined;
    let { actor: rawActor, bucket: rawBucket, ...params } = body.params;
    if (spendLimit !== undefined) delete params.spendLimit;
    let bucket = body.method === "configure" || rawBucket === undefined ? undefined : bucketInput(rawBucket);
    if (rawActor !== undefined && !isRun) throw new HttpError(400, "actor is only for runs (prompt, continue, execute)");
    const isMessage = ["prompt", "steer"].includes(body.method);
    if (params.from !== undefined && !isMessage) throw new HttpError(400, "from is only for messages (prompt, steer)");
    if (params.metadata !== undefined && !isMessage) throw new HttpError(400, "metadata is only for messages (prompt, steer)");
    if (params.images !== undefined) throw new HttpError(400, "Attach images as files: files: [{ name, data (base64), contentType }]");
    if (params.whileRunning !== undefined && (body.method !== "prompt" || !["queue", "steer"].includes(params.whileRunning))) throw new HttpError(400, "whileRunning is queue or steer, for a prompt");
    // A run's own budget: it only ever lowers what the run may spend, so whoever may run the agent may set it.
    if (params.spendLimit !== undefined && (!MODEL_RUNS.includes(body.method) || spend.spendInput(params.spendLimit) === null)) throw new HttpError(400, "spendLimit is {usd}, for a model run (prompt, continue)");
    // Its own run limits likewise only lower what the agent's allow.
    if (params.runLimits !== undefined && MODEL_RUNS.includes(body.method) && (!params.runLimits || typeof params.runLimits !== "object" || Object.keys(params.runLimits).some(key => key !== "maxResponses" && key !== "maxSeconds") || runLimitsInput(params.runLimits) === null)) throw new HttpError(400, "runLimits is {maxResponses?, maxSeconds?}, for a model run (prompt, continue)");
    // An output schema shapes the turn a prompt starts: a steer joins one already running.
    if (params.output !== undefined && (body.method !== "prompt" || params.whileRunning === "steer")) throw new HttpError(400, "output is for a prompt that starts its own turn (not whileRunning: steer)");
    // Deprecated and ignored: every run sees the agent's history (Pi's compaction bounds it); POST /v1/runs has none.
    if (params.history !== undefined) {
      if (!["full", "none"].includes(params.history)) throw new HttpError(400, 'history is "full" or "none" (deprecated: ignored, every run sees the agent\'s history)');
      if (params.history === "none") historyNoneIgnored(session.header.id, session.header.tenant, "prompt");
      delete params.history;
    }
    if (params.whileRunning === "queue") delete params.whileRunning;
    if (body.method === "abort" && (Object.keys(params).some(key => key !== "queued" && key !== "children") || ![undefined, "cancel", "keep"].includes(params.queued) || ![undefined, "abort", "keep"].includes(params.children))) {
      throw new HttpError(400, "An abort takes { queued?: \"cancel\" | \"keep\", children?: \"abort\" | \"keep\" }: whether the runs queued behind the running one are cancelled too (the default) or kept, and whether its running background sub-agents are aborted too (the default) or kept");
    }
    // A message records the request that sent it, so an application can match it to its own.
    if (isMessage) params.requestId = body.id;
    try {
      if (params.output !== undefined) params.output = outputInput(params.output);
      if (params.from !== undefined) params.from = senderInput(params.from);
      if (params.metadata !== undefined) params.metadata = metadataInput(params.metadata);
      // The sender acts, unless the application names someone else.
      actor = actorInput(rawActor) ?? (isRun ? params.from?.id : undefined);
      // A resumed turn acts for whoever the suspended one did, and spends from the same bucket.
      if (body.method === "resume") {
        actor = session.requests.get(params.suspension)?.actor;
        bucket = session.requests.get(params.suspension)?.bucket;
      }
    } catch (error) { throw new HttpError(400, errorText(error)); }
    // A child's notification (`notice`) is the runtime's alone. Its child's run was counted and checked already, and it is
    // never refused at a limit: it lands without a turn instead (`landNotice`).
    const notice = params.notice !== undefined;
    // A parent's message to its child may join the child's running turn; anything else of the runtime's is a turn of its own.
    const steerable = params.notice?.metadata?.kind === "message" && params.notice.metadata.to === "child";
    if (notice && (!trusted || body.method !== "prompt" || (params.whileRunning !== undefined && !steerable) || !childSessions.validNotice(params.notice))) throw new HttpError(400, "Invalid request");
    const rate = isRun && body.method !== "resume" && !notice ? await this.options.runRate?.(session.header.tenant) ?? undefined : undefined;
    const limited = body.method === "resume" || notice ? undefined : await spend.runLimit(this.spendContext, session, body.method, bucket);
    if (limited) throw limited;
    // The bucket the tenant names for a run is the one the runs the runtime starts for the agent after it spend from.
    if (bucket && body.method !== "resume" && session.header.runBucket !== bucket) {
      session.header.runBucket = bucket;
      await this.writeHeader(session);
    }
    const trace = isRun ? await events.traceFor(this.eventContext, session, traceparent, body.method === "resume" ? session.requests.get(params.suspension)?.trace : undefined) : undefined;
    // A run makes its agent busy: it takes one of the tenant's busy slots across the fleet (429 at the limit), held
    // until the agent has no run open. A resume continues a turn already accepted. Until the request is taken, the
    // slot is kept for it (`admitting`) even if the agent's other runs end meanwhile.
    let admitting = RUN_METHODS.includes(body.method);
    if (admitting) {
      session.admitting = (session.admitting ?? 0) + 1;
      try { await this.holdBusy(session, body.method === "resume"); }
      catch (error) { session.admitting!--; this.releaseBusy(session); throw error; }
    }
    try {
      // A run of an agent whose tools its application answers needs that application connected: refused now, rather
      // than a turn whose calls cannot run. An application reconnecting (a process restarting) has a moment to arrive.
      if (["prompt", "continue", "execute"].includes(body.method) && !allowDisconnected && session.header.definitions.length && !await events.applicationConnected(this.eventContext, session)) {
        if (existing()) return taken(existing()!);
        throw new HttpError(409, "APPLICATION_NOT_CONNECTED: this agent's tools are answered by its application, and none is connected. Connect it: upsert the agent with its tools in a process that stays up (TypeScript agents.upsert(key, { tools }), Python agents.upsert(key, tools=[…]); lower down, connectAgent or connect_agent), or send allowDisconnected: true (allow_disconnected=True) to run anyway");
      }
      const queued = QUEUED_METHODS.includes(body.method);
      // Status and aborts need no process; queued requests start it (if at all) when their turn comes.
      if (!queued && !["status", "abort"].includes(body.method)) await this.ensureStarted(session);
      // Concurrent retries may have waited on the same process startup.
      const raced = existing();
      if (raced) return taken(raced);
      // Attached files are saved and referenced before the request is: its params keep references, never bytes. Audio
      // among them is transcribed now, so the request, its message and any retry carry the transcript.
      if (["prompt", "steer"].includes(body.method) && params.files !== undefined) {
        const attaching = session.attaching ??= new Map() as NonNullable<Session["attaching"]>;
        let work = attaching.get(body.id);
        if (work && work.fingerprint !== fingerprint) throw new HttpError(409, "Request ID reused with different arguments", "IDEMPOTENCY_CONFLICT");
        if (!work) {
          const budget = params.spendLimit?.usd as number | undefined;
          work = { fingerprint, files: tools.attach(this.toolsContext, session, body.id, params.files).then(files => spend.transcribeAttached(this.spendContext, session, body.id, files, { actor, budget, bucket })) };
          attaching.set(body.id, work);
          const done = () => { if (attaching.get(body.id) === work) attaching.delete(body.id); };
          work.files.then(done, done);
        }
        const files = await work.files;
        // A run's own budget pays for its audio: what is left is the run's to spend on its model.
        const spent = files.reduce((total, file) => total + (file.cost ?? 0), 0);
        params = { ...params, files: files.map(({ cost: _cost, ...file }) => file), ...(params.spendLimit && spent ? { spendLimit: { usd: Math.max(0, params.spendLimit.usd - spent) } } : {}) };
        const again = existing();
        if (again) return taken(again);
      }
      if (["prompt", "steer"].includes(body.method) && params.message === undefined && !(typeof params.text === "string" && params.text.trim()) && !params.files?.some((file: FileRef) => file.transcript)) {
        throw new HttpError(400, "Send {\"text\": \"...\"}, or attach audio to transcribe");
      }
      // Work is open: marked before the request is taken (a failed write takes nothing, so a retry starts afresh) and before
      // it is durable, so a node dying with it leaves it for another's sweep (see `resumeOrphans`).
      // One write per busy spell: the mark stays until an unload with nothing open clears it.
      if (queued && !session.pending) {
        await underClaim(this.db, session.claim, sql => sql.query("update agents set pending_runs = true where id = $1 and not pending_runs", [session.header.id]));
        session.pending = true;
        // A retry of the same id may have been taken while this waited.
        const again = existing();
        if (again) return taken(again);
      }
      const record = this.upsertRequest(session, {
        startedAt: Date.now(), ...(body.method === "prompt" && typeof body.params.text === "string" ? { prompt: body.params.text } : {}),
        ...(body.method === "execute" && typeof body.params.code === "string" ? { code: body.params.code } : {}),
        id: body.id, method: body.method, fingerprint, state: "running", ...(queued ? { params } : {}), ...(actor ? { actor } : {}), ...(bucket ? { bucket } : {}), ...(params.metadata ? { metadata: params.metadata } : {}),
        ...(body.method === "resume" ? { suspension: params.suspension } : {}), ...(trace ? { trace } : {}),
      });
      // Taken: its running record now keeps the agent busy, so it is no longer being admitted. An abort that cancels it
      // before the write below is done then gives the slot back before the run is seen to end, as for any cancelled run.
      if (admitting) { admitting = false; session.admitting!--; }
      const durable = this.commit(session, true);
      (session.accepting ??= new Map()).set(record.id, durable);
      try { await durable; }
      finally { session.accepting.delete(record.id); }
      if (queued) this.enqueue(session, record, params);
      else void this.run(session, record, params);
      // A steer is answered at once: the running turn has it (accepted), or it runs as a turn of its own (queued).
      if (params.whileRunning === "steer") {
        const steer = await this.steerTurn(session, params) ? "accepted" : "queued";
        const current = session.requests.get(record.id);
        if (current?.state === "running") return { status: 202, record: visible(this.upsertRequest(session, { ...current, steer })), ...(rate ? { rate } : {}) };
        // Taken already, before the answer came back.
        if (current) return { status: 202, record: visible({ ...current, steer }), ...(rate ? { rate } : {}) };
      }
      return { status: 202, record: visible(record), ...(rate ? { rate } : {}) };
    } finally {
      if (admitting) { session.admitting!--; this.releaseBusy(session); }
    }
  }

  /**
   * Offer a prompt sent with `whileRunning: "steer"` to the running turn, if any; true when the turn accepted it. The
   * prompt is queued already: if the turn takes it (its message ends in the turn's events), its request completes then
   * (`steerTaken`); if not (the turn ended first, or stopped), the agent drops it and it runs as a turn of its own.
   */
  private async steerTurn(session: Session, params: Record<string, unknown>): Promise<boolean> {
    if (!session.turn) return false;
    try { return !!(await this.supervisor.request(session.header.id, "steer", params))?.steered; }
    catch { return false; /* Not running after all: the queued prompt runs. */ }
  }

  /** Save an attachment for request `requestId` ahead of it (the SDKs upload files this way, then reference them by path). */
  async upload(session: Pick<Session, "header">, requestId: string, name: string, source: Uint8Array | AsyncIterable<Uint8Array>, contentType?: string) { return tools.upload(this.toolsContext, session, requestId, name, source, contentType); }

  /** A tenant's signed link to a file of its agent's, as the agent would sign it (`POST /v1/agents/:id/links`). */
  async agentLink(id: string, tenant: string, input: unknown) { return tools.agentLink(this.toolsContext, id, tenant, input); }

  /** `upload` for a tenant's agent (REST API, channels). */
  async uploadFor(id: string, tenant: string, requestId: string, name: string, source: AsyncIterable<Uint8Array>, contentType?: string) { return tools.uploadFor(this.toolsContext, id, tenant, requestId, name, source, contentType); }

  /** A file in a tenant's agent's mounts, as a reference (channels' send_message). */
  async fileFor(id: string, tenant: string, path: string) { return tools.fileFor(this.toolsContext, id, tenant, path); }

  /** A signed download link to a file in a tenant's agent's mounts. */
  async linkFor(id: string, tenant: string, path: string, expiresIn?: number) { return tools.linkFor(this.toolsContext, id, tenant, path, expiresIn); }

  /** What file work needs of an agent (its mounts), on any node: files are volumes, which any node reaches. */
  private async headerFor(id: string, tenant: string): Promise<Pick<Session, "header">> {
    const header = (await this.owns(id, tenant)) ? this.sessions.get(id)?.header ?? (await this.readHeader(id))?.value : undefined;
    if (!header || header.purged) throw new HttpError(404, "Unknown agent");
    return { header };
  }

  /**
   * Submit a request (as `submit`) to an agent this node serves, and yield the text its run writes as it is written:
   * each text delta of each assistant message, in order, until the run's response. A request already answered (sent
   * again) yields its reply whole. Ends early when `signal` aborts, or the agent leaves this node mid-run (handed
   * off): what was written so far is what there is.
   */
  async *submitStreaming(id: string, tenant: string, body: { id: string; method: string; params: Record<string, unknown> }, signal: AbortSignal): AsyncGenerator<string> {
    if (await this.owns(id, tenant)) await this.roomFor(id);
    const session = (await this.owns(id, tenant)) ? await this.load(id) : undefined;
    if (!session) throw new HttpError(404, "Unknown agent");
    if (session.fault) throw session.fault;
    const text = events.runText(this.eventContext, session, body.id, signal);
    session.lastActive = Date.now();
    let record: RequestRecord;
    try { ({ record } = await this.accept(session, body, true)); } catch (error) { text.close(); throw error; }
    if (record.state === "completed") { text.close(); const reply = replyText(record); if (reply) yield reply; return; }
    yield* text.chunks();
  }

  /** Submit a request to a tenant's agent on the tenant's behalf (REST API and console); `rate` hears where a run left the tenant's rate limit. */
  async submit(id: string, tenant: string, body: { id: string; method: string; params: Record<string, unknown> }, rate?: (state: RateLimitState) => void) {
    if (await this.owns(id, tenant)) await this.roomFor(id);
    const session = (await this.owns(id, tenant)) ? await this.load(id) : undefined;
    if (!session) throw new HttpError(404, "Unknown agent");
    if (session.fault) throw session.fault;
    session.lastActive = Date.now();
    const accepted = await this.accept(session, body, true);
    if (accepted.rate) rate?.(accepted.rate);
    return accepted.record;
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
    // Whether the agent is busy comes from its run records (`activityOf`), as every other view of it says: not from its process.
    if (record.method === "status") return live ? { ...await this.supervisor.request(id, "status", {}), running: true, ...activityOf(session.running.values()) } : { running: false, ...activityOf(session.running.values()) };
    // Aborting a suspended turn cancels its inputs: the turn is closed without the model. Its children are aborted too.
    if (record.method === "abort") {
      const cancelled = await this.stop(session, params?.queued === "keep" ? "keep" : "cancel", params?.children === "keep" ? "keep" : "abort");
      await humanInput.cancelInputs(this.inputsContext, session, "aborted");
      return live ? { aborted: true, cancelled } : { aborted: false, running: false, cancelled };
    }
    if (record.method === "configure") return configuration.configure(this.configurationContext, session, params, live);
    if (record.method === "resume") params = await this.resumeParams(session, record.suspension!);
    // The run's own budget is the runtime's to keep (runSpendLimit), not the agent's.
    if (params?.spendLimit !== undefined) {
      const { spendLimit, ...rest } = params;
      (session.runLimits ??= new Map()).set(record.id, spendLimit.usd);
      params = rest;
    }
    // So are its own run limits (turnLimit, overrun).
    if (params?.runLimits !== undefined && MODEL_RUNS.includes(record.method)) {
      const { runLimits, ...rest } = params;
      const caps = runLimitsInput(runLimits);
      if (caps) (session.runCaps ??= new Map()).set(record.id, caps);
      params = rest;
    }
    // Aborted since it began, before the agent had it: an abort sent to the agent now would find nothing to stop. A turn
    // resumed from its transcript (continue) is open there already, so the agent is still sent it, aborted: it closes the
    // turn durably before the run is seen to end, so a fork or history page in between finds it settled.
    if (session.aborted?.delete(record.id)) {
      // A notification lands all the same, without its turn (see `stop`).
      if (method === "prompt" && params?.notice !== undefined && params.notice.metadata?.to !== "child") {
        reachable("an abort reached a notification's run before its message landed, which landed without a turn");
        params = { ...params, landOnly: STOPPED_NOTICE };
      }
      // Ended as an abort, as the agent ends one it has (code aborted), not as a runtime failure.
      else if (method !== "continue") return { error: "The run was aborted", code: "aborted" };
      else params = { ...params, aborted: true };
    }
    try {
      return await this.supervisor.request(id, method, params, RUN_METHODS.includes(record.method)
      ? event => {
          // Failed calls report zero usage; count only responses the provider completed.
          // Responses through the tenant's own endpoint count under it: `chiridion/openrouter/<model>`.
          const via = spend.endpoint(this.spendContext, session) ? `${session.header.config.model.provider}/` : "";
          const { identity, keyScope } = session.header;
          const run = { requestId: record.id, ...(record.actor ? { actor: record.actor } : {}), ...(identity ? { identity } : {}), ...(keyScope ? { keyScope } : {}) };
          if (spend.billed(event?.type === "message_end" ? event.message : undefined)) {
            const usage = spend.responseUsage(this.spendContext, session, event.message);
            this.options.onUsage?.(session.header.tenant, id, { ...event.message, usage, ...run, provider: via + event.message.provider, platform: !!session.platformKey,
              ...(event.durable && this.supervisor.options.db ? { durableReceipt: true } : {}) });
            // Its spend was written with its journal entry (`entryEffect`).
            this.counted(session, spend.responseCost(usage));
            spend.tally(session, record.id, usage);
          }
          if (event?.type === "compaction_usage" && event.usage) {
            spend.tally(session, record.id, spend.compactionUsage(this.spendContext, session, event, run));
          }
          // A prompt steered into this turn has been taken: the model has it now, and its request completes (`steerTaken`).
          const taken = event?.type === "message_end" && event.message?.role === "user" ? event.message.requestId : undefined;
          // What the turn is doing, for a hand-off's step kind: a model call, until its response's tool calls run.
          if (event?.type === "turn_start") session.step = "model";
          else if (event?.type === "tool_execution_start") session.step = "tool";
          this.publish(session, { type: "event", requestId: record.id, event });
          if (taken && taken !== record.id && session.running.get(taken)?.method === "prompt") this.steerTaken(session, taken, record.id);
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
    for (const row of rows) if (row.state === "expired" || row.answer?.by.via === "channel") humanInput.resolved(this.inputsContext, session, row);
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

  /** Finish a run whose node was lost: continue its turn, or take the answer it had already reached. */
  private async resume(session: Session, record: RequestRecord): Promise<Outcome> {
    const handoff = session.handoff, ended = session.ended;
    session.handoff = session.ended = undefined;
    // A notification's or message's turn refused as it landed (`landNotice`): no owner asks the model for it.
    const refused = session.requests.get(record.id)?.landOnly;
    const refusedOutcome = (finished: unknown) => refused ? { ...finished as object, error: refused.message, code: refused.stopped, stopped: refused.stopped } : finished;
    if (refused) reachable("a turn refused as its notification landed was resumed on another node, and kept the refusal");
    if (handoff && "continue" in handoff) return { result: await this.execute(session, record, refused ? { landOnly: refused } : {}, "continue") };
    // A resume whose turn is still suspended on the calls it answers: its node was lost before the agent took the answers
    // (the agent releases each call durably before running it, so one still waiting never ran). It runs again from its
    // inputs, as one whose turn never became active does; taken as the turn's outcome, it would end suspended with
    // nothing left to answer, and the approved call would never run.
    const suspended = (handoff?.finished as { stopped?: string } | undefined)?.stopped === "input_required";
    if (suspended && record.method === "resume") reachable("a resume found its turn still suspended on the calls it answers");
    else if (handoff) return { result: refusedOutcome(handoff.finished) };
    // Its turn ended before its node was lost, which then never recorded the run's end: the outcome is the turn's.
    else if (ended && await this.endedTurnOf(session, record, ended)) {
      reachable("a resumed run took the outcome of its turn that had ended");
      return { result: refusedOutcome(ended.finished) };
    }
    if (record.method === "resume") return { result: await this.execute(session, record, {}) };
    // A notification or message whose node was lost after its run began, before its message landed: it lands now, from its
    // record (the message is the runtime's, so nothing of it is unknown).
    const notice = record.method === "prompt" ? session.requests.get(record.id)?.notice as { notice?: unknown } | undefined : undefined;
    if (notice?.notice !== undefined) {
      reachable("a child's notification whose node was lost before its message landed landed on the next owner");
      const params = { ...notice, requestId: record.id };
      if (refused) return { result: await this.execute(session, record, { ...params, landOnly: refused }) };
      const landing = await childSessions.landing(this.childrenContext, session, record, params, true);
      if (!landing) return { error: "The runtime stopped during this request", uncertain: true };
      return "outcome" in landing ? landing.outcome : { result: await this.execute(session, record, landing.params) };
    }
    return { error: "The runtime restarted during this request", uncertain: true };
  }

  /** Whether the ended turn was this run's: a prompt's user message opens it, a resume's answered calls' results do. */
  private async endedTurnOf(session: Session, record: RequestRecord, ended: NonNullable<Session["ended"]>) {
    if (record.method === "prompt") return ended.requests.includes(record.id);
    if (record.method !== "resume" || !this.options.inputs) return false;
    const rows = await this.options.inputs.forRequest(session.header.id, record.suspension!);
    return rows.length > 0 && rows.every(row => ended.calls.includes(row.toolCallId));
  }

  /** Queue a run behind the agent's earlier runs; a busy agent never rejects work. */
  private enqueue(session: Session, record: RequestRecord, params: unknown) {
    session.runs = session.runs.then(() => this.run(session, record, params)).catch(() => {});
  }

  /**
   * A step of a run's start, tried again when the database refuses it for now or cannot be reached, or a node answers
   * 503: RUN_START_ATTEMPTS times in all, waiting RUN_START_BACKOFF_MS, doubling, with jitter, between tries; past that,
   * or on any other error, the error goes to the run, which fails with it. `work` answers whether the run goes on; so
   * does this, false too when the session was given up, moved or the run stopped while it waited.
   */
  private async startStep(session: Session, record: RequestRecord, work: () => Promise<boolean>): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try { return await work(); }
      catch (error) {
        if (attempt >= RUN_START_ATTEMPTS || !RUN_METHODS.includes(record.method) || !transientStart(error)) throw error;
        sometimes(true, "a run's start met a transient refusal and was tried again");
        console.error(JSON.stringify({ type: "run_start_retry", agent: session.header.id, request: record.id, attempt, error: safeError(error) }));
        await clock().sleep(Math.round(RUN_START_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + random().float())));
        // Given up, moved or stopped meanwhile: the run stays as it is, for whoever has it next.
        if (this.closed || this.draining || session.fault || session.leaving || session.handedBack || session.requests.get(record.id)?.state !== "running") return false;
      }
    }
  }

  private async run(session: Session, record: RequestRecord, params: unknown) {
    let value: Outcome;
    let continued: Pick<RequestRecord, "handedOff" | "carried"> | undefined;
    try {
      if (QUEUED_METHODS.includes(record.method) && (this.closed || this.draining || session.fault || session.handedBack || session.requests.get(record.id)?.state !== "running")) return;
      // Configuration keeps its params when it begins: the next owner replays one that was interrupted.
      if (record.method === "configure") record = this.upsertRequest(session, { ...record, began: Date.now() });
      // The run's start, tried again on a transient refusal (`startStep`): nothing of the run has happened yet (no begin
      // recorded, no event, nothing billed), and it keeps its place, so the runs queued behind it wait.
      // An acting request can load an orphan before the sweep's deadline too. It waits the same backoff.
      if (session.resuming.has(record.id) && !record.handedOff) {
        const row = (await this.db.query("select resume_after from agents where id = $1", [session.header.id])).rows[0];
        const delay = Number(row?.resume_after ?? 0) - Date.now();
        if (delay > 0) {
          const wait = session.resumeWait = new AbortController();
          try { await clock().sleep(delay, { signal: wait.signal }); }
          catch (error) { if (!wait.signal.aborted) throw error; }
          finally { session.resumeWait = undefined; }
        }
        if (this.closed || session.fault || session.leaving || session.requests.get(record.id)?.state !== "running") return;
      }
      const started = await this.startStep(session, record, async () => {
        // Decided once per run, so it has both its events or neither: an endpoint made meanwhile gets the next run's.
        if (RUN_METHODS.includes(record.method)) session.announcing = await (this.options.runEvents?.(session.header.tenant) ?? false);
        if (!RUN_METHODS.includes(record.method)) return true;
        // A run queued behind the one that reached the cap never begins; a resumed turn is stopped by the host.
        // A child's notification is never refused: at a limit it lands without a turn (`landNotice`).
        if (!session.resuming.has(record.id) && (params as { notice?: unknown } | undefined)?.notice === undefined) {
          const limited = await spend.runLimit(this.spendContext, session, record.method, record.bucket);
          if (limited) throw limited;
        }
        try {
          // Accepted already (here, or by a node it was taken over from): it takes its busy slot regardless of the limit.
          await this.holdBusy(session, true);
          // Mounts changed since the agent started: it starts again, so this turn's prompt and tools describe them.
          if (session.hosted && canonical(session.hosted) !== canonical(session.header.mounts ?? []) && this.supervisor.agents.has(session.header.id) && !session.starting) await this.supervisor.stop(session.header.id);
          // A connection can change while the eager host startup is still in flight.
          // Check after that startup settles too, before the model sees its tools.
          for (let attempts = 0; ; attempts++) {
            await this.ensureStarted(session);
            const revision = await this.options.sources?.computerRevision(session.header.tenant, session.header.id);
            if (session.computerRevision === revision) break;
            await this.supervisor.stop(session.header.id);
            if (attempts >= 2) throw new HttpError(503, "Computer connection changed while starting; retry");
          }
        } catch (error) {
          // No room here for a run this node took over, or for any run while a live peer may have room the node lacks
          // (its count or memory): another node with room takes it (see `handBack`), rather than the run retrying here.
          if (this.options.ownership && session.inherited?.has(record.id) && [429, 503].includes((error as { status?: number }).status ?? 0)) { await this.handBack(session); return false; }
          if (this.options.ownership && (error as { nodeFull?: boolean }).nodeFull && await this.options.ownership.peer()) { await this.handBack(session); return false; }
          throw error;
        }
        return true;
      });
      if (!started) return;
      if (RUN_METHODS.includes(record.method)) {
        if (this.draining || session.handedBack) return;
        // Cancelled while it waited to start (a stop): it never begins.
        if (session.requests.get(record.id)?.state !== "running") return;
        session.inherited?.delete(record.id);
        // Durable before any side effect: after a crash this run is "began", never repeated. A notification's or message's
        // params are the runtime's, and kept: its next owner lands it (`resume`).
        const { params: queuedParams, handedOff, carried, ...rest } = session.requests.get(record.id)!;
        const notice = record.method === "prompt" && (queuedParams as { notice?: unknown } | undefined)?.notice !== undefined ? queuedParams : undefined;
        // A turn handed off at a step boundary goes on as it was: not a resume, and its time limit counts from its first begin.
        continued = session.resuming.has(record.id) && handedOff ? { handedOff, carried } : undefined;
        record = this.upsertRequest(session, { ...rest, ...notice ? { notice } : {}, began: continued && rest.began ? rest.began : Date.now(), ...(session.resuming.has(record.id) && !continued ? { resumes: (rest.resumes ?? 0) + 1 } : {}) });
        // Code has no effect outside its sandbox until it calls a tool, and every tool call
        // makes this record durable first (`beforeEffect`; the application's tools do it when
        // their call is recorded, which is appended after it). So an execution needs no commit of its
        // own here: one that crashes before a tool call is simply run again.
        if (record.method === "execute") session.beginning = {};
        else await this.commit(session, true);
        // The journal is authoritative for this run's count, including a crash between these writes.
        // Mirror it on the agent row and reserve the next delay before any model request can run.
        if (session.resuming.has(record.id) && !continued) {
          await underClaim(this.db, session.claim, sql => sql.query(`update agents set turn_resumes = $2, resume_failures = resume_failures + 1,
            resume_after = $3 + least($4 * power(2, least(resume_failures, 30))::bigint, $5) where id = $1`,
            [session.header.id, record.resumes ?? 0, Date.now(), this.sweepMs, MAX_RESUME_DELAY_MS]));
        } else if (!continued) await this.resetResumes(session);
        this.hook("runStarted", session, record);
        session.spans = record.trace?.sampled ? await events.spansFor(this.eventContext, session, record) : undefined;
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
      if (record.method === "prompt" && !await this.startStep(session, record, () => humanInput.cancelInputs(this.inputsContext, session, "superseded").then(() => true))) return;
      // A child's notification lands once, charged to this run; at a cap it lands without a turn.
      const landing = record.method === "prompt" && (params as { notice?: unknown } | undefined)?.notice !== undefined && !session.resuming.has(record.id) ? await childSessions.landing(this.childrenContext, session, record, params) : undefined;
      // Given up while its landing waited: the run stays as it is, for whoever has the agent next.
      if (record.method === "prompt" && (params as { notice?: unknown } | undefined)?.notice !== undefined && !session.resuming.has(record.id) && !landing) return;
      if (landing && "params" in landing) params = landing.params;
      value = landing && "outcome" in landing ? landing.outcome : session.resuming.delete(record.id) ? await this.resume(session, record) : { result: await this.execute(session, record, params) };
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
      // A stop still waiting for the delegate children it aborted (`stopDelegates`): what they spent counts in this run's usage.
      if (RUN_METHODS.includes(record.method) && session.stoppingChildren) await session.stoppingChildren;
      // What its model responses used on this node (a turn resumed after its node was lost counts from the resume), what its children spent, and its images.
      if (RUN_METHODS.includes(record.method) && value.result && typeof value.result === "object") {
        const usage = session.usage?.get(record.id), children = session.childSpend?.get(record.id), images = session.imageSpend?.get(record.id), decisions = session.decisionSpend?.get(record.id);
        value = { result: { ...value.result, usage: usage || children || images || decisions ? { ...usage ?? { responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, ...children ? { subagentCostUsd: children } : {}, ...images ? { imageCostUsd: images } : {}, ...decisions ? { decisionCostUsd: decisions } : {} } : null } };
      }
      const failed = value.result as { code?: string; error?: string } | undefined;
      if (failed?.code === "model_key_missing" && this.options.modelKeyHint) value = { result: { ...failed, error: `${failed.error} ${this.options.modelKeyHint}` } };
      // A suspended turn's outcome lists what it waits on.
      if ((value.result as { stopped?: string } | undefined)?.stopped === "input_required" && this.options.inputs) {
        const rows = await this.options.inputs.forRequest(session.header.id, record.id);
        // Its inputs are its own: a run that ends suspended with none would wait for an answer no one can give.
        always(rows.length > 0, "a run that ends suspended asked for input");
        const inputs = rows.filter(row => row.state === "pending").map(inputView);
        value = { result: { ...value.result as object, inputs } };
      }
    }
    catch (error) {
      // A limit that refused the run as it left the queue: its result is coded as a stop at that limit mid-run is.
      const stop = spend.refusalStop(error);
      value = (error as { code?: string })?.code === CONTEXT_TOO_LARGE ? { result: { error: errorText(error), code: CONTEXT_TOO_LARGE } }
        : stop ? { result: { error: errorText(error), ...stop } } : { error: errorText(error) };
      // Its host's journal failed a write: only a reload knows what it holds, so the agent is given up as a fault of
      // the session's own would, and the turn goes on from storage, not from this host's memory.
      if (errorText(error).startsWith(PERSISTENCE_FAILED)) this.fail(session, error, "transcript");
    }
    if (RUN_METHODS.includes(record.method)) session.outputs = undefined;
    spend.reportActive(this.spendContext, session, false);
    session.beginning = undefined;
    // Cut off here as this node leaves (`handOffAll`): the run stays open for the next owner.
    if (this.closed || session.fault || session.leaving || session.requests.get(record.id)?.state !== "running") return;
    // Stopped at a step boundary as this node leaves: the next owner continues it.
    if (RUN_METHODS.includes(record.method) && (value.result as { handedOff?: unknown } | undefined)?.handedOff) return this.park(session, record, value.result as Record<string, unknown>);
    // The slot is free before the run is seen to end (its record, its response, its event): a client that starts the next
    // run on seeing this one end is never refused for it. Released here, the agent is no longer counted for this run.
    if (RUN_METHODS.includes(record.method)) {
      await this.releaseBusy(session, false, record.id);
      if (this.closed || session.fault || session.leaving || session.requests.get(record.id)?.state !== "running") return;
    }
    // A model turn that began and ends with no host (a resumed one whose agent failed to start, or one whose agent is gone):
    // the turn it left open is settled first, as at a load. A failed write gives the session up, and the run to the next load.
    if (resumable(record) && !this.supervisor.agents.has(session.header.id)) {
      try { await spend.closeTurn(this.spendContext, session); }
      catch (error) { this.fail(session, error, "transcript"); return; }
      if (this.closed || session.fault || session.leaving || session.requests.get(record.id)?.state !== "running") return;
    }
    const { params: _params, notice: _notice, landOnly: _landOnly, ...finished } = record;
    // Until the response is published, a drain or release must not close the stream and drop it.
    session.settling++;
    try {
      const run = RUN_METHODS.includes(record.method);
      const announcing = run && !!session.announcing;
      const completed = this.upsertRequest(session, { ...finished, state: "completed", outcome: value, endedAt: Date.now(), ...(announcing ? { announce: true as const } : {}) });
      if (run) this.countBilling(session, completed);
      session.runLimits?.delete(record.id);
      session.runCaps?.delete(record.id);
      session.childSpend?.delete(record.id);
      session.imageSpend?.delete(record.id);
      session.decisionSpend?.delete(record.id);
      session.messagesSent?.delete(record.id);
      session.aborted?.delete(record.id);
      try { await this.commit(session, true); }
      catch { return; /* The fault is reported to every later request. */ }
      if (run) {
        try { await this.resetResumes(session); await this.resetSweep(session); }
        catch (error) { this.fail(session, error, "journal"); return; }
        this.hook("runEnded", session, completed);
        // A background child's run: its ending goes to its parent now (a sweep delivers it should this node be lost first).
        if ((/^(?:spawn|msg)_/.test(completed.id) && completed.metadata?.[PARENT_KEYS.agent]) || completed.id.startsWith("resume_")) {
          void childSessions.childEnded(this.childrenContext, session.header.id, visible(completed)).catch(error => console.error(JSON.stringify({ type: "child_notice_failed", child: session.header.id, error: safeError(error) })));
        }
        const usage = session.usage;
        session.usage = undefined;
        // With this run's event, any an earlier failure left.
        const unannounced = [...session.requests.values()].filter(request => request.announce);
        if (unannounced.length) void this.announce(session, unannounced, usage);
      }
      session.lastActive = Date.now();
      this.publish(session, { type: "response", id: record.id, outcome: value });
      if (run && session.header.run && record.id === runIdOf(session.header.id)) void this.runEnded(session);
      if (run && completed.trace?.sampled) {
        // A run that never began (refused at a limit, or failed starting) has a span too.
        const spans = session.spans?.requestId === record.id ? session.spans : await events.spansFor(this.eventContext, session, completed);
        if (session.spans === spans) session.spans = undefined;
        spans?.end(value, completed);
      }
    } finally { session.settling--; }
    await this.fold(session);
  }

  /**
   * A stateless run ended: its streams end with it, its data is kept for its retention from now (then purged, as an
   * expired agent's is), and its agent stops at once, so its place on the node is free. Should this node stop first, its
   * session expires at the bound it was made with.
   */
  private async runEnded(session: Session) {
    events.endStreams(session);
    session.header.expiresAt = Date.now() + session.header.run!.retentionMs;
    try { await this.writeHeader(session); }
    catch (error) { console.error(JSON.stringify({ type: "run_retention_failed", agent: session.header.id, error: safeError(error) })); }
    await this.supervisor.stop(session.header.id).catch(() => {});
  }

  /**
   * A prompt steered into the running turn `turn` was taken: the model has it. Its request completes now, not when the turn
   * ends (a turn fed constantly may never end), so it no longer counts against the agent's open requests; its outcome names
   * the turn (`steeredInto`), whose own request has the turn's outcome. Its queued run then does nothing. Should this node
   * stop before the record is durable, the run finds the message in history already and does not run it again.
   */
  private steerTaken(session: Session, id: string, turn: string) {
    const queued = session.running.get(id);
    if (!queued) return;
    const { params: _params, ...rest } = queued;
    const outcome: Outcome = { result: { steeredInto: turn } };
    const done = this.upsertRequest(session, { ...rest, state: "completed", outcome, endedAt: Date.now(), steeredInto: turn, ...(session.announcing ? { announce: true as const } : {}) });
    void (async () => {
      await this.commit(session, true);
      this.publish(session, { type: "event", requestId: id, event: { type: "steer_taken", steeredInto: turn } });
      this.publish(session, { type: "response", id, outcome });
      if (done.announce) void this.announce(session, [done]);
      // A parent's message its running turn took: the turn's own row answers for it.
      if (id.startsWith("msg_") && done.metadata?.[PARENT_KEYS.agent]) await childSessions.childEnded(this.childrenContext, session.header.id, visible(done));
    })().catch(() => { /* The fault is reported to every later request. */ });
  }

  endUserCharge(agent: string, usage: UsageRecord) { spend.endUserCharge(this.spendContext, agent, usage); }

  /** Give the agent a budget of `usd` from now (null: none). A new value starts counting from zero. */
  private async setSpendLimit(session: Session, usd: number | null) {
    const id = session.header.id, setAt = Date.now();
    if (usd === null) await this.db.query("delete from agent_spend_limits where agent = $1", [id]);
    else await this.db.query("insert into agent_spend_limits (agent, usd, spent, set_at) values ($1, $2, 0, $3) on conflict (agent) do update set usd = excluded.usd, spent = 0, set_at = excluded.set_at", [id, usd, setAt]);
    session.spend = usd === null ? null : { usd, spent: 0, setAt };
    // What the replaced limit had counted is dropped with it.
    session.unwritten = 0;
  }

  /** Count spend against the agent's spend limit, if it has one, in this owner's count. */
  private counted(session: Session, cost: number) {
    if (session.spend && cost > 0) session.spend.spent += cost;
  }

  /**
   * Count spend no transcript record carries (a compaction's response, a child's run): it is written with the agent's
   * next transcript record (`spendEffect`), or as it unloads.
   */
  private spent(session: Session, cost: number) {
    if (!session.spend || !(cost > 0)) return;
    this.counted(session, cost);
    session.unwritten = (session.unwritten ?? 0) + cost;
  }

  /** Why the agent may not spend more on models: it has reached its own spend limit. */
  private async agentSpendLimit(session: Session): Promise<string | undefined> {
    const spend = await this.spendOf(session);
    if (!spend || spend.spent < spend.usd) return undefined;
    return `This agent has reached its spend limit of ${dollars(spend.usd)} (${dollars(spend.spent)} spent since it was set); raise it with PATCH /v1/agents/${session.header.id}/configuration {"spendLimit": {"usd": …}}`;
  }

  /** The agent's spend limit, read once per load; its owner keeps it current. */
  private async spendOf(session: Session) {
    if (session.spend === undefined) {
      const row = (await this.db.query("select usd, spent, set_at from agent_spend_limits where agent = $1", [session.header.id])).rows[0];
      session.spend ??= row ? { usd: Number(row.usd), spent: Number(row.spent), setAt: Number(row.set_at) } : null;
    }
    return session.spend;
  }

  /** Events of a compaction made between runs: billed here, as no run's stream carries them, and shown on the agent's stream. */
  private backgroundEvent(session: Session, event: any) {
    if (event?.type === "compaction_usage" && event.usage) {
      const { identity, keyScope } = session.header;
      spend.compactionUsage(this.spendContext, session, event, { ...(identity ? { identity } : {}), ...(keyScope ? { keyScope } : {}) });
    }
    this.publish(session, { type: "event", requestId: "", event });
  }

  /** The write of `cost` to the agent's spend, with the spend counted that no record carried yet; undefined when there is none. */
  private spendWrite(session: Session, cost: number): CommitEffect | undefined {
    const spend = session.spend;
    if (!spend) return undefined;
    cost += session.unwritten ?? 0;
    if (!(cost > 0)) return undefined;
    session.unwritten = 0;
    const { id } = session.header, { setAt } = spend;
    const write = (sql: Sql) => sql.query("update agent_spend_limits set spent = spent + $2 where agent = $1 and set_at = $3", [id, cost, setAt]).then(() => {});
    return sql => sql ? write(sql) : underClaim(this.db, session.claim, write);
  }

  /**
   * An agent with an idle lifetime (`idleTtlSeconds`) lives that long from its latest run: its expiry moves on as a run
   * is sent. It is written only once half the lifetime has passed since it last moved, so busy agents do not write it
   * with every run.
   */
  private async stillUsed(session: Session) {
    const { idleTtlMs, expiresAt } = session.header;
    if (!idleTtlMs || expiresAt === null || expiresAt - Date.now() > idleTtlMs / 2) return;
    session.header.expiresAt = Date.now() + idleTtlMs;
    await this.writeHeader(session);
  }

  /** Make a pending execution's start durable before anything outside its sandbox acts for it. */
  private async beforeEffect(session: Session) {
    const beginning = session.beginning;
    if (beginning) await (beginning.durable ??= this.commit(session, true));
  }

  /**
   * Wait until this node may act for the agent: its lease is fresh (`Ownership.whenFresh`), so no peer can have taken
   * the agent over. Before each model request, tool call and js_exec. Rejects once the node lost the agent.
   */
  private async leased(session: Session, signal?: AbortSignal) {
    const ownership = this.options.ownership;
    if (!ownership || !session.claim) return;
    await ownership.whenFresh(signal);
    if (!ownership.holds(session.claim)) throw new HttpError(503, "This node lost ownership of the agent; retry");
  }

  private hook(name: "runStarted" | "runEnded", session: Session, record: RequestRecord) {
    try { this.options.hooks?.[name]?.({ id: session.header.id, tenant: session.header.tenant, claim: session.claim }, record); }
    catch (error) { console.error(JSON.stringify({ type: "session_hook_failed", hook: name, error: safeError(error) })); }
    if (name === "runEnded" && !session.header.run) void this.recordActivity(session.header.id, record);
  }

  /**
   * GET /v1/agents' lastActiveAt and lastError: when its latest run ended and, of a failed one, when and its class (never
   * its text). Best effort: a lost write only leaves the list a run behind.
   */
  private async recordActivity(id: string, record: RequestRecord) {
    const at = record.endedAt ?? Date.now(), failure = failureClass(record);
    try {
      await this.db.query(failure
        ? "update agents set last_active_at = greatest(coalesce(last_active_at, 0), $2), last_error_at = greatest(coalesce(last_error_at, 0), $2), last_error_class = case when coalesce(last_error_at, 0) <= $2 then $3 else last_error_class end where id = $1"
        : "update agents set last_active_at = greatest(coalesce(last_active_at, 0), $2) where id = $1", failure ? [id, at, failure] : [id, at]);
    } catch (error) { console.error(JSON.stringify({ type: "agent_activity_failed", agent: id, error: safeError(error) })); }
  }

  remove(id: string): Promise<void> {
    const existing = this.removing.get(id);
    if (existing) return existing;
    const removed = this.removeNow(id).finally(() => { this.removing.delete(id); });
    this.removing.set(id, removed);
    return removed;
  }

  private async removeNow(id: string) {
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
    // Stop the model while the host and its usage listener are still alive. Killing the host first drops
    // message_end (and its bill), although the provider still charges for the streamed response.
    await session.starting?.catch(() => {});
    await this.stop(session);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        session.runs.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5_000); }),
      ]);
      if (!settled) console.error(JSON.stringify({ type: "agent_delete_settle_timeout", tenant: session.header.tenant, agent: id }));
    } finally { clearTimeout(timer); }
    await this.interrupt(session, "Session revoked");
    events.endStreams(session);
    await this.releaseVolumes(session.header, session.claim);
  }

  /**
   * A deleted agent stops watching its mounts, and its own workspace goes with it, mounted or not (mounts set later may
   * have left it out); shared volumes stay.
   */
  private async releaseVolumes(header: SessionHeader, claim: Claim | undefined) {
    const volumes = this.options.volumes;
    if (!volumes) return;
    const mounts = header.mounts ?? [];
    const id = header.id, tenant = header.tenant;
    try {
      if (mounts.length) await volumes.watch(id, tenant, mounts, [], claim);
      // A stateless run's mounts never change: without any, it never had a workspace.
      if (mounts.length || !header.run) await volumes.call(VolumeService.workspaceOf(id), tenant, "delete");
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
    events.closeAttached(session);
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

  /** The agents with work running here: what a node near its heap limit names, to say whose work grew it. */
  busyAgents(): string[] {
    return [...this.sessions].flatMap(([id, session]) => this.working(session) ? [id] : []);
  }

  /**
   * This node leaves the cluster, with a peer to take its work (`retire`: a newer deploy replaced it; `drain`: it was
   * stopped), or (undefined) stays after all. While it leaves, each running turn finishes only the step it is in (the
   * model call, or the tool calls of the latest response, all of them) and stops at that boundary, before its next model
   * call (the host asks `runLimit` there); the agent is then handed off at once (`park`), and the next owner continues the
   * turn from its transcript with nothing lost. Queued runs and idle agents (one waiting on human input, say) move as
   * `releaseIdle` gives them up.
   */
  handOffTurns(reason: "retire" | "drain" | "memory" | undefined) {
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
      ...(session.imageSpend?.has(id) ? { imageSpend: session.imageSpend.get(id) } : {}),
      ...(session.decisionSpend?.has(id) ? { decisionSpend: session.decisionSpend.get(id) } : {}),
      ...(session.runLimits?.has(id) ? { spendLimit: session.runLimits.get(id) } : {}),
      ...(session.runCaps?.has(id) ? { runLimits: session.runCaps.get(id) } : {}),
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
    session.imageSpend?.delete(id);
    session.decisionSpend?.delete(id);
    session.runLimits?.delete(id);
    session.runCaps?.delete(id);
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
    if (taken.imageSpend) (session.imageSpend ??= new Map()).set(record.id, taken.imageSpend);
    if (taken.decisionSpend) (session.decisionSpend ??= new Map()).set(record.id, taken.decisionSpend);
    if (taken.spendLimit !== undefined) (session.runLimits ??= new Map()).set(record.id, taken.spendLimit);
    if (taken.runLimits) (session.runCaps ??= new Map()).set(record.id, taken.runLimits);
    if (taken.toolCalls?.length) session.toolCalls = taken.toolCalls;
    if (taken.toolErrors?.length) session.toolErrors = taken.toolErrors;
    for (const file of taken.files ?? []) session.outputs?.files.set(file.path, file);
    session.outputs?.presented.push(...taken.presented ?? []);
    const last = record.handoffs?.at(-1);
    recordHandoff({
      tenant: session.header.tenant, agent: session.header.id, request: record.id, reason: last?.reason ?? "retire", step: handedOff?.step ?? "tool",
      boundaryWaitMs: handedOff?.boundaryWaitMs ?? 0, latencyMs: last ? Math.max(0, Date.now() - last.at) : 0, handoffs: record.handoffs?.length ?? 1, ...(handedOff?.from ? { fromNode: handedOff.from } : {}),
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
      events.endStreams(session, false, "drain");
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
        events.endStreams(session, false, "drain");
      }
      // Idle watchers reconnect to a node that stays.
      for (const id of [...this.idle.keys()]) this.loadedElsewhere(id, "drain");
    } finally { this.releasing = false; }
  }

  /** Expire sessions, keep SSE alive, and release idle agents' processes and memory. */
  private tick() {
    const now = Date.now();
    const idleMs = this.options.idleMs ?? 5 * 60_000;
    for (const session of this.sessions.values()) {
      const id = session.header.id;
      if (session.sweepResetAt !== undefined && now >= session.sweepResetAt) {
        void this.resetSweep(session).catch(error => console.error(JSON.stringify({ type: "sweep_reset_failed", agent: id, error: safeError(error) })));
      }
      // An agent still starting (being made, say) expires at the next tick after: stopping it now would fail its start.
      if (!session.header.revoked && expired(session.header.expiresAt, now) && !session.starting) {
        void this.remove(id).then(() => this.supervisor.stop(id)).catch(() => {});
        continue;
      }
      for (const res of events.streams(session)) events.send(res, ": heartbeat\n\n");
      // A replaced connection still answering its calls is kept alive too, or its client would think the stream dead.
      for (const attached of session.retiring ?? []) events.send(attached.res, ": heartbeat\n\n");
      if (session.activeSince !== undefined && now - session.activeSince >= ACTIVE_REPORT_MS) spend.reportActive(this.spendContext, session, true, now);
      void this.overrun(session, now).catch(() => {});
      if (this.busy(session) || now - session.lastActive < idleMs) continue;
      if (this.supervisor.agents.has(id)) void this.supervisor.stop(id).catch(() => {});
      else if (!session.response && !session.fault) {
        // Nothing is running and no application is connected: everything needed later is in storage. Its watchers
        // stay, idle (see `idle`); its polls answer, and poll again idle.
        events.idleWatchers(this.eventContext, session);
        void this.unload(session);
      }
    }
    for (const [id, entry] of this.idle) {
      for (const res of entry.watchers) events.send(res, ": heartbeat\n\n");
      // Should a load's notice be missed (the listening connection was down), who owns the agent says it too.
      const ownership = this.options.ownership;
      if (!ownership || now - entry.checked < IDLE_CHECK_MS) continue;
      entry.checked = now;
      void ownership.route(id).then(owner => { if (owner && owner !== ownership.node && !this.sessions.has(id)) this.loadedElsewhere(id); }).catch(() => {});
    }
  }

  /**
   * A run past its time limit (the agent's maxSeconds, within `runLimitsFor`'s) by `RUN_OVERRUN_MS` (`runOverrunMs`) is aborted, and its agent stopped by
   * twice that: the limit is otherwise checked only between model requests, and a turn stuck inside one
   * step would hold its agent (and its busy slot) forever. The next start closes the interrupted turn.
   */
  private async overrun(session: Session, now: number) {
    const run = [...session.running.values()].find(record => RUN_METHODS.includes(record.method) && record.began);
    const overrunMs = this.options.runOverrunMs ?? RUN_OVERRUN_MS;
    if (!run || now - run.began! < overrunMs) return;
    // The run's own limit (the agent's runLimits, within the runtime's or an admin tenant's backstop), as `turnLimit` counts it.
    const maxSeconds = await spend.maxSeconds(this.spendContext, session, run.id);
    const over = now - run.began! - maxSeconds * 1000;
    const id = session.header.id;
    if (!(over >= overrunMs) || !this.supervisor.agents.has(id) || !session.running.has(run.id)) return;
    console.error(JSON.stringify({ type: "run_overrun", agent: id, request: run.id, maxSeconds, overMs: over }));
    // The abort ends the model request or tool call in flight at once (model-stream.ts), and the run as its time limit's.
    if (over < 2 * overrunMs) await this.supervisor.request(id, "abort", { stopped: "turn_limit", message: `This run stopped at its time limit of ${spend.duration(maxSeconds)}. Send another message to continue` });
    else await this.supervisor.stop(id, { flush: false });
  }

  /** Drop a session from memory and give up ownership so any node can serve it next. */
  private async unload(session: Session) {
    session.resumeWait?.abort();
    if (this.sessions.get(session.header.id) === session) this.sessions.delete(session.header.id);
    // A faulted session's records past its failed commit are dropped: the journal as stored is what its next load goes on from.
    await session.log.close(!!session.fault).catch(() => {});
    // A revoked agent's logs are never read again.
    if (session.header.revoked) await underClaim(this.db, session.claim, sql => deleteTail(sql, session.header.id)).catch(() => {});
    // What its runs reported, so a page of it unloaded knows whether its index is behind (see `historyPage`).
    const reported = Math.max(0, ...[...session.requests.values()].map(record => Number((record.outcome?.result as { messages?: unknown } | undefined)?.messages) || 0));
    await this.db.query("update agent_history_index set reported = greatest(reported, $2) where agent = $1", [session.header.id, reported]).catch(() => {});
    // Nothing is published after this: the next owner goes on from this cursor.
    // Runs still open (queued ones a drain leaves for the next owner) keep it marked for a sweep to load; none clears the mark.
    // A faulted session's journal may be behind it (a run ended here but not durably), so it stays marked: its next load decides.
    await underClaim(this.db, session.claim, sql => sql.query("update agents set last_cursor = $2, cursor_clean = true, pending_runs = $3 where id = $1",
      [session.header.id, session.cursor, session.running.size > 0 || !!session.fault])).catch(() => {});
    // Spend no transcript record carried (a compaction's or a child's after the agent's last record).
    await this.spendWrite(session, 0)?.().catch(error => console.error(JSON.stringify({ type: "agent_spend_write_failed", agent: session.header.id, error: safeError(error) })));
    // Runs left open are its next owner's to count.
    await this.releaseBusy(session, true);
    // A graceful hand-off is not a failed sweep load, even before the two-minute reset; a memory one may be the agent's
    // doing (as on 2026-10-27), so it keeps the backoff.
    if (!session.fault && session.sweepResetAt !== undefined && this.handingOff?.reason !== "memory") await this.resetSweep(session).catch(() => {});
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
    events.endStreams(session, true);
    if (this.sessions.get(session.header.id) === session) this.sessions.delete(session.header.id);
    // Its claim is gone, so it could write no chunk: its next owner's start catches up.
    await this.supervisor.stop(session.header.id, { flush: false }).catch(() => {});
  }

  async close() {
    this.closed = true;
    for (const session of this.sessions.values()) session.resumeWait?.abort();
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
      events.endStreams(session, false, "drain");
    }
    for (const id of [...this.idle.keys()]) this.loadedElsewhere(id, "drain");
  }
}

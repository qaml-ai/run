import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { FRAME_BYTES, type ClientEvent, type TurnSnapshot } from "../../shared/client-protocol.ts";
import { HttpError } from "../http.ts";
import type { Db } from "../db.ts";
import { LostClaim, underClaim } from "../ownership.ts";
import { callParams, type McpResult } from "../mcp-results.ts";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AttachedServer } from "../attached.ts";
import { callMeta, TOOL_DEADLINES, timedOut, ToolFailure, type ToolCall } from "../tool-servers.ts";
import { recordWatchRefused, safeError } from "../metrics.ts";
import { SUBAGENT_EVENTS } from "../multi-agent.ts";
import { type SessionHeader, runIdOf, type ClientEnv, type BufferedEvent, type Session, type ClientSessionOptions, visible } from "./state.ts";

export type EventContext = {
  options: ClientSessionOptions;
  db: Db;
  sessions: Map<string, Session>;
  /** Each watcher's agent, and its place (given back when it closes) and token expiry. */
  state: { watching: number; tenantWatching: Map<string, number>; watches: WeakMap<ServerResponse, { agent: string; release: () => void; expiry?: ReturnType<typeof setTimeout> }> };
  idle: Map<string, { tenant: string; watchers: Set<ServerResponse>; polls: Set<() => void>; checked: number }>;
  isClosed(): boolean;
  isLoading(id: string): boolean;
  load(id: string): Promise<Session | undefined>;
  publish(session: Session, data: ClientEvent): void;
  replay(session: Session, raw?: string, snapshot?: boolean): { cursor: number; snapshot?: TurnSnapshot; events: BufferedEvent[] };
  idleCursor(id: string): Promise<number | undefined>;
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const json = (c: Context, status: number, value: unknown) => c.json(value, status as ContentfulStatusCode, { "Cache-Control": "no-store" });

/** Event ids an owner reserves at a time (`reserveEvents`): one write per block, made when half of it is left. */
export const EVENT_BLOCK = 10_000;
/**
 * An agent's stored event cursor (the `agents` row): where its last owner stopped (`last`; `clean` when nothing was
 * published after it), and the highest id any owner reserved (`reserved`). Every id published was reserved first.
 */
export type StoredCursor = { last?: number; clean: boolean; reserved?: number };
/**
 * The event cursor a load starts from, given the agent's stored one: where its last owner stopped cleanly, else above
 * every id reserved, so above any id an earlier owner can have published, whatever its clock said. Ids stay
 * microseconds of `now` (ms, this node's clock) where that is higher, which bounds nothing.
 */
export function startingCursor(stored: StoredCursor | undefined, now: number) {
  if (stored?.clean && stored.last !== undefined) return stored.last;
  return Math.max(now * 1000, Math.max(stored?.last ?? 0, stored?.reserved ?? 0) + 1);
}
export const storedCursor = (row: { last_cursor: number | null; cursor_clean: boolean; reserved_cursor: number | null }): StoredCursor =>
  ({ clean: row.cursor_clean, ...row.last_cursor === null ? {} : { last: Number(row.last_cursor) }, ...row.reserved_cursor === null ? {} : { reserved: Number(row.reserved_cursor) } });
export const MAX_BUFFERED_EVENTS = 512;
/** Read-only subscribers (watchers and waiting polls) one agent's stream may have at once, by default; and a tenant's and a node's. */
export const MAX_WATCHERS = 32;
export const MAX_TENANT_WATCHERS = 1024;
export const MAX_NODE_WATCHERS = 4096;
/** A long poll waits at most this long for an event. */
export const MAX_POLL_WAIT_MS = 25_000;
/** The most a snapshot's finished messages take; beyond it, a subscriber reads the turn from history. */
export const TURN_SNAPSHOT_BYTES = 1_000_000;
/** Tool progress published per call at most this often. */
export const PROGRESS_MS = 250;
/**
 * A message_update as its delta: Pi's event without the message it updates, which it carries on every
 * token (as `message`, as the delta's `partial`, and as done's `message` or error's `error`, which
 * message_end carries next). A client folds the message from its message_start and the deltas since;
 * a toolcall_start names its call (`id`, `name`), which only the message did.
 */
export function deltaOf(event: any) {
  const { partial, message: _done, error: _error, ...delta } = event.assistantMessageEvent ?? {};
  // A tool call's id and name are only in the message at its start: they come along, as fields of their own.
  if (delta.type === "toolcall_start") {
    const call = partial?.content?.[delta.contentIndex];
    if (call?.type === "toolCall") Object.assign(delta, { id: call.id, name: call.name });
  }
  return { type: "message_update", assistantMessageEvent: delta };
}
/**
 * `publish` at most once per PROGRESS_MS, trailing: an update within the window replaces the one
 * waiting, which is published when the window ends. `onFlush` gets a function publishing the
 * waiting one now (before the call's result), after which nothing more is published.
 */
export function throttled<T>(publish: (value: T) => void, onFlush: (flush: () => void) => void) {
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
export const readers = new WeakMap<ServerResponse, StreamReader>();
/** Streams that asked for the agent's children's events (`?subagents=1`); the others never get them. */
export const subagentReaders = new WeakSet<ServerResponse>();
export const isSubagent = (data: ClientEvent | TurnSnapshot) => data.type === "event" && SUBAGENT_EVENTS.includes(data.event?.type);
/** Whether a request's client has gone: its connection closed before the response was written. */
export const gone = (c: Context<ClientEnv>) => c.env.incoming.destroyed || c.env.outgoing.destroyed || !!c.env.outgoing.socket?.destroyed;
/**
 * Why the runtime closes an event stream on purpose: its node is leaving (`drain`: a deploy, a scale-in) or the agent is
 * served elsewhere now (`moved`). The stream's last frame says so (`reconnectFrame`), so the subscriber reconnects at
 * once, with Last-Event-ID, instead of backing off as after a failure.
 */
export type ReconnectReason = "drain" | "moved";
/** The last frame of a stream closed on purpose: no `id` (it is no event, and moves no cursor), and `retry: 0` for EventSource. */
export const reconnectFrame = (reason: ReconnectReason) => `event: reconnect\nretry: 0\ndata: ${JSON.stringify({ type: "reconnect", reason, retryMs: 0 })}\n\n`;
/** Write an SSE frame, cutting off a subscriber that does not keep up. */
export function send(res: ServerResponse, frame: string) {
  if (res.destroyed) return;
  if (res.writableLength + Buffer.byteLength(frame) > 2 * FRAME_BYTES) res.destroy();
  else res.write(frame);
}
/** How long a tool call waits for an application to reconnect before failing as not run. */
export const RECONNECT_GRACE_MS = 3_000;
/** How long a replaced connection stays open for the tool calls it has to answer. */
export const DRAIN_MS = 30_000;
/**
 * What the model (and the run's toolErrors) hears of a call whose server disconnected after it was sent: in words it
 * can pass on to a person, never the transport's ("MCP error -32000: Connection closed").
 */
export const CONNECTION_LOST = "The server running this tool disconnected during the call (it restarted or lost its connection), so the call may or may not have " +
  "taken effect. Check whether it did before trying it again; if you cannot check, tell the user it is unknown whether it went through.";

/**
 * Call a tool on the application's attached server, as on any MCP server. With no application
 * connected (after a short wait for one reconnecting) the call fails without running; a call the
 * connection or deadline cut short has an unknown outcome. After a crash, the turn's transcript
 * says the same: a tool call without a result is closed as unknown, never sent again.
 */
export async function callAttached(ctx: EventContext, session: Session, { name, args, signal, toolCallId, innerCallId, idempotencyKey, origin, actor, onProgress, approval, inputResponses, requestState, elicit, lineage }: ToolCall): Promise<McpResult> {
  const attached = await attachedServer(ctx, session, signal);
  if (!attached) throw new ToolFailure("not_connected", "No application is connected to answer this tool call; it did not run");
  // The tool's own deadline, else the runtime's; each progress notification restarts it, up to TOOL_DEADLINES.maxTotalMs.
  const timeout = session.header.definitions.find(tool => tool.name === name)?.timeoutMs ?? ctx.options.toolTimeoutMs ?? TOOL_DEADLINES.attachedMs;
  // Who the call is for, as an identity token would say (the same claims): the connection is the
  // application's own, so it needs no signature, and a tool reads it the same way either way.
  const header = session.header;
  const identity = {
    tenant: header.tenant, agent: header.id, sub: header.identity?.subject ?? header.id,
    ...(header.definition ? { definition: header.definition.id } : {}), ...(header.identity?.context ? { ctx: header.identity.context } : {}),
    ...(actor ? { act: actor } : {}), ...(origin ? { origin } : {}), ...(approval ? { approval } : {}),
    ...(lineage ? { par: lineage.parent, root: lineage.root } : {}),
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

/** A request as its record says, waiting first (`?wait=<seconds>`, at most 25) while it runs. */
export async function settled(ctx: EventContext, c: Context<ClientEnv>, session: Session, requestId: string) {
  const wait = Number(c.req.query("wait") ?? 0);
  if (!Number.isFinite(wait) || wait < 0) throw new HttpError(400, "wait is a number of seconds");
  const until = Date.now() + Math.min(wait * 1000, MAX_POLL_WAIT_MS);
  for (;;) {
    const record = session.requests.get(requestId);
    if (!record) throw new HttpError(404, "Unknown request");
    // Settled, out of time, or the session is no longer here to wake it: as it is now (the caller asks again).
    if (record.state === "completed" || Date.now() >= until || ctx.isClosed() || session.fault || ctx.sessions.get(session.header.id) !== session || gone(c)) return json(c, 200, visible(record));
    // A waiting request holds a subscriber's place, as a waiting events poll does.
    const release = hold(ctx, session.header.tenant, session.watchers.size + session.polls.size);
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); session.polls.delete(done); c.env.outgoing.off("close", done); release(); resolve(); };
      const timer = setTimeout(done, until - Date.now());
      session.polls.add(done);
      c.env.outgoing.once("close", done);
    });
  }
}

/** Keep the running turn as its events fold, for snapshots: the messages its run finished, from the run's start to its response. */
export function follow(session: Session, data: ClientEvent, text: string, oversized: boolean) {
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
export function turnSnapshot(ctx: EventContext, session: Session): TurnSnapshot {
  const turn = session.turn;
  const snapshot: TurnSnapshot = { type: "snapshot", cursor: session.cursor, requestId: turn?.requestId ?? null, turn: turn ? {
    start: turn.start ?? null, count: turn.count, messages: turn.messages, partial: session.partial ?? null, ...(turn.truncated ? { truncated: true as const } : {}),
  } : null };
  // Too large for one frame: the finished messages go first (they are in history), then the streaming message.
  const frame = ctx.options.snapshotBytes ?? FRAME_BYTES;
  if (snapshot.turn && Buffer.byteLength(JSON.stringify(snapshot)) > frame) snapshot.turn = { ...snapshot.turn, messages: [], truncated: true };
  if (snapshot.turn && Buffer.byteLength(JSON.stringify(snapshot)) > frame) snapshot.turn = { ...snapshot.turn, partial: null };
  return snapshot;
}

/**
 * Take a read-only subscriber's place (a watcher's, or a waiting poll's), within the agent's, its tenant's and
 * this node's bounds (429 past them); the function returned gives it back, once.
 */
export function hold(ctx: EventContext, tenant: string, subscribers: number) {
  const reject = (scope: "agent" | "tenant" | "node") => {
    recordWatchRefused(scope, tenant);
    return new HttpError(429, `This ${scope} has too many event stream subscribers; retry later`);
  };
  if (subscribers >= (ctx.options.maxWatchers ?? MAX_WATCHERS)) throw reject("agent");
  if ((ctx.state.tenantWatching.get(tenant) ?? 0) >= (ctx.options.watcherLimitFor?.(tenant) ?? ctx.options.maxTenantWatchers ?? MAX_TENANT_WATCHERS)) throw reject("tenant");
  if (ctx.state.watching >= (ctx.options.maxNodeWatchers ?? MAX_NODE_WATCHERS)) throw reject("node");
  ctx.state.watching++;
  ctx.state.tenantWatching.set(tenant, (ctx.state.tenantWatching.get(tenant) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    ctx.state.watching--;
    const left = ctx.state.tenantWatching.get(tenant)! - 1;
    if (left) ctx.state.tenantWatching.set(tenant, left); else ctx.state.tenantWatching.delete(tenant);
  };
}

/** A watcher closed: out of its agent's session or idle entry, and its place given back. */
export function unwatch(ctx: EventContext, res: ServerResponse) {
  const watch = ctx.state.watches.get(res);
  if (!watch) return;
  ctx.state.watches.delete(res);
  ctx.sessions.get(watch.agent)?.watchers.delete(res);
  const entry = ctx.idle.get(watch.agent);
  entry?.watchers.delete(res);
  if (entry && !entry.watchers.size && !entry.polls.size) ctx.idle.delete(watch.agent);
  clearTimeout(watch.expiry);
  watch.release();
}

/**
 * Reserve the next block of event ids, under the claim: the next owner starts above it. Begun when half
 * the reserved ids are left, so events wait on it (`held`) only when a block runs out first. A node that
 * lost the claim reserves nothing more, so it publishes no id past what it reserved.
 */
export function reserveEvents(ctx: EventContext, session: Session) {
  if (session.reserving || session.fault || ctx.isClosed()) return;
  const id = session.header.id, through = session.cursor + (ctx.options.eventBlock ?? EVENT_BLOCK);
  session.reserving = underClaim(ctx.db, session.claim, sql => sql.query("update agents set reserved_cursor = greatest(coalesce(reserved_cursor, 0), $2) where id = $1", [id, through])).then(() => {
    session.reserving = undefined;
    session.reserved = Math.max(session.reserved, through);
    const held = session.held ?? [];
    session.held = undefined;
    for (const data of held) ctx.publish(session, data);
  }, error => {
    session.reserving = undefined;
    if (error instanceof LostClaim) return;
    console.error(JSON.stringify({ type: "event_reserve_failed", agent: id, error: safeError(error) }));
    if (session.held) setTimeout(() => reserveEvents(ctx, session), 1_000).unref();
  });
}

/** A session loaded here: it takes up its idle watchers and polls, and other nodes end theirs (they reconnect here). */
export function loaded(ctx: EventContext, session: Session) {
  const id = session.header.id;
  const entry = ctx.idle.get(id);
  if (entry) {
    ctx.idle.delete(id);
    for (const res of entry.watchers) session.watchers.add(res);
    for (const wake of [...entry.polls]) wake();
  }
  const node = ctx.options.ownership?.node;
  if (node) void ctx.db.query("select pg_notify('agent_runtime_loaded', $1)", [`${node} ${id}`]).catch(() => {});
}

/**
 * A watcher or poll of an agent: on its session when loaded here (or loading), else registered idle,
 * without loading it. `header` is the agent's, already authorized.
 */
export async function watchAgent(ctx: EventContext, c: Context<ClientEnv>, header: SessionHeader, kind: "watch" | "poll", reader?: StreamReader): Promise<Response> {
  const id = header.id;
  const live = async () => {
    const session = await ctx.load(id);
    if (!session) throw new HttpError(404, "Unknown agent");
    if (session.fault) throw session.fault;
    return kind === "poll" ? poll(ctx, c, session, reader) : subscribe(ctx, c, session, "watch", reader);
  };
  if (ctx.sessions.has(id) || ctx.isLoading(id) || ctx.isClosed()) return live();
  const cursor = await ctx.idleCursor(id);
  // Loaded meanwhile, here or on another node (whose stream this one does not have): take the loaded path, or retry there.
  if (ctx.sessions.has(id) || ctx.isLoading(id)) return live();
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
  const existing = ctx.idle.get(id);
  const release = hold(ctx, header.tenant, existing ? existing.watchers.size + existing.polls.size : 0);
  const idle = existing ?? { tenant: header.tenant, watchers: new Set<ServerResponse>(), polls: new Set<() => void>(), checked: Date.now() };
  if (!existing) ctx.idle.set(id, idle);
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
    if (!idle.watchers.size && !idle.polls.size && ctx.idle.get(id) === idle) ctx.idle.delete(id);
    return json(c, 200, { cursor, events: snapshot ? [{ id: cursor, data: shown(snapshot) }] : [] });
  }
  const res = c.env.outgoing;
  const expiry = reader && Number.isFinite(reader.until) ? setTimeout(() => res.end(), Math.max(0, reader.until - Date.now())) : undefined;
  expiry?.unref();
  if (reader) readers.set(res, reader);
  idle.watchers.add(res);
  ctx.state.watches.set(res, { agent: id, release, expiry });
  res.on("close", () => unwatch(ctx, res));
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  res.write(`event: ready\ndata: ${JSON.stringify({ version: 5, agentId: id, watch: true })}\n\n`);
  if (snapshot) send(res, `id: ${cursor}\ndata: ${JSON.stringify(shown(snapshot))}\n\n`);
  return RESPONSE_ALREADY_SENT;
}

/** Every open event stream of the agent: the application's connection and its watchers. */
export function streams(session: Session) {
  return session.response ? [session.response, ...session.watchers] : [...session.watchers];
}

/**
 * Close every event stream (`destroy`: cut off, not ended cleanly), and answer waiting polls, so subscribers reconnect.
 * Closed on purpose (`reconnect`), each stream's last frame tells its subscriber to reconnect at once.
 */
export function endStreams(session: Session, destroy = false, reconnect?: ReconnectReason) {
  for (const res of streams(session)) if (destroy) res.destroy(); else if (!res.destroyed) res.end(reconnect ? reconnectFrame(reconnect) : undefined);
  for (const wake of [...session.polls]) wake();
}

/**
 * The application's connection is replaced (a takeover, or a new process while the old one drains): it takes no new
 * calls, and stays open, up to DRAIN_MS, until the calls it has are answered, so a deploy loses none. Then it hears
 * it was replaced, and closes.
 */
export function retire(session: Session) {
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
export function closeAttached(session: Session) {
  for (const attached of [...session.retiring ?? []]) void attached.close();
  session.retiring?.clear();
  void session.attached?.close();
}

/**
 * Open an event stream: the application's (`attach`), which carries its attached MCP server and
 * replaces the connection before it, or a read-only watcher, which never replaces another and is
 * never replaced. Every stream gets every event from its own cursor on (see `replay`).
 */
export async function subscribe(ctx: EventContext, c: Context<ClientEnv>, session: Session, mode: "attach" | "watch", reader?: StreamReader) {
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
  const { snapshot, events } = ctx.replay(session, c.req.header("last-event-id"), asked);
  const release = mode === "watch" ? hold(ctx, session.header.tenant, session.watchers.size + session.polls.size) : undefined;
  const res = c.env.outgoing;
  if (c.req.query("subagents") === "1") subagentReaders.add(res);
  let ready: Record<string, unknown> = { version: 5, agentId: session.header.id };
  // A reader's stream ends as its token expires: it reconnects with a fresh one, so access changes apply within a token's life.
  const expiry = reader && Number.isFinite(reader.until) ? setTimeout(() => res.end(), Math.max(0, reader.until - Date.now())) : undefined;
  expiry?.unref();
  if (reader) readers.set(res, reader);
  if (mode === "watch") {
    session.watchers.add(res);
    ctx.state.watches.set(res, { agent: session.header.id, release: release!, expiry });
    res.on("close", () => unwatch(ctx, res));
    ready = { ...ready, watch: true };
  } else {
    retire(session);
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
  // A stateless run's stream ends with the run: with its response, replayed or, past what is buffered, as it ended.
  const ended = mode === "watch" && session.header.run ? session.requests.get(runIdOf(session.header.id)) : undefined;
  if (ended?.state === "completed") {
    if (!events.some(event => event.data.type === "response" && event.data.id === ended.id)) send(res, `id: ${session.cursor}\ndata: ${JSON.stringify({ type: "response", id: ended.id, outcome: ended.outcome })}\n\n`);
    res.end();
  }
  return RESPONSE_ALREADY_SENT;
}

/**
 * One read of the stream for clients that cannot hold it open: the buffered events after the
 * cursor, as JSON, and the cursor to poll from next. With `wait` (seconds, at most 25) and nothing
 * buffered yet, it answers when the next event arrives or the wait ends. With `snapshot=1`, as for
 * a stream: a snapshot where there is nothing to replay from.
 */
export async function poll(ctx: EventContext, c: Context<ClientEnv>, session: Session, reader?: StreamReader) {
  if (gone(c)) return RESPONSE_ALREADY_SENT;
  const raw = c.req.header("last-event-id");
  // As a watcher: a snapshot by default, where there is nothing to replay from; snapshot=0 opts out.
  const asked = c.req.query("snapshot") !== "0";
  const wait = Number(c.req.query("wait") ?? 0);
  if (!Number.isFinite(wait) || wait < 0) throw new HttpError(400, "wait is a number of seconds");
  let read = ctx.replay(session, raw, asked);
  if (!read.snapshot && !read.events.length && wait > 0 && !ctx.isClosed() && !session.fault) {
    // A waiting poll holds a subscriber's place, as a watcher does.
    const release = hold(ctx, session.header.tenant, session.watchers.size + session.polls.size);
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); session.polls.delete(done); c.env.outgoing.off("close", done); release(); resolve(); };
      const timer = setTimeout(done, Math.max(0, Math.min(wait * 1000, MAX_POLL_WAIT_MS, reader ? reader.until - Date.now() : Infinity)));
      session.polls.add(done);
      c.env.outgoing.once("close", done);
    });
    read = ctx.replay(session, raw, asked);
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

/** A tap on a run's text deltas from now on: `chunks` yields them until the response (or the agent leaves, or `signal`). */
export function runText(ctx: EventContext, session: Session, requestId: string, signal: AbortSignal) {
  const queue: string[] = [];
  let done = false, wake: (() => void) | undefined;
  const tap = (data: ClientEvent) => {
    if (data.type === "response" && data.id === requestId) done = true;
    else if (data.type === "event" && data.requestId === requestId && data.event?.type === "message_update") {
      const update = data.event.assistantMessageEvent;
      if (update?.type === "text_delta" && typeof update.delta === "string") queue.push(update.delta);
    } else return;
    wake?.();
  };
  (session.taps ??= new Set()).add(tap);
  const stop = () => { done = true; wake?.(); };
  signal.addEventListener("abort", stop, { once: true });
  const close = () => { session.taps?.delete(tap); signal.removeEventListener("abort", stop); };
  const self = ctx;
  return {
    close,
    async *chunks() {
      try {
        for (;;) {
          while (queue.length) yield queue.shift()!;
          if (done || self.sessions.get(session.header.id) !== session) return;
          // Woken by the next delta or the response, or after a second to see whether the agent left this node.
          await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 1_000).unref(); });
          wake = undefined;
        }
      } finally { close(); }
    },
  };
}

/** Whether an application serves the agent's tools, waiting briefly for one that is reconnecting. */
export async function applicationConnected(ctx: EventContext, session: Session) {
  for (const until = Date.now() + RECONNECT_GRACE_MS; ;) {
    if (session.attached?.accepting && session.attached.initialized) return true;
    if (Date.now() >= until || ctx.isClosed() || session.fault) return false;
    await sleep(50);
  }
}

/** The attached server once its MCP session is up, waiting briefly for an application that is reconnecting. */
export async function attachedServer(ctx: EventContext, session: Session, signal: AbortSignal) {
  for (const until = Date.now() + RECONNECT_GRACE_MS; ;) {
    const attached = session.attached;
    if (attached?.accepting && await attached.ready.then(() => true, () => false) && attached.accepting) return attached;
    if (Date.now() >= until || signal.aborted || ctx.isClosed() || session.fault) return undefined;
    await sleep(50);
  }
}

/** A session unloading keeps its watchers, idle, and answers its polls. */
export function idleWatchers(ctx: EventContext, session: Session) {
  const id = session.header.id;
  if (session.watchers.size) {
    let entry = ctx.idle.get(id);
    if (!entry) { entry = { tenant: session.header.tenant, watchers: new Set(), polls: new Set(), checked: Date.now() }; ctx.idle.set(id, entry); }
    for (const res of session.watchers) entry.watchers.add(res);
    session.watchers.clear();
  }
  for (const wake of [...session.polls]) wake();
}

/**
 * The route in your app that lets its users talk to their agents from a browser. Your API key stays
 * on your server; the browser gets short-lived read-only tokens for its user's own agent, and every
 * write (a message, an answer, a stop) goes through here, as the user your `authorize` says it is.
 *
 *   // app/api/agent/route.ts
 *   export const POST = createAgentHandler({
 *     authorize: async request => { const user = await auth(request); return user ? { userId: user.id, name: user.name } : null; },
 *     agent: { instructions: "You help with orders." },
 *   });
 *
 * Fetch-standard: Next.js route handlers, Hono (`c => handler(c.req.raw)`), Workers, Bun and Deno take it
 * as is; Express and node:http with `nodeListener(handler)` from "@camelai/run/node".
 *
 * With `proxy: true`, browsers read their agent through this route too (GET <route>/v1/agents/:id/…),
 * so they only ever talk to your origin: mount it on the route and everything under it.
 *
 * Its wire protocol (POST {action: token|send|wait|answer|stop|link, …}) is in docs/frontend.md, "The route's
 * protocol": `send` with `wait` answers with the reply once the run ends, for callers without the stream.
 */
import { Agents, type Agent, type AgentConfig } from "./agents.ts";
import { AgentError, DEFAULT_URL, type CreateAgentOptions, type Sender } from "./typescript.ts";

const env = (name: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] || undefined;

/** Who is asking, as your `authorize` found: the user, and optionally which of their agents. */
export interface AgentAuth {
  /** Your user's id: `from.id` on everything this user sends or answers, and the subject of their own agent. */
  userId: string;
  /** Their display name, shown to the model and in the transcript as the sender's. */
  name?: string;
  /**
   * The agent to use (1 to 80 letters, digits, `_` and `-`). Default: `agentKeyFor(userId, thread)`, one
   * agent per user and thread. Give your own to share an agent between users (a team's agent, say).
   */
  agentKey?: string;
  /**
   * Who the agent acts for (its tools' `identity.subject`), set when it is made and never changed. Default:
   * the user, for their own agent; the `agentKey`, for an agent you name (one several people share).
   */
  subject?: string;
}

/** What an agent is made with: the parts of `AgentConfig` a handler sets. Its `subject` is always the user. */
export type AgentSetup = Pick<AgentConfig,
  "model" | "instructions" | "tools" | "mcp" | "definition" | "builtins" | "thinkingLevel" | "context" | "keyScope" | "spendLimit" | "runLimits" | "modelHeaders" | "mounts" | "name">;

export interface SendEvent<A extends AgentAuth = AgentAuth> {
  auth: A;
  thread: string | null;
  text: string;
  /** Whatever JSON the browser sent with the message (`send(text, { data })`); it reaches the agent only through you. */
  data: unknown;
  request: Request;
}

export interface AgentHandlerOptions<A extends AgentAuth = AgentAuth> {
  /** Your API key. Default: the CAMELAI_API_KEY environment variable. */
  apiKey?: string;
  /** The runtime's origin. Default: CAMELAI_BASE_URL, else https://run.camelai.com. */
  url?: string;
  /**
   * Your own session check, on every request. Return the user (and optionally which agent), or null to
   * refuse it (401). `thread` is the browser's name for a conversation: untrusted, and never an agent id.
   */
  authorize(request: Request, context: { thread: string | null; action: HandlerAction }): A | null | Promise<A | null>;
  /**
   * How the user's agent is made (on first use), and set again when this changes. A function gets the
   * user; keep what it returns stable (build tools once, not per call): a setup that differs from the
   * last reconfigures the agent, and one with tools reattaches them.
   */
  agent?: AgentSetup | ((auth: A, context: { thread: string | null }) => AgentSetup | Promise<AgentSetup>);
  /**
   * Before each message is sent: return `{ text?, metadata? }` to change it or label it (metadata is yours,
   * never shown to the model), or throw a Response to refuse it (a quota, moderation).
   */
  onSend?(event: SendEvent<A>): void | { text?: string; metadata?: Record<string, string> } | Promise<void | { text?: string; metadata?: Record<string, string> }>;
  /** The browser tokens it mints. Default: 15 minutes, every event, no provider cost (`redact: ["usage.cost"]`). */
  browserToken?: {
    ttlSeconds?: number;
    events?: string[];
    redact?: "usage.cost"[];
    /** Where browsers reach the runtime, when not where this server does (a token's `url` by default). */
    url?: string;
  };
  /** Other origins whose pages may call this route (with CORS); by default only this site's. */
  allowedOrigins?: string[];
  /**
   * Pass the browser's reads (the event stream, its long-poll fallback, history, state and inputs) through
   * this route, so the browser talks only to your origin (default false: it reads the runtime directly,
   * with a browser token). The route must then also take GET requests under its path. Each read is
   * checked with `authorize` like everything else, and streams as it arrives. Serverless functions
   * end a stream at their time limit; the chat reconnects, and falls back to long polls.
   */
  proxy?: boolean;
  /**
   * `link` signs downloads of the files an agent presented (present_file), and of files in its own
   * workspace volume. true: of any path in its mounts; the boundary is then what the agent can read,
   * including volumes the app mounted that its users may not all be meant to read (default false).
   */
  linkAnyMountedPath?: boolean;
  /** How long an agent with tools served from this process stays attached after its last use. Default 15 minutes. */
  idleMs?: number;
  fetch?: typeof globalThis.fetch;
}

export type HandlerAction = "token" | "send" | "wait" | "answer" | "stop" | "link" | "read";
const ACTIONS = new Set<HandlerAction>(["token", "send", "wait", "answer", "stop", "link"]);
/** A read the proxy passes through: [thread segment, agent id, route]. */
const READ = /(?:\/threads\/([^/]+))?\/v1\/agents\/([^/]+)\/(events|history|state|inputs)$/;
/** A file link the proxy passes through: its runtime path, whose signed token is its only credential. */
const LINK = /\/v1\/links\/[^/]+\/[^/]+$/;
/** What a file download answers with, passed on from the runtime. */
const LINK_HEADERS = ["content-type", "content-length", "content-disposition", "content-range", "accept-ranges", "etag", "last-modified", "cache-control", "x-content-type-options", "content-security-policy"];

/** The route: a fetch handler. `close()` detaches agents whose tools this process serves. */
export type AgentHandler = ((request: Request) => Promise<Response>) & { close(): Promise<void> };

const KEY = /^[A-Za-z0-9_-]{1,80}$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,80}$/;
const INPUT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_BODY = 1024 * 1024;
const MAX_CACHED = 5000;
/** The longest a `send` or `wait` with `wait` holds its request, in seconds: the runtime's longest wait. */
const MAX_WAIT_SECONDS = 25;

/** A `wait` field: true (the longest), or seconds from 1 to 25; undefined when absent or false. */
function waitSeconds(value: unknown): number | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return MAX_WAIT_SECONDS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_WAIT_SECONDS) return fail(400, "invalid_request", "wait is true, or whole seconds from 1 to 25");
  return value;
}

/** What `send` and `wait` answer: the request, and once it ended, its reply, error or why it stopped. Never its other results. */
function sent(record: { id: string; state: string; steeredInto?: string; error?: string; stopped?: string; outcome?: { result?: { reply?: unknown } } }) {
  const reply = record.outcome?.result?.reply;
  return {
    requestId: record.id, state: record.state, ...(record.steeredInto ? { steeredInto: record.steeredInto } : {}),
    ...(typeof reply === "string" ? { reply } : {}), ...(record.error !== undefined ? { error: record.error } : {}), ...(record.stopped ? { stopped: record.stopped } : {}),
  };
}

/**
 * The agent key for a user's thread: a hash of both, so it is a valid key whatever they are, and no
 * user's thread can name another user's agent.
 */
export async function agentKeyFor(userId: string, thread?: string | null): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([userId, thread ?? null]));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `u_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** A path segment, decoded; a malformed one is the request's fault. */
function decodeSegment(value: string): string {
  try { return decodeURIComponent(value); } catch { return fail(400, "invalid_request", "The path is not valid"); }
}

/** An error the handler answers with: `{ error: { code, message } }`. */
class HandlerError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const fail = (status: number, code: string, message: string): never => { throw new HandlerError(status, code, message); };

interface Cached {
  id: string;
  token: string;
  fingerprint: string;
  /** The agent this process serves tools for, if it does. */
  attached?: Agent;
  used: number;
  /** Its own workspace volume's mount path, from its mounts (null: none), once looked up. */
  workspace?: string | null;
  /** Paths it presented (present_file), as far as its history was read (up to `scanned`, a history index). */
  presented: Set<string>;
  scanned: number;
}

/** The fields of a setup that decide the agent's configuration, as a string (tools by name and description). */
function fingerprintOf(setup: AgentSetup): string {
  const tools = Object.entries(setup.tools ?? {}).map(([name, tool]) => [name, tool.description ?? ""]).sort();
  const { tools: _tools, mcp, ...rest } = setup;
  return JSON.stringify([rest, tools, mcp ? "mcp" : null]);
}

export function createAgentHandler<A extends AgentAuth = AgentAuth>(options: AgentHandlerOptions<A>): AgentHandler {
  const apiKey = options.apiKey ?? env("CAMELAI_API_KEY") ?? env("AGENT_RUNTIME_TOKEN");
  const url = (options.url ?? env("CAMELAI_BASE_URL") ?? env("AGENT_URL") ?? DEFAULT_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  let agents: Agents | undefined;
  const runtime = () => {
    if (!apiKey) fail(500, "missing_api_key", "Set apiKey (or the CAMELAI_API_KEY environment variable) on the agent handler");
    agents ??= new Agents({ apiKey, url, ...(options.fetch ? { fetch: options.fetch } : {}) });
    return agents;
  };
  const cache = new Map<string, Promise<Cached>>();
  const idleMs = options.idleMs ?? 15 * 60_000;
  let sweeper: ReturnType<typeof setInterval> | undefined;

  /** A call to the runtime with the API key (or an agent's token): its JSON, or a HandlerError with its status and code. */
  async function call(path: string, body: unknown, token = apiKey!, method = "POST"): Promise<any> {
    let response: Response;
    try {
      response = await doFetch(url + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    } catch (error) { return fail(502, "runtime_unreachable", `Could not reach the agent runtime: ${(error as Error).message}`); }
    const value = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
    if (response.ok) return value;
    const message = typeof value.error === "string" ? value.error : `HTTP ${response.status}`;
    const code = typeof value.code === "string" ? value.code : /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1] ?? codeFor(response.status);
    return fail(response.status >= 500 ? 502 : response.status, code, message);
  }

  const get = (path: string) => call(path, undefined, apiKey!, "GET");

  async function upsert(key: string, setup: AgentSetup, auth: A): Promise<Cached> {
    // A shared agent's subject cannot be whoever opened it first: it is set once, and never changes.
    const config: AgentConfig = { ...setup, subject: auth.subject ?? (auth.agentKey ? key : auth.userId) };
    const serves = !!setup.mcp || Object.keys(setup.tools ?? {}).length > 0;
    try {
      if (serves) {
        // Tools served from this process: the agent stays attached while it is used, and a while after.
        const agent = await runtime().upsert(key, { ...config, takeover: true, onEvent: () => { touch(key); } });
        startSweeper();
        return { id: agent.id, token: agent.session.token, fingerprint: fingerprintOf(setup), attached: agent, used: Date.now(), presented: new Set(), scanned: -1 };
      }
      const { instructions, ...rest } = config;
      const created: CreateAgentOptions = { ...rest as CreateAgentOptions, ...(instructions !== undefined ? { systemPrompt: instructions } : {}) };
      const { session } = await runtime().runtime.upsertAgent(key, created);
      return { id: session.id, token: session.token, fingerprint: fingerprintOf(setup), used: Date.now(), presented: new Set(), scanned: -1 };
    } catch (error) {
      if (error instanceof HandlerError) throw error;
      if (error instanceof AgentError) return fail(error.status >= 400 && error.status < 500 ? error.status : 502, error.code ?? codeFor(error.status), error.message);
      throw error;
    }
  }

  function touch(key: string) {
    void cache.get(key)?.then(entry => { entry.used = Date.now(); }, () => {});
  }
  function startSweeper() {
    if (sweeper) return;
    sweeper = setInterval(() => {
      for (const [key, pending] of cache) void pending.then(entry => {
        if (entry.attached && Date.now() - entry.used > idleMs) { cache.delete(key); void entry.attached.close().catch(() => {}); }
      }, () => {});
    }, Math.min(60_000, idleMs));
    (sweeper as { unref?: () => void }).unref?.();
  }

  /** The user's agent: upserted once per process (and again when its setup changes). */
  async function agentFor(auth: A, thread: string | null, refresh = false): Promise<Cached> {
    const key = auth.agentKey ?? await agentKeyFor(auth.userId, thread);
    if (!KEY.test(key)) fail(500, "invalid_agent_key", "authorize returned an agentKey that is not 1 to 80 letters, digits, _ and -");
    const setup = typeof options.agent === "function" ? await options.agent(auth, { thread }) : options.agent ?? {};
    const fingerprint = fingerprintOf(setup);
    const cached = cache.get(key);
    if (cached && !refresh) {
      const entry = await cached.catch(() => undefined);
      if (entry && entry.fingerprint === fingerprint) {
        entry.used = Date.now();
        // Most recently used last, so the oldest go first when the cache is full.
        cache.delete(key); cache.set(key, cached);
        return entry;
      }
    }
    const pending = upsert(key, setup, auth);
    // The entry it replaces (a changed setup, or a renewal) no longer serves the agent's tools here.
    if (cached) void Promise.all([cached, pending]).then(([previous, next]) => { if (previous.attached && previous.attached !== next.attached) return previous.attached.close(); }).catch(() => {});
    cache.delete(key);
    cache.set(key, pending);
    pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
    if (cache.size > MAX_CACHED) {
      const [oldest, entry] = cache.entries().next().value!;
      cache.delete(oldest);
      void entry.then(value => value.attached?.close(), () => {}).catch(() => {});
    }
    return pending;
  }

  /**
   * A download link for a file in the agent's mounts. For now the agent's own token signs it (so only its
   * mounts are reachable), renewed once if it expired; once the runtime has POST /v1/agents/:id/links,
   * the tenant key signs it here instead and nothing else changes.
   */
  async function signLink(agent: Cached, path: string, renew: () => Promise<Cached>): Promise<{ url: string; urlPath?: string; expiresAt: number }> {
    const sign = (entry: Cached) => call(`/clients/${encodeURIComponent(entry.id)}/links`, { path, method: "GET" }, entry.token);
    return sign(agent).catch(async error => {
      if (!(error instanceof HandlerError) || error.status !== 401) throw error;
      return sign(await renew());
    });
  }

  /**
   * Whether `path` is in the agent's own workspace volume (the one the runtime made for it, not one the
   * app mounted, which other agents may share), by its actual mounts.
   */
  async function ownWorkspace(agent: Cached, path: string): Promise<boolean> {
    if (agent.workspace === undefined) {
      const mounts = await get(`/v1/agents/${encodeURIComponent(agent.id)}/mounts`) as { volumeId: string; path: string }[];
      // The runtime names an agent's own workspace volume after the agent (VolumeService.workspaceOf).
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`workspace:${agent.id}`)));
      const own = `vol_${[...digest].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 24)}`;
      agent.workspace = mounts.find(mount => mount.volumeId === own)?.path.replace(/\/+$/, "") ?? null;
    }
    return agent.workspace !== null && path.startsWith(`${agent.workspace}/`);
  }

  /**
   * Whether the agent presented `path` (a present_file call that succeeded), from its history, newest first.
   * Only history newer than the last look is read again, so a path it never presented costs one page.
   */
  async function presented(agent: Cached, path: string): Promise<boolean> {
    if (agent.presented.has(path)) return true;
    const calls = new Set<string>();
    const through = agent.scanned;
    let before: number | null | undefined, newest = through;
    // Read to the end (or to what was read before): then everything up to the newest message has been seen.
    const exhausted = () => { agent.scanned = Math.max(agent.scanned, newest); return false; };
    for (let page = 0; page < 20 && before !== null; page++) {
      const value = await get(`/v1/agents/${encodeURIComponent(agent.id)}/history?limit=200${before !== undefined ? `&before=${before}` : ""}`) as { entries: { index: number; message: any }[]; next: number | null };
      if (page === 0) newest = value.entries.at(-1)?.index ?? through;
      // A page holds whole turns, oldest first: a call's result follows it, so read each page backwards.
      for (const { index, message } of [...value.entries].reverse()) {
        if (index <= through) return exhausted();
        if (message.role === "toolResult" && !message.isError && /(^|__)present_file$/.test(String(message.toolName ?? "")) && !message.details?.inputRequired) {
          calls.add(message.toolCallId);
          // Its result names the file as the agent's mounts show it, which is what a chat asks to link.
          const shown = (() => { try { return JSON.parse(message.content?.find((part: any) => part?.type === "text")?.text ?? "").path; } catch { return undefined; } })();
          if (typeof shown === "string") { agent.presented.add(shown); if (shown === path) return true; }
        }
        if (message.role === "assistant") for (const block of message.content ?? []) {
          if (block?.type === "toolCall" && calls.has(block.id) && typeof block.arguments?.path === "string") {
            agent.presented.add(block.arguments.path);
            if (block.arguments.path === path) return true;
          }
        }
      }
      before = value.next;
    }
    return before === null ? exhausted() : false;
  }

  /** Browser tokens the proxy reads with, by agent: minted on this server, never sent to the browser. */
  const readTokens = new Map<string, { token: string; expiresAt: number }>();
  async function readToken(agent: Cached, auth: A, fresh = false): Promise<string> {
    const known = readTokens.get(agent.id);
    if (known && !fresh && known.expiresAt - Date.now() > 120_000) return known.token;
    const token = options.browserToken ?? {};
    const minted = await call(`/v1/agents/${encodeURIComponent(agent.id)}/browser-tokens`, {
      subject: auth.userId.slice(0, 200), redact: token.redact ?? ["usage.cost"], ttlSeconds: token.ttlSeconds ?? 3600, ...(token.events ? { events: token.events } : {}),
    });
    if (readTokens.size >= MAX_CACHED) readTokens.delete(readTokens.keys().next().value!);
    readTokens.set(agent.id, { token: minted.token, expiresAt: minted.expiresAt });
    return minted.token;
  }

  /**
   * A read passed through to the runtime, streamed as it arrives: the user's own agent only (as
   * `authorize` says), with a browser token added here, and cancelled when the browser goes away.
   */
  async function read(request: Request, match: RegExpExecArray): Promise<Response> {
    const thread = match[1] === undefined ? null : decodeSegment(match[1]);
    if (thread !== null && (!thread || thread.length > 200)) fail(400, "invalid_request", "thread is a string of 1 to 200 characters");
    const requested = decodeSegment(match[2]);
    const auth = checked(await options.authorize(request, { thread, action: "read" }));
    const agent = await agentFor(auth, thread);
    // The path names an agent; only the user's own is readable (another is not found, as on the runtime).
    if (requested !== agent.id) fail(404, "not_found", "No such agent");
    const target = `${url}/v1/agents/${encodeURIComponent(agent.id)}/${match[3]}${new URL(request.url).search}`;
    const forward = async (fresh: boolean) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${await readToken(agent, auth!, fresh)}` };
      for (const name of ["accept", "last-event-id"]) { const value = request.headers.get(name); if (value !== null) headers[name] = value; }
      try { return await doFetch(target, { headers, signal: request.signal, redirect: "manual" }); }
      catch (error) {
        if (request.signal.aborted) throw error;
        return fail(502, "runtime_unreachable", `Could not reach the agent runtime: ${(error as Error).message}`);
      }
    };
    let upstream = await forward(false);
    if (upstream.status === 401) { await upstream.body?.cancel(); upstream = await forward(true); }
    const headers = new Headers({ "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
    const type = upstream.headers.get("content-type");
    if (type) headers.set("Content-Type", type);
    // The body as it comes: each chunk is passed on as it arrives, nothing is buffered or rewritten.
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  /** A signed file link passed through to the runtime (ranges included), with nothing added: its token is the credential. */
  async function download(request: Request, path: string): Promise<Response> {
    const headers: Record<string, string> = {};
    for (const name of ["range", "if-range", "if-none-match", "if-modified-since"]) { const value = request.headers.get(name); if (value !== null) headers[name] = value; }
    let upstream: Response;
    try { upstream = await doFetch(`${url}${path}`, { headers, signal: request.signal, redirect: "manual" }); }
    catch (error) {
      if (request.signal.aborted) throw error;
      return fail(502, "runtime_unreachable", `Could not reach the agent runtime: ${(error as Error).message}`);
    }
    const passed = new Headers();
    for (const name of LINK_HEADERS) { const value = upstream.headers.get(name); if (value !== null) passed.set(name, value); }
    return new Response(upstream.body, { status: upstream.status, headers: passed });
  }

  async function handle(request: Request, body: Record<string, unknown>, auth: A, action: HandlerAction, thread: string | null): Promise<unknown> {
    const agent = await agentFor(auth, thread);
    const path = `/v1/agents/${encodeURIComponent(agent.id)}`;
    const from: Sender = { id: auth.userId, ...(auth.name ? { name: auth.name } : {}) };
    switch (action) {
      case "token": {
        // Proxied, the browser reads through this route (its own endpoint), and needs no token of its own.
        if (options.proxy) return { proxy: true, agentId: agent.id, token: "", expiresAt: Date.now() + 3_600_000 };
        const token = options.browserToken ?? {};
        const minted = await call(`${path}/browser-tokens`, {
          subject: auth.userId.slice(0, 200), redact: token.redact ?? ["usage.cost"],
          ...(token.ttlSeconds !== undefined ? { ttlSeconds: token.ttlSeconds } : {}), ...(token.events ? { events: token.events } : {}),
        });
        return { token: minted.token, expiresAt: minted.expiresAt, agentId: minted.agentId, url: token.url ?? minted.url ?? url };
      }
      case "send": {
        let text = body.text;
        const clientId = body.clientId;
        if (typeof text !== "string" || !text.trim()) fail(400, "invalid_request", "text must be a nonblank string");
        if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) fail(400, "invalid_request", "clientId must be 8 to 80 letters, digits, _ and -");
        const whileRunning = body.whileRunning;
        if (whileRunning !== undefined && whileRunning !== "queue" && whileRunning !== "steer") fail(400, "invalid_request", "whileRunning is queue or steer");
        const wait = waitSeconds(body.wait);
        let metadata: Record<string, string> | undefined;
        const changed = await options.onSend?.({ auth, thread, text: text as string, data: body.data, request });
        if (changed?.text !== undefined) text = changed.text;
        if (changed?.metadata) metadata = changed.metadata;
        const accepted = await call(`${path}/prompt`, {
          text, requestId: clientId, from, ...(metadata ? { metadata } : {}), ...(whileRunning ? { whileRunning } : {}),
        });
        // Waiting, it is answered once its run ends (a steered message's, once the turn it joined does).
        if (wait === undefined || accepted.state === "completed") return sent(accepted);
        return sent(await get(`${path}/requests/${encodeURIComponent(accepted.id)}?wait=${wait}`));
      }
      case "wait": {
        // Ask again about a message sent before (its clientId), without sending it again.
        const requestId = body.requestId;
        if (typeof requestId !== "string" || !CLIENT_ID.test(requestId)) fail(400, "invalid_request", "requestId must be a message's clientId");
        const wait = waitSeconds(body.wait) ?? 0;
        return sent(await get(`${path}/requests/${encodeURIComponent(requestId as string)}${wait ? `?wait=${wait}` : ""}`));
      }
      case "answer": {
        const inputId = body.inputId;
        const answer = body.answer as { action?: unknown; content?: unknown } | undefined;
        if (typeof inputId !== "string" || !INPUT_ID.test(inputId)) fail(400, "invalid_request", "inputId must be an input's id");
        if (!answer || typeof answer !== "object" || !["accept", "decline", "cancel"].includes(answer.action as string)) fail(400, "invalid_request", "answer.action is accept, decline or cancel");
        return call(`${path}/inputs/${encodeURIComponent(inputId as string)}`, { action: answer!.action, ...(answer!.content !== undefined ? { content: answer!.content } : {}), from });
      }
      case "stop":
        return call(`${path}/abort`, {});
      case "link": {
        const file = body.path;
        if (typeof file !== "string" || !file.startsWith("/") || file.length > 1024 || file.split("/").some(segment => segment === ".." || segment === ".")) fail(400, "invalid_request", "path must be a file's absolute path");
        if (!options.linkAnyMountedPath && !await ownWorkspace(agent, file as string) && !await presented(agent, file as string)) {
          fail(403, "forbidden", "Only files the agent presented, or in its own workspace, can be linked (see linkAnyMountedPath)");
        }
        const link = await signLink(agent, file as string, () => agentFor(auth, thread, true));
        // Proxied, the browser downloads through this route too, on the page's own origin.
        if (options.proxy) return { url: `${new URL(request.url).pathname.replace(/\/+$/, "")}${link.urlPath ?? new URL(link.url).pathname}`, expiresAt: link.expiresAt };
        return { url: link.url, expiresAt: link.expiresAt };
      }
    }
  }

  /** What authorize returned, if it is a user: null is a 401, and a malformed one the app's own bug. */
  function checked(auth: A | null): A {
    if (!auth) return fail(401, "unauthorized", "Sign in first");
    if (typeof auth.userId !== "string" || !auth.userId || auth.userId.length > 200) fail(500, "invalid_auth", "authorize returned no userId, or one longer than 200 characters");
    if (auth.name !== undefined && (typeof auth.name !== "string" || auth.name.length > 200)) fail(500, "invalid_auth", "authorize returned a name longer than 200 characters");
    return auth;
  }
  /**
   * Requests only from this site (or an allowed origin): by Sec-Fetch-Site where the browser sends it,
   * else by Origin against Host (hosts only: a proxy that ends TLS changes the scheme, not the host).
   */
  function sameSite(request: Request, origin: string | null) {
    if (origin && allowed.has(origin)) return;
    const site = request.headers.get("sec-fetch-site");
    if (site === "cross-site" || site === "same-site") fail(403, "forbidden_origin", "This route takes requests from its own site; list other origins in allowedOrigins");
    if (site === null && origin && origin !== "null") {
      let from: string;
      try { from = new URL(origin).host; } catch { return fail(403, "forbidden_origin", "The request's Origin is not valid"); }
      const host = request.headers.get("host") ?? new URL(request.url).host;
      if (from !== host) fail(403, "forbidden_origin", "This route takes requests from its own site; list other origins in allowedOrigins");
    }
  }
  const allowed = new Set(options.allowedOrigins ?? []);
  const cors = (origin: string | null): Record<string, string> => origin && allowed.has(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" } : {};
  const respond = (status: number, value: unknown, origin: string | null) =>
    new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(origin) } });

  const handler = (async (request: Request) => {
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS" && origin && allowed.has(origin)) {
      return new Response(null, { status: 204, headers: { ...cors(origin), "Access-Control-Allow-Methods": options.proxy ? "GET, POST" : "POST", "Access-Control-Allow-Headers": "Content-Type, Authorization, Last-Event-ID", "Access-Control-Max-Age": "86400" } });
    }
    try {
      if (request.method === "GET" && options.proxy) {
        const pathname = new URL(request.url).pathname;
        const link = LINK.exec(pathname);
        if (link) return await download(request, link[0]);
        const match = READ.exec(pathname);
        if (!match) fail(404, "not_found", "No such route");
        sameSite(request, origin);
        const response = await read(request, match!);
        for (const [name, value] of Object.entries(cors(origin))) response.headers.set(name, value);
        return response;
      }
      if (request.method !== "POST") fail(405, "method_not_allowed", "POST a JSON body");
      // Only JSON (a form on another site cannot post it), and only from this site unless allowed.
      if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) fail(415, "unsupported_media_type", "Send Content-Type: application/json");
      sameSite(request, origin);
      const text = await request.text();
      if (text.length > MAX_BODY) fail(413, "too_large", "The request body is too large");
      let body: Record<string, unknown>;
      try { body = JSON.parse(text); } catch { return fail(400, "invalid_json", "The body is not JSON"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "invalid_request", "The body is a JSON object");
      const action = body.action as HandlerAction;
      if (!ACTIONS.has(action)) fail(400, "invalid_request", `action is one of ${[...ACTIONS].join(", ")}`);
      const thread = body.thread ?? null;
      if (thread !== null && (typeof thread !== "string" || !thread || thread.length > 200)) fail(400, "invalid_request", "thread is a string of 1 to 200 characters");
      const auth = checked(await options.authorize(request, { thread: thread as string | null, action }));
      return respond(200, await handle(request, body, auth, action, thread as string | null), origin);
    } catch (error) {
      if (error instanceof Response) {
        const headers = new Headers(error.headers);
        for (const [name, value] of Object.entries(cors(origin))) headers.set(name, value);
        return new Response(error.body, { status: error.status, statusText: error.statusText, headers });
      }
      if (error instanceof HandlerError) return respond(error.status, { error: { code: error.code, message: error.message } }, origin);
      // The browser went away mid-read: nobody to answer.
      if (request.signal?.aborted) return new Response(null, { status: 499 });
      console.error("[agent handler]", error);
      return respond(500, { error: { code: "internal_error", message: "The agent handler failed" } }, origin);
    }
  }) as AgentHandler;
  handler.close = async () => {
    clearInterval(sweeper);
    sweeper = undefined;
    const entries = [...cache.values()];
    cache.clear();
    await Promise.all(entries.map(pending => pending.then(entry => entry.attached?.close(), () => {}).catch(() => {})));
  };
  return handler;
}

function codeFor(status: number): string {
  switch (status) {
    case 400: return "invalid_request";
    case 401: return "unauthorized";
    case 403: return "forbidden";
    case 404: return "not_found";
    case 409: return "conflict";
    case 429: return "rate_limited";
    default: return status >= 500 ? "runtime_error" : "request_failed";
  }
}

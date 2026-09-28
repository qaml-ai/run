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
 * as is; Express and node:http with `nodeListener(handler)` from "@camelai/agent-runtime/node".
 */
import { Agents, type Agent, type AgentConfig } from "./agents.ts";
import { AgentError, DEFAULT_URL, type CreateAgentOptions, type Sender } from "./typescript.ts";

const env = (name: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] || undefined;

/** Who is asking, as your `authorize` found: the user, and optionally which of their agents. */
export interface AgentAuth {
  /** Your user's id: the agent's `subject`, and `from.id` on everything this user sends or answers. */
  userId: string;
  /** Their display name, shown to the model and in the transcript as the sender's. */
  name?: string;
  /**
   * The agent to use (1 to 80 letters, digits, `_` and `-`). Default: `agentKeyFor(userId, thread)`, one
   * agent per user and thread. Give your own to share an agent between users (a team's agent, say).
   */
  agentKey?: string;
}

/** What an agent is made with: the parts of `AgentConfig` a handler sets. Its `subject` is always the user. */
export type AgentSetup = Pick<AgentConfig,
  "model" | "instructions" | "tools" | "mcp" | "definition" | "thinkingLevel" | "context" | "keyScope" | "spendLimit" | "modelHeaders" | "mounts" | "name">;

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
  /** The runtime's origin. Default: CAMELAI_BASE_URL, else https://agents.camelai.dev. */
  url?: string;
  /**
   * Your own session check, on every request. Return the user (and optionally which agent), or null to
   * refuse it (401). `thread` is the browser's name for a conversation: untrusted, and never an agent id.
   */
  authorize(request: Request, context: { thread: string | null; action: HandlerAction }): A | null | Promise<A | null>;
  /** How the user's agent is made (on first use), and set again when this changes. A function gets the user. */
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
  /** How long an agent with tools served from this process stays attached after its last use. Default 15 minutes. */
  idleMs?: number;
  fetch?: typeof globalThis.fetch;
}

export type HandlerAction = "token" | "send" | "answer" | "stop" | "link";
const ACTIONS = new Set<HandlerAction>(["token", "send", "answer", "stop", "link"]);

/** The route: a fetch handler. `close()` detaches agents whose tools this process serves. */
export type AgentHandler = ((request: Request) => Promise<Response>) & { close(): Promise<void> };

const KEY = /^[A-Za-z0-9_-]{1,80}$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,80}$/;
const INPUT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_BODY = 1024 * 1024;
const MAX_CACHED = 5000;

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
  async function call(path: string, body: unknown, token = apiKey!): Promise<any> {
    let response: Response;
    try {
      response = await doFetch(url + path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "manual" });
    } catch (error) { return fail(502, "runtime_unreachable", `Could not reach the agent runtime: ${(error as Error).message}`); }
    const value = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
    if (response.ok) return value;
    const message = typeof value.error === "string" ? value.error : `HTTP ${response.status}`;
    const code = typeof value.code === "string" ? value.code : /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1] ?? codeFor(response.status);
    return fail(response.status >= 500 ? 502 : response.status, code, message);
  }

  async function upsert(key: string, setup: AgentSetup, auth: A): Promise<Cached> {
    const config: AgentConfig = { ...setup, subject: auth.userId };
    const serves = !!setup.mcp || Object.keys(setup.tools ?? {}).length > 0;
    try {
      if (serves) {
        // Tools served from this process: the agent stays attached while it is used, and a while after.
        const agent = await runtime().upsert(key, { ...config, takeover: true, onEvent: () => { touch(key); } });
        startSweeper();
        return { id: agent.id, token: agent.session.token, fingerprint: fingerprintOf(setup), attached: agent, used: Date.now() };
      }
      const { instructions, ...rest } = config;
      const created: CreateAgentOptions = { ...rest as CreateAgentOptions, ...(instructions !== undefined ? { systemPrompt: instructions } : {}) };
      const { session } = await runtime().runtime.upsertAgent(key, created);
      return { id: session.id, token: session.token, fingerprint: fingerprintOf(setup), used: Date.now() };
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

  async function handle(request: Request, body: Record<string, unknown>, auth: A, action: HandlerAction, thread: string | null): Promise<unknown> {
    const agent = await agentFor(auth, thread);
    const path = `/v1/agents/${encodeURIComponent(agent.id)}`;
    const from: Sender = { id: auth.userId, ...(auth.name ? { name: auth.name } : {}) };
    switch (action) {
      case "token": {
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
        let metadata: Record<string, string> | undefined;
        const changed = await options.onSend?.({ auth, thread, text: text as string, data: body.data, request });
        if (changed?.text !== undefined) text = changed.text;
        if (changed?.metadata) metadata = changed.metadata;
        const accepted = await call(`${path}/prompt`, {
          text, requestId: clientId, from, ...(metadata ? { metadata } : {}), ...(whileRunning ? { whileRunning } : {}),
        });
        return { requestId: accepted.id, state: accepted.state, ...(accepted.steeredInto ? { steeredInto: accepted.steeredInto } : {}) };
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
        if (typeof file !== "string" || !file || file.length > 1024) fail(400, "invalid_request", "path must be a file's path");
        const sign = (entry: Cached) => call(`/clients/${encodeURIComponent(entry.id)}/links`, { path: file, method: "GET" }, entry.token);
        // The agent's own token signs it (so only its mounts are reachable); an expired one is renewed once.
        const link = await sign(agent).catch(async error => {
          if (!(error instanceof HandlerError) || error.status !== 401) throw error;
          return sign(await agentFor(auth, thread, true));
        });
        return { url: link.url, expiresAt: link.expiresAt };
      }
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
      return new Response(null, { status: 204, headers: { ...cors(origin), "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "86400" } });
    }
    try {
      if (request.method !== "POST") fail(405, "method_not_allowed", "POST a JSON body");
      // Only JSON (a form on another site cannot post it), and only from this site unless allowed.
      if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) fail(415, "unsupported_media_type", "Send Content-Type: application/json");
      const site = request.headers.get("sec-fetch-site");
      if ((site === "cross-site" || site === "same-site") && !(origin && allowed.has(origin))) fail(403, "forbidden_origin", "This route takes requests from its own site; list other origins in allowedOrigins");
      const text = await request.text();
      if (text.length > MAX_BODY) fail(413, "too_large", "The request body is too large");
      let body: Record<string, unknown>;
      try { body = JSON.parse(text); } catch { return fail(400, "invalid_json", "The body is not JSON"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "invalid_request", "The body is a JSON object");
      const action = body.action as HandlerAction;
      if (!ACTIONS.has(action)) fail(400, "invalid_request", `action is one of ${[...ACTIONS].join(", ")}`);
      const thread = body.thread ?? null;
      if (thread !== null && (typeof thread !== "string" || !thread || thread.length > 200)) fail(400, "invalid_request", "thread is a string of 1 to 200 characters");
      const auth = await options.authorize(request, { thread: thread as string | null, action });
      if (!auth) fail(401, "unauthorized", "Sign in first");
      if (typeof auth!.userId !== "string" || !auth!.userId) fail(500, "invalid_auth", "authorize returned no userId");
      return respond(200, await handle(request, body, auth!, action, thread as string | null), origin);
    } catch (error) {
      if (error instanceof Response) {
        const headers = new Headers(error.headers);
        for (const [name, value] of Object.entries(cors(origin))) headers.set(name, value);
        return new Response(error.body, { status: error.status, statusText: error.statusText, headers });
      }
      if (error instanceof HandlerError) return respond(error.status, { error: { code: error.code, message: error.message } }, origin);
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

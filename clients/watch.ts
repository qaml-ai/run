/**
 * Watch one agent from a browser (or any runtime with `fetch`): its messages as they stream, the
 * running turn, tool progress, pending inputs and older history, with a browser token your server
 * mints (`POST /v1/agents/:id/browser-tokens`). No Node APIs and no dependencies.
 *
 * ```ts
 * import { watchAgent } from "@camelai/run/watch";
 * const watcher = watchAgent({ url, agentId, token, getToken: () => fetch("/api/token").then(r => r.json()), onChange: render });
 * ```
 */
import type { AgentEvent, AssistantMessage, Message } from "./types.ts";
import type { AgentInput } from "./typescript.ts";
export type * from "./types.ts";

/** A token and when it expires (ms); `getToken` may answer either. */
export type BrowserToken = { token: string; expiresAt?: number };
export interface WatchOptions {
  /** The runtime's URL (a browser token's `url`). */
  url: string;
  agentId: string;
  /** A browser token for the agent, and when it expires. */
  token: string;
  expiresAt?: number;
  /**
   * A new token from your server: called before the current one expires, and when the runtime refuses it
   * (401). Without it the watcher stops once the token expires, with `state.expired` set.
   */
  getToken?: () => Promise<BrowserToken | string>;
  /** Called after every change to `state`. */
  onChange?: (state: AgentView) => void;
  /** Every event as it arrives (Pi's, and the runtime's own), after `state` took it in. */
  onEvent?: (event: AgentEvent) => void;
  onError?: (error: Error) => void;
  /** "auto" (default): an SSE stream, and long polls where streams fail; or only one of them. */
  transport?: "auto" | "sse" | "poll";
  /** Messages a history page asks for (default 50). */
  pageSize?: number;
  /** A stream that delivers nothing (not even a heartbeat) this long is cut (default 35 s); two such, and it polls. */
  stallMs?: number;
  /** Close the stream while the page is hidden, after this long (default 30 s; 0: never). */
  hiddenGraceMs?: number;
  fetch?: typeof fetch;
}
/** What a watcher knows of its agent. */
export interface AgentView {
  /**
   * The agent's messages, oldest first, each at its index in the agent's history (`indexes`). A user
   * message carries its `requestId` and the application's `metadata`, to match a bubble shown before it arrived.
   */
  messages: (Message & { requestId?: string; metadata?: Record<string, string> })[];
  indexes: number[];
  /** The assistant message streaming now, folded from its deltas (tool arguments as partial JSON). */
  partial: AssistantMessage | null;
  /** The latest progress of each tool call still running, by tool call id. */
  progress: Map<string, unknown>;
  /** Whether a turn runs. */
  running: boolean;
  /** Human input the agent waits on. */
  pendingInputs: AgentInput[];
  /** How the latest run ended. */
  lastOutcome: { id: string; stopped?: string; error?: string } | null;
  /** Whether older history is there to load (`loadOlder`). */
  hasOlder: boolean;
  transport: "sse" | "poll" | null;
  connected: boolean;
  /** The token expired (or was refused) and could not be renewed: the watcher has stopped. Watch again with a new one. */
  expired: boolean;
}
export interface Watcher {
  readonly state: AgentView;
  /** Load the page of history before the oldest message held; false when there is none. */
  loadOlder(): Promise<boolean>;
  close(): void;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * JSON that may be cut off (a tool call's arguments as they stream), as far as it goes: open strings,
 * arrays and objects are closed, and a dangling key, comma or partial literal is left out.
 */
export function parsePartialJson(text: string): any {
  try { return JSON.parse(text); } catch { /* cut off */ }
  // One pass to find what is open, one repair, one parse: linear in the text, however it is cut.
  const repaired = repair(text);
  if (repaired !== undefined) {
    try { return JSON.parse(repaired.text); } catch { /* something in it is not JSON */ }
    // Leave out the member being written (an escape JSON does not allow, say), once.
    if (repaired.retry !== undefined) try { return JSON.parse(repaired.retry); } catch { /* give up */ }
  }
  return {};
}

type Frame = { close: "}" | "]"; state: "key" | "colon" | "value" | "after"; member: number };
/** `text` closed where it was cut, and (for a retry) closed before the member it was writing. */
function repair(text: string): { text: string; retry?: string } | undefined {
  const stack: Frame[] = [];
  let string: { start: number; key: boolean } | null = null, escaped = false;
  let token: number | null = null;
  const settle = () => { const frame = stack.at(-1); if (frame) frame.state = frame.state === "key" ? "colon" : "after"; };
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (string) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") { string = null; settle(); }
      continue;
    }
    if (token !== null) {
      if (/[\w.+-]/.test(char)) continue;
      token = null;
      settle();
    }
    if (char === " " || char === "\n" || char === "\r" || char === "\t") continue;
    const frame = stack.at(-1);
    if (char === "{" || char === "[") stack.push({ close: char === "{" ? "}" : "]", state: char === "{" ? "key" : "value", member: at + 1 });
    else if (char === "}" || char === "]") { stack.pop(); settle(); }
    else if (char === ":") { if (frame) frame.state = "value"; }
    else if (char === ",") { if (frame) { frame.state = frame.close === "}" ? "key" : "value"; frame.member = at; } }
    else if (char === "\"") string = { start: at, key: frame?.close === "}" && frame.state === "key" };
    else token = at;
  }
  const frame = stack.at(-1);
  const closers = () => stack.map(open => open.close).reverse().join("");
  const before = (at: number) => text.slice(0, at).replace(/\s+$/, "");
  let out: string;
  if (string) {
    if (!frame) return undefined;
    // A key being written is left out; a value being written is closed (without a dangling escape).
    if (string.key) out = before(frame.member);
    else out = `${escaped ? text.slice(0, -1) : text}"`;
  } else if (token !== null) {
    const word = text.slice(token);
    // A number is kept as far as it is one (-2. is -2); a literal only whole.
    const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(word)?.[0];
    if (/^(true|false|null)$/.test(word)) out = text;
    else if (number) out = text.slice(0, token) + number;
    else if (frame?.close === "}") out = `${before(token)}null`;
    else if (frame) out = before(frame.member);
    else return undefined;
  } else if (frame) {
    const trimmed = before(text.length);
    if (frame.state === "colon") out = before(frame.member);
    else if (frame.state === "value" && frame.close === "}") out = `${trimmed}null`;
    else if (trimmed.endsWith(",")) out = trimmed.slice(0, -1);
    else out = trimmed;
  } else return undefined;
  return { text: out + closers(), ...(frame ? { retry: before(frame.member) + closers() } : {}) };
}

/** Fold one delta into the message it updates (a copy); `json` keeps each tool call's argument text. */
function fold(message: any, delta: any, json: Map<number, string>) {
  const content = [...message.content];
  const at = delta.contentIndex;
  const block = content[at];
  switch (delta.type) {
    case "text_start": content[at] = { type: "text", text: "" }; break;
    case "text_delta": content[at] = { ...block, type: "text", text: (block?.text ?? "") + delta.delta }; break;
    case "text_end": content[at] = { ...block, type: "text", text: delta.content }; break;
    case "thinking_start": content[at] = { type: "thinking", thinking: "" }; break;
    case "thinking_delta": content[at] = { ...block, type: "thinking", thinking: (block?.thinking ?? "") + delta.delta }; break;
    case "thinking_end": content[at] = { ...block, type: "thinking", thinking: delta.content }; break;
    case "toolcall_start": json.set(at, ""); content[at] = { type: "toolCall", id: delta.id ?? "", name: delta.name ?? "", arguments: {} }; break;
    case "toolcall_delta": {
      const text = (json.get(at) ?? "") + delta.delta;
      json.set(at, text);
      content[at] = { ...block, type: "toolCall", arguments: parsePartialJson(text) };
      break;
    }
    case "toolcall_end": json.delete(at); content[at] = delta.toolCall; break;
    default: return message;
  }
  return { ...message, content };
}

/** Watch an agent: see `WatchOptions` and `AgentView`. */
export function watchAgent(options: WatchOptions): Watcher {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = `${options.url.replace(/\/+$/, "")}/v1/agents/${encodeURIComponent(options.agentId)}`;
  const pageSize = options.pageSize ?? 50;
  let token = options.token, expiresAt = options.expiresAt;
  const closed = new AbortController();
  const messages = new Map<number, Message>();
  const state: AgentView = { messages: [], indexes: [], partial: null, progress: new Map(), running: false, pendingInputs: [], lastOutcome: null, hasOlder: false, transport: null, connected: false, expired: false };
  /** Where the page older than those held ends (its `before`); null: there is none; undefined: no page yet. */
  let before: number | null | undefined;
  /** The index the next finished message takes, once the stream has said (a run's start, or a snapshot). */
  let next: number | undefined;
  let cursor = 0;
  let json = new Map<number, string>();
  let stream: AbortController | undefined;

  const changed = () => {
    const indexes = [...messages.keys()].sort((a, b) => a - b);
    state.indexes = indexes;
    state.messages = indexes.map(index => messages.get(index)!);
    state.hasOlder = !!before;
    options.onChange?.(state);
  };
  const report = (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error)));

  async function refresh() {
    if (!options.getToken) throw new Error("The browser token expired, and there is no getToken to renew it: pass watchAgent a getToken that fetches a new one from your server");
    const renewed = await options.getToken();
    token = typeof renewed === "string" ? renewed : renewed.token;
    expiresAt = typeof renewed === "string" ? undefined : renewed.expiresAt;
  }
  /** A read with the current token, renewed once on a 401. */
  async function get(path: string, init: RequestInit = {}, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try { response = await doFetch(base + path, { ...init, headers: { ...init.headers as Record<string, string>, Authorization: `Bearer ${token}` }, signal: signal ?? closed.signal }); }
      catch (error) {
        if ((signal ?? closed.signal).aborted || !(error instanceof TypeError)) throw error;
        // A browser says only "Failed to fetch" for a network failure and for a CORS refusal alike.
        throw new Error(`Could not reach the runtime at ${options.url} (${error.message}). In a browser this is also how a CORS refusal looks: the runtime allows any origin only for browser tokens (POST /v1/agents/:id/browser-tokens), never for an API key or an agent's own token; and check the url`, { cause: error });
      }
      if (response.status !== 401 || attempt || !options.getToken) return response;
      await response.body?.cancel();
      await refresh();
    }
  }
  const json200 = async (path: string) => {
    const response = await get(path);
    if (!response.ok) throw Object.assign(new Error(`${path}: HTTP ${response.status}`), { status: response.status });
    return response.json();
  };
  /** Whether the token reads history: until a 403 says not, when the watcher goes on with the stream alone. */
  let readsHistory = true;
  async function historyRead(path: string) {
    if (!readsHistory) return undefined;
    try { return await json200(path); }
    catch (error) {
      if ((error as { status?: number }).status !== 403) throw error;
      readsHistory = false;
      before = null;
      return undefined;
    }
  }

  /** Take in a page of history: its messages by index, and (for the first, or an older one) where the next older page ends. */
  function page(value: { entries: { index: number; message: Message }[]; next: number | null }, older = false) {
    for (const { index, message } of value.entries) messages.set(index, message);
    if (older || before === undefined) before = value.next;
  }
  async function newest() {
    const value = await historyRead(`/history?limit=${pageSize}`);
    if (value) page(value);
  }

  /** Take in one frame of the stream. */
  async function receive(data: any) {
    if (data.type === "snapshot") {
      // Where the stream could not replay: the running turn as of now, and the settled history before it.
      const turn = data.turn;
      state.running = !!turn;
      state.partial = turn?.partial ?? null;
      json = new Map();
      state.progress = new Map();
      if (turn?.start !== null && turn?.start !== undefined) {
        // What the run finished: all of it, unless it was too large to send (then from history, read below).
        next = turn.start + (turn.count ?? turn.messages.length);
        for (const [offset, message] of turn.messages.entries()) messages.set(turn.start + offset, message);
      } else next = undefined;
      await newest();
      // No turn in it: none runs, or the token does not show it. Its state says which, where the token reads it: read
      // after history, so a run that began in between is running here too, never a message in history with no turn.
      if (!turn) {
        const known = await json200("/state").catch(() => undefined) as { requests?: { method: string; state: string; began?: number }[] } | undefined;
        state.running = !!known?.requests?.some(request => request.state === "running" && request.began && ["prompt", "continue", "resume"].includes(request.method));
      }
      return;
    }
    if (data.type === "response") {
      state.lastOutcome = { id: data.id, ...(data.outcome?.stopped ? { stopped: data.outcome.stopped } : data.outcome?.result?.stopped ? { stopped: data.outcome.result.stopped } : {}), ...(data.outcome?.error ? { error: data.outcome.error } : {}) };
      state.running = false;
      state.partial = null;
      return;
    }
    if (data.type !== "event") return;
    const event = data.event;
    switch (event.type) {
      case "turn_opened": next = event.index; state.running = true; break;
      case "agent_start": state.running = true; break;
      case "agent_end": state.running = false; break;
      case "message_start":
        if (event.message?.role === "assistant") { state.partial = event.message; json = new Map(); }
        break;
      case "message_update":
        if (state.partial) state.partial = fold(state.partial, event.assistantMessageEvent, json);
        break;
      case "message_end":
        if (event.message?.role === "assistant") state.partial = null;
        if (next !== undefined) messages.set(next++, event.message);
        break;
      // A response taken back (before a retry, or a compaction on overflow) gives up its place.
      case "message_retracted":
        messages.delete(event.index);
        if (next !== undefined) next = event.index;
        break;
      // A message too large for the stream still takes its place; the newest page of history has it.
      case "event_omitted":
        if (event.was === "message_end" && next !== undefined) { next++; void newest().then(changed, report); }
        break;
      case "tool_execution_update": state.progress.set(event.toolCallId, event.partialResult); break;
      case "tool_execution_end": state.progress.delete(event.toolCallId); break;
      case "input_required": state.pendingInputs = [...state.pendingInputs.filter(input => input.id !== event.input.id), event.input]; break;
      case "input_resolved": state.pendingInputs = state.pendingInputs.filter(input => input.id !== event.id); break;
    }
    options.onEvent?.(event);
  }

  /** One SSE stream until it ends; true when it delivered anything (so streams work here). */
  async function sse(signal: AbortSignal): Promise<boolean> {
    const response = await get("/events?snapshot=1", { headers: { Accept: "text/event-stream", ...(cursor ? { "Last-Event-ID": String(cursor) } : {}) } }, signal);
    if (!response.ok || !response.body) throw Object.assign(new Error(`events: HTTP ${response.status}`), { status: response.status });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", delivered = false, watchdog: ReturnType<typeof setTimeout> | undefined;
    const touch = () => { clearTimeout(watchdog); watchdog = setTimeout(() => void reader.cancel().catch(() => {}), options.stallMs ?? 35_000); };
    touch();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return delivered;
        touch();
        buffer += decoder.decode(value, { stream: true });
        for (let end; (end = buffer.indexOf("\n\n")) !== -1;) {
          const lines = buffer.slice(0, end).split("\n");
          buffer = buffer.slice(end + 2);
          const text = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!text) continue;
          delivered = true;
          if (lines.includes("event: ready")) { state.connected = true; state.transport = "sse"; changed(); continue; }
          const id = Number(lines.find(line => line.startsWith("id:"))?.slice(3));
          await receive(JSON.parse(text));
          if (Number.isSafeInteger(id) && id > 0) cursor = id;
          changed();
        }
      }
    } finally { clearTimeout(watchdog); reader.releaseLock(); }
  }

  /** One long poll. */
  async function poll(signal: AbortSignal) {
    const response = await get("/events?poll=1&wait=25&snapshot=1", { headers: cursor ? { "Last-Event-ID": String(cursor) } : {} }, signal);
    if (!response.ok) throw Object.assign(new Error(`events: HTTP ${response.status}`), { status: response.status });
    const answer = await response.json() as { cursor: number; events: { id: number; data: unknown }[] };
    state.connected = true;
    state.transport = "poll";
    for (const event of answer.events) await receive(event.data);
    cursor = answer.cursor;
    changed();
  }

  async function run() {
    state.pendingInputs = await json200("/inputs?state=pending").catch(error => { report(error); return []; });
    let mode: "sse" | "poll" = options.transport === "poll" ? "poll" : "sse";
    let failures = 0, backoff = 500;
    while (!closed.signal.aborted) {
      await visible();
      if (closed.signal.aborted) break;
      stream = new AbortController();
      const signal = AbortSignal.any([closed.signal, stream.signal]);
      // Renew a token about to expire; its stream would end then anyway.
      if (expiresAt !== undefined && options.getToken && expiresAt - Date.now() < 60_000) await refresh().catch(report);
      try {
        if (mode === "sse") {
          const delivered = await sse(signal);
          failures = delivered ? 0 : failures + 1;
          state.connected = false;
        } else await poll(signal);
        backoff = 500;
      } catch (error) {
        if (closed.signal.aborted) break;
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403 || status === 404) {
          if (status === 401) {
            state.expired = true;
            report(new Error(options.getToken ? "The runtime refused the renewed browser token; the watcher stopped" : "The browser token expired, and there is no getToken to renew it; the watcher stopped (state.expired)"));
          } else report(error);
          state.connected = false; changed(); break;
        }
        if (!stream.signal.aborted) { report(error); failures++; }
        state.connected = false;
        changed();
        await sleep(backoff, closed.signal);
        backoff = Math.min(backoff * 2, 30_000);
      }
      // Streams that end or fail without delivering anything (a proxy that buffers them): poll instead.
      if (mode === "sse" && options.transport !== "sse" && failures >= 2) mode = "poll";
    }
  }

  /** Wait while the page is hidden (after a grace period, the stream is closed). */
  let hidden: (() => void) | undefined;
  const doc = (globalThis as { document?: { visibilityState?: string; addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void } }).document;
  const grace = options.hiddenGraceMs ?? 30_000;
  let hiding: ReturnType<typeof setTimeout> | undefined;
  const onVisibility = () => {
    if (doc?.visibilityState === "hidden") { if (grace > 0) hiding = setTimeout(() => stream?.abort(), grace); }
    else { clearTimeout(hiding); hidden?.(); }
  };
  doc?.addEventListener("visibilitychange", onVisibility);
  const visible = () => doc?.visibilityState === "hidden" && grace > 0 ? new Promise<void>(resolve => { hidden = resolve; closed.signal.addEventListener("abort", () => resolve(), { once: true }); }) : Promise.resolve();

  void run().catch(report);
  return {
    state,
    async loadOlder() {
      if (!before) return false;
      const value = await historyRead(`/history?limit=${pageSize}&before=${before}`);
      if (!value) return false;
      page(value, true);
      changed();
      return true;
    },
    close() {
      closed.abort();
      clearTimeout(hiding);
      doc?.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

/**
 * Watch one agent from a browser (or any runtime with `fetch`): its messages as they stream, the
 * running turn, tool progress, pending inputs and older history, with a browser token your server
 * mints (`POST /v1/agents/:id/browser-tokens`). No Node APIs and no dependencies.
 *
 * ```ts
 * import { watchAgent } from "@camelai/agent-runtime/watch";
 * const watcher = watchAgent({ url, agentId, token, getToken: () => fetch("/api/token").then(r => r.json()), onChange: render });
 * ```
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** A token and when it expires (ms); `getToken` may answer either. */
export type BrowserToken = { token: string; expiresAt?: number };
export interface WatchOptions {
  /** The runtime's URL (a browser token's `url`). */
  url: string;
  agentId: string;
  /** A browser token for the agent, and when it expires. */
  token: string;
  expiresAt?: number;
  /** A new token: called before the current one expires, and when the runtime refuses it (401). */
  getToken?: () => Promise<BrowserToken | string>;
  /** Called after every change to `state`. */
  onChange?: (state: AgentView) => void;
  /** Every event as it arrives (Pi's, and the runtime's own), after `state` took it in. */
  onEvent?: (event: any) => void;
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
  /** The agent's messages, oldest first, each at its index in the agent's history (`indexes`). */
  messages: AgentMessage[];
  indexes: number[];
  /** The assistant message streaming now, folded from its deltas (tool arguments as partial JSON). */
  partial: AssistantMessage | null;
  /** The latest progress of each tool call still running, by tool call id. */
  progress: Map<string, unknown>;
  /** Whether a turn runs. */
  running: boolean;
  /** Human input the agent waits on. */
  pendingInputs: any[];
  /** How the latest run ended. */
  lastOutcome: { id: string; stopped?: string; error?: string } | null;
  /** Whether older history is there to load (`loadOlder`). */
  hasOlder: boolean;
  transport: "sse" | "poll" | null;
  connected: boolean;
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
  for (let end = text.length; end > 0; end--) {
    const closed = close(text.slice(0, end));
    if (closed === undefined) continue;
    try { return JSON.parse(closed); } catch { /* shorter */ }
  }
  return {};
}
function close(text: string): string | undefined {
  const stack: string[] = [];
  let string = false, escaped = false;
  for (const char of text) {
    if (string) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") string = false;
    } else if (char === "\"") string = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") stack.pop();
  }
  if (escaped) return undefined;
  let out = string ? `${text}"` : text;
  out = out.replace(/\s+$/, "");
  if (/[,:]$/.test(out)) out = out.endsWith(":") ? `${out}null` : out.slice(0, -1);
  // A key with no value yet ({"a": 1, "b"}): leave it out.
  if (stack.at(-1) === "}" && /[{,]\s*"(?:[^"\\]|\\.)*"$/.test(out)) out = out.replace(/,?\s*"(?:[^"\\]|\\.)*"$/, "");
  return out + stack.reverse().join("");
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
  const messages = new Map<number, AgentMessage>();
  const state: AgentView = { messages: [], indexes: [], partial: null, progress: new Map(), running: false, pendingInputs: [], lastOutcome: null, hasOlder: false, transport: null, connected: false };
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
    if (!options.getToken) throw new Error("The browser token expired, and there is no getToken to renew it");
    const renewed = await options.getToken();
    token = typeof renewed === "string" ? renewed : renewed.token;
    expiresAt = typeof renewed === "string" ? undefined : renewed.expiresAt;
  }
  /** A read with the current token, renewed once on a 401. */
  async function get(path: string, init: RequestInit = {}, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(base + path, { ...init, headers: { ...init.headers as Record<string, string>, Authorization: `Bearer ${token}` }, signal: signal ?? closed.signal });
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
  function page(value: { entries: { index: number; message: AgentMessage }[]; next: number | null }, older = false) {
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
      // A failed response is taken back before the model is asked again: it gives up its place.
      case "auto_retry_start":
        if (next !== undefined && (messages.get(next - 1) as any)?.stopReason === "error") messages.delete(--next);
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
        if (status === 401 || status === 403 || status === 404) { report(error); state.connected = false; changed(); break; }
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

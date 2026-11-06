import {createServer} from "node:http";
import {once} from "node:events";
import { openEventStream } from "../../clients/event-transport.ts";
import { pollingAttempt, observeMissingStream, observePollingFailure, terminalRequestStates, type PollingOptions } from "./polling.ts";

export type T = { after(fn: () => Promise<void> | void): void };
export const OPERATOR = "fixture-operator-token-at-least-24-chars";
export const OTHER_OPERATOR = "other-operator-token-at-least-24-chars";
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wait, if the clock is less than `marginMs` from the end of a fixed rate-limit window of `windowSeconds`, for the next
 * one to start. The runtime's fixed windows align to the clock (UTC), and a count that crosses into the next window
 * starts again from nothing: a test that counts up to a limit and expects a refusal would see none.
 */
export async function freshWindow(windowSeconds: number, marginMs: number) {
  const windowMs = windowSeconds * 1000, left = windowMs - Date.now() % windowMs;
  if (left < marginMs) await sleep(left + 200);
}

export async function until<V>(check: () => V | Promise<V>, what: string, timeoutMs = 15_000, options: PollingOptions = {}): Promise<Exclude<V, false | 0 | "" | null | undefined>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Keep the original one-await scheduling. Extra promise continuations here
    // can race an SDK stream's close signal against its final teardown.
    const attempt = pollingAttempt(check, what, options);
    const value = attempt.finish(await attempt.result);
    if (value) return value as Exclude<V, false | 0 | "" | null | undefined>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Terminal request states cannot transition to a different requested state. */
export function untilRequestState<V extends { state: string }>(read: () => V | Promise<V>, state: string, what: string, timeoutMs = 15_000) {
  return until(async () => {
    const value = await read();
    if (value.state === state) return value;
    if (terminalRequestStates.has(value.state)) throw new Error(`Cannot wait for ${what}: request reached terminal state ${value.state}, expected ${state}`);
    return false;
  }, what, timeoutMs);
}

export async function listen(t: T, handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/**
 * `respond` with each answer free on OpenRouter (its own cost 0, a token each way) unless it gives usage: a response on
 * the platform's key that reports none is charged an estimate.
 */
export const free = (respond: (body: any, index: number) => object) => (body: any, index: number) => {
  const answer = respond(body, index) as { usage?: unknown };
  return answer.usage ? answer : { ...answer, usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } };
};

/**
 * An OpenAI-compatible model that answers each request with `respond`'s message delta. A delta's
 * `usage` (prompt_tokens, completion_tokens) is reported with the last chunk, and `delayMs` holds the answer back.
 * `httpStatus` (with `message`) answers with that error instead.
 */
export async function fakeModel(t: T, respond: (body: any, index: number) => object) {
  const bodies: any[] = [];
  /** The Authorization header of each request: which key the agent called with. */
  const keys: string[] = [];
  const headers: Record<string, string | string[] | undefined>[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    try { for await (const chunk of req) text += chunk; }
    catch (error) {
      // Cancelling a model call can close its upload before the body is complete.
      if (req.destroyed && !req.complete && (error as NodeJS.ErrnoException).code === "ECONNRESET") return;
      throw error;
    }
    const body = JSON.parse(text);
    bodies.push(body);
    keys.push(req.headers.authorization ?? "");
    headers.push(req.headers);
    // `wait`: a promise the answer waits for (a barrier between concurrent calls), before any `delayMs`.
    const { usage, delayMs, httpStatus, wait, ...delta } = respond(body, bodies.length - 1) as any;
    if (wait) await wait;
    if (delayMs) {
      // An aborted runtime request must not leave a fixture timer keeping the
      // test process alive after its server and sockets have closed.
      const connected = await new Promise<boolean>(resolve => {
        const finish = (open: boolean) => { clearTimeout(timer); res.off("close", closed); resolve(open); };
        const closed = () => finish(false);
        const timer = setTimeout(() => finish(true), delayMs);
        res.once("close", closed);
        if (res.destroyed) closed();
      });
      if (!connected) return;
    }
    // A provider refusing the request: `httpStatus` with an OpenAI-style error.
    if (httpStatus) { res.writeHead(httpStatus, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: delta.message ?? "Refused", type: "invalid_request_error" } })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [content, finish_reason] of [[delta, null], [{}, delta.tool_calls ? "tool_calls" : "stop"]]) {
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: content, finish_reason }], ...(finish_reason && usage ? { usage } : {}) })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  return { url: `${url}/v1`, bodies, keys, headers };
}
export const toolCall = (name: string, args: unknown, id = `call_${name}`) => ({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
export const lastUser = (body: any) => {
  const content = body.messages.filter((message: any) => message.role === "user").at(-1)?.content;
  return typeof content === "string" ? content : content.map((part: any) => part.text ?? "").join("");
};
export const toolResults = (body: any) => body.messages.filter((message: any) => message.role === "tool").map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join(""));

export const TEST_PASSWORD = "correct-horse-battery-staple";
/**
 * A console session for `tenant`, as a person gets one: `token` (the tenant's operator token, or the platform operator's)
 * gives it an email and password, and it signs in with them. Returns the `ar_session=...` cookie.
 */
export async function passwordSession(base: string, token: string, tenant: string, email = `${tenant}@example.test`, password = TEST_PASSWORD) {
  const set = await fetch(`${base}/v1/tenants/${tenant}/password`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!set.ok) throw new Error(`set password: ${set.status} ${await set.text()}`);
  const signIn = await fetch(`${base}/console/auth/password`, { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Runtime-Console": "1", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ email, password }) });
  if (!signIn.ok) throw new Error(`password sign-in: ${signIn.status} ${await signIn.text()}`);
  return signIn.headers.getSetCookie().find(value => value.startsWith("ar_session="))!.split(";")[0];
}

/**
 * An application attached to an agent that sets up its MCP session and never answers a tool
 * call: calls it gets stay in flight until they time out. `calls` collects them.
 */
export async function attachSilently(t: T, base: string, agent: string, token: string) {
  return attach(t, base, agent, token);
}

/**
 * An application attached to an agent over its MCP connection, answering each tool call with `answer` (if given):
 * `reply(result)` sends the call's result, `progress(n)` a progress notification for it. `calls` collects them.
 */
export async function attach(t: T, base: string, agent: string, token: string,
  answer?: (call: any, tools: { reply: (result: object) => Promise<unknown>; progress: (progress: number) => Promise<unknown> }) => void, query = "") {
  const stream = new AbortController();
  t.after(() => stream.abort());
  const headers = { Authorization: `Bearer ${token}` };
  const response = await openEventStream(fetch, `${base}/clients/${agent}/events${query}`, { headers, signal: stream.signal });
  const frames: string[] = [];
  const ended = Promise.withResolvers<void>();
  // A stalled application (a half-open connection, say) stops answering the runtime's pings.
  let stalled = false;
  if (!response.ok) {
    const body = await response.text(), calls: any[] = [];
    let json: unknown;
    try { json = JSON.parse(body); } catch { /* plain HTTP error */ }
    const observe = observeMissingStream(`${base}/clients/${agent}/events`, response.status, json);
    return { get calls() { observe(); return calls; }, status: response.status, body, get frames() { observe(); return frames; }, ended: ended.promise, close: () => stream.abort(), stall: () => {} };
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let connection = "";
  const calls: any[] = [];
  const initialized = Promise.withResolvers<void>();
  let streamEnded = false;
  const post = async (message: unknown) => {
    const result = await fetch(`${base}/clients/${agent}/mcp`, { method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Agent-Connection": connection }, body: JSON.stringify(message) });
    if (!result.ok) throw new Error(`Required MCP reply route returned HTTP ${result.status}`);
    return result;
  };
  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end; (end = buffer.indexOf("\n\n")) !== -1;) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          frames.push(frame);
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
          if (!data) continue;
          const event = JSON.parse(data);
          if (frame.includes("event: ready")) connection = event.connection;
          else if (event.type === "mcp" && event.message.method === "initialize") {
            await post({ jsonrpc: "2.0", id: event.message.id, result: { protocolVersion: event.message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "silent", version: "1" } } });
            initialized.resolve();
          } else if (event.type === "mcp" && event.message.method === "ping") {
            if (!stalled) await post({ jsonrpc: "2.0", id: event.message.id, result: {} });
          } else if (event.type === "mcp" && event.message.method === "tools/call") {
            const message = event.message;
            calls.push(message);
            answer?.(message, {
              reply: result => post({ jsonrpc: "2.0", id: message.id, result }),
              progress: progress => post({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: message.params._meta?.progressToken, progress } }),
            });
          }
        }
      }
    } catch (error) {
      initialized.reject(error);
    } finally {
      streamEnded = true;
      initialized.reject(new Error("Required MCP event stream ended before initialization"));
      ended.resolve();
    }
  })();
  await initialized.promise;
  const observe = () => { if (streamEnded) observePollingFailure("MCP event stream ended; no more calls or frames can arrive"); };
  return { get calls() { observe(); return calls; }, status: response.status, body: "", get frames() { observe(); return frames; }, ended: ended.promise, close: () => stream.abort(), stall: () => { stalled = true; } };
}

/**
 * A read-only subscriber of an agent's event stream (`?watch=1` unless `query` says otherwise):
 * `frames` collects what arrives, each with its id, `status` is the response's.
 */
export async function watchEvents(t: T, url: string, headers: Record<string, string>, options: { cursor?: number; query?: string } = {}) {
  const stream = new AbortController();
  t.after(() => stream.abort());
  const response = await openEventStream(fetch, `${url}?${options.query ?? "watch=1"}`, { headers: { ...headers, ...(options.cursor !== undefined ? { "Last-Event-ID": String(options.cursor) } : {}) }, signal: stream.signal });
  const frames: { id?: number; event?: string; data: any }[] = [];
  let ended = false;
  let errorBody: unknown;
  if (response.ok) void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body!) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        for (let end; (end = buffer.indexOf("\n\n")) !== -1; buffer = buffer.slice(end + 2)) {
          const lines = buffer.slice(0, end).split("\n");
          const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
          if (!data) continue;
          const id = lines.find(line => line.startsWith("id:"))?.slice(3).trim();
          const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
          frames.push({ ...(id ? { id: Number(id) } : {}), ...(event ? { event } : {}), data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
    ended = true;
  })();
  else {
    const text = await response.text();
    try { errorBody = JSON.parse(text); } catch { /* plain HTTP error */ }
    ended = true;
  }
  if (response.ok && response.headers.get("X-Agent-Transport") === "websocket") {
    await until(() => {
      if (ended) throw new Error("Event WebSocket ended before its ready frame");
      return frames.some(frame => frame.event === "ready");
    }, "the event WebSocket to be ready", 10_000);
  }
  const observe = observeMissingStream(url, response.status, errorBody);
  return { status: response.status, get frames() {
    observe();
    if (response.ok && ended) observePollingFailure("Event stream ended; no more frames can arrive");
    return frames;
  }, get ended() { return ended; }, close: () => stream.abort() };
}

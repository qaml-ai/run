import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testDatabase } from "./database.ts";

/** A runtime server process with a scripted model, for tests that go through the API. */
export type T = { after(fn: () => Promise<void> | void): void };
export const OPERATOR = "fixture-operator-token-at-least-24-chars";
export const OTHER_OPERATOR = "other-operator-token-at-least-24-chars";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function until<V>(check: () => V | Promise<V>, what: string, timeoutMs = 15_000): Promise<Exclude<V, false | 0 | "" | null | undefined>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as Exclude<V, false | 0 | "" | null | undefined>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

export async function listen(t: T, handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/**
 * An OpenAI-compatible model that answers each request with `respond`'s message delta. A delta's
 * `usage` (prompt_tokens, completion_tokens) is reported with the last chunk, and `delayMs` holds the answer back.
 */
export async function fakeModel(t: T, respond: (body: any, index: number) => object) {
  const bodies: any[] = [];
  /** The Authorization header of each request: which key the agent called with. */
  const keys: string[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    bodies.push(body);
    keys.push(req.headers.authorization ?? "");
    const { usage, delayMs, ...delta } = respond(body, bodies.length - 1) as any;
    if (delayMs) await sleep(delayMs);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [content, finish_reason] of [[delta, null], [{}, delta.tool_calls ? "tool_calls" : "stop"]]) {
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: content, finish_reason }], ...(finish_reason && usage ? { usage } : {}) })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  return { url: `${url}/v1`, bodies, keys };
}
export const toolCall = (name: string, args: unknown, id = `call_${name}`) => ({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
export const lastUser = (body: any) => {
  const content = body.messages.filter((message: any) => message.role === "user").at(-1)?.content;
  return typeof content === "string" ? content : content.map((part: any) => part.text ?? "").join("");
};
export const toolResults = (body: any) => body.messages.filter((message: any) => message.role === "tool").map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join(""));

/** `tenantsFile` replaces the tenants file (alice and bob, with admin keys). */
export async function runtime(t: T, respond: (body: any, index: number) => object, env: Record<string, string> = {}, tenantsFile?: object) {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-server-"));
  writeFileSync(join(root, "tenants.json"), JSON.stringify(tenantsFile ?? { tenants: {
    alice: { tokenSha256: sha(OPERATOR), apiKeys: { "*": "fixture-model-key" } },
    bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: { "*": "fixture-model-key" } },
  } }));
  const model = await fakeModel(t, respond);
  const { db, url: databaseUrl } = await testDatabase();
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    env: {
      PATH: process.env.PATH, HOME: root, AGENT_DATA_DIR: root, AGENT_DATABASE_URL: databaseUrl, PORT: "0", HOST: "127.0.0.1",
      ...(process.env.AGENT_HOSTING ? { AGENT_HOSTING: process.env.AGENT_HOSTING } : {}),
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "server-test-session-secret-with-32-chars",
      AGENT_SECRETS_KEY: randomBytes(32).toString("hex"), AGENT_PUBLIC_URL: "https://agents.example.test",
      AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: model.url, AGENT_SCHEDULER_INTERVAL_MS: "200", ...env,
    } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const logs: string[] = [];
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGTERM"); await closed; }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const ready = Promise.withResolvers<number>();
  let output = "";
  child.stdout.on("data", chunk => {
    output += chunk;
    const lines = output.split("\n");
    output = lines.pop()!;
    for (const line of lines) { if (!logs.length) ready.resolve(JSON.parse(line).address.port); logs.push(line); }
  });
  child.on("exit", code => ready.reject(new Error(`Server exited: ${code}`)));
  const base = `http://127.0.0.1:${await ready.promise}`;
  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; token?: string | null } = {}) => {
    const token = init.token === undefined ? OPERATOR : init.token;
    const response = await fetch(base + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text };
  };
  /** Prompt an agent over the REST API and wait for the outcome of its turn. */
  const prompt = async (agent: string, text: string, token?: string) => {
    const accepted = await call(`/v1/agents/${agent}/prompt`, { body: { text }, token });
    if (accepted.status !== 202) throw new Error(`prompt: ${accepted.status} ${accepted.text}`);
    return until(async () => {
      const record = (await call(`/v1/agents/${agent}/requests/${accepted.json.id}`, { token })).json;
      return record.state === "completed" && record;
    }, "the turn to end");
  };
  return { root, db, base, call, prompt, model, logs, child };
}

/**
 * An application attached to an agent that sets up its MCP session and never answers a tool
 * call: calls it gets stay in flight until they time out. `calls` collects them.
 */
export async function attachSilently(t: T, base: string, agent: string, token: string) {
  const stream = new AbortController();
  t.after(() => stream.abort());
  const headers = { Authorization: `Bearer ${token}` };
  const response = await fetch(`${base}/clients/${agent}/events`, { headers: { ...headers, Accept: "text/event-stream" }, signal: stream.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let connection = "";
  const calls: any[] = [];
  const initialized = Promise.withResolvers<void>();
  const post = (message: unknown) => fetch(`${base}/clients/${agent}/mcp`, { method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Agent-Connection": connection }, body: JSON.stringify(message) });
  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end; (end = buffer.indexOf("\n\n")) !== -1;) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
          if (!data) continue;
          const event = JSON.parse(data);
          if (frame.includes("event: ready")) connection = event.connection;
          else if (event.type === "mcp" && event.message.method === "initialize") {
            await post({ jsonrpc: "2.0", id: event.message.id, result: { protocolVersion: event.message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "silent", version: "1" } } });
            initialized.resolve();
          } else if (event.type === "mcp" && event.message.method === "tools/call") calls.push(event.message);
        }
      }
    } catch { /* the stream ended */ }
  })();
  await initialized.promise;
  return { calls };
}

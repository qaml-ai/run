import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { errorText } from "../protocol.ts";
import { validateDefinitions } from "../tool-policy.ts";
import { processLauncher, type Sandbox, type SandboxLauncher } from "./sandbox.ts";
import { staticToken, type ExecutorToken } from "./token.ts";

// A disconnect from the runtime normally ends an execution first; this is the backstop.
const GRACE_MS = 2_000;

type Execution = {
  executionId: string; code: string; tools: any[]; timeoutMs: number; maxOutputCharacters: number;
  callback: { url: string; token: string };
};

/**
 * Executor host: runs one model-written program per request in a fresh
 * sandbox (a gVisor sandbox per execution in production; see sandbox.ts) around
 * the code child (QuickJS/WASM, the same limits as local codemode), with no
 * credentials and no agent state. Guest tool calls go back to the runtime's
 * callback URL with the per-execution capability the runtime minted; the
 * runtime validates and dispatches them. Nothing here is trusted by the runtime.
 */
export function createExecutorServer(options: { token: string | ExecutorToken; maxConcurrent?: number; runtime?: string; launcher?: SandboxLauncher }) {
  const token = typeof options.token === "string" ? staticToken(options.token) : options.token;
  const launcher = options.launcher ?? processLauncher(options.runtime);
  const maxConcurrent = options.maxConcurrent ?? 8;
  let active = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, active })); return; }
    if (req.url !== "/execute") { res.writeHead(404).end(); return; }
    const presented = /^Bearer (\S{1,512})$/.exec(req.headers.authorization ?? "")?.[1];
    if (!presented || !await token.matches(presented)) { res.writeHead(401).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    if (active >= maxConcurrent) { res.writeHead(503).end(); return; }
    active++;
    try {
      let execution: Execution;
      try { execution = parse(await body(req, 2 * 1024 * 1024)); }
      catch (error) { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: errorText(error) })); return; }
      await run(execution, res, launcher);
    } finally { active--; }
  });
  server.requestTimeout = 30_000;
  return server;
}

async function run(execution: Execution, res: ServerResponse, launcher: SandboxLauncher) {
  const started = Date.now();
  let sandbox: Sandbox;
  try { sandbox = await launcher.launch(); }
  catch (error) { res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: errorText(error) })); return; }
  const { rpc } = sandbox;
  const calls = new AbortController();
  const kill = (reason: string) => { calls.abort(); rpc.close(reason); sandbox.kill(); };
  // The runtime owns the deadline and aborts by disconnecting; either way the sandbox dies.
  const timer = setTimeout(() => kill("Codemode timed out on the executor"), execution.timeoutMs + GRACE_MS);
  const disconnected = () => { if (!res.writableFinished) kill("Runtime disconnected"); };
  res.on("close", disconnected);
  if (res.destroyed) disconnected();
  const write = (message: unknown) => { if (!res.destroyed) res.write(`${JSON.stringify(message)}\n`); };
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
  rpc.onEvent = event => write({ type: "event", event });
  rpc.handler = async (method, params) => {
    if (method !== "tool") throw new Error("Unknown tool");
    return callback(execution.callback, { name: params.name, args: params.args }, calls.signal);
  };
  let outcome = "result";
  try {
    const { code, tools, timeoutMs, maxOutputCharacters } = execution;
    write({ type: "result", result: await rpc.request("execute", { code, tools, timeoutMs, maxOutputCharacters }) });
  } catch (error) {
    outcome = calls.signal.aborted ? "killed" : "error";
    write({ type: "error", error: errorText(error) });
  } finally {
    clearTimeout(timer);
    kill("Codemode completed");
    await sandbox.closed;
    res.end();
    console.log(JSON.stringify({ type: "execution", executionId: execution.executionId, sandbox: launcher.kind, outcome, ms: Date.now() - started }));
  }
}

async function callback(target: Execution["callback"], call: { name: unknown; args: unknown }, signal: AbortSignal) {
  const response = await fetch(target.url, {
    method: "POST", signal, redirect: "error",
    headers: { Authorization: `Bearer ${target.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(call),
  });
  const text = await response.text();
  let payload: any;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
  if (response.ok) return payload.result;
  throw new Error(typeof payload.error === "string" ? payload.error : `Tool callback rejected (${response.status})`);
}

function parse(value: any): Execution {
  if (!value || typeof value !== "object") throw new Error("Expected an execution");
  const { executionId, code, tools, timeoutMs, maxOutputCharacters, callback } = value;
  if (typeof executionId !== "string" || !/^[0-9a-f-]{36}$/.test(executionId)) throw new Error("Invalid executionId");
  if (typeof code !== "string" || code.length > 256_000) throw new Error("Invalid or oversized code");
  validateDefinitions(tools);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("timeoutMs must be 1..120000");
  if (!Number.isInteger(maxOutputCharacters) || maxOutputCharacters < 1 || maxOutputCharacters > 128_000) throw new Error("maxOutputCharacters must be 1..128000");
  if (!callback || typeof callback.token !== "string" || callback.token.length > 512 || typeof callback.url !== "string") throw new Error("Invalid callback");
  const url = new URL(callback.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Callback URL must be http(s)");
  return { executionId, code, tools, timeoutMs, maxOutputCharacters, callback: { url: url.href, token: callback.token } };
}

async function body(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    if ((size += chunk.length) > limit) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

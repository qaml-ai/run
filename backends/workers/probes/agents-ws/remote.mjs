import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const root = resolve(import.meta.dirname, "../.."), name = "camelrun-proto-agents-ws-1105", account = "85bbd288051330fb51ee1c86031a299b";
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("Cloudflare credential unavailable");
const bearer = randomBytes(32).toString("hex"), state = await mkdtemp(join(tmpdir(), "camelrun-agents-ws-"));
const report = { name, account: "camelAI", startedAt: new Date().toISOString(), operations: [], result: {}, cleanup: {} };
const path = join(root, "measurements/agents-ws-cloud.json");
try {
  const previous = JSON.parse(await readFile(path, "utf8"));
  report.previousAttempts = [...previous.previousAttempts ?? [], { startedAt: previous.startedAt, endedAt: previous.endedAt, error: previous.error, cleanup: previous.cleanup }];
} catch {}
const safe = value => JSON.stringify(value, null, 2).replaceAll(token, "[redacted]").replaceAll(bearer, "[redacted]");
const save = () => writeFile(path, safe(report) + "\n");
async function api(suffix, method = "GET", body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${suffix}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  if (!response.ok || value.success === false) throw new Error(`Cloudflare ${method} ${suffix}: HTTP ${response.status} ${safe(value.errors)}`);
  return value.result ?? value;
}
async function namespaces() {
  const result = [];
  for (let page = 1; page <= 20; page++) { const rows = await api(`/workers/durable_objects/namespaces?per_page=1000&page=${page}`); result.push(...rows); if (rows.length < 1000) break; }
  return result;
}
async function wrangler(args, input) {
  const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...args], { cwd: root, env: { ...process.env, WRANGLER_LOG_PATH: join(state, "logs"), WRANGLER_SEND_METRICS: "false" }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", value => output += value); child.stderr.on("data", value => output += value); child.stdin.end(input);
  const code = await new Promise(resolve => child.once("close", resolve));
  if (code !== 0) throw new Error(`Wrangler ${args[0]} failed (${code}): ${safe(output.slice(-4000))}`);
  report.operations.push({ command: args.join(" "), exitCode: code, ...(output.match(/Current Version ID: ([-a-f0-9]+)/)?.[1] ? { version: output.match(/Current Version ID: ([-a-f0-9]+)/)[1] } : {}) });
  await save();
}
let owned = false, deployed = false, socket, base;
const pending = new Set();
try {
  if ((await api("/workers/scripts")).some(worker => worker.id === name) || (await namespaces()).some(ns => ns.script === name)) throw new Error("Probe name already exists; refusing reuse");
  owned = true;
  report.preflight = { worker: false, namespace: false };
  base = `https://${name}.${(await api("/workers/subdomain")).subdomain}.workers.dev`;
  await wrangler(["deploy", "--dry-run", "-c", "probes/agents-ws/wrangler.jsonc"]);
  await wrangler(["deploy", "-c", "probes/agents-ws/wrangler.jsonc"]); deployed = true;
  await wrangler(["secret", "put", "API_TOKEN", "-c", "probes/agents-ws/wrangler.jsonc"], bearer + "\n");
  const readiness = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(base + "/state", { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(10000) });
    readiness.push(response.status);
    await response.body?.cancel();
    if (response.ok) break;
    if (attempt === 29) throw new Error(`Probe readiness failed: ${readiness.join(",")}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  report.readiness = readiness;
  await save();
  const call = async endpoint => {
    const response = await fetch(base + endpoint, { method: "POST", headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Probe ${endpoint}: HTTP ${response.status}`);
    return response.json();
  };
  let connection, opened = 0, initialized = 0, toolCalls = 0;
  socket = new WebSocket(base.replace("https:", "wss:") + "/events", ["camelrun.events.v1"], { headers: { authorization: `Bearer ${bearer}` } });
  const ready = Promise.withResolvers();
  socket.on("open", () => opened++);
  socket.on("error", error => ready.reject(error));
  socket.on("message", bytes => {
    const frame = JSON.parse(bytes.toString());
    if (frame.event === "ready") { connection = frame.data.connection; return; }
    const message = frame.data?.message;
    if (!message?.id) return;
    const result = message.method === "initialize" ? (initialized++, {}) : message.method === "tools/call" ? (toolCalls++, { content: [{ type: "text", text: message.params.arguments.value }] }) : {};
    const work = fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-agent-connection": connection }, body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), signal: AbortSignal.timeout(10000) }).then(response => {
      if (!response.ok) throw new Error(`MCP reply HTTP ${response.status}`);
      if (message.method === "initialize") ready.resolve();
    });
    pending.add(work); void work.finally(() => pending.delete(work)).catch(error => ready.reject(error));
  });
  await Promise.race([ready.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("WebSocket initialization timeout")), 15000))]);
  const before = await call("/call");
  report.result.before = before;
  const waits = [];
  let after;
  for (const idleMs of [35000, 45000]) {
    await new Promise(resolve => setTimeout(resolve, idleMs));
    after = await call("/call"); waits.push({ idleMs, changedBoot: after.boot !== before.boot, restored: after.restored });
    if (after.boot !== before.boot) break;
  }
  report.result = { before, after, waits, opened, initialized, toolCalls, sameConnection: opened === 1 && initialized === 1, evicted: after.boot !== before.boot, passed: after.boot !== before.boot && after.restored === 1 && opened === 1 && initialized === 1 && after.result.content[0].text === "synthetic probe" };
  if (!report.result.passed) throw new Error("Same-connection hibernation restoration was not observed within bounded waits");
  await call("/cleanup");
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  socket?.close();
  await Promise.allSettled([...pending]);
  if (owned) {
    const errors = [];
    const attempt = async (step, fn) => { try { return await fn(); } catch (error) { errors.push({ step, error: String(error) }); } };
    deployed ||= (await attempt("worker inventory", () => api("/workers/scripts")))?.some(worker => worker.id === name) ?? false;
    if (deployed) {
      const config = JSON.parse(await readFile(join(root, "probes/agents-ws/wrangler.jsonc"), "utf8"));
      config.main = join(root, "probes/agents-ws/empty.ts"); config.durable_objects = { bindings: [] }; config.migrations.push({ tag: "delete-attached-ws-probe", deleted_classes: ["AttachedWsProbe"] });
      const teardown = join(state, "teardown.json"); await writeFile(teardown, JSON.stringify(config));
      await attempt("namespace tombstone", () => wrangler(["deploy", "-c", teardown]));
      await attempt("worker deletion", () => api(`/workers/scripts/${name}`, "DELETE"));
    }
    report.cleanup.workers = (await attempt("worker verification", () => api("/workers/scripts")))?.filter(worker => worker.id === name).map(worker => worker.id);
    report.cleanup.namespaces = (await attempt("namespace verification", namespaces))?.filter(ns => ns.script === name);
    report.cleanup.errors = errors;
    if (errors.length || report.cleanup.workers?.length || report.cleanup.namespaces?.length) process.exitCode = 1;
  }
  report.spend = { estimatedMarginalUsdLessThan: 0.01, observedInvoiceUsd: null, note: "One DO and one WebSocket, fixed synthetic calls, less than two minutes; excludes existing subscription. Invoice not yet settled." };
  report.endedAt = new Date().toISOString(); await save(); await rm(state, { recursive: true, force: true });
}
console.log(safe(report));

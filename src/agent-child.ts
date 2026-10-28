import { randomUUID } from "node:crypto";
import { parentRpc, type Rpc } from "./rpc.ts";
import { createAgentHost } from "./agent-host.ts";
import { setMetricService, setMetricSink } from "./metrics.ts";
import { remotePiStorage } from "./pi-durable/storage.ts";

// One agent in its own process: the host's I/O goes over IPC to the supervisor.
// Its stdout is not kept: metric lines (metrics.ts) go to stderr, which the node's log keeps.
setMetricSink(line => process.stderr.write(`${line}\n`));
// This process's environment is its node's settings for it (agentProcessEnv).
setMetricService(process.env.AGENT_SERVICE_NAME);
const rpc = parentRpc();
const host = createAgentHost({
  dedupeUserEntries: process.env.AGENT_PI_DEDUPE_USER_ENTRIES === "true",
  emit: event => rpc.send({ type: "event", event }),
  tool: (name, args, call) => rpc.request("tool", { name, args, ...call }),
  cancelTools: () => rpc.request("cancel-tools"),
  runLimit: async () => (await rpc.request("run-limit")) ?? undefined,
  search: query => rpc.request("search", query),
  file: ref => rpc.request("file", ref),
  modelAuth: () => rpc.request("model-auth"),
  modelAttempt: event => rpc.request("model-attempt", event),
  fs: (op, args) => rpc.request("fs", { op, args }),
  codeSlot: signal => codeSlot(rpc, signal),
  lease: () => rpc.request("lease"),
  history: { indexed: () => rpc.request("history", { op: "indexed" }), write: chunk => rpc.request("history", { op: "write", chunk }) },
  // The legacy log is the supervisor's, read through it.
  legacyLog: { read: () => rpc.request("legacy-log", { op: "read" }), empty: () => rpc.request("legacy-log", { op: "empty" }) },
  piStorage: async () => await rpc.request("pi-storage", { method: "available" }) ? remotePiStorage(request => rpc.request("pi-storage", request)) : undefined,
  // This process's environment is the node's settings for it (agentProcessEnv).
});

/** A turn to run js_exec, held by the supervisor (which counts the tenant's across the node) until given back. */
async function codeSlot(rpc: Rpc, signal: AbortSignal): Promise<() => void> {
  const id = randomUUID();
  const release = () => { void rpc.request("code-release", { id }).catch(() => {}); };
  signal.addEventListener("abort", release, { once: true });
  try { await rpc.request("code-slot", { id }); }
  catch (error) { release(); throw error; }
  finally { signal.removeEventListener("abort", release); }
  return release;
}

// Answered here, not by the host: the supervisor's watchdog pings to see that this thread is not stuck.
rpc.handler = (method, params) => method === "ping" ? Promise.resolve(null) : host.handle(method, params);

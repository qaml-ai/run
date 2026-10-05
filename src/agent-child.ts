import { randomUUID } from "node:crypto";
import { parentRpc, type Rpc } from "./rpc.ts";
import { createAgentHost } from "./agent-host.ts";
import { setMetricSink } from "./metrics.ts";
import type { AppendLog } from "../shared/append-log.ts";
import type { TranscriptRecord } from "./transcript.ts";

// One agent in its own process: the host's I/O goes over IPC to the supervisor.
// Its stdout is not kept: metric lines (metrics.ts) go to stderr, which the node's log keeps.
setMetricSink(line => process.stderr.write(`${line}\n`));
const rpc = parentRpc();
const host = createAgentHost({
  emit: event => rpc.send({ type: "event", event }),
  tool: (name, args, call) => rpc.request("tool", { name, args, ...call }),
  cancelTools: () => rpc.request("cancel-tools"),
  runLimit: async () => (await rpc.request("run-limit")) ?? undefined,
  search: query => rpc.request("search", query),
  file: ref => rpc.request("file", ref),
  modelAuth: () => rpc.request("model-auth"),
  fs: (op, args) => rpc.request("fs", { op, args }),
  codeSlot: signal => codeSlot(rpc, signal),
  history: { indexed: () => rpc.request("history", { op: "indexed" }), write: chunk => rpc.request("history", { op: "write", chunk }), read: from => rpc.request("history", { op: "read", from }) },
  transcript: remoteTranscript(rpc),
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

/** The transcript is the supervisor's: records are buffered here and sent with each flush. The supervisor closes the log when this process ends. */
function remoteTranscript(rpc: Rpc): AppendLog<TranscriptRecord> {
  let buffer: TranscriptRecord[] = [];
  let appended = 0;
  return {
    read: () => rpc.request("transcript", { op: "read" }),
    append(record) { buffer.push(record); appended++; },
    flush(durable) {
      const records = buffer;
      buffer = [];
      return rpc.request("transcript", { op: "append", records, durable });
    },
    async rewrite(snapshot) {
      buffer = [];
      await rpc.request("transcript", { op: "rewrite", records: snapshot() });
      appended = 0;
    },
    get appendedSinceRewrite() { return appended; },
    close: async () => {},
  };
}
// Answered here, not by the host: the supervisor's watchdog pings to see that this thread is not stuck.
rpc.handler = (method, params) => method === "ping" ? Promise.resolve(null) : host.handle(method, params);

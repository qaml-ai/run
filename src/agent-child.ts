import { parentRpc, type Rpc } from "./rpc.ts";
import { createAgentHost } from "./agent-host.ts";
import type { AppendLog } from "../shared/append-log.ts";
import type { TranscriptRecord } from "./transcript.ts";

// One agent in its own process: the host's I/O goes over IPC to the supervisor.
const rpc = parentRpc();
const host = createAgentHost({
  emit: event => rpc.send({ type: "event", event }),
  tool: (name, args, call) => rpc.request("tool", { name, args, ...call }),
  cancelTools: () => rpc.request("cancel-tools"),
  spendLimit: async () => (await rpc.request("spend-limit")) ?? undefined,
  search: query => rpc.request("search", query),
  file: ref => rpc.request("file", ref),
  modelAuth: () => rpc.request("model-auth"),
  fs: (op, args) => rpc.request("fs", { op, args }),
  history: { indexed: () => rpc.request("history", { op: "indexed" }), write: chunk => rpc.request("history", { op: "write", chunk }), read: from => rpc.request("history", { op: "read", from }) },
  transcript: remoteTranscript(rpc),
});

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
rpc.handler = (method, params) => host.handle(method, params);

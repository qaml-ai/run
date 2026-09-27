import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { WireMessage } from "./protocol.ts";
import { errorText } from "./protocol.ts";

// JSON IPC is shared by Node and Bun. Never use stdout as a protocol channel:
// dependencies and model-generated console output may both write to it.
export class Rpc {
  pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  handler?: (method: string, params: any) => Promise<any>;
  onEvent?: (event: any) => void;
  closed = false;
  readonly send: (message: WireMessage) => void;
  constructor(send: (message: WireMessage) => void) { this.send = send; }
  request(method: string, params: any = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Process disconnected"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ type: "request", id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async receive(message: WireMessage) {
    if (message.type === "response") {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error !== undefined) pending?.reject(new Error(message.error));
      else pending?.resolve(message.result);
    } else if (message.type === "event") {
      this.onEvent?.(message.event);
    } else if (message.type === "request") {
      let response: WireMessage;
      try {
        if (!this.handler) throw new Error("RPC handler unavailable");
        response = { type: "response", id: message.id, result: await this.handler(message.method, message.params) };
      } catch (error) { response = { type: "response", id: message.id, error: errorText(error) }; }
      if (!this.closed) this.send(response);
    }
  }
  close(reason = "Process disconnected") {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
  }
}

export function childProcess(entry: string, cwd: string, runtime = process.execPath, detached = false): { child: ChildProcess; rpc: Rpc } {
  const args = runtime.toLowerCase().includes("bun") ? [] : ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
  const child = spawn(runtime, [...args, fileURLToPath(new URL(entry, import.meta.url))], {
    cwd,
    detached,
    // No inherited provider keys, supervisor token, NODE_OPTIONS, or preload hooks. One agent
    // runs one js_exec at a time: it starts a sandbox worker on demand and lets it go when idle.
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd, AGENT_CODE_WORKERS_MIN: "0",
      // Where agent-launcher's sandbox processes listen, when it started them.
      ...(process.env.AGENT_SANDBOX_SOCKETS ? { AGENT_SANDBOX_SOCKETS: process.env.AGENT_SANDBOX_SOCKETS } : {}),
      // The history backlog's bound (transcript.ts), which tests lower.
      ...(process.env.AGENT_HISTORY_BACKLOG_BYTES ? { AGENT_HISTORY_BACKLOG_BYTES: process.env.AGENT_HISTORY_BACKLOG_BYTES } : {}),
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    serialization: "json",
  });
  const rpc = new Rpc(message => {
    if (!child.connected) throw new Error("Process disconnected");
    child.send(message, error => { if (error) rpc.close(error.message); });
  });
  child.on("message", message => { void rpc.receive(message as WireMessage); });
  child.on("error", error => rpc.close(error.message));
  child.on("exit", (code, signal) => rpc.close(`Process exited (${signal ?? code})`));
  return { child, rpc };
}

export function parentRpc(): Rpc {
  const rpc = new Rpc(message => {
    if (!process.connected) throw new Error("Parent disconnected");
    process.send!(message, error => { if (error) rpc.close(error.message); });
  });
  process.on("message", message => { void rpc.receive(message as WireMessage); });
  process.on("disconnect", () => { rpc.close(); process.exit(0); });
  return rpc;
}

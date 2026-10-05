import { createServer, type Socket } from "node:net";
import { parseArgs } from "node:util";
import { availableParallelism } from "node:os";
import { CodePool, defaultCodeWorkers, localGuest, type Guest } from "./codemode.ts";
import { frames } from "./sandbox-wire.ts";
import { inspectHere } from "./inspect.ts";
import { FILE_LIMITS, SANDBOX_LIMITS } from "./limits.ts";

// One sandbox process: a CodePool serving executions over a unix socket, one per
// connection. agent-launcher (sandbox/launcher.c) binds the socket, passes it as
// fd 3, and runs this as its own uid with an empty environment, no_new_privs and a
// seccomp filter that leaves it no network. The runtime treats every frame from
// here as untrusted and enforces all tool policy and limits on its side.
const { values: args } = parseArgs({
  options: {
    fd: { type: "string", default: "3" },
    /** Listen on a path instead of an inherited socket: tests and development. */
    socket: { type: "string" },
    /** AGENT_CODE_WORKERS_MIN and _MAX as the runtime would read them, shared across `processes`. */
    "workers-min": { type: "string" },
    "workers-max": { type: "string" },
    processes: { type: "string", default: "1" },
    /** Serve `probe` requests, which report this process's confinement (tests/image-isolation.ts). */
    "test-hooks": { type: "boolean", default: false },
  },
});
const processes = Number(args.processes);
const share = (total: number) => Math.ceil(total / processes);
const pool = new CodePool({
  min: share(args["workers-min"] === undefined ? Math.min(4, availableParallelism()) : Number(args["workers-min"])),
  max: share(args["workers-max"] === undefined ? defaultCodeWorkers() : Number(args["workers-max"])),
});

function serve(socket: Socket) {
  const closed = new AbortController();
  let guest: Guest | undefined;
  let execution: string | undefined;
  let answered = false;
  socket.on("error", () => {});
  socket.once("close", () => {
    closed.abort();
    guest?.end(answered);
  });
  let onData: ((message: any) => void) | undefined;
  const send = frames(socket, (message: any) => {
    if (onData) return onData(message);
    if (execution !== undefined) return guest?.send(message);
    if (message?.type !== "request" || typeof message.id !== "string") return void socket.destroy();
    execution = message.id;
    if (message.method === "inspect") return receiveFile(message.params, send, socket);
    if (message.method === "probe" && args["test-hooks"]) {
      return void import("./sandbox-probe.ts").then(({ probe }) => probe(message.params))
        .then(result => send({ type: "response", id: execution, result }), error => send({ type: "response", id: execution, error: String(error) }));
    }
    if (message.method !== "execute") return void socket.destroy();
    // The runtime's CPU budget for the execution, which this process's watchdog holds it to.
    const cpuMs = message.params?.cpuMs;
    localGuest(pool, closed.signal, Number.isInteger(cpuMs) && cpuMs > 0 && cpuMs <= SANDBOX_LIMITS.maxCpuMs ? cpuMs : SANDBOX_LIMITS.cpuMs).then(acquired => {
      if (socket.destroyed) return acquired.end(false);
      guest = acquired;
      acquired.listen(reply => {
        if ((reply as { type?: string; id?: string }).type === "response" && (reply as { id?: string }).id === execution) answered = true;
        send(reply);
      }, reason => {
        if (socket.destroyed) return;
        send({ type: "response", id: execution, error: reason });
        socket.end();
      });
      send({ type: "dispatched" });
      acquired.send(message);
    }, () => socket.destroy());
  });

  /** An untrusted file to parse (inspect.ts): its bytes follow in `data` frames, then one response. */
  function receiveFile(params: any, reply: (message: unknown) => void, socket: Socket) {
    const size = params?.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > FILE_LIMITS.inspectBytes) return void socket.destroy();
    const bytes = Buffer.alloc(size);
    let received = 0;
    const run = () => {
      onData = () => socket.destroy();
      inspectHere(bytes, params.text === true).then(result => reply({ type: "response", id: execution, result }), error => reply({ type: "response", id: execution, error: String(error) }));
    };
    onData = message => {
      const data = message?.type === "data" && typeof message.data === "string" ? Buffer.from(message.data, "base64") : undefined;
      if (!data || received + data.length > size) return void socket.destroy();
      data.copy(bytes, received);
      received += data.length;
      if (received === size) run();
    };
    if (size === 0) run();
  }
}

const server = createServer(serve);
server.listen(args.socket ?? { fd: Number(args.fd) });

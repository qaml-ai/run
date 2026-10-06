import { createServer, type Socket } from "node:net";
import { parseArgs } from "node:util";
import { availableParallelism } from "node:os";
import { CodePool, codeWorkers, INSPECT_FRAME_BYTES, localGuest, type Guest } from "./codemode.ts";
import { frames } from "./sandbox-wire.ts";
import { inspectHere } from "./inspect.ts";
import { V8Exec } from "./v8-exec.ts";
import { FILE_LIMITS, SANDBOX_LIMITS } from "./limits.ts";

// One sandbox process, serving executions over a unix socket, one per connection, each on the
// engine its request names: its CodePool (QuickJS), or a v8-exec process of its own (V8), which
// inherits this process's confinement. agent-launcher (sandbox/launcher.c) binds the socket, passes it as
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
    /**
     * AGENT_JS_EXEC, AGENT_V8_PRESPAWN, AGENT_V8_MAX and AGENT_V8_JITLESS as the runtime reads them (the
     * launcher passes them on). With v8 the default, v8-exec processes are started ahead (2 per sandbox
     * process by default, else none until a tenant on V8 runs one).
     */
    engine: { type: "string", default: "quickjs" },
    "v8-prespawn": { type: "string" },
    "v8-max": { type: "string" },
    "v8-jitless": { type: "string", default: "1" },
  },
});
const processes = Number(args.processes);
const share = (total: number) => Math.ceil(total / processes);
const v8First = args.engine === "v8";
// Started on first use, so a node whose tenants never run V8 spawns nothing.
let v8: V8Exec | undefined;
const v8Exec = () => v8 ??= new V8Exec({
  prespawn: args["v8-prespawn"] === undefined ? (v8First ? 2 : 0) : Number(args["v8-prespawn"]),
  max: share(args["v8-max"] === undefined ? 64 : Number(args["v8-max"])),
  jitless: args["v8-jitless"] !== "0",
});
if (v8First) v8Exec();
const pool = new CodePool({
  // Warm whatever the default engine: tenants pinned to QuickJS keep its warm workers (AGENT_CODE_WORKERS_MIN=0 once none are).
  min: share(args["workers-min"] === undefined ? Math.min(4, availableParallelism()) : Number(args["workers-min"])),
  max: share(args["workers-max"] === undefined ? codeWorkers() : Number(args["workers-max"])),
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
    (message.params?.engine === "v8" ? Promise.resolve(v8Exec().open()) : localGuest(pool, closed.signal, Number.isInteger(cpuMs) && cpuMs > 0 && cpuMs <= SANDBOX_LIMITS.maxCpuMs ? cpuMs : SANDBOX_LIMITS.cpuMs)).then(acquired => {
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

  /** An untrusted file to parse (inspect.ts): its bytes follow in `data` frames; then one response, after an image's scaled-down bytes if it was to `fit`. */
  function receiveFile(params: any, reply: (message: unknown) => void, socket: Socket) {
    const size = params?.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > FILE_LIMITS.inspectBytes) return void socket.destroy();
    const bytes = Buffer.alloc(size);
    let received = 0;
    const run = () => {
      onData = () => socket.destroy();
      inspectHere(bytes, params.text === true, params.fit === true).then((result: any) => {
        // A scaled-down image's bytes go back in `data` frames before the response, as they came.
        const data: Uint8Array | undefined = result?.data instanceof Uint8Array ? result.data : undefined;
        if (data) for (let offset = 0; offset < data.length; offset += INSPECT_FRAME_BYTES) reply({ type: "data", data: Buffer.from(data.subarray(offset, offset + INSPECT_FRAME_BYTES)).toString("base64") });
        reply({ type: "response", id: execution, result: data ? { ...result, data: undefined } : result });
      }, error => reply({ type: "response", id: execution, error: String(error) }));
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

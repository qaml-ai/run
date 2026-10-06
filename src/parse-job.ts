import type { Socket } from "node:net";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { frames, INSPECT_FRAME_BYTES } from "./sandbox-wire.ts";
import { FILE_LIMITS } from "./limits.ts";

// One untrusted file parsed (inspect.ts), in a process of its own: under agent-launcher
// (sandbox/launcher.c) a uid no other process has, an empty environment, no_new_privs and a seccomp
// filter that leaves it no network, with its connection to the runtime as stdin and stdout. The
// request comes first, then the file's bytes in `data` frames; one response goes back, after an
// image's scaled-down bytes if it was to `fit`, and the runtime then ends the process. The runtime
// trusts none of it, and checks every field. Its imports are kept few: each TypeScript module costs this
// short-lived process startup time.
const { values: args } = parseArgs({
  options: {
    /** Serve a `probe` request instead, which reports this process's confinement (tests/image-isolation.ts). */
    "test-hooks": { type: "boolean", default: false },
  },
});

const input = process.stdin as unknown as Socket;
// The runtime gone: nothing more to do.
input.on("end", () => process.exit(0));
let onData: ((message: any) => void) | undefined;
const send = frames(input, (message: any) => {
  if (onData) return onData(message);
  if (message?.type !== "request" || typeof message.id !== "string") return void process.exit(1);
  const id = message.id;
  const reply = (result: Promise<unknown>) => result.then(result => send({ type: "response", id, result }), error => send({ type: "response", id, error: String(error) }));
  if (message.method === "probe" && args["test-hooks"]) return void reply(import("./sandbox-probe.ts").then(({ probe }) => probe(message.params)));
  if (message.method !== "inspect") return void process.exit(1);
  const params = message.params;
  const size = params?.size;
  if (!Number.isSafeInteger(size) || size < 0 || size > FILE_LIMITS.inspectBytes) return void process.exit(1);
  const bytes = Buffer.alloc(size);
  let received = 0;
  const run = () => {
    onData = () => process.exit(1);
    void reply(inspectHere(bytes, params.text === true, params.fit === true).then((result: any) => {
      // A scaled-down image's bytes go back in `data` frames before the response, as they came.
      const data: Uint8Array | undefined = result?.data instanceof Uint8Array ? result.data : undefined;
      if (!data) return result;
      for (let offset = 0; offset < data.length; offset += INSPECT_FRAME_BYTES) send({ type: "data", data: Buffer.from(data.subarray(offset, offset + INSPECT_FRAME_BYTES)).toString("base64") });
      return { ...result, data: undefined };
    }));
  };
  onData = message => {
    const data = message?.type === "data" && typeof message.data === "string" ? Buffer.from(message.data, "base64") : undefined;
    if (!data || received + data.length > size) return void process.exit(1);
    data.copy(bytes, received);
    received += data.length;
    if (received === size) run();
  };
  if (size === 0) run();
}, undefined, process.stdout as unknown as Socket);

/** How the worker scales an image down for a model request (inspect-worker.ts). */
const FIT = { side: FILE_LIMITS.requestImageSide, bytes: FILE_LIMITS.requestImageBytes, pixels: FILE_LIMITS.imageSide ** 2, ms: FILE_LIMITS.inspectMs };

/**
 * Parse `bytes` on a worker thread, which has a V8 heap limit, a deadline, and a ceiling on this
 * process's resident memory: pdf.js inflates streams into ArrayBuffers, which heap limits do not
 * count, so a small compressed "bomb" is stopped by the ceiling. `fit` scales an image down for a model request.
 */
function inspectHere(bytes: Uint8Array, text: boolean, fit = false): Promise<unknown> {
  const worker = new Worker(new URL("./inspect-worker.ts", import.meta.url), {
    workerData: { bytes, text, maxChars: FILE_LIMITS.extractedChars, ...(fit ? { fit: FIT } : {}) }, env: {},
    resourceLimits: { maxOldGenerationSizeMb: FILE_LIMITS.inspectHeapMb, maxYoungGenerationSizeMb: 32 },
  });
  const done = Promise.withResolvers<unknown>();
  // Stopped from outside, not by what the file holds: the caller may try again (`fitImage`).
  const stop = (reason: string) => { done.resolve({ media: { kind: "none", reason: `could not be read (${reason})` }, transient: true }); void worker.terminate(); };
  const baseline = process.memoryUsage.rss();
  const watchdog = setInterval(() => { if (process.memoryUsage.rss() - baseline > FILE_LIMITS.inspectMemoryBytes) stop("it needs too much memory"); }, 20);
  const timer = setTimeout(() => stop("it took too long"), FILE_LIMITS.inspectMs);
  worker.once("message", done.resolve);
  worker.once("error", error => stop(String((error as Error)?.message ?? error).slice(0, 200)));
  worker.once("exit", () => stop("its parser stopped"));
  return done.promise.finally(() => { clearInterval(watchdog); clearTimeout(timer); void worker.terminate(); });
}

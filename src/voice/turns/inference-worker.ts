import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { isMainThread, parentPort, Worker, workerData, type MessagePort } from "node:worker_threads";
import { logMel, WHISPER } from "./features.ts";
import { MODELS, WORKER_LIMITS, type HostMessage, type ClientMessage, type EotJob, type EotDone } from "./protocol.ts";

/**
 * The turn models' worker threads (inference.ts starts them): onnxruntime blocks the thread it runs on (a Smart Turn
 * inference is ~40 ms), so no voice code waits on it.
 *
 * - The host (role "host", one per node) owns Silero VAD: each client's chunks, from every session and speaker, run as
 *   one batch per turn of its event loop (a speaker's chunk at a time: its state comes back with its probability). It
 *   hands end-of-turn jobs to its end-of-turn workers, the fewest busy first.
 * - Each end-of-turn worker (role "eot") owns a Smart Turn session: the audio's log-mel features, then the model.
 *
 * Each ONNX session runs on its own thread alone (intra- and inter-op threads 1), with no memory arena.
 */

type Ort = typeof import("onnxruntime-node");
const ort = (): Ort => createRequire(import.meta.url)("onnxruntime-node");
/** End-of-turn jobs one worker holds at most (one running, the rest waiting). */
const EOT_QUEUE = 3;
const SESSION_OPTIONS = { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: "sequential", graphOptimizationLevel: "all", enableCpuMemArena: false, enableMemPattern: false } as const;

export type Data = { role: "host"; eotWorkers?: number; models?: { vad?: string; eot?: string } } | { role: "eot"; model: string };
const data = workerData as Data | undefined;

if (!isMainThread && data?.role === "host") void host(data);
if (!isMainThread && data?.role === "eot") void eot(data.model);

async function host(options: Extract<Data, { role: "host" }>) {
  const runtime = ort();
  const vad = await runtime.InferenceSession.create(options.models?.vad ?? MODELS.vad, SESSION_OPTIONS);
  const sr = new runtime.Tensor("int64", BigInt64Array.from([16_000n]), []);
  type Pending = { port: MessagePort; id: number; input: Float32Array; state: Float32Array };
  let queue: Pending[] = [];
  let scheduled = false;
  const flush = async () => {
    scheduled = false;
    const batch = queue;
    queue = [];
    if (!batch.length) return;
    const size = batch.length;
    const input = new Float32Array(size * 576), state = new Float32Array(2 * size * 128);
    batch.forEach((item, b) => {
      input.set(item.input, b * 576);
      state.set(item.state.subarray(0, 128), b * 128);
      state.set(item.state.subarray(128), (size + b) * 128);
    });
    try {
      const out = await vad.run({ input: new runtime.Tensor("float32", input, [size, 576]), state: new runtime.Tensor("float32", state, [2, size, 128]), sr });
      const probabilities = out.output.data as Float32Array, next = out.stateN.data as Float32Array;
      batch.forEach((item, b) => {
        const s = new Float32Array(256);
        s.set(next.subarray(b * 128, b * 128 + 128));
        s.set(next.subarray((size + b) * 128, (size + b) * 128 + 128), 128);
        item.port.postMessage({ type: "vad", id: item.id, probability: probabilities[b], state: s } satisfies HostMessage, [s.buffer]);
      });
    } catch (error) {
      for (const item of batch) item.port.postMessage({ type: "error", id: item.id, message: String((error as Error).message ?? error) } satisfies HostMessage);
    }
    vadBatches++; vadChunks += size;
  };
  let vadBatches = 0, vadChunks = 0, eotRefused = 0;

  // End-of-turn workers, each with its own Smart Turn session.
  const count = Math.max(1, options.eotWorkers ?? Math.min(2, Math.max(1, availableParallelism() - 1)));
  type Eot = { worker: Worker; busy: number };
  const workers: Eot[] = [];
  const waiting = new Map<number, { port: MessagePort; id: number; worker: Eot }>();
  let jobs = 0;
  for (let i = 0; i < count; i++) {
    const worker = new Worker(new URL(import.meta.url), { workerData: { role: "eot", model: options.models?.eot ?? MODELS.eot } satisfies Data, resourceLimits: WORKER_LIMITS });
    const entry: Eot = { worker, busy: 0 };
    worker.on("message", (done: EotDone) => {
      const job = waiting.get(done.job);
      if (!job) return;
      waiting.delete(done.job);
      entry.busy--;
      job.port.postMessage(done.error === undefined
        ? { type: "eot", id: job.id, probability: done.probability!, ms: done.ms, featuresMs: done.featuresMs ?? 0 } satisfies HostMessage
        : { type: "error", id: job.id, message: done.error } satisfies HostMessage);
    });
    // An end-of-turn worker that fails takes the host with it: the client's pending calls fail, and it is started again.
    worker.on("error", error => { throw error; });
    worker.on("exit", code => { if (code !== 0 && !closing) throw new Error(`end-of-turn worker exited ${code}`); });
    workers.push(entry);
  }

  const attach = (port: MessagePort) => {
    port.on("message", (message: ClientMessage) => {
      if (message.type === "vad") {
        queue.push({ port, id: message.id, input: message.input, state: message.state });
        if (!scheduled) { scheduled = true; setImmediate(() => void flush()); }
      } else if (message.type === "eot") {
        const worker = workers.reduce((a, b) => b.busy < a.busy ? b : a);
        // Past a few waiting, an answer would come too late to matter: the caller falls back to its silence timer.
        if (worker.busy >= EOT_QUEUE) {
          port.postMessage({ type: "error", id: message.id, message: "end-of-turn workers busy", busy: true } satisfies HostMessage);
          eotRefused++;
          return;
        }
        const job = ++jobs;
        worker.busy++;
        waiting.set(job, { port, id: message.id, worker });
        worker.worker.postMessage({ job, audio: message.audio } satisfies EotJob, [message.audio.buffer as ArrayBuffer]);
      } else if (message.type === "stats") {
        port.postMessage({ type: "stats", id: message.id, vadBatches, vadChunks, eotBusy: workers.map(w => w.busy), eotRefused, rssBytes: process.memoryUsage().rss } satisfies HostMessage);
      }
    });
    port.on("close", () => { queue = queue.filter(item => item.port !== port); });
  };
  // Closing: each session released before its thread ends. onnxruntime aborts the process (a mutex torn down under it)
  // when a thread is terminated with a session alive, so threads end themselves.
  let closing = false;
  parentPort!.on("message", async (message: { type: "port"; port: MessagePort } | { type: "close" }) => {
    if (message.type === "port") attach(message.port);
    if (message.type !== "close" || closing) return;
    closing = true;
    await Promise.all(workers.map(({ worker }) => new Promise(resolve => { worker.once("exit", resolve); worker.postMessage({ type: "close" }); })));
    await vad.release();
    process.exit(0);
  });
  parentPort!.postMessage({ type: "ready" });
}

async function eot(model: string) {
  const runtime = ort();
  const session = await runtime.InferenceSession.create(model, SESSION_OPTIONS);
  // Jobs run one at a time, in order: a run blocks this thread.
  let chain = Promise.resolve();
  parentPort!.on("message", (job: EotJob | { type: "close" }) => {
    if ("type" in job) {
      chain = chain.then(async () => { await session.release(); process.exit(0); });
      return;
    }
    chain = chain.then(async () => {
      const started = performance.now();
      try {
        const audio = new Float32Array(job.audio.length);
        for (let i = 0; i < audio.length; i++) audio[i] = job.audio[i] / 32_768;
        const features = logMel(audio);
        const featuresMs = performance.now() - started;
        const out = await session.run({ input_features: new runtime.Tensor("float32", features, [1, WHISPER.mels, WHISPER.frames]) });
        const probability = (out.logits.data as Float32Array)[0];
        parentPort!.postMessage({ job: job.job, probability, ms: performance.now() - started, featuresMs } satisfies EotDone);
      } catch (error) {
        parentPort!.postMessage({ job: job.job, error: String((error as Error).message ?? error), ms: performance.now() - started } satisfies EotDone);
      }
    });
  });
}

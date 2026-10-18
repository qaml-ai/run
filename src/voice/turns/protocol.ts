/** The messages between turn-model clients (inference.ts) and their worker threads (inference-worker.ts). */

const here = (file: string) => new URL(`./models/${file}`, import.meta.url).pathname;
/** The models, kept with the code (see models/NOTICE.md for where they come from and their licenses). */
export const MODELS = Object.freeze({
  vad: here("silero_vad_v6.2.3.onnx"),
  eot: here("smart-turn-v3.2-cpu.onnx"),
});

/** A client's call: a speaker's next VAD chunk (64 samples of context, then 512 new) with its LSTM state; an end-of-turn check; stats. */
export type ClientMessage =
  | { type: "vad"; id: number; input: Float32Array; state: Float32Array }
  | { type: "eot"; id: number; audio: Int16Array }
  | { type: "stats"; id: number };

export type HostMessage =
  | { type: "vad"; id: number; probability: number; state: Float32Array }
  | { type: "eot"; id: number; probability: number; ms: number; featuresMs: number }
  | { type: "stats"; id: number; vadBatches: number; vadChunks: number; eotBusy: number[]; eotRefused: number; rssBytes: number }
  | { type: "error"; id: number; message: string; busy?: boolean };

/** Between the host and an end-of-turn worker. */
export type EotJob = { job: number; audio: Int16Array };
export type EotDone = { job: number; probability?: number; error?: string; ms: number; featuresMs?: number };

/** Each model thread's JavaScript heap: it holds a few buffers at a time (the models themselves are native memory). */
export const WORKER_LIMITS = Object.freeze({ maxYoungGenerationSizeMb: 8, maxOldGenerationSizeMb: 64 });

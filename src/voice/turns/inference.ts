import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import { WORKER_LIMITS, type ClientMessage, type HostMessage } from "./protocol.ts";

/**
 * What turn-taking asks of its models (turn-taker.ts): Silero VAD on a speaker's next chunk, and Smart Turn on a turn's
 * audio. Both answer asynchronously, from worker threads (inference-worker.ts): one host per node, which a client in any
 * thread reaches over a MessagePort. A call fails fast (rejects) when the workers are gone or busy; the caller then
 * falls back to timing silence.
 */
export interface TurnModels {
  /** Speech probability of 512 new samples (16 kHz; `input` is 576: the 64 before them, then them), and the next LSTM state (256). */
  vad(input: Float32Array, state: Float32Array): Promise<{ probability: number; state: Float32Array }>;
  /** Probability that the speaker finished their turn, from its audio (16 kHz mono; the last 8 s count). */
  endOfTurn(audio: Int16Array): Promise<number>;
  close(): void;
}

export class TurnModelsUnavailable extends Error {
  readonly busy: boolean;
  constructor(message: string, busy = false) { super(message); this.busy = busy; }
}

export const INFERENCE_LIMITS = Object.freeze({
  /** A VAD answer later than this is treated as lost (the worker stalled). */
  vadTimeoutMs: 500,
  /** An end-of-turn answer later than this is too late to be worth waiting for. */
  eotTimeoutMs: 1_000,
});

/** A client of the turn models over `port` (from `startTurnModels().port()`, possibly sent to another thread). */
export function clientFrom(port: MessagePort): TurnModels & { stats(): Promise<Extract<HostMessage, { type: "stats" }>>; readonly closed: boolean } {
  let next = 0, closed = false;
  type Waiter = { resolve(message: HostMessage): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  const waiting = new Map<number, Waiter>();
  // Ref'd only while answers are awaited: an idle client does not keep its thread alive.
  const settle = (id: number) => { waiting.delete(id); if (!waiting.size) port.unref(); };
  const failAll = (message: string) => {
    closed = true;
    for (const [id, waiter] of waiting) { clearTimeout(waiter.timer); settle(id); waiter.reject(new TurnModelsUnavailable(message)); }
  };
  port.on("message", (message: HostMessage) => {
    const waiter = waiting.get(message.id);
    if (!waiter) return;
    settle(message.id);
    clearTimeout(waiter.timer);
    if (message.type === "error") waiter.reject(new TurnModelsUnavailable(message.message, message.busy));
    else waiter.resolve(message);
  });
  // The host's thread ended (or the port was closed): nothing pending will be answered.
  port.on("close", () => failAll("turn models closed"));
  port.unref();
  const call = <T extends HostMessage["type"]>(message: ClientMessage, transfer: ArrayBuffer[], timeoutMs: number) =>
    new Promise<Extract<HostMessage, { type: T }>>((resolve, reject) => {
      if (closed) { reject(new TurnModelsUnavailable("turn models closed")); return; }
      const timer = setTimeout(() => {
        settle(message.id);
        reject(new TurnModelsUnavailable("turn models timed out"));
      }, timeoutMs);
      timer.unref?.();
      waiting.set(message.id, { resolve: resolve as (message: HostMessage) => void, reject, timer });
      port.ref();
      port.postMessage(message, transfer);
    });
  return {
    async vad(input, state) {
      const answer = await call<"vad">({ type: "vad", id: ++next, input, state }, [], INFERENCE_LIMITS.vadTimeoutMs);
      return { probability: answer.probability, state: answer.state };
    },
    async endOfTurn(audio) {
      const copy = audio.slice();
      return (await call<"eot">({ type: "eot", id: ++next, audio: copy }, [copy.buffer], INFERENCE_LIMITS.eotTimeoutMs)).probability;
    },
    stats: () => call<"stats">({ type: "stats", id: ++next }, [], 5_000),
    close() { port.close(); failAll("turn models closed"); },
    get closed() { return closed; },
  };
}

/**
 * A client of `host` that outlives its restarts: a call made after its port closed (the host ended) takes a new port.
 * What was pending when it ended still fails, fast.
 */
export function hostClient(host: TurnModelsHost): TurnModels {
  let client: ReturnType<typeof clientFrom> | undefined;
  const current = () => {
    if (!client || client.closed) client = clientFrom(host.port());
    return client;
  };
  return {
    vad: (input, state) => current().vad(input, state),
    endOfTurn: audio => current().endOfTurn(audio),
    close() { client?.close(); },
  };
}

export type TurnModelsHost = {
  /** A new port to the host, for one client (in this thread or sent to another). */
  port(): MessagePort;
  /** Resolves once the models are loaded (again, after a restart); rejects if they cannot be. */
  readonly ready: Promise<void>;
  /** The host's thread now, if it runs (metrics, and tests that end it). */
  readonly thread: Worker | undefined;
  close(): Promise<void>;
};

/**
 * Start the node's turn models: the host worker (Silero VAD) and its end-of-turn workers (Smart Turn). If the host
 * exits, every client's pending calls fail, and it is started again (after `restartMs`, doubling to a minute while it
 * keeps failing to start); ports given out before reach the old one, and fail: callers take a new port.
 */
export function startTurnModels(options: { eotWorkers?: number; models?: { vad?: string; eot?: string }; restartMs?: number; onExit?(code: number): void } = {}): TurnModelsHost {
  const firstRestartMs = options.restartMs ?? 1_000;
  let worker: Worker | undefined, stopped = false, restartMs = firstRestartMs, restart: ReturnType<typeof setTimeout> | undefined;
  let ready!: Promise<void>;
  const start = () => {
    const current = worker = new Worker(new URL("./inference-worker.ts", import.meta.url), { workerData: { role: "host", eotWorkers: options.eotWorkers, models: options.models }, resourceLimits: WORKER_LIMITS });
    current.unref();
    const started = Promise.withResolvers<void>();
    current.once("message", (message: { type: string }) => message.type === "ready" ? started.resolve() : started.reject(new Error("unexpected message")));
    current.on("error", error => started.reject(error));
    current.on("exit", code => {
      started.reject(new Error(`turn models exited ${code}`));
      if (worker !== current) return;
      worker = undefined;
      options.onExit?.(code);
      if (stopped) return;
      // Until it is back, `ready` waits for the next one.
      const again = Promise.withResolvers<void>();
      ready = again.promise;
      ready.catch(() => {});
      restart = setTimeout(() => { if (!stopped) { start(); ready.then(again.resolve, again.reject); } }, restartMs);
      restartMs = Math.min(restartMs * 2, 60_000);
    });
    ready = started.promise.then(() => { restartMs = firstRestartMs; });
    ready.catch(() => {});
  };
  start();
  return {
    port() {
      const { port1, port2 } = new MessageChannel();
      if (worker) worker.postMessage({ type: "port", port: port2 }, [port2]);
      else port2.close();
      return port1;
    },
    get ready() { return ready; },
    get thread() { return worker; },
    /** Stop: the threads release their models and end (terminated if they have not within 5 s). */
    async close() {
      stopped = true;
      clearTimeout(restart);
      const current = worker;
      worker = undefined;
      if (!current) return;
      const exited = new Promise(resolve => current.once("exit", resolve));
      current.postMessage({ type: "close" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5_000); })]);
      clearTimeout(timer);
      await current.terminate();
    },
  };
}

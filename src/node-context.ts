import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fetch as undiciFetch } from "undici";

/**
 * How a node reaches anything outside its process: other nodes, model providers, MCP servers, webhook receivers, OAuth
 * and sign-in providers, channels' APIs, Stripe, ECS. Tests can supply a network through NodeDeps.network.
 *
 * The AWS SDK's clients, Discord's voice WebSocket and UDP socket, and the code executor's sockets connect directly.
 */
export type Network = {
  /** HTTP. */
  fetch: typeof fetch;
  /** HTTP through the outbound guard (src/outbound.ts): undici's fetch, whose dispatcher checks each address it connects to. */
  guardedFetch: typeof undiciFetch;
  /** Every address a host name resolves to: what the outbound guard checks. */
  resolve: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /** A streamed HTTP request: one forwarded to the node that owns its actor. */
  request: typeof request;
  /** A TCP connection: whether a peer still listens (`probeNode`). */
  connect: typeof connect;
};

export const REAL_NETWORK: Network = {
  // Read at each call, so whatever the process's fetch is then (a test's stub) is the one called.
  fetch: (input, init) => globalThis.fetch(input, init),
  guardedFetch: undiciFetch,
  resolve: hostname => lookup(hostname, { all: true, verbatim: true }),
  request,
  connect,
};

type Timer = ReturnType<typeof setTimeout>;
/** The clock used for ownership leases, timeouts, and retry delays. */
export type Clock = {
  /** Milliseconds since the epoch, as Date.now. */
  now(): number;
  /** Monotonic milliseconds, as performance.now. */
  monotonic(): number;
  setTimeout(callback: () => void, ms: number): Timer;
  clearTimeout(timer: Timer | undefined): void;
  setInterval(callback: () => void, ms: number): Timer;
  clearInterval(timer: Timer | undefined): void;
  /** Resolves after `ms`, or rejects with an AbortError when `signal` aborts first, as timers/promises' setTimeout. */
  sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void>;
};

export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: timer => clearInterval(timer),
  sleep: (ms, options) => sleep(ms, undefined, options),
};

/** The node's random source for peer selection, retry jitter, and sampling. */
export type Random = {
  /** A number in [0, 1), as Math.random. */
  float(): number;
  /** `size` random bytes, as crypto.randomBytes. */
  bytes(size: number): Buffer;
};

export const REAL_RANDOM: Random = { float: () => Math.random(), bytes: size => randomBytes(size) };

/**
 * What a node runs with that is not its own code: given to it by NodeDeps, and found by any code running for it (its
 * requests, timers and callbacks) through the async context it was created in, so nothing threads it through. A process
 * with one node, as in production, never sets it: everything gets the real ones.
 */
export type NodeContext = { network: Network; clock: Clock; random: Random };
const current = new AsyncLocalStorage<NodeContext>();

/** The context of the node this code runs for, if it was given one. */
export const nodeContext = (): NodeContext | undefined => current.getStore();
/** The network of the node this code runs for. */
export const network = (): Network => current.getStore()?.network ?? REAL_NETWORK;
/** The clock of the node this code runs for. */
export const clock = (): Clock => current.getStore()?.clock ?? REAL_CLOCK;
/** The randomness of the node this code runs for. */
export const random = (): Random => current.getStore()?.random ?? REAL_RANDOM;

/** Run `work` for a node with `context`: what it starts, and what that starts, keeps it. */
export const runFor = <T>(context: NodeContext, work: () => T): T => current.run(context, work);

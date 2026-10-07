import { AsyncLocalStorage } from "node:async_hooks";
import { lookup } from "node:dns/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { fetch as undiciFetch } from "undici";

/**
 * How a node reaches anything outside its process: other nodes, model providers, MCP servers, webhook receivers, OAuth
 * and sign-in providers, channels' APIs, Stripe, ECS. Production's is the real network. A simulation gives each node
 * its own (NodeDeps.network), which routes to fakes and to the other nodes, and can drop, delay or partition.
 *
 * Not covered, because a simulation leaves them out: the AWS SDK's own clients (S3, which Storage replaces; SES, Secrets
 * Manager, ECS, Bedrock), Discord's gateway WebSocket, and the confined processes' sockets (the code executor's).
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

/**
 * What a node runs with that is not its own code: given to it by NodeDeps, and found by any code running for it (its
 * requests, timers and callbacks) through the async context it was created in, so nothing threads it through. A process
 * with one node, as in production, never sets it: everything gets the real one.
 */
export type NodeContext = { network: Network };
const current = new AsyncLocalStorage<NodeContext>();

/** The network of the node this code runs for. */
export const network = (): Network => current.getStore()?.network ?? REAL_NETWORK;

/** Run `work` for a node with `context`: what it starts, and what that starts, keeps it. */
export const runFor = <T>(context: NodeContext, work: () => T): T => current.run(context, work);

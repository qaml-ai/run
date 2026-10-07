import { AsyncResource } from "node:async_hooks";
import { Duplex } from "node:stream";

/**
 * Two connected in-memory sockets: what one writes the other reads, through process.nextTick only, so an exchange over
 * them completes in an order fixed by the code that drives it. They stand in for TCP sockets where node:http needs one
 * (a server's 'connection', a client's createConnection). Each end delivers what it reads in the async context it was
 * bound in (`bind`), as a real socket's events run in the context of whoever opened it: a node's server hears its
 * requests as that node, not as the client that sent them.
 */
export function socketPair(options: { local?: string; remote?: string } = {}): [SimSocket, SimSocket] {
  // Each end's remoteAddress is the other's address.
  const a = new SimSocket(options.remote ?? "10.0.0.2"), b = new SimSocket(options.local ?? "10.0.0.1");
  a.peer = b; b.peer = a;
  return [a, b];
}

export class SimSocket extends Duplex {
  private scope?: AsyncResource;
  /** Deliver what this end reads in the current async context from now on. */
  bind() { this.scope = new AsyncResource("SimSocket"); return this; }
  private deliver(work: () => void) { if (this.scope) this.scope.runInAsyncScope(work); else work(); }
  peer?: SimSocket;
  readonly remoteAddress: string;
  readonly remotePort = 40000;
  readonly localAddress = "10.0.0.0";
  readonly remoteFamily = "IPv4";
  connecting = false;
  readonly encrypted = false;
  private ended = false;

  constructor(remoteAddress: string) {
    super({ allowHalfOpen: true });
    this.remoteAddress = remoteAddress;
  }
  override _read() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    const peer = this.peer;
    process.nextTick(() => { if (peer && !peer.destroyed) peer.deliver(() => peer.push(chunk)); done(); });
  }
  override _final(done: (error?: Error | null) => void) {
    const peer = this.peer;
    process.nextTick(() => { if (peer && !peer.ended) { peer.ended = true; peer.deliver(() => peer.push(null)); } done(); });
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void) {
    const peer = this.peer;
    this.peer = undefined;
    if (peer && !peer.destroyed) process.nextTick(() => peer.deliver(() => peer.destroy()));
    done(error);
  }
  // What node:http calls on a net.Socket.
  setTimeout(_ms: number, callback?: () => void) { if (callback) this.once("timeout", callback); return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  address() { return { address: this.localAddress, family: "IPv4", port: 80 }; }
}

import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions, type Server } from "node:http";
import { Duplex, Readable } from "node:stream";
import type { Network } from "../../src/node-context.ts";
import { socketPair } from "./duplex.ts";

/**
 * The simulated network: every host (a runtime node, the fake model provider, a client) is a name under `.sim` with an
 * address of its own, served by an http.Server that never listens. A connection is a pair of in-memory sockets
 * (duplex.ts) handed to the server as a 'connection', so HTTP between hosts, SSE included, runs through node:http as it
 * does over TCP, but with no real I/O. Each host reaches the others through its own `Network` (`networkFor`), which a
 * fault can cut: a partition between two hosts makes connections between them fail (`refused`) or never answer (`blackhole`).
 */
export class SimNet {
  private readonly hosts = new Map<string, { address: string; server?: Server; enter?: <T>(work: () => T) => T }>();
  /** Cut links, as "from to" (one direction each). */
  private readonly cuts = new Map<string, "refused" | "blackhole">();
  /** Every connection made, for the trace: `from -> to`. */
  readonly connections: string[] = [];
  /** Connections open now, with their ends. */
  private readonly open = new Set<{ from: string; to: string; ends: Duplex[] }>();

  /**
   * Add a host, served by `server` (none: a host that only makes requests, such as a client). `enter` runs work as the
   * host (a node's context), so its server hears connections as itself.
   */
  add(host: string, server?: Server, enter?: <T>(work: () => T) => T) {
    const known = this.hosts.get(host);
    this.hosts.set(host, { address: known?.address ?? `10.0.${Math.floor(this.hosts.size / 250)}.${(this.hosts.size % 250) + 1}`, server, enter });
  }
  /** A host that went away (a crashed node): its connections drop, and new ones are refused until it is added again. */
  remove(host: string) {
    const known = this.hosts.get(host);
    if (known) known.server = undefined;
    for (const connection of this.open) {
      if (connection.from !== host && connection.to !== host) continue;
      this.open.delete(connection);
      for (const end of connection.ends) end.destroy();
    }
  }
  address(host: string) {
    const known = this.hosts.get(host);
    if (!known) throw new Error(`Unknown simulated host ${host}`);
    return known.address;
  }
  /** The host at `address`, for a server that wants to know who called. */
  hostOf(address: string) {
    for (const [host, entry] of this.hosts) if (entry.address === address) return host;
    return undefined;
  }

  /** Cut `from` off from `to` (one way unless `both`). */
  cut(from: string, to: string, how: "refused" | "blackhole" = "refused", both = true) {
    this.cuts.set(`${from} ${to}`, how);
    if (both) this.cuts.set(`${to} ${from}`, how);
  }
  heal(from?: string, to?: string) {
    if (from === undefined) { this.cuts.clear(); return; }
    this.cuts.delete(`${from} ${to}`);
    this.cuts.delete(`${to} ${from}`);
  }

  /**
   * A connection from `from` to `to`: the client end, or an error code. The server end goes to `to`'s server. A
   * blackholed connection never connects and never fails: the caller's own timeout ends it.
   */
  private connect(from: string, to: string): Duplex | "ECONNREFUSED" | "ENOTFOUND" | "blackhole" {
    const target = this.hosts.get(to);
    if (!target) return "ENOTFOUND";
    const cut = this.cuts.get(`${from} ${to}`);
    if (cut === "blackhole") return "blackhole";
    if (cut === "refused" || !target.server) return "ECONNREFUSED";
    this.connections.push(`${from} -> ${to}`);
    const [client, server] = socketPair({ local: this.hosts.get(from)?.address, remote: target.address });
    client.bind();
    const connection = { from, to, ends: [client, server] };
    this.open.add(connection);
    client.once("close", () => this.open.delete(connection));
    const accept = () => { server.bind(); target.server!.emit("connection", server); };
    if (target.enter) target.enter(accept); else accept();
    return client;
  }

  /** A socket that fails as `code`, or (blackholed) never does anything. */
  private failing(code: "ECONNREFUSED" | "ENOTFOUND" | "blackhole") {
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
    Object.assign(socket, { connecting: true, setTimeout: () => socket, setNoDelay: () => socket, setKeepAlive: () => socket, ref: () => socket, unref: () => socket });
    if (code !== "blackhole") process.nextTick(() => socket.destroy(Object.assign(new Error(`connect ${code}`), { code })));
    return socket;
  }

  /** The network as `from` sees it. */
  networkFor(from: string): Network {
    const request = ((url: string | URL, options: RequestOptions | ((response: IncomingMessage) => void), callback?: (response: IncomingMessage) => void): ClientRequest => {
      if (typeof options === "function") { callback = options; options = {}; }
      const target = new URL(url);
      return httpRequest(target, {
        ...options,
        createConnection: () => {
          const socket = this.connect(from, target.hostname);
          return (typeof socket === "string" ? this.failing(socket) : socket) as never;
        },
      }, callback);
    }) as Network["request"];
    const fetch: Network["fetch"] = async (input, init) => {
      const asked = new Request(input, init);
      const body = asked.body ? Buffer.from(await asked.arrayBuffer()) : undefined;
      const signal = asked.signal;
      signal.throwIfAborted();
      return new Promise<Response>((resolve, reject) => {
        const headers: Record<string, string> = {};
        asked.headers.forEach((value, name) => { headers[name] = value; });
        if (body) headers["content-length"] = String(body.length);
        const sent = request(asked.url, { method: asked.method, headers }, answer => {
          const stream = Readable.toWeb(answer) as ReadableStream<Uint8Array>;
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(answer.headers)) {
            if (Array.isArray(value)) for (const one of value) responseHeaders.append(name, one); else if (value !== undefined) responseHeaders.set(name, value);
          }
          const status = answer.statusCode ?? 502;
          resolve(new Response(status === 204 || status === 304 || asked.method === "HEAD" ? null : stream, { status, statusText: answer.statusMessage, headers: responseHeaders }));
        });
        const abort = () => sent.destroy(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        signal.addEventListener("abort", abort, { once: true });
        sent.on("error", error => { signal.removeEventListener("abort", abort); reject(signal.aborted ? signal.reason : Object.assign(new TypeError("fetch failed"), { cause: error })); });
        sent.on("close", () => signal.removeEventListener("abort", abort));
        sent.end(body);
      });
    };
    return {
      fetch,
      // The outbound guard's own dispatcher is undici's; here its checks have run, and the request goes as any other.
      guardedFetch: ((input: string | URL, init?: RequestInit & { dispatcher?: unknown }) => {
        const { dispatcher: _dispatcher, ...rest } = init ?? {};
        return fetch(String(input), rest as RequestInit);
      }) as unknown as Network["guardedFetch"],
      resolve: async hostname => {
        const known = this.hosts.get(hostname);
        if (!known) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
        return [{ address: known.address, family: 4 }];
      },
      request,
      connect: ((options: { host: string; port: number }) => {
        const socket = this.connect(from, options.host);
        if (typeof socket === "string") return this.failing(socket);
        // Only whether something answers: the probe closes it at once.
        process.nextTick(() => socket.emit("connect"));
        return socket;
      }) as unknown as Network["connect"],
    };
  }
}

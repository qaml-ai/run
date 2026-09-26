import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { canonical } from "../shared/durable-json.ts";
import { errorText } from "./protocol.ts";
import type { Outbound } from "./outbound.ts";
import type { Progress } from "./tool-servers.ts";

/**
 * Remote MCP servers as a tool source. Connections are made lazily, one per tenant
 * and server (URL and credentials) on each node, shared by every agent that uses
 * that server, and closed when idle. Tool lists are cached for a while and dropped
 * when the server says its list changed. Every request goes through the outbound
 * guard, with the server's credentials sent to its own origin only.
 */
/**
 * `token` mints the Authorization for each request (the runtime's identity tokens); such a
 * server gets its own connection per `scope` (an agent), since its tokens name the agent.
 */
export interface McpServer { url: string; headers: Record<string, string>; token?: () => Promise<string>; scope?: string }
type Connection = {
  key: string; server: McpServer;
  client?: Client; connecting?: Promise<Client>;
  tools?: { list: Tool[]; at: number }; listing?: Promise<Tool[]>;
  lastUsed: number;
};

const TOOLS_TTL_MS = 5 * 60_000;
const IDLE_MS = 10 * 60_000;
const MAX_CONNECTIONS = 256;
const MAX_TOOLS = 512;
const CONNECT_TIMEOUT_MS = 15_000;

export class McpConnections {
  private readonly outbound: Outbound;
  private readonly connections = new Map<string, Connection>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(options: { outbound: Outbound }) {
    this.outbound = options.outbound;
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  private key(tenant: string, server: McpServer) {
    return createHash("sha256").update(canonical({ tenant, url: server.url, headers: server.headers, ...(server.token ? { scope: server.scope ?? "" } : {}) })).digest("hex");
  }

  private connection(tenant: string, server: McpServer) {
    const key = this.key(tenant, server);
    let connection = this.connections.get(key);
    if (!connection) {
      connection = { key, server, lastUsed: Date.now() };
      this.connections.set(key, connection);
      if (this.connections.size > MAX_CONNECTIONS) {
        const oldest = [...this.connections.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
        this.drop(oldest);
      }
    }
    connection.lastUsed = Date.now();
    return connection;
  }

  /** Requests to the server's own origin carry its credentials; anything else goes without them. */
  private fetcher(server: McpServer): FetchLike {
    return async (url, init) => this.outbound.fetch(url, {
      ...init as RequestInit, secrets: server.token ? { ...server.headers, Authorization: `Bearer ${await server.token()}` } : server.headers,
      timeoutMs: CONNECT_TIMEOUT_MS, maxBytes: 8 * 1024 * 1024,
      // A response may be an event stream carrying the answer (or the server's notifications): only its start is timed.
      stream: true,
    });
  }

  private client(connection: Connection): Promise<Client> {
    if (connection.client) return Promise.resolve(connection.client);
    return connection.connecting ??= (async () => {
      const url = this.outbound.check(connection.server.url);
      const open = async (transport: StreamableHTTPClientTransport | SSEClientTransport) => {
        const client = new Client({ name: "agent-runtime", version: "1.0.0" }, { capabilities: {} });
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { connection.tools = undefined; });
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
        return client;
      };
      let client: Client;
      try { client = await open(new StreamableHTTPClientTransport(url, { fetch: this.fetcher(connection.server), reconnectionOptions: { maxRetries: 2, initialReconnectionDelay: 1_000, maxReconnectionDelay: 30_000, reconnectionDelayGrowFactor: 2 } })); }
      catch (error) {
        // Servers from before Streamable HTTP answer its POST with 404 or 405: use their SSE transport.
        if (!(error instanceof StreamableHTTPError && [400, 404, 405].includes(error.code ?? 0))) throw error;
        client = await open(new SSEClientTransport(url, { fetch: this.fetcher(connection.server) }));
      }
      client.onclose = () => { if (connection.client === client) { connection.client = undefined; connection.tools = undefined; } };
      connection.client = client;
      return client;
    })().finally(() => { connection.connecting = undefined; });
  }

  /** The server's tools, from the cache when it is fresh. */
  async tools(tenant: string, server: McpServer): Promise<Tool[]> {
    const connection = this.connection(tenant, server);
    if (connection.tools && Date.now() - connection.tools.at < TOOLS_TTL_MS) return connection.tools.list;
    return connection.listing ??= this.retrying(connection, async client => {
      const list: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout: CONNECT_TIMEOUT_MS });
        list.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor && list.length < MAX_TOOLS);
      connection.tools = { list: list.slice(0, MAX_TOOLS), at: Date.now() };
      return connection.tools.list;
    }).finally(() => { connection.listing = undefined; });
  }

  /** The server's tools as this node last listed them, and when, without connecting; undefined if it has not. */
  cached(tenant: string, server: McpServer): { list: Tool[]; at: number } | undefined {
    return this.connections.get(this.key(tenant, server))?.tools;
  }

  /** Call a tool; `onProgress` hears the progress the server reports for it (the call gets a progressToken). */
  async call(tenant: string, server: McpServer, name: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number, meta?: Record<string, unknown>, onProgress?: (progress: Progress) => void) {
    const connection = this.connection(tenant, server);
    return this.retrying(connection, client => client.callTool({ name, arguments: args, ...(meta && Object.keys(meta).length ? { _meta: meta } : {}) }, undefined, { signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs, ...(onProgress ? { onprogress: onProgress } : {}) }));
  }

  /**
   * Run `work` on the connection. A session the server no longer knows (404) never ran the
   * request, so it is retried once on a new connection; any other failure is the caller's.
   */
  private async retrying<T>(connection: Connection, work: (client: Client) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.client(connection).catch(error => { this.drop(connection); throw new Error(`Could not connect to MCP server ${new URL(connection.server.url).host}: ${errorText(error)}`); });
      try { return await work(client); }
      catch (error) {
        if (attempt === 0 && error instanceof StreamableHTTPError && error.code === 404) { this.reset(connection, client); continue; }
        throw error;
      }
    }
  }

  private reset(connection: Connection, client: Client) {
    if (connection.client === client) { connection.client = undefined; connection.tools = undefined; }
    void client.close().catch(() => {});
  }

  private drop(connection: Connection) {
    if (this.connections.get(connection.key) === connection) this.connections.delete(connection.key);
    if (connection.client) this.reset(connection, connection.client);
  }

  private sweep() {
    for (const connection of [...this.connections.values()]) if (Date.now() - connection.lastUsed > IDLE_MS && !connection.connecting && !connection.listing) this.drop(connection);
  }

  async close() {
    clearInterval(this.timer);
    for (const connection of [...this.connections.values()]) this.drop(connection);
  }
}

import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { FRAME_BYTES } from "../shared/client-protocol.ts";

/**
 * The application's attached MCP server, reached over the application's own connection to
 * its agent: the runtime's JSON-RPC messages go out as `mcp` events on the event stream (to
 * the live connection only, never replayed), and the application's come back as POSTs to
 * /clients/:id/mcp naming this connection. The runtime is an ordinary MCP client of it, as
 * of a remote server; a new connection is a new MCP session.
 */
export class AttachedServer implements Transport {
  /** Names this connection: the application's POSTs carry it, so a replaced connection's are refused. */
  readonly id = randomUUID();
  readonly client = new Client({ name: "agent-runtime", version: "1.0.0" });
  /** Settles when the MCP session is initialized; rejects if the application never answers. */
  readonly ready: Promise<void>;
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  /** The application answered: it serves the agent's tools on this connection. */
  initialized = false;
  private closed = false;
  private readonly res: ServerResponse;

  constructor(res: ServerResponse) {
    this.res = res;
    res.on("close", () => void this.close());
    this.ready = this.client.connect(this, { timeout: 10_000 });
    this.ready.then(() => { this.initialized = true; }, () => {});
  }

  get open() { return !this.closed && !this.res.destroyed; }

  /** Whether the application still answers on this connection: an MCP ping, within `ms`. */
  async answers(ms = 2_000) {
    try { await this.client.ping({ timeout: ms }); return true; }
    catch { return false; }
  }

  async start() {}

  async send(message: JSONRPCMessage) {
    if (!this.open) throw new Error("The application disconnected");
    const frame = `data: ${JSON.stringify({ type: "mcp", message })}\n\n`;
    // A client that does not keep up is disconnected, as for any event.
    if (this.res.writableLength + Buffer.byteLength(frame) > 2 * FRAME_BYTES) { this.res.destroy(); throw new Error("The application is not reading its event stream"); }
    this.res.write(frame);
  }

  /** A message the application POSTed. */
  receive(message: JSONRPCMessage) { if (this.open) this.onmessage?.(message); }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

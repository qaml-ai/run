import type { ToolRegistration, ToolExecutionResult, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { HttpError } from "./errors.ts";

export type ToolDefinition = {
  name: string; description?: string; inputSchema?: Record<string, unknown>;
  parameters?: Record<string, unknown>; timeoutMs?: number;
  executionMode?: "parallel" | "sequential"; exposure?: "direct" | "codemode" | "both";
  _meta?: Record<string, unknown>;
};
export type McpResult = { content?: unknown[]; structuredContent?: unknown; isError?: boolean; [key: string]: unknown };
type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void };
type Connection = { id: string; send: (event: unknown) => void; pending: Map<string, Pending>; ready: Promise<unknown>; initialized: boolean; draining: boolean };

/** Attached MCP runs over the SDK's SSE stream, with replies on /mcp. */
export class AttachedTools {
  private current?: Connection;

  get connected() { return !!this.current?.initialized && !this.current.draining; }

  attach(send: (event: unknown) => void, previous?: string, takeover = false) {
    if (this.connected && !takeover && previous !== this.current?.id)
      throw new HttpError(409, "APPLICATION_CONNECTED: another connection serves this agent's tools", "APPLICATION_CONNECTED");
    this.close();
    const connection: Connection = { id: crypto.randomUUID(), send, pending: new Map(), ready: Promise.resolve(), initialized: false, draining: false };
    this.current = connection;
    // Start after the ready frame so SDK replies can name the connection.
    const start = () => {
      connection.ready = this.request(connection, "initialize", {
        protocolVersion: "2025-06-18", capabilities: {},
        clientInfo: { name: "agent-runtime", version: "1.0.0" },
      }, 10_000).then(() => {
        connection.initialized = true;
        connection.send({ type: "mcp", message: { jsonrpc: "2.0", method: "notifications/initialized" } });
      });
      void connection.ready.catch(() => { if (this.current === connection) this.close(); });
    };
    return { id: connection.id, start, close: () => { if (this.current === connection) this.close(); } };
  }

  receive(value: unknown, id: string | null) {
    const connection = this.current;
    if (!connection || id !== connection.id)
      throw new HttpError(409, "APPLICATION_REPLACED: this connection no longer serves tools", "APPLICATION_REPLACED");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Expected an MCP message");
    const message = value as Record<string, unknown>;
    if (message.method === "notifications/camelrun/draining" || message.method === "notifications/agent-runtime/draining") connection.draining = true;
    if (message.id === undefined) return;
    const key = String(message.id), pending = connection.pending.get(key);
    if (!pending) return;
    connection.pending.delete(key);
    if (message.error) pending.reject(new Error(String((message.error as { message?: unknown }).message ?? "MCP request failed")));
    else pending.resolve(message.result);
  }

  close() {
    const connection = this.current;
    this.current = undefined;
    if (!connection) return;
    for (const pending of connection.pending.values())
      pending.reject(Object.assign(new Error("Application connection lost; tool outcome may be unknown"), { code: "connection_lost", outcomeUnknown: true }));
    connection.pending.clear();
  }

  private request(connection: Connection, method: string, params: unknown, timeoutMs: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const cancelled = () => {
        const pending = connection.pending.get(id);
        connection.pending.delete(id);
        connection.send({ type: "mcp", message: { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Tool cancelled" } } });
        pending?.reject(new Error("Attached tool cancelled; its outcome may be unknown"));
      };
      const timeout = setTimeout(() => {
        connection.pending.delete(id);
        connection.send({ type: "mcp", message: { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Tool timeout" } } });
        reject(Object.assign(new Error(`Attached tool timed out after ${timeoutMs}ms; its outcome may be unknown`), { code: "timeout", outcomeUnknown: true }));
      }, timeoutMs);
      signal?.addEventListener("abort", cancelled, { once: true });
      const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener("abort", cancelled); };
      connection.pending.set(id, { resolve: result => { cleanup(); resolve(result); }, reject: error => { cleanup(); reject(error); } });
      try { connection.send({ type: "mcp", message: { jsonrpc: "2.0", id, method, params } }); }
      catch (error) { connection.pending.get(id)?.reject(error as Error); connection.pending.delete(id); }
    });
  }

  async call(name: string, args: unknown, timeoutMs = 300_000, signal?: AbortSignal): Promise<McpResult> {
    const connection = this.current;
    if (!connection || connection.draining) throw Object.assign(new Error("No application is connected to answer this tool call; it did not run"), { code: "not_connected" });
    await connection.ready;
    if (this.current !== connection) throw new Error("Application connection replaced");
    return await this.request(connection, "tools/call", { name, arguments: args }, timeoutMs, signal) as McpResult;
  }

  tools(definitions: ToolDefinition[]): ToolRegistration[] {
    return definitions.map(definition => registration(definition, (args, _api, context) => this.call(definition.name, args, definition.timeoutMs, context?.abortSignal)));
  }
}

/** Keep MCP content and structured values intact at Pi's tool boundary. */
export function toolResult(result: McpResult): ToolExecutionResult {
  const output = (result.content ?? []).flatMap<NonNullable<ToolExecutionResult["output"]>[number]>(part => {
    if (!part || typeof part !== "object") return [];
    const block = part as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text" as const, text: block.text }];
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string")
      return [{ type: "image" as const, data: block.data, mimeType: block.mimeType }];
    return [{ type: "text" as const, text: JSON.stringify(block) }];
  });
  let structuredOutput = result.structuredContent;
  if (structuredOutput === undefined && output.length === 1 && output[0].type === "text") {
    try { structuredOutput = JSON.parse(output[0].text); } catch { structuredOutput = output[0].text; }
  }
  return { output, ...(result.isError ? { isError: true } : structuredOutput !== undefined ? { structuredOutput: structuredOutput as never } : {}) };
}

export function registration(definition: ToolDefinition, call: (args: unknown, api: ToolExecutionApi, context: Context) => Promise<McpResult>): ToolRegistration {
  const exposure = definition.exposure ?? definition._meta?.["agent-runtime/exposure"];
  return {
    name: definition.name, description: definition.description ?? definition.name,
    parameters: definition.parameters ?? definition.inputSchema ?? { type: "object", properties: {}, additionalProperties: true },
    structuredOutputSchema: {},
    replay: "unsafe", ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
    ...(exposure === "codemode" ? { callers: ["tools"] as const } : exposure === "direct" ? { callers: ["model"] as const } : {}),
    execute: async (args, api, context) => toolResult(await call(args, api, context)),
  };
}

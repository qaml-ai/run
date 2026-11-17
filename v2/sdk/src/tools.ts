import { normalizeAgentEvent } from "./sse.ts";
import {
  CamelRunError, type AgentEvent, type LocalTool, type ToolDefinition,
  type WebSocketConstructorLike, type WebSocketLike,
} from "./types.ts";

export function defineTool<TArgs = Record<string, unknown>, TResult = unknown>(tool: LocalTool<TArgs, TResult>): LocalTool<TArgs, TResult> {
  return tool;
}

export function isLocalTool(tool: ToolDefinition | LocalTool<any, any>): tool is LocalTool<any, any> {
  return typeof (tool as LocalTool<any, any>).execute === "function";
}

export function toWireToolDefinition(tool: ToolDefinition | LocalTool<any, any>): ToolDefinition {
  const def: ToolDefinition = { name: tool.name, description: tool.description, parameters: tool.parameters };
  if ("url" in tool && tool.url !== undefined) def.url = tool.url;
  if (tool.headers !== undefined) def.headers = tool.headers;
  if (tool.requiresApproval !== undefined) def.requiresApproval = tool.requiresApproval;
  return def;
}

export function buildAgentWsUrl(baseUrl: string, agentIdOrKey: string, token: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const wsBase = trimmed.startsWith("https://") ? `wss://${trimmed.slice(8)}`
    : trimmed.startsWith("http://") ? `ws://${trimmed.slice(7)}` : trimmed;
  return `${wsBase}/v2/agents/${encodeURIComponent(agentIdOrKey)}/ws?token=${encodeURIComponent(token)}`;
}

function decodeWsPayload(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return String(data);
}

export type ToolEventSubscriber = (event: AgentEvent) => void;
export interface ToolSessionOptions {
  baseUrl: string; agentIdOrKey: string; token: string;
  tools: LocalTool<any, any>[]; WebSocket?: WebSocketConstructorLike;
}

export class ToolSession {
  private readonly tools = new Map<string, LocalTool<any, any>>();
  private readonly subscribers = new Set<ToolEventSubscriber>();
  private readonly ws: WebSocketLike;
  private readonly readyPromise: Promise<void>;
  private closed = false;

  constructor(options: ToolSessionOptions) {
    for (const t of options.tools) this.tools.set(t.name, t);
    const WS = options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketConstructorLike | undefined);
    if (!WS) throw new CamelRunError("No global WebSocket found; pass WebSocket in CamelRunOptions", { code: "websocket_unavailable" });

    this.ws = new WS(buildAgentWsUrl(options.baseUrl, options.agentIdOrKey, options.token));
    let ackResolve: (() => void) | undefined;
    const ackPromise = new Promise<void>((r) => { ackResolve = r; });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      let opened = false;
      const handleOpen = () => {
        if (opened) return;
        opened = true;
        try { this.sendRegisterTools(); }
        catch (err) { reject(err instanceof Error ? err : new Error(String(err))); return; }
        const timer = setTimeout(resolve, 15);
        void ackPromise.then(() => { clearTimeout(timer); resolve(); });
      };
      this.ws.addEventListener("message", (ev) => { void this.handleMessage(ev.data, ackResolve); });
      this.ws.addEventListener("error", (err) => {
        if (!opened) reject(new CamelRunError("Failed to open attached-tool WebSocket", { code: "websocket_error", cause: err }));
      });
      this.ws.addEventListener("close", () => {
        this.closed = true;
        if (!opened) reject(new CamelRunError("Attached-tool WebSocket closed before handshake", { code: "websocket_closed" }));
      });
      if (this.ws.readyState === 1) handleOpen();
      else this.ws.addEventListener("open", handleOpen);
    });
  }

  get isOpen(): boolean { return !this.closed && this.ws.readyState === 1; }
  ready(): Promise<void> { return this.readyPromise; }
  subscribe(listener: ToolEventSubscriber): () => void {
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  setTools(tools: LocalTool<any, any>[]): void {
    this.tools.clear();
    for (const t of tools) this.tools.set(t.name, t);
    if (this.isOpen) this.sendRegisterTools();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.subscribers.clear();
    try { if (this.ws.readyState === 0 || this.ws.readyState === 1) this.ws.close(1000, "client_close"); } catch {}
  }

  private sendRegisterTools(): void {
    this.ws.send(JSON.stringify({ type: "register_tools", tools: Array.from(this.tools.keys()) }));
  }

  private async handleMessage(rawData: unknown, onAck?: () => void): Promise<void> {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(decodeWsPayload(rawData)) as Record<string, unknown>; } catch { return; }
    const t = msg.type;
    if (t === "registered" || t === "tools_registered" || t === "ack" || t === "ready") { onAck?.(); return; }

    if (t === "tool_call" && typeof msg.callId === "string" && typeof msg.name === "string") {
      onAck?.();
      const tool = this.tools.get(msg.name);
      if (!tool) {
        this.safeSend({ type: "tool_result", callId: msg.callId, result: null, error: `Unknown attached tool: ${msg.name}` });
        return;
      }
      try {
        const args = typeof msg.args === "string" ? (JSON.parse(msg.args) as unknown) : (msg.args ?? {});
        const result = await tool.execute(args);
        this.safeSend({ type: "tool_result", callId: msg.callId, result: result === undefined ? null : result, error: null });
      } catch (err) {
        this.safeSend({ type: "tool_result", callId: msg.callId, result: null, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (t === "event" || typeof msg.seq === "number") {
      const event = normalizeAgentEvent(msg);
      for (const sub of this.subscribers) { try { sub(event); } catch {} }
    }
  }

  private safeSend(payload: Record<string, unknown>): void {
    if (!this.closed && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify(payload)); } catch {} }
  }
}

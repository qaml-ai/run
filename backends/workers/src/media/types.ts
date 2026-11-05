/** Host interfaces for source-reused standalone media code. */
export type Outbound = { fetch(address: string | URL, options?: any): Promise<Response> };
export type AgentIdentity = { subject?: string; context?: Record<string, unknown> };
export type UsageRecord = { provider: string; model: string; platform: boolean; kind: string; timestamp: number; usage: { input?: number; output?: number; cost: { total: number } }; images?: number; audioSeconds?: number; transcriptions?: number; speeches?: number; identity?: AgentIdentity; actor?: string; keyScope?: string };
export type ToolDefinition = { name: string; exposure?: string; description: string; parameters: any };
export type McpResult = { content: any[]; structuredContent?: any };
export type ToolFiles = { read(path: string, limit: number): Promise<Uint8Array>; save(name: string, bytes: Uint8Array, type: string): Promise<{ path: string; contentType: string; size: number }> };

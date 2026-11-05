/** Host boundary for unchanged agent policy, without importing the Node server. */
export { HttpError } from './errors.ts';
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  exposure?: string;
  callers?: string[];
  executionMode?: string;
}
export type AgentIdentity = { subject?: string; context?: Record<string, unknown> };
export type UsageRecord = {
  provider: string; model: string; kind?: string; platform?: boolean;
  decisions?: number; timestamp: number; actor?: string; keyScope?: string;
  identity?: AgentIdentity;
  usage: { input: number; output: number; cost: { total: number } };
};
export type McpResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: unknown;
};
export interface Outbound {
  fetch(url: string, options: RequestInit & { secrets?: Record<string, string>; timeoutMs?: number; maxBytes?: number }): Promise<Response>;
}
export const errorStatus = (error: unknown, fallback: number) => {
  const status = (error as { status?: number } | undefined)?.status;
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : fallback;
};
/** Only error classes and lengths leave the request, never state or provider text. */
export function safeError(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number })?.status;
  return `${/^\w{1,40}$/.test(name) ? name : 'Error'}${typeof status === 'number' ? ` ${status}` : ''} (${message.length} chars)`;
}
export function recordDecisionWait(wait: { tenant: string; items: number; waitMs: number; nodeWaitMs: number; queued: number; slots: number }) {
  console.log(JSON.stringify({ type: 'decision_wait', ...wait }));
}

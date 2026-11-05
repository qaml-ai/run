/** Workers infrastructure for unchanged relational policy. No timers are started by a service. */
import type { Message } from '@earendil-works/pi-ai';
export type AgentMessage = Exclude<Message, { role: 'system' }> | { role: 'compactionSummary'; summary: string; timestamp: number };
export const PERSISTENCE_FAILED = "Session persistence failed";
export const clock = () => ({ sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) });
export const network = () => ({ fetch });
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export const recordEventMetrics = (_events: unknown) => {};
export const deliveryLine = (line: unknown) => line;
export const writeMetricLine = (_line: unknown) => {};
export const creditRefused = (_tenant: string, _refused: unknown, _where: string) => {};
export type Outbound = {
  check(url: string): unknown;
  fetch(url: string, init: RequestInit & { timeoutMs?: number; maxBytes?: number }): Promise<Response>;
};
export interface UsageRecord {
  provider?: string; model?: string; kind?: string; platform?: boolean; timestamp?: number;
  requestId?: string; actor?: string; keyScope?: string; identity?: { subject?: string; context?: Record<string, unknown> };
  usage?: Record<string, any>; searches?: number; renders?: number; toolSearch?: number;
  audioSeconds?: number; speechSeconds?: number; images?: number; decisions?: number;
  [key: string]: any;
}

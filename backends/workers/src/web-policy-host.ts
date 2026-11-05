import type { WebRender } from './web-render-policy.ts';
export type UsageRecord = { provider?: string; model?: string; platform?: boolean; searches?: number; renders?: number; usage: { input?: number; output?: number; cacheRead?: number; cost: { total: number } } };
export type FetchOptions = RequestInit & { secrets?: Record<string, string>; timeoutMs?: number; maxBytes?: number; maxRedirects?: number };
export interface Outbound { allowHttp: boolean; withoutOrigins(): Outbound; reachable(url: string | URL): Promise<URL>; fetch(url: string | URL, options?: FetchOptions): Promise<Response> }
export type McpResult = { content: any[]; structuredContent?: unknown };
export type WebFiles = { save(name: string, content: AsyncIterable<Uint8Array>, contentType: string): Promise<{ type: string; path: string; contentType: string; size: number; [key: string]: unknown }> };
export type BuiltinContext = { tenant: string; agent: string; files?: WebFiles };
export type BuiltinServices = { outbound: Outbound; render?: WebRender };
export const jsonResult = (value: unknown): McpResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
export { textual, readCapped, download } from './web-transfer-policy.ts';

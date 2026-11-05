import type { EntryRecord } from '@earendil-works/pi-durable';
import type { Message } from '@earendil-works/pi-ai';

export type RunToolCall = { tool: string; toolCallId: string; innerCallId?: string; ok: boolean; code?: string; agentId?: string };
export type RunToolError = { tool: string; toolCallId: string; innerCallId?: string; code: string; message: string; outcomeUnknown?: true };
type Result = Extract<Message, { role: 'toolResult' }>;
const textOf = (message: Result) => message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
function objectOf(text: string): Record<string, unknown> | undefined {
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; } catch { return undefined; }
}
/** The durable transcript is authoritative after a restart; no transient tool ledger is needed. */
export class RunProjection {
  private active?: string;
  private index = 0;
  private replyIndex?: number;
  private calls = new Map<string, RunToolCall>();
  private errors = new Map<string, RunToolError>();
  readonly requestId: string;
  constructor(requestId: string) { this.requestId = requestId; }
  add(entry: Pick<EntryRecord, 'kind' | 'data' | 'model'>) {
    if (entry.kind === 'camel.prompt') this.active = (entry.data as { requestId?: string })?.requestId;
    for (const message of entry.model ?? []) {
      const index = this.index++;
      if (this.active !== this.requestId) continue;
      if (message.role === 'assistant') {
        if (message.stopReason !== 'error' && message.content.some(part => part.type === 'text' && part.text.trim())) this.replyIndex = index;
        for (const part of message.content) if (part.type === 'toolCall' && this.calls.size < 100 && !this.calls.has(part.id)) this.calls.set(part.id, { tool: part.name, toolCallId: part.id, ok: false, code: 'aborted' });
      }
      if (message.role === 'toolResult') this.result(message);
    }
  }
  private result(message: Result) {
    const call = this.calls.get(message.toolCallId) ?? { tool: message.toolName, toolCallId: message.toolCallId, ok: false };
    const text = textOf(message);
    const value = objectOf(text);
    const code = message.isError ? typeof value?.code === 'string' ? value.code : 'tool_error' : undefined;
    const child = ['delegate', 'spawn_agent'].includes(call.tool) && typeof value?.agentId === 'string' ? value.agentId : undefined;
    if (this.calls.size < 100 || this.calls.has(message.toolCallId)) this.calls.set(message.toolCallId, { tool: call.tool, toolCallId: call.toolCallId, ok: !message.isError, ...(code ? { code } : {}), ...(child ? { agentId: child } : {}) });
    if (message.isError && this.errors.size < 100) this.errors.set(message.toolCallId, { tool: call.tool, toolCallId: call.toolCallId, code: code!, message: typeof value?.message === 'string' ? value.message : text });
    // Pi's codemode result keeps a bounded table of inner calls. Only metadata,
    // never their arguments or result bodies, enters the public run summary.
    const details = message.details as { calls?: { id: number | string; name: string; status: string; error?: string }[] } | undefined;
    if (call.tool === 'codemode' && Array.isArray(details?.calls)) for (const inner of details.calls) {
      if (this.calls.size >= 100) break;
      const innerCallId = String(inner.id), ok = inner.status === 'ok';
      const innerCode = inner.status === 'cancelled' ? 'aborted' : 'tool_error';
      this.calls.set(`${message.toolCallId}:${innerCallId}`, { tool: inner.name, toolCallId: message.toolCallId, innerCallId, ok, ...(!ok ? { code: innerCode } : {}) });
      if (!ok && inner.error && this.errors.size < 100) this.errors.set(`${message.toolCallId}:${innerCallId}`, { tool: inner.name, toolCallId: message.toolCallId, innerCallId, code: innerCode, message: inner.error });
    }
  }
  finish() {
    return { ...(this.replyIndex !== undefined ? { replyIndex: this.replyIndex } : {}), ...(this.calls.size ? { toolCalls: [...this.calls.values()] } : {}), ...(this.errors.size ? { toolErrors: [...this.errors.values()] } : {}) };
  }
}
export function projectRunEntries(requestId: string, entries: Iterable<Pick<EntryRecord, 'kind' | 'data' | 'model'>>) {
  const projection = new RunProjection(requestId);
  for (const entry of entries) projection.add(entry);
  return projection.finish();
}

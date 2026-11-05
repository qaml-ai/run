import { TOOL_DEADLINES, timedOut } from './tool-call-policy.ts';
import type { ToolCallSite } from './tool-call-context.ts';

export type Progress = { progress: number; total?: number; message?: string };
export type ToolProgressEvent = { type: 'tool_execution_update'; toolCallId: string; toolName: string; partialResult: { content: { type: 'text'; text: string }[]; details: { type: 'progress'; tool: string; innerCallId?: string } & Progress } };
export function progressEvent(tool: string, site: ToolCallSite, progress: Progress): ToolProgressEvent {
  return { type: 'tool_execution_update', toolCallId: site.toolCallId, toolName: site.innerCallId ? 'codemode' : tool,
    partialResult: { content: [{ type: 'text', text: progress.message ?? `${progress.progress}${progress.total !== undefined ? `/${progress.total}` : ''}` }],
      details: { type: 'progress', tool, ...(site.innerCallId ? { innerCallId: site.innerCallId } : {}), progress: progress.progress, ...(progress.total !== undefined ? { total: progress.total } : {}), ...(progress.message !== undefined ? { message: progress.message } : {}) } } };
}
/** Source progress pacing: first immediately, latest within each 250 ms window, flush before result. */
export function pacedProgress(publish: (progress: Progress) => Promise<void> | void) {
  let last = 0, pending: Progress | undefined, timer: ReturnType<typeof setTimeout> | undefined, done = false;
  let sent = Promise.resolve();
  const send = (progress: Progress) => { last = Date.now(); sent = sent.then(() => publish(progress)); };
  const release = () => { timer = undefined; if (pending) { const value = pending; pending = undefined; send(value); } };
  return { update(value: Progress) { if (done) return; const delay = last + 250 - Date.now(); if (delay <= 0 && !timer) send(value); else { pending = value; timer ??= setTimeout(release, Math.max(0, delay)); } },
    async flush() { clearTimeout(timer); release(); done = true; await sent; } };
}
/** MCP deadlines bound silence, with the source absolute 20 minute ceiling. */
export function silenceDeadline(ms: number, signal?: AbortSignal) {
  const timeout = new AbortController(), started = Date.now();
  let timer: ReturnType<typeof setTimeout>;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => timeout.abort(timedOut(ms)), Math.max(0, Math.min(ms, TOOL_DEADLINES.maxTotalMs - (Date.now() - started)))); };
  touch();
  return { signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal, touch, close() { clearTimeout(timer); } };
}

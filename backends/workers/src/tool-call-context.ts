import type { ToolExecutionApi, ToolTaskInput } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { callMeta, toolCallKey } from './tool-call-policy.ts';

export type ToolCallSite = { toolCallId: string; innerCallId?: string; assistant?: number; messageIndex?: number };

/** Pi's durable parent/key links retain the public call identity across execution and replay. */
export async function toolCallSite(api: ToolExecutionApi, context: Context = BACKGROUND_CONTEXT): Promise<ToolCallSite> {
  let taskId = api.taskId;
  const seen = new Set<number>();
  let innerCallId: string | undefined;
  while (!seen.has(Number(taskId))) {
    seen.add(Number(taskId));
    const task = await api.getTask(taskId, context);
    if (!task) break;
    const input = task.input as ToolTaskInput;
    if (input.kind === 'model') return { toolCallId: input.callId, assistant: Number(input.assistant), ...(innerCallId ? { innerCallId } : {}) };
    if (input.kind !== 'nested') break;
    innerCallId = innerCallId ? `${input.key}/${innerCallId}` : input.key;
    taskId = input.parent;
  }
  return { toolCallId: api.callId, ...(innerCallId ? { innerCallId } : {}) };
}

export function toolCallMeta(agent: string, site: ToolCallSite, origin?: Record<string, unknown>, actor?: string) {
  return callMeta({ ...site, idempotencyKey: toolCallKey(agent, site.messageIndex, site.toolCallId, site.innerCallId), origin, actor });
}

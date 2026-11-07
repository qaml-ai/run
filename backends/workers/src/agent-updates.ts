import { hook, ToolTask, type Extension, type HookApi } from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';
import { agentUpdates } from './multi-agent-policy.ts';
import { AGENT_UPDATES } from './sender-markers.ts';
import type { Delegation, ShownProgress } from './delegation.ts';

/** The tools that show sub-agents' progress themselves (`Delegation.toolResult`, and list_agents/wait_agent's fields). */
const DELEGATION_TOOLS = new Set(['delegate', 'spawn_agent', 'wait_agent', 'list_agents', 'send_message', 'interrupt_agent', 'report_progress']);
/** Results the Harness writes itself, not a tool's answer: nothing rides on them. */
const NOT_ANSWERED = new Set(['tool_unavailable', 'invalid_arguments', 'blocked', 'interrupted', 'restart_limit', 'aborted', 'abandoned']);
const MEMO = 'camel.agent-updates';

/**
 * Background children's progress rides on the parent's next tool result, whatever the tool, as on Node
 * (client-sessions/tools.ts `pendingUpdates`): the reports it has not seen yet, latest only, in the runtime's own
 * <agent_updates> part. Only a model-issued call's answer carries them (never a nested call's, nor codemode's), and an
 * error result does not. The reports a result shows are a memo of its tool task, so a hook run again after a crash shows
 * the same ones; they are marked shown once they are in it.
 */
export function agentUpdatesExtension(delegation: () => Delegation, assistant: (api: HookApi, callId: string) => Promise<readonly { role: string; content: unknown }[]>): Extension {
  return { name: 'camel.agent-updates', hooks: [hook(ToolTask, {
    async afterTool(call, result, api, context) {
      if (call.parent || call.name === 'codemode' || DELEGATION_TOOLS.has(call.name) || result.isError || result.output === undefined) return;
      if (result.diagnostics?.some(value => NOT_ANSWERED.has(value.code ?? ''))) return;
      if (result.output.some(part => part.type === 'text' && (part as unknown as Record<string, unknown>)[AGENT_UPDATES] === true)) return;
      let reports = await api.memo<JsonValue>(MEMO, context) as ShownProgress[] | undefined;
      if (!reports) {
        const fresh = await delegation().unshownProgress(await assistant(api, call.id));
        if (!fresh.length) return;
        reports = await api.memo<JsonValue>(MEMO, fresh as unknown as JsonValue, context) as unknown as ShownProgress[];
      }
      if (!reports.length) return;
      await delegation().markShown(reports);
      return { ...result, output: [...result.output, agentUpdates(reports)] };
    },
  })] };
}

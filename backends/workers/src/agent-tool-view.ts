import type { AgentConfiguration } from './api-contract.ts';

/** Match the application's MCP catalog as it appears in an agent detail. */
export function agentToolView(config: AgentConfiguration) {
  return (config.mcp?.tools ?? []).map(tool => {
    const meta = tool._meta ?? {};
    const exposure = tool.exposure ?? meta['agent-runtime/exposure'];
    const executionMode = tool.executionMode ?? meta['agent-runtime/executionMode'];
    const timeoutMs = tool.timeoutMs ?? meta['agent-runtime/timeoutMs'];
    return { name: tool.name, description: tool.description || tool.name, parameters: tool.parameters ?? tool.inputSchema,
      ...(exposure !== undefined ? { exposure } : {}), ...(executionMode !== undefined ? { executionMode } : {}),
      ...(tool.needsApproval || meta['agent-runtime/needsApproval'] === true ? { needsApproval: true } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
  });
}

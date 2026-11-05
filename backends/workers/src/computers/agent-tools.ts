import { defineTool } from '@earendil-works/pi-durable';
import { COMMON, SHELL, BROWSER } from './policy.ts';
import { ComputerService, type ComputerEnv } from './service.ts';
export function attachedComputerTools(env: ComputerEnv, identity: () => Promise<{ id: string; tenantId: string }>, serialize: <T>(run: () => Promise<T>) => Promise<T>) {
  return [...COMMON, ...SHELL, ...BROWSER].map(tool => defineTool({
    name: tool.name,
    description: tool.description.replace(' A shell computer mounts its home directory at /computer for the file tools; save results to a volume with cp before stopping.', '').replace(', after copying results to a volume with cp.', '.'),
    parameters: tool.parameters,
    replay: tool.name === 'computer_status' ? 'safe' : 'unsafe',
    async execute(args, api) {
      const config = await identity();
      const value = await serialize(() => new ComputerService(env, config.tenantId).call(config.id, tool.name, args as Record<string, unknown>, api.callId));
      return { output: [{ type: 'text' as const, text: JSON.stringify(value) }] };
    },
  }));
}

import test from 'node:test';
import { z } from 'zod';
import { assertToolSchema } from '../../../tests/tool-schema-assertions.ts';
import { registerHooks } from 'node:module';
import { SEND_MESSAGE_TOOL, SEND_MESSAGE_WITH_AGENTS_TOOL } from '../../../src/core/channels/channels.ts';
// The file tools import the volume Durable Object's module for its helpers. Nothing here may construct one.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: "data:text/javascript,class Unexpected { constructor() { throw new Error('Unexpected Durable Object'); } } export { Unexpected as DurableObject, Unexpected as WorkerEntrypoint };", shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { bashTool } = await import('../src/camelfs/bash.ts');
const { attachedComputerTools } = await import('../src/computers/agent-tools.ts');
const { builtinDefinitions } = await import('../src/web-definitions.ts');
const { builtinDefinitions: inboxDefinitions } = await import('../src/inbox-definitions.ts');
const { agentScheduleTools } = await import('../src/agent-schedules.ts');
const { delegateTool, agentsTools, REPORT_PROGRESS, SEND_MESSAGE } = await import('../src/multi-agent-policy.ts');
const { DECIDE } = await import('../src/decision-policy.ts');
const { GENERATE_IMAGE } = await import('../src/media/images.ts');
const { repoTools } = await import('../src/repos/tools.ts');
const { compatibleFileTools } = await import('../src/fs-tools.ts');
const { tools } = await import('../src/hosted-mcp-tools.ts');
const { askHuman, askUser } = await import('../src/human.ts');
const { hostExecutionTool } = await import('../src/host-execution.ts');
hooks.deregister();

// Every tool the Workers backend can offer a model, built as agent-tools.ts builds them. OpenAI-family APIs refuse a
// request holding one tool whose parameters are not a top-level object. final_output and codemode, which only exist in
// an open harness, are checked by tests/contract/areas/tool-schemas.contract.test.ts on a real model request.
test('every tool a model can receive has a top-level object schema', () => {
  const registrations = [bashTool({} as never), ...attachedComputerTools({} as never, async () => ({ id: 'fixture', tenantId: 'fixture' }), async run => run())];
  registrations.push(askHuman, askUser, hostExecutionTool({} as never), ...compatibleFileTools(repoTools({} as never, 'fixture', 'fixture')), ...agentScheduleTools(['schedule'], {} as never));
  for (const tool of registrations) assertToolSchema(tool.name, tool.parameters);
  for (const tool of tools(() => ({} as never))) assertToolSchema(tool.name, z.toJSONSchema(z.object(tool.input)));
  const builtins = ['web_fetch', 'web_search', 'x_search', 'ask_user', 'request_decision'];
  for (const tool of [...builtinDefinitions(builtins), ...inboxDefinitions(builtins), GENERATE_IMAGE, DECIDE, REPORT_PROGRESS, SEND_MESSAGE, SEND_MESSAGE_TOOL, SEND_MESSAGE_WITH_AGENTS_TOOL, delegateTool({ instructions: true }, () => undefined), ...agentsTools({ instructions: true }, () => undefined)]) assertToolSchema(tool.name, tool.parameters);
});

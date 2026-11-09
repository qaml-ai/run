import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { assertToolSchema } from '../../../tests/tool-schema-assertions.ts';
import { registerHooks } from 'node:module';
import { SEND_MESSAGE_TOOL, SEND_MESSAGE_WITH_AGENTS_TOOL } from '../../../src/core/channels/channels.ts';
// The file tools import the volume Durable Object's module for its helpers. Nothing here may construct one.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: "data:text/javascript,class Unexpected { constructor() { throw new Error('Unexpected Durable Object'); } } export { Unexpected as DurableObject, Unexpected as WorkerEntrypoint };", shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { computerTool, computerParameters, validateComputerRequest } = await import('../src/computers/tool.ts');
const { attachedComputerTools } = await import('../src/computers/agent-tools.ts');
const { builtinDefinitions } = await import('../src/web-definitions.ts');
const { builtinDefinitions: inboxDefinitions } = await import('../src/inbox-definitions.ts');
const { agentScheduleTools } = await import('../src/agent-schedules.ts');
const { delegateTool, agentsTools, REPORT_PROGRESS, SEND_MESSAGE } = await import('../src/multi-agent-policy.ts');
const { DECIDE } = await import('../src/decision-policy.ts');
const { GENERATE_IMAGE } = await import('../src/media/images.ts');
const { volumeTools } = await import('../src/files.ts');
const { compatibleFileTools } = await import('../src/fs-tools.ts');
const { tools } = await import('../src/hosted-mcp-tools.ts');
const { askHuman, askUser } = await import('../src/human.ts');
const { hostExecutionTool } = await import('../src/host-execution.ts');
hooks.deregister();

// Every tool the Workers backend can offer a model, built as agent-tools.ts builds them. OpenAI-family APIs refuse a
// request holding one tool whose parameters are not a top-level object. final_output and codemode, which only exist in
// an open harness, are checked by tests/contract/areas/tool-schemas.contract.test.ts on a real model request.
test('every tool a model can receive has a top-level object schema', () => {
  const registrations = [computerTool({}, 'fixture'), ...attachedComputerTools({} as never, async () => ({ id: 'fixture', tenantId: 'fixture' }), async run => run())];
  registrations.push(askHuman, askUser, hostExecutionTool({} as never), ...compatibleFileTools(volumeTools({} as never, 'fixture', 'fixture')), ...agentScheduleTools(['schedule'], {} as never));
  for (const tool of registrations) assertToolSchema(tool.name, tool.parameters);
  for (const tool of tools(() => ({} as never))) assertToolSchema(tool.name, z.toJSONSchema(z.object(tool.input)));
  const builtins = ['web_fetch', 'web_search', 'x_search', 'ask_user', 'request_decision'];
  for (const tool of [...builtinDefinitions(builtins), ...inboxDefinitions(builtins), GENERATE_IMAGE, DECIDE, REPORT_PROGRESS, SEND_MESSAGE, SEND_MESSAGE_TOOL, SEND_MESSAGE_WITH_AGENTS_TOOL, delegateTool({ instructions: true }, () => undefined), ...agentsTools({ instructions: true }, () => undefined)]) assertToolSchema(tool.name, tool.parameters);
  assert.equal(computerParameters.type, 'object');
  assert.deepEqual(computerParameters.required, ['provider', 'op']);
  assert.equal(computerParameters.additionalProperties, false);
  assert.deepEqual(Object.keys(computerParameters.properties), ['provider', 'op', 'command', 'argv', 'timeoutMs', 'path', 'content', 'format', 'name']);
  assert.deepEqual(computerParameters.properties.op.enum, ['exec', 'read', 'write', 'parse', 'snapshot', 'restore', 'sleep']);
  // Each optional field says which operation takes it.
  for (const [name, schema] of Object.entries<any>(computerParameters.properties).slice(2)) assert.match(schema.description, /^(exec|read|write|parse|snapshot|restore)[,:]/, name);
});

test('computer validates operation combinations before dispatch', async () => {
  const dispatched: any[] = [];
  const tool = computerTool({ COMPUTER_CONTAINERS: { getByName: () => ({ operate: async (request: unknown) => { dispatched.push(request); return {}; } }) } } as never, 'fixture');
  for (const request of [
    { op: 'exec', command: 'true' }, { op: 'exec', argv: ['true'], timeoutMs: 600000 },
    { op: 'read', path: '/workspace/a' }, { op: 'write', path: 'a', content: '' },
    { op: 'parse', path: 'a', format: 'json' }, { op: 'snapshot', name: 'save' },
    { op: 'restore', name: 'save' }, { op: 'sleep' },
  ]) await tool.execute({ provider: 'container', ...request } as never, undefined as never, undefined as never);
  assert.equal(dispatched.length, 8);
  assert.equal(dispatched[2].path, 'a');
  for (const [request, error] of [
    [{ op: 'exec' }, /^exec needs command or argv$/],
    [{ op: 'exec', command: 'true', argv: ['true'] }, /^exec takes command or argv, not both$/],
    [{ op: 'exec', command: '' }, /^Invalid computer request: /],
    [{ op: 'exec', argv: [] }, /^Invalid computer request: /],
    [{ op: 'exec', command: 'true', timeoutMs: 600001 }, /^Invalid computer request: /],
    [{ op: 'exec', command: 'true', path: 'a' }, /^exec does not take path$/],
    [{ op: 'read' }, /^read needs path$/],
    [{ op: 'write', path: 'a' }, /^write needs content$/],
    [{ op: 'write' }, /^write needs path and content$/],
    [{ op: 'parse', path: 'a' }, /^parse needs format$/],
    [{ op: 'parse', path: 'a', format: 'pdf' }, /^Invalid computer request: /],
    [{ op: 'snapshot' }, /^snapshot needs name$/],
    [{ op: 'snapshot', name: '../bad' }, /^Invalid computer request: /],
    [{ op: 'restore', name: 'save', path: 'a' }, /^restore does not take path$/],
    [{ op: 'sleep', command: 'true' }, /^sleep does not take command$/],
    [{ op: 'reboot' }, /^Unknown computer op: /],
  ] as const) {
    assert.throws(() => validateComputerRequest({ provider: 'container', ...request }), { message: error });
    await assert.rejects(tool.execute({ provider: 'container', ...request } as never, undefined as never, undefined as never), { message: error });
  }
  assert.equal(dispatched.length, 8, 'invalid calls never reach the computer');
});

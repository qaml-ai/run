import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantEntry, Harness, ToolTask, createRegistry } from '@earendil-works/pi-durable';
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory';
import { createModels } from '@earendil-works/pi-ai';
import { InlineCodemodeSandbox, loadQuickJSWasm } from '@earendil-works/pi-codemode';
import { workflowTools } from '../src/workflow.ts';
import { workflowSettings } from '../src/workflow-policy.ts';
import type { Delegation } from '../src/delegation.ts';

test('workflow configuration reuses source target and builtin requirements', () => {
  assert.throws(() => workflowSettings(['workflow'], undefined), /needs workflow/);
  assert.throws(() => workflowSettings([], { instructions: true }), /workflow builtin/);
  assert.throws(() => workflowSettings(['workflow'], { instructions: true, maxParallel: 65 }), /maxParallel/);
  assert.deepEqual(workflowSettings(['workflow'], { agents: ['worker'], maxAgents: 5 }), { agents: [{ name: 'worker', definition: 'worker' }], maxAgents: 5 });
});

test('native workflow scripts keep structured answers, progress and bounded parallel children', async () => {
  const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
  const events: any[] = [], calls: any[] = [];
  let active = 0, peak = 0;
  const delegation = {
    targetDescriptions: async () => () => 'Does one item',
    start: async (args: any, key: string, _signal: unknown, _background: unknown, _api: unknown, settings: any) => {
      if (args.agent === 'missing') throw new Error('Unknown agent');
      assert.equal(settings.maxParallel, 2);
      calls.push({ args, key }); active++; peak = Math.max(active, peak);
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
      return { id: key, requestId: key, status: 'completed', value: args.output ? { items: ['a', 'b'] } : args.task };
    },
    wait: async (child: unknown) => child,
    answer: (child: any) => ({ agentId: child.id, requestId: child.requestId, status: child.status, output: child.value }),
    cancel: async (_request: string, prefix: string) => { assert.equal(prefix, 'workflow:workflow:'); },
  } as unknown as Delegation;
  const tools = await workflowTools({ sandbox, delegation, settings: { agents: [{ name: 'worker', definition: 'worker' }], maxParallel: 2 }, context: async () => ({ id: 'run' }), emit: async event => { events.push(event); } });
  const registry = createRegistry(); registry.install({ name: 'workflow', tools });
  const pi = await Harness.open(new MemoryStorage(), { registry, models: createModels() }, context);
  try {
    assert.match(tools[0].description!, /worker: Does one item/);
    assert.deepEqual(tools[1].callers, ['tools']);
    const root = await pi.root(context, { agent: { tools } });
    const script = `export const meta = { name: 'scan' };
phase('list');
const list = await agent('list', { agent: 'worker', schema: { type: 'object' } });
phase('each');
const out = await pipeline(list.items, item => agent(item, { agent: 'worker' }));
const missing = await agent('fail', { agent: 'missing' });
log('finished');
return { out, missing, args };`;
    const task = await pi.commit(async tx => {
      const assistant = await tx.appendEntry(AssistantEntry, root.id, { model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'workflow', name: 'run_workflow', arguments: { script, args: { exact: true } } }], stopReason: 'toolUse' } as never] });
      return tx.createTask(ToolTask, { kind: 'model', assistant: assistant.id, callId: 'workflow' }, { ownership: { kind: 'conversation' }, conversationId: root.id });
    }, context);
    const result = await pi.waitForTask(task, context);
    assert.equal(result.state.outcome.status, 'completed');
    const history = await root.entries({}, 10, undefined, context);
    const message = history.items.flatMap(entry => entry.model ?? []).find(message => message.role === 'toolResult') as any;
    assert.equal(!!message.isError, false, JSON.stringify(message));
    const value = JSON.parse(message.content[0].text);
    assert.deepEqual(value.value, { out: ['a', 'b'], missing: null, args: { exact: true } });
    assert.equal(value.agents.length, 4);
    assert.equal(value.agents.at(-1).status, 'failed');
    assert.equal(peak, 2);
    assert.equal(new Set(calls.map(call => call.key)).size, calls.length);
    assert.deepEqual(events.filter(event => event.event.type === 'workflow_progress').map(event => event.event.phase ?? event.event.log), ['list', 'each', 'finished']);
    assert.equal(events.at(-1).event.type, 'workflow_end');
  } finally { await pi.close(context); await sandbox.close(); }
});

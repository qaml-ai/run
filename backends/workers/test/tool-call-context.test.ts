import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { toolCallSite, toolCallMeta } from '../src/tool-call-context.ts';
import { AttachedTools } from '../src/attached-tools.ts';

const key = (agent: string, messageIndex: number | undefined, call: string, inner = '') => createHash('sha256').update(`${agent}:${messageIndex ?? ''}:${call}:${inner}`).digest('hex').slice(0, 32);
const apiFor = (taskId: number, tasks: Record<number, object>) => ({ taskId, callId: 'outer/c1', conversationId: 1, getTask: async (id: number) => tasks[id] }) as unknown as ToolExecutionApi;

test('nested Pi task links retain the outer model call and stable inner key', async () => {
  const api = apiFor(3, { 3: { input: { kind: 'nested', parent: 2, key: 'c1' } }, 2: { input: { kind: 'model', assistant: 9, callId: 'outer' } } });
  const site = await toolCallSite(api);
  assert.deepEqual(site, { toolCallId: 'outer', assistant: 9, innerCallId: 'c1' });
  assert.deepEqual(toolCallMeta('agent', { ...site, messageIndex: 3 }), {
    'agent-runtime/toolCallId': 'outer', 'agent-runtime/innerCallId': 'c1', 'agent-runtime/idempotencyKey': key('agent', 3, 'outer', 'c1'),
  });
  assert.notEqual(toolCallMeta('agent', { ...site, messageIndex: 7 })['agent-runtime/idempotencyKey'], key('agent', 3, 'outer', 'c1'));
  assert.equal(toolCallMeta('agent', site)['agent-runtime/idempotencyKey'], key('agent', undefined, 'outer', 'c1'));
});

test('attached MCP emits source-compatible call metadata and uses the supplied message index', async () => {
  const attached = new AttachedTools();
  let params: any;
  attached.restore('connection', frame => {
    const message = (frame as any).message;
    params = message.params;
    queueMicrotask(() => attached.receive({ id: message.id, result: { content: [{ type: 'text', text: 'done' }] } }, 'connection'));
  });
  const tool = attached.tools([{ name: 'echo' }], async () => ({ claims: { tenant: 't', agent: 'a', act: 'person' }, call: { toolCallId: 'outer', innerCallId: 'c2', messageIndex: 3 } }))[0];
  await tool.execute({}, apiFor(3, {}), {} as never);
  assert.equal(params._meta['agent-runtime/toolCallId'], 'outer');
  assert.equal(params._meta['agent-runtime/innerCallId'], 'c2');
  assert.equal(params._meta['agent-runtime/idempotencyKey'], key('a', 3, 'outer', 'c2'));
  assert.equal(params._meta['agent-runtime/actor'], 'person');
  attached.close();
});

test('attached progress resets the deadline on its matching request only', async () => {
  const attached = new AttachedTools();
  attached.restore('connection', frame => {
    const message = (frame as any).message;
    if (message.method !== 'tools/call') return;
    const timer = setInterval(() => attached.receive({ method: 'notifications/progress', params: { progressToken: message.params._meta.progressToken, progress: 1 } }, 'connection'), 15);
    setTimeout(() => {
      clearInterval(timer);
      attached.receive({ id: message.id, result: { content: [{ type: 'text', text: 'done' }] } }, 'connection');
    }, 75);
  });
  assert.equal((await attached.call('slow', {}, 40)).content?.length, 1);
  attached.close();
});

test('attached timeout reports a source-class unknown outcome', async () => {
  const attached = new AttachedTools();
  attached.restore('connection', () => {});
  await assert.rejects(attached.call('slow', {}, 5), error => {
    assert.equal((error as any).code, 'timeout');
    assert.equal((error as any).outcomeUnknown, true);
    assert.match((error as Error).message, /No answer within 5 ms/);
    return true;
  });
  attached.close();
});

test('approval prompt lists exactly the source-gated tools', async () => {
  const { approvalPrompt } = await import('../src/tool-approval-prompt.ts');
  const { approvalFor } = await import('../src/tool-call-policy.ts');
  assert.equal(approvalFor({ default: 'destructive' }, 'read', false), 'never');
  assert.equal(approvalFor({ default: 'destructive' }, 'delete', true), 'always');
  assert.equal(approvalFor({ default: 'always', tools: { read: 'never' } }, 'read', false), 'never');
  assert.deepEqual(approvalPrompt([{ name: 'read' }, { name: 'delete', needsApproval: true }]), ['- The user approves each call of these tools before it runs, which pauses your turn until they answer: delete.']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decider, decisionRequest, decisionsAnswer, checkedAnswers } from '../src/decision-policy.ts';
import { delegateInput, delegateSettings } from '../src/multi-agent-policy.ts';
import { Delegation, type DelegationHost } from '../src/delegation.ts';

const questions = { valid: { type: 'noul' as const, instructions: 'Is valid?' } };
const signal = () => new AbortController().signal;
test('stock decision policy validates before sending and enforces maxUsd', async () => {
  let calls = 0;
  const decider = new Decider({ key: async () => ({ apiKey: 'fixture', platform: false }), provider: { id: 'fixture', async decide() { calls++; return { answers: { valid: { noul: 1 } }, inputTokens: 1, outputTokens: 1 }; } } });
  assert.throws(() => decisionRequest({ state: 'x', questions: { q: { type: 'choice', instructions: 'x', criteria: { only: '' } } } }));
  await assert.rejects(decider.decide({ tenant: 'test' }, decisionRequest({ state: 'x', questions, maxUsd: 1e-9 }), signal()), /more than maxUsd/);
  assert.equal(calls, 0);
});
test('stock decision policy retains batch ordering and bills only validated answers', async () => {
  const decider = new Decider({ key: async () => ({ apiKey: 'fixture', platform: true }), provider: { id: 'fixture', async decide(item) { return { answers: item.state === 'bad' ? {} : { valid: { noul: 1.5 } }, inputTokens: 4, outputTokens: 2, costUsd: 0.01 }; } } });
  const request = decisionRequest({ items: [{ state: 'ok', questions }, { state: 'bad', questions }] });
  const result = await decider.decide({ tenant: 'test' }, request, signal());
  assert.equal(result.costUsd, 0.01);
  assert.equal(result.usage?.decisions, 1);
  assert.deepEqual(result.results[0], { answers: { valid: { type: 'noul', noul: 1 } }, usage: { inputTokens: 4, outputTokens: 2 }, costUsd: 0.01 });
  assert.ok('error' in result.results[1]);
  assert.throws(() => decisionsAnswer({ ...result, results: [result.results[1]] }, false));
});
test('stock decision policy normalizes probabilities and refuses unsupported data policy', async () => {
  assert.deepEqual(checkedAnswers(questions, { valid: { noul: -1 } }), { valid: { type: 'noul', noul: 0 } });
  const decider = new Decider({ key: async () => ({ apiKey: 'fixture', platform: false }), provider: { id: 'fixture', async decide() { throw new Error('must not send'); } } });
  await assert.rejects(decider.decide({ tenant: 'test', dataCollection: 'deny' }, decisionRequest({ state: 'x', questions }), signal()), /cannot honour/);
});
test('stock delegation configuration validates named targets and depth ceilings', () => {
  assert.deepEqual(delegateInput({ instructions: true, maxDepth: 3 }), { instructions: true, maxDepth: 3 });
  assert.throws(() => delegateInput({ instructions: true, maxDepth: 6 }));
  assert.throws(() => delegateSettings(['delegate'], undefined));
  assert.deepEqual(delegateSettings(['delegate'], { agents: ['helper'] })?.agents, [{ name: 'helper', definition: 'helper' }]);
});
function fixture() {
  const values = new Map<string, unknown>();
  const storage = { get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }, delete: async (key: string) => values.delete(key), list: async ({ prefix }: { prefix: string }) => new Map([...values].filter(([key]) => key.startsWith(prefix))), transaction: async (run: (tx: unknown) => unknown) => run(storage) };
  const events: any[] = [], submitted: any[] = [], tasks: Promise<unknown>[] = [];
  let run: any = { id: 'parent-run' }, made = 0, parentId = 'parent';
  const host: DelegationHost = {
    storage: storage as unknown as DurableObjectStorage, secret: 'test-only-delegation-secret',
    context: async () => ({ id: parentId, config: { model: 'test/echo', delegate: { instructions: true, maxDepth: 2, maxParallel: 2 }, spendLimit: { usd: 0.1 } }, run }),
    create: async () => ({ id: `child-${++made}` }), target: async () => { throw new Error('unexpected target'); },
    fetch: async (_id, request) => {
      if (new URL(request.url).pathname === '/events') return new Response('');
      if (request.method === 'POST') { submitted.push(await request.json()); return Response.json({ state: 'running' }); }
      return Response.json({ state: 'completed', status: 'completed', outcome: { result: { reply: 'helped', usage: { costUsd: 0.01 } } } });
    },
    emit: async event => { events.push(event); }, waitUntil: promise => { tasks.push(promise); },
  };
  return { delegation: new Delegation(host), host, events, submitted, tasks, setRun: (value: unknown) => { run = value; }, setId: (value: string) => { parentId = value; }, values };
}
test('delegation persists idempotent child, budget and result events', async () => {
  const f = fixture();
  const first = await f.delegation.start({ instructions: 'Be HELPER', task: 'help' }, 'call', signal());
  const done = await f.delegation.wait(first);
  assert.equal(f.delegation.answer(done).text, 'helped');
  assert.equal(f.submitted[0].params.spendLimit.usd, 0.05);
  assert.equal(f.submitted[0].params.metadata.delegationDepth, '1');
  assert.match(f.submitted[0].params.text, /Your role:\nBe HELPER/);
  assert.equal((await f.delegation.start({ instructions: 'Be HELPER', task: 'help' }, 'call', signal())).id, first.id);
  assert.equal(f.submitted.length, 1);
  assert.equal(await f.delegation.cost('parent-run'), 0.01);
  assert.ok(f.events.some(event => event.event.type === 'subagent_start'));
  assert.equal(f.events.filter(event => event.event.type === 'subagent_end').length, 1);
  await Promise.all(f.tasks);
});
test('unsigned metadata cannot raise depth; genuine child metadata keeps the ceiling', async () => {
  const f = fixture();
  f.setRun({ id: 'parent-run', metadata: { delegationDepth: '99', delegationMaxDepth: '99', delegationChain: 'parent' } });
  const first = await f.delegation.start({ instructions: 'helper', task: 'help' }, 'a', signal());
  assert.equal(first.depth, 1);
  assert.equal(f.submitted[0].params.metadata.delegationMaxDepth, '2');
  await Promise.all(f.tasks);
});

test('signed lineage cannot exceed its inherited depth ceiling', async () => {
  const parent = fixture();
  const child = await parent.delegation.start({ instructions: 'helper', task: 'help' }, 'first', signal());
  await Promise.all(parent.tasks);
  const middle = fixture();
  middle.setId(child.id); middle.setRun({ id: child.requestId, metadata: parent.submitted[0].params.metadata });
  const grandchild = await middle.delegation.start({ instructions: 'helper', task: 'help' }, 'second', signal());
  assert.equal(grandchild.depth, 2);
  await Promise.all(middle.tasks);
  const last = fixture();
  last.setId(grandchild.id); last.setRun({ id: grandchild.requestId, metadata: middle.submitted[0].params.metadata });
  await assert.rejects(last.delegation.start({ instructions: 'helper', task: 'help' }, 'third', signal()), /depth limit of 2/);
  assert.equal(last.submitted.length, 0);
});
test('a depleted parent budget refuses a child before creation or submission', async () => {
  const f = fixture(); f.setRun({ id: 'no-budget', params: { spendLimit: { usd: 0 } } });
  await assert.rejects(f.delegation.start({ instructions: 'helper', task: 'help' }, 'a', signal()), /no budget left/);
  assert.equal(f.submitted.length, 0);
  assert.equal((await f.delegation.children()).length, 0);
});
test('recovery notifies completed background children but never direct delegates', async () => {
  const f = fixture(), notified: string[] = [];
  f.host.notify = async child => { notified.push(child.key); };
  const base = { id: 'child', requestId: 'child-run', parentRequestId: 'parent-run', toolCallId: 'call', task: 'go', name: 'helper', depth: 1, root: 'parent', createdAt: 1, endedAt: 2, status: 'completed', made: true, accepted: true };
  f.values.set('delegation:background', { ...base, key: 'background', background: true });
  f.values.set('delegation:direct', { ...base, key: 'direct', background: false });
  await f.delegation.recover();
  await Promise.all(f.tasks);
  assert.deepEqual(notified, ['background']);
  assert.equal((f.values.get('delegation:background') as { notified: boolean }).notified, true);
  await new Delegation(f.host).recover();
  await Promise.all(f.tasks);
  assert.deepEqual(notified, ['background']);
});
test('parent cancellation aborts made children and only its actively running named child', async () => {
  const f = fixture(), aborted: string[] = [];
  const base = { requestId: 'child-run', parentRequestId: 'parent-run', toolCallId: 'call', task: 'go', name: 'helper', depth: 1, createdAt: 1, status: 'running', accepted: true };
  f.values.set('delegation:made', { ...base, id: 'made', key: 'made', made: true });
  f.values.set('delegation:named', { ...base, id: 'named', key: 'named', made: false });
  f.values.set('delegation:queued', { ...base, id: 'queued', key: 'queued', made: false });
  f.host.fetch = async (id, request) => {
    if (request.method === 'POST') { aborted.push(id); return Response.json({}); }
    return Response.json(id === 'named' ? { state: 'running', began: 1 } : { state: 'running' });
  };
  await f.delegation.cancel('parent-run');
  assert.deepEqual(aborted.sort(), ['made', 'named']);
});
async function childFixture() {
  const f = fixture(), secret = f.host.secret;
  const bytes = await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode('delegation-v1:child:child-run:1:2:parent'));
  f.setId('child');
  f.setRun({ id: 'child-run', metadata: { parentAgentId: 'parent', delegationDepth: '1', delegationMaxDepth: '2', delegationChain: 'parent', delegationSignature: [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('') } });
  return f;
}
test('signed children can message their parent with bounded idempotent request ids', async () => {
  const f = await childFixture(), sent: any[] = [];
  f.host.sendMessage = async (...args) => { sent.push(args); };
  const send = f.delegation.tools({}, [], true).find(tool => tool.name === 'send_message')!;
  const invoke = (callId: string) => (send.execute as any)({ to: 'parent', text: 'Need a choice' }, { callId }, { abortSignal: signal() });
  await invoke('first'); await invoke('first');
  assert.equal(sent[0][0], 'parent');
  assert.equal(sent[0][1].id, sent[1][1].id);
  assert.equal(sent[0][2].source.agentId, 'child');
  assert.equal(sent[0][2].metadata.kind, 'message');
  for (let i = 1; i < 20; i++) await invoke('call-' + i);
  await assert.rejects(invoke('over-limit'), /20 messages/);
});
test('public metadata cannot forge a parent for agent messages or progress', async () => {
  const f = fixture(); let sent = false;
  f.setRun({ id: 'fake', metadata: { parentAgentId: 'somebody', delegationDepth: '1', delegationMaxDepth: '5', delegationChain: 'somebody', delegationSignature: 'fake' } });
  f.host.sendMessage = f.host.reportProgress = async () => { sent = true; };
  for (const name of ['send_message', 'report_progress']) {
    const tool = f.delegation.tools({}, [], true).find(tool => tool.name === name)!;
    await assert.rejects((tool.execute as any)({ to: 'parent', text: 'fake' }, { callId: name }, { abortSignal: signal() }), /no parent/);
  }
  assert.equal(sent, false);
});
test('progress is idempotent, shown once in tool results, and never starts a turn', async () => {
  const parent = fixture(), child = await childFixture();
  parent.values.set('delegation:live', { id: 'child', key: 'live', requestId: 'child-run', parentRequestId: 'parent-run', toolCallId: 'spawn', task: 'go', name: 'helper', depth: 1, createdAt: 1, status: 'running', made: true, background: true, accepted: true });
  child.host.reportProgress = async (id, report) => { assert.equal(id, 'parent'); await parent.delegation.recordProgress(report); };
  const progress = child.delegation.tools({}, [], true).find(tool => tool.name === 'report_progress')!;
  await (progress.execute as any)({ text: 'Read the first source' }, { callId: 'progress' }, { abortSignal: signal() });
  await (progress.execute as any)({ text: 'Read the first source' }, { callId: 'progress' }, { abortSignal: signal() });
  assert.equal(parent.events.length, 1);
  assert.equal((parent.events[0] as any).event.type, 'subagent_progress');
  assert.equal(parent.submitted.length, 0);
  const list = parent.delegation.tools({ instructions: true }, ['agents']).find(tool => tool.name === 'list_agents')!;
  const first = await (list.execute as any)({}, { callId: 'list' }, { abortSignal: signal() });
  assert.equal(first.output[1].agentUpdates, true);
  assert.match(first.output[1].text, /Read the first source/);
  const second = await (list.execute as any)({}, { callId: 'list2' }, { abortSignal: signal() });
  assert.equal(second.output.length, 1);
  await assert.rejects(parent.delegation.recordProgress({ agentId: 'stranger', requestId: 'child-run', callId: 'fake', text: 'fake' }), /Unknown sub-agent/);
});
test('wait_agent takes a background ending exactly once and excludes direct delegates', async () => {
  const f = fixture();
  const base = { id: 'child', requestId: 'child-run', parentRequestId: 'parent-run', toolCallId: 'call', task: 'go', name: 'helper', depth: 1, root: 'parent', createdAt: 1, endedAt: 2, status: 'completed', made: true, accepted: true, outcome: { result: { reply: 'done' } } };
  f.values.set('delegation:background', { ...base, key: 'background', background: true });
  f.values.set('delegation:direct', { ...base, id: 'direct', key: 'direct', background: false });
  const wait = f.delegation.tools({ instructions: true }, ['agents']).find(tool => tool.name === 'wait_agent')!;
  const first = await (wait.execute as any)({}, { callId: 'wait' }, { abortSignal: signal() });
  assert.deepEqual(JSON.parse(first.output[0].text).agents.map((entry: any) => entry.text), ['done']);
  assert.equal((f.values.get('delegation:background') as any).landedBy, 'wait');
  const second = await (wait.execute as any)({}, { callId: 'again' }, { abortSignal: signal() });
  assert.deepEqual(JSON.parse(second.output[0].text).agents, []);
});

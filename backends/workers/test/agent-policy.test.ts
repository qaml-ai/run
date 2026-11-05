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

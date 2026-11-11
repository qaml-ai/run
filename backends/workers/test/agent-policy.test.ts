import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Decider, decisionRequest, decisionsAnswer, checkedAnswers } from '../src/decision-policy.ts';
import { delegateInput, delegateSettings } from '../src/multi-agent-policy.ts';
import { Delegation, type DelegationHost } from '../src/delegation.ts';
import { DecisionRuntime } from '../src/decision-runtime.ts';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { withSql, submitViaFetch, childAlarms } from './sql-storage.ts';

const questions = { valid: { type: 'noul' as const, instructions: 'Is valid?' } };
const signal = () => new AbortController().signal;
const toolApi = (callId: string) => ({ callId, getTask: async () => undefined }) as unknown as ToolExecutionApi;
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
const fixtures: { delegation: Delegation; host: DelegationHost; stop: () => Promise<void> }[] = [];
// The simulated children's alarms stop with the file.
after(async () => { for (const { stop } of fixtures) await stop(); });
function fixture() {
  const values = new Map<string, unknown>();
  let transaction = Promise.resolve<unknown>(undefined);
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => values.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])),
    transaction: (run: (tx: unknown) => unknown) => {
      const pending = transaction.then(() => run(storage));
      transaction = pending.catch(() => {});
      return pending;
    },
  };
  withSql(storage);
  const events: any[] = [], submitted: any[] = [], tasks: Promise<unknown>[] = [];
  const sockets = new Map<string, Set<EventTarget>>();
  const send = (id: string, frame: object) => {
    for (const socket of sockets.get(id) ?? []) socket.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(frame) }));
  };
  let run: any = { id: 'parent-run' }, made = 0, parentId = 'parent';
  const host: DelegationHost = {
    storage: storage as unknown as DurableObjectStorage, secret: 'test-only-delegation-secret',
    context: async () => ({ id: parentId, config: { model: 'test/echo', delegate: { instructions: true, maxDepth: 2, maxParallel: 2 }, spendLimit: { usd: 0.1 } }, run }),
    create: async () => ({ id: `child-${++made}` }), target: async () => { throw new Error('unexpected target'); },
    fetch: async (id, request) => {
      if (new URL(request.url).pathname === '/events') {
        assert.equal(request.headers.get('Upgrade'), 'websocket');
        const socket = Object.assign(new EventTarget(), {
          accept() { queueMicrotask(() => send(id, { event: 'ready', data: {} })); },
          close() { sockets.get(id)?.delete(socket); },
        });
        const active = sockets.get(id) ?? new Set<EventTarget>();
        sockets.set(id, active); active.add(socket);
        return { status: 101, webSocket: socket } as unknown as Response;
      }
      if (request.method === 'POST') { submitted.push(await request.json()); return Response.json({ state: 'running' }); }
      queueMicrotask(() => send(id, { data: { type: 'response', id: new URL(request.url).pathname.split('/').at(-1) } }));
      return Response.json({ state: 'completed', status: 'completed', outcome: { result: { reply: 'helped', usage: { costUsd: 0.01 } } } });
    },
    emit: async event => { events.push(event); }, waitUntil: promise => { tasks.push(promise); },
  };
  host.submitChild = submitViaFetch(host);
  const delegation = new Delegation(host);
  fixtures.push({ delegation, host, stop: childAlarms(host, delegation) });
  return { delegation, host, events, submitted, tasks, setRun: (value: unknown) => { run = value; }, setId: (value: string) => { parentId = value; }, values };
}
test('decision and delegation tools resolve context from the executing conversation', async () => {
  const api = { ...toolApi('host-call'), conversationId: 42 } as ToolExecutionApi;
  let recorded: unknown;
  const decision = new DecisionRuntime({
    key: async () => ({ apiKey: 'fixture', platform: false }),
    context: async current => { assert.equal(current, api); return { tenant: 'test', requestId: 'host-request' }; },
    provider: { id: 'fixture', async decide() { return { answers: { valid: { noul: 1 } }, inputTokens: 1, outputTokens: 1, costUsd: 0.01 }; } },
    record: async current => { recorded = current.requestId; },
  });
  await decision.tool().execute({ state: 'x', questions }, api, { abortSignal: signal() } as never);
  assert.equal(recorded, 'host-request');
  const f = fixture(), original = f.host.context;
  f.host.context = async current => { assert.equal(current, api); return { ...await original(), run: { id: 'host-request' } }; };
  f.host.remainingBudget = async (_background, current) => { assert.equal(current, api); return 0.1; };
  const delegate = f.delegation.tools({ instructions: true }, ['delegate'])[0];
  await delegate.execute({ instructions: 'helper', task: 'help' }, api, { abortSignal: signal() } as never);
  assert.equal(f.submitted[0].params.metadata.parentRunId, 'host-request');
  await Promise.all(f.tasks);
});
test('delegation persists idempotent child, budget and result events', async () => {
  const f = fixture();
  const first = await f.delegation.start({ instructions: 'Be HELPER', task: 'help' }, 'call', signal());
  const done = await f.delegation.wait(first);
  assert.equal(f.delegation.answer(done).text, 'helped');
  assert.equal(f.submitted[0].params.spendLimit.usd, 0.05);
  assert.deepEqual(f.submitted[0].delegation, { owner: { kind: 'agent', id: 'parent' }, rootOwner: { kind: 'agent', id: 'parent' }, chain: ['parent'], depth: 1, maxDepth: 2, toolCallId: 'call', ownerRun: 'parent-run' });
  // Nothing is signed into the prompt: its metadata only says who started it.
  assert.deepEqual(f.submitted[0].params.metadata, { parentAgentId: 'parent', parentRunId: 'parent-run', parentToolCallId: 'call' });
  assert.match(f.submitted[0].params.text, /Your role:\nBe HELPER/);
  assert.equal((await f.delegation.start({ instructions: 'Be HELPER', task: 'help' }, 'call', signal())).id, first.id);
  assert.equal(f.submitted.length, 1);
  assert.equal(await f.delegation.cost('parent-run'), 0.01);
  assert.ok(f.events.some(event => event.event.type === 'subagent_start'));
  assert.equal(f.events.filter(event => event.event.type === 'subagent_end').length, 1);
  await Promise.all(f.tasks);
});
test('a structured child request wraps its schema and records its runtime parent', async () => {
  const f = fixture(), schema = { type: 'object', properties: { answer: { type: 'number' } } };
  let relation: unknown;
  f.host.create = async (_config, _key, parent) => { relation = parent; return { id: 'structured-child' }; };
  await f.delegation.start({ instructions: 'help', task: 'answer', output: schema }, 'structured', signal());
  assert.deepEqual(f.submitted[0].params.output, { schema });
  assert.deepEqual(relation, { agent: 'parent', run: 'parent-run', place: { depth: 1, maxDepth: 2, chain: ['parent'], owner: { kind: 'agent', id: 'parent' }, rootOwner: { kind: 'agent', id: 'parent' } } });
  await Promise.all(f.tasks);
});
test('a sub-agent\'s turn signed into no chain (a notification\'s) delegates from the place it was made at', async () => {
  const f = fixture();
  f.setId('mid');
  f.host.made = async () => ({ depth: 2, maxDepth: 2, chain: ['root', 'parent'] });
  await assert.rejects(f.delegation.start({ instructions: 'helper', task: 'help' }, 'deep', signal()), /depth limit of 2/);
  assert.equal(f.submitted.length, 0);
  f.host.made = async () => ({ depth: 1, maxDepth: 2, chain: ['root'] });
  await f.delegation.start({ instructions: 'helper', task: 'help' }, 'shallow', signal());
  assert.equal(f.submitted[0].delegation.depth, 2);
  assert.deepEqual(f.submitted[0].delegation.chain, ['root', 'mid']);
  assert.deepEqual(f.submitted[0].delegation.rootOwner, { kind: 'agent', id: 'root' });
  await Promise.all(f.tasks);
});
test('new child inherits the parent computer before submission, once across replay', async () => {
  const f = fixture(), inherited: string[][] = [], fetch = f.host.fetch;
  // A fresh child: the parent's connection is copied, with no fork.
  f.host.inheritComputer = async (parent, child, computer) => { assert.equal(computer, undefined); inherited.push([parent, child]); };
  f.host.fetch = async (id, request) => {
    if (request.method === 'POST') assert.deepEqual(inherited, [['parent', id]]);
    return fetch(id, request);
  };
  await f.delegation.start({ instructions: 'helper', task: 'help', computer: 'fresh' }, 'inherit', signal());
  await Promise.all(f.tasks);
  await f.delegation.start({ instructions: 'helper', task: 'help', computer: 'fresh' }, 'inherit', signal());
  assert.deepEqual(inherited, [['parent', 'child-1']]);
});
test('delegation to an existing agent preserves its computer connection', async () => {
  const f = fixture(), context = f.host.context;
  f.host.context = async () => ({ ...await context(), config: { delegate: { agents: [{ name: 'helper', agent: 'existing' }] } } });
  f.host.target = async () => ({ id: 'existing', config: {} });
  f.host.inheritComputer = async () => { assert.fail('must not replace an existing agent connection'); };
  assert.equal((await f.delegation.start({ agent: 'helper', task: 'help' }, 'existing', signal())).id, 'existing');
  await Promise.all(f.tasks);
});
test('child spending includes decisions, web tools, images, transcription and its own children', async () => {
  const f = fixture(), fetch = f.host.fetch;
  f.host.fetch = async (id, request) => request.method === 'GET' && new URL(request.url).pathname.startsWith('/requests/')
    ? Response.json({ state: 'completed', status: 'completed', outcome: { result: { usage: { costUsd: 0.01, subagentCostUsd: 0.02, imageCostUsd: 0.03, decisionCostUsd: 0.04, webCostUsd: 0.05, transcriptionCostUsd: 0.06 } } } })
    : fetch(id, request);
  const child = await f.delegation.start({ instructions: 'helper', task: 'help' }, 'all-costs', signal());
  const done = await f.delegation.wait(child);
  assert.ok(Math.abs(done.spent! - 0.21) < 1e-12);
  assert.ok(Math.abs(await f.delegation.costSince(child.createdAt) - 0.21) < 1e-12);
  await Promise.all(f.tasks);
});
test('sequential delegates share the same assistant response budget before either starts', async () => {
  const f = fixture(), original = f.host.context, fetch = f.host.fetch;
  f.host.context = async api => { const context = await original(api); return { ...context, config: { ...context.config, delegate: { instructions: true, maxParallel: 1 } } }; };
  f.host.remainingBudget = async () => 0.1 - await f.delegation.cost('parent-run');
  f.host.fetch = async (id, request) => request.method === 'GET' && new URL(request.url).pathname.startsWith('/requests/')
    ? Response.json({ state: 'completed', status: 'completed', outcome: { result: { usage: { costUsd: 0.05 } } } }) : fetch(id, request);
  const api = { taskId: 1, callId: 'first', getTask: async () => ({ input: { kind: 'model', callId: 'first', assistant: 2 } }),
    commit: async (read: (tx: unknown) => unknown) => read({ entry: async () => ({ model: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'delegate' }, { type: 'toolCall', name: 'delegate' }] }] }) }) } as unknown as ToolExecutionApi;
  const first = await f.delegation.start({ instructions: 'worker', task: 'first' }, 'first', signal(), false, api);
  await f.delegation.wait(first);
  const second = await f.delegation.start({ instructions: 'worker', task: 'second' }, 'second', signal(), false, api);
  await f.delegation.wait(second);
  await Promise.all(f.tasks);
  assert.deepEqual(f.submitted.map(request => request.params.spendLimit.usd), [0.05, 0.05]);
});
test('delegate tools describe their saved definition targets', async () => {
  const f = fixture();
  f.host.target = async () => ({ config: {}, description: 'Finds answers' });
  const tools = await f.delegation.toolsFor({ agents: [{ name: 'researcher', definition: 'researcher' }] }, ['delegate']);
  assert.match(tools[0].description!, /researcher: Finds answers/);
});
test('authoritative remaining budget reserves shares held by background children from earlier runs', async () => {
  const f = fixture();
  f.host.remainingBudget = async background => { assert.equal(background, true); return 0.04; };
  f.values.set('delegation:earlier', { id: 'earlier', key: 'earlier', requestId: 'earlier', parentRequestId: 'old-run', status: 'running', background: true, held: 0.03 });
  await f.delegation.start({ instructions: 'helper', task: 'help' }, 'remaining', signal(), true);
  assert.ok(Math.abs(f.submitted[0].params.spendLimit.usd - 0.01) < 1e-12);
  await Promise.all(f.tasks);
});
test('public metadata cannot place a run: depth and ceiling come from the stored placement only', async () => {
  const f = fixture();
  f.setRun({ id: 'parent-run', metadata: { delegationDepth: '99', delegationMaxDepth: '99', delegationChain: 'parent', delegationSignature: 'forged' } });
  const first = await f.delegation.start({ instructions: 'helper', task: 'help' }, 'a', signal());
  assert.equal(first.depth, 1);
  assert.equal(f.submitted[0].delegation.maxDepth, 2);
  await Promise.all(f.tasks);
});

test('a run older code started keeps its signed place for one deploy; a forged signature does not', async () => {
  // Older code signed the place into the child's prompt metadata (delegation-v1). Verified, never made, until the
  // contract deploy: a run it started before this deploy keeps its depth and chain.
  const f = fixture();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-only-delegation-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('delegation-v1:mid:old-run:1:2:root')))].map(x => x.toString(16).padStart(2, '0')).join('');
  const metadata = { delegationDepth: '1', delegationMaxDepth: '2', delegationChain: 'root', delegationSignature: mac };
  assert.deepEqual(await f.delegation.lineage('mid', { id: 'old-run', metadata }), { depth: 1, maxDepth: 2, chain: ['root'], parent: 'root', root: 'root', owner: { kind: 'agent', id: 'root' }, rootOwner: { kind: 'agent', id: 'root' } });
  assert.equal(await f.delegation.lineage('mid', { id: 'old-run', metadata: { ...metadata, delegationChain: 'other' } }), undefined);
  assert.equal(await f.delegation.lineage('other', { id: 'old-run', metadata }), undefined);
});

test('a stored placement cannot exceed its inherited depth ceiling', async () => {
  const parent = fixture();
  const child = await parent.delegation.start({ instructions: 'helper', task: 'help' }, 'first', signal());
  await Promise.all(parent.tasks);
  const middle = fixture();
  middle.setId(child.id); middle.setRun({ id: child.requestId, metadata: parent.submitted[0].params.metadata, delegation: parent.submitted[0].delegation });
  assert.deepEqual(await middle.delegation.lineage(child.id, { id: child.requestId, delegation: parent.submitted[0].delegation }), {
    depth: 1, maxDepth: 2, chain: ['parent'], parent: 'parent', root: 'parent', owner: { kind: 'agent', id: 'parent' }, rootOwner: { kind: 'agent', id: 'parent' },
  });
  // The metadata alone places nothing: only the placement the owner stored with the run does.
  assert.equal(await middle.delegation.lineage(child.id, { id: child.requestId, metadata: parent.submitted[0].params.metadata }), undefined);
  const grandchild = await middle.delegation.start({ instructions: 'helper', task: 'help' }, 'second', signal());
  assert.equal(grandchild.depth, 2);
  await Promise.all(middle.tasks);
  const last = fixture();
  last.setId(grandchild.id); last.setRun({ id: grandchild.requestId, delegation: middle.submitted[0].delegation });
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
test('background child result and lifecycle events retain their public identity', async () => {
  const f = fixture();
  const child = await f.delegation.start({ instructions: 'helper', task: 'help', name: 'researcher' }, 'background-call', signal(), true);
  await f.delegation.wait(child);
  await Promise.all(f.tasks);
  assert.equal(f.delegation.answer(child).name, 'researcher');
  for (const type of ['subagent_start', 'subagent_end']) {
    const event = f.events.find(item => item.event.type === type).event;
    assert.equal(event.background, true);
    assert.equal(event.name, 'researcher');
    assert.equal(event.agentId, child.id);
    assert.equal(event.requestId, child.requestId);
  }
});
test('a paused background child produces one new completion notice after its human resume', async () => {
  const f = fixture(), notified: string[] = [], retries: number[] = [];
  let resumed = false;
  f.values.set('delegation:paused', { id: 'child', key: 'paused', requestId: 'child-run', parentRequestId: 'parent-run', toolCallId: 'spawn', task: 'ask', name: 'helper', depth: 1, createdAt: Date.now(), status: 'input_required', background: true, made: true, accepted: true, notified: true });
  const original = f.host.fetch;
  f.host.fetch = async (id, request) => new URL(request.url).pathname.startsWith('/requests/resume_') && !resumed ? new Response('', { status: 404 }) : original(id, request);
  f.host.notify = async child => { notified.push(child.key); };
  f.host.retry = async after => { retries.push(after!); };
  await f.delegation.recover();
  assert.equal(retries[0], 15_000);
  resumed = true;
  await f.delegation.recover();
  await Promise.all(f.tasks);
  // The resumed run's ending comes by the child's outbox (simulated by the fixture's child alarms).
  for (let i = 0; i < 400 && !notified.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await Promise.all(f.tasks);
  await f.delegation.recover();
  await Promise.all(f.tasks);
  assert.deepEqual(notified, ['paused:resume']);
});
test('a trusted tool starts an existing tenant worker without exposing a model spawn tool', async () => {
  const f = fixture();
  f.host.target = async ({ agent }) => ({ id: agent!, config: { name: 'prepared' } });
  const result = await f.delegation.toolSpawn('app__work', { agent: 'prepared-worker', task: 'do it', output: { type: 'object' } }, { callId: 'source-call', taskId: 1, getTask: async () => undefined } as unknown as ToolExecutionApi, { abortSignal: signal() } as never);
  assert.equal(JSON.parse((result.content![0] as { text: string }).text).agentId, 'prepared-worker');
  assert.deepEqual(result.structuredContent, { agentId: 'prepared-worker', name: 'prepared' });
  assert.deepEqual(f.submitted[0].params.output, { schema: { type: 'object' } });
  await Promise.all(f.tasks);
});
test('deleting a parent retries made-child cleanup without deleting named workers', async () => {
  const f = fixture(), removed: string[] = [];
  const child = { requestId: 'done', parentRequestId: 'parent-run', toolCallId: 'call', task: 'go', name: 'helper', depth: 1, createdAt: 1, status: 'completed', accepted: true };
  f.values.set('delegation:made', { ...child, id: 'made', key: 'made', made: true });
  f.values.set('delegation:resume', { ...child, id: 'made', key: 'resume', made: true });
  f.values.set('delegation:named', { ...child, id: 'named', key: 'named', made: false });
  let fail = true;
  f.host.remove = async id => { if (fail) throw new Error('retry cleanup'); removed.push(id); };
  await assert.rejects(f.delegation.destroy(), /retry cleanup/);
  fail = false;
  await f.delegation.destroy();
  assert.deepEqual(removed, ['made']);
});
test('parent cancellation aborts made children and only its actively running named child', async () => {
  const f = fixture(), aborted: string[] = [];
  const base = { requestId: 'child-run', parentRequestId: 'parent-run', toolCallId: 'call', task: 'go', name: 'helper', depth: 1, createdAt: 1, status: 'running', accepted: true };
  f.values.set('delegation:made', { ...base, id: 'made', key: 'made', made: true });
  f.values.set('delegation:named', { ...base, id: 'named', key: 'named', made: false });
  f.values.set('delegation:queued', { ...base, id: 'queued', key: 'queued', made: false });
  f.host.fetch = async (id, request) => {
    if (request.method === 'POST') { aborted.push(id); return Response.json({}); }
    if (aborted.includes(id)) return Response.json({ state: 'completed', status: 'aborted' });
    return Response.json(id === 'named' ? { state: 'running', began: 1 } : { state: 'running' });
  };
  await f.delegation.cancel('parent-run');
  assert.deepEqual(aborted.sort(), ['made', 'named']);
  // The queued request belongs to the existing agent; finish it before disposing
  // this fixture so its recovery timer does not outlive the test.
  f.host.fetch = async () => Response.json({ state: 'completed', status: 'completed' });
  await f.delegation.recover();
});
test('cancellation during child creation cannot submit or reopen a child', async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const creating = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.host.create = async () => { entered(); await gate; return { id: 'late-child' }; };
  f.host.cancelRequest = async () => {};
  const pending = f.delegation.start({ instructions: 'helper', task: 'help' }, 'late-create', signal());
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await creating;
  await f.delegation.cancel('parent-run');
  release();
  await rejected;
  assert.equal(f.submitted.length, 0, 'cancellation prevents the later prompt submission');
  const [child] = await f.delegation.children();
  assert.equal(child.status, 'aborted');
  assert.equal(child.cancelRequested, true);
  assert.equal((await f.delegation.start({ instructions: 'helper', task: 'help' }, 'late-create', signal())).status, 'aborted');
});
test('cancellation racing an accepted child is reasserted after its submit finishes', async () => {
  const f = fixture(), originalFetch = f.host.fetch;
  let entered!: () => void, release!: () => void;
  const submitting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const cancelled: string[] = [];
  f.host.cancelRequest = async (_agent, request) => { cancelled.push(request); };
  f.host.fetch = async (id, request) => {
    if (request.method === 'POST') { entered(); await gate; return originalFetch(id, request); }
    if (new URL(request.url).pathname.startsWith('/requests/')) return Response.json({ state: 'completed', status: 'aborted', outcome: { result: { reply: '', usage: { costUsd: 0.001 } } } });
    return originalFetch(id, request);
  };
  const pending = f.delegation.start({ instructions: 'helper', task: 'help' }, 'late-submit', signal());
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await submitting;
  await f.delegation.cancel('parent-run');
  release();
  await rejected;
  await Promise.all(f.tasks);
  assert.equal(cancelled.length, 2, 'cancel both before and after the in-flight submission');
  assert.equal(new Set(cancelled).size, 1);
  const [child] = await f.delegation.children();
  assert.equal(child.cancelRequested, true);
  assert.equal(child.status, 'aborted');
  assert.equal(child.spent, 0.001, 'accepted cancelled work still accounts its incurred cost');
});
test('targeted cancellation includes queued requests of named agents and survives restart', async () => {
  const f = fixture(), cancelled: string[] = [];
  f.host.cancelRequest = async (_agent, request) => { cancelled.push(request); };
  // Background cancellation persists the request and recovery follows its ending.
  // Direct delegates are already drained by cancel() before it returns.
  f.values.set('delegation:queued', { id: 'shared-agent', key: 'queued', requestId: 'owned-request', parentRequestId: 'parent-run', status: 'running', made: false, background: true, accepted: true });
  await f.delegation.cancel('parent-run');
  assert.deepEqual(cancelled, ['owned-request']);
  await new Delegation(f.host).recover();
  await Promise.all(f.tasks);
  assert.deepEqual(cancelled, ['owned-request', 'owned-request']);
});
test('cancel recovery reads costs when eviction lost the child admission acknowledgement', async () => {
  const f = fixture();
  f.host.cancelRequest = async () => {};
  f.values.set('delegation:pending', { id: 'child', key: 'pending', requestId: 'child-request', parentRequestId: 'parent-run', status: 'running', made: true, accepted: false, cancelRequested: true });
  await f.delegation.recover();
  await Promise.all(f.tasks);
  assert.equal(await f.delegation.cost('parent-run'), 0.01);
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
  const invoke = (callId: string) => (send.execute as any)({ to: 'parent', text: 'Need a choice' }, toolApi(callId), { abortSignal: signal() });
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
    await assert.rejects((tool.execute as any)({ to: 'parent', text: 'fake' }, toolApi(name), { abortSignal: signal() }), /no parent/);
  }
  assert.equal(sent, false);
});
test('a message folded into a running child keeps its original answer for wait_agent', async () => {
  const f = fixture();
  f.values.set('delegation:original', { id: 'child', key: 'original', requestId: 'child-run', parentRequestId: 'parent-run', toolCallId: 'spawn', task: 'work', name: 'worker', depth: 1, createdAt: 1, status: 'completed', background: true, accepted: true, made: true, outcome: { result: { reply: 'the full answer' } } });
  let submitted = '';
  f.host.sendMessage = async (_id, request) => { submitted = request.id; };
  const fetch = f.host.fetch;
  f.host.fetch = async (id, request) => new URL(request.url).pathname.startsWith('/requests/')
    ? Response.json({ state: new URL(request.url).searchParams.has('wait') ? 'completed' : 'queued', steer: 'accepted', steeredInto: 'child-run' })
    : fetch(id, request);
  const tools = f.delegation.tools({ instructions: true }, ['agents']);
  const send = tools.find(tool => tool.name === 'send_message')!;
  const result = await (send.execute as any)({ to: 'worker', text: 'also this' }, toolApi('send'), { abortSignal: signal() });
  assert.match(submitted, /^msg_/);
  assert.match(result.output[0].text, /^\{"sent":true/);
  assert.equal(JSON.parse(result.output[0].text).into, 'its running turn');
  const wait = tools.find(tool => tool.name === 'wait_agent')!;
  const waited = await (wait.execute as any)({ agents: ['worker'] }, toolApi('wait'), { abortSignal: signal() });
  assert.equal(JSON.parse(waited.output[0].text).agents[0].text, 'the full answer');
  await Promise.all(f.tasks);
});
test('a message that never reached its child ends failed, with no notification, rather than waiting on a request the child never had', async () => {
  const f = fixture();
  f.values.set('delegation:original', { id: 'child', key: 'original', requestId: 'child-run', parentRequestId: 'parent-run', toolCallId: 'spawn', task: 'work', name: 'worker', depth: 1, createdAt: 1, status: 'completed', background: true, accepted: true, made: true, outcome: { result: { reply: 'done' } } });
  f.host.sendMessage = async () => { throw new Error('A call to blockConcurrencyWhile() in a Durable Object waited for too long.'); };
  const fetch = f.host.fetch;
  f.host.fetch = async (id, request) => new URL(request.url).pathname.startsWith('/requests/msg_') ? new Response('', { status: 404 }) : fetch(id, request);
  const tools = f.delegation.tools({ instructions: true }, ['agents']);
  const send = tools.find(tool => tool.name === 'send_message')!;
  await assert.rejects((send.execute as any)({ to: 'worker', text: 'also this' }, toolApi('send'), { abortSignal: signal() }), /blockConcurrencyWhile/);
  const message = [...f.values.entries()].find(([key]) => key.startsWith('delegation:message-'))![1] as any;
  assert.deepEqual([message.status, message.notified, message.accepted], ['failed', true, false]);
  assert.match(message.error, /did not reach worker/);
  const wait = tools.find(tool => tool.name === 'wait_agent')!;
  const waited = JSON.parse((await (wait.execute as any)({ agents: ['worker'] }, toolApi('wait'), { abortSignal: signal() })).output[0].text);
  assert.doesNotMatch(JSON.stringify(waited), /deleted/);
  await Promise.all(f.tasks);
});
test('progress is idempotent, shown once in tool results, and never starts a turn', async () => {
  const parent = fixture(), child = await childFixture();
  parent.values.set('delegation:live', { id: 'child', key: 'live', requestId: 'child-run', parentRequestId: 'parent-run', toolCallId: 'spawn', task: 'go', name: 'helper', depth: 1, createdAt: 1, status: 'running', made: true, background: true, accepted: true });
  child.host.reportProgress = async (owner, report) => { assert.deepEqual(owner, { kind: 'agent', id: 'parent' }); return parent.delegation.recordProgress(report); };
  const progress = child.delegation.tools({}, [], true).find(tool => tool.name === 'report_progress')!;
  await (progress.execute as any)({ text: 'Read the first source' }, toolApi('progress'), { abortSignal: signal() });
  await (progress.execute as any)({ text: 'Read the first source' }, toolApi('progress'), { abortSignal: signal() });
  assert.equal(parent.events.length, 1);
  assert.equal((parent.events[0] as any).event.type, 'subagent_progress');
  assert.equal(parent.submitted.length, 0);
  const list = parent.delegation.tools({ instructions: true }, ['agents']).find(tool => tool.name === 'list_agents')!;
  const first = await (list.execute as any)({}, toolApi('list'), { abortSignal: signal() });
  assert.deepEqual(JSON.parse(first.output[0].text).agents.map((entry: any) => [entry.name, entry.status, entry.progress]), [['helper', 'running', 'Read the first source']]);
  assert.equal(first.output[1].agentUpdates, true);
  assert.match(first.output[1].text, /Read the first source/);
  const second = await (list.execute as any)({}, toolApi('list2'), { abortSignal: signal() });
  assert.equal(second.output.length, 1);
  assert.deepEqual(await parent.delegation.recordProgress({ agentId: 'stranger', requestId: 'child-run', callId: 'fake', text: 'fake' }), { accepted: false, error: 'Unknown sub-agent run' });
});
test('wait_agent takes a background ending exactly once and excludes direct delegates', async () => {
  const f = fixture();
  const base = { id: 'child', requestId: 'child-run', parentRequestId: 'parent-run', toolCallId: 'call', task: 'go', name: 'helper', depth: 1, root: 'parent', createdAt: 1, endedAt: 2, status: 'completed', made: true, accepted: true, outcome: { result: { reply: 'done' } } };
  f.values.set('delegation:background', { ...base, key: 'background', background: true });
  f.values.set('delegation:direct', { ...base, id: 'direct', key: 'direct', background: false });
  const wait = f.delegation.tools({ instructions: true }, ['agents']).find(tool => tool.name === 'wait_agent')!;
  const first = await (wait.execute as any)({}, toolApi('wait'), { abortSignal: signal() });
  assert.deepEqual(JSON.parse(first.output[0].text).agents.map((entry: any) => [entry.name, entry.text]), [['helper', 'done']]);
  assert.equal((f.values.get('delegation:background') as any).landedBy, 'wait');
  const second = await (wait.execute as any)({}, toolApi('again'), { abortSignal: signal() });
  assert.deepEqual(JSON.parse(second.output[0].text).agents, []);
});

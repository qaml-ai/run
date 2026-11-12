import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowAgents, workflowRun, type EffectUsage, type LandedOutcome, type WorkflowChildren } from '../src/workflow-agents.ts';
import type { Placement } from '../../../shared/owner.ts';
import { withSql } from './sql-storage.ts';

// The real agent() executor: a workflow-owned child per `key:attempt`, started once, its ending landed on the effect,
// a refusal for money a pause (not a null), and an abort that stops every child.

type Submitted = { childId: string; request: { id: string; params: Record<string, any> }; placement: Placement };

function world(options: { budget?: number | undefined; concurrency?: number; config?: Record<string, unknown> } = {}) {
  const values = new Map<string, unknown>();
  const storage = {
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async delete(key: string) { return values.delete(key); },
    async list({ prefix }: { prefix: string }) { return new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); },
    async transaction(work: (tx: unknown) => unknown) { return work(storage); },
  };
  withSql(storage);
  const created: { key: string; config: Record<string, any>; place: any }[] = [], submitted: Submitted[] = [], cancelled: string[] = [];
  let onCancel: ((childId: string) => Promise<void>) | undefined;
  // The runner's landing as the workflow object wires it: the first landing of key:attempt wins, the ledger keeps one row per key:attempt.
  const landed: { key: string; attempt: number; outcome: LandedOutcome; usage?: EffectUsage }[] = [], ledger = new Map<string, number>();
  let landFails = 0;
  let submitAnswer: () => { ok: true } | { ok: false; status: number; error: string } = () => ({ ok: true });
  let submitThrows = 0, createGate: Promise<void> | undefined, createThrows: unknown;
  const children: WorkflowChildren = {
    config: async args => ({ model: args.model ?? 'test/echo', systemPrompt: 'sub-agent', computer: { hosts: ['x'] }, ...options.config }),
    // The same key makes the same agent, as Directory.upsert does.
    create: async (config, key, place) => {
      if (createThrows) { const error = createThrows; createThrows = undefined; throw error; }
      created.push({ key, config, place });
      await createGate;
      return { id: `client_${key}` };
    },
    submit: async (childId, request, placement) => {
      if (submitThrows > 0) { submitThrows--; throw new Error('the child was unreachable'); }
      submitted.push({ childId, request, placement });
      return submitAnswer();
    },
    cancel: async (childId, requestId) => { cancelled.push(`${childId}/${requestId}`); await onCancel?.(childId); },
  };
  const agents = new WorkflowAgents({
    storage: storage as unknown as DurableObjectStorage, workflow: { id: 'wf_test', tenant: 'acme', bucket: 'wf-bucket' },
    budget: () => ('budget' in options ? options.budget : 100) as number, concurrency: options.concurrency ?? 4, children,
    land: async (key, attempt, outcome, usage) => {
      if (landFails > 0) { landFails--; throw new Error('the workflow object was evicted'); }
      landed.push({ key, attempt, outcome, usage });
      if (usage && !ledger.has(`${key}:${attempt}`)) ledger.set(`${key}:${attempt}`, usage.costUsd);
    },
  });
  const refused = () => landed.filter(entry => 'refused' in entry.outcome);
  return { agents, created, submitted, cancelled, landed, refused, ledger, answer: (fn: typeof submitAnswer) => { submitAnswer = fn; }, failSubmits: (n: number) => { submitThrows = n; },
    failLands: (n: number) => { landFails = n; }, cancelling: (fn: (childId: string) => Promise<void>) => { onCancel = fn; }, holdCreate: (gate: Promise<void>) => { createGate = gate; }, failCreate: (error: unknown) => { createThrows = error; } };
}

const effect = (key: string, args: Record<string, unknown> = { prompt: `do ${key}` }, attempt = 1) => ({ key, attempt, kind: 'agent', args });
const completed = (submitted: Submitted, result: Record<string, unknown>) => ({ agentId: submitted.childId, requestId: submitted.request.id, record: { state: 'completed', status: 'completed', outcome: { result } } });

test('a child per key:attempt, owned by the workflow, billed to its tenant and bucket within its budget, started once', async () => {
  const w = world({ budget: 10, concurrency: 4 });
  await w.agents.start(effect('review:a.ts', { prompt: 'review a.ts', instructions: 'You review code.', output: { type: 'object' } }));
  await w.agents.start(effect('review:a.ts', { prompt: 'review a.ts', instructions: 'You review code.', output: { type: 'object' } }));
  assert.equal(w.created.length, 1, 'the same effect made again makes nothing more');
  assert.equal(w.submitted.length, 1);
  const [{ config, place }] = w.created, [{ request, placement }] = w.submitted;
  assert.equal(config.computer, undefined, 'a workflow child has no computer');
  assert.equal(config.bucket, 'wf-bucket');
  assert.equal(config.type, 'subagent');
  assert.deepEqual(placement.owner, { kind: 'workflow', id: 'wf_test' });
  assert.deepEqual(placement.rootOwner, { kind: 'workflow', id: 'wf_test' });
  assert.deepEqual(placement.chain, ['wf_test']);
  assert.equal(placement.depth, 1);
  assert.equal(placement.toolCallId, 'review:a.ts');
  assert.equal(place.ownerRun, workflowRun('wf_test'));
  assert.equal(request.params.endUser, undefined, 'never an end user pool');
  assert.equal(request.params.bucket, 'wf-bucket');
  assert.equal(request.params.spendLimit.usd, 2.5, 'its share: what is left over the free slots');
  assert.match(request.params.text, /^Your role:\nYou review code\.\n\nYour task:\nreview a\.ts$/);
  assert.deepEqual(request.params.output, { schema: { type: 'object' } });
  assert.deepEqual(request.params.metadata, { workflowId: 'wf_test', effectKey: 'review:a.ts', effectAttempt: '1' });
});

test('an ending lands the result with its usage; delivered again it lands again, and the ledger keeps one row', async () => {
  const w = world();
  await w.agents.start(effect('plan'));
  const ending = completed(w.submitted[0]!, { output: { steps: 3 }, reply: 'ignored', usage: { costUsd: 0.2 } });
  assert.deepEqual(await w.agents.receiveEnding(ending), { accepted: true });
  assert.deepEqual(await w.agents.receiveEnding(ending), { accepted: true });
  assert.deepEqual(w.landed.map(entry => entry.outcome), [{ ok: true, value: { steps: 3 } }, { ok: true, value: { steps: 3 } }]);
  assert.equal(w.landed[0]!.usage?.costUsd, 0.2);
  assert.deepEqual([...w.ledger], [['plan:1', 0.2]], 'one ledger row');
  assert.deepEqual(await w.agents.receiveEnding({ ...ending, requestId: 'someone-else' }), { accepted: false });
  await w.agents.start(effect('text'));
  await w.agents.receiveEnding(completed(w.submitted[1]!, { reply: 'plain text' }));
  assert.deepEqual(w.landed.at(-1)!.outcome, { ok: true, value: 'plain text' });
  await w.agents.start(effect('broken'));
  await w.agents.receiveEnding({ agentId: w.submitted[2]!.childId, requestId: w.submitted[2]!.request.id, record: { state: 'completed', status: 'failed', error: 'model failed', outcome: { error: 'model failed' } } });
  assert.deepEqual(w.landed.at(-1)!.outcome, { ok: false, error: 'model failed' });
  // An ending landed, then the start made again (the runner's wake after a crash): the outcome is landed again, nothing started.
  await w.agents.start(effect('plan'));
  assert.equal(w.submitted.length, 3);
  assert.deepEqual({ ...w.landed.at(-1)!, usage: undefined }, { key: 'plan', attempt: 1, outcome: { ok: true, value: { steps: 3 } }, usage: undefined });
});

test('a payer out of credit pauses the workflow (refused, not null), at admission or at its spend limit; a new attempt is a new child', async () => {
  const w = world();
  w.answer(() => ({ ok: false, status: 402, error: 'The tenant has no credit' }));
  await w.agents.start(effect('a'));
  assert.deepEqual(w.refused().map(entry => [entry.key, entry.outcome]), [['a', { refused: 'The tenant has no credit', code: 'payer_exhausted' }]]);
  assert.equal(w.landed.length - w.refused().length, 0, 'never landed as a failure the script would filter out');
  w.answer(() => ({ ok: true }));
  await w.agents.start(effect('b'));
  // Stopped at its spend limit well short of its share (25 of 100 over 4 slots): the tenant's credit ran out.
  await w.agents.receiveEnding(completed(w.submitted.at(-1)!, { stopped: 'spend_limit', usage: { costUsd: 1 } }));
  assert.deepEqual(w.refused().at(-1)!.outcome, { refused: 'The workflow\'s tenant has no credit left', code: 'payer_exhausted' });
  assert.equal(w.refused().at(-1)!.usage?.costUsd, 1, 'what it spent still reaches the ledger');
  assert.equal(w.landed.length, w.refused().length);
  // Stopped having spent its whole share: the workflow's budget is what ran out.
  await w.agents.start(effect('c'));
  const share = w.submitted.at(-1)!.request.params.spendLimit.usd;
  await w.agents.receiveEnding(completed(w.submitted.at(-1)!, { stopped: 'spend_limit', usage: { costUsd: share } }));
  assert.equal((w.refused().at(-1)!.outcome as { code: string }).code, 'budget_exhausted');
  // Resume re-issues it under the next attempt: a new child, a new request.
  await w.agents.start(effect('a', undefined, 2));
  assert.equal(w.created.length, 4);
  assert.notEqual(w.created.at(-1)!.key, w.created[0]!.key);
  assert.notEqual(w.submitted.at(-1)!.request.id, w.submitted[0]!.request.id);
});

test('a spent budget, or a remainder too small for a turn, pauses with budget_exhausted before anything is made', async () => {
  for (const budget of [0, 0.004]) {
    const w = world({ budget });
    await w.agents.start(effect('a'));
    assert.equal((w.refused()[0]!.outcome as { code: string }).code, 'budget_exhausted');
    assert.equal(w.created.length, 0);
  }
});

test('past its concurrency an effect waits for a slot, then starts as an ending frees one', async () => {
  const w = world({ concurrency: 2 });
  for (const key of ['a', 'b', 'c']) await w.agents.start(effect(key));
  assert.deepEqual(w.submitted.map(entry => entry.request.params.metadata.effectKey), ['a', 'b']);
  await w.agents.receiveEnding(completed(w.submitted[0]!, { reply: 'done' }));
  assert.deepEqual(w.submitted.map(entry => entry.request.params.metadata.effectKey), ['a', 'b', 'c']);
});

test('a start lost on its way to the child is made again with the same request, which the child dedupes', async () => {
  const w = world();
  w.failSubmits(1);
  await assert.rejects(w.agents.start(effect('a')), /unreachable/);
  assert.equal(w.landed.length, 0, 'not a failure: the child may have taken it');
  await w.agents.recover();
  assert.equal(w.created.length, 1, 'the same child');
  assert.equal(w.submitted.length, 1);
  await w.agents.start(effect('a'));
  assert.equal(w.submitted.length, 1, 'acknowledged once, not submitted again');
});

test('abort: queued children never start, running ones are stopped', async () => {
  const w = world({ concurrency: 1 });
  await w.agents.start(effect('a'));
  await w.agents.start(effect('b'));
  await w.agents.abort();
  assert.deepEqual(w.cancelled, [`${w.submitted[0]!.childId}/${w.submitted[0]!.request.id}`]);
  // The stopped child's ending still comes; the queued one never starts.
  await w.agents.receiveEnding({ agentId: w.submitted[0]!.childId, requestId: w.submitted[0]!.request.id, record: { state: 'completed', status: 'aborted', outcome: { result: { stopped: 'aborted' } } } });
  assert.equal(w.submitted.length, 1);
  assert.equal((await w.agents.rows.withStatus('aborted')).length, 2);
});

test('agent() options a workflow child cannot have are refused on the effect', async () => {
  const w = world();
  await w.agents.start(effect('c', { prompt: 'x', computer: 'fork' }));
  assert.match(String((w.landed[0]!.outcome as { error: string }).error), /no computer/);
  await assert.rejects(w.agents.start({ key: 's', attempt: 1, kind: 'job', args: { command: 'true' } }), /agent\(\) effects/);
});

test('a definition cannot bill a workflow child to an end user: its subject (and agent spend limit) are not taken', async () => {
  const w = world({ config: { subject: 'end-user-42', spendLimit: { usd: 1000 } } });
  await w.agents.start(effect('a', { prompt: 'x', definition: 'billed-to-a-user' }));
  const [{ config }] = w.created;
  assert.equal(config.subject, undefined);
  assert.equal(config.spendLimit, undefined);
  assert.equal(w.submitted[0]!.request.params.endUser, undefined);
});

test('the row ends and the spend lands together: a crash between them is made good by the redelivery', async () => {
  const w = world();
  await w.agents.start(effect('a'));
  const ending = completed(w.submitted[0]!, { reply: 'done', usage: { costUsd: 0.3 } });
  // The workflow object goes away after the row ended and before the landing (and its ledger row) was made: no
  // receipt goes back, so the child's outbox delivers again.
  w.failLands(1);
  await assert.rejects(w.agents.receiveEnding(ending));
  assert.equal(w.ledger.size, 0);
  assert.deepEqual(await w.agents.receiveEnding(ending), { accepted: true });
  assert.deepEqual([...w.ledger], [['a:1', 0.3]], 'the spend reached the ledger');
  assert.deepEqual(w.landed.map(entry => entry.outcome), [{ ok: true, value: 'done' }]);
});

test('an abort while a child is being made: the child is never started', async () => {
  const w = world();
  let made!: () => void;
  w.holdCreate(new Promise<void>(resolve => { made = resolve; }));
  const starting = w.agents.start(effect('a'));
  for (let i = 0; i < 50 && !w.created.length; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(w.created.length, 1, 'the child is being made');
  await w.agents.abort();
  made();
  await starting;
  assert.equal(w.submitted.length, 0, 'nothing was submitted after the abort');
  assert.equal((await w.agents.rows.withStatus('aborted')).length, 1);
  assert.equal((await w.agents.rows.withStatus('running')).length, 0);
});

test('a create that fails with a 5xx or no status is tried again with the same key; a 4xx fails the effect', async () => {
  const w = world();
  w.failCreate(Object.assign(new Error('directory unavailable'), { status: 503 }));
  await assert.rejects(w.agents.start(effect('a')), /unavailable/);
  assert.equal(w.landed.length, 0);
  await w.agents.recover();
  assert.equal(w.submitted.length, 1);
  w.failCreate(new Error('connection reset'));
  await assert.rejects(w.agents.start(effect('b')), /reset/);
  await w.agents.recover();
  assert.equal(w.submitted.length, 2);
  w.failCreate(Object.assign(new Error('Unknown definition'), { status: 400 }));
  await w.agents.start(effect('c'));
  assert.deepEqual(w.landed.at(-1)!.outcome, { ok: false, error: 'Unknown definition' });
});

test('cancel stops one effect\'s child', async () => {
  const w = world();
  await w.agents.start(effect('a'));
  await w.agents.start(effect('b'));
  await w.agents.cancel({ key: 'b', attempt: 1 });
  assert.deepEqual(w.cancelled, [`${w.submitted[1]!.childId}/${w.submitted[1]!.request.id}`]);
});

test('a workflow with no cap (Infinity) gives its children no spend limit of its own; an unknown budget refuses', async () => {
  const unlimited = world({ budget: Infinity });
  await unlimited.agents.start(effect('a'));
  assert.equal(unlimited.submitted[0]!.request.params.spendLimit, undefined);
  assert.equal(unlimited.refused().length, 0);
  for (const budget of [-Infinity, -5]) {
    const negative = world({ budget });
    await negative.agents.start(effect('a'));
    assert.equal((negative.refused()[0]!.outcome as { code: string }).code, 'budget_exhausted', `budget ${budget}`);
  }
  const unknown = world({ budget: undefined });
  await unknown.agents.start(effect('a'));
  assert.equal((unknown.refused()[0]!.outcome as { code: string }).code, 'budget_exhausted');
  assert.equal(unknown.created.length, 0);
});

test('abort: an ending that lands during an earlier child\'s cancel is not written back to running', async () => {
  const w = world();
  await w.agents.start(effect('a'));
  await w.agents.start(effect('b'));
  const [first, second] = w.submitted;
  // While a's cancel is on its way, b ends on its own.
  w.cancelling(async childId => {
    if (childId === first!.childId) await w.agents.receiveEnding(completed(second!, { reply: 'b done', usage: { costUsd: 0.1 } }));
  });
  await w.agents.abort();
  const b = (await w.agents.rows.all()).find(row => row.id === second!.childId)!;
  assert.equal(b.status, 'completed', 'b stays ended');
  assert.equal(b.held, undefined, 'and holds no share of the budget');
  assert.deepEqual(w.cancelled, [`${first!.childId}/${first!.request.id}`], 'an ended child is not cancelled');
  assert.equal((await w.agents.rows.withStatus('running')).length, 1, 'only a is still running (its ending to come)');
});

test('a landing from inside a start never waits on the step that called the start (the runner serializes both)', async () => {
  // The runner calls start() inside its serialized step, and its land() waits for that step: a start that awaited its
  // own landing would never return. Refusals and failures found by a start are landed after it returns.
  const { WorkflowAgents } = await import('../src/workflow-agents.ts');
  const values = new Map<string, unknown>();
  const storage = {
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async list({ prefix }: { prefix: string }) { return new Map([...values].filter(([key]) => key.startsWith(prefix))); },
    async transaction(work: (tx: unknown) => unknown) { return work(storage); },
  };
  withSql(storage);
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => { const next = queue.then(work); queue = next.catch(() => undefined); return next; };
  const landed: unknown[] = [], deferred: (() => Promise<void>)[] = [];
  let crash = true;
  const agents = new WorkflowAgents({
    storage: storage as never, workflow: { id: 'wf_s', tenant: 't' }, budget: () => 0, concurrency: 2,
    children: { config: async () => ({}), create: async () => ({ id: 'c' }), submit: async () => ({ ok: true }), cancel: async () => {} },
    land: (key, attempt, outcome) => serial(async () => { landed.push([key, outcome]); }),
    // The first deferred landing is lost to a crash; recover() lands it again.
    defer: task => { if (crash) { crash = false; deferred.push(task); return; } void task(); },
  });
  await Promise.race([serial(() => agents.start({ key: 'a', attempt: 1, kind: 'agent', args: { prompt: 'x' } })), new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock')), 2000))]);
  assert.equal(landed.length, 0, 'the landing was lost to the crash');
  await agents.recover();
  await queue;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(landed, [['a', { refused: "The workflow's budget is spent", code: 'budget_exhausted' }]]);
  await agents.recover();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(landed.length, 1, 'landed once marked, recover leaves it');
});

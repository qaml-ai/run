import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowAgents, workflowRun, type Refusal, type WorkflowChildren } from '../src/workflow-agents.ts';
import type { EffectOutcome } from '../src/workflow-runner.ts';
import type { Placement } from '../../../shared/owner.ts';
import { withSql } from './sql-storage.ts';

// The real agent() executor: a workflow-owned child per `key:attempt`, started once, its ending landed on the effect,
// a refusal for money a pause (not a null), and an abort that stops every child.

type Submitted = { childId: string; request: { id: string; params: Record<string, any> }; placement: Placement };

function world(options: { budget?: number; concurrency?: number } = {}) {
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
  const landed: { key: string; attempt: number; outcome: EffectOutcome }[] = [], refused: { key: string; attempt: number; refusal: Refusal }[] = [], charged: number[] = [];
  let submitAnswer: () => { ok: true } | { ok: false; status: number; error: string } = () => ({ ok: true });
  let submitThrows = 0;
  const children: WorkflowChildren = {
    config: async args => ({ model: args.model ?? 'test/echo', systemPrompt: 'sub-agent', computer: { hosts: ['x'] } }),
    // The same key makes the same agent, as Directory.upsert does.
    create: async (config, key, place) => { created.push({ key, config, place }); return { id: `client_${key}` }; },
    submit: async (childId, request, placement) => {
      if (submitThrows > 0) { submitThrows--; throw new Error('the child was unreachable'); }
      submitted.push({ childId, request, placement });
      return submitAnswer();
    },
    cancel: async (childId, requestId) => { cancelled.push(`${childId}/${requestId}`); },
  };
  const agents = new WorkflowAgents({
    storage: storage as unknown as DurableObjectStorage, workflow: { id: 'wf_test', tenant: 'acme', bucket: 'wf-bucket' },
    budget: () => options.budget, concurrency: options.concurrency ?? 4, children,
    land: async (key, attempt, outcome) => { landed.push({ key, attempt, outcome }); },
    refuse: async (key, attempt, refusal) => { refused.push({ key, attempt, refusal }); },
    charge: async (_key, _attempt, usd) => { charged.push(usd); },
  });
  return { agents, created, submitted, cancelled, landed, refused, charged, answer: (fn: typeof submitAnswer) => { submitAnswer = fn; }, failSubmits: (n: number) => { submitThrows = n; } };
}

const effect = (key: string, args: Record<string, unknown> = { prompt: `do ${key}` }, attempt = 1) => ({ key, attempt, kind: 'agent', args, phase: undefined });
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

test('an ending lands the result once a run of it is charged; delivered again it lands again, and the runner keeps the first', async () => {
  const w = world();
  await w.agents.start(effect('plan'));
  const ending = completed(w.submitted[0]!, { output: { steps: 3 }, reply: 'ignored', usage: { costUsd: 0.2 } });
  assert.deepEqual(await w.agents.receiveEnding(ending), { accepted: true });
  assert.deepEqual(await w.agents.receiveEnding(ending), { accepted: true });
  assert.deepEqual(w.landed.map(entry => entry.outcome), [{ ok: true, value: { steps: 3 } }, { ok: true, value: { steps: 3 } }]);
  assert.deepEqual(w.charged, [0.2], 'charged once');
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
  assert.deepEqual(w.landed.at(-1)!, { key: 'plan', attempt: 1, outcome: { ok: true, value: { steps: 3 } } });
});

test('a payer out of credit pauses the workflow (refused, not null), at admission or at its spend limit; a new attempt is a new child', async () => {
  const w = world();
  w.answer(() => ({ ok: false, status: 402, error: 'The tenant has no credit' }));
  await w.agents.start(effect('a'));
  assert.deepEqual(w.refused, [{ key: 'a', attempt: 1, refusal: { code: 'payer_exhausted', message: 'The tenant has no credit' } }]);
  assert.equal(w.landed.length, 0, 'never landed as a failure the script would filter out');
  w.answer(() => ({ ok: true }));
  await w.agents.start(effect('b'));
  await w.agents.receiveEnding(completed(w.submitted.at(-1)!, { stopped: 'spend_limit', usage: { costUsd: 1 } }));
  assert.equal(w.refused.at(-1)!.refusal.code, 'payer_exhausted');
  assert.equal(w.landed.length, 0);
  // Resume re-issues it under the next attempt: a new child, a new request.
  await w.agents.start(effect('a', undefined, 2));
  assert.equal(w.created.length, 3);
  assert.notEqual(w.created.at(-1)!.key, w.created[0]!.key);
  assert.notEqual(w.submitted.at(-1)!.request.id, w.submitted[0]!.request.id);
});

test('a spent budget pauses with budget_exhausted before anything is made', async () => {
  const w = world({ budget: 0 });
  await w.agents.start(effect('a'));
  assert.equal(w.refused[0]!.refusal.code, 'budget_exhausted');
  assert.equal(w.created.length, 0);
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
  assert.equal(w.landed.length + w.refused.length, 0, 'not a failure: the child may have taken it');
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
  await assert.rejects(w.agents.start({ key: 's', attempt: 1, kind: 'sleep', args: { ms: 1 }, phase: undefined }), /agent\(\) effects/);
});

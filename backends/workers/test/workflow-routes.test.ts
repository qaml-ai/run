import test from 'node:test';
import assert from 'node:assert/strict';
import { startInput, workflowsEnabled, workflowId, workflowRoutes, WORKFLOWS_OFF } from '../src/workflow-routes.ts';
import { resolveAgentOptions, classModel } from '../src/workflow-types.ts';

test('workflows are on only for the tenants AGENT_WORKFLOW_TENANTS names; off, the API says so', async () => {
  assert.equal(workflowsEnabled({ AGENT_WORKFLOW_TENANTS: 'pilot-camel-code, test' }, 'pilot-camel-code'), true);
  assert.equal(workflowsEnabled({ AGENT_WORKFLOW_TENANTS: 'pilot-camel-code' }, 'acme'), false);
  assert.equal(workflowsEnabled({}, 'acme'), false);
  assert.equal(workflowsEnabled({ AGENT_WORKFLOW_TENANTS: '*' }, 'acme'), true);
  const response = await workflowRoutes(new Request('https://run/v1/workflows', { method: 'POST', body: '{}' }), {} as never, 'acme');
  assert.equal(response?.status, 403);
  assert.deepEqual(await response?.json(), { error: WORKFLOWS_OFF, code: 'WORKFLOWS_OFF' });
  assert.equal(await workflowRoutes(new Request('https://run/v1/agents'), {} as never, 'acme'), undefined, 'not a workflow path');
});

test('a start needs a script and a budget (null: no cap) and refuses what it does not know', () => {
  assert.throws(() => startInput({ script: 'return 1' }), /budget is \{ usd \}/);
  assert.throws(() => startInput({ script: '', budget: { usd: 1 } }), /script/);
  assert.throws(() => startInput({ script: 'x', budget: { usd: -1 } }), /positive/);
  assert.throws(() => startInput({ script: 'x', budget: { usd: 1 }, computer: true }), /Unknown field computer/);
  assert.throws(() => startInput({ script: 'x', budget: { usd: 1 }, classes: { worker: 'huge' } }), /classes maps/);
  assert.deepEqual(startInput({ script: 'x', budget: { usd: null }, args: { a: 1 }, classes: { critic: 'max' }, concurrency: 4, name: 'n' }),
    { script: 'x', budgetUsd: null, concurrency: 4, settings: { name: 'n', args: { a: 1 }, classes: { critic: 'max' } } });
});

test('an idempotency key gives the same id for the same tenant, another for another', async () => {
  assert.equal(await workflowId('t', 'k'), await workflowId('t', 'k'));
  assert.notEqual(await workflowId('t', 'k'), await workflowId('u', 'k'));
  assert.match(await workflowId('t'), /^wf_[0-9a-f]{40}$/);
});

test('types and classes: defaults, pins, the judgment guard and the critic schema', () => {
  assert.deepEqual(resolveAgentOptions({ type: 'worker' }), { type: 'worker', modelClass: 'fast' });
  assert.deepEqual(resolveAgentOptions({ type: 'critic', output: {} }), { type: 'critic', modelClass: 'strong' });
  assert.deepEqual(resolveAgentOptions({ type: 'worker' }, { classes: { worker: 'strong' } }), { type: 'worker', modelClass: 'strong' });
  assert.deepEqual(resolveAgentOptions({ class: 'max' }), { modelClass: 'max' });
  assert.deepEqual(resolveAgentOptions({ model: 'some/model' }), {});
  assert.throws(() => resolveAgentOptions({ type: 'critic' }), /needs|schema/);
  assert.throws(() => resolveAgentOptions({ type: 'lead', class: 'fast' }), /judges/);
  assert.deepEqual(resolveAgentOptions({ type: 'lead', class: 'fast', allowFastJudgment: true }), { type: 'lead', modelClass: 'fast' });
  assert.throws(() => resolveAgentOptions({ class: 'fast', model: 'x/y' }), /not both/);
  assert.throws(() => resolveAgentOptions({ type: 'boss' }), /type is one of/);
  assert.equal(classModel({}, 'strong'), 'camelrun/strong');
  assert.equal(classModel({ AGENT_WORKFLOW_CLASS_MODELS: '{"fast":"a/b"}' }, 'fast'), 'a/b');
});

test('a script edit refuses a non-integer rerunConfirmPercent with 400, before the runner sees it', async () => {
  const edits: unknown[] = [];
  const stub = { get: async () => ({ tenant: 'acme' }), view: async () => ({}), edit: async (options: unknown) => { edits.push(options); return { revision: 2 }; } };
  const env = { AGENT_WORKFLOW_TENANTS: 'acme', WORKFLOWS: { getByName: () => stub } } as never;
  const edit = (body: unknown) => workflowRoutes(new Request('https://run/v1/workflows/wf_1/script', { method: 'PUT', body: JSON.stringify(body) }), env, 'acme');
  const refused = await edit({ script: 'x', reason: 'r', rerunConfirmPercent: 12.5 });
  assert.equal(refused?.status, 400);
  assert.match(((await refused!.json()) as { error: string }).error, /integer/);
  assert.equal(edits.length, 0);
  assert.equal((await edit({ script: 'x', reason: 'r', rerunConfirmPercent: 30 }))?.status, 200);
  assert.deepEqual(edits, [{ code: 'x', reason: 'r', rerunConfirmPercent: 30 }]);
  // Another tenant's workflow is not found.
  assert.equal((await workflowRoutes(new Request('https://run/v1/workflows/wf_1'), { AGENT_WORKFLOW_TENANTS: '*', WORKFLOWS: { getByName: () => stub } } as never, 'other'))?.status, 404);
});

import assert from 'node:assert/strict';
import { contractTest, toolCall, until } from '../support.ts';

contractTest('inbox', 'tests/inputs-inbox.test.ts', 'both backends index human inputs and advance versions only on settlement', async (_t, f) => {
  f.setModel((_body, index) => index === 0
    ? toolCall('ask_user', { questions: [{ question: 'Which region?', header: 'Region', allowOther: true, options: [{ label: 'EU' }, { label: 'US' }] }] })
    : { role: 'assistant', content: 'Recorded.' });
  const definition = (await f.call('/v1/definitions', { body: {
    name: 'Inbox asker', builtins: ['ask_user'], humanInput: { approvers: ['boss'] },
  } })).json;
  const agent = (await f.call('/v1/agents', { body: { definition: definition.id, ttlSeconds: null } })).json.id;
  const run = await f.prompt(agent, 'Choose a region', undefined, { actor: 'alice' });
  const [input] = run.outcome.result.inputs;
  const pending = await until(async () => {
    const rows = await f.inputIndex(agent);
    return rows.length === 1 && rows[0].state === 'pending' && rows[0];
  }, 'pending inbox row');
  assert.deepEqual(pending, { state: 'pending', version: 1, priority: 'normal', priority_rank: 2, blocking: true, responders: ['alice', 'boss'] });
  const answer = { action: 'accept', content: { answers: { 'Which region?': 'EU' } }, actor: 'alice' };
  assert.equal((await f.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: answer })).status, 202);
  await until(async () => (await f.inputIndex(agent))[0]?.version === 2, 'settled inbox row');
  assert.equal((await f.inputIndex(agent))[0].state, 'answered');
  assert.equal((await f.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: answer })).status, 200);
  assert.equal((await f.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: 'decline', actor: 'alice' } })).status, 409);
  assert.equal((await f.inputIndex(agent))[0].version, 2);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkersFixture } from '../../../tests/contract/fixtures/workers.ts';
import { lastUser, until } from '../../../tests/contract/http.ts';

test('prompts submitted between upserts use their preceding configuration', { timeout: 90_000 }, async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const fixture = await createWorkersFixture(t, { respond: body => ({
    role: 'assistant', content: 'ok', ...(lastUser(body) === 'hold' ? { wait: gate.promise } : {}),
  }) });
  const upsert = async (systemPrompt: string) => {
    const response = await fixture.call('/v1/agents', { body: { systemPrompt }, headers: { 'Idempotency-Key': 'configuration-order' } });
    assert.equal(response.status, 201, response.text);
    return response.json;
  };
  const agent = await upsert('configuration A.');
  const unchanged = await upsert('configuration A.');
  await until(async () => (await fixture.call(`/v1/agents/${agent.id}/requests/${unchanged.reconfigured.id}`)).json.state === 'completed', 'unchanged configuration');
  assert.equal((await fixture.call(`/v1/agents/${agent.id}`)).json.configHash, agent.configHash);
  const prompt = async (text: string, requestId = text) => {
    const response = await fixture.call(`/v1/agents/${agent.id}/prompt`, { body: { text, requestId } });
    assert.equal(response.status, 202, response.text);
    return response.json.id as string;
  };
  const held = await prompt('hold');
  await until(() => fixture.model.bodies.length === 1, 'held turn');
  await upsert('configuration B.');
  const middle = await prompt('middle', 'z_middle');
  const nextMiddle = await prompt('next-middle', 'a_middle');
  await upsert('configuration C.');
  const last = await prompt('last');
  gate.resolve();
  for (const id of [held, middle, nextMiddle, last]) {
    await until(async () => (await fixture.call(`/v1/agents/${agent.id}/requests/${id}`)).json.state === 'completed', `request ${id}`);
  }
  assert.deepEqual(fixture.model.bodies.map(lastUser), ['hold', 'middle', 'next-middle', 'last']);
  for (const [index, label] of ['A', 'B', 'B', 'C'].entries()) {
    const system = fixture.model.bodies[index].messages.find((message: { role: string }) => ['system', 'developer'].includes(message.role))?.content;
    assert.ok(String(system).includes(`configuration ${label}.`), String(system));
  }
});

test('spend configuration applies before a queued turn and a retry preserves consumed allowance', { timeout: 90_000 }, async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const fixture = await createWorkersFixture(t, { respond: body => ({
    role: 'assistant', content: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.25 },
    ...(lastUser(body) === 'hold' ? { wait: gate.promise } : {}),
  }) });
  const agent = (await fixture.call('/v1/agents', { body: {} })).json;
  const path = `/v1/agents/${agent.id}`;
  const configure = () => fixture.call(`${path}/requests`, {
    body: { id: 'allowance', method: 'configure', params: { spendLimit: { usd: 1 } } },
  });
  assert.equal((await configure()).status, 202);
  await fixture.prompt(agent.id, 'spend');
  const spent = async () => (await fixture.call(path)).json.spendLimit.spent;
  assert.equal((await spent()).toFixed(2), '0.25');
  assert.equal((await configure()).status, 202);
  assert.equal((await spent()).toFixed(2), '0.25', 'replaying the configuration preserves its allowance counter');

  const held = await fixture.call(`${path}/prompt`, { body: { text: 'hold' } });
  assert.equal(held.status, 202);
  await until(() => fixture.model.bodies.length === 2, 'held turn');
  assert.equal((await fixture.call(`${path}/configuration`, { method: 'PATCH', body: { spendLimit: { usd: 0 } } })).status, 202);
  const refused = await fixture.call(`${path}/prompt`, { body: { text: 'refused' } });
  assert.deepEqual([refused.status, refused.json.code], [402, 'SPEND_LIMIT']);
  gate.resolve();
  await until(async () => (await fixture.call(`${path}/requests/${held.json.id}`)).json.state === 'completed', 'held turn completion');
});

test('aborting configuration waiters completes them and releases their attachment admission', { timeout: 90_000 }, async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const fixture = await createWorkersFixture(t, {
    env: { TENANT_MAX_ACTIVE: '1' },
    respond: body => ({ role: 'assistant', content: 'ok', ...(lastUser(body) === 'hold' ? { wait: gate.promise } : {}) }),
  });
  const agent = (await fixture.call('/v1/agents', { body: {} })).json;
  const path = `/v1/agents/${agent.id}`;
  const held = await fixture.call(`${path}/prompt`, { body: { text: 'hold' } });
  assert.equal(held.status, 202);
  await until(() => fixture.model.bodies.length === 1, 'held turn');
  assert.equal((await fixture.call(`${path}/configuration`, { method: 'PATCH', body: { systemPrompt: 'queued configuration' } })).status, 202);
  const waiter = await fixture.call(`${path}/prompt`, { body: {
    text: 'must not run', requestId: 'waiting-file', files: [{ name: 'queued.txt', data: Buffer.from('queued attachment').toString('base64') }],
  } });
  assert.equal(waiter.status, 202, waiter.text);
  const other = (await fixture.call('/v1/agents', { body: {} })).json;
  assert.equal((await fixture.call(`/v1/agents/${other.id}/prompt`, { body: { text: 'other' } })).status, 429);

  const aborted = await fixture.call(`${path}/abort`, { body: {} });
  assert.equal(aborted.status, 200, aborted.text);
  assert.ok(aborted.json.cancelled.includes('waiting-file'));
  const cancelled = (await fixture.call(`${path}/requests/waiting-file`)).json;
  assert.equal(cancelled.state, 'completed');
  assert.equal(cancelled.outcome.result.code, 'cancelled');
  gate.resolve();
  await until(async () => (await fixture.call(`${path}/requests/${held.json.id}`)).json.state === 'completed', 'aborted running turn');
  await fixture.prompt(other.id, 'other');
  assert.equal((await fixture.call(`${path}/configuration`, { method: 'PATCH', body: { systemPrompt: 'after abort' } })).status, 202);
  await fixture.prompt(agent.id, 'after');
  assert.deepEqual(fixture.model.bodies.map(lastUser), ['hold', 'other', 'after']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkersFixture } from '../../../tests/contract/fixtures/workers.ts';
import { lastUser, until } from '../../../tests/contract/http.ts';

test('configuration patches remove key scopes while creation rejects null', { timeout: 90_000 }, async t => {
  const fixture = await createWorkersFixture(t);
  const rejected = await fixture.call('/v1/agents', { body: { keyScope: null } });
  assert.equal(rejected.status, 400, rejected.text);
  const created = await fixture.call('/v1/agents', { body: { keyScope: 'org-1' } });
  assert.equal(created.status, 201, created.text);
  const path = `/v1/agents/${created.json.id}`;
  assert.equal((await fixture.call(path)).json.keyScope, 'org-1');
  const accepted = await fixture.call(`${path}/configuration`, { method: 'PATCH', body: { keyScope: null } });
  assert.equal(accepted.status, 202, accepted.text);
  const completed = await until(async () => {
    const response = await fixture.call(`${path}/requests/${accepted.json.id}`);
    assert.equal(response.status, 200, response.text);
    return response.json.state === 'completed' && response.json;
  }, 'key scope removal');
  assert.equal(completed.outcome.error, undefined);
  assert.equal(completed.outcome.result.configured, true);
  assert.equal((await fixture.call(path)).json.keyScope, null);
});

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

test('a definition applied behind a queued configuration change keeps that change', { timeout: 90_000 }, async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const fixture = await createWorkersFixture(t, { respond: body => ({
    role: 'assistant', content: 'ok', ...(lastUser(body) === 'hold' ? { wait: gate.promise } : {}),
  }) });
  const definition = (await fixture.call('/v1/definitions', { body: { name: 'Queued', systemPrompt: 'Revision one.', maxOutputTokens: 100 } })).json;
  const agent = (await fixture.call('/v1/agents', { body: { definition: definition.id } })).json;
  const path = `/v1/agents/${agent.id}`;
  const held = (await fixture.call(`${path}/prompt`, { body: { text: 'hold', requestId: 'hold' } })).json.id;
  await until(() => fixture.model.bodies.length === 1, 'held turn');
  // Both wait for the turn: the agent's own change first, then the revision.
  const patched = await fixture.call(`${path}/configuration`, { method: 'PATCH', body: { requestId: 'own-limit', maxOutputTokens: 175 } });
  assert.equal(patched.status, 202, patched.text);
  assert.notEqual(patched.json.state, 'completed');
  const apply = () => fixture.call(`/v1/definitions/${definition.id}`, { method: 'PATCH', body: { systemPrompt: 'Revision two.', maxOutputTokens: 200, apply: 'all' } });
  const applied = await apply();
  assert.equal(applied.status, 200, applied.text);
  assert.deepEqual(applied.json.applied.map((entry: { status: string }) => entry.status), ['queued']);
  gate.resolve();
  for (const id of [held, 'own-limit', applied.json.applied[0].requestId])
    await until(async () => (await fixture.call(`${path}/requests/${id}`)).json.state === 'completed', `request ${id}`);
  const configuration = (await fixture.call(`${path}/configuration`)).json;
  assert.equal(configuration.maxOutputTokens, 175, 'the agent set its own limit before the revision applied');
  assert.equal(configuration.systemPrompt, 'Revision two.');
  assert.deepEqual((await fixture.call(`/v1/definitions/${definition.id}/agents`)).json, [{ id: agent.id, revision: 2 }]);
  // Applying the same revision again is the same request, whatever the agent changed since.
  const again = await apply();
  assert.deepEqual(again.json.applied.map((entry: { status: string }) => entry.status), ['updated'], again.text);
  assert.equal((await fixture.call(`${path}/configuration`)).json.maxOutputTokens, 175);
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

test('queued upserts preserve omitted model and language from the preceding configuration', { timeout: 90_000 }, async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const fixture = await createWorkersFixture(t, {
    respond: body => ({ role: 'assistant', content: 'ok', ...(lastUser(body) === 'hold' ? { wait: gate.promise } : {}) }),
  });
  const upsert = async (body: object) => {
    const response = await fixture.call('/v1/agents', { body, headers: { 'Idempotency-Key': 'omitted-configuration' } });
    assert.equal(response.status, 201, response.text);
    return response.json;
  };
  const agent = await upsert({});
  assert.equal((await fixture.call(`/v1/agents/${agent.id}/prompt`, { body: { text: 'hold' } })).status, 202);
  await until(() => fixture.model.bodies.length === 1, 'held turn');
  const model = 'openrouter/openai/gpt-4.1';
  await upsert({ model, language: 'fr', systemPrompt: 'first queued configuration', fileTools: false, codeMode: false, systemPromptAppend: 'temporary' });
  const last = await upsert({ systemPrompt: 'last queued configuration' });
  gate.resolve();
  await until(async () => (await fixture.call(`/v1/agents/${agent.id}/requests/${last.reconfigured.id}`)).json.state === 'completed', 'last queued configuration');
  const saved = (await fixture.call(`/v1/agents/${agent.id}`)).json;
  assert.equal(saved.model, model);
  assert.equal(saved.language, 'fr');
  assert.equal(saved.systemPrompt, 'last queued configuration');
  assert.deepEqual([saved.fileTools, saved.codeMode, saved.systemPromptAppend], [true, true, '']);
  await fixture.prompt(agent.id, 'after');
  assert.equal(fixture.model.bodies.at(-1).model, 'openai/gpt-4.1');
});

test('a refused configuration waiter releases its attachment admission', { timeout: 90_000 }, async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const fixture = await createWorkersFixture(t, {
    env: { TENANT_MAX_ACTIVE: '1' },
    respond: body => ({ role: 'assistant', content: 'ok', ...(lastUser(body) === 'hold' ? { wait: gate.promise } : {}) }),
  });
  const agent = (await fixture.call('/v1/agents', { body: {} })).json;
  const path = `/v1/agents/${agent.id}`;
  assert.equal((await fixture.call(`${path}/prompt`, { body: { text: 'hold' } })).status, 202);
  await until(() => fixture.model.bodies.length === 1, 'held turn');
  assert.equal((await fixture.call(`${path}/configuration`, { method: 'PATCH', body: { systemPrompt: 'queued configuration' } })).status, 202);
  const waiter = await fixture.call(`${path}/prompt`, { body: {
    text: 'must not run', requestId: 'refused-file', files: [{ name: 'queued.txt', data: Buffer.from('queued attachment').toString('base64') }],
  } });
  assert.equal(waiter.status, 202, waiter.text);
  assert.equal((await fixture.call(`${path}/configuration`, { method: 'PATCH', body: { spendLimit: { usd: 0 } } })).status, 202);
  gate.resolve();
  const refused = await until(async () => {
    const record = (await fixture.call(`${path}/requests/refused-file`)).json;
    return record.state === 'completed' && record;
  }, 'refused deferred prompt');
  assert.match(refused.error, /spend limit/);
  const other = (await fixture.call('/v1/agents', { body: {} })).json;
  await fixture.prompt(other.id, 'other');
  assert.deepEqual(fixture.model.bodies.map(lastUser), ['hold', 'other']);
});

test('keyed configuration preserves mounts unless it explicitly remounts', { timeout: 90_000 }, async t => {
  const fixture = await createWorkersFixture(t);
  const volume = (await fixture.call('/v1/volumes', { body: { name: 'mounted' } })).json.id;
  const headers = { 'Idempotency-Key': 'mounted-configuration' };
  const mounts = (path: string) => [{ volumeId: volume, path, mode: 'rw' }, { workspace: true }];
  const initial = await fixture.call('/v1/agents', { body: { mounts: mounts('/data') }, headers });
  assert.equal(initial.status, 201, initial.text);
  const repeated = await fixture.call('/v1/agents', { body: { mounts: mounts('/data') }, headers });
  assert.equal(repeated.status, 201, repeated.text);
  const refused = await fixture.call('/v1/agents', { body: { mounts: mounts('/moved') }, headers });
  assert.equal(refused.status, 409, refused.text);
  assert.match(refused.json.error, /mounts cannot change.*remount: true/);
  const moved = await fixture.call('/v1/agents', { body: { mounts: mounts('/moved'), remount: true }, headers });
  assert.equal(moved.status, 201, moved.text);
  await until(async () => (await fixture.call(`/v1/agents/${initial.json.id}/requests/${moved.json.reconfigured.id}`)).json.state === 'completed', 'remounted configuration');
  assert.equal((await fixture.call(`/v1/agents/${initial.json.id}/mounts`)).json[0].path, '/moved');
});

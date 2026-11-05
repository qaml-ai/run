import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkersFixture } from '../../../tests/contract/fixtures/workers.ts';
import { lastUser, until } from '../../../tests/contract/http.ts';

test('definition targets return idle receipts and share prompt ordering with keyed upserts', { timeout: 90_000 }, async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const fixture = await createWorkersFixture(t, { respond: body => ({
    role: 'assistant', content: 'ok', ...(lastUser(body) === 'hold' ? { wait: gate.promise } : {}),
  }) });
  const definition = await fixture.call('/v1/definitions', { body: { name: 'Ordered targets', systemPrompt: 'target A.' } });
  assert.equal(definition.status, 201, definition.text);
  const headers = { 'Idempotency-Key': 'definition-target-order' };
  const created = await fixture.call('/v1/agents', { body: { definition: definition.json.id }, headers });
  assert.equal(created.status, 201, created.text);
  const path = `/v1/agents/${created.json.id}`;
  const apply = async (systemPrompt: string) => {
    const result = await fixture.call(`/v1/definitions/${definition.json.id}`, {
      method: 'PATCH', body: { systemPrompt, apply: 'all' },
    });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.json.applied.length, 1);
    return result.json.applied[0];
  };
  const idle = await apply('target B.');
  assert.equal(idle.status, 'updated');
  const receipt = (await fixture.call(`${path}/requests/${idle.requestId}`)).json;
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.outcome.result.changed, true);
  assert.equal('configurationOrigin' in receipt, false);
  assert.equal(receipt.outcome.result.configHash, (await fixture.call(path)).json.configHash);

  const prompt = async (text: string) => {
    const result = await fixture.call(`${path}/prompt`, { body: { text, requestId: text } });
    assert.equal(result.status, 202, result.text);
    return result.json.id as string;
  };
  const held = await prompt('hold');
  await until(() => fixture.model.bodies.length === 1, 'held turn');
  const queued = await apply('target C.');
  assert.equal(queued.status, 'queued');
  const middle = await prompt('middle');
  const upsert = await fixture.call('/v1/agents', {
    body: { definition: definition.json.id, systemPromptAppend: 'last configuration.' }, headers,
  });
  assert.equal(upsert.status, 201, upsert.text);
  const last = await prompt('last');
  gate.resolve();
  for (const id of [held, queued.requestId, middle, upsert.json.reconfigured.id, last]) {
    const record = await until(async () => {
      const current = (await fixture.call(`${path}/requests/${id}`)).json;
      return current.state === 'completed' && current;
    }, `request ${id}`);
    assert.equal(record.error, undefined);
  }
  assert.deepEqual(fixture.model.bodies.map(lastUser), ['hold', 'middle', 'last']);
  const systems = fixture.model.bodies.map(body => String(body.messages.find((message: { role: string }) => ['system', 'developer'].includes(message.role))?.content));
  assert.match(systems[0], /target B\./);
  assert.match(systems[1], /target C\./);
  assert.doesNotMatch(systems[1], /last configuration\./);
  assert.match(systems[2], /target C\./);
  assert.match(systems[2], /last configuration\./);
});

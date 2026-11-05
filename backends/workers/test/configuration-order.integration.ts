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

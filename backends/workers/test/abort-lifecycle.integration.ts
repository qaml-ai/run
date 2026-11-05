import assert from 'node:assert/strict';
import test from 'node:test';
import { startFixture } from './fixture.ts';

test('abort cancels queued runs, keep preserves them, and idle legacy steer joins only the next prompt', { timeout: 120_000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  const call = async (path: string, value?: unknown) => {
    const response = await fetch(fixture.url + path, { method: value === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const created = await call('/v1/agents', { model: 'test/echo' }), base = `/v1/agents/${created.body.id}`;
  const submit = (id: string, text: string, whileRunning?: string) => call(`${base}/requests`, { id, method: 'prompt', params: { text, ...(whileRunning ? { whileRunning } : {}) } });
  const until = async (id: string, finished = true) => {
    for (let n = 0; n < 300; n++) {
      const value = (await call(`${base}/requests/${id}`)).body;
      if (finished ? value.state === 'completed' : value.began) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Request ${id} did not ${finished ? 'finish' : 'begin'}`);
  };
  await submit('first', 'slow:5000:first');
  await until('first', false);
  await submit('queued', 'queued');
  await submit('steered', 'steered', 'steer');
  const cancelled = await call(`${base}/abort`, {});
  assert.deepEqual(cancelled.body, { aborted: true, cancelled: ['queued', 'steered'] });
  for (const id of cancelled.body.cancelled) assert.equal((await until(id)).outcome.result.code, 'cancelled');
  await submit('second', 'slow:5000:second');
  await until('second', false);
  await submit('kept', 'kept');
  assert.equal((await call(`${base}/abort`, { queued: 'invalid' })).status, 400);
  assert.deepEqual((await call(`${base}/abort`, { queued: 'keep' })).body, { aborted: true, cancelled: [] });
  assert.equal((await until('kept')).outcome.result.reply, 'Echo: kept');

  const before = (await call(`${base}/history`)).body.messages.length;
  assert.equal((await call(`${base}/requests`, { id: 'legacy', method: 'steer', params: { text: 'held second' } })).status, 202);
  assert.equal((await call(`${base}/history`)).body.messages.length, before, 'an idle legacy steer writes no history and makes no model request');
  await submit('starts', 'starts first');
  assert.equal((await until('starts')).outcome.result.reply, 'Echo: held second');
  const messages = (await call(`${base}/history`)).body.messages.slice(before);
  assert.deepEqual(messages.map((message: any) => [message.role, message.requestId]), [['user', 'starts'], ['user', 'legacy'], ['assistant', undefined]]);
  await call(`${base}/requests`, { id: 'discard', method: 'steer', params: { text: 'must not reach history' } });
  await call(`${base}/abort`, {});
  await submit('after', 'after');
  await until('after');
  assert.doesNotMatch(JSON.stringify((await call(`${base}/history`)).body), /must not reach history/);
});

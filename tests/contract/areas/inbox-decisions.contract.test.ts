import assert from 'node:assert/strict';
import { contractTest, toolCall, toolResults, until, OPERATOR } from '../support.ts';

contractTest('human-input', 'tests/inbox-decisions.test.ts:18', 'non-blocking decisions survive prompts, replace keys, and deliver a batch once', async (_t, f) => {
  const def = await f.call('/v1/definitions', { body: { name: 'Decision asker', builtins: ['request_decision'] } });
  assert.equal(def.status, 201, def.text);
  const made = await f.call('/v1/agents', { body: { definition: def.json.id, ttlSeconds: null } });
  const id = made.json.id;
  for (let i = 0; i < 3; i++) {
    // A new call on each prompt, even though old tool results remain in history.
    f.setModel((body, index) => index % 2 === 0 ? toolCall('request_decision', { title: `Choose ${i}`, body: 'Which path?', key: i < 2 ? 'plan' : 'other', priority: 'high', options: [{ label: 'A' }, { label: 'B' }], links: ['https://example.com/review'], recommendation: { answer: { answers: { [`Choose ${i}`]: 'A' } }, reason: 'Preferred' }, applyRecommendationOnExpiry: true }, `decision_${i}`) : { role: 'assistant', content: 'Continuing' });
    const run = await f.prompt(id, `Ask ${i}`);
    assert.equal(run.outcome.result.reply, 'Continuing');
  }
  const all = (await f.call(`/v1/agents/${id}/inputs`)).json;
  assert.equal(all.length, 3);
  assert.equal(all.filter((x: any) => x.state === 'withdrawn').length, 1);
  const pending = all.filter((x: any) => x.state === 'pending');
  assert.equal(pending.length, 2);
  assert.ok(pending.every((x: any) => x.kind === 'decision' && x.blocking === false && x.priority === 'high'));
  assert.ok(pending.every((x: any) => Math.abs(x.expiresAt - x.createdAt - 7 * 86400000) < 60000));
  for (const route of ['/v1/inbox', '/v1/inputs']) {
    const response = await f.call(`${route}?kind=decision&priority=high`);
    assert.equal(response.status, 200, response.text);
    const page = response.json;
    assert.deepEqual(page.items.map((item: any) => item.id).sort(), pending.map((item: any) => item.id).sort());
    assert.equal(page.counts.priority.high, 2);
    for (const listed of page.items) {
      const item = pending.find((item: any) => item.id === listed.id);
      for (const field of ['kind', 'message', 'detail', 'priority', 'blocking', 'key', 'version', 'links', 'recommendation', 'applyRecommendationOnExpiry'])
        assert.deepEqual(listed[field], item[field], field);
      assert.equal(listed.inputId, item.id);
    }
    assert.equal(JSON.stringify(page).includes('argumentsHash'), false);
    assert.equal(JSON.stringify(page).includes('delivery'), false);
  }
  const before = f.model.bodies.length;
  f.setModel(() => ({ role: 'assistant', content: 'Decisions received' }));
  const answers = { answers: pending.map((x: any) => ({ id: x.id, action: 'accept', content: { answers: { [x.message]: 'A' } } })) };
  const answered = await f.call(`/v1/agents/${id}/inputs`, { body: answers });
  assert.equal(answered.status, 202, answered.text);
  await until(() => f.model.bodies.length === before + 1, 'one decision notice');
  const text = JSON.stringify(f.model.bodies.at(-1));
  for (const item of pending) assert.ok(text.includes(item.id));
  assert.ok(text.includes('decision_answer'));
  assert.equal((await f.call(`/v1/agents/${id}/inputs`, { body: answers })).status, 200);
  assert.deepEqual((await f.call('/v1/inbox?kind=decision')).json.items, [], 'answered decisions leave the inbox');
});

contractTest('human-input', 'tests/inbox-decisions.test.ts:8', 'ask_user stores its recommendation and applies it on expiry only with opt-in', async (_t, f) => {
  f.setModel((body, index) => index === 0 ? toolCall('ask_user', {
    attachments: [{ path: '/workspace/review.txt', caption: 'Review' }], priority: 'urgent', links: ['https://example.com/review'], applyRecommendationOnExpiry: true,
    questions: [{ question: 'Region?', header: 'Region', options: [{ label: 'EU' }, { label: 'US' }], recommended: 'EU', reason: 'Nearest' }],
  }) : { role: 'assistant', content: toolResults(body).at(-1) });
  const def = await f.call('/v1/definitions', { body: { name: 'Expiry asker', builtins: ['ask_user'] } });
  const volume = (await f.call('/v1/volumes', { body: { name: 'Review files' } })).json.id;
  const uploaded = await fetch(`${f.base}/v1/volumes/${volume}/files/review.txt`, { method: 'PUT', headers: { Authorization: `Bearer ${OPERATOR}`, 'Content-Type': 'text/plain' }, body: 'Review this' });
  assert.equal(uploaded.status, 201);
  const made = await f.call('/v1/agents', { body: { definition: def.json.id, ttlSeconds: null, mounts: [{ volumeId: volume, path: '/workspace', mode: 'rw' }] } });
  const id = made.json.id;
  const waiting = await f.prompt(id, 'Choose');
  const [input] = waiting.outcome.result.inputs;
  assert.equal(input.priority, 'urgent');
  assert.equal(input.attachments[0].path, '/workspace/review.txt');
  assert.equal(input.attachments[0].caption, 'Review');
  assert.ok(Number.isInteger(input.attachments[0].version));
  assert.deepEqual(input.links, ['https://example.com/review']);
  assert.deepEqual(input.recommendation.answer, { answers: { 'Region?': 'EU' } });
  const page = await until(async () => {
    const response = await f.call('/v1/inbox?kind=question&priority=urgent');
    assert.equal(response.status, 200, response.text);
    return response.json.items.find((item: any) => item.inputId === input.id);
  }, 'question metadata reaches the inbox');
  for (const field of ['attachments', 'links', 'recommendation', 'applyRecommendationOnExpiry'])
    assert.deepEqual(page[field], input[field], field);
  await f.expireInputs(id);
  await until(() => f.model.bodies.length === 2, 'expiry resumes the question');
  assert.deepEqual(JSON.parse(toolResults(f.model.bodies[1]).at(-1)).answers, { 'Region?': 'EU' });
  const settled = (await f.call(`/v1/agents/${id}/inputs`)).json[0];
  assert.equal(settled.state, 'expired');
  assert.equal(settled.answer.by.system, 'expired');
  assert.equal(settled.answer.action, 'accept');
});

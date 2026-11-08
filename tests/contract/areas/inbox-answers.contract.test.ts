import { existsSync } from "node:fs";
import assert from 'node:assert/strict';
import { contractTest, toolCall, until } from '../support.ts';

contractTest('inbox-answers', 'shared/inbox-answers.ts', 'batch answers use the authority, enforce responders, and replay outcomes', async (_t, f) => {
  f.setModel((_body, index) => index === 0 ? toolCall('ask_user', { questions: [{ question: 'Region?', header: 'Region', options: [{ label: 'EU' }, { label: 'US' }] }] }) : { role: 'assistant', content: 'Recorded.' });
  const definition = (await f.call('/v1/definitions', { body: { name: 'Batch asker', builtins: ['ask_user'] } })).json;
  const created = await f.call('/v1/agents', { body: { definition: definition.id, ttlSeconds: null } });
  assert.equal(created.status, 201, created.text);
  const agent = created.json.id;
  await f.prompt(agent, 'Ask', undefined, { actor: 'alice' });
  const item = await until(async () => (await f.call('/v1/inbox')).json.items.find((i: any) => i.agent === agent), 'indexed question');
  const answer = { id: item.id, version: item.version, action: 'accept', content: { answers: { 'Region?': 'EU' } }, actor: 'alice' };
  const forbidden = await f.call('/v1/inbox/answers', { body: { requestId: 'forbidden', answers: [{ ...answer, actor: 'mallory' }] } });
  assert.equal(forbidden.status, 200, forbidden.text);
  assert.equal(forbidden.json.outcomes[0].outcome, 'forbidden');
  assert.equal('state' in forbidden.json.outcomes[0], false);
  assert.equal('by' in forbidden.json.outcomes[0], false);
  const moved = await f.call('/v1/inbox/answers', { body: { requestId: 'moved', answers: [{ ...answer, version: 20 }] } });
  assert.equal(moved.json.outcomes[0].outcome, 'conflict');
  const batch = { requestId: 'batch', answers: [answer, { ...answer, id: 'absent' }] };
  const [first, concurrent] = await Promise.all([f.call('/v1/inbox/answers', { body: batch }), f.call('/v1/inbox/answers', { body: batch })]);
  assert.deepEqual(concurrent.json, first.json, concurrent.text);
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json.outcomes.map((o: any) => o.outcome), ['answered', 'unknown']);
  assert.deepEqual((await f.call('/v1/inbox/answers', { body: batch })).json, first.json);
  const reordered = { requestId: batch.requestId, answers: [{ actor: answer.actor, content: answer.content, action: answer.action, version: answer.version, id: answer.id }, batch.answers[1]] };
  assert.deepEqual((await f.call('/v1/inbox/answers', { body: reordered })).json, first.json);
  const changed = { ...batch, answers: [{ ...answer, content: { answers: { 'Region?': 'US' } } }] };
  assert.equal((await f.call('/v1/inbox/answers', { body: changed })).status, 409);
  const forbiddenSettled = await f.call('/v1/inbox/answers', { body: { requestId: 'forbidden-settled', answers: [{ ...answer, actor: 'mallory' }] } });
  assert.deepEqual(forbiddenSettled.json.outcomes.map((o: any) => [o.outcome, 'state' in o, 'by' in o]), [['forbidden', false, false]]);
  await f.ageInboxReceipt(batch.requestId);
  assert.equal((await f.call('/v1/inbox/answers', { body: changed })).status, 200, 'expired key accepts a new payload');
  await f.ageInboxReceipt(batch.requestId);
  assert.equal(await f.pruneInboxReceipts(), 0);
  const conflict = await f.call('/v1/inbox/answers', { body: { ...batch, requestId: 'again' } });
  assert.equal(conflict.json.outcomes[0].outcome, 'same');
});

contractTest('inbox-answers', 'shared/inbox-answers.ts', 'several answers for one suspended agent resume one model turn', async (_t, f) => {
  f.setModel((_body, index) => index === 0 ? { role: 'assistant', tool_calls: ['a', 'b'].map((id, i) => ({
    ...toolCall('ask_user', { questions: [{ question: `Choice ${id}?`, header: 'Choice', options: [{ label: 'Yes' }, { label: 'No' }] }] }, id).tool_calls[0], index: i,
  })) } : { role: 'assistant', content: 'Both recorded.' });
  const definition = (await f.call('/v1/definitions', { body: { name: 'Two questions', builtins: ['ask_user'] } })).json;
  const created = await f.call('/v1/agents', { body: { definition: definition.id, ttlSeconds: null } });
  assert.equal(created.status, 201, created.text);
  const agent = created.json.id;
  await f.prompt(agent, 'Ask both');
  const items = await until(async () => {
    const items = (await f.call('/v1/inbox')).json.items.filter((i: any) => i.agent === agent);
    return items.length === 2 && items;
  }, 'two indexed questions');
  const body = { requestId: 'two', answers: items.map((i: any) => ({ id: i.id, version: i.version, action: 'accept', content: { answers: { [i.message]: 'Yes' } } })) };
  const result = await f.call('/v1/inbox/answers', { body });
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.json.outcomes.map((o: any) => o.outcome), ['answered', 'answered']);
  await until(async () => f.model.bodies.length === 2, 'one resumed turn');
  assert.equal(f.model.bodies.length, 2);
  assert.deepEqual((await f.call('/v1/inbox/answers', { body })).json, result.json);
  assert.equal(f.model.bodies.length, 2);
});

contractTest('inbox-answers', 'shared/inbox-answers.ts', 'a mixed batch answers fresh items despite answered and expired neighbors', async (_t, f) => {
  f.setModel(() => toolCall('ask_user', { questions: [{ question: 'Region?', header: 'Region', options: [{ label: 'EU' }, { label: 'US' }] }] }));
  const definition = await f.call('/v1/definitions', { body: { name: 'Mixed inbox', builtins: ['ask_user'] } });
  assert.equal(definition.status, 201, definition.text);
  const items: any[] = [];
  for (let i = 0; i < 3; i++) {
    const created = await f.call('/v1/agents', { body: { definition: definition.json.id, ttlSeconds: null } });
    assert.equal(created.status, 201, created.text);
    await f.prompt(created.json.id, 'Ask', undefined, { actor: 'alice' });
    items.push(await until(async () => (await f.call('/v1/inbox')).json.items.find((item: any) => item.agent === created.json.id), 'indexed question'));
  }
  f.setModel(() => ({ role: 'assistant', content: 'Recorded.' }));
  const answer = (item: any) => ({ id: item.id, version: item.version, action: 'accept', content: { answers: { 'Region?': 'EU' } }, actor: 'alice' });
  const settled = await f.call(`/v1/agents/${items[1].agent}/inputs/${items[1].inputId}`, { body: answer(items[1]) });
  assert.equal(settled.status, 202, settled.text);
  await f.expireInputs(items[2].agent);
  const body = { requestId: 'mixed', answers: items.map(answer) };
  const result = await f.call('/v1/inbox/answers', { body });
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.json.outcomes.map((o: any) => o.outcome), ['answered', 'same', 'conflict']);
  assert.equal(result.json.outcomes[2].state, 'expired');
  assert.deepEqual((await f.call('/v1/inbox/answers', { body })).json, result.json);
});

// This authority is supplied by slices 6–7. Keep the combined contract here so
// bringing that branch in also exercises withdrawal and the actual notice.
if (existsSync(new URL('../../../backends/workers/src/inbox-decisions.ts', import.meta.url))) {
  contractTest('inbox-answers', 'shared/inbox-answers.ts', 'withdrawn decisions conflict while several fresh answers arrive in one notice', async (_t, f) => {
    const definition = await f.call('/v1/definitions', { body: { name: 'Inbox decisions', builtins: ['request_decision'] } });
    assert.equal(definition.status, 201, definition.text);
    const created = await f.call('/v1/agents', { body: { definition: definition.json.id, ttlSeconds: null } });
    assert.equal(created.status, 201, created.text);
    const agent = created.json.id;
    for (let i = 0; i < 3; i++) {
      f.setModel((_body, index) => index === 0 ? toolCall('request_decision', { title: `Choice ${i}`, body: 'Review', key: i < 2 ? 'plan' : 'other', options: [{ label: 'A' }, { label: 'B' }] }, `decision_${i}`) : { role: 'assistant', content: 'Continuing.' });
      await f.prompt(agent, `Ask ${i}`, undefined, { actor: 'alice' });
    }
    const all = (await f.call(`/v1/agents/${agent}/inputs`)).json;
    assert.equal(all.length, 3);
    assert.equal(all.filter((i: any) => i.state === 'withdrawn').length, 1);
    const before = f.model.bodies.length;
    f.setModel(() => ({ role: 'assistant', content: 'Decisions recorded.' }));
    const body = { requestId: 'decisions', answers: all.map((i: any) => ({ id: i.id, version: i.version, action: 'accept', content: { answers: { [i.message]: 'A' } }, actor: 'alice' })) };
    const result = await f.call('/v1/inbox/answers', { body });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.json.outcomes.filter((o: any) => o.outcome === 'answered').length, 2);
    assert.equal(result.json.outcomes.find((o: any) => o.outcome === 'conflict').state, 'withdrawn');
    await until(() => f.model.bodies.length === before + 1, 'one decision notice');
    const notice = JSON.stringify(f.model.bodies.at(-1));
    assert.match(notice, /decision_answer/);
    for (const item of all.filter((i: any) => i.state === 'pending')) assert.ok(notice.includes(item.id));
    assert.deepEqual((await f.call('/v1/inbox/answers', { body })).json, result.json);
    assert.equal(f.model.bodies.length, before + 1);
  });
}

contractTest('inbox-answers', 'shared/inbox-answers.ts', 'a down agent is unavailable without blocking a healthy agent', async (_t, f) => {
  f.setModel(() => toolCall('ask_user', { questions: [{ question: 'Region?', header: 'Region', options: [{ label: 'EU' }, { label: 'US' }] }] }));
  const definition = (await f.call('/v1/definitions', { body: { name: 'Availability', builtins: ['ask_user'] } })).json;
  const items: any[] = [];
  for (let i = 0; i < 2; i++) {
    const created = await f.call('/v1/agents', { body: { definition: definition.id, ttlSeconds: null } });
    assert.equal(created.status, 201, created.text);
    await f.prompt(created.json.id, 'Ask');
    items.push(await until(async () => (await f.call('/v1/inbox')).json.items.find((item: any) => item.agent === created.json.id), 'indexed input'));
  }
  f.setModel(() => ({ role: 'assistant', content: 'Recorded.' }));
  await f.failInboxAgent(items[0].agent);
  const body = { requestId: 'availability', answers: items.map(item => ({ id: item.id, version: item.version, action: 'accept', content: { answers: { 'Region?': 'EU' } } })) };
  const response = await f.call('/v1/inbox/answers', { body });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json.outcomes[0], { id: items[0].id, outcome: 'unavailable', status: 503, retryable: true });
  assert.equal(response.json.outcomes[1].outcome, 'answered');
  assert.deepEqual((await f.call('/v1/inbox/answers', { body })).json, response.json);
  const pending = (await f.call('/v1/inbox')).json.items.find((item: any) => item.id === items[0].id);
  assert.equal(pending.state, 'pending');
}, { env: { AGENT_IDLE_MS: '1000' }, timeout: 90_000 });

contractTest('inbox-answers', 'shared/inbox-answers.ts', 'the per-agent writer rejects a stale version while the input is still pending', async (_t, f) => {
  f.setModel(() => toolCall('ask_user', { questions: [{ question: 'Region?', header: 'Region', options: [{ label: 'EU' }, { label: 'US' }] }] }));
  const definition = (await f.call('/v1/definitions', { body: { name: 'CAS input', builtins: ['ask_user'] } })).json;
  const created = await f.call('/v1/agents', { body: { definition: definition.id, ttlSeconds: null } });
  assert.equal(created.status, 201, created.text);
  const agent = created.json.id;
  await f.prompt(agent, 'Ask');
  const item = await until(async () => (await f.call('/v1/inbox')).json.items.find((item: any) => item.agent === agent), 'input');
  await f.advanceInboxVersion(agent);
  const response = await f.call(`/v1/agents/${agent}/inputs/${item.inputId}`, { body: { version: item.version, action: 'accept', content: { answers: { 'Region?': 'EU' } } } });
  assert.equal(response.status, 409, response.text);
  const current = (await f.call('/v1/inbox')).json.items.find((input: any) => input.id === item.id);
  assert.equal(current.state, 'pending');
  assert.equal(current.version, item.version + 1);
});

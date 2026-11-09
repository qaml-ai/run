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
  const answer = { agent: item.agent, id: item.id, version: item.version, action: 'accept', content: { answers: { 'Region?': 'EU' } }, actor: 'alice' };
  const forbidden = await f.call('/v1/inbox/answers', { body: { requestId: 'forbidden', answers: [{ ...answer, actor: 'mallory' }] } });
  assert.equal(forbidden.status, 200, forbidden.text);
  assert.equal(forbidden.json.outcomes[0].outcome, 'forbidden');
  assert.equal('state' in forbidden.json.outcomes[0], false);
  assert.equal('by' in forbidden.json.outcomes[0], false);
  const forbiddenVersion = await f.call(`/v1/agents/${agent}/inputs/${item.inputId}`, { body: { ...answer, actor: 'mallory', version: 20 } });
  assert.equal(forbiddenVersion.status, 403, forbiddenVersion.text);
  assert.equal('input' in forbiddenVersion.json, false);
  const moved = await f.call('/v1/inbox/answers', { body: { requestId: 'moved', answers: [{ ...answer, version: 20 }] } });
  assert.equal(moved.json.outcomes[0].outcome, 'conflict');
  const outsider = await f.seedTenant('outsider');
  const hidden = await f.call('/v1/inbox/answers', { token: outsider.token, body: { requestId: 'foreign-agent', answers: [answer] } });
  assert.equal(hidden.status, 200, hidden.text);
  assert.equal(hidden.json.outcomes[0].outcome, 'unknown');
  const batch = { requestId: 'batch', answers: [answer, { ...answer, id: 'absent' }] };
  const [first, concurrent] = await Promise.all([f.call('/v1/inbox/answers', { body: batch }), f.call('/v1/inbox/answers', { body: batch })]);
  assert.deepEqual(concurrent.json, first.json, concurrent.text);
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json.outcomes.map((o: any) => o.outcome), ['answered', 'unknown']);
  assert.deepEqual((await f.call('/v1/inbox/answers', { body: batch })).json, first.json);
  const reordered = { requestId: batch.requestId, answers: [{ agent: answer.agent, actor: answer.actor, content: answer.content, action: answer.action, version: answer.version, id: answer.id }, batch.answers[1]] };
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
  const body = { requestId: 'two', answers: items.map((i: any) => ({ agent: i.agent, id: i.id, version: i.version, action: 'accept', content: { answers: { [i.message]: 'Yes' } } })) };
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
  const answer = (item: any) => ({ agent: item.agent, id: item.id, version: item.version, action: 'accept', content: { answers: { 'Region?': 'EU' } }, actor: 'alice' });
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

  contractTest('inbox-answers', 'shared/inbox-answers.ts', 'withdrawn decisions conflict while several fresh answers arrive in one notice', async (_t, f) => {
    const definition = await f.call('/v1/definitions', { body: { name: 'Inbox decisions', builtins: ['request_decision'] } });
    assert.equal(definition.status, 201, definition.text);
    const created = await f.call('/v1/agents', { body: { definition: definition.json.id, ttlSeconds: null } });
    assert.equal(created.status, 201, created.text);
    const agent = created.json.id;
    for (let i = 0; i < 3; i++) {
      f.setModel((_body, index) => index % 2 === 0 ? toolCall('request_decision', { title: `Choice ${i}`, body: 'Review', key: i < 2 ? 'plan' : 'other', options: [{ label: 'A' }, { label: 'B' }] }, `decision_${i}`) : { role: 'assistant', content: 'Continuing.' });
      await f.prompt(agent, `Ask ${i}`, undefined, { actor: 'alice' });
    }
    const all = (await f.call(`/v1/agents/${agent}/inputs`)).json;
    assert.equal(all.length, 3);
    assert.equal(all.filter((i: any) => i.state === 'withdrawn').length, 1);
    const before = f.model.bodies.length;
    f.setModel(() => ({ role: 'assistant', content: 'Decisions recorded.' }));
    const body = { requestId: 'decisions', answers: all.map((i: any) => ({ agent: i.agent, id: i.id, version: i.version, action: 'accept', content: { answers: { [i.message]: 'A' } }, actor: 'alice' })) };
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
  const body = { requestId: 'availability', answers: items.map(item => ({ agent: item.agent, id: item.id, version: item.version, action: 'accept', content: { answers: { 'Region?': 'EU' } } })) };
  const response = await f.call('/v1/inbox/answers', { body });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json.outcomes[0], { agent: items[0].agent, id: items[0].id, outcome: 'unavailable', status: 503, retryable: true });
  assert.equal(response.json.outcomes[1].outcome, 'answered');
  assert.deepEqual((await f.call('/v1/inbox/answers', { body })).json, response.json);
  const pending = (await f.call('/v1/inbox')).json.items.find((item: any) => item.id === items[0].id);
  assert.equal(pending.state, 'pending');
}, { env: { AGENT_IDLE_MS: '1000' }, timeout: 90_000 });

contractTest('inbox-answers', 'shared/inbox-answers.ts', 'both per-agent writers reject stale versions while inputs remain pending', async (_t, f) => {
  for (const builtin of ['ask_user', 'request_decision']) {
    f.setModel((_body, index) => index === 0 ? toolCall(builtin, builtin === 'ask_user'
      ? { questions: [{ question: 'Region?', header: 'Region', options: [{ label: 'EU' }, { label: 'US' }] }] }
      : { title: 'Region?', body: 'Review', options: [{ label: 'EU' }, { label: 'US' }] }) : { role: 'assistant', content: 'Continuing.' });
    const definition = (await f.call('/v1/definitions', { body: { name: 'CAS ' + builtin, builtins: [builtin] } })).json;
    const created = await f.call('/v1/agents', { body: { definition: definition.id, ttlSeconds: null } });
    assert.equal(created.status, 201, created.text);
    const agent = created.json.id;
    await f.prompt(agent, 'Ask');
    const item = await until(async () => (await f.call('/v1/inbox')).json.items.find((item: any) => item.agent === agent), 'input');
    await f.advanceInboxVersion(agent);
    const response = await f.call(`/v1/agents/${agent}/inputs/${item.inputId}`, { body: { version: item.version, action: 'accept', content: { answers: { 'Region?': 'EU' } } } });
    assert.equal(response.status, 409, response.text);
    const current = (await f.call('/v1/inbox')).json.items.find((input: any) => input.agent === agent && input.id === item.id);
    assert.equal(current.state, 'pending');
    assert.equal(current.version, item.version + 1);
  }
});

contractTest('inbox-answers', 'shared/inbox-answers.ts', 'mixed blocking inputs and decisions settle independently with one decision notice', async (_t, f) => {
  const definition = (await f.call('/v1/definitions', { body: { name: 'Mixed authorities', builtins: ['ask_user', 'request_decision'] } })).json;
  const created = await f.call('/v1/agents', { body: { definition: definition.id, ttlSeconds: null } });
  assert.equal(created.status, 201, created.text);
  const agent = created.json.id;
  for (let i = 0; i < 3; i++) {
    f.setModel((_body, index) => index % 2 === 0 ? toolCall('request_decision', {
      title: `Decision ${i}`, body: 'Review', key: i < 2 ? 'plan' : 'other', options: [{ label: 'A' }, { label: 'B' }],
    }, `decision_${i}`) : { role: 'assistant', content: 'Continuing.' });
    await f.prompt(agent, `Ask ${i}`);
  }
  f.setModel(() => toolCall('ask_user', { questions: [{ question: 'Blocking?', header: 'Block', options: [{ label: 'A' }, { label: 'B' }] }] }));
  await f.prompt(agent, 'Ask blocking');
  const all = (await f.call(`/v1/agents/${agent}/inputs`)).json;
  assert.equal(all.length, 4);
  assert.equal(all.filter((item: any) => item.state === 'withdrawn').length, 1);
  f.setModel(() => ({ role: 'assistant', content: 'Recorded.' }));
  // Decisions first in the request must not prevent the blocking answer being recorded.
  const ordered = [...all].sort((a: any, b: any) => Number(a.blocking) - Number(b.blocking));
  const body = { requestId: 'mixed-authorities', answers: ordered.map((item: any) => ({ agent, id: item.id, version: item.version, action: 'accept', content: { answers: { [item.message]: 'A' } } })) };
  const response = await f.call('/v1/inbox/answers', { body });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.outcomes.filter((outcome: any) => outcome.outcome === 'answered').length, 3, response.text);
  assert.equal(response.json.outcomes.find((outcome: any) => outcome.outcome === 'conflict').state, 'withdrawn');
  await until(async () => {
    const requests = (await f.call(`/v1/agents/${agent}`)).json.requests;
    return requests.some((request: any) => request.id.startsWith('decision_') && request.state === 'completed');
  }, 'the decision notice completes');
  const notices = (await f.call(`/v1/agents/${agent}`)).json.requests.filter((request: any) => request.id.startsWith('decision_'));
  assert.equal(notices.length, 1);
  const delivered = f.model.bodies.map(body => JSON.stringify(body)).find(body => body.includes('decision_answer'))!;
  for (const item of all.filter((item: any) => !item.blocking && item.state === 'pending')) assert.ok(delivered.includes(item.id));
  assert.deepEqual((await f.call('/v1/inbox/answers', { body })).json, response.json);
  assert.equal((await f.call(`/v1/agents/${agent}`)).json.requests.filter((request: any) => request.id.startsWith('decision_')).length, 1);
});

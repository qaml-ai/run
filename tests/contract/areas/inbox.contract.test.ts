import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { contractTest, createContractFixture, OTHER_OPERATOR, toolCall, until } from '../support.ts';

contractTest('human-input', 'shared/inbox.ts', 'the inbox reads the shared index with filters, stable pages, counts and tenant isolation', async t => {
  // This standalone case includes a cold Workers fixture; Node's short baseline omits that startup cost.
  const r = await createContractFixture(t);
  const due = Date.now() + 3600000;
  await r.seedInbox([
    { id: 'urgent', priority: 'urgent', expiresAt: due + 1, responders: ['sam'], subject: 'customer' },
    { id: 'high', priority: 'high', kind: 'approval', expiresAt: due + 1, agent: 'child', root: 'lead-b' },
    { id: 'soon', expiresAt: due, createdAt: 9, responders: ['someone'] },
    { id: 'old-a', expiresAt: due + 1, createdAt: 1 },
    { id: 'old-b', expiresAt: due + 1, createdAt: 1 },
    { id: 'new', expiresAt: due + 1, createdAt: 2 },
    { id: 'low', priority: 'low', expiresAt: due },
    { id: 'expired', expiresAt: 0 }, { id: 'settled', state: 'answered' },
    { id: 'other-tenant', tenant: 'bob', priority: 'urgent' },
  ]);
  const first = await r.call('/v1/inbox?limit=2');
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json.items.map((x: any) => x.id), ['urgent', 'high']);
  assert.deepEqual(first.json.counts, { priority: { urgent: 1, high: 1, normal: 4, low: 1 }, lead: { 'lead-a': 6, 'lead-b': 1 } });
  const ids = first.json.items.map((x: any) => x.id);
  let cursor = first.json.cursor;
  while (cursor) {
    const page = (await r.call(`/v1/inbox?limit=2&cursor=${cursor}`)).json;
    assert.deepEqual(page.counts, first.json.counts);
    ids.push(...page.items.map((x: any) => x.id)); cursor = page.cursor;
  }
  assert.deepEqual(ids, ['urgent', 'high', 'soon', 'old-a', 'old-b', 'new', 'low']);
  for (const [query, expected] of [
    ['for=sam&subject=customer', ['urgent']], ['root=lead-b&kind=approval&priority=high', ['high']],
    ['for=sam&priority=normal', ['old-a', 'old-b', 'new']], ['subject=absent', []],
  ] as [string, string[]][]) {
    const page = (await r.call(`/v1/inbox?${query}`)).json;
    assert.deepEqual(page.items.map((x: any) => x.id), expected);
  }
  for (const query of ['limit=101', 'limit=0', 'limit=1.5', 'priority=invalid', 'kind=invalid', 'cursor=garbage']) {
    assert.equal((await r.call(`/v1/inbox?${query}`)).status, 400, query);
  }
  assert.equal((await r.call('/v1/inbox', { token: null })).status, 401);
  assert.deepEqual((await r.call('/v1/inbox', { token: OTHER_OPERATOR })).json.items.map((x: any) => x.id), ['other-tenant']);
  const legacy = (await r.call('/v1/inputs?state=answered')).json;
  assert.equal(legacy.length, 1); assert.equal(legacy[0].id, 'settled');
  assert.deepEqual(Object.keys(legacy[0]).sort(), ['id', 'agent', 'tenant', 'requestId', 'toolCallId', 'kind', 'message', 'detail', 'responders', 'state', 'createdAt', 'expiresAt'].sort());
  assert.equal(JSON.stringify(first.json).includes('private'), false);
}, { timeout: 90_000 });

contractTest('human-input', 'shared/inbox.ts', 'the legacy input list keeps newest-first ordering, up to 500 rows, and ignores cursors', async t => {
  const r = await createContractFixture(t);
  const rows = Array.from({ length: 502 }, (_, i) => ({ id: `legacy-${String(i).padStart(3, '0')}`, createdAt: Math.floor(i / 2),
    // Keep the background expiry worker from settling deliberately overdue fixture rows.
    expiresAt: 0, deferExpiry: true, priority: i % 2 ? 'urgent' as const : 'low' as const }));
  await r.seedInbox(rows);
  const expected = [...rows].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).map(row => row.id);
  const ids = async (query = '') => {
    const response = await r.call(`/v1/inputs${query}`);
    assert.equal(response.status, 200, response.text);
    return response.json.map((row: any) => row.id);
  };
  assert.deepEqual(await ids(), expected.slice(0, 100));
  assert.deepEqual(await ids('?state=pending&limit=500'), expected.slice(0, 500));
  assert.deepEqual(await ids('?limit=3&cursor=not-a-cursor&priority=invalid'), expected.slice(0, 3));
  assert.deepEqual(await ids('?state=answered'), []);
  assert.equal((await r.call('/v1/inputs?limit=501')).status, 400);
  assert.deepEqual((await r.call('/v1/inbox')).json.items, [], 'inbox alone hides expired pending rows');
}, { timeout: 90_000 });

// Slice 3 must land first. Register on both backends as soon as its mirror module
// is present in the tested tree, including an archive sent to a Sprite (no .git).
if (existsSync(new URL('../../../backends/workers/src/input-mirror.ts', import.meta.url))) {
  contractTest('human-input', 'shared/inbox.ts', 'a real agent question reaches the inbox and disappears after an answer (requires slice 3)', async t => {
    const question = { questions: [{ question: 'Which region?', header: 'Region', options: [{ label: 'EU' }, { label: 'US' }] }] };
    const r = await createContractFixture(t, { respond: (_body, index) => index === 0 ? toolCall('ask_user', question, 'inbox_question') : { role: 'assistant', content: 'Done' } });
    const definition = await r.call('/v1/definitions', { body: { name: 'Inbox asker', builtins: ['ask_user'] } });
    assert.equal(definition.status, 201, definition.text);
    const created = await r.call('/v1/agents', { body: { definition: definition.json.id } });
    assert.equal(created.status, 201, created.text);
    const agent = created.json.id;
    const run = await r.prompt(agent, 'Ask me which region');
    const [input] = run.outcome.result.inputs;
    assert.equal(input.kind, 'question');
    const page = await until(async () => {
      const reply = await r.call('/v1/inbox');
      assert.equal(reply.status, 200, reply.text);
      return reply.json.items.some((item: any) => item.id === input.id) && reply.json;
    }, 'the real question reaches the shared index');
    assert.equal(page.items.find((item: any) => item.id === input.id).agent, agent);
    assert.equal(page.counts.priority.normal, 1);
    const answer = await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: 'accept', content: { answers: { 'Which region?': 'EU' } } } });
    assert.equal(answer.status, 202, answer.text);
    await until(async () => !(await r.call('/v1/inbox')).json.items.some((item: any) => item.id === input.id), 'the answer settles the mirrored input');
  }, { timeout: 90_000 });
}

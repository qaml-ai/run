import assert from 'node:assert/strict';
import { contractTest, createContractFixture, OTHER_OPERATOR } from '../support.ts';

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

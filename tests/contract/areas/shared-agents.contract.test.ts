import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { contractTest, createContractFixture, OTHER_OPERATOR } from '../support.ts';

contractTest('shared-agents', 'native', 'owner links, membership and caps stay private and persist', async t => {
  const r = await createContractFixture(t);
  const agent = (await r.call('/v1/agents', { body: {} })).json.id;
  const base = `/v1/agents/${agent}`;
  assert.equal((await r.call(`${base}/share-links`, { token: OTHER_OPERATOR })).status, 404);
  assert.equal((await r.call(`${base}/share-links`, { body: { expiresIn: 60 } })).status, 400);
  const made = await r.call(`${base}/share-links`, { body: {}, headers: { 'Idempotency-Key': 'share-once' } });
  assert.equal(made.status, 201, made.text);
  assert.equal((await r.call(`${base}/share-links`, { body: {}, headers: { 'Idempotency-Key': 'share-once' } })).status, 409);
  assert.match(made.json.id, /^asl_[a-f0-9]{16}$/);
  const secret = new URL(made.json.url).hash.slice(3);
  assert.equal(Buffer.from(secret, 'base64url').length, 32);
  assert.ok(Math.abs(made.json.expiresAt - Date.now() - 604800000) < 10000);
  const saved = (await r.sharedAgentsQuery('select * from agent_share_links where id=$1', [made.json.id])).rows[0];
  assert.equal(Buffer.from(saved.sha256).toString('hex'), createHash('sha256').update(secret).digest('hex'));
  const forever = await r.call(`${base}/share-links`, { body: { expiresIn: null } });
  assert.equal(forever.json.expiresAt, null);
  let members = await r.call(`${base}/members`);
  assert.equal(members.json.length, 1);
  const owner = members.json[0];
  assert.equal(owner.role, 'owner');
  assert.match(owner.id, /^m_[a-f0-9]{16}$/);
  assert.equal((await r.call(`${base}/members/${owner.id}`, { method: 'DELETE' })).status, 400);
  assert.equal((await r.call(`${base}/members/${owner.id}`, { method: 'PATCH', body: { dailyCap: 1 } })).status, 200);
  await r.sharedAgentsQuery(`insert into agent_members (id,tenant,agent,person,role,name,email,link,added_at) select 'm_0123456789abcdef',tenant,agent,'fixture-guest','guest','Dana','dana@example.test',id,$2 from agent_share_links where id=$1`, [made.json.id, Date.now()]);
  const member = 'm_0123456789abcdef';
  await r.sharedAgentsQuery(`insert into agent_member_days (member,day,charge) values ($1,(now() at time zone 'UTC')::date,1250000)`, [member]);
  const capped = await r.call(`${base}/members/${member}`, { method: 'PATCH', body: { dailyCap: 2.5 } });
  assert.equal(capped.status, 200, capped.text);
  assert.equal(capped.json.dailyCap, 2.5);
  assert.equal(capped.json.spentToday, 1.25);
  assert.equal((await r.call(`${base}/members/${member}`, { method: 'PATCH', body: { dailyCap: -1 } })).status, 400);
  assert.equal((await r.call(`${base}/members/${member}`, { method: 'PATCH', body: { removed: true } })).status, 400);
  assert.equal((await r.call(`${base}/members/${member}`, { method: 'PATCH', body: { dailyCap: null } })).json.dailyCap, null);
  assert.equal((await r.call(`${base}/share-links/${made.json.id}`, { method: 'DELETE' })).status, 200);
  members = await r.call(`${base}/members`);
  assert.equal(members.json[1].removedAt, null, 'revoking a link preserves membership');
  const links = await r.call(`${base}/share-links`);
  assert.ok(links.json.find((link: any) => link.id === made.json.id).revokedAt);
  assert.ok(!links.text.includes(secret));
  assert.ok(!links.text.includes('sha256'));
  assert.equal((await r.call(`${base}/members/${member}`, { method: 'DELETE', token: OTHER_OPERATOR })).status, 404);
  assert.equal((await r.call(`${base}/members/${member}`, { method: 'DELETE' })).status, 200);
  assert.ok((await r.call(`${base}/members`)).json[1].removedAt);
  assert.equal((await r.call(`${base}/members/${member}`, { method: 'PATCH', body: { removed: false } })).json.removedAt, null);
  assert.equal((await r.call(`${base}/members/m_missing`, { method: 'DELETE' })).status, 404);
  await r.call(base, { method: 'DELETE' });
  assert.ok((await r.sharedAgentsQuery('select removed_at from agent_members where agent=$1', [agent])).rows.every(row => row.removed_at));
}, { timeout: 90_000 });

contractTest('shared-agents', 'native', 'removal cancels only the member’s queued runs and leaves the active turn alone', async t => {
  const { until } = await import('../support.ts');
  const r = await createContractFixture(t, { respond: (_body, index) => ({ role: 'assistant', content: 'done', ...(index === 0 ? { delayMs: 5000 } : {}) }) });
  const agent = (await r.call('/v1/agents', { body: {} })).json.id;
  const base = `/v1/agents/${agent}`;
  const link = (await r.call(`${base}/share-links`, { body: {} })).json.id;
  const member = 'm_0123456789abcdef';
  await r.sharedAgentsQuery(`insert into agent_members (id,tenant,agent,person,role,name,link,added_at) select $1,tenant,agent,'guest','guest','Dana',id,$3 from agent_share_links where id=$2`, [member, link, Date.now()]);
  await r.call(`${base}/prompt`, { body: { text: 'active', requestId: 'active', actor: `member:${member}` } });
  await until(() => r.model.bodies.length === 1, 'the active model call');
  for (const [requestId, actor] of [['removed-queue', `member:${member}`], ['owner-queue', 'owner']]) {
    assert.equal((await r.call(`${base}/prompt`, { body: { text: requestId, requestId, actor } })).status, 202);
  }
  assert.equal((await r.call(`${base}/members/${member}`, { method: 'DELETE' })).status, 200);
  const cancelled = await until(async () => { const record = (await r.call(`${base}/requests/removed-queue`)).json; return record.state === 'completed' && record; }, 'the removed member’s queued run to cancel');
  assert.equal(cancelled.outcome.result.code, 'cancelled');
  for (const requestId of ['active', 'owner-queue']) {
    const ended = await until(async () => { const record = (await r.call(`${base}/requests/${requestId}`)).json; return record.state === 'completed' && record; }, `${requestId} to finish`);
    assert.equal(ended.outcome.result.reply, 'done');
  }
});

contractTest('shared-agents', 'native', 'only the owning console session or tenant key manages shares', async t => {
  const r = await createContractFixture(t);
  const cookie = await r.seedConsoleIdentity('share-owner', { method: 'google', subject: 'share-owner-google', email: 'owner@example.test', login: 'Owner' });
  const consoleCall = (path: string, body?: unknown) => r.call(path, { token: null, headers: { Cookie: cookie, 'X-Agent-Runtime-Console': '1', 'Sec-Fetch-Site': 'same-origin' }, ...(body === undefined ? {} : { body }) });
  const created = await consoleCall('/v1/agents', {});
  assert.equal(created.status, 201, created.text);
  const agent = created.json.id;
  const base = `/v1/agents/${agent}`;
  assert.equal((await consoleCall(`${base}/share-links`, {})).status, 201);
  assert.equal((await consoleCall(`${base}/members`)).json[0].email, 'owner@example.test');
  for (const [path, method, body] of [
    ['share-links', 'POST', {}], ['share-links', 'GET', undefined], ['share-links/asl_unknown', 'DELETE', undefined],
    ['members', 'GET', undefined], ['members/m_unknown', 'PATCH', { dailyCap: 1 }], ['members/m_unknown', 'DELETE', undefined],
  ] as const) assert.equal((await r.call(`${base}/${path}`, { method, ...(body === undefined ? {} : { body }) })).status, 404);
  const browser = await consoleCall(`${base}/browser-tokens`, {});
  assert.equal(browser.status, 201, browser.text);
  assert.equal((await r.call(`${base}/members`, { token: browser.json.token })).status, 403);
});

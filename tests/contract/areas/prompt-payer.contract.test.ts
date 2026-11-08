import assert from 'node:assert/strict';
import { contractTest, until, OTHER_OPERATOR, listen, toolCall, toolResults } from '../support.ts';

contractTest('credits', 'tests/prompt-payer.test.ts', 'prompt payer owns holds and settlement; defaults and refusal remain run-local', async (t, r) => {
  const events: any[] = [];
  const receiver = await listen(t, async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; events.push(JSON.parse(raw)); res.writeHead(200).end(); });
  assert.equal((await r.call('/v1/webhooks', { body: { url: receiver, events: ['usage.recorded', 'run.completed'] } })).status, 201);
  r.setModel(() => ({ content: 'done', usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.01 } }));
  assert.equal((await r.call('/v1/end-user-settings', { method: 'PUT', body: { enabled: true, allowances: { 'bot:7': 500_000 }, markupBps: 0 } })).status, 200);
  for (const user of ['owner', 'guest']) assert.equal((await r.call(`/v1/end-users/${user}/entries`, { body: { kind: 'grant', amount: 100_000, key: `seed-${user}` } })).status, 201);
  const made = await r.call('/v1/agents', { body: { subject: 'owner', bucket: 'bot:7', queue: { mode: 'batch', windowMs: 2000 } } });
  assert.equal(made.status, 201, made.text);
  const { id, token } = made.json;
  const send = (requestId: string, endUser?: string) => r.call(`/v1/agents/${id}/prompt`, { body: { text: requestId, requestId, ...(endUser ? { endUser } : {}) } });
  assert.equal((await send('bad', 'missing')).status, 404);
  await r.call('/v1/end-users/foreign/entries', { token: OTHER_OPERATOR, body: { kind: 'grant', amount: 100_000, key: 'foreign' } });
  assert.equal((await send('foreign', 'foreign')).status, 404);
  const browser = (await r.call(`/v1/agents/${id}/browser-tokens`, { body: {} })).json.token;
  assert.equal((await r.call(`/v1/agents/${id}/prompt`, { token: browser, body: { text: 'x', endUser: 'guest' } })).status, 403);
  await r.seedOAuthAccessToken({ grantId: 'grt_payer', tenant: 'alice', clientId: 'mcp_payer', clientName: 'Payer test', login: 'alice@example.test', scope: 'agents', resource: 'agents', token: 'aro_payer_test', expiresAt: Date.now() + 3_600_000 });
  assert.equal((await r.call(`/v1/agents/${id}/prompt`, { token: 'aro_payer_test', body: { text: 'x', endUser: 'guest' } })).status, 403);
  assert.equal((await r.call(`/clients/${id}/requests`, { token, body: { id: 'forged', method: 'prompt', params: { text: 'x', endUser: 'guest' } } })).status, 403);
  assert.equal((await r.call(`/v1/agents/${id}/prompt`, { body: { text: 'x', endUser: 'guest', whileRunning: 'steer' } })).status, 400);
  for (const [rid, user] of [['guest-run', 'guest'], ['owner-run', undefined]] as const) assert.equal((await send(rid, user)).status, 202);
  for (const rid of ['guest-run', 'owner-run']) {
    const done = await until(async () => { const record = (await r.call(`/v1/agents/${id}/requests/${rid}`)).json; return record.state === 'completed' && record; }, 'prompt to finish');
    assert.equal(done.batchedInto, undefined);
    assert.equal(done.outcome?.result?.reply, 'done', JSON.stringify(done));
  }
  for (const [user, rid] of [['guest', 'guest-run'], ['owner', 'owner-run']]) {
    const ledger = (await r.call(`/v1/end-users/${user}/ledger`)).json.entries.filter((e: any) => e.kind === 'usage');
    assert.equal(ledger.length, 1, JSON.stringify(ledger));
    assert.equal(ledger[0].metadata.requestId, rid);
    assert.equal(ledger[0].bucket, 'bot:7');
    assert.ok(ledger[0].raw > 0);
    assert.equal((await r.call(`/v1/end-users/${user}`)).json.held, 0);
  }
  await until(() => events.some(e => e.type === 'run.completed' && e.data.requestId === 'guest-run') && events.some(e => e.type === 'usage.recorded' && e.data.requestId === 'guest-run'), 'payer webhooks');
  assert.equal(events.find(e => e.type === 'run.completed' && e.data.requestId === 'guest-run').data.endUser, 'guest');
  assert.equal(events.find(e => e.type === 'usage.recorded' && e.data.requestId === 'guest-run').data.subject, 'guest');
  await r.call('/v1/end-users/guest', { method: 'PATCH', body: { allowances: { 'bot:7': 0 } } });
  await r.call('/v1/end-users/guest/entries', { body: { kind: 'adjustment', amount: -100_000, key: 'empty' } });
  const refused = await send('broke', 'guest');
  assert.deepEqual([refused.status, refused.json.code, refused.json.endUser], [402, 'END_USER_CREDIT', 'guest'], refused.text);
}, { env: { AGENT_MODEL: 'openai/gpt-4.1', AGENT_OPENROUTER_CREDIT_MULTIPLIER: '1', AGENT_OUTBOUND_ALLOW_HTTP: 'true', AGENT_OUTBOUND_ALLOW_CIDRS: '127.0.0.0/8' } });

contractTest('credits', 'tests/prompt-payer.test.ts', 'a newly spawned child inherits the prompt payer and bucket', async (_t, r) => {
  r.setModel(body => {
    const child = body.messages.some((m: any) => m.role === 'user' && JSON.stringify(m.content).includes('PAYER_CHILD'));
    const answer = child || toolResults(body).length ? { content: 'done' } : toolCall('delegate', { instructions: 'You are PAYER_CHILD.', task: 'answer' }, 'child_call');
    return { ...answer, usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.01 } };
  });
  await r.call('/v1/end-user-settings', { method: 'PUT', body: { enabled: true, allowances: { 'bot:7': 1_000_000 } } });
  await r.call('/v1/end-users/guest/entries', { body: { kind: 'grant', amount: 100_000, key: 'guest' } });
  const { id } = (await r.call('/v1/agents', { body: { subject: 'owner', bucket: 'bot:7', builtins: ['delegate'], delegate: { instructions: true } } })).json;
  const done = await r.prompt(id, 'delegate', undefined, { endUser: 'guest' });
  assert.equal(done.outcome.result.reply, 'done', JSON.stringify(done));
  const child = done.outcome.result.toolCalls.find((c: any) => c.tool === 'delegate').agentId;
  assert.ok(child);
  assert.equal((done.outcome.result.toolErrors ?? []).length, 0);
  const ledger = (await r.call('/v1/end-users/guest/ledger')).json.entries.filter((e: any) => e.kind === 'usage');
  assert.ok(ledger.some((e: any) => e.metadata.agent === child));
  assert.ok(ledger.every((e: any) => e.bucket === 'bot:7'));
  assert.equal((await r.call('/v1/end-users/owner/ledger')).json.entries.length, 0);
}, { env: { AGENT_MODEL: 'openai/gpt-4.1', AGENT_OPENROUTER_CREDIT_MULTIPLIER: '1' } });

contractTest('credits', 'tests/prompt-payer.test.ts', 'an in-flight model hold belongs to the prompt payer and is released on settlement', async (_t, r) => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  r.setModel(() => ({ content: 'done', wait, usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.01 } }));
  await r.call('/v1/end-user-settings', { method: 'PUT', body: { enabled: true } });
  await r.call('/v1/end-users/guest/entries', { body: { kind: 'grant', amount: 1_000_000, key: 'guest' } });
  const { id } = (await r.call('/v1/agents', { body: { subject: 'owner' } })).json;
  try {
    assert.equal((await r.call(`/v1/agents/${id}/prompt`, { body: { text: 'work', requestId: 'held', endUser: 'guest' } })).status, 202);
    await until(async () => (await r.call('/v1/end-users/guest')).json.held > 0, 'guest credit to be held');
    assert.equal((await r.call('/v1/end-users/owner')).json.held, 0);
  } finally { release(); }
  await until(async () => (await r.call(`/v1/agents/${id}/requests/held`)).json.state === 'completed', 'held run to finish');
  const guest = (await r.call('/v1/end-users/guest')).json;
  assert.equal(guest.held, 0);
  assert.equal(guest.balance, 990_000);
  assert.equal((await r.call('/v1/end-users/owner/ledger')).json.entries.length, 0);
}, { env: { AGENT_MODEL: 'openai/gpt-4.1', AGENT_OPENROUTER_CREDIT_MULTIPLIER: '1' } });

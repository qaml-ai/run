import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { contractTest, until, OPERATOR, OTHER_OPERATOR, listen, toolCall, toolResults } from '../support.ts';

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
}, { timeout: 180_000, env: { AGENT_MODEL: 'openai/gpt-4.1', AGENT_OPENROUTER_CREDIT_MULTIPLIER: '1', AGENT_OUTBOUND_ALLOW_HTTP: 'true', AGENT_OUTBOUND_ALLOW_CIDRS: '127.0.0.0/8' } });

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

const payerEnv = { AGENT_MODEL: 'openai/gpt-4.1', AGENT_OPENROUTER_CREDIT_MULTIPLIER: '1' };
const lastText = (body: any) => {
  const content = body.messages.findLast((m: any) => m.role === 'user')?.content;
  return typeof content === 'string' ? content : (content ?? []).map((part: any) => part.text ?? '').join('');
};
const priced = (answer: object) => ({ ...answer, usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.01 } });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function seedPayers(r: import('../fixture.ts').ContractFixture) {
  await r.call('/v1/end-user-settings', { method: 'PUT', body: { enabled: true, markupBps: 0 } });
  for (const user of ['owner', 'guest', 'other']) await r.call(`/v1/end-users/${user}/entries`, { body: { kind: 'grant', amount: 1_000_000, key: user } });
}
async function completed(r: import('../fixture.ts').ContractFixture, agent: string, request: string) {
  return until(async () => { const record = (await r.call(`/v1/agents/${agent}/requests/${request}`)).json; return record.state === 'completed' && record; }, `request ${request}`);
}

contractTest('credits', 'tests/prompt-payer.test.ts', 'only a steer with the running payer joins; orphan steers never batch with follow-ups', async (_t, r) => {
  await seedPayers(r);
  const hold = deferred(), began = deferred();
  r.setModel(body => {
    if (lastText(body) === 'hold') { began.resolve(); return priced({ content: 'held', wait: hold.promise }); }
    return priced({ content: 'done' });
  });
  const made = await r.call('/v1/agents', { body: { subject: 'owner', queue: { mode: 'batch' } } });
  const { id, token } = made.json;
  const send = (requestId: string, endUser?: string, steer = false) => r.call(`/v1/agents/${id}/prompt`, { body: { text: requestId, requestId, ...(endUser ? { endUser } : {}), ...(steer ? { whileRunning: 'steer' } : {}) } });
  try {
    assert.equal((await send('hold', 'guest')).status, 202);
    await began.promise;
    const joined = await send('same', 'guest', true);
    assert.equal(joined.json.steer, 'accepted', joined.text);
    for (const [requestId, payer] of [['other-steer', 'other'], ['subject-steer', undefined]] as const) {
      const queued = await send(requestId, payer, true);
      assert.equal(queued.json.steer, 'queued', queued.text);
    }
    assert.equal((await send('other-followup', 'other')).status, 202);
    const legacy = await r.call(`/clients/${id}/requests`, { token, body: { id: 'legacy-subject', method: 'steer', params: { text: 'legacy-subject' } } });
    assert.equal(legacy.json.steer, 'queued', legacy.text);
    assert.equal((await r.call(`/clients/${id}/requests`, { token, body: { id: 'forged-steer', method: 'prompt', params: { text: 'x', endUser: 'guest', whileRunning: 'steer' } } })).status, 403);
  } finally { hold.resolve(); }
  assert.equal((await completed(r, id, 'same')).steeredInto, 'hold');
  for (const request of ['hold', 'other-steer', 'subject-steer', 'other-followup', 'legacy-subject']) {
    const done = await completed(r, id, request);
    assert.equal(done.batchedInto, undefined, JSON.stringify(done));
    assert.equal(done.steeredInto, undefined, JSON.stringify(done));
  }
  // An idle steer starts its own turn and must not ride a queued batch either.
  assert.equal((await send('idle-steer', 'guest', true)).json.steer, 'queued');
  await completed(r, id, 'idle-steer');
  for (const [user, requests] of [['guest', ['hold', 'idle-steer']], ['other', ['other-steer', 'other-followup']], ['owner', ['subject-steer', 'legacy-subject']]] as const) {
    const entries = (await r.call(`/v1/end-users/${user}/ledger`)).json.entries.filter((e: any) => e.kind === 'usage');
    assert.deepEqual([...new Set(entries.map((e: any) => e.metadata.requestId))].sort(), [...requests].sort(), JSON.stringify(entries));
    assert.equal((await r.call(`/v1/end-users/${user}`)).json.held, 0);
  }
}, { timeout: 180_000, env: payerEnv });

contractTest('credits', 'tests/prompt-payer.test.ts', 'a follow-up queued before a steer keeps its own payer at the final boundary', async (_t, r) => {
  await seedPayers(r);
  const hold = deferred(), began = deferred();
  r.setModel(body => {
    if (lastText(body) === 'wait-before-steer') { began.resolve(); return priced({ content: 'held', wait: hold.promise }); }
    return priced({ content: 'done' });
  });
  const { id } = (await r.call('/v1/agents', { body: { subject: 'owner', queue: { mode: 'batch' } } })).json;
  let steered = false;
  try {
    assert.equal((await r.call(`/v1/agents/${id}/prompt`, { body: { text: 'wait-before-steer', requestId: 'before', endUser: 'guest' } })).status, 202);
    await began.promise;
    assert.equal((await r.call(`/v1/agents/${id}/prompt`, { body: { text: 'next', requestId: 'next', endUser: 'other' } })).status, 202);
    const steer = await r.call(`/v1/agents/${id}/prompt`, { body: { text: 'late', requestId: 'late', endUser: 'guest', whileRunning: 'steer' } });
    assert.equal(steer.status, 202, steer.text);
    steered = steer.json.steer === 'accepted';
  } finally { hold.resolve(); }
  for (const request of ['before', 'next', 'late']) await completed(r, id, request);
  for (const [user, expected] of [['guest', steered ? ['before'] : ['before', 'late']], ['other', ['next']]] as const) {
    const entries = (await r.call(`/v1/end-users/${user}/ledger`)).json.entries.filter((e: any) => e.kind === 'usage');
    assert.deepEqual([...new Set(entries.map((e: any) => e.metadata.requestId))].sort(), [...expected].sort(), JSON.stringify(entries));
    assert.equal(entries.reduce((sum: number, entry: any) => sum + entry.raw, 0), user === 'guest' ? 20_000 : 10_000, 'each payer owns its model calls');
    assert.equal((await r.call(`/v1/end-users/${user}`)).json.held, 0);
  }
}, { timeout: 180_000, env: payerEnv });

contractTest('credits', 'tests/prompt-payer.test.ts', 'an idle raw steer waits and runs after a next prompt with a different payer', async (_t, r) => {
  await seedPayers(r);
  r.setModel(() => priced({ content: 'done' }));
  const made = await r.call('/v1/agents', { body: { subject: 'owner', queue: { mode: 'batch' } } });
  const { id, token } = made.json;
  const held = await r.call(`/clients/${id}/requests`, { token, body: { id: 'held-owner', method: 'steer', params: { text: 'owner message' } } });
  assert.equal(held.status, 202, held.text);
  assert.equal(held.json.method, 'steer');
  assert.equal(r.model.bodies.length, 0);
  await r.prompt(id, 'guest message', undefined, { requestId: 'guest-next', endUser: 'guest' });
  await completed(r, id, 'held-owner');
  assert.equal(r.model.bodies.length, 2);
  for (const [user, request] of [['guest', 'guest-next'], ['owner', 'held-owner']]) {
    const entries = (await r.call(`/v1/end-users/${user}/ledger`)).json.entries.filter((entry: any) => entry.kind === 'usage');
    assert.deepEqual(entries.map((entry: any) => entry.metadata.requestId), [request]);
    assert.equal(entries[0].raw, 10_000);
    assert.equal((await r.call(`/v1/end-users/${user}`)).json.held, 0);
  }
}, { timeout: 180_000, env: payerEnv });

contractTest('credits', 'tests/prompt-payer.test.ts', 'first prompt accepts a payer, malformed JSON is 400, and payer buckets do not become the subject default', async (_t, r) => {
  await seedPayers(r);
  r.setModel(() => priced({ content: 'done' }));
  const made = await r.call('/v1/agents', { body: { subject: 'owner', prompt: { text: 'first', requestId: 'first', endUser: 'guest', bucket: 'guest-bucket' } } });
  assert.equal(made.status, 201, made.text);
  const id = made.json.id;
  await completed(r, id, 'first');
  const owner = await r.prompt(id, 'subject');
  assert.equal(owner.outcome.result.reply, 'done');
  const guestEntries = (await r.call('/v1/end-users/guest/ledger')).json.entries.filter((e: any) => e.kind === 'usage');
  const ownerEntries = (await r.call('/v1/end-users/owner/ledger')).json.entries.filter((e: any) => e.kind === 'usage');
  assert.equal(guestEntries[0].bucket, 'guest-bucket');
  assert.equal(ownerEntries[0].bucket, 'default');
  for (const path of ['/v1/agents', `/v1/agents/${id}/prompt`, `/clients/${id}/requests`]) {
    for (const body of ['{broken']) {
      const response = await fetch(r.base + path, { method: 'POST', headers: { Authorization: `Bearer ${path.startsWith('/clients/') ? made.json.token : OPERATOR}`, 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, 400, `${path}: ${body}`);
    }
  }
}, { env: payerEnv });

contractTest('credits', 'tests/prompt-payer.test.ts', 'idle parent messages and completion notices keep the child task payer; reused children bill the current sender', async (_t, r) => {
  await seedPayers(r);
  // The owner cannot pay: a wrongly attributed internal prompt is refused immediately.
  await r.call('/v1/end-users/owner/entries', { body: { kind: 'adjustment', amount: -1_000_000, key: 'empty-owner' } });
  const childGo = deferred();
  r.setModel(body => {
    const text = lastText(body), last = body.messages.at(-1);
    const child = body.messages.some((m: any) => m.role === 'user' && JSON.stringify(m.content).includes('PAYER_WORKER'));
    if (child) {
      if (last.role === 'tool' || text.includes('second task')) return priced({ content: 'child done' });
      return priced({ ...toolCall('send_message', { to: 'parent', text: 'child checking in' }, 'child_message'), wait: childGo.promise });
    }
    if (last.role === 'tool' || text.startsWith('<agent_')) return priced({ content: 'parent done' });
    if (text === 'reuse') return priced(toolCall('send_message', { to: 'worker', text: 'second task' }, 'reuse_child'));
    return priced(toolCall('spawn_agent', { instructions: 'You are PAYER_WORKER.', task: 'work', name: 'worker' }, 'spawn_worker'));
  });
  const made = await r.call('/v1/agents', { body: { subject: 'owner', builtins: ['agents'], delegate: { instructions: true } } });
  const id = made.json.id;
  try {
    const first = await r.prompt(id, 'start', undefined, { endUser: 'guest', bucket: 'first-bucket' });
    assert.equal(first.outcome.result.reply, 'parent done', JSON.stringify(first));
  } finally { childGo.resolve(); }
  const child = await until(async () => (await r.call(`/v1/agents/${id}/children`)).json.children.find((c: any) => c.name === 'worker' && c.delivered), 'child notice delivered');
  await completed(r, id, `child_${child.requestId}`);
  const guest = (await r.call('/v1/end-users/guest/ledger')).json.entries.filter((e: any) => e.kind === 'usage');
  assert.ok(guest.some((e: any) => e.metadata.agent === id && e.metadata.requestId.startsWith('msg_')), JSON.stringify(guest));
  assert.ok(guest.some((e: any) => e.metadata.agent === id && e.metadata.requestId.startsWith('child_')), JSON.stringify(guest));
  assert.ok(guest.some((e: any) => e.metadata.agent === child.agentId));
  assert.ok(guest.every((e: any) => e.bucket === 'first-bucket'));
  const reused = await r.prompt(id, 'reuse', undefined, { endUser: 'other', bucket: 'second-bucket' });
  assert.equal(reused.outcome.result.reply, 'parent done', JSON.stringify(reused));
  await until(async () => (await r.call('/v1/end-users/other/ledger')).json.entries.some((e: any) => e.kind === 'usage' && e.metadata.agent === child.agentId), 'reused child billed other');
  await until(async () => (await r.call('/v1/end-users/other/ledger')).json.entries.some((e: any) => e.kind === 'usage' && e.metadata.agent === id && e.metadata.requestId.startsWith('child_')), 'reused child notification billed other');
  const nextChild = (await r.call(`/v1/agents/${id}/children`)).json.children.find((c: any) => c.agentId === child.agentId);
  await completed(r, id, `child_${nextChild.requestId}`);
  const other = (await r.call('/v1/end-users/other/ledger')).json.entries.filter((e: any) => e.kind === 'usage');
  assert.ok(other.some((e: any) => e.metadata.agent === id && e.metadata.requestId.startsWith('child_')), JSON.stringify(other));
  assert.ok(other.every((e: any) => e.bucket === 'second-bucket'));
  assert.equal((await r.call('/v1/end-users/owner/ledger')).json.entries.filter((e: any) => e.kind === 'usage').length, 0);
  for (const user of ['guest', 'other']) assert.equal((await r.call(`/v1/end-users/${user}`)).json.held, 0);
}, { timeout: 180_000, env: payerEnv });

contractTest('credits', 'tests/prompt-payer.test.ts', 'a collaborator pays for a child without becoming its MCP identity', async (t, r) => {
  await seedPayers(r);
  const subjects: string[] = [];
  const keys = createRemoteJWKSet(new URL(`${r.base}/.well-known/jwks.json`));
  const url = await listen(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const { payload } = await jwtVerify(req.headers.authorization!.slice(7), keys, { issuer: r.base, audience: 'urn:camelrun:alice:identity', algorithms: ['EdDSA'] });
    if (raw && JSON.parse(raw).method === 'tools/call') subjects.push(payload.sub!);
    const server = new McpServer({ name: 'identity', version: '1.0.0' });
    server.registerTool('whoami', { description: 'Return the authenticated subject' }, async () => ({ content: [{ type: 'text', text: payload.sub! }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  const definition = await r.call('/v1/definitions', { body: { name: 'Identity child', systemPrompt: 'You are IDENTITY_CHILD.', mcpServers: [{ name: 'identity', url, auth: { type: 'runtime' }, audience: 'urn:camelrun:alice:identity' }] } });
  assert.equal(definition.status, 201, definition.text);
  r.setModel(body => {
    const child = body.messages.some((m: any) => ['system', 'developer'].includes(m.role) && JSON.stringify(m.content).includes('IDENTITY_CHILD'));
    if (body.messages.at(-1).role === 'tool') return priced({ content: 'done' });
    return priced(child ? toolCall('identity__whoami', {}, 'identity_call') : toolCall('delegate', { agent: 'helper', task: 'who are you?' }, 'delegate_identity'));
  });
  const made = await r.call('/v1/agents', { body: { subject: 'owner', builtins: ['delegate'], delegate: { agents: [{ name: 'helper', definition: definition.json.id }] } } });
  assert.equal(made.status, 201, made.text);
  subjects.length = 0; // Definition and agent provisioning probe tools before any run.
  const done = await r.prompt(made.json.id, 'go', undefined, { endUser: 'guest' });
  assert.equal((done.outcome?.result?.toolErrors ?? []).length, 0, JSON.stringify(done));
  assert.ok(subjects.length > 0);
  assert.deepEqual([...new Set(subjects)], ['owner']);
  const child = done.outcome.result.toolCalls.find((c: any) => c.tool === 'delegate').agentId;
  const guest = (await r.call('/v1/end-users/guest/ledger')).json.entries.filter((e: any) => e.kind === 'usage');
  assert.ok(guest.some((e: any) => e.metadata.agent === child));
  assert.equal((await r.call('/v1/end-users/owner/ledger')).json.entries.filter((e: any) => e.kind === 'usage').length, 0);
}, { env: { ...payerEnv, AGENT_OUTBOUND_ALLOW_HTTP: 'true', AGENT_OUTBOUND_ALLOW_CIDRS: '127.0.0.0/8', AGENT_PUBLIC_URL: '' } });

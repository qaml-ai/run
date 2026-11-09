import { SHARED_SENDER_INSTRUCTIONS } from "../../../src/sender.ts";
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { contractTest, createContractFixture, OTHER_OPERATOR, listen, toolCall, until } from '../support.ts';

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
  assert.equal((await r.call(`${base}/members/${owner.id}`, { method: 'PATCH', body: { dailyCapMicros: 1 } })).status, 400);
  assert.equal((await r.call(`${base}/members/${owner.id}`, { method: 'PATCH', body: { dailyCapMicros: null } })).status, 400);
  assert.equal((await r.call(`${base}/members`)).json[0].dailyCapMicros, null);
  await r.sharedAgentsQuery(`insert into agent_members (id,tenant,agent,person,role,name,email,link,added_at) select 'm_0123456789abcdef',tenant,agent,'fixture-guest','guest','Dana','dana@example.test',id,$2 from agent_share_links where id=$1`, [made.json.id, Date.now()]);
  const member = 'm_0123456789abcdef';
  await r.sharedAgentsQuery(`insert into agent_member_days (member,day,charge) values ($1,(now() at time zone 'UTC')::date,1250000)`, [member]);
  const capped = await r.call(`${base}/members/${member}`, { method: 'PATCH', body: { dailyCapMicros: 2500000 } });
  assert.equal(capped.status, 200, capped.text);
  assert.equal(capped.json.dailyCapMicros, 2500000);
  assert.equal(capped.json.spentToday, 1.25);
  assert.equal((await r.call(`${base}/members/${member}`, { method: 'PATCH', body: { dailyCapMicros: -1 } })).status, 400);
  for (const dailyCapMicros of [0.1, 0.0000001, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await r.call(`${base}/members/${member}`, { method: 'PATCH', body: { dailyCapMicros } })).status, 400);
  }
  assert.equal((await r.call(`${base}/members/${member}`, { method: 'PATCH', body: { dailyCap: 2.5 } })).status, 400, 'the old float field is rejected');
  assert.equal((await r.call(`${base}/members/${member}`, { method: 'PATCH', body: { dailyCapMicros: 1 } })).json.dailyCapMicros, 1, 'one micro is stored without rounding');
  assert.equal((await r.call(`${base}/members/${member}`, { method: 'PATCH', body: { dailyCapMicros: 0 } })).json.dailyCapMicros, 0, 'zero is an explicit cap');

  assert.equal((await r.call(`${base}/members/${member}`, { method: 'PATCH', body: { removed: true } })).status, 400);
  assert.equal((await r.call(`${base}/members/${member}`, { method: 'PATCH', body: { dailyCapMicros: null } })).json.dailyCapMicros, null);
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

for (const mode of ['each', 'batch'] as const) contractTest('shared-agents', 'native', `${mode}: removal cancels only the member’s queued runs and leaves the active turn alone`, async t => {
  const { until } = await import('../support.ts');
  const r = await createContractFixture(t, { respond: (_body, index) => ({ role: 'assistant', content: 'done', ...(index === 0 ? { delayMs: 5000 } : {}) }) });
  const agent = (await r.call('/v1/agents', { body: { queue: { mode } } })).json.id;
  const base = `/v1/agents/${agent}`;
  const link = (await r.call(`${base}/share-links`, { body: {} })).json.id;
  const member = 'm_0123456789abcdef';
  await r.sharedAgentsQuery(`insert into agent_members (id,tenant,agent,person,role,name,link,added_at) select $1,tenant,agent,'guest','guest','Dana',id,$3 from agent_share_links where id=$2`, [member, link, Date.now()]);
  await r.call(`${base}/prompt`, { body: { text: 'active', requestId: 'active', actor: `member:${member}` } });
  await until(() => r.model.bodies.length === 1, 'the active model call');
  for (const [requestId, actor] of [['owner-queue', 'owner'], ['removed-queue', `member:${member}`], ['removed-queue-2', `member:${member}`]]) {
    assert.equal((await r.call(`${base}/prompt`, { body: { text: requestId, requestId, actor } })).status, 202);
  }
  assert.equal((await r.call(`${base}/members/${member}`, { method: 'DELETE' })).status, 200);
  for (const identity of [{ actor: `member:${member}` }, { from: { id: `member:${member}` } }]) {
    const refused = await r.call(`${base}/prompt`, { body: { text: 'after removal', ...identity } });
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.json.code, 'FORBIDDEN');
  }
  for (const [method, params] of [['continue', { actor: `member:${member}` }], ['execute', { code: '1', actor: `member:${member}` }]] as const) {
    const refused = await r.call(`/registry/${agent}/requests`, { body: { id: `removed-${method}`, method, params } });
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.json.code, 'FORBIDDEN');
  }
  for (const queued of ['removed-queue', 'removed-queue-2']) {
    const cancelled = await until(async () => { const record = (await r.call(`${base}/requests/${queued}`)).json; return record.state === 'completed' && record; }, 'the removed member’s queued run to cancel');
    assert.equal(cancelled.outcome.result.code, 'cancelled');
  }
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
    ['members', 'GET', undefined], ['members/m_unknown', 'PATCH', { dailyCapMicros: 1 }], ['members/m_unknown', 'DELETE', undefined],
  ] as const) assert.equal((await r.call(`${base}/${path}`, { method, ...(body === undefined ? {} : { body }) })).status, 404);
  const browser = await consoleCall(`${base}/browser-tokens`, {});
  assert.equal(browser.status, 201, browser.text);
  assert.equal((await r.call(`${base}/members`, { token: browser.json.token })).status, 403);
});

contractTest('shared-agents', 'native', 'member ids are scoped to their agent and OAuth cannot manage shares', async t => {
  const r = await createContractFixture(t);
  const first = (await r.call('/v1/agents', { body: {} })).json.id;
  const second = (await r.call('/v1/agents', { body: {}, token: OTHER_OPERATOR })).json.id;
  const link = (await r.call(`/v1/agents/${second}/share-links`, { body: {}, token: OTHER_OPERATOR })).json.id;
  const member = 'm_0123456789abcdef';
  await r.sharedAgentsQuery(`insert into agent_members (id,tenant,agent,person,role,name,link,added_at) select $1,tenant,agent,'guest','guest','Dana',id,$3 from agent_share_links where id=$2`, [member, link, Date.now()]);
  assert.equal((await r.call(`/v1/agents/${first}/members/${member}`, { method: 'DELETE' })).status, 404);
  assert.equal((await r.call(`/v1/agents/${second}/members/${member}`, { method: 'DELETE' })).status, 404);
  assert.equal((await r.call(`/v1/agents/${second}/members`, { token: OTHER_OPERATOR })).json.find((m: any) => m.id === member).removedAt, null);
  const token = 'aro_shared_owner_fixture';
  await r.seedOAuthAccessToken({ grantId: 'grt_shared', tenant: 'alice', clientId: 'mcp_shared', clientName: 'Test', login: 'alice', scope: 'agents', resource: 'agents', token, expiresAt: Date.now() + 3600000 });
  // Prove this is an otherwise valid owner credential, not an authentication failure.
  assert.equal((await r.call(`/v1/agents/${first}`, { token })).status, 200);
  for (const [path, method, body] of [
    ['share-links', 'POST', {}], ['share-links', 'GET', undefined], ['share-links/asl_unknown', 'DELETE', undefined],
    ['members', 'GET', undefined], ['members/m_unknown', 'PATCH', { dailyCapMicros: 1 }], ['members/m_unknown', 'DELETE', undefined],
  ] as const) assert.equal((await r.call(`/v1/agents/${first}/${path}`, { token, method, ...(body === undefined ? {} : { body }) })).status, 403);
}, { timeout: 90_000 });

contractTest('shared-agents', 'native', 'failed membership cleanup leaves deletion retryable', async t => {
  const r = await createContractFixture(t);
  const agent = (await r.call('/v1/agents', { body: {} })).json.id;
  await r.call(`/v1/agents/${agent}/share-links`, { body: {} });
  await r.sharedAgentsQuery('alter table agent_members add constraint reject_removal check (removed_at is null) not valid');
  const failed = await r.call(`/v1/agents/${agent}`, { method: 'DELETE' });
  assert.ok(failed.status >= 400 && failed.status < 600, 'the forced database failure reaches the caller');
  assert.equal((await r.call(`/v1/agents/${agent}`)).status, 200, 'the agent was not revoked before cleanup succeeded');
  await r.sharedAgentsQuery('alter table agent_members drop constraint reject_removal');
  assert.equal((await r.call(`/v1/agents/${agent}`, { method: 'DELETE' })).status, 200);
  assert.ok((await r.sharedAgentsQuery('select removed_at from agent_members where agent=$1', [agent])).rows.every(row => row.removed_at));
}, { timeout: 90_000 });

contractTest('shared-agents', 'native', 'a sub-agent cannot be shared', async t => {
  const { toolCall, toolResults } = await import('../support.ts');
  const r = await createContractFixture(t, { respond: body => {
    if (JSON.stringify(body.messages).includes('SHARED_CHILD')) return { role: 'assistant', content: 'done' };
    if (body.messages.at(-1).role === 'tool') return { role: 'assistant', content: toolResults(body).at(-1) };
    return toolCall('spawn_agent', { instructions: 'SHARED_CHILD', task: 'finish' }, 'spawn_child');
  } });
  const parent = (await r.call('/v1/agents', { body: { builtins: ['agents'], delegate: { instructions: true } } })).json.id;
  const result = await r.prompt(parent, 'start a child');
  const child = result.outcome.result.toolCalls.find((call: any) => call.agentId)?.agentId;
  assert.ok(child, 'the runtime created a real sub-agent');
  const refused = await r.call(`/v1/agents/${child}/share-links`, { body: {} });
  assert.equal(refused.status, 400, refused.text);
  assert.match(refused.json.error, /Sub-agents cannot be shared/);
  assert.equal((await r.sharedAgentsQuery('select 1 from agent_share_links where agent=$1', [child])).rows.length, 0);
  assert.equal((await r.sharedAgentsQuery('select 1 from agent_members where agent=$1', [child])).rows.length, 0);
}, { timeout: 90_000 });

const members = {
  owner: { id: "member:m_0000000000000001", name: "Owner", role: "owner" },
  members: [
    { id: "member:m_0000000000000001", name: "Owner", role: "owner" },
    { id: "member:m_0000000000000002", name: "Dana", role: "guest" },
    { id: "member:m_0000000000000003", name: "Bob", role: "guest" },
  ],
};
// Include cold workerd startup; the shared runtime assertions still use bounded polling.
const options = { timeout: 90_000, env: { TEST_SHARED_MEMBERS: "1" } };
const ask = { questions: [{ question: "Where?", header: "Place", options: [{ label: "Here" }, { label: "There" }] }] };
const settled = (f: any, agent: string, id: string) => until(async () => {
  const r = (await f.call(`/v1/agents/${agent}/requests/${id}`)).json;
  assert.equal(r.sharedAgent, undefined, "membership snapshots are runtime-only");
  assert.equal(r.heldForInput, undefined, "queue bookkeeping is runtime-only");
  return r.state === "completed" && r;
}, "prompt to complete");
async function agent(f: any, extra: object = {}) {
  const definition = (await f.call("/v1/definitions", { body: { name: "Shared", builtins: ["ask_user"], ...extra } })).json;
  const r = await f.call("/v1/agents", { body: { definition: definition.id, ttlSeconds: null } });
  assert.equal(r.status, 201, r.text);
  for (const member of members.members) await f.sharedAgentsQuery("insert into agent_members (id,tenant,agent,person,role,name,added_at) values ($1,'alice',$2,$3,$4,$5,$6)", [member.id.slice(7), r.json.id, member.id, member.role, member.name, Date.now()]);
  return r.json.id;
}
async function memberPrompt(f: any, agent: string, member: string, text: string) {
  const r = await f.call(`/__test/shared/${agent}/${member}`, { body: { text } });
  assert.equal(r.status, 202, r.text);
  return settled(f, agent, r.json.id);
}
contractTest("shared-agents", "tests/contract/areas/shared-agents.contract.test.ts:1", "runtime member roles cannot be forged and another sender preserves a question", async (_t, f) => {
  f.setModel((_body, index) => index === 0 ? toolCall("ask_user", ask) : { role: "assistant", content: "ok" });
  const id = await agent(f);
  for (const role of ["owner", "guest"]) {
    const bad = await f.call(`/v1/agents/${id}/prompt`, { body: { text: "forge", from: { id: "member:m_0000000000000002", role } } });
    assert.equal(bad.status, 400, bad.text);
  }
  for (const [key, value] of Object.entries({ actor: "owner", from: { id: "owner" }, metadata: {}, endUser: "other", output: {}, spendLimit: { usd: 1 }, whileRunning: "steer", bucket: "other" })) {
    const bad = await f.call(`/__test/shared/${id}/${members.members[1].id}`, { body: { text: "Reject control fields", [key]: value } });
    assert.equal(bad.status, 400, `${key}: ${bad.text}`);
  }
  await memberPrompt(f, id, "member:m_0000000000000002", "Ask me");
  const pending = (await f.call(`/v1/agents/${id}/inputs?state=pending`)).json;
  assert.equal(pending.length, 1, JSON.stringify((await f.call(`/v1/agents/${id}/history`)).json));
  assert.ok(pending[0].responders.audience.includes("member:m_0000000000000002"));
  const system = f.model.bodies[0].messages.filter((m: any) => ["system", "developer"].includes(m.role)).map((m: any) => m.content).join("\n");
  assert.ok(system.includes(SHARED_SENDER_INSTRUCTIONS));
  assert.ok(JSON.stringify(f.model.bodies[0]).includes('guest'));
  const bob = await f.call(`/__test/shared/${id}/member:m_0000000000000003`, { body: { text: "Hi" } });
  assert.equal(bob.status, 202, bob.text);
  assert.equal((await f.call(`/v1/agents/${id}/inputs?state=pending`)).json.length, 1);
  f.setModel(() => ({ role: "assistant", content: "ok" }));
  await f.restart();
  await memberPrompt(f, id, "member:m_0000000000000002", "Never mind");
  await settled(f, id, bob.json.id);
  assert.equal((await f.call(`/v1/agents/${id}/inputs?state=pending`)).json.length, 0);
}, options);

contractTest("shared-agents", "tests/contract/areas/shared-agents.contract.test.ts:55", "guest approvals exclude the guest even when the definition names them", async t => {
  let calls = 0;
  const url = await listen(t, async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let text = ""; for await (const chunk of req) text += chunk;
    const msg = JSON.parse(text);
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    let result: object = {};
    if (msg.method === "initialize") result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "approval", version: "1" } };
    if (msg.method === "tools/list") result = { tools: [{ name: "remove", description: "Remove", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } }] };
    if (msg.method === "tools/call") { calls++; result = { content: [{ type: "text", text: "done" }] }; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  const f = await createContractFixture(t, { ...options, env: { ...options.env, AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" },
    respond: (_b, n) => n === 0 ? toolCall("shop__remove", {}) : { role: "assistant", content: "ok" } });
  const id = await agent(f, { humanInput: { approvers: ["member:m_0000000000000002", "approver"] }, mcpServers: [{ name: "shop", url, approval: { default: "destructive" } }] });
  await memberPrompt(f, id, "member:m_0000000000000002", "Remove it");
  const [input] = (await f.call(`/v1/agents/${id}/inputs?state=pending`)).json;
  assert.equal(input.kind, "approval");
  assert.deepEqual(input.responders.audience.sort(), ["approver", "member:m_0000000000000001"]);
  await until(async () => (await f.call(`/v1/inbox?for=${members.owner.id}`)).json.items.some((item: any) => item.inputId === input.id), "the owner receives the approval in the inbox");
  assert.ok(!(await f.call(`/v1/inbox?for=${members.members[1].id}`)).json.items.some((item: any) => item.inputId === input.id), "the guest never receives the approval in the inbox");
  assert.equal(calls, 0);
  assert.equal((await f.call(`/v1/agents/${id}/inputs/${input.id}`, { body: { action: "accept", from: { id: "member:m_0000000000000002" } } })).status, 403);
  // Pi may have its own waiter alarm. Admission must leave the runtime's alarm plan alone.
  const before = process.env.CONTRACT_BACKEND === "workers" ?
    (await f.call(`/__test/shared-state/${id}`)).json : undefined;
  const bob = await f.call(`/__test/shared/${id}/member:m_0000000000000003`, { body: { text: "Hello" } });
  if (before) {
    const state = (await f.call(`/__test/shared-state/${id}`)).json;
    assert.equal(state.held, 1, "the other member prompt is held behind the approval");
    assert.equal(state.generation, before.generation, "holding a prompt never arms a runtime wake");
    assert.equal(state.deadline, before.deadline, "the existing input deadline stays unchanged");
  }
  assert.equal(bob.status, 202, bob.text);
  assert.equal((await f.call(`/v1/agents/${id}/inputs?state=pending`)).json.length, 1);
  const accepted = await f.call(`/v1/agents/${id}/inputs/${input.id}`, { body: { action: "accept", from: { id: "member:m_0000000000000001" } } });
  assert.equal(accepted.status, 202, accepted.text);
  await settled(f, id, accepted.json.request.id);
  assert.equal(calls, 1, "the approved tool runs exactly once");
  await settled(f, id, bob.json.id);
}, { timeout: options.timeout });

contractTest("shared-agents", "tests/contract/areas/shared-agents.contract.test.ts:95", "console prompts stamp owners; API and explicit senders stay unchanged", async (_t, f) => {
  const id = await agent(f);
  const cookie = await f.seedConsoleIdentity("alice", { method: "github", subject: 4242, login: "owner" });
  const headers = { Cookie: cookie, Origin: new URL(f.base).origin, "X-Agent-Runtime-Console": "1" };
  const owner = await f.call(`/v1/agents/${id}/prompt`, { token: null, headers, body: { text: "From console", actor: "ignored" } });
  assert.equal(owner.status, 202, owner.text);
  await settled(f, id, owner.json.id);
  await f.prompt(id, "From API");
  const explicit = await f.call(`/v1/agents/${id}/prompt`, { token: null, headers, body: { text: "Explicit", from: { id: "slack:U1" } } });
  assert.equal(explicit.status, 202, explicit.text);
  await settled(f, id, explicit.json.id);
  const history = (await f.call(`/v1/agents/${id}/history`)).json.messages.filter((m: any) => m.role === "user");
  assert.deepEqual(history[0].from, members.owner);
  assert.equal(history[1].from, undefined);
  assert.deepEqual(history[2].from, { id: "slack:U1" });
}, options);

contractTest("shared-agents", "production", "membership is live between turns and fixed through a suspended turn", async (_t, f) => {
  const id = (await f.call("/v1/agents", { body: { builtins: ["ask_user"], ttlSeconds: null } })).json.id;
  const cookie = await f.seedConsoleIdentity("alice", { method: "github", subject: 4243, login: "live-owner" });
  const headers = { Cookie: cookie, Origin: new URL(f.base).origin, "X-Agent-Runtime-Console": "1" };
  f.setModel((_body, index) => index === 1 ? toolCall("ask_user", ask) : { role: "assistant", content: "ok" });
  async function prompt(text: string) {
    const submitted = await f.call(`/v1/agents/${id}/prompt`, { token: null, headers, body: { text } });
    assert.equal(submitted.status, 202, submitted.text);
    return settled(f, id, submitted.json.id);
  }
  await prompt("Before sharing");
  assert.equal((await f.call(`/v1/agents/${id}/share-links`, { body: {} })).status, 201);
  const owner = (await f.call(`/v1/agents/${id}/members`)).json[0];
  await prompt("After sharing");
  const [input] = (await f.call(`/v1/agents/${id}/inputs?state=pending`)).json;
  assert.deepEqual(input.responders.audience, [`member:${owner.id}`]);
  // The turn keeps its snapshot through its input and later model render; the next turn reads SQL again.
  await f.sharedAgentsQuery("update agent_members set removed_at=$2 where agent=$1", [id, Date.now()]);
  const answer = await f.call(`/v1/agents/${id}/inputs/${input.id}`, { body: { action: "accept", from: { id: `member:${owner.id}` }, content: { answers: { "Where?": "Here" } } } });
  assert.equal(answer.status, 202, answer.text);
  await settled(f, id, answer.json.request.id);
  await prompt("After membership removal");
  const instructions = f.model.bodies.map((body: any) => body.messages.filter((message: any) => ["system", "developer"].includes(message.role)).map((message: any) => message.content).join("\n").includes(SHARED_SENDER_INSTRUCTIONS));
  assert.deepEqual(instructions, [false, true, true, false]);
  const history = (await f.call(`/v1/agents/${id}/history`)).json.messages.filter((message: any) => message.role === "user");
  assert.equal(history[0].from, undefined);
  assert.equal(history[1].from.id, `member:${owner.id}`);
  assert.equal(history[1].from.role, "owner");
  assert.equal(history[2].from, undefined);
}, { timeout: 90_000 });

contractTest("shared-agents", "delegation", "a guest's child uses the root membership for its approval", async t => {
  let calls = 0;
  const url = await listen(t, async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let text = ""; for await (const chunk of req) text += chunk;
    const message = JSON.parse(text);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    let result: object = {};
    if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "approval", version: "1" } };
    if (message.method === "tools/list") result = { tools: [{ name: "remove", description: "Remove", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } }] };
    if (message.method === "tools/call") { calls++; result = { content: [{ type: "text", text: "done" }] }; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  const f = await createContractFixture(t, { env: { ...options.env, AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" }, respond: body => {
    const child = body.messages.some((message: any) => ["system", "developer"].includes(message.role) && JSON.stringify(message.content).includes("SHARED_CHILD"));
    if (body.messages.some((message: any) => message.role === "tool")) return { role: "assistant", content: "done" };
    return child ? toolCall("shop__remove", {}) : toolCall("delegate", { agent: "shared-child", task: "Remove it" });
  } });
  const childDefinition = await f.call("/v1/definitions", { headers: { "Idempotency-Key": "shared-child" }, body: {
    name: "Child", description: "Performs the removal", systemPrompt: "SHARED_CHILD", humanInput: { approvers: [members.members[1].id, "ops"] },
    mcpServers: [{ name: "shop", url, approval: { default: "destructive" } }],
  } });
  assert.equal(childDefinition.status, 201, childDefinition.text);
  const parent = await agent(f, { builtins: ["delegate"], delegate: { agents: ["shared-child"] } });
  const submitted = await f.call(`/__test/shared/${parent}/${members.members[1].id}`, { body: { text: "Delegate removal" } });
  assert.equal(submitted.status, 202, submitted.text);
  const indexed = await until(async () => (await f.call("/v1/inputs?state=pending")).json.items.find((input: any) => input.kind === "approval"), "child approval");
  const input = { ...indexed, id: indexed.inputId };
  assert.notEqual(input.agent, parent);
  assert.deepEqual((await f.call(`/v1/agents/${input.agent}/members`)).json, []);
  assert.deepEqual(input.responders.audience.sort(), [members.owner.id, "ops"].sort());
  assert.equal((await f.call(`/v1/agents/${input.agent}/inputs/${input.id}`, { body: { action: "accept", from: { id: members.members[1].id } } })).status, 403);
  const accepted = await f.call(`/v1/agents/${input.agent}/inputs/${input.id}`, { body: { action: "accept", from: { id: members.owner.id } } });
  assert.equal(accepted.status, 202, accepted.text);
  await settled(f, parent, submitted.json.id);
  assert.equal(calls, 1, "the approved tool runs exactly once");
  const messages = (await f.call(`/v1/agents/${input.agent}/history`)).json.messages;
  assert.equal(messages.find((message: any) => message.role === "user").from.role, "guest");
}, { timeout: 120_000 });


contractTest("shared-agents", "nonblocking", "an open decision does not hold another member's prompt", async (_t, f) => {
  const id = await agent(f, { builtins: ["request_decision"] });
  f.setModel((_body, index) => index === 0 ? toolCall("request_decision", { title: "Choose", body: "Which path?", key: "plan", options: [{ label: "A" }, { label: "B" }] }) : { role: "assistant", content: "ok" });
  await memberPrompt(f, id, members.members[1].id, "Ask me later");
  const [decision] = (await f.call(`/v1/agents/${id}/inputs?state=pending`)).json;
  assert.equal(decision.blocking, false);
  await memberPrompt(f, id, members.members[2].id, "Hello now");
  assert.equal((await f.call(`/v1/agents/${id}/inputs?state=pending`)).json[0].id, decision.id);
}, options);

contractTest('shared-agents', 'native', 'concurrent member submissions preserve request ID conflicts', async t => {
  const { until } = await import('../support.ts');
  const r = await createContractFixture(t);
  const agent = (await r.call('/v1/agents', { body: {} })).json.id;
  const link = (await r.call(`/v1/agents/${agent}/share-links`, { body: {} })).json.id;
  const member = 'm_0123456789abcdef';
  await r.sharedAgentsQuery(`insert into agent_members (id,tenant,agent,person,role,name,link,added_at) select $1,tenant,agent,'guest','guest','Dana',id,$3 from agent_share_links where id=$2`, [member, link, Date.now()]);
  const responses = await Promise.all(Array.from({ length: 8 }, (_, n) => r.call(`/v1/agents/${agent}/prompt`, {
    body: { text: `message ${n}`, requestId: 'concurrent-member', actor: `member:${member}` },
  })));
  assert.equal(responses.filter(response => response.status === 202).length, 1);
  assert.equal(responses.filter(response => response.status === 409 && response.json.code === 'IDEMPOTENCY_CONFLICT').length, 7);
  await until(async () => (await r.call(`/v1/agents/${agent}/requests/concurrent-member`)).json.state === 'completed', 'the one admitted request');
  assert.equal(r.model.bodies.length, 1);
}, { timeout: 90_000 });

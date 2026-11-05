import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {configuredModel} from '../../../src/model.ts';
import {contractTest, type T} from '../support.ts';
import type {ContractFixture} from '../fixture.ts';
const operator = 'operator-fixture-secret-at-least-24-chars';
async function fixture(r:ContractFixture, seedOperator=true){
 if(seedOperator) await r.seedTenant('operator',{token:operator,config:{apiKeys:{openrouter:'host-fixture-key'}}});
 const headers=(token:string)=>({Authorization:`Bearer ${token}`,'Content-Type':'application/json'});
 return {post:(path:string,body:unknown,token=operator)=>fetch(r.base+path,{method:'POST',headers:headers(token),body:JSON.stringify(body)}),
 get:(path:string,token=operator)=>fetch(r.base+path,{headers:headers(token)})};
}

contractTest('agents', 'tests/service-api.test.ts:43', 'operator provisioning imports native history once; scoped reads do not journal transcript copies', async(t,r)=>{
  const f = await fixture(r);
  const initialMessages = [{ role: 'user', content: 'preserve-native-history', timestamp: 1 }];
  const response = await f.post('/v1/agents', { thinkingLevel: 'low', initialMessages });
  assert.equal(response.status, 201);
  const session = await response.json() as any;
  const path = `/clients/${session.id}`;
  assert.equal((await f.get(path + '/history')).status, 401, 'operator token is not a scoped credential');
  assert.equal((await f.get(path + '/history', 'wrong-scoped-token')).status, 401);
  const history = await (await f.get(path + '/history', session.token)).json() as any;
  assert.deepEqual(history.messages, initialMessages);
  // Node journal/header storage assertions remain in the original implementation suite.

});

contractTest('agents', 'tests/service-api.test.ts:62', 'scoped configuration persists allowed fields and rejects provider credentials or endpoints', async(t,r)=>{
  const f = await fixture(r);
  const response = await f.post('/v1/agents', {});
  const session = await response.json() as any;
  const path = `/clients/${session.id}`;
  for (const params of [{ model: configuredModel({ AGENT_PROVIDER: "openrouter" }) }, { apiKey: 'secret' }, { initialMessages: [] }]) {
    assert.equal((await f.post(path + '/requests', { id: 'invalid', method: 'configure', params }, session.token)).status, 400);
  }
  const inspect = { name: 'inspect', description: 'Inspect a fixture', inputSchema: { type: 'object', properties: {} }, _meta: { 'agent-runtime/exposure': 'direct' } };
  const params = { systemPrompt: 'You inspect test fixtures.', thinkingLevel: 'high', mcp: { tools: [inspect] } };
  assert.equal((await f.post(path + '/requests', { id: 'config', method: 'configure', params }, session.token)).status, 202);
  let record: any;
  // Configuration waits for the agent to start, which on a loaded CI runner takes more than a second.
  for (let i = 0; i < 1000; i++) {
    record = await (await f.get(path + '/requests/config', session.token)).json();
    if (record.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.notEqual(record.state, 'running', 'configuration finished');
  assert.equal(record.outcome.error, undefined);
  const saved = (await r.call(`/v1/agents/${session.id}`, {token:operator})).json;
  assert.equal(saved.systemPrompt, params.systemPrompt);
  // The public detail has no thinkingLevel field; observe the persisted setting on its next model request.
  await r.prompt(session.id, 'Check the configured reasoning level.', operator, {allowDisconnected:true});
  assert.equal(r.model.bodies.at(-1).reasoning?.effort, 'high');
  assert.deepEqual(saved.tools, [{ name: 'inspect', description: 'Inspect a fixture', parameters: inspect.inputSchema, exposure: 'direct' }]);

}, {env:{AGENT_MODEL:'deepseek/deepseek-v4.1-flash-1017'}});

contractTest('agents', 'tests/service-api.test.ts:88', 'provisioning takes models by name only, never an endpoint or credentials', async(t,r)=>{
  const f = await fixture(r);
  for (const extra of [
    { apiKey: 'should-not-persist' },
    { model: { ...configuredModel({ AGENT_PROVIDER: "openrouter" }), headers: { Authorization: 'Bearer should-not-persist' } } },
    { model: { ...configuredModel({ AGENT_PROVIDER: "openrouter" }), baseUrl: 'https://user:pass@example.test/v1' } },
    { model: { ...configuredModel({ AGENT_PROVIDER: "openrouter" }), baseUrl: 'https://example.test/v1?key=secret' } },
    // The host provider key must never be sent to an endpoint a caller names.
    { model: { ...configuredModel({ AGENT_PROVIDER: "openrouter" }), baseUrl: 'https://collector.example.test/v1' } },
    { model: { ...configuredModel({ AGENT_PROVIDER: "openrouter" }), maxTokens: -1 } },
    { thinkingLevel: 'invalid' },
  ]) assert.equal((await f.post('/v1/agents', { ...extra })).status, 400);

});

contractTest('agents', 'tests/service-api.test.ts:102', 'tenants provision and see only their own agents, billed to their own provider keys', async(t,r)=>{
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const alice = 'alice-operator-token-at-least-24-chars', bob = 'bob-operator-token-at-least-24-chars', carol = 'carol-operator-token-at-least-24-chars';
  await r.seedTenant('alice',{token:alice,config:{apiKeys:{openrouter:'alice-provider-key'}}});
  await r.seedTenant('bob',{token:bob,config:{apiKeys:{}}});
  const f = await fixture(r, false);
  assert.equal((await fetch(new URL('/healthz', (await f.get('/registry', alice)).url))).status, 200);
  assert.equal((await f.post('/v1/agents', {}, 'operator-fixture-secret-at-least-24-chars')).status, 401, 'a token no tenant has is refused');
  const created = await f.post('/v1/agents', { name: 'Alice agent' }, alice);
  assert.equal(created.status, 201);
  const agent = await created.json() as any;
  // A tenant with no model key still makes agents; their runs say which key to set.
  const keyless = await f.post('/v1/agents', { name: 'Bob agent' }, bob);
  assert.equal(keyless.status, 201);
  assert.deepEqual((await (await f.get('/registry', alice)).json() as any[]).map(a => a.name), ['Alice agent']);
  assert.deepEqual((await (await f.get('/registry', bob)).json() as any[]).map(a => a.name), ['Bob agent']);
  assert.equal((await f.get(`/registry/${agent.id}`, bob)).status, 404, "another tenant's agent is not found");
  assert.equal((await f.post(`/registry/${agent.id}/requests`, { id: 'cross', method: 'status', params: {} }, bob)).status, 401);
  assert.equal((await f.post(`/registry/${agent.id}/requests`, { id: 'own', method: 'status', params: {} }, alice)).status, 202);
  // The same idempotency key in another tenant is a different agent.
  const sameKey = (token: string) => fetch(new URL('/v1/agents', (created as Response).url), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'shared-key' }, body: JSON.stringify({}) });
  await r.seedTenant('carol',{token:carol,config:{apiKeys:{openrouter:'carol-provider-key'}}});
  let carolAgent: Response | undefined;
  for (let i = 0; i < 50 && carolAgent?.status !== 201; i++) { carolAgent = await sameKey(carol); if (carolAgent.status !== 201) await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(carolAgent!.status, 201);
  const aliceShared = await sameKey(alice);
  assert.notEqual((await aliceShared.json() as any).id, (await carolAgent!.json() as any).id);
  // Node header ownership/key storage assertions remain in the source suite.

});

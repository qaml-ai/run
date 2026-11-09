import assert from 'node:assert/strict';
import { contractTest, listen, OTHER_OPERATOR, toolCall, toolResults, OPERATOR } from '../support.ts';

import { Agents } from '../../../clients/agents.ts';

contractTest('configuration', 'tests/small-parity.test.ts', 'mount instructions and pinned definition revisions survive updates', async (_t, r) => {
  r.setModel(body => ({ role: 'assistant', content: JSON.stringify(body.messages) }));
  const volume = await r.call('/v1/volumes', { body: { name: 'memory' } });
  const mounts = [{ volumeId: volume.json.id, path: '/memory', mode: 'ro', instructions: 'Read the index before searching.' }];
  const definition = await r.call('/v1/definitions', { body: { name: 'Pinned', description: 'REVISION_ONE_DESCRIPTION', systemPrompt: 'REVISION_ONE', mounts } });
  assert.equal(definition.status, 201, definition.text);
  const changed = await r.call(`/v1/definitions/${definition.json.id}`, { method: 'PATCH', body: { description: 'REVISION_TWO_DESCRIPTION', systemPrompt: 'REVISION_TWO' } });
  assert.equal(changed.status, 200, changed.text);
  const made = await r.call('/v1/agents', { body: { definition: definition.json.id, definitionRevision: 1 } });
  assert.equal(made.status, 201, made.text);
  const result = await r.prompt(made.json.id, 'describe');
  assert.match(result.outcome.result.reply, /REVISION_ONE/);
  assert.doesNotMatch(result.outcome.result.reply, /REVISION_TWO/);
  assert.match(result.outcome.result.reply, /Read the index before searching/);
  const invalid = await r.call('/v1/agents', { body: { mounts: [{ ...mounts[0], instructions: 'x'.repeat(4097) }] } });
  assert.equal(invalid.status, 400, invalid.text);
  assert.match(result.outcome.result.reply, /Mount notes from the agent's owner/);
  const tooMany = await r.call('/v1/agents', { body: { mounts: [0, 1, 2].map(i => ({ ...mounts[0], path: `/m${i}`, instructions: 'x'.repeat(3000) })) } });
  assert.equal(tooMany.status, 400, tooMany.text);
  const atLimit = await r.call('/v1/agents', { body: { mounts: [0, 1].map(i => ({ ...mounts[0], path: `/m${i}`, instructions: 'x'.repeat(4096) })) } });
  assert.equal(atLimit.status, 201, atLimit.text);
  const tooWide = await r.call('/v1/agents', { body: { delegate: { maxParallel: 65 } } });
  assert.equal(tooWide.status, 400, tooWide.text);
  assert.match(tooWide.text, /64/);
  for (const revision of [0, -1, 1.5, 999]) {
    const invalidPin = await r.call('/v1/agents', { body: { definition: definition.json.id, definitionRevision: revision } });
    assert.ok([400, 404].includes(invalidPin.status), invalidPin.text);
  }
  const foreign = await r.call('/v1/agents', { token: OTHER_OPERATOR, body: { definition: definition.json.id, definitionRevision: 1 } });
  assert.equal(foreign.status, 404, foreign.text);
  for (const [revision, token] of [[0, OPERATOR], [999, OPERATOR], [1, OTHER_OPERATOR]] as const) {
    const invalidTarget = await r.call('/v1/agents', { token, body: { builtins: ['delegate'], delegate: { agents: [{ name: 'bad', definition: definition.json.id, revision }] } } });
    if (revision === 0) { assert.equal(invalidTarget.status, 400, invalidTarget.text); continue; }
    assert.equal(invalidTarget.status, 201, invalidTarget.text);
    r.setModel(body => toolResults(body).length ? { role: 'assistant', content: toolResults(body).at(-1) } : toolCall('delegate', { agent: 'bad', task: 'describe' }));
    const rejected = await r.prompt(invalidTarget.json.id, 'delegate', token);
    assert.match(rejected.outcome.result.reply, /Unknown definition/);
    assert.doesNotMatch(rejected.outcome.result.reply, /REVISION_ONE/);
  }
  const parent = await r.call('/v1/agents', { body: { builtins: ["delegate"], delegate: { maxParallel: 64, agents: [{ name: 'pinned', definition: definition.json.id, revision: 1 }] } } });
  assert.equal(parent.status, 201, parent.text);
  r.setModel(body => {
    if (JSON.stringify(body.messages).includes('REVISION_ONE')) return { role: 'assistant', content: 'pinned revision one' };
    assert.match(JSON.stringify(body.tools), /REVISION_ONE_DESCRIPTION/);
    assert.doesNotMatch(JSON.stringify(body.tools), /REVISION_TWO_DESCRIPTION/);
    return toolResults(body).length ? { role: 'assistant', content: toolResults(body).at(-1) } : toolCall('delegate', { agent: 'pinned', task: 'describe' });
  });
  const delegated = await r.prompt(parent.json.id, 'delegate');
  assert.match(delegated.outcome.result.reply, /pinned revision one/);
});

contractTest('human-input', 'tests/small-parity.test.ts', 'unattended approvals decline without waiting', async (t, r) => {
  let calls = 0;
  const server = await listen(t, async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(parts).toString());
    const reply = (result: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); };
    if (body.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } });
    if (body.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    if (body.method === 'tools/list') return reply({ tools: [{ name: 'write', inputSchema: { type: 'object', properties: {} } }] });
    calls++;
    return reply({ content: [{ type: 'text', text: 'ran' }] });
  });
  r.setModel(body => !toolResults(body).length ? toolCall('test__write', {}) : { role: 'assistant', content: toolResults(body).at(-1) });
  const settings = { humanInput: { unattended: 'decline' }, mcpServers: [{ name: 'test', url: server + '/mcp', exposure: 'direct', approval: { default: 'always' } }] };
  const definition = await r.call('/v1/definitions', { body: { name: 'Unattended', ...settings } });
  assert.equal(definition.status, 201, definition.text);
  const made = await r.call('/v1/agents', { body: { definition: definition.json.id } });
  const result = await r.prompt(made.json.id, 'write');
  assert.match(result.outcome.result.reply, /unattended/);
  assert.equal(calls, 0);
  assert.notEqual(result.outcome.result.stopped, 'input_required');
  const direct = await r.call('/v1/agents', { body: settings });
  assert.equal(direct.status, 201, direct.text);
  const directResult = await r.prompt(direct.json.id, 'write');
  assert.match(directResult.outcome.result.reply, /unattended/);
  assert.equal(calls, 0);
  assert.notEqual(directResult.outcome.result.stopped, 'input_required');
}, { env: { AGENT_OUTBOUND_ALLOW_HTTP: 'true', AGENT_OUTBOUND_ALLOW_CIDRS: '127.0.0.1/32' } });

contractTest('quotas', 'tests/small-parity.test.ts', 'SDK run returns a budget pause without throwing', async (_t, r) => {
  r.setModel((_body, index) => ({ ...toolCall('codemode', { code: 'return 1' }, `call_${index}`), usage: { prompt_tokens: 5000, completion_tokens: 0 } }));
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  const run = await agents.run({ input: 'go', spendLimit: { usd: 0.000001 }, throwOnError: false });
  assert.equal(run.status, 'failed');
  assert.equal(run.stoppedReason, 'budget_reached');
  assert.equal(run.limit, 'run');
  assert.equal(run.error?.code, 'spend_limit');
  const agent = await agents.upsert('budget-pause', { attach: false, connection: 'lazy' });
  try {
    const paused = await agent.run('work', { spendLimit: { usd: 0.000001 } });
    assert.equal(paused.status, 'paused');
    r.setModel(() => ({ role: 'assistant', content: 'continued' }));
    const resumed = await agent.client.continue();
    assert.equal(resumed.reply, 'continued');
  } finally { await agent.close(); }
});

contractTest('agents', 'tests/small-parity.test.ts', 'agent MCP reports a budget pause as an error with limit details', async (t, r) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  r.setModel((_body, index) => ({ ...toolCall('codemode', { code: 'return 1' }, `call_${index}`), usage: { prompt_tokens: 5000, completion_tokens: 0 } }));
  const made = await r.call('/v1/agents', { body: { spendLimit: { usd: 0.000001 } } });
  assert.equal(made.status, 201, made.text);
  const client = new Client({ name: 'budget-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${r.base}/v1/agents/${made.json.id}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${OPERATOR}` } } }));
  t.after(() => client.close());
  const result = await client.callTool({ name: 'message', arguments: { text: 'work' } });
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as any).error.code, 'spend_limit');
  assert.equal((result.structuredContent as any).error.limit, 'agent');
});

contractTest('human-input', 'tests/small-parity.test.ts', 'unattended declines only the approval in a mixed input request', async (t, r) => {
  const server = await listen(t, async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.id === undefined) { res.writeHead(202).end(); return; }
    const reply = (result: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    if (body.method === 'initialize') return reply({ protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mixed', version: '1' } });
    if (body.method === 'tools/list') return reply({ tools: [{ name: 'ask', inputSchema: { type: 'object', properties: {} } }] });
    return reply({ resultType: 'input_required', inputRequests: {
      approval: { method: 'agent-runtime/approval', params: {} },
      question: { method: 'agent-runtime/question', params: { questions: [{ question: 'Which region?', header: 'Region', options: [{ label: 'EU' }, { label: 'US' }] }] } },
    } });
  });
  r.setModel(() => toolCall('mixed__ask', {}));
  const made = await r.call('/v1/agents', { body: { humanInput: { unattended: 'decline' }, mcpServers: [{ name: 'mixed', url: server + '/mcp', exposure: 'direct' }] } });
  assert.equal(made.status, 201, made.text);
  const result = await r.prompt(made.json.id, 'ask');
  assert.equal(result.outcome.result.stopped, 'input_required');
  const inputs = await r.call(`/v1/agents/${made.json.id}/inputs`);
  assert.ok(inputs.json.some((input: any) => input.kind === 'question' && input.state === 'pending'), inputs.text);
  assert.ok(inputs.json.some((input: any) => input.kind === 'approval' && input.state === 'declined'), inputs.text);
}, { env: { AGENT_OUTBOUND_ALLOW_HTTP: 'true', AGENT_OUTBOUND_ALLOW_CIDRS: '127.0.0.1/32' } });

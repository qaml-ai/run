import assert from 'node:assert/strict';
import { contractTest, listen, toolCall, toolResults, OPERATOR } from '../support.ts';

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
  const run = await agents.run({ input: 'go', spendLimit: { usd: 0.000001 } });
  assert.equal(run.status, 'paused');
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

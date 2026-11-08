import assert from 'node:assert/strict';
import { contractTest, createContractFixture, listen, toolCall, toolResults, until, lastUser, OPERATOR } from '../support.ts';
import { asked, fakeSlack, slackChannels, type FakeSlack } from '../channel-service-fakes.ts';
import { Agents } from '../../../clients/agents.ts';

const decision = { title: 'Which region?', body: 'Choose later', options: [{ label: 'EU' }, { label: 'US' }] };
const question = { questions: [{ question: 'Which region?', header: 'Region', options: [{ label: 'EU' }, { label: 'US' }] }] };
const local = { AGENT_OUTBOUND_ALLOW_HTTP: 'true', AGENT_OUTBOUND_ALLOW_CIDRS: '127.0.0.1/32' };

contractTest('human-input', 'tests/inbox-decisions.test.ts:8', 'an approval request refuses applyRecommendationOnExpiry', async t => {
  const server = await listen(t, async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const message = JSON.parse(text);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const reply = (result: object) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    if (message.method === 'initialize') return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'approval-test', version: '1' } });
    if (message.method === 'tools/list') return reply({ tools: [{ name: 'approve', description: 'Request approval.', inputSchema: { type: 'object', properties: {} } }] });
    return reply({ resultType: 'input_required', inputRequests: { approval: { method: 'agent-runtime/approval', params: { applyRecommendationOnExpiry: true, recommendation: { answer: true, reason: 'Untrusted tool recommendation' } } } } });
  });
  const f = await createContractFixture(t, { env: local, respond: (body, index) => index === 0 ? toolCall('test__approve', {}) : { role: 'assistant', content: toolResults(body).at(-1) } });
  const def = await f.call('/v1/definitions', { body: { name: 'Approval asker', humanInput: {}, mcpServers: [{ name: 'test', url: server + '/mcp', exposure: 'direct' }] } });
  assert.equal(def.status, 201, def.text);
  const agent = (await f.call('/v1/agents', { body: { definition: def.json.id } })).json.id;
  const run = await f.prompt(agent, 'Ask for approval');
  assert.match(run.outcome.result.reply, /Approvals cannot apply recommendations on expiry/);
  assert.notEqual(run.outcome.result.stopped, 'input_required');
  assert.deepEqual((await f.call(`/v1/agents/${agent}/inputs`)).json, []);
});

contractTest('human-input', 'tests/inbox-decisions.test.ts:20', 'mixed decision and blocking answers are refused atomically on Workers', async (_t, f) => {
  f.setModel((body, index) => index === 0 ? toolCall('request_decision', decision, 'decision')
    : index === 1 ? toolCall('ask_user', question, 'question') : { role: 'assistant', content: 'Answered' });
  const made = await f.call('/v1/agents', { body: { builtins: ['ask_user', 'request_decision'], ttlSeconds: null } });
  assert.equal(made.status, 201, made.text);
  const agent = made.json.id;
  await f.prompt(agent, 'Ask both');
  const inputs = (await f.call(`/v1/agents/${agent}/inputs?state=pending`)).json;
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs.map((input: any) => input.blocking).sort(), [false, true]);
  const result = await f.call(`/v1/agents/${agent}/inputs`, { body: { answers: inputs.map((input: any) => ({ id: input.id, action: 'accept', content: { answers: { 'Which region?': 'EU' } } })) } });
  // The existing authorities differ: Node can transact both rows, while Workers must keep Pi and Postgres batches separate.
  if (process.env.CONTRACT_BACKEND === 'workers') {
    assert.equal(result.status, 400, result.text);
    assert.match(result.json.error, /separate batches/);
    assert.equal((await f.call(`/v1/agents/${agent}/inputs?state=pending`)).json.length, 2);
  } else {
    assert.equal(result.status, 202, result.text);
  }
});

contractTest('delegation', 'tests/inbox-decisions.test.ts:20', 'a pending decision does not hold a child result', async (t, f) => {
  let release!: () => void;
  const finish = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  f.setModel(body => {
    const role = body.messages.filter((m: any) => m.role === 'system' || m.role === 'developer').map((m: any) => JSON.stringify(m.content)).join('')
      + JSON.stringify(body.messages.find((m: any) => m.role === 'user')?.content);
    if (role.includes('INBOX_WORKER')) return { role: 'assistant', content: 'Child result', wait: finish };
    if (lastUser(body).includes('<agent_notification')) return { role: 'assistant', content: 'Received child result' };
    const results = toolResults(body);
    if (!results.length) return toolCall('request_decision', decision, 'decision');
    if (JSON.parse(results.at(-1)).inputId) return toolCall('spawn_agent', { instructions: 'You are INBOX_WORKER.', task: 'Do the work' }, 'spawn');
    return { role: 'assistant', content: 'Still working' };
  });
  const made = await f.call('/v1/agents', { body: { builtins: ['request_decision', 'agents'], delegate: { instructions: true }, ttlSeconds: null } });
  assert.equal(made.status, 201, made.text);
  const parent = made.json.id;
  assert.equal((await f.prompt(parent, 'Start')).outcome.result.reply, 'Still working');
  const inputs = (await f.call(`/v1/agents/${parent}/inputs?state=pending`)).json;
  assert.equal(inputs.length, 1);
  release();
  await until(async () => (await f.call(`/v1/agents/${parent}`)).json.requests.find((request: any) => request.id.startsWith('child_') && request.state === 'completed' && request.outcome?.result?.reply === 'Received child result'), 'child result delivered while decision remains open');
  assert.deepEqual((await f.call(`/v1/agents/${parent}/inputs?state=pending`)).json.map((input: any) => input.id), inputs.map((input: any) => input.id));
});

let slack: FakeSlack;
contractTest('channels', 'tests/inbox-decisions.test.ts:20', 'a pending decision does not swallow the next Slack message', async (_t, f) => {
  const channels = slackChannels(f);
  f.setModel((body, index) => index === 0 ? toolCall('request_decision', decision, 'decision') : { role: 'assistant', content: `Message: ${asked(body).text}` });
  const def = await f.call('/v1/definitions', { body: { name: 'Slack decisions', builtins: ['request_decision'] } });
  assert.equal(def.status, 201, def.text);
  const channel = await channels.createChannel({ definition: def.json.id });
  assert.equal((await channels.event(channel, { type: 'app_mention', channel: 'C1', ts: '100.0001', text: '<@UBOT> choose' })).status, 200);
  await until(() => slack.posts().length === 1, 'first channel reply');
  const agent = (await f.call('/v1/agents')).json[0].id;
  const inputs = (await f.call(`/v1/agents/${agent}/inputs?state=pending`)).json;
  assert.equal(inputs.length, 1);
  assert.equal((await channels.event(channel, { type: 'message', channel_type: 'channel', channel: 'C1', ts: '101.0001', thread_ts: '100.0001', text: 'EU' })).status, 200);
  await until(() => slack.posts().length === 2, 'normal reply to the next Slack message');
  assert.equal(slack.posts()[1].text, 'Message: EU');
  assert.equal(asked(f.model.bodies.at(-1)).text, 'EU');
  assert.deepEqual((await f.call(`/v1/agents/${agent}/inputs?state=pending`)).json.map((input: any) => input.id), inputs.map((input: any) => input.id));
}, { env: local, prepare: async t => { slack = await fakeSlack(t); return { AGENT_SLACK_API_URL: slack.url }; } });

contractTest('human-input', 'tests/inbox-clients.test.ts:17', 'the SDK answers a decision and returns a completed receipt', async (t, f) => {
  f.setModel((body, index) => index === 0 ? toolCall('request_decision', decision) : { role: 'assistant', content: 'Continuing' });
  const agents = new Agents({ url: f.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  const agent = await agents.upsert('sdk-decisions', { builtins: ['request_decision'] });
  await f.prompt(agent.id, 'Ask a decision');
  const [input] = await agent.pendingInputs();
  assert.equal(input.kind, 'decision');
  const receipt = await input.answer('EU');
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(receipt.inputs, []);
  await until(() => f.model.bodies.some(body => JSON.stringify(body).includes('decision_answer')), 'the later decision notice');
  const [saved] = (await f.call(`/v1/agents/${agent.id}/inputs`)).json;
  assert.equal(saved.answer.content.answers['Which region?'], 'EU');
});

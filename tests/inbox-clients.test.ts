import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agents } from '../clients/agents.ts';
import { answerValue } from '../clients/chat.ts';
import type { AgentInput, Builtin } from '../clients/typescript.ts';
import { Api } from '../packages/cli/src/api.ts';
import { answer } from '../packages/cli/src/ops.ts';

const builtin: Builtin = 'request_decision';
const input: AgentInput = {
  id: 'inp_decision', agent: `client_${'a'.repeat(40)}`, requestId: 'original', toolCallId: builtin,
  kind: 'decision', message: 'Region?', detail: { questions: [{ question: 'Region?', options: [{ label: 'EU' }, { label: 'US' }], multiSelect: false, allowOther: true }] },
  responders: {}, state: 'pending', blocking: false, priority: 'normal', createdAt: 1, expiresAt: 2,
};
const expected = { action: 'accept', content: { answers: { 'Region?': 'EU' } } };

test('SDK and chat answer a decision by label without reporting a suspended turn', async t => {
  const sent: unknown[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    if (new URL(String(url)).pathname.endsWith(`/inputs/${input.id}`)) {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ input: { ...input, state: 'answered' }, request: null });
    }
    assert.match(String(url), /\/inputs\?state=pending$/);
    return Response.json([input]);
  };
  const agents = new Agents({ url: 'https://runtime.test', apiKey: 'fixture', fetch: fetcher });
  t.after(() => agents.close());
  const agent = await agents.agent({ id: input.agent, token: 'fixture', expiresAt: null });
  const [pending] = await agent.pendingInputs();
  assert.equal(pending.kind, 'decision');
  const receipt = await pending.answer('EU');
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(receipt.inputs, []);
  assert.deepEqual(sent, [expected]);
  assert.deepEqual(answerValue(input, 'EU'), expected);
});

test('CLI answers a decision without claiming that other inputs block its turn', async () => {
  let sent: unknown;
  const api = new Api({ url: 'https://runtime.test' }, async (url, init) => {
    if (String(url).endsWith(`/inputs/${input.id}`)) {
      sent = JSON.parse(String(init?.body));
      return Response.json({ input, request: null });
    }
    return Response.json([input]);
  });
  assert.deepEqual(await answer(api, input.agent, input.id, 'EU'), { agent: input.agent, input: input.id, status: 'answered' });
  assert.deepEqual(sent, expected);
});

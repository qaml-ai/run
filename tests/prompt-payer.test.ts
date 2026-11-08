import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientSessions } from '../src/client-sessions.ts';
import { endUserCharge, payer } from '../src/client-sessions/spend.ts';
import { runBuiltin } from '../src/builtins.ts';
import { WebSearch, braveSearch } from '../src/web-search.ts';
import { WebRender } from '../src/web-render.ts';
import { XSearch } from '../src/x-search.ts';
import { joins } from '../shared/queue-mode.ts';

test('payer is run-local; batches require the same payer selection', () => {
  const ctx = { options: { endUsers: {} } } as any;
  const session = { header: { identity: { subject: 'owner' }, bucket: 'bot:7' } } as any;
  assert.deepEqual(payer(ctx, session, { endUser: 'guest' } as any), { id: 'guest', bucket: 'bot:7' });
  assert.deepEqual(payer(ctx, session, undefined), { id: 'owner', bucket: 'bot:7' });
  const member = (endUser?: string) => ({ bucket: 'bot:7', params: { text: 'hi', ...(endUser ? { endUser } : {}) } });
  assert.equal(joins(member('a'), member('b')), false);
  assert.equal(joins(member('a'), member()), false);
  assert.equal(joins(member('a'), member('a')), true);
});

test('late tool usage keeps the originating run payer and bucket', async () => {
  const first = { id: 'first', endUser: 'guest', bucket: 'first-bucket' };
  const next = { id: 'next', endUser: 'other', bucket: 'next-bucket', method: 'prompt', began: 1 };
  const session = { header: { tenant: 'tenant', identity: { subject: 'owner' } }, requests: new Map([['first', first], ['next', next]]), running: new Map([['next', next]]) };
  const sessions = new Map([['agent', session]]);
  const clients = { sessions } as any;
  const usage = ClientSessions.prototype.billingUsage.call(clients, 'agent', { requestId: 'first', searches: 1, usage: { cost: { total: 0.01 } } } as any);
  assert.equal(usage.identity?.subject, 'guest');
  let charge: unknown[] | undefined;
  const ctx = { sessions, options: { endUsers: { charge: async (...args: unknown[]) => { charge = args; } } } } as any;
  endUserCharge(ctx, 'agent', usage);
  assert.deepEqual(charge?.slice(0, 4), ['tenant', 'guest', 'first-bucket', 10_000]);
  assert.equal((charge?.[5] as any).requestId, 'first');
});

test('web services preserve the originating request in their usage callbacks', async () => {
  const recorded: any[] = [];
  let answer: object = {};
  const outbound = { reachable: async () => {}, fetch: async () => Response.json(answer) } as any;
  const key = async () => ({ key: 'fixture', platform: true });
  const onUsage = (_tenant: string, _agent: string, usage: any) => recorded.push(usage);
  const context = { tenant: 'tenant', agent: 'agent', requestId: 'original' };
  const signal = new AbortController().signal;
  const search = new WebSearch({ outbound, key, order: ['brave'], providers: { brave: braveSearch() } as any, price: () => 1, onSearch: onUsage });
  answer = { web: { results: [{ title: 'result', url: 'https://example.com' }] } };
  await runBuiltin({ outbound, search }, context, 'web_search', { query: 'test' }, signal);
  const xSearch = new XSearch({ outbound, key, onSearch: onUsage });
  answer = { status: 'completed', usage: { cost_in_usd_ticks: 1 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'result' }] }] };
  await runBuiltin({ outbound, xSearch }, context, 'x_search', { query: 'test' }, signal);
  const render = new WebRender({ outbound, key, price: 1, onRender: onUsage });
  answer = { data: { markdown: 'result' } };
  await render.render(context, 'https://example.com', signal);
  assert.deepEqual(recorded.map(usage => [usage.model, usage.requestId]), [
    ['web_search', 'original'], ['x_search', 'original'], ['web_fetch', 'original'],
  ]);
});

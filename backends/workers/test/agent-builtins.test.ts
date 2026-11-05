import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentBuiltins, type BuiltinScope } from '../src/agent-builtins.ts';
import { PublicOutbound } from '../src/public-outbound.ts';
import { PublicAddressPolicy } from '../src/public-address-policy.ts';
import type { Outbound, UsageRecord } from '../src/web-policy-host.ts';

const context = (builtins: string[], extra: Partial<BuiltinScope> = {}) => async () => ({ tenant: 'fixture', agent: 'agent', builtins, ...extra });
const invoke = (tool: any, args: Record<string, unknown>) => tool.execute(args, { callId: 'call' }, { abortSignal: new AbortController().signal });
const value = (result: any) => JSON.parse(result.output[0].text);
function outbound(fetch: Outbound['fetch']): Outbound { return { fetch, reachable: async url => new URL(url), withoutOrigins() { return this; }, allowHttp: false }; }

test('public outbound rejects private names, mixed DNS and mapped private addresses before dispatch', async () => {
  let dispatched = 0;
  const guard = new PublicOutbound({ resolve: async () => ['93.184.216.34', '10.0.0.1'], transport: async () => { dispatched++; return new Response('private'); } });
  for (const url of ['https://public.example/', 'https://metadata.internal./', 'https://localhost/', 'https://127.1/', 'https://[::ffff:127.0.0.1]/']) await assert.rejects(guard.fetch(url));
  assert.equal(dispatched, 0);
  const policy = new PublicAddressPolicy();
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', '2002:0a00:0001::']) assert.ok(policy.blocked(address), address);
  assert.equal(policy.blocked('93.184.216.34'), undefined);
});
test('public redirects are rechecked and cross-origin secrets are stripped', async () => {
  const urls: string[] = [], headers: Headers[] = [], resolutions: string[] = [];
  const guard = new PublicOutbound({ resolve: async host => { resolutions.push(host); return ['93.184.216.34']; }, transport: async (url, init) => {
    urls.push(String(url)); headers.push(new Headers(init?.headers));
    return urls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://other.example/page' } }) : new Response('done');
  } });
  const response = await guard.fetch('https://public.example/start', { secrets: { authorization: 'fixture-secret' }, maxRedirects: 1 });
  assert.equal(await response.text(), 'done');
  assert.equal(response.url, 'https://other.example/page');
  assert.deepEqual(resolutions, ['public.example', 'other.example']);
  assert.equal(headers[0].get('authorization'), 'fixture-secret');
  assert.equal(headers[1].get('authorization'), null);
  const blocked = new PublicOutbound({ resolve: async host => host === 'private.example' ? ['192.168.1.1'] : ['93.184.216.34'], transport: async () => new Response(null, { status: 302, headers: { location: 'https://private.example/' } }) });
  await assert.rejects(blocked.fetch('https://public.example/', { maxRedirects: 1 }), /private.example resolves to 192.168.1.1, a private, local or reserved address/);
});
test('test mode alone does not grant web builtins access to private addresses', async () => {
  const tools = await agentBuiltins({ TEST_MODE: '1', TEST_MODEL: '1' } as never, context(['web_fetch']));
  await assert.rejects(invoke(tools[0], { url: 'http://127.0.0.1/' }), /127.0.0.1 is a private, local or reserved address/);
});
test('outbound streams stop at their byte budget', async () => {
  const guard = new PublicOutbound({ resolve: async () => ['93.184.216.34'], transport: async () => new Response('too much data') });
  await assert.rejects((await guard.fetch('https://public.example/', { maxBytes: 3 })).text(), /larger than 3 bytes/);
});
test('web_fetch preserves source HTML conversion and truncation contract', async () => {
  const html = `<html><head><title>A &amp; B</title></head><body><script>secret()</script><h1>Hello</h1><p>${'Readable text. '.repeat(30)}</p></body></html>`;
  const tools = await agentBuiltins({} as never, context(['web_fetch']), { outbound: outbound(async () => new Response(html, { headers: { 'content-type': 'text/html' } })), key: async () => undefined });
  const result = value(await invoke(tools[0], { url: 'https://public.example/', maxCharacters: 100 }));
  assert.equal(result.title, 'A & B');
  assert.equal(result.text.length, 100);
  assert.equal(result.truncated, true);
  assert.ok(result.totalCharacters > 100);
  assert.deepEqual((await invoke(tools[0], { url: 'https://public.example/', maxCharacters: 100 })).structuredOutput, result);
  assert.doesNotMatch(result.text, /secret/);
  await assert.rejects(invoke(tools[0], { url: 'https://public.example/', maxCharacters: 100001 }), /Invalid web_fetch/);
});
test('web search falls back only on retryable failures and records the answering provider', async () => {
  const calls: string[] = [], usages: UsageRecord[] = [];
  const tools = await agentBuiltins({} as never, context(['web_search'], { webSearch: { providers: ['exa', 'brave'] } }), {
    key: async () => ({ key: 'fixture', platform: false }), admit: async () => {}, record: async (_scope, usage) => { usages.push(usage); },
    outbound: outbound(async url => { calls.push(String(url)); return String(url).includes('exa.ai') ? new Response('', { status: 429 }) : Response.json({ web: { results: [{ title: '<b>Title</b>', url: 'https://example.com', description: 'The <b>answer</b>', page_age: '2026-11-01' }] } }); }),
  });
  const result = value(await invoke(tools[0], { query: 'the answer', count: 1, freshness: 'week' }));
  assert.equal(result.provider, 'brave');
  assert.deepEqual(result.results, [{ title: 'Title', url: 'https://example.com', snippet: 'The answer', date: '2026-11-01' }]);
  assert.equal(calls.length, 2);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].provider, 'brave');
  assert.doesNotMatch(tools[0].description, /read the page with web_fetch/);
});
test('search reports missing own keys without dispatching', async () => {
  let fetched = false;
  const tools = await agentBuiltins({} as never, context(['web_search']), { key: async () => undefined, outbound: outbound(async () => { fetched = true; return Response.json({}); }) });
  await assert.rejects(invoke(tools[0], { query: 'test' }), /add an Exa, Brave or Parallel key/);
  assert.equal(fetched, false);
});
test('x_search preserves handle filters, citations and provider-reported exact cost', async () => {
  let request: any;
  const usages: UsageRecord[] = [];
  const tools = await agentBuiltins({} as never, context(['x_search']), {
    key: async () => ({ key: 'fixture', platform: false }), admit: async () => {}, record: async (_scope, usage) => { usages.push(usage); },
    outbound: outbound(async (_url, init) => { request = JSON.parse(init!.body as string); return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'The answer', annotations: [{ url: 'https://x.com/example/status/1', title: 'Post' }] }] }], usage: { input_tokens: 10, output_tokens: 20, cost_in_usd_ticks: '25000000', server_side_tool_usage_details: { x_search_calls: 2 } } }); }),
  });
  const result = value(await invoke(tools[0], { query: 'topic', allowedHandles: ['@example'], fromDate: '2026-11-01', toDate: '2026-11-05' }));
  assert.deepEqual(request.tools, [{ type: 'x_search', allowed_x_handles: ['example'], from_date: '2026-11-01', to_date: '2026-11-05' }]);
  assert.equal(result.usage.costUsd, 0.0025);
  assert.equal(result.usage.searchCalls, 2);
  assert.equal(result.citations.length, 1);
  assert.equal(usages[0].usage.cost.total, 0.0025);
  await assert.rejects(invoke(tools[0], { query: 'topic', allowedHandles: ['a'], excludedHandles: ['b'] }), /not both/);
});
test('JavaScript shells use source renderer and meter once', async () => {
  const usages: UsageRecord[] = [];
  const tools = await agentBuiltins({} as never, context(['web_fetch']), {
    key: async (_scope, provider) => provider === 'firecrawl' ? { key: 'fixture', platform: false } : undefined,
    admit: async () => {}, record: async (_scope, usage) => { usages.push(usage); },
    outbound: outbound(async url => String(url).includes('firecrawl') ? Response.json({ data: { markdown: 'Rendered page content', metadata: { title: 'Rendered' } } }) : new Response('<html><div id="root"></div></html>', { headers: { 'content-type': 'text/html' } })),
  });
  const result = value(await invoke(tools[0], { url: 'https://public.example/' }));
  assert.equal(result.rendered, true);
  assert.equal(result.text, 'Rendered page content');
  assert.equal(usages.length, 1);
});

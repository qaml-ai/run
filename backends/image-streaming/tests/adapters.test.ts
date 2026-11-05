import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { complete } from '@earendil-works/pi-ai/compat';
import type { Api, Model } from '@earendil-works/pi-ai';
import { handleFake } from '../src/fake-provider.ts';

const data = Buffer.from('synthetic-image-bytes');
const hash = createHash('sha256').update(data).digest('hex');
for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages', 'azure-openai-responses'] as const) {
  test(`unmodified ${api} uses custom fetch and consumes fake provider SSE`, async () => {
    let calls = 0;
    const model: Model<Api> = {
      api, provider: api === 'anthropic-messages' ? 'anthropic' : api === 'azure-openai-responses' ? 'azure' : 'openai',
      id: 'fixture', name: 'Fixture', baseUrl: api === 'anthropic-messages' ? 'https://fake.internal' : 'https://fake.internal/v1',
      input: ['text', 'image'], reasoning: false, contextWindow: 1000000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      headers: { authorization: 'Bearer test-only' },
    };
    const result = await complete(model, { messages: [{ role: 'user', content: [{ type: 'image', data: data.toString('base64'), mimeType: 'image/png' }], timestamp: Date.now() }] }, {
      apiKey: 'test-only', maxRetries: 0,
      fetch: async (input, init) => {
        calls++;
        const request = new Request(input, init);
        // Azure's resource/deployment path differs; the fake shares Responses semantics.
        const path = new URL(request.url).pathname;
        if (api === 'azure-openai-responses') {
          assert.ok(path.endsWith('/responses'));
          return handleFake(new Request('https://fake.internal/v1/responses', request), { EXPERIMENT_TOKEN: 'test-only' });
        }
        return handleFake(request, { EXPERIMENT_TOKEN: 'test-only' });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('');
    const body = JSON.parse(text);
    assert.equal(body.imageCount, 1);
    assert.equal(body.images[0].sha256, hash);
  });
}

for (const provider of ['openrouter', 'deepseek']) {
  test(`${provider} completions endpoint preserves image bytes through custom fetch`, async () => {
    const model: Model<'openai-completions'> = {
      api: 'openai-completions', provider, id: 'fixture', name: 'Fixture',
      baseUrl: `https://${provider}.invalid/v1`, input: ['text', 'image'], reasoning: false,
      contextWindow: 100000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    let calls = 0;
    const result = await complete(model, { messages: [{ role: 'user', content: [{ type: 'image', data: data.toString('base64'), mimeType: 'image/png' }], timestamp: Date.now() }] }, {
      apiKey: 'test-only', maxRetries: 0,
      fetch: async (input, init) => {
        calls++;
        const request = new Request(input, init);
        return handleFake(new Request('https://fake.internal/v1/chat/completions', request), { EXPERIMENT_TOKEN: 'test-only' });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('')).images[0].sha256, hash);
  });
}

test('pi-ai retries after the fake provider consumes and rejects a partial request', async () => {
  const model: Model<'openai-completions'> = {
    api: 'openai-completions', provider: 'openai', id: 'fixture', name: 'Fixture',
    baseUrl: 'https://fake.internal/v1', input: ['text', 'image'], reasoning: false,
    contextWindow: 100000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let calls = 0;
  const result = await complete(model, { messages: [{ role: 'user', content: [{ type: 'image', data: data.toString('base64'), mimeType: 'image/png' }], timestamp: Date.now() }] }, {
    apiKey: 'test-only', maxRetries: 1, maxRetryDelayMs: 10,
    fetch: async (input, init) => {
      calls++;
      const headers = new Headers(init?.headers);
      if (calls === 1) headers.set('x-proto-fail-after', '1');
      return handleFake(new Request(input, { ...init, headers }), { EXPERIMENT_TOKEN: 'test-only' });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.stopReason, 'stop', result.errorMessage);
});

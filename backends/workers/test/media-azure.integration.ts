import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startFixture } from './fixture.ts';
import { pngBytes } from '../../../tests/file-fixtures.ts';

test('Azure serves platform images/transcription, falls back only on transient errors, and preserves other keys', { timeout: 90000 }, async t => {
  type Call = { path: string; body: string; authorization?: string; azureKey?: string };
  const azureCalls: Call[] = [], openaiCalls: Call[] = [];
  let mode: 'ok' | 'transient' | 'safety' = 'ok';
  const endpoint = async (azure: boolean) => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      (azure ? azureCalls : openaiCalls).push({ path: request.url!, body: Buffer.concat(chunks).toString(), authorization: request.headers.authorization, azureKey: request.headers['api-key'] as string | undefined });
      if (azure && mode === 'transient') {
        response.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Synthetic rate limit' } })); return;
      }
      if (azure && mode === 'safety') {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'contentFilter', inner_error: { code: 'ResponsibleAIPolicyViolation', content_filter_results: { violence: { filtered: true } } } } })); return;
      }
      const path = new URL(request.url!, 'http://fixture').pathname;
      if (path.endsWith('/audio/speech')) {
        response.writeHead(200, { 'content-type': 'audio/pcm' }).end(Buffer.alloc(24000)); return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(path.endsWith('/audio/transcriptions')
        ? { text: 'Synthetic transcript', usage: { type: 'duration', seconds: 1 } }
        : { data: [{ b64_json: pngBytes(10, 10).toString('base64') }], usage: { input_tokens: 0, output_tokens: 1000 } }));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  const azureBase = await endpoint(true), openaiBase = await endpoint(false);
  const token = 'local-integration-only-token-with-at-least-32-characters', adminToken = 'art_synthetic-admin-token';
  const f = await startFixture({ tenants: [{ id: 'camelrun-proto-local', token }, { id: 'media-azure-admin', token: adminToken }], vars: {
    AGENT_TENANTS_JSON: JSON.stringify({ platformKeys: { openai: 'synthetic-platform-key' }, tenants: {
      'camelrun-proto-local': { tokenSha256: createHash('sha256').update(token).digest('hex'), apiKeys: {} },
      'media-azure-admin': { tokenSha256: createHash('sha256').update(adminToken).digest('hex'), apiKeys: { openai: 'synthetic-admin-key' } },
    } }),
    MEDIA_BASE_URL: openaiBase, AGENT_AZURE_OPENAI_ENDPOINT: azureBase,
    AGENT_AZURE_OPENAI_API_KEY: 'synthetic-azure-key', AGENT_AZURE_IMAGE_DEPLOYMENT: 'image-fixture', AGENT_AZURE_TRANSCRIPTION_DEPLOYMENT: 'transcription-fixture',
  } });
  t.after(() => f.stop());
  const call = (path: string, body: unknown, method = 'POST', key = token) => fetch(f.url + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const image = async (key = token, keyScope?: string) => {
    const response = await call('/v1/images', { prompt: 'Synthetic image', ...(keyScope ? { keyScope } : {}) }, 'POST', key);
    const body = await response.json() as any;
    assert.equal(response.status, 200, `${body.code ?? ''}: ${body.error ?? ''}`);
    assert.equal(body.model, 'openai/gpt-image-2.5-flare');
  };
  const wav = Buffer.alloc(44 + 48000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(48000, 40);
  const transcribe = async () => {
    const response = await call('/v1/transcriptions', { data: wav.toString('base64') });
    const body = await response.json() as any;
    assert.equal(response.status, 200, `${body.code ?? ''}: ${body.error ?? ''}`);
    assert.equal(body.text, 'Synthetic transcript');
  };

  await image(); await transcribe();
  assert.equal(openaiCalls.length, 0);
  assert.equal(azureCalls[0].path, '/openai/deployments/image-fixture/images/generations?api-version=2025-04-01-preview');
  assert.equal(JSON.parse(azureCalls[0].body).model, 'image-fixture');
  assert.equal(azureCalls[1].path, '/openai/deployments/transcription-fixture/audio/transcriptions?api-version=2025-04-01-preview');
  assert.match(azureCalls[1].body, /transcription-fixture/);
  assert.ok(azureCalls.every(call => call.azureKey === 'synthetic-azure-key' && call.authorization === undefined));

  mode = 'transient';
  await image(); await transcribe();
  assert.equal(azureCalls.length, 4);
  assert.deepEqual(openaiCalls.map(call => call.path), ['/images/generations', '/audio/transcriptions']);
  assert.ok(openaiCalls.every(call => call.authorization === 'Bearer synthetic-platform-key' && call.azureKey === undefined));
  mode = 'safety';
  const refused = await call('/v1/images', { prompt: 'Synthetic safety refusal' });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json() as any).code, 'IMAGE_REFUSED');
  assert.equal(openaiCalls.length, 2, 'safety refusals never fall back');

  mode = 'ok';
  const azureCount = azureCalls.length;
  const speech = await call('/v1/speech', { text: 'Synthetic speech', format: 'wav' });
  assert.equal(speech.status, 200); assert.equal((await speech.arrayBuffer()).byteLength, 24044);
  assert.equal(openaiCalls.at(-1)?.path, '/audio/speech');
  await image(adminToken);
  assert.ok(openaiCalls.at(-1)?.authorization === 'Bearer synthetic-admin-key');
  assert.equal((await call('/v1/providers/openai/key', { apiKey: 'synthetic-owned-key', verify: false }, 'PUT')).status, 200);
  await image(); assert.ok(openaiCalls.at(-1)?.authorization === 'Bearer synthetic-owned-key');
  assert.equal((await call('/v1/key-scopes/customer/providers/openai', { apiKey: 'synthetic-scoped-key' }, 'PUT')).status, 200);
  await image(token, 'customer'); assert.ok(openaiCalls.at(-1)?.authorization === 'Bearer synthetic-scoped-key');
  assert.equal(azureCalls.length, azureCount, 'speech, admin, tenant-owned and scoped credentials stay off Azure');
});

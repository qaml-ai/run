import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { handleFake } from '../src/fake-provider.ts';
import { makeMarker } from '../src/marker.ts';
import { handleProxy } from '../src/proxy.ts';

// Native FixedLengthStream is verified on deployed Workers; this test double permits Node orchestration.
class FixedLengthTestStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(_size: number) { super(); }
}
const payload = new Uint8Array([0, 1, 127, 255, 32, 8, 42]);
const sha256 = createHash('sha256').update(payload).digest('hex');
const marker = makeMarker({ key: 'derivative/test', size: payload.length, mimeType: 'image/png', sha256 });
function request(body: unknown) {
  return new Request('https://proxy.internal/verify', { method: 'POST', headers: { authorization: 'Bearer test-only' }, body: JSON.stringify(body) });
}
test('proxy expands only image slots and forwards exact Content-Length', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'FixedLengthStream');
  Object.defineProperty(globalThis, 'FixedLengthStream', { value: FixedLengthTestStream, configurable: true });
  try {
    let gets = 0;
    const response = await handleProxy(request({ messages: [{ content: [{ type: 'text', text: marker }, { type: 'image_url', image_url: { url: `data:image/png;base64,${marker}` } }] }] }), {
      EXPERIMENT_TOKEN: 'test-only',
      BUCKET: {
        head: async () => ({ size: payload.length }),
        get: async () => { gets++; return { size: payload.length, body: new Blob([payload]).stream() }; },
      },
      PROVIDER: { fetch: async (input, init) => handleFake(new Request(input, { ...init, duplex: 'half' } as RequestInit), { EXPERIMENT_TOKEN: 'test-only' }) },
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { imageCount: number; images: {sha256:string}[]; contentLengthMatches:boolean; transferEncoding:null };
    assert.equal(result.imageCount, 1);
    assert.equal(result.images[0].sha256, sha256);
    assert.equal(result.contentLengthMatches, true);
    assert.equal(result.transferEncoding, null);
    assert.equal(gets, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, 'FixedLengthStream', original);
    else Reflect.deleteProperty(globalThis, 'FixedLengthStream');
  }
});

test('proxy denies missing images before provider and bounds marker request size', async () => {
  let providerCalls = 0;
  const env = {
    EXPERIMENT_TOKEN: 'test-only',
    BUCKET: { head: async () => null, get: async () => null },
    PROVIDER: { fetch: async () => { providerCalls++; return new Response('unexpected'); } },
  };
  const missing = await handleProxy(request({ input: [{ content: [{ type: 'input_image', image_url: `data:image/png;base64,${marker}` }] }] }), env);
  assert.equal(missing.status, 502);
  assert.equal(providerCalls, 0);
  assert.equal((await handleProxy(request('x'.repeat(256 * 1024)), env)).status, 413);
});

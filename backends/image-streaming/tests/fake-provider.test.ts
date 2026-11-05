import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { handleFake, verifyImageBody } from '../src/fake-provider.ts';

const bytes = Uint8Array.from({ length: 2053 }, (_, index) => (index * 71) % 256);
const base64 = Buffer.from(bytes).toString('base64');
const expected = createHash('sha256').update(bytes).digest('hex');
function request(body: unknown, fragment = 19): Request {
  const data = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
  let offset = 0;
  return new Request('https://fake.internal/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer test-only' },
    body: new ReadableStream({ pull(controller) {
      if (offset === data.length) return controller.close();
      const end = Math.min(data.length, offset + fragment);
      controller.enqueue(data.slice(offset, end)); offset = end;
    } }), duplex: 'half',
  } as RequestInit);
}
function chat(data = base64) { return { messages: [{ role: 'user', content: [{ type: 'text', text: 'Not an image: \\"data, [image]\\" 🙂' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }] }] }; }

test('fake provider hashes fragmented OpenAI, Responses and Anthropic bodies', async () => {
  const payloads = [chat(), { input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${base64}` }] }] }, { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] }] }];
  for (const payload of payloads) {
    const result = await verifyImageBody(request(payload));
    assert.deepEqual(result.images.map(({sha256,bytes,source})=>({sha256,bytes,source})), [{ sha256: expected, bytes: bytes.length, source: 'base64' }]);
  }
});

test('receiver checks JPEG/WebP magic against declared data-URL MIME', async () => {
  const jpeg = Buffer.from([255,216,255,224,0,4,1,2,3,4,5,6]);
  await assert.rejects(verifyImageBody(request(chat(jpeg.toString('base64')))), /MIME does not match/);
  const payload = JSON.stringify(chat(jpeg.toString('base64'))).replace('image/png','image/jpeg');
  const result = await verifyImageBody(request(payload));
  assert.equal(result.images[0].mimeType,'image/jpeg');
  assert.equal(result.images[0].declaredMimeType,'image/jpeg');
});

test('parser handles large chunks without retaining a whole image', async () => {
  const big = Buffer.alloc(4 * 1024 * 1024, 97);
  const result = await verifyImageBody(request(chat(big.toString('base64')), 64 * 1024));
  assert.equal(result.images[0].sha256, createHash('sha256').update(big).digest('hex'));
  assert.equal(result.images[0].bytes, big.length);
});

test('fake provider verifies many images and preserves order', async () => {
  const result = await verifyImageBody(request({ messages: [{ role: 'user', content: Array.from({ length: 100 }, () => chat().messages[0].content[1]) }] }));
  assert.equal(result.imageCount, 100);
  assert.ok(result.images.every(image => image.sha256 === expected));
});

test('base64-only rejects URLs, malformed base64, missing data and excess images', async () => {
  await assert.rejects(verifyImageBody(request({ input: [{ content: [{ type: 'input_image', image_url: 'https://images.example/a' }] }] })), /base64 only/);
  await assert.rejects(verifyImageBody(request(chat('!!!!'))), /base64/);
  await assert.rejects(verifyImageBody(request(chat('YQ='))), /quartet/);
  await assert.rejects(verifyImageBody(request(chat('YR=='))), /Noncanonical/);
  await assert.rejects(verifyImageBody(request('{"messages":[')), /Incomplete/);
  await assert.rejects(verifyImageBody(request(chat()), { maxImages: 0 }), /Too many/);
});

test('URL mode streams and hashes allowed fetch response', async () => {
  const result = await verifyImageBody(request({ input: [{ content: [{ type: 'input_image', image_url: 'https://images.example/a' }] }] }), {
    allowUrls: true,
    fetchUrl: async url => { assert.equal(url, 'https://images.example/a'); return new Response(bytes); },
  });
  assert.deepEqual(result.images, [{ sha256: expected, bytes: bytes.length, source: 'url' }]);
});

test('injected failure cancels incoming stream and retries can read fresh stream', async () => {
  await assert.rejects(verifyImageBody(request(chat()), { failAfterBytes: 100 }), /Injected/);
  assert.equal((await verifyImageBody(request(chat()))).images[0].sha256, expected);
});

test('authenticated fake handler returns usable SSE, denies unauthorized calls', async () => {
  const response = await handleFake(request(chat()), { EXPERIMENT_TOKEN: 'test-only' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.match(await response.text(), new RegExp(expected));
  assert.equal((await handleFake(request(chat()), { EXPERIMENT_TOKEN: 'wrong' })).status, 401);
});

test('signed image fetch rejects redirects without following or exposing capability URLs', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/' } });
  };
  try {
    const incoming = request({ input: [{ content: [{ type: 'input_image', image_url: 'https://images.example/signed-image?signature=private' }] }] });
    incoming.headers.set('x-proto-mode', 'urls');
    const response = await handleFake(incoming, { EXPERIMENT_TOKEN: 'test-only', ALLOWED_IMAGE_ORIGIN: 'https://images.example' });
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.match(text, /redirect is not allowed/);
    assert.doesNotMatch(text, /private|untrusted|images.example/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('URL-mode failure interrupts image download, cancels its source and allows a fresh retry', async () => {
  const original = globalThis.fetch;
  const image = Buffer.alloc(192 * 1024, 73);
  const expectedHash = createHash('sha256').update(image).digest('hex');
  let fetched = 0, cancelled = 0, downloaded = 0;
  globalThis.fetch = async () => {
    fetched++;
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === image.length) { controller.close(); return; }
        const end = Math.min(offset + 16 * 1024, image.length);
        downloaded += end - offset;
        controller.enqueue(image.subarray(offset, end)); offset = end;
      },
      cancel() { cancelled++; },
    }));
  };
  function incoming(fail: boolean) {
    const value = request({ input: [{ content: [{ type: 'input_image', image_url: 'https://images.example/signed-image?signature=private' }] }] });
    value.headers.set('x-proto-mode', 'urls');
    if (fail) value.headers.set('x-proto-fail-after', '50000');
    return value;
  }
  const env = { EXPERIMENT_TOKEN: 'test-only', ALLOWED_IMAGE_ORIGIN: 'https://images.example' };
  try {
    const first = await handleFake(incoming(true), env);
    assert.equal(first.status, 503);
    const failure = await first.text();
    assert.match(failure, /Injected mid-stream failure/);
    assert.doesNotMatch(failure, /private|images.example|signature/);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(cancelled, 1);
    assert.ok(downloaded >= 50000 && downloaded < image.length);
    const second = await handleFake(incoming(false), env);
    assert.equal(second.status, 200);
    assert.match(await second.text(), new RegExp(expectedHash));
    assert.equal(fetched, 2);
  } finally { globalThis.fetch = original; }
});

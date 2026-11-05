import assert from 'node:assert/strict';
import test from 'node:test';
import { makeMarker } from '../src/marker.ts';
import { createSignedImageUrl, serveSignedImage, substituteSignedUrls } from '../src/signed.ts';

const ref = { key: 'derivatives/test.png', size: 7, mimeType: 'image/png', sha256: 'a'.repeat(64) };
const options = { origin: 'https://example.invalid', secret: 'a-test-only-signing-secret-value', keyPrefix: 'derivatives/', now: 1000, expiresAt: 1100 };
const bucket = { async get(key: string) { assert.equal(key, ref.key); return { body: new Blob(['payload']).stream(), size: 7, httpMetadata: { contentType: 'image/png' } }; } };

test('signed image grants expire and bind exact key/path', async () => {
  const url = await createSignedImageUrl(ref, options);
  const result = await serveSignedImage(new Request(url), bucket, options);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-length'), '7');
  assert.equal(await result.text(), 'payload');
  assert.equal((await serveSignedImage(new Request(url), bucket, { ...options, now: 1100 })).status, 403);
  const tampered = new URL(url); tampered.searchParams.set('key', 'derivatives/different.png');
  assert.equal((await serveSignedImage(new Request(tampered), bucket, options)).status, 403);
  tampered.pathname = '/different';
  assert.equal((await serveSignedImage(new Request(tampered), bucket, options)).status, 404);
  await assert.rejects(createSignedImageUrl({ ...ref, key: 'private/secret' }, options), /outside/);
  await assert.rejects(createSignedImageUrl({ ...ref, key: 'derivatives/../secret' }, options), /outside/);
});

test('substitution covers provider image fields and leaves marker-looking text alone', async () => {
  const marker = makeMarker(ref);
  const body = JSON.stringify({ messages: [{ role: 'user', content: [
    { type: 'text', text: marker },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + marker } },
    { type: 'input_image', image_url: 'data:image/png;base64,' + marker },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: marker } },
  ] }] });
  const result = await substituteSignedUrls(body, options);
  const blocks = JSON.parse(result.body).messages[0].content;
  assert.equal(result.images, 3);
  assert.equal(blocks[0].text, marker);
  assert.equal(blocks[1].image_url.url, blocks[2].image_url);
  assert.deepEqual(blocks[3].source, { type: 'url', url: blocks[2].image_url });
  assert.equal((await serveSignedImage(new Request(blocks[2].image_url), bucket, options)).status, 200);
});

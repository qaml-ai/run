import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { makeMarker } from '../src/marker.ts';
import { streamingFetch, type ImageBucket } from '../src/stream.ts';

test('application-owned bearer transport expands native Converse image bytes with an exact length', async () => {
  // Synthetic offline fixture: no AWS SDK, real credential, DNS lookup or network call.
  const bytes = Uint8Array.from({ length: 65_539 }, (_, index) => index % 251);
  const reference = { key: 'derivative/bearer.png', size: bytes.length,
    mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex') };
  let reads = 0;
  const bucket: ImageBucket = {
    head: async key => key === reference.key ? { size: bytes.length } : null,
    get: async key => {
      if (key !== reference.key) return null;
      reads++;
      let offset = 0;
      return { size: bytes.length, body: new ReadableStream<Uint8Array>({ pull(controller) {
        if (offset === bytes.length) return controller.close();
        const end = Math.min(offset + 997, bytes.length);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      } }) };
    },
  };
  const requestBody = JSON.stringify({ messages: [{ role: 'user', content: [
    { text: 'Describe this synthetic image.' },
    { image: { format: 'png', source: { bytes: makeMarker(reference) } } },
  ] }] });
  let requests = 0;
  const receiver: typeof fetch = async (input, init) => {
    requests++;
    assert.equal(input, 'https://bedrock.example.invalid/model/proto/converse-stream');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer synthetic-offline-fixture');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('transfer-encoding'), null);
    const expanded = await new Response(init?.body).text();
    assert.equal(Number(headers.get('content-length')), Buffer.byteLength(expanded));
    const image = JSON.parse(expanded).messages[0].content[1].image;
    assert.equal(image.format, 'png');
    assert.deepEqual(Buffer.from(image.source.bytes, 'base64'), Buffer.from(bytes));
    return new Response('synthetic response; native response decoding is not implemented');
  };
  const transport = streamingFetch(receiver, bucket, {
    createFixedLengthStream: length => {
      let written = 0;
      return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          written += chunk.byteLength;
          assert.ok(written <= length);
          controller.enqueue(chunk);
        },
        flush() { assert.equal(written, length); },
      });
    },
  });
  const response = await transport('https://bedrock.example.invalid/model/proto/converse-stream', {
    method: 'POST',
    headers: { authorization: 'Bearer synthetic-offline-fixture', 'content-type': 'application/json' },
    body: requestBody,
  });
  assert.equal(response.status, 200);
  assert.equal(requests, 1);
  assert.equal(reads, 1, 'bearer authentication requires only the sending pass');
});

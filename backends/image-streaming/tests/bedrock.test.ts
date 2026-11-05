import assert from 'node:assert/strict';
import { createHash, createHmac, type Hash, type Hmac } from 'node:crypto';
import { test } from 'node:test';
import { SignatureV4 } from '@smithy/signature-v4';
import type { SourceData } from '@smithy/types';
import { makeMarker } from '../src/marker.ts';
import { prepareBody, type ImageBucket } from '../src/stream.ts';

function asBytes(source: SourceData): Uint8Array {
  if (typeof source === 'string') return Buffer.from(source);
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}
class NodeSha256 {
  private hash: Hash | Hmac;
  constructor(secret?: SourceData) {
    this.hash = secret === undefined ? createHash('sha256') : createHmac('sha256', asBytes(secret));
  }
  update(source: SourceData): void { this.hash.update(asBytes(source)); }
  async digest(): Promise<Uint8Array> { return this.hash.digest(); }
}
const hex = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

test('two streamed passes reproduce a real SigV4 signature over the expanded body without AWS access', async () => {
  const objects = new Map<string, Uint8Array>([
    ['derivative/first', Uint8Array.from({ length: 65_539 }, (_, index) => index % 251)],
    ['derivative/second', Uint8Array.from({ length: 32_773 }, (_, index) => (index * 17) % 256)],
  ]);
  let reads = 0;
  const bucket: ImageBucket = {
    head: async key => objects.has(key) ? { size: objects.get(key)!.length } : null,
    get: async key => {
      const bytes = objects.get(key);
      if (!bytes) return null;
      reads++;
      let offset = 0;
      return { size: bytes.length, body: new ReadableStream({ pull(controller) {
        if (offset === bytes.length) return controller.close();
        const end = Math.min(offset + 997, bytes.length);
        controller.enqueue(bytes.slice(offset, end)); offset = end;
      } }) };
    },
  };
  const content = [...objects].map(([key, bytes]) => ({ image: { format: 'png', source: {
    bytes: makeMarker({ key, size: bytes.length, mimeType: 'image/png', sha256: hex(bytes) }),
  } } }));
  const markerBody = JSON.stringify({ messages: [{ role: 'user', content }] });
  const expandedBody = JSON.stringify({ messages: [{ role: 'user', content: [...objects.values()].map(bytes => ({
    image: { format: 'png', source: { bytes: Buffer.from(bytes).toString('base64') } },
  })) }] });
  async function pass() {
    const prepared = await prepareBody(markerBody, bucket, { createFixedLengthStream: () => new TransformStream<Uint8Array, Uint8Array>() });
    const hash = createHash('sha256');
    const reader = prepared.body.getReader();
    let size = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      hash.update(item.value); size += item.value.length;
    }
    await prepared.done;
    assert.equal(size, prepared.length);
    return hash.digest('hex');
  }
  const firstPassHash = await pass();
  const secondPassHash = await pass();
  assert.equal(firstPassHash, hex(expandedBody));
  assert.equal(secondPassHash, firstPassHash);
  assert.equal(reads, objects.size * 2, 'each pass independently opens every immutable object');

  // Public, synthetic, nonfunctional fixture values. No real AWS credential or endpoint is used.
  const signer = new SignatureV4({ service: 'bedrock', region: 'us-east-1', sha256: NodeSha256,
    credentials: { accessKeyId: 'EXPERIMENT_SYNTHETIC_ACCESS_KEY', secretAccessKey: 'experiment-synthetic-nonfunctional-signing-secret' } });
  const request = { protocol: 'https:', hostname: 'bedrock.example.invalid', method: 'POST',
    path: '/model/proto/converse-stream', headers: { host: 'bedrock.example.invalid', 'content-type': 'application/json' } };
  const options = { signingDate: new Date('2026-11-05T00:00:00.000Z') };
  const buffered = await signer.sign({ ...request, body: expandedBody }, options);
  const streamed = await signer.sign({ ...request, headers: { ...request.headers, 'x-amz-content-sha256': firstPassHash } }, options);
  const wrong = await signer.sign({ ...request, body: markerBody }, options);
  assert.equal(streamed.headers.authorization, buffered.headers.authorization);
  assert.equal(streamed.headers['x-amz-content-sha256'], secondPassHash);
  assert.notEqual(wrong.headers.authorization, streamed.headers.authorization, 'signing markers then expanding invalidates SigV4');
});

// Real, open-licensed images. Only provenance metadata is checked in.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const REALISTIC_SOURCES = JSON.parse(await readFile(new URL('./realistic-sources.json', import.meta.url), 'utf8'));

/** The caller controls concurrency; each download has a size cap and timeout. */
export async function realisticFixture(index, { signal, maxBytes = 12 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= REALISTIC_SOURCES.length) throw Error('Invalid realistic fixture index');
  const source = REALISTIC_SOURCES[index];
  const url = new URL(source.originalUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'upload.wikimedia.org') throw Error('Unexpected corpus source host');
  const response = await fetch(url, {
    headers: { 'user-agent': 'camelrun-image-experiment/1.0 (https://github.com/qaml-ai/run)' },
    signal: AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]),
    redirect: 'error',
  });
  if (!response.ok || !response.body) throw Error(`Corpus download ${index}: HTTP ${response.status}`);
  const announced = Number(response.headers.get('content-length'));
  if (announced > maxBytes) { await response.body.cancel(); throw Error(`Corpus download ${index} exceeds ${maxBytes} bytes`); }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw Error(`Corpus download ${index} exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, size);
  const sourceSha1 = createHash('sha1').update(bytes).digest('hex');
  if (sourceSha1 !== source.sourceSha1) throw Error(`Corpus source ${index} changed since the pinned Wikimedia revision`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha256, source: { ...source, downloadedBytes: size, originalSha256: sha256 } };
}

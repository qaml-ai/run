import { authorized } from './fake-provider.ts';
import { streamingFetch, type ImageBucket } from './stream.ts';

export interface ProxyEnv {
  BUCKET: ImageBucket;
  PROVIDER: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  EXPERIMENT_TOKEN: string;
}

/** Stateless transport: only marker-sized JSON enters the proxy isolate. */
export async function handleProxy(request: Request, env: ProxyEnv): Promise<Response> {
  if (!authorized(request, env.EXPERIMENT_TOKEN)) return new Response('Unauthorized', { status: 401 });
  const url = new URL(request.url);
  if (request.method !== 'POST' || !['/v1/chat/completions', '/v1/messages', '/v1/responses', '/verify'].includes(url.pathname)) return new Response('Not found', { status: 404 });
  const advertised = Number(request.headers.get('content-length') ?? 0);
  if (advertised > 256 * 1024) return new Response('Marker request too large', { status: 413 });
  if (!request.body) return new Response('Missing body', { status: 400 });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 256 * 1024) {
        await reader.cancel();
        return new Response('Marker request too large', { status: 413 });
      }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const body = await new Blob(chunks).text();
  const forward = streamingFetch(env.PROVIDER.fetch.bind(env.PROVIDER), env.BUCKET);
  try {
    return await forward(`https://provider.internal${url.pathname}`, {
      method: 'POST', headers: request.headers, body, signal: request.signal,
    });
  } catch {
    return Response.json({ error: { message: 'Image transport failed', type: 'image_transport_error' } }, { status: 502 });
  }
}

export default { fetch: handleProxy };

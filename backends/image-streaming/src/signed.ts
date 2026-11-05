import { parseMarker, type ImageReference } from './marker.ts';

export interface SignedImageOptions {
  origin: string;
  secret: string;
  keyPrefix: string;
  expiresAt?: number;
  now?: number;
}

export interface SignedImageBucket {
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number; httpMetadata?: { contentType?: string } } | null>;
}

const encoder = new TextEncoder();
const path = '/signed-image';
const maxLifetimeSeconds = 300;

function allowedKey(key: string, prefix: string): boolean {
  return prefix.length > 0 && key.startsWith(prefix) && key.length <= 1024 && !key.includes('\0') && !key.split('/').includes('..');
}

async function signingKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 24) throw new Error('Image signing secret must contain at least 24 characters');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function signedBytes(key: string, expires: number): Uint8Array {
  return encoder.encode(JSON.stringify(['camelrun-image-v1', path, key, expires]));
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
}

export async function createSignedImageUrl(ref: ImageReference, options: SignedImageOptions): Promise<string> {
  if (!allowedKey(ref.key, options.keyPrefix)) throw new Error('Image key is outside this experiment');
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const expires = options.expiresAt ?? now + 120;
  if (!Number.isSafeInteger(expires) || expires <= now || expires > now + maxLifetimeSeconds) throw new Error('Invalid image URL expiry');
  const url = new URL(path, options.origin);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error('Image URL requires HTTPS');
  url.searchParams.set('key', ref.key);
  url.searchParams.set('expires', String(expires));
  url.searchParams.set('signature', hex(await crypto.subtle.sign('HMAC', await signingKey(options.secret), signedBytes(ref.key, expires))));
  return url.href;
}

/** Only provider image fields are eligible; marker-looking text is never a capability. */
export async function substituteSignedUrls(body: string, options: SignedImageOptions): Promise<{ body: string; images: number }> {
  const json: unknown = JSON.parse(body);
  let images = 0;
  async function imageUrl(data: unknown): Promise<string | undefined> {
    if (typeof data !== 'string') return undefined;
    const match = /^data:[^;,]+;base64,(.*)$/s.exec(data);
    const ref = parseMarker(match ? match[1]! : data);
    if (!ref) return undefined;
    images++;
    return createSignedImageUrl(ref, options);
  }
  async function visit(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) await visit(entry);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === 'image_url' && node.image_url && typeof node.image_url === 'object') {
      const field = node.image_url as Record<string, unknown>;
      const replacement = await imageUrl(field.url);
      if (replacement) field.url = replacement;
    } else if (node.type === 'input_image') {
      const replacement = await imageUrl(node.image_url);
      if (replacement) node.image_url = replacement;
    } else if (node.type === 'image' && node.source && typeof node.source === 'object') {
      const source = node.source as Record<string, unknown>;
      if (source.type === 'base64') {
        const replacement = await imageUrl(source.data);
        if (replacement) node.source = { type: 'url', url: replacement };
      }
    }
    for (const item of Object.values(node)) await visit(item);
  }
  await visit(json);
  return { body: JSON.stringify(json), images };
}

/** This route is the only public access to the otherwise private experiment bucket. */
export async function serveSignedImage(request: Request, bucket: SignedImageBucket, options: Omit<SignedImageOptions, 'origin' | 'expiresAt'>): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== path || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
  const key = url.searchParams.get('key') ?? '';
  const expires = Number(url.searchParams.get('expires'));
  const signature = url.searchParams.get('signature') ?? '';
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (!allowedKey(key, options.keyPrefix) || !Number.isSafeInteger(expires) || expires <= now || expires > now + maxLifetimeSeconds || !/^[0-9a-f]{64}$/.test(signature)) return new Response('Forbidden', { status: 403 });
  const bytes = Uint8Array.from(signature.match(/../g)!, value => Number.parseInt(value, 16));
  if (!(await crypto.subtle.verify('HMAC', await signingKey(options.secret), bytes, signedBytes(key, expires)))) return new Response('Forbidden', { status: 403 });
  const object = await bucket.get(key);
  if (!object) return new Response('Not found', { status: 404 });
  const headers = {
    'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    'Content-Length': String(object.size),
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
  if (request.method === 'HEAD') {
    await object.body.cancel();
    return new Response(null, { headers });
  }
  return new Response(object.body, { headers });
}

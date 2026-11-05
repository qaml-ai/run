import { createHash, timingSafeEqual } from 'node:crypto';

export interface ImageDigest { sha256: string; bytes: number; source: 'base64' | 'url' }
export interface Verification {
  images: ImageDigest[];
  bytesRead: number;
  imageCount: number;
  contentLength: number | null;
  contentLengthMatches: boolean | null;
  transferEncoding: string | null;
}
export interface FakeEnv {
  EXPERIMENT_TOKEN: string;
  ALLOWED_IMAGE_ORIGIN?: string;
}
export interface VerifyOptions {
  allowUrls?: boolean;
  maxImages?: number;
  maxImageBytes?: number;
  maxBodyBytes?: number;
  failAfterBytes?: number;
  fetchUrl?: (url: string) => Promise<Response>;
}

export function authorized(request: Request, token: string): boolean {
  const authorization = request.headers.get('authorization');
  const actual = new TextEncoder().encode(authorization ?? request.headers.get('x-api-key') ?? '');
  const expected = new TextEncoder().encode(authorization !== null ? `Bearer ${token}` : token);
  return token.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected);
}

class Base64Digest {
  private tail = '';
  private hash = createHash('sha256');
  bytes = 0;
  private limit: number;
  constructor(limit: number) { this.limit = limit; }
  write(value: string): void {
    if (!/^[A-Za-z0-9+/=]*$/.test(value)) throw new Error('Invalid base64 character');
    const input = this.tail + value;
    // Keep the final quartet until close so padding is validated exactly once.
    const amount = Math.max(0, Math.floor((input.length - 4) / 4) * 4);
    const prefix = input.slice(0, amount);
    if (prefix.includes('=')) throw new Error('Non-final base64 padding');
    this.update(Buffer.from(prefix, 'base64'));
    this.tail = input.slice(amount);
  }
  private update(bytes: Uint8Array): void {
    this.bytes += bytes.byteLength;
    if (this.bytes > this.limit) throw new Error('Image exceeds fake-provider limit');
    this.hash.update(bytes);
  }
  finish(): ImageDigest {
    if (this.tail.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(this.tail)) {
      throw new Error('Invalid final base64 quartet');
    }
    const final = Buffer.from(this.tail, 'base64');
    if (final.toString('base64') !== this.tail) throw new Error('Noncanonical base64 padding');
    this.update(final);
    return { sha256: this.hash.digest('hex'), bytes: this.bytes, source: 'base64' };
  }
}

type Path = (string | number)[];
type Frame = { kind: 'object' | 'array'; path: Path; state: 'key' | 'colon' | 'value' | 'comma'; key?: string; index: number };

function imageSlot(path: Path): 'base64' | 'url' | null {
  const joined = path.map(String).join('/');
  if (/^messages\/\d+\/content\/\d+(?:\/content\/\d+)*\/source\/data$/.test(joined)) return 'base64';
  if (/^messages\/\d+\/content\/\d+(?:\/content\/\d+)*\/source\/url$/.test(joined)) return 'url';
  if (/^messages\/\d+\/content\/\d+\/image_url\/url$/.test(joined)) return 'url';
  if (/^input\/\d+\/content\/\d+\/image_url$/.test(joined)) return 'url';
  return null;
}

/** A small JSON tokenizer: only keys and URL prefixes are retained, never the request. */
export async function verifyImageBody(request: Request, options: VerifyOptions = {}): Promise<Verification> {
  if (!request.body) throw new Error('Missing request body');
  const maxImageBytes = options.maxImageBytes ?? 5 * 1024 * 1024;
  const maxImages = options.maxImages ?? 100;
  const maxBodyBytes = options.maxBodyBytes ?? 768 * 1024 * 1024;
  const images: ImageDigest[] = [];
  const stack: Frame[] = [];
  let rootDone = false;
  let mode: 'normal' | 'string' | 'literal' = 'normal';
  let stringKind: 'key' | 'discard' | 'base64' | 'url' = 'discard';
  let captured = '';
  let escaped = false;
  let unicode: string | null = null;
  let literal = '';
  let digest: Base64Digest | null = null;
  let bytesRead = 0;
  let urlIsBase64 = false;
  let urlIsRemote = false;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const reader = request.body.getReader();

  function valuePath(): Path {
    const parent = stack.at(-1);
    if (!parent) {
      if (rootDone) throw new Error('Trailing JSON value');
      return [];
    }
    if (parent.state !== 'value') throw new Error('Unexpected JSON value');
    return [...parent.path, parent.kind === 'array' ? parent.index : parent.key!];
  }
  function completeValue(): void {
    const parent = stack.at(-1);
    if (!parent) { rootDone = true; return; }
    if (parent.state !== 'value') throw new Error('Unexpected JSON value end');
    parent.state = 'comma';
    if (parent.kind === 'array') parent.index++;
  }
  function addString(value: string): void {
    if (stringKind === 'key') {
      captured += value;
      if (captured.length > 512) throw new Error('JSON key too long');
    } else if (stringKind === 'base64') {
      digest!.write(value);
    } else if (stringKind === 'url') {
      if (urlIsBase64) { digest!.write(value); return; }
      captured += value;
      if (!urlIsRemote && captured.startsWith('data:')) {
        const comma = captured.indexOf(',');
        if (comma < 0) {
          if (captured.length > 256) throw new Error('Invalid data URL prefix');
          return;
        }
        if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(captured.slice(0, comma + 1))) throw new Error('Expected base64 image data URL');
        digest = new Base64Digest(maxImageBytes);
        digest.write(captured.slice(comma + 1));
        captured = '';
        urlIsBase64 = true;
      } else {
        if (captured.length >= 5 && !'https:'.startsWith(captured) && !captured.startsWith('https:')) throw new Error('Expected image data URL or HTTPS URL');
        if (captured.startsWith('https:')) urlIsRemote = true;
        if (captured.length > 4096) throw new Error('Image URL too long');
      }
    }
  }
  async function closeString(): Promise<void> {
    if (stringKind === 'key') {
      const parent = stack.at(-1)!;
      parent.key = captured;
      parent.state = 'colon';
      return;
    }
    if (stringKind === 'base64' || urlIsBase64) images.push(digest!.finish());
    else if (stringKind === 'url') {
      if (!options.allowUrls) throw new Error('This fake provider accepts base64 only');
      if (!urlIsRemote || !options.fetchUrl) throw new Error('Missing URL fetch policy');
      const response = await options.fetchUrl(captured);
      if (!response.ok || !response.body) throw new Error(`Image URL returned ${response.status}`);
      const hash = createHash('sha256');
      const imageReader = response.body.getReader();
      let bytes = 0;
      try {
        while (true) {
          const item = await imageReader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > maxImageBytes) throw new Error('URL image exceeds fake-provider limit');
          hash.update(item.value);
        }
      } finally { await imageReader.cancel().catch(() => {}); }
      images.push({ sha256: hash.digest('hex'), bytes, source: 'url' });
    }
    if (images.length > maxImages) throw new Error('Too many images');
    completeValue();
  }
  function closeLiteral(): void {
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(literal)) throw new Error('Invalid JSON literal');
    mode = 'normal';
    completeValue();
  }
  async function parse(chunk: string): Promise<void> {
    for (let i = 0; i < chunk.length; i++) {
      let character = chunk[i];
      if (mode === 'literal') {
        if (/[\s,}\]]/.test(character)) { closeLiteral(); i--; continue; }
        literal += character;
        if (literal.length > 128) throw new Error('JSON literal too long');
        continue;
      }
      if (mode === 'string') {
        if (unicode !== null) {
          if (!/[0-9a-fA-F]/.test(character)) throw new Error('Invalid JSON unicode escape');
          unicode += character;
          if (unicode.length === 4) { addString(String.fromCharCode(parseInt(unicode, 16))); unicode = null; }
          continue;
        }
        if (escaped) {
          escaped = false;
          if (character === 'u') { unicode = ''; continue; }
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (!(character in escapes)) throw new Error('Invalid JSON escape');
          addString(escapes[character]);
          continue;
        }
        if (character === '\\') { escaped = true; continue; }
        if (character === '"') { await closeString(); mode = 'normal'; continue; }
        let end = i;
        while (end < chunk.length && chunk[end] !== '"' && chunk[end] !== '\\') {
          if (chunk.charCodeAt(end) < 32) throw new Error('Unescaped JSON control character');
          end++;
        }
        addString(chunk.slice(i, end));
        i = end - 1;
        continue;
      }
      if (/\s/.test(character)) continue;
      const parent = stack.at(-1);
      if (character === '"') {
        stringKind = parent?.kind === 'object' && parent.state === 'key' ? 'key' : (imageSlot(valuePath()) ?? 'discard');
        captured = '';
        digest = stringKind === 'base64' ? new Base64Digest(maxImageBytes) : null;
        urlIsBase64 = false;
        urlIsRemote = false;
        mode = 'string';
      } else if (character === '{' || character === '[') {
        const path = valuePath();
        if (stack.length > 32) throw new Error('JSON nesting too deep');
        stack.push({ kind: character === '{' ? 'object' : 'array', path, state: character === '{' ? 'key' : 'value', index: 0 });
      } else if (character === '}' || character === ']') {
        if (!parent || parent.kind !== (character === '}' ? 'object' : 'array')) throw new Error('Unexpected JSON close');
        const empty = parent.kind === 'object' ? parent.state === 'key' && parent.key === undefined : parent.state === 'value' && parent.index === 0;
        if (!empty && parent.state !== 'comma') throw new Error('Incomplete JSON container');
        stack.pop();
        completeValue();
      } else if (character === ':') {
        if (!parent || parent.kind !== 'object' || parent.state !== 'colon') throw new Error('Unexpected JSON colon');
        parent.state = 'value';
      } else if (character === ',') {
        if (!parent || parent.state !== 'comma') throw new Error('Unexpected JSON comma');
        parent.state = parent.kind === 'object' ? 'key' : 'value';
      } else {
        valuePath();
        literal = character;
        mode = 'literal';
      }
    }
  }
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytesRead += item.value.byteLength;
      if (bytesRead > maxBodyBytes) throw new Error('Body exceeds fake-provider limit');
      if (options.failAfterBytes !== undefined && bytesRead >= options.failAfterBytes) throw new Error('Injected mid-stream failure');
      await parse(decoder.decode(item.value, { stream: true }));
    }
    await parse(decoder.decode());
    if ((mode as string) === 'literal') closeLiteral();
    if (mode !== 'normal' || stack.length !== 0 || !rootDone) throw new Error('Incomplete JSON body');
    const declared = request.headers.get('content-length');
    const contentLength = declared === null ? null : Number(declared);
    const contentLengthMatches = contentLength === null ? null : contentLength === bytesRead;
    if (contentLengthMatches === false) throw new Error('Content-Length does not match streamed bytes');
    return { images, bytesRead, imageCount: images.length, contentLength, contentLengthMatches,
      transferEncoding: request.headers.get('transfer-encoding') };
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }
}

function sse(events: unknown[]): Response {
  return new Response(events.map(event => typeof event === 'string' ? `data: ${event}\n\n` : `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  });
}

function providerReply(path: string, result: Verification): Response {
  const content = JSON.stringify(result);
  if (path.endsWith('/messages')) {
    const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    return new Response([
      event('message_start', { message: { id: 'msg_proto', type: 'message', role: 'assistant', model: 'proto-vision', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: content } }),
      event('content_block_stop', { index: 0 }),
      event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
      event('message_stop', {}),
    ].join(''), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
  }
  if (path.endsWith('/responses')) {
    return sse([
      { type: 'response.created', response: { id: 'resp_proto', status: 'in_progress', model: 'proto-vision', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_proto', type: 'message', status: 'in_progress', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', item_id: 'msg_proto', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_proto', output_index: 0, content_index: 0, delta: content },
      { type: 'response.output_text.done', item_id: 'msg_proto', output_index: 0, content_index: 0, text: content },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_proto', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: content, annotations: [] }] } },
      { type: 'response.completed', response: { id: 'resp_proto', status: 'completed', model: 'proto-vision', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]);
  }
  return sse([
    { id: 'chatcmpl-proto', object: 'chat.completion.chunk', created: 0, model: 'proto-vision', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { id: 'chatcmpl-proto', object: 'chat.completion.chunk', created: 0, model: 'proto-vision', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    '[DONE]',
  ]);
}

export async function handleFake(request: Request, env: FakeEnv): Promise<Response> {
  if (!authorized(request, env.EXPERIMENT_TOKEN)) return new Response('Unauthorized', { status: 401 });
  const url = new URL(request.url);
  if (request.method !== 'POST' || !['/v1/chat/completions', '/v1/messages', '/v1/responses', '/verify'].includes(url.pathname)) return new Response('Not found', { status: 404 });
  const allowUrls = request.headers.get('x-proto-mode') === 'urls';
  const failAfter = Number(request.headers.get('x-proto-fail-after') ?? 0);
  let imageBytesRead = 0;
  try {
    const result = await verifyImageBody(request, {
      allowUrls,
      failAfterBytes: !allowUrls && failAfter > 0 ? failAfter : undefined,
      fetchUrl: async imageUrl => {
        const parsed = new URL(imageUrl);
        if (!env.ALLOWED_IMAGE_ORIGIN || parsed.origin !== env.ALLOWED_IMAGE_ORIGIN || parsed.protocol !== 'https:') throw new Error('Image URL origin is not allowed');
        const response = await fetch(parsed, { redirect: 'manual', signal: request.signal });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new Error('Image URL redirect is not allowed');
        }
        if (allowUrls && failAfter > 0 && response.body) {
          // URL requests have small JSON bodies: inject while downloading the image,
          // so the retry exercises a partially consumed provider-side fetch as well.
          const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              imageBytesRead += chunk.byteLength;
              if (imageBytesRead >= failAfter) throw new Error('Injected mid-stream failure');
              controller.enqueue(chunk);
            },
          }));
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        return response;
      },
    });
    return url.pathname === '/verify' ? Response.json(result) : providerReply(url.pathname, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid provider request';
    return Response.json({ error: { message, type: 'invalid_request_error' } }, { status: message === 'Injected mid-stream failure' ? 503 : 400 });
  }
}

export default { fetch: handleFake };

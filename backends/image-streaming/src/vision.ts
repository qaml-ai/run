import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
import {stream as chat} from '@earendil-works/pi-ai/api/openai-completions';
import {normalizeContext} from '@earendil-works/pi-ai/utils/transcript';
import type {Model} from '@earendil-works/pi-ai';
import {makeMarker, parseMarker, type ImageReference} from './marker.ts';
import {streamingFetch} from './stream.ts';
import {makeVisionFixture, VISION_FIXTURE} from './vision-fixture.ts';

const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const MAX_IMAGE_BYTES = 128 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const PREFIX = 'vision-v1/';
const PROMPT = 'Identify the geometric shape and its color on each side of the image. ' +
  'Answer only "Left: [color] [shape]; Right: [color] [shape]".';

export interface VisionEnv {AI: Ai; BUCKET: R2Bucket}

async function readBounded(stream: ReadableStream<Uint8Array>, maximum: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > maximum) throw new Error('Vision bridge body exceeds its one-image bound');
      chunks.push(item.value);
    }
    return Buffer.concat(chunks, length);
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}

function sha256(bytes: Uint8Array): string {return createHash('sha256').update(bytes).digest('hex');}

/**
 * One real-model smoke check. B streams into a bounded bridge; the bridge then
 * buffers one tiny image into the number[] accepted by the Workers AI binding.
 * This does NOT claim streaming HTTP ingestion or memory scaling by Workers AI.
 */
export async function runVisionCheck(env: VisionEnv) {
  const started = performance.now();
  const bytes = await makeVisionFixture();
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Vision fixture exceeds its bound');
  const digest = sha256(bytes);
  const ref: ImageReference = {key: `${PREFIX}${digest}.png`, size: bytes.length,
    mimeType: 'image/png', sha256: digest};
  await env.BUCKET.put(ref.key, bytes, {httpMetadata: {contentType: 'image/png'},
    customMetadata: {sha256: digest}});
  const marker = makeMarker(ref);
  let calls = 0;
  let aiElapsedMs = 0;
  let modelResult: unknown;
  let received: {contentLength: number; consumedBytes: number; transferEncoding: string | null;
    imageCount: number; imageBytes: number; sha256: string; hashMatches: boolean} | undefined;

  const bindingBridge: typeof fetch = async (_input, init) => {
    calls++;
    if (calls !== 1) throw new Error('Vision smoke check permits one real-model invocation');
    if (!(init?.body instanceof ReadableStream)) throw new Error('Expected B streaming body');
    const headers = new Headers(init.headers);
    const contentLength = Number(headers.get('content-length'));
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > MAX_JSON_BYTES) {
      throw new Error('Invalid bounded vision bridge Content-Length');
    }
    const bodyBytes = await readBounded(init.body, MAX_JSON_BYTES);
    if (bodyBytes.length !== contentLength) throw new Error('Vision bridge Content-Length mismatch');
    if (headers.has('transfer-encoding')) throw new Error('Vision bridge must use exact Content-Length');
    const body = JSON.parse(new TextDecoder().decode(bodyBytes)) as {
      messages?: {role?: string; content?: {type?: string; text?: string;
        image_url?: {url?: string}}[] | string}[];
    };
    const content = body.messages?.filter(message => message.role === 'user')
      .flatMap(message => Array.isArray(message.content) ? message.content : []) ?? [];
    const images = content.filter(part => part.type === 'image_url');
    if (images.length !== 1) throw new Error('Vision smoke check requires exactly one image');
    const dataUrl = images[0]?.image_url?.url;
    if (!dataUrl?.startsWith('data:image/png;base64,')) throw new Error('Vision bridge expected PNG data URL');
    const data = dataUrl.slice('data:image/png;base64,'.length);
    if (data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) || parseMarker(data)) {
      throw new Error('Vision bridge received oversized image or unexpanded marker');
    }
    const image = Buffer.from(data, 'base64');
    if (image.toString('base64') !== data || image.length !== ref.size || sha256(image) !== ref.sha256) {
      throw new Error('Vision bridge did not receive the exact original image');
    }
    const prompt = content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
    if (prompt !== PROMPT) throw new Error('Vision bridge prompt changed');
    received = {contentLength, consumedBytes: bodyBytes.length, transferEncoding: headers.get('transfer-encoding'),
      imageCount: images.length, imageBytes: image.length, sha256: sha256(image), hashMatches: true};
    const aiStarted = performance.now();
    // Model schema and installed Workers types allow image: number[]. This
    // intentional bounded conversion is separate from B's streamed request.
    const result = await env.AI.run(MODEL, {prompt, image: Array.from(image),
      max_tokens: 80, temperature: 0, stream: false});
    aiElapsedMs = performance.now() - aiStarted;
    modelResult = result;
    if (!result || typeof result !== 'object' || !('response' in result) || typeof result.response !== 'string') {
      throw new Error('Workers AI returned no text response');
    }
    // Map actual model text back into the format requested by the Pi SDK.
    const frame = (delta: Record<string, string>, finishReason: string | null) =>
      `data: ${JSON.stringify({id: 'workers-ai-vision', object: 'chat.completion.chunk', created: 0,
        model: MODEL, choices: [{index: 0, delta, finish_reason: finishReason}]})}\n\n`;
    return new Response(frame({role: 'assistant', content: result.response}, null) +
      frame({}, 'stop') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
  };

  const model: Model<'openai-completions'> = {id: MODEL, name: 'Workers AI vision bridge',
    api: 'openai-completions', provider: 'openai', baseUrl: 'https://workers-ai-binding.invalid/v1',
    input: ['text', 'image'], reasoning: false, contextWindow: 128000, maxTokens: 80,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
  const response = await chat(model, normalizeContext({messages: [{role: 'user', timestamp: Date.now(),
    content: [{type: 'text', text: PROMPT}, {type: 'image', mimeType: 'image/png', data: marker}]}]}), {
    apiKey: 'unused-binding-placeholder', maxRetries: 0, maxTokens: 80, timeoutMs: 120000,
    fetch: streamingFetch(bindingBridge, env.BUCKET, {allowKey: key => key === ref.key}),
  }).result();
  if (response.stopReason !== 'stop') throw new Error(response.errorMessage ?? 'Pi vision bridge did not complete');
  const text = response.content.filter(part => part.type === 'text').map(part => part.text).join('').trim();
  const plain = text.replaceAll('*', '');
  const left = /\bleft\s*:\s*([^;\n]*)/i.exec(plain)?.[1] ?? '';
  const right = /\bright\s*:\s*([^;\n]*)/i.exec(plain)?.[1] ?? '';
  const checks = {leftRedSquare: /\bred\b/i.test(left) && /\bsquare\b/i.test(left),
    rightBlueCircle: /\bblue\b/i.test(right) && /\bcircle\b/i.test(right)};
  return {model: MODEL, fixture: {...VISION_FIXTURE, bytes: ref.size, sha256: ref.sha256, key: ref.key},
    prompt: PROMPT, response: text, modelResult, checks,
    match: checks.leftRedSquare && checks.rightBlueCircle && received?.hashMatches === true,
    elapsedMs: performance.now() - started, aiElapsedMs, calls, received,
    transport: {piAdapter: 'openai-completions', markerBytes: marker.length,
      request: 'B streamingFetch -> FixedLengthStream -> bounded Workers AI bridge',
      aiInput: 'one buffered image as number[]', aiReceivesHttpStream: false, journalUsed: false,
      path: ['Pi ImageContent marker', 'stock Pi Chat adapter', 'B FixedLengthStream from R2',
        'bounded bridge verifies PNG SHA-256', 'AI.run image:number[]', 'real model text through Chat SSE', 'Pi result']},
    limits: {maxImages: 1, maxImageBytes: MAX_IMAGE_BYTES, maxJsonBytes: MAX_JSON_BYTES, maxOutputTokens: 80},
    caveat: 'One small image validates real visual recognition through the bridge; it does not establish Workers AI large-image memory scaling or external HTTPS provider streaming.'};
}

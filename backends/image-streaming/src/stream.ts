import { parseMarker, type ImageReference } from "./marker.ts";

export interface ImageBucket {
  head(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
}

export interface StreamOptions {
  signal?: AbortSignal | null;
  /** Injected only by Node tests; deployed requests must use FixedLengthStream. */
  createFixedLengthStream?: (length: number) => {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  allowKey?: (key: string) => boolean;
}

export interface PreparedBody {
  body: ReadableStream<Uint8Array>;
  length: number;
  images: number;
  done: Promise<void>;
}

type Part = string | ImageReference;
const encoder = new TextEncoder();
const CHUNK_BYTES = 48 * 1024; // Divisible by three; intermediate chunks never contain '='.

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** Canonicalize small adapter JSON while substituting only known image fields. */
function imageParts(body: string): Part[] {
  const parsed: unknown = JSON.parse(body);
  const replacements: { token: string; ref: ImageReference }[] = [];
  const nonce = crypto.randomUUID();
  const replace = (value: unknown, dataUrl = false): unknown => {
    if (typeof value !== "string") return value;
    const match = dataUrl ? /^data:image\/[a-zA-Z0-9.+-]+;base64,(.*)$/.exec(value) : null;
    const data = dataUrl ? match?.[1] : value;
    if (!data) return value;
    const ref = parseMarker(data);
    if (!ref) return value;
    const token = `__camelrun_stream_${nonce}_${replacements.length}__`;
    replacements.push({ token, ref });
    return dataUrl ? value.slice(0, value.length - data.length) + token : token;
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const obj = value as Record<string, unknown>;
    // Anthropic Messages, including its tool result image blocks.
    if (obj.type === "image" && obj.source && typeof obj.source === "object") {
      const source = obj.source as Record<string, unknown>;
      if (source.type === "base64") source.data = replace(source.data);
    }
    // OpenAI Chat Completions and Responses (OpenRouter uses the former).
    if (obj.type === "image_url" && obj.image_url && typeof obj.image_url === "object") {
      const image = obj.image_url as Record<string, unknown>;
      image.url = replace(image.url, true);
    }
    if (obj.type === "input_image") obj.image_url = replace(obj.image_url, true);
    // Google SDK JSON and REST JSON spellings.
    for (const key of ["inlineData", "inline_data"]) {
      if (obj[key] && typeof obj[key] === "object") {
        const data = obj[key] as Record<string, unknown>;
        const mime = data.mimeType ?? data.mime_type;
        if (typeof mime === "string" && mime.startsWith("image/")) data.data = replace(data.data);
      }
    }
    // Bedrock Converse; its SigV4 signature must be recomputed after this change.
    if (obj.image && typeof obj.image === "object") {
      const image = obj.image as Record<string, unknown>;
      if (typeof image.format === "string" && image.source && typeof image.source === "object") {
        const source = image.source as Record<string, unknown>;
        source.bytes = replace(source.bytes);
      }
    }
    for (const child of Object.values(obj)) visit(child);
  };
  visit(parsed);
  if (!replacements.length) return [body];
  const serialized = JSON.stringify(parsed);
  const parts: Part[] = [];
  let offset = 0;
  // Traversal order need not match serialization order after property overwrites.
  const located = replacements.map(({ token, ref }) => ({ index: serialized.indexOf(token), token, ref }))
    .sort((left, right) => left.index - right.index);
  for (const { index, token, ref } of located) {
    if (index < offset) throw new Error("Invalid image replacement location");
    parts.push(serialized.slice(offset, index), ref);
    offset = index + token.length;
  }
  parts.push(serialized.slice(offset));
  return parts;
}

function base64(bytes: Uint8Array): Uint8Array {
  return encoder.encode(btoa(String.fromCharCode(...bytes)));
}

async function* encodeObject(
  bucket: ImageBucket, ref: ImageReference, signal?: AbortSignal | null,
): AsyncGenerator<Uint8Array> {
  throwIfAborted(signal);
  const object = await bucket.get(ref.key);
  if (!object) throw new Error(`Missing image object: ${ref.key}`);
  if (object.size !== ref.size) {
    await object.body.cancel();
    throw new Error(`Image size changed: ${ref.key}`);
  }
  const reader = object.body.getReader();
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  let carry = new Uint8Array(0);
  let consumed = 0;
  let finished = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      consumed += value.byteLength;
      let offset = 0;
      if (carry.length) {
        const needed = 3 - carry.length;
        const count = Math.min(needed, value.length);
        const joined = new Uint8Array(carry.length + count);
        joined.set(carry);
        joined.set(value.subarray(0, count), carry.length);
        offset += count;
        if (joined.length === 3) { yield base64(joined); carry = new Uint8Array(0); }
        else { carry = joined; continue; }
      }
      while (offset + 3 <= value.length) {
        const length = Math.min(CHUNK_BYTES, Math.floor((value.length - offset) / 3) * 3);
        yield base64(value.subarray(offset, offset + length));
        offset += length;
      }
      carry = value.slice(offset);
    }
    if (consumed !== ref.size) throw new Error(`Image length mismatch: ${ref.key}`);
    if (carry.length) yield base64(carry);
    finished = true;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* outputParts(parts: Part[], bucket: ImageBucket, signal?: AbortSignal | null): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    throwIfAborted(signal);
    if (typeof part === "string") yield encoder.encode(part);
    else yield* encodeObject(bucket, part, signal);
  }
}

function generatorStream(generator: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await generator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await generator.return(undefined); },
  }, { highWaterMark: 0 });
}

export async function prepareBody(body: string, bucket: ImageBucket, options: StreamOptions = {}): Promise<PreparedBody> {
  throwIfAborted(options.signal);
  const parts = imageParts(body);
  const refs = parts.filter((part): part is ImageReference => typeof part !== "string");
  const unique = [...new Map(refs.map((ref) => [ref.key, ref])).values()];
  for (const ref of refs) {
    if (options.allowKey && !options.allowKey(ref.key)) throw new Error("Image key outside request scope");
  }
  // Metadata-only preflight; never retain an open body per image. Four bounded HEADs.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, async () => {
    while (cursor < unique.length) {
      const ref = unique[cursor++];
      throwIfAborted(options.signal);
      const metadata = await bucket.head(ref.key);
      if (!metadata) throw new Error(`Missing image object: ${ref.key}`);
      if (metadata.size !== ref.size) throw new Error(`Image size changed: ${ref.key}`);
    }
  }));
  throwIfAborted(options.signal);
  const length = parts.reduce((sum, part) => sum + (typeof part === "string"
    ? encoder.encode(part).byteLength : 4 * Math.ceil(part.size / 3)), 0);
  if (!Number.isSafeInteger(length)) throw new Error("Request body too large");
  const create = options.createFixedLengthStream ?? ((size: number) => {
    const Fixed = (globalThis as unknown as { FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
    if (!Fixed) throw new Error("FixedLengthStream is required for deployed image streaming");
    return new Fixed(size);
  });
  const fixed = create(length);
  const done = generatorStream(outputParts(parts, bucket, options.signal)).pipeTo(fixed.writable, {
    signal: options.signal ?? undefined,
  });
  // The returned promise remains rejectable, without an unhandled rejection if fetch fails first.
  void done.catch(() => {});
  return { body: fixed.readable, length, images: refs.length, done };
}

/** Each invocation opens fresh R2 streams, including provider SDK retries. */
export function streamingFetch(
  fetchImpl: typeof fetch, bucket: ImageBucket, options: Omit<StreamOptions, "signal"> = {},
): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body !== "string") throw new Error("Image transport requires pi-ai's JSON string body");
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    // Changing an already signed body invalidates SigV4. The Bedrock audit tests this separately.
    if (headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256")) {
      throw new Error("Streaming substitution must run before Bedrock SigV4 signing");
    }
    const controller = new AbortController();
    const signal = init.signal;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const prepared = await prepareBody(init.body, bucket, { ...options, signal: controller.signal });
      headers.set("content-length", String(prepared.length));
      headers.delete("transfer-encoding");
      try {
        const response = await fetchImpl(input, { ...init, headers, body: prepared.body, signal: controller.signal });
        if (!response.ok) {
          controller.abort(new Error(`Provider returned HTTP ${response.status} before upload completion`));
          await prepared.done.catch(() => {});
          return response;
        }
        // A successful early response must not hide an under/over-length upload.
        await prepared.done;
        return response;
      } catch (error) {
        controller.abort(error);
        await prepared.done.catch(() => {});
        throw error;
      }
    } finally { signal?.removeEventListener("abort", abort); }
  };
}

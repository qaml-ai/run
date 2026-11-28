import { parseMarker, type ImageReference } from "./image-request-marker.ts";

export interface ImageBucket {
  head(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
}

export interface StreamOptions {
  signal?: AbortSignal | null;
  /** Node tests supply a transform in place of the Workers FixedLengthStream. */
  createFixedLengthStream?: (length: number) => {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  allowReference?: (reference: ImageReference) => boolean;
}

export interface PreparedBody {
  body: ReadableStream<Uint8Array>;
  length: number;
  images: number;
  done: Promise<void>;
}

type Part = string | ImageReference;
const encoder = new TextEncoder();
const IMAGE_URL_PREFIX = /^data:image\/[a-zA-Z0-9.+-]+;base64,/;
const TEXT_FIELDS = new Set(["text", "content", "input", "instructions", "system", "output", "arguments"]);
const CHUNK_BYTES = 48 * 1024; // Divisible by three, so only the last chunk can have padding.

function parseImageUrl(value: string): ImageReference | null {
  const prefix = IMAGE_URL_PREFIX.exec(value)?.[0];
  return prefix ? parseMarker(value.slice(prefix.length)) : null;
}

/** Canonicalize adapter JSON while substituting only known provider image fields. */
function imageParts(body: string, allowReference: StreamOptions["allowReference"]): Part[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const replacements: { token: string; ref: ImageReference }[] = [];
  const nonce = crypto.randomUUID();
  const replace = (value: unknown, dataUrl = false, onReference?: (ref: ImageReference) => void): unknown => {
    if (typeof value !== "string") return value;
    const ref = dataUrl ? parseImageUrl(value) : parseMarker(value);
    if (!ref) return value;
    if (!allowReference?.(ref)) throw new Error("Image key outside request scope");
    onReference?.(ref);
    const token = `__camelrun_stream_${nonce}_${replacements.length}__`;
    replacements.push({ token, ref });
    return dataUrl ? `data:${ref.mimeType};base64,${token}` : token;
  };

  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      // An adapter change must fail closed if it places a live marker in an unknown field.
      const ref = parseMarker(value) ?? parseImageUrl(value);
      if (ref && allowReference?.(ref)) throw new Error("Unsupported provider image field");
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const obj = value as Record<string, unknown>;

    // Anthropic Messages user and tool result image blocks.
    if (obj.type === "image" && obj.source && typeof obj.source === "object") {
      const source = obj.source as Record<string, unknown>;
      if (source.type === "base64") {
        source.data = replace(source.data, false, ref => { source.media_type = ref.mimeType; });
      }
    }
    // Chat Completions (including OpenRouter) and the OpenAI, Azure and Codex Responses adapters.
    if (obj.type === "image_url" && obj.image_url && typeof obj.image_url === "object") {
      const image = obj.image_url as Record<string, unknown>;
      image.url = replace(image.url, true);
    }
    if (obj.type === "input_image") obj.image_url = replace(obj.image_url, true);

    // Accept both Google SDK and REST JSON spellings.
    for (const key of ["inlineData", "inline_data"]) {
      if (!obj[key] || typeof obj[key] !== "object") continue;
      const data = obj[key] as Record<string, unknown>;
      const mime = data.mimeType ?? data.mime_type;
      if (typeof mime === "string" && mime.startsWith("image/")) {
        data.data = replace(data.data, false, ref => {
          if ("mimeType" in data) data.mimeType = ref.mimeType;
          if ("mime_type" in data) data.mime_type = ref.mimeType;
        });
      }
    }
    // Bedrock Converse JSON over an application-owned HTTPS transport.
    if (obj.image && typeof obj.image === "object") {
      const image = obj.image as Record<string, unknown>;
      if (typeof image.format === "string" && image.source && typeof image.source === "object") {
        const source = image.source as Record<string, unknown>;
        source.bytes = replace(source.bytes, false, ref => { image.format = ref.mimeType.slice("image/".length); });
      }
    }
    for (const [key, child] of Object.entries(obj)) {
      if (typeof child !== "string" || !TEXT_FIELDS.has(key)) visit(child);
    }
  };

  visit(parsed);
  if (!replacements.length) return undefined;
  const serialized = JSON.stringify(parsed);
  const parts: Part[] = [];
  let offset = 0;
  // Some adapters serialize keys in an order different from provider field traversal.
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

/** R2 calls do not take a signal. Stop waiting on abort and dispose of a late body. */
function waitFor<T>(operation: Promise<T>, signal: AbortSignal, dispose?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) dispose?.(value);
      else resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

function base64(bytes: Uint8Array): Uint8Array {
  return encoder.encode(btoa(String.fromCharCode(...bytes)));
}

async function* encodeObject(
  bucket: ImageBucket, ref: ImageReference, signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  signal.throwIfAborted();
  const object = await waitFor(bucket.get(ref.key), signal, late => {
    void late?.body.cancel(signal.reason).catch(() => {});
  });
  if (!object) throw new Error("Missing image object");
  const reader = object.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let carry: Uint8Array = new Uint8Array(0);
  let consumed = 0;
  let finished = false;
  try {
    signal.throwIfAborted();
    if (object.size !== ref.size) throw new Error("Image size changed");
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      consumed += value.byteLength;
      if (consumed > ref.size) throw new Error("Image length mismatch");
      let offset = 0;
      if (carry.length) {
        const count = Math.min(3 - carry.length, value.length);
        const joined = new Uint8Array(carry.length + count);
        joined.set(carry);
        joined.set(value.subarray(0, count), carry.length);
        offset += count;
        if (joined.length < 3) {
          carry = joined;
          continue;
        }
        yield base64(joined);
        signal.throwIfAborted();
      }
      while (offset + 3 <= value.length) {
        const length = Math.min(CHUNK_BYTES, Math.floor((value.length - offset) / 3) * 3);
        yield base64(value.subarray(offset, offset + length));
        signal.throwIfAborted();
        offset += length;
      }
      carry = new Uint8Array(value.subarray(offset));
    }
    if (consumed !== ref.size) throw new Error("Image length mismatch");
    if (carry.length) yield base64(carry);
    finished = true;
  } finally {
    signal.removeEventListener("abort", abort);
    if (!finished) void reader.cancel(signal.reason).catch(() => {});
    reader.releaseLock();
  }
}

async function* outputParts(parts: Part[], bucket: ImageBucket, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    signal.throwIfAborted();
    if (typeof part === "string") yield encoder.encode(part);
    else yield* encodeObject(bucket, part, signal);
  }
}

function generatorStream(
  generator: AsyncGenerator<Uint8Array>,
  stop: (reason: unknown) => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await generator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      stop(reason);
      await generator.return(undefined);
    },
  }, { highWaterMark: 0 });
}

async function prepareParts(
  parts: Part[], bucket: ImageBucket, options: StreamOptions,
): Promise<PreparedBody & { abort: (reason: unknown) => void }> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  signal.throwIfAborted();

  const refs = parts.filter((part): part is ImageReference => typeof part !== "string");
  const unique = new Map<string, ImageReference>();
  for (const ref of refs) {
    const previous = unique.get(ref.key);
    if (previous && previous.size !== ref.size) throw new Error("Conflicting image sizes");
    unique.set(ref.key, ref);
  }
  // Metadata-only preflight. At most four HEADs and one open GET body.
  const pending = unique.values();
  try {
    await Promise.all(Array.from({ length: Math.min(4, unique.size) }, async () => {
      for (const ref of pending) {
        signal.throwIfAborted();
        const metadata = await waitFor(bucket.head(ref.key), signal);
        signal.throwIfAborted();
        if (!metadata) throw new Error("Missing image object");
        if (metadata.size !== ref.size) throw new Error("Image size changed");
      }
    }));
  } catch (error) {
    controller.abort(error);
    throw error;
  }
  signal.throwIfAborted();

  const length = parts.reduce((sum, part) => sum + (typeof part === "string"
    ? encoder.encode(part).byteLength : 4 * Math.ceil(part.size / 3)), 0);
  if (!Number.isSafeInteger(length)) throw new Error("Request body too large");
  const fixed = options.createFixedLengthStream?.(length) ?? new FixedLengthStream(length);
  const abort = (reason: unknown) => controller.abort(reason);
  const source = generatorStream(outputParts(parts, bucket, signal), abort);
  const done = waitFor(source.pipeTo(fixed.writable, { signal }), signal);
  // The caller can await this rejection even if fetch fails before reading.
  void done.catch(() => {});
  return { body: fixed.readable, length, images: refs.length, done, abort };
}

export async function prepareBody(body: string, bucket: ImageBucket, options: StreamOptions = {}): Promise<PreparedBody> {
  options.signal?.throwIfAborted();
  return prepareParts(imageParts(body, options.allowReference) ?? [body], bucket, options);
}

/** Each invocation opens fresh R2 streams, including provider SDK retries. */
export function streamingFetch(
  fetchImpl: typeof fetch, bucket: ImageBucket, options: Omit<StreamOptions, "signal"> = {},
): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body !== "string") return fetchImpl(input, init);
    const request = input instanceof Request ? input : undefined;
    const signal = init.signal === undefined ? request?.signal : init.signal;
    signal?.throwIfAborted();
    const parts = imageParts(init.body, options.allowReference);
    if (!parts) return fetchImpl(input, init);

    const headers = new Headers(init.headers ?? request?.headers);
    if (headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256")) {
      throw new Error("Streaming substitution must run before Bedrock SigV4 signing");
    }

    const prepared = await prepareParts(parts, bucket, { ...options, signal });
    headers.set("content-length", String(prepared.length));
    headers.delete("transfer-encoding");
    // Node fetch requires duplex for streamed bodies. Workers ignores this field.
    const streamed = { ...init, headers, body: prepared.body, duplex: "half" };
    const uploadFailed = new Promise<never>((_, reject) => { void prepared.done.catch(reject); });
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => fetchImpl(input, streamed)),
        uploadFailed,
      ]);
      if (response.ok) {
        // Verify byte counts even if the provider responds before reading the full body.
        await prepared.done;
      } else {
        prepared.abort(new Error(`Provider returned HTTP ${response.status}`));
      }
      return response;
    } catch (error) {
      prepared.abort(error);
      throw error;
    }
  };
}

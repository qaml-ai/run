import { Buffer } from "node:buffer";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type TranscriptContext,
  type UserMessage,
  type Model,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { digest, FileError } from "./volume.ts";
export interface ImageBindings {
  BUCKET: R2Bucket;
  IMAGES: ImagesBinding;
  FILE_SIGNING_SECRET?: string;
  PUBLIC_BASE_URL?: string;
}
export interface ImageRef {
  type: "image_ref";
  tenant: string;
  key: string;
  originalKey: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  size: number;
  version: 1;
}
export const IMAGE_LIMITS = {
  originalBytes: 32 * 1024 * 1024,
  derivativeBytes: 3.75 * 1024 * 1024,
  requestBase64Bytes: 20 * 1024 * 1024,
  requestImages: 40,
};
export async function boundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new FileError("Body exceeds byte limit", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
/** Original streams through Images; at most one bounded derivative is buffered. */
export async function storeImage(
  env: ImageBindings,
  tenant: string,
  bytes: Uint8Array,
): Promise<ImageRef> {
  if (!bytes.length || bytes.length > IMAGE_LIMITS.originalBytes)
    throw new FileError("Invalid image size", 413);
  const hash = await digest(bytes),
    root = `images/${encodeURIComponent(tenant)}/${hash}`;
  const originalKey = `${root}/original`,
    key = `${root}/jpeg-1568-v1`;
  await env.BUCKET.put(originalKey, bytes);
  const existing = await env.BUCKET.head(key);
  if (!existing) {
    const original = await env.BUCKET.get(originalKey);
    if (!original) throw new FileError("Original image missing", 503);
    const transformed = await env.IMAGES.input(original.body)
      .transform({ width: 1568, height: 1568, fit: "scale-down" })
      .output({ format: "image/jpeg", quality: 85, anim: false });
    const derivative = await boundedBytes(
      transformed.response().body,
      IMAGE_LIMITS.derivativeBytes,
    );
    await env.BUCKET.put(key, derivative, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    return {
      type: "image_ref",
      tenant,
      key,
      originalKey,
      mimeType: "image/jpeg",
      size: derivative.length,
      version: 1,
    };
  }
  return {
    type: "image_ref",
    tenant,
    key,
    originalKey,
    mimeType: "image/jpeg",
    size: existing.size,
    version: 1,
  };
}
async function signingKey(env: ImageBindings) {
  if (!env.FILE_SIGNING_SECRET || env.FILE_SIGNING_SECRET.length < 32)
    throw new FileError("File signing secret is not configured", 503);
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.FILE_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signFile(
  env: ImageBindings,
  tenant: string,
  key: string,
  baseUrl: string,
  expiresIn = 900,
) {
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 3600)
    throw new FileError("expiresIn must be 1–3600 seconds");
  const expiresAt = Date.now() + expiresIn * 1000;
  const payload = Buffer.from(
    JSON.stringify({ tenant, key, expiresAt }),
  ).toString("base64url");
  const signature = Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      await signingKey(env),
      new TextEncoder().encode(payload),
    ),
  ).toString("base64url");
  return {
    url: `${env.PUBLIC_BASE_URL ?? baseUrl}/v1/files/${payload}.${signature}/file`,
    expiresAt,
  };
}
export async function handleSignedFileRequest(
  request: Request,
  env: ImageBindings,
): Promise<Response | null> {
  const path = new URL(request.url).pathname,
    match = /^\/v1\/files\/([^/]+)\/[^/]+$/.exec(path);
  if (!match) return null;
  try {
    if (request.method !== "GET")
      throw new FileError("Method not allowed", 405);
    const [payload, signature, ...extra] = match[1].split(".");
    if (
      !payload ||
      !signature ||
      extra.length ||
      Buffer.from(signature, "base64url").toString("base64url") !== signature
    )
      throw new FileError("Invalid file capability", 403);
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await signingKey(env),
        Buffer.from(signature, "base64url"),
        new TextEncoder().encode(payload),
      ))
    )
      throw new FileError("Invalid file capability", 403);
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      tenant: string;
      key: string;
      expiresAt: number;
    };
    if (
      !claim.tenant ||
      !Number.isFinite(claim.expiresAt) ||
      claim.expiresAt <= Date.now() ||
      (!claim.key.startsWith(`images/${encodeURIComponent(claim.tenant)}/`) &&
        !claim.key.startsWith(`files/${encodeURIComponent(claim.tenant)}/`))
    )
      throw new FileError("Expired or invalid file capability", 403);
    const object = await env.BUCKET.get(claim.key);
    if (!object) throw new FileError("File not found", 404);
    return new Response(object.body, {
      headers: {
        "content-type":
          object.httpMetadata?.contentType ?? "application/octet-stream",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof FileError
            ? error.message
            : "Invalid file capability",
      },
      { status: error instanceof FileError ? error.status : 403 },
    );
  }
}
/** Read newest-first, applying count/byte policy before fetching any object.
 * URLs are transient provider input, never durable history. Only an adapter that
 * has verified URL support may choose that path; stock Pi uses bounded base64. */
export async function imageInputs(
  env: ImageBindings,
  tenant: string,
  refs: ImageRef[],
  baseUrl: string,
  urlSupport: boolean,
) {
  let used = 0;
  const blocks: (
    | {
        type: "input_image";
        image_url: string;
      }
    | {
        type: "image";
        data: string;
        mimeType: string;
      }
  )[] = [];
  for (const ref of refs.slice(-IMAGE_LIMITS.requestImages).reverse()) {
    if (
      ref.type !== "image_ref" ||
      ref.tenant !== tenant ||
      !ownedImageKey(tenant, ref.key) ||
      ref.size < 1 ||
      ref.size > IMAGE_LIMITS.derivativeBytes
    )
      throw new FileError("Invalid image reference");
    const size = 4 * Math.ceil(ref.size / 3);
    if (used + size > IMAGE_LIMITS.requestBase64Bytes) continue;
    used += size;
    if (urlSupport)
      blocks.unshift({
        type: "input_image",
        image_url: (await signFile(env, tenant, ref.key, baseUrl)).url,
      });
    else {
      const object = await env.BUCKET.get(ref.key);
      if (!object) throw new FileError("Image derivative missing", 503);
      const bytes = await boundedBytes(
        object.body,
        IMAGE_LIMITS.derivativeBytes,
      );
      if (bytes.length !== ref.size)
        throw new FileError("Image size does not match reference");
      blocks.unshift({
        type: "image",
        mimeType: ref.mimeType,
        data: Buffer.from(bytes).toString("base64"),
      });
    }
  }
  return blocks;
}
const MARKER = "[camelrun-image-ref:v1]";
const ownedImageKey = (tenant: string, key: string) =>
  key.startsWith(`images/${encodeURIComponent(tenant)}/`) || key.startsWith(`files/${encodeURIComponent(tenant)}/`);
export function imageReferenceInput(
  text: string,
  refs: ImageRef[],
  tenant: string,
): UserMessage["content"] {
  if (!Array.isArray(refs) || refs.length > IMAGE_LIMITS.requestImages)
    throw new FileError("Too many image references");
  for (const ref of refs)
    if (
      ref?.tenant !== tenant ||
      ref.type !== "image_ref" ||
      ref.version !== 1 ||
      typeof ref.key !== "string" ||
      !ownedImageKey(tenant, ref.key) ||
      !Number.isSafeInteger(ref.size) ||
      ref.size < 1 ||
      ref.size > IMAGE_LIMITS.derivativeBytes
    )
      throw new FileError("Invalid image reference");
  return [
    { type: "text", text },
    ...refs.map((ref) => ({
      type: "text" as const,
      text: MARKER + JSON.stringify(ref),
    })),
  ];
}
/** Pi's stable schema stores compact references as typed text, not unsupported
 * custom content blocks. Only the provider adapter expands them, with one budget
 * across the entire retained history. Provider URLs never enter that history. */
export function withImageReferences<A extends Api>(
  provider: Provider<A>,
  env: ImageBindings,
  getTenant: () => Promise<string>,
  authorizeFile?: (key: string) => Promise<boolean>,
): Provider<A> {
  const hydrate = async (context: TranscriptContext) => {
    const locations: {
      message: number;
      part: number;
      ref: ImageRef;
    }[] = [];
    context.messages.forEach((m, message) => {
      if (m.role === "user" && Array.isArray(m.content))
        m.content.forEach((p, part) => {
          if (p.type === "text" && p.text.startsWith(MARKER))
            locations.push({
              message,
              part,
              ref: JSON.parse(p.text.slice(MARKER.length)),
            });
        });
    });
    if (!locations.length) return context;
    const tenant = await getTenant(),
      selected = new Map<string, unknown>();
    let bytes = 0,
      count = 0;
    for (const location of locations.reverse()) {
      const ref = location.ref,
        size = 4 * Math.ceil(ref.size / 3);
      if (ref.key.startsWith("files/") && !await authorizeFile?.(ref.key)) continue;
      if (
        count >= IMAGE_LIMITS.requestImages ||
        bytes + size > IMAGE_LIMITS.requestBase64Bytes
      )
        continue;
      const block = (
        await imageInputs(
          env,
          tenant,
          [ref],
          env.PUBLIC_BASE_URL ?? "https://localhost.invalid",
          false,
        )
      )[0];
      selected.set(`${location.message}:${location.part}`, block);
      count++;
      bytes += size;
    }
    return {
      ...context,
      messages: context.messages.map((m, message) =>
        m.role !== "user" || !Array.isArray(m.content)
          ? m
          : {
              ...m,
              content: m.content.map((p, part) =>
                p.type === "text" && p.text.startsWith(MARKER)
                  ? (selected.get(`${message}:${part}`) ?? {
                      type: "text",
                      text: "[Older image omitted by request budget]",
                    })
                  : p,
              ),
            },
      ),
    } as TranscriptContext;
  };
  const defer = (
    model: Model<A>,
    context: TranscriptContext,
    open: (prepared: TranscriptContext) => AssistantMessageEventStream,
  ) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        const prepared = await hydrate(context);
        const source = open(prepared);
        for await (const event of source) output.push(event);
      } catch (error) {
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "error",
          timestamp: Date.now(),
          errorMessage:
            error instanceof Error ? error.message : "Image input failed",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        output.push({ type: "error", reason: "error", error: message });
      }
    })();
    return output;
  };
  return {
    ...provider,
    stream(model, context, options) {
      return defer(model, context, (p) => provider.stream(model, p, options));
    },
    streamSimple(model, context, options) {
      return defer(model, context, (p) =>
        provider.streamSimple(model, p, options),
      );
    },
  };
}

import { createHash, timingSafeEqual } from "node:crypto";
import { IMAGE_LIMITS } from "../../../src/limits.ts";
import { IMAGE_QUALITIES, IMAGE_SIZES } from "./media/images.ts";

const maxBytes = IMAGE_LIMITS.promptChars * 6 + 4096;
const fields = new Set(["prompt", "context", "subject", "bucket", "size", "quality"]);

export function legacyBotsImageAuthorization(request: Request, expected?: string): string | undefined {
  const { protocol, host, pathname, search } = new URL(request.url);
  if (protocol !== "https:" || (host !== "run.camelai.com" && host !== "agents.camelai.dev") ||
      pathname !== "/v1/images" || search || request.method !== "POST" || request.headers.has("upgrade") ||
      request.headers.get("content-type")?.toLowerCase().trim() !== "application/json" ||
      !expected || !/^[a-f0-9]{64}$/.test(expected)) return;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return;
  const digest = createHash("sha256").update(authorization).digest();
  if (timingSafeEqual(digest, Buffer.from(expected, "hex"))) return authorization;
}

/** Admit the SDK's one-image generation form. Edits, stored output and other clients keep their original route. */
export async function legacyBotsImageGeneration(request: Request): Promise<boolean> {
  if (Number(request.headers.get("content-length")) > maxBytes || !request.body) return false;
  const reader = request.clone().body!.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) return false;
      text += decoder.decode(value, { stream: true });
    }
    const value: unknown = JSON.parse(text + decoder.decode());
    return generation(value);
  } catch {
    return false;
  } finally {
    // The original stream is still owned by the caller until a shape is selected.
    void reader.cancel().catch(() => {});
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function generation(value: unknown) {
  if (!object(value) || Object.keys(value).some(key => !fields.has(key))) return false;
  const { prompt, context, subject, bucket, size, quality } = value;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > IMAGE_LIMITS.promptChars ||
      !object(context) || Object.keys(context).length !== 1 ||
      typeof context.bot !== "string" || !/^[a-z0-9_-]{1,80}$/.test(context.bot) ||
      !optionalChoice(IMAGE_SIZES, size) || !optionalChoice(IMAGE_QUALITIES, quality)) return false;
  // Production bot calls use bot:<bot>; preview calls use builder. Heal calls omit both.
  if (subject === undefined || bucket === undefined) return subject === undefined && bucket === undefined;
  return typeof subject === "string" && !!subject.trim() && subject.length <= 200 &&
    (bucket === `bot:${context.bot}` || bucket === "builder");
}

function optionalChoice(choices: readonly string[], value: unknown) {
  return value === undefined || typeof value === "string" && choices.includes(value);
}

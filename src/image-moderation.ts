import { z } from "@hono/zod-openapi";
import type { Outbound } from "./outbound.ts";
import { HttpError } from "./http.ts";
import { imageHeader, imageIntact } from "./image-header.ts";
import type { RateLimitState } from "./rate-limits.ts";

export const MODERATION_IMAGE_BYTES = 2 * 1024 * 1024;
export const MODERATION_TIMEOUT_MS = 4_000;
const categories = ["sexual", "sexual/minors", "harassment", "harassment/threatening", "hate", "hate/threatening",
  "illicit", "illicit/violent", "self-harm", "self-harm/intent", "self-harm/instructions", "violence", "violence/graphic"] as const;
const fields = <T extends z.ZodType>(type: T) => Object.fromEntries(categories.map(name => [name, type])) as Record<typeof categories[number], T>;
/** Keep applied input types: some categories (including sexual/minors) do not classify images. */
export const ImageModerationResult = z.object({
  id: z.string().min(1), model: z.string().min(1), flagged: z.boolean(),
  categories: z.object(fields(z.boolean())).catchall(z.boolean()),
  category_scores: z.object(fields(z.number().min(0).max(1))).catchall(z.number().min(0).max(1)),
  category_applied_input_types: z.object(fields(z.array(z.enum(["image", "text"])))).catchall(z.array(z.enum(["image", "text"]))),
}).openapi("ImageModerationResult");
export type ImageModerationResult = z.infer<typeof ImageModerationResult>;
export interface ImageModerationService {
  admit(tenant: string): Promise<RateLimitState | undefined>;
  check(bytes: Uint8Array, contentType: string, signal: AbortSignal): Promise<ImageModerationResult>;
}

/** One image, no stored input, no tenant URL or provider key, no retries that outlive the caller's deadline. */
export function imageModeration(options: {
  outbound: Pick<Outbound, "fetch">; key: () => string | undefined;
  admit: ImageModerationService["admit"]; endpoint?: string; timeoutMs?: number;
}): ImageModerationService {
  return {
    admit: options.admit,
    async check(bytes, contentType, callerSignal) {
      if (bytes.byteLength > MODERATION_IMAGE_BYTES) throw new HttpError(413, "An image may be at most 2 MiB");
      const header = imageHeader(Buffer.from(bytes));
      if (!["image/jpeg", "image/png"].includes(contentType) || header?.mimeType !== contentType || !header.width || !header.height
        || !imageIntact(Buffer.from(bytes), contentType)) throw new HttpError(415, "Send a complete JPEG or PNG image with its matching Content-Type");
      const key = options.key();
      if (!key) throw new HttpError(503, "Image moderation is not configured", "MODERATION_UNAVAILABLE");
      const deadline = AbortSignal.timeout(options.timeoutMs ?? MODERATION_TIMEOUT_MS);
      const signal = AbortSignal.any([callerSignal, deadline]);
      try {
        const response = await options.outbound.fetch(options.endpoint ?? "https://api.openai.com/v1/moderations", {
          method: "POST", headers: { "Content-Type": "application/json" }, secrets: { Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: "omni-moderation-latest", input: [{ type: "image_url", image_url: { url: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}` } }] }),
          signal, timeoutMs: options.timeoutMs ?? MODERATION_TIMEOUT_MS, maxBytes: 64 * 1024, maxRedirects: 0,
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error("Provider refused moderation"); }
        const body = await response.json() as { id?: unknown; model?: unknown; results?: unknown[] };
        if (!Array.isArray(body.results) || body.results.length !== 1) throw new Error("Missing moderation result");
        const parsed = ImageModerationResult.safeParse({ ...(body.results[0] as object), id: body.id, model: body.model });
        if (!parsed.success) throw new Error("Invalid moderation result");
        if (!Object.values(parsed.data.category_applied_input_types).some(types => types.includes("image"))) throw new Error("Image was not assessed");
        // A contradictory response is not a successful clean check.
        if (!parsed.data.flagged && Object.values(parsed.data.categories).some(Boolean)) throw new Error("Inconsistent moderation result");
        return parsed.data;
      } catch {
        // Never pass provider bodies, credentials or uploaded bytes into an error or log.
        if (deadline.aborted) throw new HttpError(504, "Image moderation timed out", "MODERATION_TIMEOUT");
        throw new HttpError(502, "The image could not be checked. Try again later", "MODERATION_FAILED");
      }
    },
  };
}

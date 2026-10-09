import { randomBytes } from "node:crypto";
import type { Outbound } from "./outbound.ts";
import type { UsageRecord } from "./client-sessions.ts";
import { HttpError } from "./http.ts";
import type { AgentIdentity } from "./identity.ts";
import { imageHeader } from "./image-header.ts";
import { FILE_LIMITS, IMAGE_LIMITS } from "./limits.ts";
import { MICROS } from "./pricing.ts";
import { safeError } from "./metrics.ts";
import type { ToolDefinition } from "./protocol.ts";
import type { McpResult } from "./mcp-results.ts";
import type { ToolFiles } from "./tool-files.ts";

/**
 * Images made from text, or edited from images given: for `POST /v1/images` (and the generate_image builtin).
 * A provider sits behind `ImageProvider`; OpenAI's is the one built in, on the tenant's OpenAI key as a model call
 * resolves it (its key scope's, its own, else the platform's, which a prepaid tenant pays for at the model's token
 * prices). Prompts and images are never written to a log: logs carry sizes, quality, tokens and timings.
 */
export const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export const IMAGE_QUALITIES = ["low", "medium", "high"] as const;
export const IMAGE_FORMATS = ["png", "jpeg", "webp"] as const;
export type ImageSize = typeof IMAGE_SIZES[number];
export type ImageQuality = typeof IMAGE_QUALITIES[number];
export type ImageFormat = typeof IMAGE_FORMATS[number];
export type ImageOptions = { size: ImageSize; quality: ImageQuality; format: ImageFormat; background?: "transparent" | "opaque"; count: number };
/** An image given to edit (or a mask), checked: its type and size from its header. */
export type InputImage = { bytes: Uint8Array; contentType: string; width: number; height: number };
/** What a provider made, and the tokens it billed: text and image tokens in, image tokens out. */
export type GeneratedImages = { images: { bytes: Uint8Array; contentType: string }[]; tokens: ImageTokens; model: string };
export type ImageTokens = { textInput: number; imageInput: number; output: number };
/**
 * A provider's key (and where it sends, when a key scope gives an address), as a model call's would be. The platform's
 * may instead be an Azure OpenAI deployment (azure-openai.ts): its address, the deployment it names as the model, its
 * key as `secrets` (headers sent only to its origin), and the platform's OpenAI key to fall back on (`fallback`) when it
 * fails for now (rate limited, down).
 */
export type ImageCredentials = {
  apiKey: string; baseUrl?: string; headers?: Record<string, string>;
  model?: string; query?: string; secrets?: Record<string, string>; via?: "azure"; fallback?: ImageCredentials;
};
/** Micro-USD per million tokens of each kind. */
export type ImagePrice = { textInput: number; imageInput: number; output: number };

export interface ImageProvider {
  /** The provider key it uses: PUT /v1/providers/<id>/key, as for that provider's models. */
  id: string;
  /** The one model it makes images with, priced at `Pricing.image`. */
  model: string;
  generate(request: { prompt: string; images: InputImage[]; mask?: InputImage; options: ImageOptions }, credentials: ImageCredentials, signal: AbortSignal): Promise<GeneratedImages>;
}

/** Why a provider made no image: 502 when it failed, 400 when it refused the request (IMAGE_REFUSED when its safety system did). */
export class ImageFailed extends HttpError {
  /** It may succeed elsewhere or later: rate limited, the provider down or unreachable. */
  transient = false;
  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) { super(status, message, code ?? (status === 502 ? "IMAGE_FAILED" : undefined), details); }
}
const transient = (error: ImageFailed) => Object.assign(error, { transient: true });

/** Azure's content filter's categories that filtered (`content_filter_results`: {hate: {filtered, severity}, …}). */
function filtered(results: unknown): string[] {
  if (!results || typeof results !== "object") return [];
  return Object.entries(results as Record<string, any>).filter(([, result]) => result?.filtered === true).map(([name]) => name).slice(0, 10);
}
/**
 * A safety refusal, as OpenAI (`moderation_blocked`, with `moderation_details`) or Azure's content filter (`contentFilter`,
 * `content_policy_violation`, or an inner `ResponsibleAIPolicyViolation`, with `content_filter_results`) says it: its stage
 * and categories, or undefined when the error is not one.
 */
export function safetyRefusal(error: any): { stage?: "input" | "output"; categories: string[] } | undefined {
  if (!error || typeof error !== "object") return undefined;
  if (error.code === "moderation_blocked") {
    const stage = ["input", "output"].includes(error.moderation_details?.moderation_stage) ? error.moderation_details.moderation_stage : undefined;
    const categories = Array.isArray(error.moderation_details?.categories) ? (error.moderation_details.categories as unknown[]).filter((value): value is string => typeof value === "string").slice(0, 10) : [];
    return { ...(stage ? { stage } : {}), categories };
  }
  const inner = error.inner_error ?? error.innererror;
  if (["contentFilter", "content_filter", "content_policy_violation"].includes(error.code) || inner?.code === "ResponsibleAIPolicyViolation") {
    // Azure filters the prompt (and images given) before the model runs.
    return { stage: "input", categories: filtered(inner?.content_filter_results ?? error.content_filter_results) };
  }
  return undefined;
}

/** The model images are made with: OpenAI's fast everyday image model, billed per token. */
export const IMAGE_MODEL = "gpt-image-2.5-flare";

/**
 * Image tokens OpenAI bills for one output image, by size and quality (measured on gpt-image-2.5-flare): what a request
 * is estimated at before it is sent. The cost charged is what the provider reports.
 */
export const OUTPUT_TOKENS: Record<ImageSize, Record<ImageQuality, number>> = {
  "1024x1024": { low: 196, medium: 439, high: 1756 },
  "1536x1024": { low: 158, medium: 343, high: 1372 },
  "1024x1536": { low: 158, medium: 343, high: 1372 },
};
/** Image tokens one input image is estimated at: OpenAI bills 1,024 for a square one and 1,536 for a wide one; a margin above. */
const INPUT_IMAGE_TOKENS = 2_048;

const CONTENT_TYPES: Record<ImageFormat, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/**
 * OpenAI's images API with `gpt-image-2.5-flare`: generations from a prompt, edits (multipart) when images are given.
 * Its safety system's refusals (`moderation_blocked`) are IMAGE_REFUSED, with the stage and categories it names.
 */
export function openaiImages(options: { outbound: Outbound; baseUrl?: string; timeoutMs?: number }): ImageProvider {
  const { outbound, baseUrl = "https://api.openai.com/v1", timeoutMs = IMAGE_LIMITS.timeoutMs } = options;
  return {
    id: "openai",
    model: IMAGE_MODEL,
    async generate({ prompt, images, mask, options: asked }, credentials, signal) {
      const provider = credentials.via === "azure" ? "Azure OpenAI" : "OpenAI";
      const fields: Record<string, string> = {
        model: credentials.model ?? IMAGE_MODEL, prompt, size: asked.size, quality: asked.quality, output_format: asked.format, n: String(asked.count),
        ...(asked.background ? { background: asked.background } : {}),
      };
      const root = (credentials.baseUrl ?? baseUrl).replace(/\/+$/, "");
      let body: Buffer<ArrayBuffer> | string, contentType: string, url: string;
      if (images.length) {
        const form = new FormData();
        for (const [name, value] of Object.entries(fields)) form.set(name, value);
        images.forEach((image, index) => form.append("image[]", new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.contentType }), `image-${index + 1}.${EXTENSIONS[image.contentType]}`));
        if (mask) form.set("mask", new Blob([mask.bytes as Uint8Array<ArrayBuffer>], { type: mask.contentType }), `mask.${EXTENSIONS[mask.contentType]}`);
        // Encoded here: the guarded fetch is undici's own, which takes this runtime's FormData as an opaque object.
        const encoded = new Response(form);
        body = Buffer.from(await encoded.arrayBuffer());
        contentType = encoded.headers.get("content-type")!;
        url = `${root}/images/edits${credentials.query ? `?${credentials.query}` : ""}`;
      } else {
        body = JSON.stringify({ ...fields, n: asked.count });
        contentType = "application/json";
        url = `${root}/images/generations${credentials.query ? `?${credentials.query}` : ""}`;
      }
      let response: Response;
      try {
        response = await outbound.fetch(url, {
          method: "POST", body, headers: { Accept: "application/json", ...credentials.headers, "Content-Type": contentType },
          secrets: credentials.secrets ?? (credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {}), timeoutMs, maxBytes: IMAGE_LIMITS.responseBytes, signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw transient(new ImageFailed(502, `${provider} could not be reached to make the image (${safeError(error)})`));
      }
      const refused = (refusal: { stage?: "input" | "output"; categories: string[] }) => new ImageFailed(400,
        `${provider}'s safety system refused ${refusal.stage === "output" ? "the image it made" : "this request"}${refusal.categories.length ? ` (${refusal.categories.join(", ")})` : ""}`,
        "IMAGE_REFUSED", { ...(refusal.stage ? { stage: refusal.stage } : {}), categories: refusal.categories });
      if (!response.ok) {
        const error: any = await response.json().then((body: any) => body?.error, () => undefined);
        const status = response.status;
        // What the safety system names: the stage (the prompt or input images, or the image made) and categories, never the prompt.
        const refusal = safetyRefusal(error);
        if (refusal) throw refused(refusal);
        // The error message names the parameter at fault (never the prompt).
        const detail = typeof error?.message === "string" ? error.message.slice(0, 300) : "";
        if (status === 401 || status === 403) throw new ImageFailed(502, `${provider} rejected the API key (HTTP ${status})`);
        // Azure's deployment missing (renamed, or still being made) is the operator's to fix; meanwhile OpenAI serves.
        if (status === 404 && credentials.via === "azure") throw transient(new ImageFailed(502, `${provider} has no such deployment (HTTP 404)`));
        if (status === 400 || status === 413 || status === 415) throw new ImageFailed(400, `${provider} could not make the image (HTTP ${status}${detail ? `: ${detail}` : ""})`);
        const failed = new ImageFailed(502, `${provider} failed to make the image (HTTP ${status})`);
        throw status === 408 || status === 429 || status >= 500 ? transient(failed) : failed;
      }
      const answer: any = await response.json().catch(() => undefined);
      const data: unknown[] = Array.isArray(answer?.data) ? answer.data : [];
      const made = data.flatMap((entry: any) => typeof entry?.b64_json === "string" ? [Buffer.from(entry.b64_json, "base64")] : []);
      // Azure filters the image made out of the answer, saying why beside it.
      const withheld = data.flatMap((entry: any) => typeof entry?.b64_json !== "string" ? filtered(entry?.content_filter_results) : []);
      if (!made.length && withheld.length) throw refused({ stage: "output", categories: [...new Set(withheld)] });
      if (!made.length) throw new ImageFailed(502, `${provider} answered without an image`);
      const usage = answer.usage ?? {};
      const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
      const textInput = count(usage.input_tokens_details?.text_tokens), imageInput = count(usage.input_tokens_details?.image_tokens);
      const tokens = {
        // Without a breakdown, every input token is text.
        textInput: textInput || imageInput ? textInput : count(usage.input_tokens), imageInput,
        // What OpenAI bills; the estimate when it says nothing.
        output: count(usage.output_tokens) || OUTPUT_TOKENS[asked.size][asked.quality] * made.length,
      };
      return { images: made.map(bytes => ({ bytes, contentType: imageHeader(bytes)?.mimeType ?? CONTENT_TYPES[asked.format] })), tokens, model: IMAGE_MODEL };
    },
  };
}

/** An image given to edit, checked: PNG, JPEG or WebP, within the limits. */
export function checkedImage(bytes: Uint8Array, name = "The image"): InputImage {
  if (bytes.length > IMAGE_LIMITS.inputBytes) throw new HttpError(413, `${name} is larger than ${IMAGE_LIMITS.inputBytes} bytes, the most an image to edit may be`, "IMAGE_TOO_LARGE");
  const header = imageHeader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (!header || !Object.values(CONTENT_TYPES).includes(header.mimeType)) throw new HttpError(415, `${name} is not an image to edit: send PNG, JPEG or WebP`, "UNSUPPORTED_IMAGE");
  if (header.width > IMAGE_LIMITS.inputSide || header.height > IMAGE_LIMITS.inputSide) throw new HttpError(413, `${name} is ${header.width}x${header.height}; an image to edit is at most ${IMAGE_LIMITS.inputSide} pixels a side`, "IMAGE_TOO_LARGE");
  return { bytes, contentType: header.mimeType, width: header.width, height: header.height };
}

/** Options as asked (strings from a form or JSON), checked, with their defaults: medium quality, a square PNG, one image. */
export function imageOptions(input: { size?: unknown; quality?: unknown; format?: unknown; background?: unknown; n?: unknown }, maxCount: number = IMAGE_LIMITS.count): ImageOptions {
  const pick = <T extends string>(name: string, value: unknown, choices: readonly T[], fallback: T): T => {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value !== "string" || !choices.includes(value as T)) throw new HttpError(400, `${name} is one of ${choices.join(", ")}`);
    return value as T;
  };
  const format = pick("format", input.format, IMAGE_FORMATS, "png");
  const background = input.background === undefined || input.background === null || input.background === "" ? undefined : pick("background", input.background, ["transparent", "opaque"] as const, "opaque");
  if (background === "transparent" && format === "jpeg") throw new HttpError(400, "A transparent background needs format png or webp");
  const count = input.n === undefined || input.n === null || input.n === "" ? 1 : Number(input.n);
  if (!Number.isInteger(count) || count < 1 || count > maxCount) throw new HttpError(400, `n is a whole number from 1 to ${maxCount}`);
  return { size: pick("size", input.size, IMAGE_SIZES, "1024x1024"), quality: pick("quality", input.quality, IMAGE_QUALITIES, "medium"), format, ...(background ? { background } : {}), count };
}

export interface ImagerOptions {
  provider: ImageProvider;
  /** The provider's key for a tenant (in a key scope), and whether it is the platform's; throws when the tenant may not use it (spent credit). */
  key(tenant: string, keyScope: string | undefined, provider: string): Promise<(ImageCredentials & { platform: boolean }) | undefined>;
  /** Micro-USD per million tokens. */
  price(): ImagePrice;
}

/** Images made and what they cost, for usage records. */
export type Generated = { generated: GeneratedImages; usage: UsageRecord };

export class Imager {
  readonly options: ImagerOptions;
  constructor(options: ImagerOptions) { this.options = options; }

  get provider() { return this.options.provider.id; }

  /** What `tokens` cost (USD), at the price per million tokens of each kind. */
  cost(tokens: ImageTokens) {
    const price = this.options.price();
    return (tokens.textInput * price.textInput + tokens.imageInput * price.imageInput + tokens.output * price.output) / 1e6 / MICROS;
  }

  /** What a request is estimated to cost (USD) before it is sent: its prompt, its input images and its images out, at their most. */
  estimate(prompt: string, inputs: number, options: ImageOptions) {
    return this.cost({ textInput: Math.ceil(prompt.length / 2), imageInput: inputs * INPUT_IMAGE_TOKENS, output: OUTPUT_TOKENS[options.size][options.quality] * options.count });
  }

  /**
   * Make images for a tenant: its usage record (cost in `usage.cost.total`, `platform` when it ran on the platform's
   * key) is the caller's to record, with the run's facts. `budget` (USD), when given, is checked against the estimate
   * before anything is sent.
   */
  async generate(context: { tenant: string; keyScope?: string; budget?: number }, request: { prompt: string; images: InputImage[]; mask?: InputImage; options: ImageOptions }, signal: AbortSignal): Promise<Generated> {
    const { provider } = this.options;
    const key = await this.options.key(context.tenant, context.keyScope, provider.id);
    if (!key) throw new HttpError(400, `Image generation needs an OpenAI key: add one under Models & keys (PUT /v1/providers/${provider.id}/key)${context.keyScope ? `, or to key scope ${context.keyScope}` : ""}`, "IMAGE_UNAVAILABLE");
    const estimate = this.estimate(request.prompt, request.images.length + (request.mask ? 1 : 0), request.options);
    if (context.budget !== undefined && estimate > context.budget) throw new HttpError(402, `Making this image costs about $${estimate.toFixed(4)}, more than the $${Math.max(0, context.budget).toFixed(4)} left of this run's spend limit`, "SPEND_LIMIT");
    const { platform, ...credentials } = key;
    const started = Date.now();
    let via = credentials.via;
    const generated = await provider.generate(request, credentials, signal).catch(error => {
      // The platform's Azure deployment rate limited or down: the platform's OpenAI key instead.
      if (!(error instanceof ImageFailed && error.transient && credentials.fallback) || signal.aborted) throw error;
      console.error(JSON.stringify({ type: "images_fallback", tenant: context.tenant, via: credentials.via ?? provider.id, error: safeError(error) }));
      via = credentials.fallback.via;
      return provider.generate(request, credentials.fallback, signal);
    });
    const usd = this.cost(generated.tokens);
    const { options } = request;
    console.log(JSON.stringify({ type: "images_generated", tenant: context.tenant, provider: provider.id, ...(via ? { via } : {}), model: generated.model, size: options.size, quality: options.quality, format: options.format, images: generated.images.length, inputs: request.images.length, ...generated.tokens, bytes: generated.images.reduce((sum, image) => sum + image.bytes.length, 0), ms: Date.now() - started }));
    return {
      generated,
      usage: {
        provider: provider.id, model: generated.model, platform, kind: "image", images: generated.images.length, timestamp: Date.now(),
        usage: { input: generated.tokens.textInput + generated.tokens.imageInput, output: generated.tokens.output, cost: { total: usd } },
      },
    };
  }
}

/** An image as given to `POST /v1/images`: its bytes, or a URL to fetch them from. */
export type ImageSource = { bytes: Uint8Array } | { url: string };

/** What `POST /v1/images` is asked: a prompt, images to edit (if any), how to make it, and where to save it (if anywhere). */
export type ImageRequest = {
  prompt: string;
  images?: ImageSource[];
  mask?: ImageSource;
  options: ImageOptions;
  keyScope?: string;
  /** A volume of the tenant's to save the images into, under `path` (a directory), instead of answering their bytes. */
  volume?: { id: string; path: string };
  /** Who it is for and who asked, as an agent's identity and a run's actor say (`usage.recorded`'s subject, context and actor). */
  identity?: AgentIdentity; actor?: string;
};

export interface ImageService {
  imager: Imager;
  /** Fetches images given by URL: the public internet only. */
  outbound: Outbound;
  /** Refuses a tenant that may not make images now (runs per minute, a monthly cap, spent credit); throws. */
  admit(tenant: string): Promise<void>;
  /** Records the images' usage, as a model response's is (billing, usage.recorded). */
  record(tenant: string, usage: UsageRecord): void;
  /** Whether the tenant owns the volume; without it, images are not saved to volumes. */
  owns?(tenant: string, volume: string): Promise<boolean>;
  /** Saves an image to a volume of the tenant's. */
  save?(tenant: string, volume: string, path: string, bytes: Uint8Array, contentType: string): Promise<{ path: string; size: number; version: number; contentType?: string }>;
}

/** Images asked for alone (`POST /v1/images`): answered as base64, or saved to a volume of the tenant's; nothing else is kept. */
export async function imageRequest(service: ImageService, tenant: string, request: ImageRequest, signal: AbortSignal) {
  const sources = request.images ?? [];
  if (sources.length > IMAGE_LIMITS.inputs) throw new HttpError(400, `Send at most ${IMAGE_LIMITS.inputs} images to edit`);
  if (request.mask && !sources.length) throw new HttpError(400, "A mask needs an image to edit");
  if (request.volume && !service.save) throw new HttpError(404, "Volumes are not enabled on this runtime");
  if (request.volume && !await service.owns!(tenant, request.volume.id)) throw new HttpError(404, "Unknown volume");
  await service.admit(tenant);
  let total = 0;
  const read = async (source: ImageSource, name: string) => {
    const bytes = "bytes" in source ? source.bytes : await fetchImage(service.outbound, source.url, signal);
    total += bytes.length;
    if (total > IMAGE_LIMITS.inputTotalBytes) throw new HttpError(413, `The images to edit are larger than ${IMAGE_LIMITS.inputTotalBytes} bytes in all`, "IMAGE_TOO_LARGE");
    return checkedImage(bytes, name);
  };
  const images: InputImage[] = [];
  for (const [index, source] of sources.entries()) images.push(await read(source, sources.length > 1 ? `Image ${index + 1}` : "The image"));
  const mask = request.mask ? await read(request.mask, "The mask") : undefined;
  // OpenAI's rule: a mask with an alpha channel, in the format and size of the (first) image it masks.
  if (mask && (mask.contentType === "image/jpeg" || mask.contentType !== images[0]!.contentType || mask.width !== images[0]!.width || mask.height !== images[0]!.height)) {
    throw new HttpError(400, `The mask is an image with an alpha channel (PNG or WebP) in the format and size of the first image (${images[0]!.contentType}, ${images[0]!.width}x${images[0]!.height})`);
  }
  const { generated, usage } = await service.imager.generate({ tenant, ...(request.keyScope ? { keyScope: request.keyScope } : {}) }, { prompt: request.prompt, images, ...(mask ? { mask } : {}), options: request.options }, signal);
  service.record(tenant, { ...usage, ...(request.actor ? { actor: request.actor } : {}), ...(request.identity ? { identity: request.identity } : {}), ...(request.keyScope ? { keyScope: request.keyScope } : {}) });
  const volume = request.volume;
  const stamp = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const answered = await Promise.all(generated.images.map(async (image, index) => {
    const size = imageHeader(Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength));
    const facts = { contentType: image.contentType, ...(size ? { width: size.width, height: size.height } : {}) };
    if (!volume) return { ...facts, data: Buffer.from(image.bytes).toString("base64") };
    const path = `${volume.path.replace(/\/+$/, "")}/image-${stamp}${generated.images.length > 1 ? `-${index + 1}` : ""}.${EXTENSIONS[image.contentType] ?? "png"}`;
    const saved = await service.save!(tenant, volume.id, path, image.bytes, image.contentType);
    return { ...facts, volumeId: volume.id, path: saved.path, size: saved.size, version: saved.version };
  }));
  return {
    images: answered, model: `${service.imager.provider}/${generated.model}`,
    usage: { inputTokens: generated.tokens.textInput + generated.tokens.imageInput, outputTokens: generated.tokens.output },
    costUsd: usage.usage.cost.total as number,
  };
}

/** An image from a URL, through the outbound guard, at most IMAGE_LIMITS.inputBytes. */
async function fetchImage(outbound: Outbound, url: string, signal: AbortSignal): Promise<Uint8Array> {
  let address: URL;
  try { address = new URL(url); } catch { throw new HttpError(400, "url must be an absolute https URL"); }
  const where = `${address.origin}${address.pathname}`;
  try {
    const response = await outbound.fetch(address, { signal, timeoutMs: FILE_LIMITS.urlMs, maxBytes: IMAGE_LIMITS.inputBytes, maxRedirects: FILE_LIMITS.urlRedirects });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(400, `Could not fetch ${where} (HTTP ${response.status})`); }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof HttpError || signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/larger than/.test(message)) throw new HttpError(413, `${where} is larger than ${IMAGE_LIMITS.inputBytes} bytes, the most an image to edit may be`, "IMAGE_TOO_LARGE");
    throw new HttpError(400, `Could not fetch ${where} (${message.slice(0, 200)})`);
  }
}

/** The generate_image builtin: an image made (or edited from images in the agent's mounts), saved to its workspace. */
export const GENERATE_IMAGE: ToolDefinition = {
  name: "generate_image", exposure: "both",
  description: `Make an image from a prompt, or edit images from your files (images: their paths, at most ${IMAGE_LIMITS.inputs}; PNG, JPEG or WebP). The image is saved to your workspace and its path returned, and you are shown it. To show it to the user, present it with present_file. Each image costs money (about $0.013 at medium quality, $0.05 at high): make the images asked for, not variations nobody asked for.`,
  parameters: { type: "object", additionalProperties: false, required: ["prompt"], properties: {
    prompt: { type: "string", minLength: 1, maxLength: IMAGE_LIMITS.promptChars, description: "What to make, or how to change or combine the images given: subject, style, composition, any text it shows" },
    images: { type: "array", maxItems: IMAGE_LIMITS.inputs, items: { type: "string" }, description: "Paths of images to edit or combine" },
    size: { type: "string", enum: [...IMAGE_SIZES], description: "Square (default), landscape (1536x1024) or portrait (1024x1536)" },
    quality: { type: "string", enum: [...IMAGE_QUALITIES], description: "Default medium; high for detailed or final images" },
    format: { type: "string", enum: [...IMAGE_FORMATS], description: "Default png" },
    background: { type: "string", enum: ["transparent", "opaque"], description: "transparent for a cut-out (png or webp)" },
  } },
};

/**
 * A generate_image call: its arguments checked, its input images read from the agent's mounts (`files`), one image made
 * within `budget` (USD, when the run or agent has a limit) and saved to the workspace. The model gets the image's file
 * reference (so it sees it). `record` takes its usage as soon as it is made, so it is billed even if it cannot be saved.
 */
export async function generateImage(imager: Imager, context: { tenant: string; keyScope?: string; budget?: number; files: ToolFiles; record(usage: UsageRecord): void }, args: Record<string, unknown>, signal: AbortSignal): Promise<McpResult> {
  const prompt = args.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) throw new HttpError(400, "Give the prompt: what to make");
  if (prompt.length > IMAGE_LIMITS.promptChars) throw new HttpError(400, `The prompt is at most ${IMAGE_LIMITS.promptChars} characters`);
  const paths = args.images === undefined ? [] : args.images;
  if (!Array.isArray(paths) || paths.some(path => typeof path !== "string")) throw new HttpError(400, "images is a list of paths of images in your files");
  if (paths.length > IMAGE_LIMITS.inputs) throw new HttpError(400, `Give at most ${IMAGE_LIMITS.inputs} images to edit`);
  const options = imageOptions({ size: args.size, quality: args.quality, format: args.format, background: args.background }, 1);
  const images: InputImage[] = [];
  let total = 0;
  for (const path of paths as string[]) {
    const bytes = await context.files.read(path, IMAGE_LIMITS.inputBytes);
    total += bytes.length;
    if (total > IMAGE_LIMITS.inputTotalBytes) throw new HttpError(413, `The images to edit are larger than ${IMAGE_LIMITS.inputTotalBytes} bytes in all`, "IMAGE_TOO_LARGE");
    images.push(checkedImage(bytes, path));
  }
  const { generated, usage } = await imager.generate({ tenant: context.tenant, ...(context.keyScope ? { keyScope: context.keyScope } : {}), ...(context.budget !== undefined ? { budget: context.budget } : {}) }, { prompt, images, options }, signal);
  context.record(usage);
  const image = generated.images[0]!;
  const size = imageHeader(Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength));
  const saved = await context.files.save(`image.${EXTENSIONS[image.contentType] ?? "png"}`, image.bytes, image.contentType)
    .catch(error => { throw new Error(`The image was made but could not be saved: ${(error as Error).message}`); });
  const value = { path: saved.path, contentType: saved.contentType, ...(size ? { width: size.width, height: size.height } : {}), size: saved.size, costUsd: usage.usage.cost.total as number };
  return { content: [{ type: "text", text: JSON.stringify(value) }, saved], structuredContent: value };
}

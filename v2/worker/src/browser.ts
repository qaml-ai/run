import { Buffer } from "node:buffer";
import { fetchWithoutRedirects, type Fetcher as RedirectSafeFetcher } from "./lib/no-redirect.ts";
import { imageHeader, imageIntact } from "./lib/image-header.ts";
import { FILE_LIMITS } from "./lib/limits.ts";
import { ApiError, type Env, type LlmToolSchema } from "./types.ts";

export type BrowserEngine = "kitesurf" | "chromium";
export type BrowserExtractMode = "scrape" | "links" | "content" | "accessibilityTree";
export type BrowserScreenshotFormat = "png" | "jpeg" | "webp";
export type BrowserWaitUntil = BrowserRunLifecycleEvent;

export type BrowserEnv = Pick<
  Env,
  | "BROWSER"
  | "BROWSER_DEFAULT_ENGINE"
  | "CLOUDFLARE_ACCOUNT_ID"
  | "CLOUDFLARE_BROWSER_RUN_TOKEN"
  | "CLOUDFLARE_API_TOKEN"
  | "CLOUDFLARE_BROWSER_RUN_BASE_URL"
>;

export class BrowserBlockedUrlError extends ApiError {
  constructor(message: string) {
    super(400, "browser_url_blocked", message);
    this.name = "BrowserBlockedUrlError";
  }
}

export const BROWSER_LIMITS = Object.freeze({
  maxUrlLength: 4096,
  defaultTimeoutMs: 30_000,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 60_000,
  defaultViewport: Object.freeze({ width: 1280, height: 720 }),
  minViewportDim: 320,
  maxViewportDim: 2560,
  defaultMaxChars: 32_000,
  minMaxChars: 200,
  maxMaxChars: 200_000,
  maxSelectors: 20,
  maxLinks: 500,
  maxScreenshotBytes: 15 * 1024 * 1024,
});

const DEFAULT_CF_API_BASE = "https://api.cloudflare.com/client/v4";

const VALID_WAIT_UNTIL = new Set<BrowserWaitUntil>([
  "load",
  "domcontentloaded",
  "networkidle0",
  "networkidle2",
]);

const VALID_SNAPSHOT_FORMATS = new Set<BrowserRunSnapshotFormat>([
  "content",
  "screenshot",
  "markdown",
  "accessibilityTree",
]);

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.goog",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
  ".home.arpa",
];

// Same blocked ranges as src/outbound.ts (private, loopback, CGNAT, link-local / cloud metadata,
// documentation, benchmarking, multicast, reserved).
const BLOCKED_V4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const;

const BLOCKED_V6_CIDRS = [
  "::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/32",
  "2001:db8::/32",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
] as const;

interface CidrRange {
  bytes: Uint8Array;
  prefix: number;
}

function parseIpv4Bytes(text: string): Uint8Array | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const n = Number(part);
    if (n < 0 || n > 255) return undefined;
    out[i] = n;
  }
  return out;
}

function parseIpv6Bytes(raw: string): Uint8Array | undefined {
  if (!raw.includes(":")) return undefined;
  let text = raw.toLowerCase().split("%")[0];
  if (!text) return undefined;

  let tail: number[] = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = parseIpv4Bytes(dotted[2]);
    if (!v4) return undefined;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = dotted[1].endsWith("::") ? dotted[1] : dotted[1].slice(0, -1);
  }

  const halves = text.split("::");
  if (halves.length > 2) return undefined;

  const parseGroups = (part: string | undefined): number[] | undefined => {
    if (!part) return [];
    const groups = part.split(":");
    const nums: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
      nums.push(parseInt(g, 16));
    }
    return nums;
  };

  const left = parseGroups(halves[0]);
  const right = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!left || !right) return undefined;

  const missing = 8 - left.length - right.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;

  const all = [...left, ...Array<number>(Math.max(0, missing)).fill(0), ...right, ...tail];
  if (all.length !== 8) return undefined;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = all[i] >> 8;
    bytes[i * 2 + 1] = all[i] & 0xff;
  }
  return bytes;
}

export function parseIpBytes(address: string): Uint8Array | undefined {
  return parseIpv4Bytes(address) ?? parseIpv6Bytes(address);
}

function compileCidr(spec: string): CidrRange {
  const [addr, bits] = spec.split("/");
  const bytes = parseIpBytes(addr);
  const prefix = Number(bits);
  if (!bytes || !Number.isInteger(prefix) || prefix < 0 || prefix > bytes.length * 8) {
    throw new Error(`Invalid CIDR range: ${spec}`);
  }
  return { bytes, prefix };
}

function inCidr(bytes: Uint8Array, range: CidrRange): boolean {
  if (bytes.length !== range.bytes.length) return false;
  for (let bit = 0; bit < range.prefix; bit += 8) {
    const mask = range.prefix - bit >= 8 ? 0xff : (0xff << (8 - (range.prefix - bit))) & 0xff;
    if ((bytes[bit / 8] & mask) !== (range.bytes[bit / 8] & mask)) return false;
  }
  return true;
}

const BUILTIN_BLOCKED_CIDRS = [...BLOCKED_V4_CIDRS, ...BLOCKED_V6_CIDRS].map(compileCidr);
const IPV4_MAPPED_V6 = compileCidr("::ffff:0:0/96");
const NAT64_WELL_KNOWN = compileCidr("64:ff9b::/96");
const SIX_TO_FOUR = compileCidr("2002::/16");

function isBlockedIpBytes(bytes: Uint8Array): boolean {
  if (BUILTIN_BLOCKED_CIDRS.some((range) => inCidr(bytes, range))) return true;
  if (bytes.length === 16) {
    if (inCidr(bytes, IPV4_MAPPED_V6) || inCidr(bytes, NAT64_WELL_KNOWN)) {
      return isBlockedIpBytes(bytes.slice(12));
    }
    if (inCidr(bytes, SIX_TO_FOUR)) {
      return isBlockedIpBytes(bytes.slice(2, 6));
    }
  }
  return false;
}

/**
 * Validates that a URL is safe to hand to Cloudflare Browser Run:
 * - http:// or https:// only (no file:, data:, javascript:, chrome:, ftp:, etc.)
 * - No embedded credentials
 * - Not localhost, internal/local suffixes, single-label hostnames, or private/loopback/link-local/metadata IP literals
 */
export function assertSafeBrowserUrl(rawUrl: unknown): URL {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new BrowserBlockedUrlError("Browser URL must be a non-empty string");
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length > BROWSER_LIMITS.maxUrlLength) {
    throw new BrowserBlockedUrlError(`Browser URL exceeds ${BROWSER_LIMITS.maxUrlLength} characters`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BrowserBlockedUrlError(`Invalid browser URL: ${trimmed.slice(0, 120)}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrowserBlockedUrlError(`Only http:// and https:// URLs are allowed (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new BrowserBlockedUrlError("Browser URLs may not contain credentials");
  }

  const rawHost = parsed.hostname;
  if (!rawHost) {
    throw new BrowserBlockedUrlError("Browser URL is missing a hostname");
  }

  // Strip IPv6 brackets and trailing FQDN dots.
  const host = rawHost.replace(/^\[(.*)\]$/, "$1").replace(/\.+$/, "").toLowerCase();
  if (!host) {
    throw new BrowserBlockedUrlError("Browser URL hostname is empty");
  }

  // Check IP literals (WHATWG URL has already canonicalized decimal/octal/hex/short IPv4 spellings).
  const ipBytes = parseIpBytes(host);
  if (ipBytes) {
    if (isBlockedIpBytes(ipBytes)) {
      throw new BrowserBlockedUrlError(`Blocked private, loopback, link-local, or reserved IP address: ${host}`);
    }
    return parsed;
  }

  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new BrowserBlockedUrlError(`Blocked internal or local hostname: ${host}`);
  }

  // Reject single-label non-IP hostnames (e.g. "http://redis/", "http://camelfsd:8790/").
  if (!host.includes(".")) {
    throw new BrowserBlockedUrlError(`Blocked non-public hostname: ${host}`);
  }

  return parsed;
}

export function resolveBrowserEngine(
  requested: unknown,
  env?: Pick<BrowserEnv, "BROWSER_DEFAULT_ENGINE">,
): BrowserEngine {
  if (requested === undefined || requested === null || requested === "") {
    const envDefault = env?.BROWSER_DEFAULT_ENGINE?.trim().toLowerCase();
    if (envDefault === "chromium") return "chromium";
    return "kitesurf";
  }
  if (requested === "kitesurf" || requested === "chromium") {
    return requested;
  }
  throw new ApiError(400, "invalid_browser_engine", `Invalid browser engine '${String(requested)}': expected "kitesurf" or "chromium"`);
}

export interface BrowserCommonInput {
  url: string;
  engine?: BrowserEngine;
  waitUntil?: BrowserWaitUntil;
  waitForSelector?: string;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
}

export interface BrowserMarkdownInput extends BrowserCommonInput {
  maxChars?: number;
}

export interface BrowserScreenshotInput extends BrowserCommonInput {
  fullPage?: boolean;
  selector?: string;
  format?: BrowserScreenshotFormat;
  quality?: number;
}

export interface BrowserSnapshotInput extends BrowserCommonInput {
  formats?: BrowserRunSnapshotFormat[];
  fullPage?: boolean;
  format?: BrowserScreenshotFormat;
  maxChars?: number;
}

export interface BrowserExtractInput extends BrowserCommonInput {
  mode?: BrowserExtractMode;
  selectors?: string[];
  visibleLinksOnly?: boolean;
  excludeExternalLinks?: boolean;
  root?: string;
  interestingOnly?: boolean;
  maxChars?: number;
}

export interface BrowserMarkdownResult {
  url: string;
  finalUrl?: string;
  title?: string;
  status?: number;
  engine: BrowserEngine;
  markdown: string;
  truncated: boolean;
  browserMsUsed?: number;
}

export interface BrowserScreenshotResult {
  url: string;
  engine: BrowserEngine;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  size: number;
  base64: string;
  browserMsUsed?: number;
}

export interface BrowserSnapshotResult {
  url: string;
  finalUrl?: string;
  title?: string;
  status?: number;
  engine: BrowserEngine;
  formats: BrowserRunSnapshotFormat[];
  markdown?: string;
  markdownTruncated?: boolean;
  content?: string;
  contentTruncated?: boolean;
  accessibilityTree?: BrowserRunSerializedAXNode | null;
  screenshot?: {
    contentType: "image/png" | "image/jpeg" | "image/webp";
    width: number;
    height: number;
    size: number;
    base64: string;
  };
  browserMsUsed?: number;
}

export interface BrowserExtractResult {
  url: string;
  finalUrl?: string;
  title?: string;
  status?: number;
  engine: BrowserEngine;
  mode: BrowserExtractMode;
  data: unknown;
  truncated?: boolean;
  browserMsUsed?: number;
}

export interface BrowserCallOptions {
  signal?: AbortSignal;
  fetchFn?: RedirectSafeFetcher;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function buildCommonPayload(input: BrowserCommonInput, safeUrl: URL): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    url: safeUrl.toString(),
  };

  const timeout = clampNumber(
    input.timeoutMs,
    BROWSER_LIMITS.defaultTimeoutMs,
    BROWSER_LIMITS.minTimeoutMs,
    BROWSER_LIMITS.maxTimeoutMs,
  );
  const waitUntil =
    typeof input.waitUntil === "string" && VALID_WAIT_UNTIL.has(input.waitUntil as BrowserWaitUntil)
      ? (input.waitUntil as BrowserWaitUntil)
      : undefined;

  if (waitUntil || input.timeoutMs !== undefined) {
    payload.gotoOptions = {
      ...(waitUntil ? { waitUntil } : {}),
      timeout,
    };
  }

  if (typeof input.waitForSelector === "string" && input.waitForSelector.trim()) {
    payload.waitForSelector = {
      selector: input.waitForSelector.trim(),
      timeout: Math.min(timeout, 30_000),
    };
  }

  if (input.viewport && typeof input.viewport === "object") {
    const width = clampNumber(
      input.viewport.width,
      BROWSER_LIMITS.defaultViewport.width,
      BROWSER_LIMITS.minViewportDim,
      BROWSER_LIMITS.maxViewportDim,
    );
    const height = clampNumber(
      input.viewport.height,
      BROWSER_LIMITS.defaultViewport.height,
      BROWSER_LIMITS.minViewportDim,
      BROWSER_LIMITS.maxViewportDim,
    );
    payload.viewport = { width, height };
  }

  return payload;
}

function parseBrowserMsUsed(response: Response): number | undefined {
  const raw = response.headers.get("x-browser-ms-used");
  if (!raw) return undefined;
  const num = Number(raw);
  return Number.isFinite(num) && num >= 0 ? num : undefined;
}

function extractCloudflareErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const errBody = body as Partial<BrowserRunErrorResponse> & { error?: { message?: string } };
    if (Array.isArray(errBody.errors) && errBody.errors.length > 0) {
      const parts = errBody.errors
        .map((e) => {
          const code = e.code !== undefined ? `[${e.code}] ` : "";
          const detail = e.detail ? ` (${e.detail})` : "";
          return `${code}${e.message || "Browser Run error"}${detail}`;
        })
        .filter(Boolean);
      if (parts.length > 0) return parts.join("; ");
    }
    if (typeof errBody.error?.message === "string" && errBody.error.message) {
      return errBody.error.message;
    }
  }
  return `Cloudflare Browser Run returned HTTP ${status}`;
}

async function throwForFailedResponse(response: Response, action: string): Promise<never> {
  const text = await response.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  const message = parsed
    ? extractCloudflareErrorMessage(parsed, response.status)
    : text.trim().slice(0, 300) || `Cloudflare Browser Run ${action} failed (HTTP ${response.status})`;
  const status = response.status >= 400 && response.status < 600 ? response.status : 502;
  throw new ApiError(status, "browser_run_failed", `browser ${action} failed: ${message}`);
}

function checkResponseMetaFinalUrl(meta?: BrowserRunResponseMeta): void {
  if (meta?.finalUrl) {
    assertSafeBrowserUrl(meta.finalUrl);
  }
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function decodeValidatedImage(
  rawBytes: Uint8Array,
  label: string,
): { contentType: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number; size: number; base64: string } {
  if (!rawBytes.byteLength) {
    throw new ApiError(502, "browser_invalid_image", `${label} returned an empty image`);
  }
  if (rawBytes.byteLength > BROWSER_LIMITS.maxScreenshotBytes) {
    throw new ApiError(413, "browser_image_too_large", `${label} exceeds the ${BROWSER_LIMITS.maxScreenshotBytes} byte screenshot limit`);
  }
  const buf = Buffer.from(rawBytes);
  const header = imageHeader(buf);
  if (
    !header ||
    !header.width ||
    !header.height ||
    (header.mimeType !== "image/png" && header.mimeType !== "image/jpeg" && header.mimeType !== "image/webp") ||
    !imageIntact(buf, header.mimeType)
  ) {
    throw new ApiError(502, "browser_invalid_image", `${label} returned an invalid or unsupported image`);
  }
  return {
    contentType: header.mimeType,
    width: header.width,
    height: header.height,
    size: buf.byteLength,
    base64: buf.toString("base64"),
  };
}

/**
 * Low-level dispatcher for Cloudflare Browser Run Quick Actions.
 *
 * Uses the native Workers `env.BROWSER.quickAction()` binding when bound (zero tokens, lowest latency),
 * passing `{ browser: "kitesurf" }` for Kitesurf or omitting `browser` for Chromium.
 * Falls back to the Cloudflare Browser Run REST API (`/accounts/:id/browser-run/:action?browser=kitesurf`)
 * via `fetchWithoutRedirects` when `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_BROWSER_RUN_TOKEN` (or `CLOUDFLARE_API_TOKEN`)
 * are configured.
 */
async function invokeQuickAction(
  env: BrowserEnv,
  action: "markdown" | "screenshot" | "snapshot" | "scrape" | "links" | "content" | "accessibilityTree",
  payload: Record<string, unknown>,
  engine: BrowserEngine,
  opts?: BrowserCallOptions,
): Promise<Response> {
  // 1. Primary path: Native Cloudflare Workers Browser Run binding
  if (env.BROWSER && typeof env.BROWSER.quickAction === "function") {
    const bindingPayload =
      engine === "kitesurf"
        ? { ...payload, browser: "kitesurf" as const }
        : { ...payload };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return env.BROWSER.quickAction(action as any, bindingPayload as any);
  }

  // 2. Fallback path: Cloudflare Browser Run REST API (no redirects so Bearer token cannot leak)
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = (env.CLOUDFLARE_BROWSER_RUN_TOKEN || env.CLOUDFLARE_API_TOKEN)?.trim();
  if (!accountId || !token) {
    throw new ApiError(
      503,
      "browser_unavailable",
      "Cloudflare Browser Run is not configured: attach the `BROWSER` binding in Wrangler or set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_BROWSER_RUN_TOKEN",
    );
  }

  const baseUrl = (env.CLOUDFLARE_BROWSER_RUN_BASE_URL?.trim() || DEFAULT_CF_API_BASE).replace(/\/+$/, "");
  const query = engine === "kitesurf" ? "?browser=kitesurf" : "";
  const endpoint = `${baseUrl}/accounts/${encodeURIComponent(accountId)}/browser-run/${action}${query}`;
  const fetcher: RedirectSafeFetcher = opts?.fetchFn ?? ((input, init) => fetch(input, init));

  return fetchWithoutRedirects(fetcher, endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: opts?.signal,
  });
}

async function parseJsonQuickAction<T extends { success: boolean; meta?: BrowserRunResponseMeta }>(
  response: Response,
  action: string,
): Promise<{ body: T; browserMsUsed?: number }> {
  const browserMsUsed = parseBrowserMsUsed(response);
  if (!response.ok) {
    await throwForFailedResponse(response, action);
  }
  let parsed: T;
  try {
    parsed = (await response.json()) as T;
  } catch {
    throw new ApiError(502, "browser_invalid_response", `Cloudflare Browser Run ${action} returned non-JSON body`);
  }
  if (!parsed || parsed.success !== true) {
    const msg = extractCloudflareErrorMessage(parsed, response.status);
    throw new ApiError(502, "browser_run_failed", `browser ${action} failed: ${msg}`);
  }
  checkResponseMetaFinalUrl(parsed.meta);
  return { body: parsed, browserMsUsed };
}

export async function browserMarkdown(
  env: BrowserEnv,
  input: BrowserMarkdownInput,
  opts?: BrowserCallOptions,
): Promise<BrowserMarkdownResult> {
  const safeUrl = assertSafeBrowserUrl(input.url);
  const engine = resolveBrowserEngine(input.engine, env);
  const maxChars = clampNumber(
    input.maxChars,
    BROWSER_LIMITS.defaultMaxChars,
    BROWSER_LIMITS.minMaxChars,
    BROWSER_LIMITS.maxMaxChars,
  );
  const payload = buildCommonPayload(input, safeUrl);
  const response = await invokeQuickAction(env, "markdown", payload, engine, opts);
  const { body, browserMsUsed } = await parseJsonQuickAction<BrowserRunMarkdownSuccessResponse>(response, "markdown");

  const rawMarkdown = typeof body.result === "string" ? body.result : "";
  const { text, truncated } = truncateText(rawMarkdown, maxChars);

  return {
    url: safeUrl.toString(),
    ...(body.meta?.finalUrl ? { finalUrl: body.meta.finalUrl } : {}),
    ...(body.meta?.title ? { title: body.meta.title } : {}),
    ...(typeof body.meta?.status === "number" ? { status: body.meta.status } : {}),
    engine,
    markdown: text,
    truncated,
    ...(browserMsUsed !== undefined ? { browserMsUsed } : {}),
  };
}

export async function browserScreenshot(
  env: BrowserEnv,
  input: BrowserScreenshotInput,
  opts?: BrowserCallOptions,
): Promise<BrowserScreenshotResult> {
  const safeUrl = assertSafeBrowserUrl(input.url);
  const engine = resolveBrowserEngine(input.engine, env);
  const format: BrowserScreenshotFormat =
    input.format === "jpeg" || input.format === "webp" || input.format === "png"
      ? input.format
      : "png";

  const payload = buildCommonPayload(
    {
      ...input,
      viewport: input.viewport ?? BROWSER_LIMITS.defaultViewport,
    },
    safeUrl,
  );

  if (typeof input.selector === "string" && input.selector.trim()) {
    payload.selector = input.selector.trim();
  }

  const screenshotOptions: Record<string, unknown> = {
    type: format,
  };
  if (input.fullPage !== undefined) {
    screenshotOptions.fullPage = Boolean(input.fullPage);
  }
  if ((format === "jpeg" || format === "webp") && typeof input.quality === "number") {
    screenshotOptions.quality = clampNumber(input.quality, 80, 1, 100);
  }
  payload.screenshotOptions = screenshotOptions;

  const response = await invokeQuickAction(env, "screenshot", payload, engine, opts);
  const browserMsUsed = parseBrowserMsUsed(response);
  if (!response.ok) {
    await throwForFailedResponse(response, "screenshot");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const image = decodeValidatedImage(bytes, "browser screenshot");

  return {
    url: safeUrl.toString(),
    engine,
    ...image,
    ...(browserMsUsed !== undefined ? { browserMsUsed } : {}),
  };
}

export async function browserSnapshot(
  env: BrowserEnv,
  input: BrowserSnapshotInput,
  opts?: BrowserCallOptions,
): Promise<BrowserSnapshotResult> {
  const safeUrl = assertSafeBrowserUrl(input.url);
  const engine = resolveBrowserEngine(input.engine, env);
  const maxChars = clampNumber(
    input.maxChars,
    BROWSER_LIMITS.defaultMaxChars,
    BROWSER_LIMITS.minMaxChars,
    BROWSER_LIMITS.maxMaxChars,
  );

  const requestedFormats = Array.isArray(input.formats) && input.formats.length > 0
    ? [...new Set(input.formats.filter((f): f is BrowserRunSnapshotFormat => VALID_SNAPSHOT_FORMATS.has(f)))]
    : (["markdown", "accessibilityTree"] as BrowserRunSnapshotFormat[]);

  if (requestedFormats.length === 0) {
    throw new ApiError(
      400,
      "invalid_snapshot_formats",
      'formats must include one or more of: "markdown", "accessibilityTree", "content", "screenshot"',
    );
  }

  // Cloudflare's `/snapshot` action requires at least 2 distinct formats; if the caller only asked
  // for 1 format, transparently dispatch to the dedicated action so single-format calls still succeed.
  if (requestedFormats.length === 1) {
    const only = requestedFormats[0];
    if (only === "markdown") {
      const md = await browserMarkdown(env, { ...input, maxChars }, opts);
      return {
        url: md.url,
        ...(md.finalUrl ? { finalUrl: md.finalUrl } : {}),
        ...(md.title ? { title: md.title } : {}),
        ...(md.status !== undefined ? { status: md.status } : {}),
        engine: md.engine,
        formats: ["markdown"],
        markdown: md.markdown,
        markdownTruncated: md.truncated,
        ...(md.browserMsUsed !== undefined ? { browserMsUsed: md.browserMsUsed } : {}),
      };
    }
    if (only === "screenshot") {
      const shot = await browserScreenshot(env, input, opts);
      return {
        url: shot.url,
        engine: shot.engine,
        formats: ["screenshot"],
        screenshot: {
          contentType: shot.contentType,
          width: shot.width,
          height: shot.height,
          size: shot.size,
          base64: shot.base64,
        },
        ...(shot.browserMsUsed !== undefined ? { browserMsUsed: shot.browserMsUsed } : {}),
      };
    }
    const ext = await browserExtract(env, { ...input, mode: only, maxChars }, opts);
    return {
      url: ext.url,
      ...(ext.finalUrl ? { finalUrl: ext.finalUrl } : {}),
      ...(ext.title ? { title: ext.title } : {}),
      ...(ext.status !== undefined ? { status: ext.status } : {}),
      engine: ext.engine,
      formats: [only],
      ...(only === "content" ? { content: String(ext.data ?? ""), contentTruncated: ext.truncated } : {}),
      ...(only === "accessibilityTree" ? { accessibilityTree: (ext.data as BrowserRunSerializedAXNode | null) ?? null } : {}),
      ...(ext.browserMsUsed !== undefined ? { browserMsUsed: ext.browserMsUsed } : {}),
    };
  }

  const wantsScreenshot = requestedFormats.includes("screenshot");
  const payload = buildCommonPayload(
    {
      ...input,
      viewport: input.viewport ?? (wantsScreenshot ? BROWSER_LIMITS.defaultViewport : undefined),
    },
    safeUrl,
  );
  payload.formats = requestedFormats;

  if (wantsScreenshot) {
    const format: BrowserScreenshotFormat =
      input.format === "jpeg" || input.format === "webp" || input.format === "png"
        ? input.format
        : "png";
    payload.screenshotOptions = {
      type: format,
      ...(input.fullPage !== undefined ? { fullPage: Boolean(input.fullPage) } : {}),
    };
  }

  const response = await invokeQuickAction(env, "snapshot", payload, engine, opts);
  const { body, browserMsUsed } = await parseJsonQuickAction<BrowserRunSnapshotSuccessResponse>(response, "snapshot");

  const out: BrowserSnapshotResult = {
    url: safeUrl.toString(),
    ...(body.meta?.finalUrl ? { finalUrl: body.meta.finalUrl } : {}),
    ...(body.meta?.title ? { title: body.meta.title } : {}),
    ...(typeof body.meta?.status === "number" ? { status: body.meta.status } : {}),
    engine,
    formats: requestedFormats,
    ...(browserMsUsed !== undefined ? { browserMsUsed } : {}),
  };

  if (typeof body.result?.markdown === "string") {
    const md = truncateText(body.result.markdown, maxChars);
    out.markdown = md.text;
    out.markdownTruncated = md.truncated;
  }
  if (typeof body.result?.content === "string") {
    const html = truncateText(body.result.content, maxChars);
    out.content = html.text;
    out.contentTruncated = html.truncated;
  }
  if (body.result && "accessibilityTree" in body.result) {
    out.accessibilityTree = body.result.accessibilityTree ?? null;
  }
  if (typeof body.result?.screenshot === "string" && body.result.screenshot.length > 0) {
    // Cloudflare snapshot screenshot may be raw base64 or a data URI; normalize cleanly.
    const rawB64 = body.result.screenshot.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
    const decoded = Buffer.from(rawB64, "base64");
    out.screenshot = decodeValidatedImage(decoded, "browser snapshot screenshot");
  }

  return out;
}

export async function browserExtract(
  env: BrowserEnv,
  input: BrowserExtractInput,
  opts?: BrowserCallOptions,
): Promise<BrowserExtractResult> {
  const safeUrl = assertSafeBrowserUrl(input.url);
  const engine = resolveBrowserEngine(input.engine, env);
  const maxChars = clampNumber(
    input.maxChars,
    BROWSER_LIMITS.defaultMaxChars,
    BROWSER_LIMITS.minMaxChars,
    BROWSER_LIMITS.maxMaxChars,
  );

  const inferredMode: BrowserExtractMode =
    input.mode ??
    (Array.isArray(input.selectors) && input.selectors.length > 0 ? "scrape" : "links");

  const payload = buildCommonPayload(input, safeUrl);

  if (inferredMode === "scrape") {
    const selectors = Array.isArray(input.selectors)
      ? input.selectors.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean)
      : [];
    if (selectors.length === 0) {
      throw new ApiError(400, "invalid_selectors", 'browser_extract with mode="scrape" requires at least one CSS selector in `selectors`');
    }
    if (selectors.length > BROWSER_LIMITS.maxSelectors) {
      throw new ApiError(400, "too_many_selectors", `At most ${BROWSER_LIMITS.maxSelectors} CSS selectors are allowed`);
    }
    payload.elements = selectors.map((selector) => ({ selector }));
    const response = await invokeQuickAction(env, "scrape", payload, engine, opts);
    const { body, browserMsUsed } = await parseJsonQuickAction<BrowserRunScrapeSuccessResponse>(response, "scrape");
    return {
      url: safeUrl.toString(),
      ...(body.meta?.finalUrl ? { finalUrl: body.meta.finalUrl } : {}),
      ...(body.meta?.title ? { title: body.meta.title } : {}),
      ...(typeof body.meta?.status === "number" ? { status: body.meta.status } : {}),
      engine,
      mode: "scrape",
      data: body.result ?? [],
      ...(browserMsUsed !== undefined ? { browserMsUsed } : {}),
    };
  }

  if (inferredMode === "links") {
    if (input.visibleLinksOnly !== undefined) payload.visibleLinksOnly = Boolean(input.visibleLinksOnly);
    if (input.excludeExternalLinks !== undefined) payload.excludeExternalLinks = Boolean(input.excludeExternalLinks);
    const response = await invokeQuickAction(env, "links", payload, engine, opts);
    const { body, browserMsUsed } = await parseJsonQuickAction<BrowserRunLinksSuccessResponse>(response, "links");
    const links = Array.isArray(body.result) ? body.result : [];
    const truncated = links.length > BROWSER_LIMITS.maxLinks;
    return {
      url: safeUrl.toString(),
      ...(body.meta?.finalUrl ? { finalUrl: body.meta.finalUrl } : {}),
      ...(body.meta?.title ? { title: body.meta.title } : {}),
      ...(typeof body.meta?.status === "number" ? { status: body.meta.status } : {}),
      engine,
      mode: "links",
      data: truncated ? links.slice(0, BROWSER_LIMITS.maxLinks) : links,
      ...(truncated ? { truncated: true } : {}),
      ...(browserMsUsed !== undefined ? { browserMsUsed } : {}),
    };
  }

  if (inferredMode === "content") {
    const response = await invokeQuickAction(env, "content", payload, engine, opts);
    const { body, browserMsUsed } = await parseJsonQuickAction<BrowserRunContentSuccessResponse>(response, "content");
    const { text, truncated } = truncateText(typeof body.result === "string" ? body.result : "", maxChars);
    return {
      url: safeUrl.toString(),
      ...(body.meta?.finalUrl ? { finalUrl: body.meta.finalUrl } : {}),
      ...(body.meta?.title ? { title: body.meta.title } : {}),
      ...(typeof body.meta?.status === "number" ? { status: body.meta.status } : {}),
      engine,
      mode: "content",
      data: text,
      truncated,
      ...(browserMsUsed !== undefined ? { browserMsUsed } : {}),
    };
  }

  if (inferredMode === "accessibilityTree") {
    if (typeof input.root === "string" && input.root.trim()) payload.root = input.root.trim();
    if (input.interestingOnly !== undefined) payload.interestingOnly = Boolean(input.interestingOnly);
    const response = await invokeQuickAction(env, "accessibilityTree", payload, engine, opts);
    const { body, browserMsUsed } = await parseJsonQuickAction<BrowserRunAccessibilityTreeSuccessResponse>(
      response,
      "accessibilityTree",
    );
    return {
      url: safeUrl.toString(),
      ...(body.meta?.finalUrl ? { finalUrl: body.meta.finalUrl } : {}),
      ...(body.meta?.title ? { title: body.meta.title } : {}),
      ...(typeof body.meta?.status === "number" ? { status: body.meta.status } : {}),
      engine,
      mode: "accessibilityTree",
      data: body.result?.accessibilityTree ?? null,
      ...(browserMsUsed !== undefined ? { browserMsUsed } : {}),
    };
  }

  throw new ApiError(
    400,
    "invalid_extract_mode",
    `Invalid mode '${String(inferredMode)}': expected "scrape", "links", "content", or "accessibilityTree"`,
  );
}

export const BROWSER_TOOL_NAMES = [
  "browser_markdown",
  "browser_screenshot",
  "browser_snapshot",
  "browser_extract",
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

export function isBrowserToolName(name: string): name is BrowserToolName {
  return (BROWSER_TOOL_NAMES as readonly string[]).includes(name);
}

export const BROWSER_TOOL_SCHEMAS: LlmToolSchema[] = [
  {
    name: "browser_markdown",
    description:
      "Open a public HTTP/HTTPS page in Cloudflare Browser Run (defaulting to the fast Kitesurf engine; pass engine='chromium' for complex SPAs/WebGL/bot-challenges) and return clean Markdown plus page metadata.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http:// or https:// URL to render" },
        engine: { type: "string", enum: ["kitesurf", "chromium"], description: "Browser engine (default: kitesurf)" },
        waitUntil: { type: "string", enum: ["domcontentloaded", "load", "networkidle0", "networkidle2"] },
        waitForSelector: { type: "string", description: "Optional CSS selector to wait for before extraction" },
        maxChars: { type: "number", description: "Maximum Markdown characters to return (default: 32000)" },
        timeoutMs: { type: "number", description: "Navigation timeout in milliseconds (1000-60000)" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Render a public HTTP/HTTPS page in Cloudflare Browser Run (default: Kitesurf) and capture a screenshot returned inline so you can visually inspect the page, optionally saving it to the agent repository.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http:// or https:// URL to screenshot" },
        path: { type: "string", description: "Optional repository path to save the screenshot (e.g. screenshots/page.png)" },
        engine: { type: "string", enum: ["kitesurf", "chromium"], description: "Browser engine (default: kitesurf)" },
        fullPage: { type: "boolean", description: "Capture the full scrollable page instead of the viewport" },
        selector: { type: "string", description: "Optional CSS selector of a specific element to screenshot" },
        format: { type: "string", enum: ["png", "jpeg", "webp"], description: "Image format (default: png)" },
        quality: { type: "number", description: "Compression quality (1-100) for jpeg/webp" },
        viewport: {
          type: "object",
          properties: {
            width: { type: "number" },
            height: { type: "number" },
          },
        },
        waitUntil: { type: "string", enum: ["domcontentloaded", "load", "networkidle0", "networkidle2"] },
        waitForSelector: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Capture multiple representations of a public page in a single Cloudflare Browser Run load (default: markdown + accessibilityTree; optionally include screenshot and/or content HTML).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http:// or https:// URL to snapshot" },
        formats: {
          type: "array",
          items: { type: "string", enum: ["markdown", "accessibilityTree", "content", "screenshot"] },
          description: "Page formats to capture (default: ['markdown', 'accessibilityTree'])",
        },
        path: { type: "string", description: "Optional repository path to save the screenshot when 'screenshot' format is included" },
        engine: { type: "string", enum: ["kitesurf", "chromium"], description: "Browser engine (default: kitesurf)" },
        fullPage: { type: "boolean" },
        format: { type: "string", enum: ["png", "jpeg", "webp"] },
        viewport: {
          type: "object",
          properties: {
            width: { type: "number" },
            height: { type: "number" },
          },
        },
        waitUntil: { type: "string", enum: ["domcontentloaded", "load", "networkidle0", "networkidle2"] },
        waitForSelector: { type: "string" },
        maxChars: { type: "number" },
        timeoutMs: { type: "number" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_extract",
    description:
      "Extract structured data from a rendered page via Cloudflare Browser Run: CSS selector scraping ('scrape'), page hyperlinks ('links'), semantic ARIA tree ('accessibilityTree'), or rendered HTML ('content').",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http:// or https:// URL to inspect" },
        mode: {
          type: "string",
          enum: ["scrape", "links", "content", "accessibilityTree"],
          description: "Extraction mode (defaults to 'scrape' if selectors are given, otherwise 'links')",
        },
        selectors: {
          type: "array",
          items: { type: "string" },
          description: "CSS selectors to scrape when mode='scrape'",
        },
        visibleLinksOnly: { type: "boolean", description: "For mode='links': only return visible links" },
        excludeExternalLinks: { type: "boolean", description: "For mode='links': exclude external domains" },
        root: { type: "string", description: "For mode='accessibilityTree': CSS selector scoping the ARIA subtree" },
        interestingOnly: { type: "boolean", description: "For mode='accessibilityTree': prune non-semantic nodes" },
        engine: { type: "string", enum: ["kitesurf", "chromium"], description: "Browser engine (default: kitesurf)" },
        waitUntil: { type: "string", enum: ["domcontentloaded", "load", "networkidle0", "networkidle2"] },
        waitForSelector: { type: "string" },
        maxChars: { type: "number" },
        timeoutMs: { type: "number" },
      },
      required: ["url"],
    },
  },
];

export interface ExecuteBrowserToolOptions extends BrowserCallOptions {
  saveScreenshot?: (input: {
    path: string;
    contentType: "image/png" | "image/jpeg" | "image/webp";
    base64: string;
    url: string;
  }) => Promise<string>;
}

function parseViewportArg(value: unknown): { width: number; height: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { width?: unknown; height?: unknown };
  if (typeof record.width !== "number" || typeof record.height !== "number") return undefined;
  return { width: record.width, height: record.height };
}

export function assertScreenshotPathExtension(
  path: string,
  contentType: "image/png" | "image/jpeg" | "image/webp",
): void {
  const expectedExt =
    contentType === "image/png"
      ? /\.png$/i
      : contentType === "image/jpeg"
        ? /\.jpe?g$/i
        : /\.webp$/i;
  if (!expectedExt.test(path)) {
    const label = contentType === "image/png" ? ".png" : contentType === "image/jpeg" ? ".jpg/.jpeg" : ".webp";
    throw new Error(`Choose a ${label} output path for ${contentType} screenshots`);
  }
}

export async function executeBrowserTool(
  env: BrowserEnv,
  toolName: BrowserToolName,
  args: Record<string, unknown>,
  opts?: ExecuteBrowserToolOptions,
): Promise<unknown> {
  const common = {
    url: String(args.url ?? ""),
    engine: typeof args.engine === "string" ? (args.engine as BrowserEngine) : undefined,
    waitUntil: typeof args.waitUntil === "string" ? (args.waitUntil as BrowserWaitUntil) : undefined,
    waitForSelector: typeof args.waitForSelector === "string" ? args.waitForSelector : undefined,
    viewport: parseViewportArg(args.viewport),
    timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
  };

  if (toolName === "browser_markdown") {
    return browserMarkdown(
      env,
      {
        ...common,
        maxChars: typeof args.maxChars === "number" ? args.maxChars : undefined,
      },
      opts,
    );
  }

  if (toolName === "browser_screenshot") {
    const shot = await browserScreenshot(
      env,
      {
        ...common,
        fullPage: args.fullPage !== undefined ? Boolean(args.fullPage) : undefined,
        selector: typeof args.selector === "string" ? args.selector : undefined,
        format: typeof args.format === "string" ? (args.format as BrowserScreenshotFormat) : undefined,
        quality: typeof args.quality === "number" ? args.quality : undefined,
      },
      opts,
    );

    let savedPath: string | undefined;
    if (typeof args.path === "string" && args.path.trim() && opts?.saveScreenshot) {
      savedPath = await opts.saveScreenshot({
        path: args.path,
        contentType: shot.contentType,
        base64: shot.base64,
        url: shot.url,
      });
    }

    const summary = [
      `Captured ${shot.width}×${shot.height} ${shot.contentType} screenshot of ${shot.url} via ${shot.engine}`,
      savedPath ? `saved to ${savedPath}` : undefined,
      shot.browserMsUsed !== undefined ? `(${shot.browserMsUsed}ms)` : undefined,
    ]
      .filter(Boolean)
      .join(" ");

    if (shot.base64.length <= FILE_LIMITS.requestImageBase64Bytes) {
      return {
        content: [
          { type: "text", text: summary },
          { type: "image", mimeType: shot.contentType, data: shot.base64 },
        ],
      };
    }

    return {
      url: shot.url,
      engine: shot.engine,
      contentType: shot.contentType,
      width: shot.width,
      height: shot.height,
      size: shot.size,
      ...(savedPath ? { path: savedPath } : {}),
      ...(shot.browserMsUsed !== undefined ? { browserMsUsed: shot.browserMsUsed } : {}),
      note: "Screenshot exceeded the inline model image byte budget; inspect the saved repository file or capture a smaller viewport.",
    };
  }

  if (toolName === "browser_snapshot") {
    const formats = Array.isArray(args.formats)
      ? args.formats.filter((f): f is BrowserRunSnapshotFormat => typeof f === "string")
      : undefined;
    const snap = await browserSnapshot(
      env,
      {
        ...common,
        formats,
        fullPage: args.fullPage !== undefined ? Boolean(args.fullPage) : undefined,
        format: typeof args.format === "string" ? (args.format as BrowserScreenshotFormat) : undefined,
        maxChars: typeof args.maxChars === "number" ? args.maxChars : undefined,
      },
      opts,
    );

    let savedPath: string | undefined;
    if (snap.screenshot && typeof args.path === "string" && args.path.trim() && opts?.saveScreenshot) {
      savedPath = await opts.saveScreenshot({
        path: args.path,
        contentType: snap.screenshot.contentType,
        base64: snap.screenshot.base64,
        url: snap.url,
      });
    }

    if (snap.screenshot && snap.screenshot.base64.length <= FILE_LIMITS.requestImageBase64Bytes) {
      const { screenshot, ...rest } = snap;
      const textPayload = {
        ...rest,
        screenshot: {
          contentType: screenshot.contentType,
          width: screenshot.width,
          height: screenshot.height,
          size: screenshot.size,
          ...(savedPath ? { path: savedPath } : {}),
        },
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(textPayload) },
          { type: "image", mimeType: screenshot.contentType, data: screenshot.base64 },
        ],
      };
    }

    if (snap.screenshot) {
      const { screenshot, ...rest } = snap;
      return {
        ...rest,
        screenshot: {
          contentType: screenshot.contentType,
          width: screenshot.width,
          height: screenshot.height,
          size: screenshot.size,
          ...(savedPath ? { path: savedPath } : {}),
          note: "Screenshot exceeded the inline model image byte budget.",
        },
      };
    }

    return snap;
  }

  const selectors = Array.isArray(args.selectors)
    ? args.selectors.filter((s): s is string => typeof s === "string")
    : undefined;
  return browserExtract(
    env,
    {
      ...common,
      mode: typeof args.mode === "string" ? (args.mode as BrowserExtractMode) : undefined,
      selectors,
      visibleLinksOnly: args.visibleLinksOnly !== undefined ? Boolean(args.visibleLinksOnly) : undefined,
      excludeExternalLinks: args.excludeExternalLinks !== undefined ? Boolean(args.excludeExternalLinks) : undefined,
      root: typeof args.root === "string" ? args.root : undefined,
      interestingOnly: args.interestingOnly !== undefined ? Boolean(args.interestingOnly) : undefined,
      maxChars: typeof args.maxChars === "number" ? args.maxChars : undefined,
    },
    opts,
  );
}

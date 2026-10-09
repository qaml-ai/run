// Trusted host policy. Guest arguments cannot raise these limits.
export const SANDBOX_LIMITS = Object.freeze({
  /** One execution's V8 heap: v8-exec's HEAP_BYTES (sandbox/v8-exec/src/main.rs), for the system prompt. */
  heapBytes: 128 * 1024 * 1024,
  /**
   * One execution's CPU: what a tenant gets by default, and at most whatever is set for it. v8-exec's
   * watchdog terminates the guest at it, and its process 250 ms later (sandbox/v8-exec).
   */
  cpuMs: 2_000, maxCpuMs: 30_000,
  /**
   * One execution's wall time and output characters: by default, and at most when it asks (`timeoutMs`,
   * `maxOutputCharacters`). A tenant's longest timeoutMs is `CODE_LIMITS.maxTimeoutMs` unless set otherwise, within this.
   */
  timeoutMs: 30_000, maxTimeoutMs: 120_000, outputCharacters: 32_000, maxOutputCharacters: 128_000,
  toolCalls: 256,
  concurrentTools: 32,
  argumentBytes: 128 * 1024,
  resultBytes: 1024 * 1024,
  totalToolBytes: 8 * 1024 * 1024,
  outputEvents: 1024,
});

/**
 * A tenant's js_exec limits unless its own are set (a tenants-file entry's `codeCpuMs`,
 * `codeMaxTimeoutMs`, `codeConcurrency`, or `tenants.limits`'): CPU per execution, the longest
 * timeoutMs it may ask for, and executions it may run at once on one node (on free credit, `freeConcurrent`).
 * Admin tenants (the tenants file's) are not held to `concurrent` or `maxTimeoutMs` unless their entry sets them.
 */
export const CODE_LIMITS = Object.freeze({ cpuMs: SANDBOX_LIMITS.cpuMs, maxTimeoutMs: 60_000, concurrent: 4, freeConcurrent: 2 });

/**
 * An agent's tool catalog. Most tools are reached from js_exec, where only names enter the
 * sandbox and search runs on the host; at most `direct` are declared to the model itself.
 */
export const CATALOG_LIMITS = Object.freeze({ tools: 4096, bytes: 16 * 1024 * 1024, direct: 64 });

/** Files in and out of agents (files.ts, inspect.ts). */
export const FILE_LIMITS = Object.freeze({
  /** Files attached to one message, and their inline (base64) bytes in all, decoded. */
  attachments: 20, inlineBytes: 4 * 1024 * 1024,
  /** An image the model sees natively: Anthropic's per-image cap, and the longest side any provider takes. */
  imageBytes: 5 * 1024 * 1024, imageSide: 8000,
  /**
   * An image as a model request carries it; a larger one is scaled down first (inspect.ts). Anthropic scales a side
   * past 1,568 px down anyway, and refuses sides over 2,000 px once a request holds more than 20 images; base64 of
   * the bytes stays within its 5 MB. Scaling down decodes at most `imageSide` squared pixels, within `inspectMs`.
   */
  requestImageSide: 1568, requestImageBytes: 3.75 * 1024 * 1024,
  /** A PDF the model sees natively (Anthropic's page cap; well under every provider's size cap). */
  documentBytes: 16 * 1024 * 1024, documentPages: 100,
  /** Across one model request: older files past these are described in text instead. */
  requestFileBytes: 24 * 1024 * 1024, requestImages: 100,
  /** File bytes the agent host keeps hydrated between model requests. */
  hydratedBytes: 32 * 1024 * 1024,
  /** Parsing untrusted files (in a worker of a parse job, parse-job.ts): input, time, memory and text out. */
  inspectBytes: 32 * 1024 * 1024, inspectMs: 10_000, inspectHeapMb: 256, inspectMemoryBytes: 512 * 1024 * 1024, extractedChars: 1_000_000,
  /** A text file's first lines, as its reference carries them: read from at most this many bytes, lines cut to a width. */
  headBytes: 1024, headLines: 5, headWidth: 200,
  /** Signed links: default and longest lifetime, in seconds. */
  linkSeconds: 15 * 60, maxLinkSeconds: 24 * 60 * 60,
  /** A file attached by URL: at most this large, fetched within this long, following at most this many redirects. */
  urlBytes: 64 * 1024 * 1024, urlMs: 60_000, urlRedirects: 3,
  /** An upload's whole request may take this long (other requests get 30 s). */
  uploadMs: 15 * 60_000,
  /** One js_exec fs.readFile or fs.writeFile: base64 of this, with its path, fits a 1 MiB tool result. */
  scriptFileBytes: 700 * 1024,
});

/** Files through tool calls (tool-files.ts): arguments that name a file, and outputs saved to the workspace. */
export const TOOL_FILE_LIMITS = Object.freeze({
  /** A file sent as base64 in a tool's arguments. */
  inlineBytes: 4 * 1024 * 1024,
  /** A binary response (an OpenAPI operation's, web_fetch's), saved rather than shown. */
  responseBytes: 64 * 1024 * 1024,
  /** An MCP text resource longer than this is saved rather than shown. */
  textBytes: 64 * 1024,
  /** What one tool call, and all the calls of one run, may save. */
  callBytes: 64 * 1024 * 1024, runBytes: 256 * 1024 * 1024,
  /** A call-bound file URL's lifetime, in seconds; a directory's snapshot is kept this long after its call ends. */
  urlSeconds: 5 * 60,
  /** A directory sent to a tool: its files, and their bytes. */
  directoryFiles: 1000, directoryBytes: 256 * 1024 * 1024,
  /** Files up to this size carry a sha-256 digest (each is read to compute it). */
  digestBytes: 64 * 1024 * 1024,
});

/** Audio transcribed (transcription.ts): what a provider takes, and what one message may carry. */
export const AUDIO_LIMITS = Object.freeze({
  /** One audio file: OpenAI's 25 MB, and 30 minutes, read from its header before it is sent. */
  fileBytes: 25 * 1000 * 1000, seconds: 30 * 60,
  /** Audio files transcribed for one message, and their minutes together. */
  files: 5, messageSeconds: 30 * 60,
  /** A provider's answer, from when the audio is sent. */
  timeoutMs: 5 * 60_000,
});

/** Transient provider failures (overload, rate limit, 5xx, network) are retried with backoff. */
export const DEFAULT_RETRY = Object.freeze({ maxAttempts: 3, baseDelayMs: 2_000 });

export function jsonWithinLimit(value: unknown, maxBytes: number, label: string): string {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > maxBytes) throw new Error(`${label} exceeds JSON size limit`);
  return json;
}

export function codeRequest(value: unknown): { code: string; timeoutMs?: number; maxOutputCharacters?: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected codemode arguments");
  const args = value as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!["code", "description", "timeoutMs", "maxOutputCharacters"].includes(key)) throw new Error(`Unknown codemode option: ${key}`);
  }
  if (typeof args.code !== "string") throw new Error("code must be a string");
  if (args.timeoutMs !== undefined && typeof args.timeoutMs !== "number") throw new Error("timeoutMs must be a number");
  if (args.maxOutputCharacters !== undefined && typeof args.maxOutputCharacters !== "number") throw new Error("maxOutputCharacters must be a number");
  return { code: args.code, timeoutMs: args.timeoutMs, maxOutputCharacters: args.maxOutputCharacters };
}

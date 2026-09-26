// Trusted host policy. Guest arguments cannot raise these limits.
export const SANDBOX_LIMITS = Object.freeze({
  wasmBytes: 32 * 1024 * 1024,
  heapBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
  cpuMs: 2_000,
  /** One execution's wall time and output characters: by default, and at most when it asks (`timeoutMs`, `maxOutputCharacters`). */
  timeoutMs: 30_000, maxTimeoutMs: 120_000, outputCharacters: 32_000, maxOutputCharacters: 128_000,
  toolCalls: 256,
  concurrentTools: 32,
  argumentBytes: 128 * 1024,
  resultBytes: 1024 * 1024,
  totalToolBytes: 8 * 1024 * 1024,
  outputEvents: 1024,
});

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
  /** A PDF the model sees natively (Anthropic's page cap; well under every provider's size cap). */
  documentBytes: 16 * 1024 * 1024, documentPages: 100,
  /** Across one model request: older files past these are described in text instead. */
  requestFileBytes: 24 * 1024 * 1024, requestImages: 100,
  /** File bytes the agent host keeps hydrated between model requests. */
  hydratedBytes: 32 * 1024 * 1024,
  /** Parsing untrusted files (in a worker, in a sandbox process when there are some): input, time, memory and text out. */
  inspectBytes: 32 * 1024 * 1024, inspectMs: 10_000, inspectHeapMb: 256, inspectMemoryBytes: 512 * 1024 * 1024, extractedChars: 1_000_000,
  /** A text file's first lines, as its reference carries them: read from at most this many bytes, lines cut to a width. */
  headBytes: 1024, headLines: 5, headWidth: 200,
  /** Signed links: default and longest lifetime, in seconds. */
  linkSeconds: 15 * 60, maxLinkSeconds: 24 * 60 * 60,
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

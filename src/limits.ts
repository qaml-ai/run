// Trusted host policy. Guest arguments cannot raise these limits.
export const SANDBOX_LIMITS = Object.freeze({
  wasmBytes: 32 * 1024 * 1024,
  heapBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
  cpuMs: 2_000,
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

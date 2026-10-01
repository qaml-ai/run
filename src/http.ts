import { databaseUnavailable } from "./db.ts";

export class HttpError extends Error {
  status: number;
  /** A machine-readable code for the error body (see `errorCode`); by default one for its status. */
  code?: string;
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; if (code) this.code = code; }
}

/**
 * What to do without credentials, said in each 401 and 404 a person or a coding agent reads: where API tokens are made,
 * the CLI's login, and the setup skill.
 */
export const signInHint = (origin: string) =>
  `Create an API token at ${origin}/console/tokens and send it as Authorization: Bearer <token> (the SDKs read CAMELAI_API_KEY; the CLI also takes \`npx @camelai/camelrun login\`). Coding agents: read ${origin}/SKILL.md`;

/** The code an error body carries for each status, when the error names none of its own. */
const STATUS_CODES: Record<number, string> = {
  400: "INVALID_REQUEST", 401: "UNAUTHORIZED", 402: "PAYMENT_REQUIRED", 403: "FORBIDDEN", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT", 410: "GONE", 412: "PRECONDITION_FAILED", 413: "TOO_LARGE", 415: "UNSUPPORTED_MEDIA_TYPE", 429: "RATE_LIMITED",
  500: "INTERNAL", 502: "UPSTREAM_ERROR", 503: "UNAVAILABLE", 504: "TIMEOUT",
};

/**
 * An error body's machine-readable `code`: the error's own (HttpError's third argument), else the one its message
 * opens with (`APPLICATION_CONNECTED: ...`), else its status's. The message stays as it is, for people.
 */
export function errorCode(error: unknown, status: number): string {
  const own = (error as { code?: unknown } | undefined)?.code;
  if (typeof own === "string" && /^[A-Z][A-Z0-9_]+$/.test(own)) return own;
  const opening = /^([A-Z][A-Z0-9_]{2,}):/.exec((error as Error | undefined)?.message ?? "")?.[1];
  return opening ?? STATUS_CODES[status] ?? (status >= 500 ? "INTERNAL" : "INVALID_REQUEST");
}

/** The status to answer an error with: its own, else 503 (retry) when the database is unreachable, else `fallback`. */
export function errorStatus(error: unknown, fallback: number): number {
  const status = (error as { status?: unknown } | undefined)?.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) return status;
  return databaseUnavailable(error) ? 503 : fallback;
}

/** Read a request body as text, failing with 413 past `limit` bytes rather than buffering it all. */
export async function readText(body: AsyncIterable<Uint8Array> | null, limit: number) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of body ?? []) {
    bytes += chunk.length;
    if (bytes > limit) throw new HttpError(413, "Request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse a JSON body; an empty body is `empty` when given, and invalid otherwise. */
export async function readJson(body: AsyncIterable<Uint8Array> | null, limit: number, empty?: object) {
  const text = await readText(body, limit);
  if (!text && empty) return empty;
  try { return JSON.parse(text); }
  catch { throw new HttpError(400, "Invalid JSON"); }
}

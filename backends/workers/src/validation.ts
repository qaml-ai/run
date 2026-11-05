/** Deliberately small prototype contract; do not silently accept camelRun options. */
export class BadRequest extends Error {}

export function object(
  value: unknown,
  keys: string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequest("Expected a JSON object");
  const record = value as Record<string, unknown>;
  const unsupported = Object.keys(record).filter((key) => !keys.includes(key));
  if (unsupported.length)
    throw new BadRequest(`Unsupported field: ${unsupported.join(", ")}`);
  return record;
}

export function boundedText(value: unknown, name: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).length > max
  ) {
    throw new BadRequest(
      `${name} must be nonempty text of at most ${max} bytes`,
    );
  }
  return value;
}

export function agentId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value))
    throw new BadRequest("Invalid agent id");
  return value;
}

export function workspacePath(value: string): string {
  // Reject aliases rather than letting URL and filesystem normalization disagree.
  if (
    !value ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new BadRequest(
      "Expected a relative workspace file path without dot segments",
    );
  }
  return `/workspace/${value}`;
}

export async function body(
  request: Request,
  maxBytes = 32 * 1024,
  emptyObject = false,
): Promise<unknown> {
  if (!request.body) {
    if (emptyObject) return {};
    throw new BadRequest("Expected a JSON body");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new BadRequest("Request body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0 && emptyObject) return {};
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BadRequest("Invalid JSON");
  }
}

export async function authorized(
  request: Request,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret || secret.length < 32) return false;
  const received = request.headers.get("authorization");
  if (!received || received.length > 1024) return false;
  const encode = (text: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const [a, b] = await Promise.all([
    encode(received),
    encode(`Bearer ${secret}`),
  ]);
  const left = new Uint8Array(a),
    right = new Uint8Array(b);
  let different = 0;
  for (let index = 0; index < left.length; index++)
    different |= left[index] ^ right[index];
  return different === 0;
}

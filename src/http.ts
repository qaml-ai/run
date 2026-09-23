export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
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

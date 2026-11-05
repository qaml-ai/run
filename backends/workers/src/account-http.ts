import { HttpError } from "./errors.ts";
export { HttpError };

/** Same bounded read as src/http.ts, using Workers' Web stream iterator. */
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

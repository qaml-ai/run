export type CamelfsEnv = { CAMELFS_API_URL?: string; CAMELFS_API_TOKEN?: string };
export const camelfsConfigured = (env: CamelfsEnv): boolean => !!env.CAMELFS_API_URL && !!env.CAMELFS_API_TOKEN;
export type CamelfsFile = { path: string; sha256: string; size: number; key: string };
/** The lineage of a volume is stable across snapshots. */
export const volumeLineage = (tenant: string, volume: string): string => `${tenant}:${volume}`;

/** Bound daemon responses without putting their contents or credentials in errors. */
async function body(response: Response): Promise<unknown> {
  const bad = () => new Error(`camelFS status ${response.status}: malformed or oversized body`);
  const reader = response.body?.getReader();
  if (!reader) throw bad();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); throw bad(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw bad(); }
  finally { reader.releaseLock(); }
}

/** Import references first; only blobs the lineage lacks cross the network, in bounded batches. */
export async function importTree(env: CamelfsEnv, input: {
  lineage: string; parentTree?: string; files: CamelfsFile[];
  read: (file: CamelfsFile) => Promise<{ body: ReadableStream<Uint8Array> | Uint8Array; size: number }>;
}, fetcher: typeof fetch = fetch): Promise<{ tree: string; uploaded: number }> {
  if (!camelfsConfigured(env)) throw new Error("camelFS is not configured");
  const url = env.CAMELFS_API_URL!.replace(/\/+$/, ""), authorization = `Bearer ${env.CAMELFS_API_TOKEN}`;
  const byHash = new Map(input.files.map(file => [file.sha256, file]));
  const files = Object.fromEntries(input.files.map(file => [file.path, { sha256: file.sha256 }]));
  let uploaded = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetcher(`${url}/v0/trees`, {
      method: "POST", headers: { authorization, "content-type": "application/json" }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ lineage: input.lineage, ...(input.parentTree ? { parentTree: input.parentTree } : {}), files }),
    });
    const value = await body(response) as { tree?: unknown; missing?: unknown } | null;
    const bad = () => new Error(`camelFS status ${response.status}: invalid tree import response`);
    if (response.status === 200) {
      if (typeof value?.tree !== "string" || !/^[0-9a-f]{40}$/.test(value.tree)) throw bad();
      return { tree: value.tree, uploaded };
    }
    if (response.status !== 409 || attempt === 2 || !Array.isArray(value?.missing)) throw bad();
    const missing = [...new Set(value.missing)];
    if (missing.some(hash => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash) || !byHash.has(hash))) throw bad();
    for (let i = 0; i < missing.length; i += 8) {
      await Promise.all(missing.slice(i, i + 8).map(async hash => {
        const { body, size } = await input.read(byHash.get(hash)!);
        const put = await fetcher(`${url}/v0/blobs/${hash}?lineage=${encodeURIComponent(input.lineage)}`, {
          method: "PUT", headers: { authorization, "content-type": "application/octet-stream", "content-length": String(size) },
          signal: AbortSignal.timeout(60_000), body,
          ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
        });
        await put.body?.cancel();
        if (put.status !== 200 && put.status !== 201) throw new Error(`camelFS status ${put.status}: blob upload failed`);
        uploaded++;
      }));
    }
  }
  throw new Error("camelFS status 409: tree import retries exhausted");
}

export type CamelfsEnv = { CAMELFS?: { fetch(input: Request | string, init?: RequestInit): Promise<Response> }; CAMELFS_API_TOKEN?: string };
export const camelfsConfigured = (env: CamelfsEnv): boolean => !!env.CAMELFS && !!env.CAMELFS_API_TOKEN;
export type CamelfsFile = { path: string; sha256: string; size: number; key: string };
/** The lineage of a volume is stable across snapshots. */
export const volumeLineage = (tenant: string, volume: string): string => `${tenant}:${volume}`;

/** A blob upload's deadline (ledger L26): 60 s plus the time to send it at 2 MiB/s, at most 30 minutes. */
export function uploadTimeoutMs(size: number): number {
  return Math.min(60_000 + Math.ceil(size / (2 * 2 ** 20)) * 1000, 30 * 60_000);
}

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

/** Import references first; only blobs the lineage lacks cross the network, in bounded batches.
 * Bounded by the source Volume's own limits (VOLUME_LIMITS: files, fileBytes); camelFS adds none (ledger L28).
 */
export async function importTree(env: CamelfsEnv, input: {
  lineage: string; parentTree?: string; files: CamelfsFile[];
  read: (file: CamelfsFile) => Promise<{ body: ReadableStream<Uint8Array> | Uint8Array; size: number }>;
}, fetcher?: NonNullable<CamelfsEnv["CAMELFS"]>["fetch"]): Promise<{ tree: string; uploaded: number }> {
  if (!camelfsConfigured(env)) throw new Error("camelFS is not configured");
  const request = fetcher ?? ((input, init) => env.CAMELFS!.fetch(input, init));
  const authorization = `Bearer ${env.CAMELFS_API_TOKEN}`;
  const byHash = new Map(input.files.map(file => [file.sha256, file]));
  // camelFS paths are relative ("src/a.ts"); a Volume's are absolute ("/src/a.ts").
  const files = Object.fromEntries(input.files.map(file => [file.path.replace(/^\/+/, ""), { sha256: file.sha256 }]));
  let uploaded = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request("http://camelfs/v0/trees", {
      method: "POST", headers: { authorization, "content-type": "application/json" }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ lineage: input.lineage, ...(input.parentTree ? { parentTree: input.parentTree } : {}), files }),
    });
    const value = await body(response) as { tree?: unknown; missing?: unknown; error?: unknown; detail?: unknown } | null;
    // The daemon's error code (its shape checked) and detail (the token cut out, printable, bounded) say why it refused.
    const code = typeof value?.error === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value.error) ? value.error : "";
    const detail = typeof value?.detail === "string" ? value.detail.split(env.CAMELFS_API_TOKEN!).join("***").replace(/[^\x20-\x7e]/g, "").slice(0, 160) : "";
    const said = [code, detail].filter(Boolean).join(": ").split(env.CAMELFS_API_TOKEN!).join("***");
    const bad = () => new Error(`camelFS status ${response.status}: ${said || "invalid tree import response"}`);
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
        const put = await request(`http://camelfs/v0/blobs/${hash}?lineage=${encodeURIComponent(input.lineage)}`, {
          method: "PUT", headers: { authorization, "content-type": "application/octet-stream", "content-length": String(size) },
          signal: AbortSignal.timeout(uploadTimeoutMs(size)), body,
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

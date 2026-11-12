// The Workers shape: one Durable Object per lineage (`LINEAGE`), its SQLite holding refs/trees/commits/index/working
// layer, R2 (`BUCKET`, prefix per lineage) holding blobs and the tree mirror. Every response carries `x-do-ms`, the
// object's own time, so the bench can separate it from the harness's HTTP hop.
import { DurableObject } from "cloudflare:workers";
import { MerkleStore, StoreError, type Blobs, type RefKind, type Sql } from "./store.ts";

type Env = { LINEAGE: DurableObjectNamespace<Lineage>; BUCKET: R2Bucket };

export default {
  async fetch(request: Request, env: Env) {
    const m = /^\/l\/([^/]+)(\/.*)$/.exec(new URL(request.url).pathname);
    if (!m) return new Response("not found", { status: 404 });
    return env.LINEAGE.getByName(m[1]).fetch(request);
  },
};

export class Lineage extends DurableObject<Env> {
  private store: MerkleStore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql: Sql = {
      exec: <T>(q: string, ...p: unknown[]) => ctx.storage.sql.exec(q, ...p).toArray() as T[],
      txn: (fn) => ctx.storage.transactionSync(fn),
    };
    const prefix = `${ctx.id.toString()}/`;
    const r2: Blobs = {
      async get(key) { const o = await env.BUCKET.get(prefix + key); return o ? new Uint8Array(await o.arrayBuffer()) : null; },
      async put(key, bytes) { await env.BUCKET.put(prefix + key, bytes); },
      async delete(keys) { await env.BUCKET.delete(keys.map((k) => prefix + k)); },
    };
    this.store = new MerkleStore(sql, r2);
  }

  async fetch(request: Request): Promise<Response> {
    const t0 = performance.now();
    try {
      const out = await this.route(request);
      const res = out instanceof Response ? out : Response.json(out);
      res.headers.set("x-do-ms", (performance.now() - t0).toFixed(2));
      return res;
    } catch (e) {
      const status = e instanceof StoreError ? e.status : 500;
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
    }
  }

  private async route(request: Request): Promise<unknown> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").slice(3).map(decodeURIComponent); // after /l/:lineage
    const q = url.searchParams, s = this.store, method = request.method;
    const [head, name, action, ...rest] = parts;
    if (head === "volumes" && method === "POST") return s.createVolume(name);
    if (head === "objects" && method === "POST") return this.objects(new Uint8Array(await request.arrayBuffer()));
    if (head === "gc" && method === "POST") return s.gc({ graceMs: q.has("graceMs") ? Number(q.get("graceMs")) : undefined }); // override: bench only
    if (head === "stats") return { ...s.stats(), io: s.io };
    if (head === "owners" && method === "DELETE") { s.deleteOwned(name); return { ok: true }; }
    if (head !== "refs") throw new StoreError("no route", 404);
    if (!action) {
      if (method === "DELETE") { s.deleteRef(name); return { ok: true }; }
      return { ...s.ref(name), dirty: s.dirty(name) };
    }
    if (action === "files") {
      const path = rest.join("/");
      if (method === "PUT") return { sha: await s.write(name, path, new Uint8Array(await request.arrayBuffer())) };
      if (method === "DELETE") { s.remove(name, path); return { ok: true }; }
      const bytes = await s.read(name, path);
      return bytes ? new Response(bytes) : new Response("not found", { status: 404 });
    }
    if (action === "import" && method === "POST") return this.import(name, new Uint8Array(await request.arrayBuffer()));
    if (action === "checkpoint" && method === "POST") return s.checkpoint(name, q.get("message") ?? undefined);
    if (action === "fork" && method === "POST")
      return s.fork(name, q.get("name")!, { kind: (q.get("kind") as RefKind) ?? "fork", owner: q.get("owner") ?? undefined, expiresAt: q.has("expiresAt") ? Number(q.get("expiresAt")) : undefined });
    if (action === "merge" && method === "POST") return s.merge(name, q.get("from")!);
    if (action === "diff") return s.diff(q.get("from")!, s.ref(name).root);
    throw new StoreError("no route", 404);
  }

  /** Many files in one request: [u16 path length][path][u32 size][bytes]... into the ref's working layer. */
  private async import(ref: string, body: Uint8Array) {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const files: { path: string; bytes: Uint8Array }[] = [];
    for (let i = 0; i < body.length;) {
      const n = view.getUint16(i); const path = new TextDecoder().decode(body.subarray(i + 2, i + 2 + n)); i += 2 + n;
      const size = view.getUint32(i); files.push({ path, bytes: body.subarray(i + 4, i + 4 + size) }); i += 4 + size;
    }
    let next = 0;
    await Promise.all(Array.from({ length: 32 }, async () => { while (next < files.length) { const f = files[next++]; await this.store.write(ref, f.path, f.bytes); } }));
    return { files: files.length };
  }

  /**
   * The materializer's one call: [20-byte sha]... in, [20-byte sha][u8 type: 0 missing, 1 tree, 2 blob][u32 size][bytes]
   * out. Trees come from SQLite (no R2 round trip), blobs from R2, 32 at a time.
   */
  private async objects(body: Uint8Array) {
    const shas: string[] = [];
    for (let i = 0; i + 20 <= body.length; i += 20) shas.push([...body.subarray(i, i + 20)].map((b) => b.toString(16).padStart(2, "0")).join(""));
    const out: Uint8Array[] = new Array(shas.length);
    let next = 0;
    await Promise.all(Array.from({ length: 32 }, async () => {
      while (next < shas.length) {
        const i = next++, sha = shas[i];
        const tree = this.store.treeBody(sha);
        let type = 1, bytes: Uint8Array | null = tree;
        if (!bytes) { type = 2; bytes = await this.store.getBlob(sha).catch(() => null); }
        if (!bytes) type = 0;
        const frame = new Uint8Array(25 + (bytes?.length ?? 0));
        for (let k = 0; k < 20; k++) frame[k] = parseInt(sha.slice(k * 2, k * 2 + 2), 16);
        frame[20] = type; new DataView(frame.buffer).setUint32(21, bytes?.length ?? 0);
        if (bytes) frame.set(bytes, 25);
        out[i] = frame;
      }
    }));
    return new Response(new Blob(out as BlobPart[]));
  }
}

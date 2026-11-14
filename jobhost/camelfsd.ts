import { createServer, request } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Transform } from "node:stream";

export type CamelfsMount = { image: string; warm: boolean; root: string; tree: string; mountMs: number; hydrating: boolean };
export type CamelfsCheckpoint = { commit: string; root: string; tree: string; parentRoot: string; changedChunks: number; uploadedChunks: number; changedBytes: number; reflinkMs: number; fiemapMs: number; hashMs: number; uploadMs: number; checkpointMs: number; wallMs?: number; imageMs?: number };
export type CamelfsCommit = { message?: string; trailers?: { agent?: string; run?: string; turn?: string; job?: string; kind: "auto" | "manual" | "job"; exitCode?: number } };
export interface Camelfsd {
  // Older daemon adapters can mount and apply without supporting checkpoints.
  checkpoint?(jobId: string, timeoutMs: number, commit?: CamelfsCommit): Promise<CamelfsCheckpoint>;
  mount(input: { jobId: string; lineage: string; tree: string; parent?: string; fence?: { holder: string; epoch: number }; vsock: string }): Promise<CamelfsMount>;
  heartbeat?(jobId: string): Promise<void>;
  release(jobId: string): Promise<void>;
  health(): Promise<{ ok: boolean; version: string; data: string; store: string; hostId: string }>;
  status(jobId: string): Promise<{ state: string; image: string; root: string; hydratedRegions: number; totalRegions: number; leaseEpoch: number }>;
}

/** The daemon owns storage; the host only passes its opaque image path to the VM. */
export function camelfsdClient(socketPath: string): Camelfsd & Required<Pick<Camelfsd, "checkpoint" | "heartbeat">> {
  const call = (method: string, path: string, input?: unknown, timeoutMs = 120_000): Promise<unknown> => new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: input === undefined ? {} : { "content-type": "application/json" } });
    // A wall-clock deadline also bounds a daemon that keeps trickling bytes.
    const timer = setTimeout(() => req.destroy(new Error(`camelfsd request timed out after ${timeoutMs / 1000} s`)), timeoutMs);
    const fail = (error: Error) => { clearTimeout(timer); reject(error); };
    req.on("error", fail);
    req.on("response", res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("error", fail);
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) { req.destroy(new Error("camelfsd response exceeds 1 MiB")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString("utf8"), status = res.statusCode ?? 500;
        let body: unknown;
        try { body = text ? JSON.parse(text) : undefined; } catch { /* errors may have no JSON body */ }
        if (method === "DELETE" && status === 404) { resolve(undefined); return; }
        if (status < 200 || status >= 300) {
          const { error, detail } = (body ?? {}) as { error?: unknown; detail?: unknown };
          const message = [error, detail].filter(value => value !== undefined).map(value => typeof value === "string" ? value : JSON.stringify(value)).join(": ").slice(0, 300);
          reject(new Error(`camelfsd ${status}${message ? `: ${message}` : ""}`));
        } else if (text && body === undefined) reject(new Error("camelfsd returned invalid JSON"));
        else resolve(body);
      });
    });
    req.end(input === undefined ? undefined : JSON.stringify(input));
  });
  const jobId = (id: string) => {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(id)) throw new Error("Invalid camelFS job id");
    return encodeURIComponent(id);
  };
  return {
    checkpoint: async (id, timeoutMs, commit) => await call("POST", `/v0/mounts/${jobId(id)}/checkpoint`, { timeoutMs, ...commit }, timeoutMs + 30_000) as CamelfsCheckpoint,
    heartbeat: async id => { await call("POST", `/v0/mounts/${jobId(id)}/heartbeat`, {}); },
    health: async () => await call("GET", "/v0/health") as { ok: boolean; version: string; data: string; store: string; hostId: string },
    mount: async input => { jobId(input.jobId); return await call("POST", "/v0/mounts", input) as CamelfsMount; },
    release: async id => { await call("DELETE", `/v0/mounts/${jobId(id)}`); },
    status: async id => await call("GET", `/v0/mounts/${jobId(id)}`) as { state: string; image: string; root: string; hydratedRegions: number; totalRegions: number; leaseEpoch: number },
  };
}

/** Only the import API crosses this listener: mount and release stay local to the host. */
export async function serveImportProxy(options: { socketPath: string; token: string; host: string; port: number }): Promise<{ port: number; close(): Promise<void> }> {
  const expected = Buffer.from(`Bearer ${options.token}`), max = 512 * 1024 * 1024;
  const server = createServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const refuse = (status: number) => {
      if (res.headersSent) res.destroy();
      else { res.writeHead(status, { connection: "close" }); res.end(); }
      req.resume();
    };
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { refuse(401); return; }
    const path = req.url ?? "";
    let url: URL;
    try { url = new URL(path, "http://localhost"); } catch { refuse(404); return; }
    if (!(req.method === "POST" && path === "/v0/trees") &&
        !(req.method === "PUT" && /^\/v0\/blobs\/[a-fA-F0-9]{64}$/.test(path.split("?")[0]!) && url.searchParams.has("lineage"))) { refuse(404); return; }
    if (Number(req.headers["content-length"] ?? 0) > max) { refuse(413); return; }
    // The daemon needs a blob's length up front (it refuses a chunked body): pass content-length on, and content-type.
    const length = req.headers["content-length"];
    const upstream = request({ socketPath: options.socketPath, method: req.method, path, headers: {
      ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
      ...(length !== undefined && /^\d{1,15}$/.test(length) ? { "content-length": length } : {}),
    } });
    let size = 0, tooLarge = false;
    const limit = new Transform({ transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > max) {
        tooLarge = true; req.unpipe(limit); req.resume(); upstream.destroy(); refuse(413); done(); return;
      }
      done(null, chunk);
    } });
    upstream.on("error", () => { if (tooLarge) return; if (res.headersSent) res.destroy(); else { res.writeHead(502); res.end(); } });
    upstream.on("response", response => {
      if (tooLarge) { response.destroy(); return; }
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.on("error", () => res.destroy());
      response.pipe(res);
    });
    req.on("aborted", () => upstream.destroy());
    req.on("error", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(limit).pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, () => { server.removeListener("error", reject); resolve(); }); });
  return { port: (server.address() as { port: number }).port, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}

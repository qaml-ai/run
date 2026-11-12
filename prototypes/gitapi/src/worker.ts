// Worker + one Durable Object per repo. The object owns refs, the object index and tree/commit bytes (SQLite) and
// serialises writers; blob bytes and clone packs are R2. The Worker is the stateless front: routing, auth (not in
// the prototype) and streaming pack bytes from R2.
import { DurableObject } from "cloudflare:workers";
import { RepoCore, type Sql } from "./repo.ts";
import { handle, rethrowable, type RepoApi, type StreamBucket } from "./http.ts";

export interface Env { REPOS: DurableObjectNamespace<GitApiRepo>; BUCKET: R2Bucket }

function r2Bucket(r2: R2Bucket): StreamBucket {
  return {
    async put(key, bytes) { await r2.put(key, bytes); },
    async get(key, range) { const o = await r2.get(key, range ? { range } : undefined); return o ? new Uint8Array(await o.arrayBuffer()) : null; },
    async delete(keys) { for (let i = 0; i < keys.length; i += 1000) if (keys.slice(i, i + 1000).length) await r2.delete(keys.slice(i, i + 1000)); },
    async getStream(key) { return (await r2.get(key))?.body ?? null; },
    async putStream(key, stream, length) { const f = new FixedLengthStream(length); await Promise.all([stream.pipeTo(f.writable), r2.put(key, f.readable)]); },
  };
}

const WRITES = new Set(["commit", "merge", "gc", "destroy", "createBranch", "extendBranch", "wtWrite", "checkpoint"]);

export class GitApiRepo extends DurableObject<Env> {
  private core?: RepoCore;
  private lock: Promise<unknown> = Promise.resolve();
  private open(name: string) {
    if (!this.core) {
      const sql: Sql = { exec: (q, ...p) => this.ctx.storage.sql.exec(q, ...p).toArray() as never, tx: (fn) => this.ctx.storage.transactionSync(fn) };
      this.core = new RepoCore(sql, r2Bucket(this.env.BUCKET), `gitapi/${name}`);
      if (this.ctx.storage.kv.get("name") !== name) this.ctx.storage.kv.put("name", name);
    }
    return this.core;
  }
  /** One RPC entry point: `method(...args)` on the repo's core, writers one at a time. */
  async call(name: string, method: keyof RepoCore, args: unknown[]): Promise<unknown> {
    const core = this.open(name);
    const run = async () => {
      try {
        const result = await (core[method] as (...a: unknown[]) => unknown).apply(core, args);
        if (method === "createBranch" || method === "extendBranch") await this.armAlarm();
        return result;
      } catch (e) { rethrowable(e); }
    };
    if (!WRITES.has(method)) return run();
    const next = this.lock.then(run, run);
    this.lock = next.catch(() => undefined);
    return next;
  }
  private async armAlarm() {
    const next = this.core!.nextExpiry();
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
  /** Ephemeral branches expire here; a GC follows so their objects go with them. */
  async alarm() {
    const name = (this.ctx.storage.kv.get("name") as string | undefined) ?? "unknown";
    const core = this.open(name);
    const run = async () => { const { expired, next } = core.expire(); if (expired.length) await core.gc({ graceMs: 60_000 }); if (next !== null) await this.ctx.storage.setAlarm(next); };
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => undefined);
    await p;
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const repoOf = (name: string): RepoApi => {
      const stub = env.REPOS.getByName(name);
      return new Proxy({}, { get: (_t, method: string) => (...args: unknown[]) => stub.call(name, method as keyof RepoCore, args) }) as RepoApi;
    };
    return handle(request, repoOf, r2Bucket(env.BUCKET), (p) => ctx.waitUntil(p));
  },
} satisfies ExportedHandler<Env>;

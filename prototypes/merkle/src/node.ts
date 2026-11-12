// The Node / self-host backend of the same store: node:sqlite for the tables and a directory (or any S3 bucket
// behind the same three calls) for the objects. The store has no Workers dependency, so camelRun's Node backend and a
// self-hosted install run the identical code the Durable Object runs.
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Blobs, Sql } from "./store.ts";

export function nodeSql(path = ":memory:"): Sql & { db: DatabaseSync } {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  let depth = 0;
  return {
    db,
    exec<T>(query: string, ...params: unknown[]) { return db.prepare(query).all(...(params as never[])) as T[]; },
    txn<T>(fn: () => T): T {
      if (depth++) try { return fn(); } finally { depth--; }
      db.exec("BEGIN");
      try { const out = fn(); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } finally { depth--; }
    },
  };
}

export function dirBlobs(root: string): Blobs {
  const path = (key: string) => join(root, key.slice(0, 4), key.slice(4));
  return {
    async get(key) { try { return new Uint8Array(await readFile(path(key))); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } },
    async put(key, bytes) { const p = path(key); await mkdir(dirname(p), { recursive: true }); await writeFile(`${p}.tmp`, bytes); await rename(`${p}.tmp`, p); },
    async delete(keys) { await Promise.all(keys.map((k) => rm(path(k), { force: true }))); },
  };
}

/** An in-memory bucket for tests, which can hold a delete in flight to exercise the collector's races. */
export function memoryBlobs() {
  const map = new Map<string, Uint8Array>();
  let gate: Promise<void> | null = null;
  const blobs: Blobs & { map: Map<string, Uint8Array>; holdDeletes(): () => void } = {
    map,
    async get(key) { return map.get(key) ?? null; },
    async put(key, bytes) { await Promise.resolve(); map.set(key, bytes); },
    async delete(keys) { if (gate) await gate; for (const k of keys) map.delete(k); },
    holdDeletes() { let release!: () => void; gate = new Promise((r) => (release = r)); return () => { gate = null; release(); }; },
  };
  return blobs;
}

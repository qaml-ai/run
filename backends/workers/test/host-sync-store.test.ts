import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HostSyncStore } from "../src/jobs/host-sync-store.ts";

function sql(db = new DatabaseSync(":memory:")) {
  return { exec(query: string, ...args: any[]) { const rows = db.prepare(query).all(...args) as any[]; return Object.assign(rows[Symbol.iterator](), { toArray: () => rows, one: () => rows[0] }); } } as unknown as SqlStorage;
}

test("a manifest of 100,000 files is rows: stored, and each file read by its own index", () => {
  const store = new HostSyncStore(sql());
  const files = Array.from({ length: 100_000 }, (_, index) => ({ path: `src/f${index}.ts`, size: index, sha256: "a".repeat(64), key: `files/t/v/${index}` }));
  assert.equal(store.put("t0ken", 2_000, files), 100_000);
  assert.deepEqual(store.file("t0ken", 99_999, 1_000), { ok: true, size: 99_999, key: "files/t/v/99999" });
  assert.deepEqual(store.file("t0ken", 0, 1_000), { ok: true, size: 0, key: "files/t/v/0" });
  assert.deepEqual(store.file("t0ken", 100_000, 1_000), { ok: false, status: 404 });
});

test("the token is the job's alone, while it lasts; a new record replaces the old, and clear ends it", () => {
  const store = new HostSyncStore(sql());
  store.put("first", 2_000, [{ path: "a", size: 1, sha256: "b".repeat(64), key: "k1" }]);
  assert.equal(store.file("wrong", 0, 1_000).ok, false);
  assert.deepEqual(store.file("wrong", 0, 1_000), { ok: false, status: 401 }, "a wrong token learns nothing, not even whether the file exists");
  assert.deepEqual(store.file("first", 0, 2_000), { ok: false, status: 401 }, "expired");
  store.put("second", 3_000, [{ path: "a", size: 2, sha256: "c".repeat(64), key: "k2" }]);
  assert.deepEqual(store.file("first", 0, 1_000), { ok: false, status: 401 }, "a run made again replaces the token");
  assert.deepEqual(store.file("second", 0, 1_000), { ok: true, size: 2, key: "k2" });
  store.clear();
  assert.deepEqual(store.file("second", 0, 1_000), { ok: false, status: 401 });
});

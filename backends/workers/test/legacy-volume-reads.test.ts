import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { memoryStorage } from "../../../shared/storage.ts";
import { postgresTail } from "../../../src/log-tail.ts";
import { VolumeService } from "../../../src/volumes.ts";
import { testDatabase } from "../../../tests/database.ts";
import { legacyVolumeReadRoute, serveLegacyVolumeRead } from "../src/legacy-volume-reads.ts";

test("the Worker can read a legacy volume and its existing snapshot without owning it", async t => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db, { unfenced: true }));
  const volumes = new VolumeService({ db, storage });
  t.after(() => volumes.close());
  const tenant = "acme";
  const { id: volume } = await volumes.create(tenant, { name: "builder draft" });
  const original = await volumes.put(tenant, volume, "/README.md", Buffer.from("hello old"));
  const binary = Buffer.from([0, 254, 255]);
  await volumes.put(tenant, volume, "/media/a.bin", binary);
  const snapshot = await volumes.call(volume, tenant, "snapshot", { name: "release", pinned: true, labels: { release: "v1" } });
  await volumes.call(volume, tenant, "snapshot", { name: "file-arg:scratch", directory: "/", limit: { files: 10, bytes: 100 } });
  const current = await volumes.put(tenant, volume, "/README.md", Buffer.from("new draft"), { ifMatch: original.version });
  const read = (path: string, headers?: HeadersInit, as = tenant) =>
    serveLegacyVolumeRead(new Request(`https://run.example/v1/volumes${path}`, { headers }), as, db, storage);

  assert.equal(legacyVolumeReadRoute(new Request(`https://run.example/v1/volumes/${volume}/files/README.md`)), true);
  assert.equal(legacyVolumeReadRoute(new Request(`https://run.example/v1/volumes/${volume}/files/README.md`, { method: "PUT", body: "write" })), false);
  assert.deepEqual(await (await read(`/${volume}`)).json(), await volumes.call(volume, tenant, "info"));
  assert.deepEqual(await (await read(`/${volume}/snapshots?label=release:v1`)).json(), [snapshot]);
  assert.deepEqual(await (await read(`/${volume}/snapshots`)).json(), [snapshot]);
  assert.deepEqual(await (await read(`/${volume}/snapshots?label=release:v2`)).json(), []);

  const first = await (await read(`/${volume}/files?snapshot=${snapshot.id}&limit=1`)).json();
  assert.deepEqual(first.files.map((file: { path: string }) => file.path), ["/README.md"]);
  assert.equal(first.next, "/README.md");
  assert.equal("chunks" in first.files[0], false);
  const next = await (await read(`/${volume}/files?snapshot=${snapshot.id}&after=${encodeURIComponent(first.next)}&limit=1`)).json();
  assert.deepEqual(next.files.map((file: { path: string }) => file.path), ["/media/a.bin"]);
  assert.equal(next.next, undefined);

  const live = await read(`/${volume}/files/README.md`);
  assert.equal(live.headers.get("X-File-Version"), String(current.version));
  assert.equal(await live.text(), "new draft");
  const partial = await read(`/${volume}/files/README.md?snapshot=${snapshot.id}`, { range: "bytes=6-" });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("X-File-Version"), String(original.version));
  assert.equal(partial.headers.get("Content-Range"), "bytes 6-8/9");
  assert.equal(await partial.text(), "old");

  const all = await (await read(`/${volume}/files?snapshot=${snapshot.id}&content=true`)).json();
  assert.equal(all.snapshot, snapshot.id);
  assert.equal(all.seq, snapshot.seq);
  assert.equal(all.files[0].text, "hello old");
  assert.equal(all.files[1].data, binary.toString("base64"));
  assert.equal(all.files[1].sha256, createHash("sha256").update(binary).digest("hex"));
  await assert.rejects(read(`/${volume}/files?snapshot=${snapshot.id}&content=true`, undefined, "another"), { status: 404 });
  await assert.rejects(read(`/${volume}/files/media`), { status: 404 });
  await assert.rejects(read(`/${volume}/files?content=false`), { status: 400 });
});

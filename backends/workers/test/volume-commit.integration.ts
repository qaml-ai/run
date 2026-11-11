import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";
const token = "local-integration-only-token-with-at-least-32-characters";
const DAY = 86_400_000;

test("atomic volume commits and fork pins that live with the fork", { timeout: 240_000 }, async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  const call = (path: string, options: RequestInit = {}) =>
    fetch(fixture.worker.url + path, {
      ...options,
      headers: { authorization: `Bearer ${token}`, ...options.headers },
      signal: AbortSignal.timeout(30_000),
    });
  const post = (path: string, body: unknown) =>
    call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const created = async (name: string) => {
    const response = await post("/v1/volumes", { name });
    assert.equal(response.status, 201, await response.clone().text());
    return ((await response.json()) as { id: string }).id;
  };
  const put = async (volume: string, path: string, body: string, version?: number) => {
    const response = await call(`/v1/volumes/${volume}/files${path}`, {
      method: "PUT",
      body,
      headers: { "content-type": "text/plain", ...(version === undefined ? {} : version === 0 ? { "if-none-match": "*" } : { "if-match": String(version) }) },
    });
    return response;
  };
  const text = async (volume: string, path: string) => {
    const response = await call(`/v1/volumes/${volume}/files${path}`);
    return response.status === 200 ? await response.text() : response.status;
  };
  const commit = (volume: string, body: unknown) => post(`/v1/volumes/${volume}/commit`, body);
  const gc = async (volume: string, advance = 0) =>
    (await (await call(`/v1/volumes/${volume}/__gc?advance=${advance}`, { method: "POST" })).json()) as { removed: number; held: number; candidates: number };
  try {
    const base = await created("commit base");

    await t.test("a commit writes and removes every file together, at new versions", async () => {
      const first = await commit(base, {
        files: [
          { path: "/src/a.ts", version: 0, text: "a1" },
          { path: "/src/b.ts", version: 0, data: Buffer.from("b1").toString("base64"), contentType: "text/plain" },
          { path: "/old.txt", version: 0, text: "old" },
        ],
      });
      assert.equal(first.status, 200, await first.clone().text());
      const body = (await first.json()) as { seq: number; files: { path: string; version: number; contentType: string }[]; removed: string[] };
      assert.deepEqual(body.files.map((f) => f.path), ["/src/a.ts", "/src/b.ts", "/old.txt"]);
      assert.equal(new Set(body.files.map((f) => f.version)).size, 3);
      assert.equal(body.seq, Math.max(...body.files.map((f) => f.version)));
      assert.equal(body.files[1].contentType, "text/plain");
      assert.equal("key" in body.files[0], false);
      const old = body.files[2].version;
      const second = await commit(base, {
        files: [
          { path: "/old.txt", version: old, delete: true },
          // The removed file's path becomes a directory in the same commit.
          { path: "/old.txt/inside.txt", version: 0, text: "inside" },
        ],
      });
      assert.equal(second.status, 200, await second.clone().text());
      assert.deepEqual(((await second.json()) as { removed: string[] }).removed, ["/old.txt"]);
      assert.equal(await text(base, "/old.txt/inside.txt"), "inside");
      assert.equal(await text(base, "/src/a.ts"), "a1");
    });

    await t.test("a conflict writes nothing and names each stale path with its head version", async () => {
      const a = ((await (await call(`/v1/volumes/${base}/files?prefix=/src`)).json()) as { files: { path: string; version: number }[] }).files;
      const versionOf = (path: string) => a.find((f) => f.path === path)!.version;
      const before = ((await (await call(`/v1/volumes/${base}`)).json()) as { seq: number }).seq;
      const response = await commit(base, {
        files: [
          { path: "/src/a.ts", version: versionOf("/src/a.ts"), text: "a2" },
          { path: "/src/b.ts", version: versionOf("/src/b.ts") - 1, text: "b2" },
          { path: "/src/c.ts", version: 7, text: "c" },
          { path: "/src/new.ts", version: 0, text: "new" },
        ],
        snapshot: { name: "never" },
      });
      assert.equal(response.status, 409);
      const body = (await response.json()) as { code: string; conflicts: { path: string; headVersion: number }[] };
      assert.equal(body.code, "COMMIT_CONFLICT");
      assert.deepEqual(body.conflicts, [
        { path: "/src/b.ts", headVersion: versionOf("/src/b.ts") },
        { path: "/src/c.ts", headVersion: 0 },
      ]);
      assert.equal(await text(base, "/src/a.ts"), "a1");
      assert.equal(await text(base, "/src/new.ts"), 404);
      assert.equal(((await (await call(`/v1/volumes/${base}`)).json()) as { seq: number }).seq, before);
      assert.equal(((await (await call(`/v1/volumes/${base}/snapshots`)).json()) as unknown[]).length, 0);
    });

    await t.test("a snapshot on success holds exactly the commit", async () => {
      const head = ((await (await call(`/v1/volumes/${base}/files?prefix=/src/a.ts`)).json()) as { files: { version: number }[] }).files[0].version;
      const response = await commit(base, {
        files: [{ path: "/src/a.ts", version: head, text: "a3" }],
        snapshot: { name: "release 1", pinned: true, labels: { release: "1" } },
      });
      assert.equal(response.status, 200, await response.clone().text());
      const body = (await response.json()) as { seq: number; snapshot: { id: string; seq: number; pinned: boolean; labels: Record<string, string> } };
      assert.equal(body.snapshot.seq, body.seq);
      assert.equal(body.snapshot.pinned, true);
      assert.deepEqual(body.snapshot.labels, { release: "1" });
      await put(base, "/src/a.ts", "after the snapshot");
      assert.equal(await (await call(`/v1/volumes/${base}/files/src/a.ts?snapshot=${body.snapshot.id}`)).text(), "a3");
      const bad = await commit(base, { files: [{ path: "/src/z.ts", version: 0, text: "z" }], snapshot: { name: "" } });
      assert.equal(bad.status, 400);
      assert.equal(await text(base, "/src/z.ts"), 404);
    });

    await t.test("concurrent commits: the same file has one winner, different files all land", async () => {
      const seed = await put(base, "/race.txt", "0", 0);
      const version = ((await seed.json()) as { version: number }).version;
      const same = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          commit(base, { files: [{ path: "/race.txt", version, text: `writer ${i}` }, { path: `/race-side-${i}.txt`, version: 0, text: "side" }] }),
        ),
      );
      assert.deepEqual(same.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409]);
      const winner = same.findIndex((r) => r.status === 200);
      assert.equal(await text(base, "/race.txt"), `writer ${winner}`);
      for (let i = 0; i < 6; i++) assert.equal(await text(base, `/race-side-${i}.txt`), i === winner ? "side" : 404);
      const different = await Promise.all(
        Array.from({ length: 6 }, (_, i) => commit(base, { files: [{ path: `/many/${i}.txt`, version: 0, text: String(i) }] })),
      );
      assert.deepEqual(different.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
      const versions = await Promise.all(different.map(async (r) => ((await r.json()) as { files: { version: number }[] }).files[0].version));
      assert.equal(new Set(versions).size, 6);
    });

    await t.test("plain writes interleaved with commits on one file: exactly one wins", async () => {
      const seed = await put(base, "/mixed.txt", "0", 0);
      const version = ((await seed.json()) as { version: number }).version;
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          i % 2
            ? put(base, "/mixed.txt", `put ${i}`, version).then((r) => r.status)
            : commit(base, { files: [{ path: "/mixed.txt", version, text: `commit ${i}` }] }).then((r) => r.status),
        ),
      );
      assert.equal(results.filter((s) => s === 200 || s === 201).length, 1, JSON.stringify(results));
      assert.ok(results.every((s) => [200, 201, 409, 412].includes(s)), JSON.stringify(results));
    });

    await t.test("a fork's changes commit onto its base from the fork", async () => {
      const forked = await post(`/v1/volumes/${base}/fork`, { name: "worker fork" });
      assert.equal(forked.status, 201, await forked.clone().text());
      const fork = ((await forked.json()) as { id: string }).id;
      const listed = ((await (await call(`/v1/volumes/${base}/files?prefix=/src`)).json()) as { files: { path: string; version: number }[] }).files;
      const b = listed.find((f) => f.path === "/src/b.ts")!;
      assert.equal(((await (await put(fork, "/src/b.ts", "b from fork", b.version)).json()) as { version: number }).version > b.version, true);
      await put(fork, "/src/fresh.ts", "fresh", 0);
      const landed = await commit(base, {
        files: [
          { path: "/src/b.ts", version: b.version, from: { volume: fork } },
          { path: "/src/fresh.ts", version: 0, from: { volume: fork } },
          // Unchanged in the fork: its content is the base's own, referred to again.
          { path: "/src/copy-of-a.ts", version: 0, from: { volume: fork, path: "/old.txt/inside.txt" } },
        ],
      });
      assert.equal(landed.status, 200, await landed.clone().text());
      // The fork goes; what was committed stays readable in the base, through collection.
      assert.equal((await call(`/v1/volumes/${fork}`, { method: "DELETE" })).status, 200);
      await gc(base);
      await gc(base, 2 * DAY);
      assert.equal(await text(base, "/src/b.ts"), "b from fork");
      assert.equal(await text(base, "/src/fresh.ts"), "fresh");
      assert.equal(await text(base, "/src/copy-of-a.ts"), "inside");
    });

    await t.test("a fork reads its base past a day, and deleting it releases the base", async () => {
      const source = await created("fork source");
      await put(source, "/keep.txt", "original", 0);
      const forked = await post(`/v1/volumes/${source}/fork`, {});
      assert.equal(forked.status, 201, await forked.clone().text());
      const fork = ((await forked.json()) as { id: string; files: number }).id;
      // The source moves on: its old blob is now held by nothing but the fork.
      await put(source, "/keep.txt", "changed");
      // Two collections two days apart: the first finds candidates, the second removes those still unheld.
      const first = await gc(source), second = await gc(source, 2 * DAY);
      assert.equal(first.removed + second.removed, 0);
      assert.equal(await text(fork, "/keep.txt"), "original");
      // A fork of the fork pins the same blob in the volume that owns it, so deleting the middle fork keeps it.
      const nested = ((await (await post(`/v1/volumes/${fork}/fork`, {})).json()) as { id: string }).id;
      assert.equal((await call(`/v1/volumes/${fork}`, { method: "DELETE" })).status, 200);
      await gc(source);
      assert.equal((await gc(source, 2 * DAY)).removed, 0);
      assert.equal(await text(nested, "/keep.txt"), "original");
      assert.equal((await call(`/v1/volumes/${nested}`, { method: "DELETE" })).status, 200);
      await gc(source);
      assert.equal((await gc(source, 2 * DAY)).removed, 1);
      assert.equal(await text(source, "/keep.txt"), "changed");
    });
  } catch (error) {
    t.diagnostic(fixture.worker.logs());
    throw error;
  }
});

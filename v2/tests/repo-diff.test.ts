import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CamelFsClient, CamelFsLsEntry, CamelFsReadResponse, CamelFsRefInfo } from "../worker/src/camelfs.ts";
import {
  computeRepoDiff,
  computeUnifiedDiff,
  validateRefName,
} from "../worker/src/lib/repo-diff.ts";
import { ApiError } from "../worker/src/types.ts";

describe("validateRefName", () => {
  it("accepts valid refs/* names", () => {
    assert.equal(validateRefName("refs/heads/main"), "refs/heads/main");
    assert.equal(validateRefName("refs/camel/live"), "refs/camel/live");
    assert.equal(validateRefName("refs/checkpoints/cp-123_v2.0"), "refs/checkpoints/cp-123_v2.0");
  });

  it("rejects invalid ref names with 400 ApiError", () => {
    const bad = [
      "",
      "main",
      "HEAD",
      "refs/",
      "refs/heads/a..b",
      "refs/heads/bad\nname",
      "refs/heads/bad\x00name",
      "refs/heads/with space",
      "refs/heads//double",
      "refs/heads/trailing/",
      "refs/heads/trailing.",
      "refs/heads/a~1",
      "refs/heads/a^2",
      "refs/heads/a:b",
      "refs/heads/a@{0}",
      " refs/heads/main",
      123,
      null,
    ];
    for (const candidate of bad) {
      assert.throws(
        () => validateRefName(candidate),
        (err: unknown) => err instanceof ApiError && err.status === 400,
        `expected 400 for ${JSON.stringify(candidate)}`,
      );
    }
  });
});

describe("computeUnifiedDiff", () => {
  it("produces clean unified diff hunks for modified, added, and deleted files", () => {
    const oldText = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n";
    const newText = "line1\nline2-edited\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10-edited\n";
    const mod = computeUnifiedDiff("src/app.ts", oldText, newText, 1);
    assert.equal(mod.additions, 2);
    assert.equal(mod.deletions, 2);
    assert.match(mod.patch, /^--- a\/src\/app\.ts\n\+\+\+ b\/src\/app\.ts\n/);
    assert.match(mod.patch, /@@ -1,3 \+1,3 @@/);
    assert.match(mod.patch, /-line2\n\+line2-edited/);
    assert.match(mod.patch, /@@ -9,2 \+9,2 @@/);
    assert.match(mod.patch, /-line10\n\+line10-edited/);

    const added = computeUnifiedDiff("new.txt", null, "hello\nworld\n", 3);
    assert.equal(added.additions, 2);
    assert.equal(added.deletions, 0);
    assert.match(added.patch, /^--- \/dev\/null\n\+\+\+ b\/new\.txt\n@@ -0,0 \+1,2 @@\n\+hello\n\+world\n$/);

    const deleted = computeUnifiedDiff("old.txt", "bye\n", null, 3);
    assert.equal(deleted.additions, 0);
    assert.equal(deleted.deletions, 1);
    assert.match(deleted.patch, /^--- a\/old\.txt\n\+\+\+ \/dev\/null\n@@ -1,1 \+0,0 @@\n-bye\n$/);
  });

  it("merges nearby hunks and handles contextLines = 0", () => {
    const oldText = "a\nb\nc\nd\ne\n";
    const newText = "a\nB\nc\nD\ne\n";
    const merged = computeUnifiedDiff("f.txt", oldText, newText, 3);
    assert.equal(merged.patch.match(/^@@ /gm)?.length, 1);

    const split = computeUnifiedDiff("f.txt", oldText, newText, 0);
    assert.equal(split.patch.match(/^@@ /gm)?.length, 2);
    assert.equal(split.additions, 2);
    assert.equal(split.deletions, 2);
  });
});

describe("computeRepoDiff", () => {
  const c1 = "a".repeat(64);
  const c2 = "b".repeat(64);
  const t1 = "1".repeat(64);
  const t2 = "2".repeat(64);

  function makeMockCfs() {
    const readCalls: Array<{ at: string; path: string }> = [];
    const lsCalls: Array<{ at: string; path?: string }> = [];
    const refs: CamelFsRefInfo[] = [
      { name: "refs/heads/main", commit: c2, tree: t2, updatedAt: 2 },
      { name: "refs/camel/live", commit: c1, tree: t1, updatedAt: 1 },
    ];
    const trees: Record<string, CamelFsLsEntry[]> = {
      [c1]: [
        { path: "unchanged.ts", type: "file", size: 20, mode: 0o644, hash: "hash_same" },
        { path: "app.ts", type: "file", size: 12, mode: 0o644, hash: "hash_app_v1" },
        { path: "removed.txt", type: "file", size: 8, mode: 0o644, hash: "hash_rem" },
        { path: "logo.png", type: "file", size: 100, mode: 0o644, hash: "hash_png_v1" },
      ],
      [c2]: [
        { path: "unchanged.ts", type: "file", size: 20, mode: 0o644, hash: "hash_same" },
        { path: "app.ts", type: "file", size: 14, mode: 0o644, hash: "hash_app_v2" },
        { path: "added.txt", type: "file", size: 10, mode: 0o644, hash: "hash_add" },
        { path: "logo.png", type: "file", size: 120, mode: 0o644, hash: "hash_png_v2" },
        { path: "data.dat", type: "file", size: 5, mode: 0o644, hash: "hash_bin_dat" },
      ],
    };
    const blobs: Record<string, Record<string, CamelFsReadResponse>> = {
      [c1]: {
        "app.ts": { commit: c1, path: "app.ts", size: 12, mode: 0o644, binary: false, content: "const x = 1;\n", base64: null },
        "removed.txt": { commit: c1, path: "removed.txt", size: 8, mode: 0o644, binary: false, content: "old line\n", base64: null },
      },
      [c2]: {
        "app.ts": { commit: c2, path: "app.ts", size: 14, mode: 0o644, binary: false, content: "const x = 2;\n", base64: null },
        "added.txt": { commit: c2, path: "added.txt", size: 10, mode: 0o644, binary: false, content: "brand new\n", base64: null },
        "data.dat": { commit: c2, path: "data.dat", size: 5, mode: 0o644, binary: true, content: null, base64: "AAECAw==" },
      },
    };

    const cfs = {
      async listRefs() {
        return { refs };
      },
      async ls(_lineage: string, params?: { at?: string; path?: string }) {
        const at = params?.at ?? "refs/heads/main";
        lsCalls.push({ at, path: params?.path });
        const entries = trees[at] ?? [];
        const filtered = params?.path
          ? entries.filter((e) => e.path === params.path || e.path.startsWith(`${params.path}/`))
          : entries;
        return { commit: at, entries: filtered };
      },
      async read(_lineage: string, params: { at?: string; path: string }) {
        const at = params.at ?? "refs/heads/main";
        readCalls.push({ at, path: params.path });
        const blob = blobs[at]?.[params.path];
        if (!blob) throw new ApiError(404, "not_found", `missing ${params.path}`);
        return blob;
      },
    } as unknown as CamelFsClient;

    return { cfs, readCalls, lsCalls };
  }

  it("reads zero blobs for unchanged hashes and skips binary extensions without fetching", async () => {
    const { cfs, readCalls } = makeMockCfs();
    const res = await computeRepoDiff(cfs, "lin_1", { from: "refs/camel/live", to: "HEAD" });

    assert.equal(res.from, c1);
    assert.equal(res.to, c2);
    assert.equal(res.fromTree, t1);
    assert.equal(res.toTree, t2);
    assert.equal(res.identical, false);
    assert.equal(res.truncated, false);
    assert.deepEqual(res.summary, { added: 2, modified: 2, deleted: 1, totalFiles: 5 });

    // Never reads unchanged.ts or logo.png!
    assert.ok(!readCalls.some((c) => c.path === "unchanged.ts"));
    assert.ok(!readCalls.some((c) => c.path === "logo.png"));

    const byPath = new Map(res.files.map((f) => [f.path, f]));
    assert.equal(byPath.get("logo.png")?.binary, true);
    assert.equal(byPath.get("logo.png")?.patch, undefined);
    assert.equal(byPath.get("data.dat")?.binary, true);
    assert.equal(byPath.get("data.dat")?.patch, undefined);
    assert.equal(byPath.get("app.ts")?.additions, 1);
    assert.equal(byPath.get("app.ts")?.deletions, 1);
    assert.match(byPath.get("app.ts")?.patch ?? "", /-const x = 1;\n\+const x = 2;/);
    assert.equal(byPath.get("added.txt")?.status, "added");
    assert.equal(byPath.get("removed.txt")?.status, "deleted");
  });

  it("performs zero blob reads in statOnly mode and short-circuits identical refs", async () => {
    const { cfs, readCalls, lsCalls } = makeMockCfs();
    const stat = await computeRepoDiff(cfs, "lin_1", { from: "refs/camel/live", to: "refs/heads/main", statOnly: true });
    assert.equal(readCalls.length, 0);
    assert.equal(stat.summary.totalFiles, 5);
    assert.ok(stat.files.every((f) => f.patch === undefined));

    lsCalls.length = 0;
    const same = await computeRepoDiff(cfs, "lin_1", { from: "refs/heads/main", to: "HEAD" });
    assert.equal(same.identical, true);
    assert.equal(same.files.length, 0);
    assert.equal(lsCalls.length, 0);
  });

  it("enforces maxBytes budget and truncates cleanly without reading remaining blobs", async () => {
    const { cfs, readCalls } = makeMockCfs();
    const res = await computeRepoDiff(cfs, "lin_1", {
      from: c1,
      to: c2,
      maxBytes: 40,
    });
    assert.equal(res.truncated, true);
    const totalPatchBytes = res.files.reduce(
      (sum, f) => sum + (f.patch ? Buffer.byteLength(f.patch, "utf8") : 0),
      0,
    );
    assert.ok(totalPatchBytes <= 40, `expected <= 40 bytes, got ${totalPatchBytes}`);
    assert.ok(res.files.some((f) => f.truncated === true));
    // Once maxBytes was exhausted on the first file (added.txt), later files were not read!
    assert.ok(!readCalls.some((c) => c.path === "removed.txt"));
  });

  it("supports single-file path filter without reading unrelated files", async () => {
    const { cfs, readCalls } = makeMockCfs();
    const res = await computeRepoDiff(cfs, "lin_1", {
      from: c1,
      to: c2,
      path: "app.ts",
    });
    assert.equal(res.identical, false);
    assert.deepEqual(res.summary, { added: 0, modified: 1, deleted: 0, totalFiles: 1 });
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0]?.path, "app.ts");
    assert.ok(readCalls.every((c) => c.path === "app.ts"));
  });
});

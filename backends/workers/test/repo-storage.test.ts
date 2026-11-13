import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_TREE, sha256Hex, gitBlobSha1, gitHash, commitObject, parseCommit } from "../src/repos/git.ts";
import { camelfsStorage, camelfsConfigured, StorageError, uploadTimeoutMs } from "../src/repos/storage.ts";
import type { CommitInput } from "../src/repos/storage.ts";
import { fakeCamelfsd, serveFakeCamelfsd } from "./fake-camelfsd.ts";
const token = "test-storage-token", lineage = "tenant:repo / with spaces";
const enc = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const hasGit = spawnSync("git", ["--version"]).status === 0;
const input = (changes: CommitInput["changes"] = [], extra: Partial<CommitInput> = {}): CommitInput => ({ time: 1700000000, parents: [], changes, author: "agent:abc", message: "checkpoint", trailers: { "Camel-Agent": "abc", "Camel-Kind": "manual" }, ...extra });
function fixture() {
  const fake = fakeCamelfsd(token);
  const storage = camelfsStorage({ CAMELFS_API_TOKEN: token, CAMELFS: { fetch: (url, init) => fake.fetch(new Request(url, init)) } });
  return { fake, storage };
}
const isError = (status: number, code: string) => (e: unknown) => e instanceof StorageError && e.status === status && e.code === code;

test("Git hashes and fixed camelfsd commit bytes", async () => {
  assert.equal(await gitBlobSha1(enc("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
  assert.equal(await sha256Hex(enc("hello\n")), "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03");
  assert.equal(await gitHash("tree", new Uint8Array()), EMPTY_TREE);
  const obj = await commitObject({ tree: EMPTY_TREE, parents: [], author: "agent:abc", at: 1700000000123, message: "checkpoint", trailers: { "Camel-Agent": "abc", "Camel-Kind": "manual" } });
  assert.equal(obj.id, "37ddea37aabe9118c16f49c41b8d1c1f01f46d09");
  assert.equal(decode(obj.bytes), `tree ${EMPTY_TREE}\nauthor agent:abc <agent:abc@camelfs> 1700000000 +0000\ncommitter camelfs <camelfs@camelfs> 1700000000 +0000\n\ncheckpoint\n\nCamel-Agent: abc\nCamel-Kind: manual\n`);
  assert.deepEqual(parseCommit(obj.bytes), { tree: EMPTY_TREE, parents: [], author: "agent:abc <agent:abc@camelfs> 1700000000 +0000", committer: "camelfs <camelfs@camelfs> 1700000000 +0000", message: "checkpoint", trailers: { "Camel-Agent": "abc", "Camel-Kind": "manual" } });
  const multi = await commitObject({ tree: EMPTY_TREE, parents: [obj.id, obj.id], author: "user:u1", at: 0, message: "first\n\nsecond", trailers: {} });
  assert.deepEqual(parseCommit(multi.bytes).parents, [obj.id, obj.id]);
  assert.equal(parseCommit(multi.bytes).message, "first\n\nsecond");
});
test("commit bytes agree with git hash-object", { skip: !hasGit }, async () => {
  const obj = await commitObject({ tree: EMPTY_TREE, parents: [], author: "agent:abc", at: 1700000000000, message: "checkpoint", trailers: { "Camel-Agent": "abc", "Camel-Kind": "manual" } });
  const result = spawnSync("git", ["hash-object", "-t", "commit", "--stdin"], { input: obj.bytes, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), obj.id);
});
test("blob upload, scoped reads, range, batch binary bytes and HTTP transport", async () => {
  const { storage, fake } = fixture();
  const bytes = Uint8Array.from([0, 255, 13, 10, 128, 45, 45]);
  const b = await storage.putBlob(lineage, bytes);
  assert.deepEqual(b, { blob: await gitBlobSha1(bytes), sha256: await sha256Hex(bytes), size: bytes.length });
  assert.deepEqual(await storage.putBlob(lineage, bytes), b);
  const c = await storage.commit(lineage, input([{ path: "dir/data", blob: b.blob }, { path: "link", blob: b.blob, mode: "120000" }]));
  assert.deepEqual(await storage.readBlob(lineage, b.blob, c.tree, "dir/data"), bytes);
  assert.deepEqual(await storage.readBlob(lineage, b.blob, c.tree, "dir/data", "bytes=1-3"), bytes.slice(1, 4));
  const batch = await storage.readBatch(lineage, c.tree, ["dir/data", "missing", "link"]);
  assert.deepEqual(batch, [{ path: "dir/data", blob: b.blob, mode: "100644", size: bytes.length, bytes }, { path: "missing", error: "not_in_tree" }, { path: "link", blob: b.blob, mode: "120000", size: bytes.length, bytes }]);
  assert.deepEqual(await storage.readBatch(lineage, c.tree, []), []);
  await assert.rejects(storage.readBatch(lineage, c.tree, ["dir/data"], 1), (e: unknown) => isError(413, "too_large")(e) && (e as StorageError).details.path === "dir/data");
  await assert.rejects(storage.readBatch(lineage, c.tree, Array(257).fill("link")), isError(413, "too_large"));
  await assert.rejects(storage.readBlob(lineage, b.blob, c.tree, "missing"), isError(404, "not_in_tree"));
  await assert.rejects(storage.readBlob("other", b.blob, c.tree, "dir/data"), isError(404, "not_in_tree"));
  await assert.rejects(storage.commit("other", input([{ path: "x", blob: b.blob }])), isError(400, "unknown_blob"));
  await assert.rejects(storage.commit("other", input([], { baseTree: c.tree })), isError(400, "unknown_tree"));
  await assert.rejects(storage.commit("other", input([], { parents: [c.commit] })), isError(400, "unknown_commit"));
  assert(fake.calls.every(c => c.includes(encodeURIComponent(lineage)) || c.includes("/other/")));
  const unauthorized = await fake.fetch(new Request("http://camelfs/v1/lineages/a/blobs", { method: "PUT", body: bytes }));
  assert.equal(unauthorized.status, 401);
  const mismatch = await fake.fetch(new Request("http://camelfs/v1/lineages/a/blobs", { method: "PUT", body: bytes, headers: { authorization: `Bearer ${token}`, "X-Camel-Sha256": "0".repeat(64) } }));
  assert.equal((await mismatch.json()).error.code, "blob_mismatch");
  const server = await serveFakeCamelfsd(token);
  try {
    const remote = camelfsStorage({ CAMELFS_API_TOKEN: token, CAMELFS: { fetch: (url, init) => fetch(String(url).replace("http://camelfs", server.url), init) } });
    const uploaded = await remote.putBlob("remote", enc("over HTTP"));
    const committed = await remote.commit("remote", input([{ path: "a", blob: uploaded.blob }]));
    assert.equal(decode(await remote.readBlob("remote", uploaded.blob, committed.tree, "a")), "over HTTP");
  } finally { await server.close(); }
});
test("commits: parents, mode-only, deletes, no-op, idempotency and caller time", async () => {
  const { storage, fake } = fixture();
  const empty = await storage.commit(lineage, input());
  assert.equal(empty.tree, EMPTY_TREE); assert.equal(empty.commit, "37ddea37aabe9118c16f49c41b8d1c1f01f46d09");
  assert.equal(empty.time, 1700000000); assert.deepEqual(empty.parents, []);
  const b = await storage.putBlob(lineage, enc("hello\n"));
  const first = await storage.commit(lineage, input([{ path: "a", blob: b.blob }], { parents: [empty.commit] }), "key");
  assert.deepEqual(await storage.commit(lineage, input([{ path: "a", blob: b.blob }], { parents: [empty.commit] }), "key"), first);
  const mode = await storage.commit(lineage, input([{ path: "a", mode: "100755" }], { parents: [first.commit], time: 1700000005 }));
  assert.equal(mode.changed, 1); assert.equal(mode.bytes, 0, "a mode-only change names no blob"); assert.equal(first.bytes, 6); assert.equal(mode.time, 1700000005);
  const merge = await storage.commit(lineage, input([], { parents: [mode.commit, first.commit] }));
  assert.equal(merge.tree, mode.tree); assert.equal(merge.changed, 0); assert.deepEqual(merge.parents, [mode.commit, first.commit]);
  const info = await storage.getCommit(lineage, merge.commit);
  assert.equal(info.tree, mode.tree); assert.equal(info.time, merge.time); assert.deepEqual(info.parents, merge.parents);
  assert.equal(info.message, "checkpoint"); assert.equal(info.trailers["Camel-Agent"], "abc");
  const deleted = await storage.commit(lineage, input([{ path: "a", delete: true }, { path: "absent", delete: true }], { parents: [mode.commit] }));
  assert.equal(deleted.tree, EMPTY_TREE); assert.equal(deleted.changed, 1);
  await assert.rejects(storage.commit(lineage, input(Array.from({ length: 10001 }, () => ({ path: "x", delete: true })))), isError(413, "too_large"));
  await assert.rejects(storage.commit(lineage, input([], { parents: [first.commit, first.commit, first.commit] })), isError(400, "invalid_request"));
  await assert.rejects(storage.commit(lineage, input([{ path: "../bad", blob: b.blob }])), isError(400, "invalid_request"));
  await assert.rejects(storage.getCommit("other", first.commit), isError(404, "not_in_tree"));
});
test("client supplies caller time or a current default; identical commit bodies hash identically", async () => {
  const { storage, fake } = fixture();
  const before = Math.floor(Date.now() / 1000);
  const result = await storage.commit(lineage, input([], { time: undefined }));
  assert(result.time >= before && result.time <= Math.floor(Date.now() / 1000));
  const fixed = input([], { time: 1234567890 });
  const a = await storage.commit(lineage, fixed), b = await storage.commit(lineage, fixed);
  assert.deepEqual(a, b); assert.equal(a.time, 1234567890);
  const body = parseCommit(fake.commits.get(a.commit)!);
  assert(body.author.endsWith("1234567890 +0000"));
  const changed = await storage.commit(lineage, { ...fixed, time: 1234567891 });
  assert.notEqual(changed.commit, a.commit);
});
test("Git tree encoding agrees with git write-tree incl sorting, symlink and executable", { skip: !hasGit }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "repo-storage-"));
  try {
    const run = (...args: string[]) => { const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    run("init", "-q"); run("config", "core.filemode", "true"); run("config", "core.autocrlf", "false");
    await mkdir(join(dir, "a")); await mkdir(join(dir, "nested"));
    const contents = { "a/z": "nested\n", "a.c": "sort before directory\n", "a0": "sort after directory\n", "nested/é": "unicode\n", "run": "#!/bin/sh\n", "link": "a/z" };
    const { storage } = fixture(); const edits: CommitInput["changes"] = [];
    for (const [path, text] of Object.entries(contents)) {
      if (path === "link") await symlink(text, join(dir, path)); else await writeFile(join(dir, path), text);
      if (path === "run") await chmod(join(dir, path), 0o755);
      edits.push({ path, blob: (await storage.putBlob(lineage, enc(text))).blob, mode: path === "run" ? "100755" : path === "link" ? "120000" : "100644" });
    }
    run("add", "."); const real = run("write-tree");
    assert.equal((await storage.commit(lineage, input(edits))).tree, real);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("listTree pagination, directories, path filter, listAll; diff statuses", async () => {
  const { storage } = fixture(); const b = await storage.putBlob(lineage, enc("a")), b2 = await storage.putBlob(lineage, enc("b"));
  const base = await storage.commit(lineage, input([{ path: "a", blob: b.blob }, { path: "dir/x", blob: b.blob }, { path: "gone", blob: b.blob }]));
  const page = await storage.listTree(lineage, base.tree, { limit: 1 }); assert.equal(page.entries.length, 1); assert.equal(page.next, "a");
  const rest = await storage.listTree(lineage, base.tree, { after: page.next });
  assert.equal(rest.entries[0].mode, "040000"); assert.equal(rest.entries[0].path, "dir");
  assert.deepEqual((await storage.listTree(lineage, base.tree, { path: "dir", recursive: true })).entries.map(e => e.path), ["dir/x"]);
  assert.deepEqual((await storage.listAll(lineage, base.tree)).map(e => e.path), ["a", "dir/x", "gone"]);
  const next = await storage.commit(lineage, input([{ path: "a", mode: "100755" }, { path: "dir/x", blob: b2.blob }, { path: "gone", delete: true }, { path: "new", blob: b.blob }], { parents: [base.commit] }));
  assert.deepEqual((await storage.diff(lineage, base.tree, next.tree)).changes.map(c => [c.path, c.status]), [["a", "mode"], ["dir/x", "modified"], ["gone", "deleted"], ["new", "added"]]);
  assert.deepEqual((await storage.diff(lineage, base.tree, next.tree, "dir")).changes.map(c => c.path), ["dir/x"]);
  await assert.rejects(storage.listTree("other", base.tree), isError(404, "not_in_tree"));
  // Force more than one default-sized page to exercise listAll's cursor loop.
  const many = await storage.commit(lineage, input(Array.from({ length: 10000 }, (_, i) => ({ path: `p${String(i).padStart(5, "0")}`, blob: b.blob })), { parents: [base.commit] }));
  assert.equal((await storage.listAll(lineage, many.tree)).length, 10003);
});
test("merge clean, both_modified, delete_modify; conflicts write nothing", async () => {
  const { storage, fake } = fixture();
  const [a, b, c] = await Promise.all(["a", "b", "c"].map(s => storage.putBlob(lineage, enc(s))));
  const base = await storage.commit(lineage, input([{ path: "a", blob: a.blob }]));
  const ours = await storage.commit(lineage, input([{ path: "ours", blob: b.blob }], { parents: [base.commit] }));
  const theirs = await storage.commit(lineage, input([{ path: "theirs", blob: c.blob }], { parents: [base.commit] }));
  const merged = await storage.merge(lineage, { base: base.tree, ours: ours.tree, theirs: theirs.tree, mode: "merge" });
  assert("tree" in merged); assert.deepEqual(merged.took, { ours: 1, theirs: 1 });
  assert.deepEqual((await storage.listAll(lineage, merged.tree)).map(e => e.path), ["a", "ours", "theirs"]);
  const left = await storage.commit(lineage, input([{ path: "a", blob: b.blob }], { parents: [base.commit] }));
  const right = await storage.commit(lineage, input([{ path: "a", blob: c.blob }], { parents: [base.commit] }));
  const deleted = await storage.commit(lineage, input([{ path: "a", delete: true }], { parents: [base.commit] }));
  const count = fake.trees.size;
  const conflict = await storage.merge(lineage, { base: base.tree, ours: left.tree, theirs: right.tree, mode: "squash" });
  assert("conflicts" in conflict); assert.equal(conflict.conflicts[0].reason, "both_modified"); assert.equal(fake.trees.size, count);
  const dm = await storage.merge(lineage, { base: base.tree, ours: deleted.tree, theirs: left.tree, mode: "merge" });
  assert("conflicts" in dm); assert.equal(dm.conflicts[0].reason, "delete_modify");
});
test("grep literal, regex, case, glob, context, cap and invalid regex", async () => {
  const { storage } = fixture(); const b = await storage.putBlob(lineage, enc("before\nHello\nhello\nafter\n"));
  const c = await storage.commit(lineage, input([{ path: "dir/a.ts", blob: b.blob }, { path: "b.md", blob: b.blob }]));
  const result = await storage.grep(lineage, { tree: c.tree, q: "hello", ignoreCase: true, path: "**/*.ts", context: 1 });
  assert.equal(result.files, 1); assert.equal(result.matches.length, 2); assert.equal(result.matches[0].line, 2);
  assert.deepEqual(result.matches[0].before, ["before"]); assert.deepEqual(result.matches[0].after, ["hello"]);
  assert.equal((await storage.grep(lineage, { tree: c.tree, q: "^H.*o$", regex: true })).matches.length, 2);
  assert.equal((await storage.grep(lineage, { tree: c.tree, q: "hello", ignoreCase: true, limit: 1 })).truncated, true);
  assert.equal((await storage.grep(lineage, { tree: c.tree, q: "absent" })).matches.length, 0);
  await assert.rejects(storage.grep(lineage, { tree: c.tree, q: "[", regex: true }), isError(400, "invalid_request"));
});
test("redacted structured errors, transport errors, verification and response bounds", async () => {
  assert.equal(camelfsConfigured({}), false); assert.throws(() => camelfsStorage({}), isError(0, "not_configured"));
  assert.equal(uploadTimeoutMs(0), 60000); assert.equal(uploadTimeoutMs(2 ** 20), 61000);
  const make = (fetch: (input: Request | string, init?: RequestInit) => Promise<Response>) => camelfsStorage({ CAMELFS_API_TOKEN: token, CAMELFS: { fetch } });
  const broken = make(async () => Response.json({ error: { code: "unavailable", message: `failure ${token}`, details: { nested: [token], [token]: token } } }, { status: 503 }));
  await assert.rejects(broken.getCommit(lineage, "x"), (e: unknown) => {
    assert(e instanceof StorageError); assert.equal(e.code, "unavailable"); assert(!e.message.includes(token)); assert(!JSON.stringify(e.details).includes(token)); return true;
  });
  await assert.rejects(make(async () => { throw new Error(token); }).putBlob(lineage, enc("x")), isError(0, "transport_error"));
  for (const field of ["blob", "sha256", "size"]) {
    const bytes = enc("x"), response = { blob: await gitBlobSha1(bytes), sha256: await sha256Hex(bytes), size: 1 };
    await assert.rejects(make(async () => Response.json({ ...response, [field]: "bad" }, { status: 201 })).putBlob(lineage, bytes), isError(201, "blob_mismatch"));
  }
  await assert.rejects(make(async () => new Response("not json")).getCommit(lineage, "x"), isError(200, "invalid_response"));
  await assert.rejects(make(async () => new Response('"' + "x".repeat(1024 * 1024) + '"')).getCommit(lineage, "x"), isError(200, "invalid_response"));
  const large = make(async () => Response.json({ entries: [{ path: "x".repeat(1024 * 1024) }] }));
  assert.equal((await large.listTree(lineage, EMPTY_TREE)).entries.length, 1);
  await assert.rejects(make(async () => new Response("broken", { headers: { "content-type": "multipart/mixed; boundary=x" } })).readBatch(lineage, EMPTY_TREE, ["a"]), isError(200, "invalid_response"));
});

test("the fake refuses fields the daemon refuses, and a refused call names itself and the daemon's reason", async () => {
  const fake = fakeCamelfsd("t".repeat(32));
  const plane = camelfsStorage({ CAMELFS: { fetch: (input, init) => fake.fetch(new Request(input, init)) }, CAMELFS_API_TOKEN: "t".repeat(32) });
  const root = await plane.commit("l", { parents: [], changes: [], author: "api:t", message: "create", trailers: {}, time: 1700000000 });
  assert.deepEqual([root.parents, root.time], [[], 1700000000]);
  await assert.rejects(plane.commit("l", { parents: [root.commit], parent: root.commit, changes: [], author: "api:t", message: "m", trailers: {} } as never),
    (e: unknown) => e instanceof StorageError && e.op === "commit" && e.code === "invalid_request" && e.reason === "unknown field parent");
  const raw = await fake.fetch(new Request("http://camelfs/v1/lineages/l/commits", { method: "POST", headers: { authorization: `Bearer ${"t".repeat(32)}` },
    body: JSON.stringify({ changes: [], author: "a", message: "m", trailers: {}, time: 1 }) }));
  assert.equal(raw.status, 400);
  assert.deepEqual(((await raw.json()) as { error: { message: string } }).error.message, "missing field parents");
});

// End to end with real git: tokens, push/clone through the proxy, ref scoping, server-side commit and merge,
// VolumeCore checkpoints, and (when S3_ENDPOINT is set: MinIO on a sprite) the replication gate + restore.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startServer } from "../src/server.ts";
import { mintToken } from "../src/token.ts";
import { git, gitRaw } from "../src/gitexec.ts";
import { Replicator } from "../src/replicate.ts";
import { GitsvcStore } from "../src/core/store.ts";
import { VolumeCore, type Sql } from "../src/core/volume.ts";

const KEY = "test-key";
const root = await mkdtemp(join(tmpdir(), "gitsvc-test-"));
const replicator = process.env.S3_ENDPOINT ? new Replicator({ endpoint: process.env.S3_ENDPOINT, bucket: process.env.S3_BUCKET ?? "gitsvc", accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! }) : undefined;
const server = await startServer({ root: join(root, "repos"), key: KEY, replicator });
await (await import("node:fs/promises")).mkdir(join(root, "repos"), { recursive: true });
after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });

const tok = (repo: string, scope: "read" | "write" | "admin", refs?: string[]) => mintToken(KEY, { repo, scope, exp: Date.now() / 1000 + 600, refs });
const header = (t: string) => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${t}` });
const api = (repo: string, path: string, init: RequestInit = {}, scope: "read" | "admin" = "admin") =>
  fetch(`${server.url}/api/repos${path}`, { ...init, headers: { authorization: `Bearer ${tok(repo, scope)}`, "content-type": "application/json" } });
const b64 = (s: string) => Buffer.from(s).toString("base64");

test("create, push, clone over v2, scoped tokens", async () => {
  assert.equal((await api("r1", "", { method: "POST", body: JSON.stringify({ name: "r1" }) })).status, 201);
  const work = join(root, "w1");
  await git(["init", "-q", "-b", "main", work]);
  await writeFile(join(work, "a.txt"), "one\ntwo\nthree\n");
  await git(["-C", work, "add", "."]); await git(["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "first"]);
  const remote = `${server.url}/r1.git`;
  // a read token cannot push
  const denied = await gitRaw(["-C", work, "push", remote, "main"], { env: header(tok("r1", "read")), okCodes: [128] });
  assert.equal(denied.code, 128);
  // a token for another repo cannot read
  assert.equal((await gitRaw(["ls-remote", remote], { env: header(tok("r2", "admin")), okCodes: [128] })).code, 128);
  await git(["-C", work, "push", "-q", remote, "main"], { env: header(tok("r1", "write")) });
  // a write token scoped to job/ cannot move main
  await writeFile(join(work, "a.txt"), "one\ntwo\nTHREE\n");
  await git(["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "second"]);
  const scoped = await gitRaw(["-C", work, "push", remote, "main"], { env: header(tok("r1", "write", ["refs/heads/job/"])), okCodes: [1] });
  assert.equal(scoped.code, 1);
  await git(["-C", work, "push", "-q", remote, "main:refs/heads/job/x"], { env: header(tok("r1", "write", ["refs/heads/job/"])) });
  const clone = join(root, "c1");
  await git(["-c", "protocol.version=2", "clone", "-q", remote, clone], { env: header(tok("r1", "read")) });
  assert.equal(await git(["-C", clone, "show", "HEAD:a.txt"]), "one\ntwo\nthree");
});

test("server-side commit with CAS, fork as a branch, merge-ort merge and conflict", async () => {
  await api("r3", "", { method: "POST", body: JSON.stringify({ name: "r3" }) });
  const c1 = await (await api("r3", "/r3/commit", { method: "POST", body: JSON.stringify({ branch: "main", parent: null, message: "base", files: { "f.txt": b64("1\n2\n3\n4\n5\n6\n7\n8\n"), "g.txt": b64("g\n") } }) })).json() as { commit: string };
  assert.match(c1.commit, /^[0-9a-f]{40}$/);
  // stale parent -> 409
  assert.equal((await api("r3", "/r3/commit", { method: "POST", body: JSON.stringify({ branch: "main", parent: null, message: "x", files: { "x": b64("x") } }) })).status, 409);
  // fork = create a branch at main
  assert.equal((await api("r3", "/r3/refs", { method: "POST", body: JSON.stringify({ ref: "refs/heads/fork/a", old: null, new: c1.commit }) })).status, 200);
  const ours = await (await api("r3", "/r3/commit", { method: "POST", body: JSON.stringify({ branch: "main", parent: c1.commit, message: "ours", files: { "f.txt": b64("ONE\n2\n3\n4\n5\n6\n7\n8\n") } }) })).json() as { commit: string };
  const theirs = await (await api("r3", "/r3/commit", { method: "POST", body: JSON.stringify({ branch: "fork/a", parent: c1.commit, message: "theirs", files: { "f.txt": b64("1\n2\n3\n4\n5\n6\n7\nEIGHT\n"), "g.txt": null } }) })).json() as { commit: string };
  assert.ok(ours.commit && theirs.commit);
  const merged = await (await api("r3", "/r3/merge", { method: "POST", body: JSON.stringify({ into: "main", from: "fork/a" }) })).json() as { merged: boolean; commit: string };
  assert.equal(merged.merged, true);
  const blob = await (await api("r3", `/r3/tree/${merged.commit}`, {}, "read")).arrayBuffer();
  const entries = Buffer.from(blob).toString().split("\0").filter(Boolean);
  assert.equal(entries.length, 1); // g.txt removed by theirs
  const fsha = entries[0].split(/\s+/)[2];
  assert.equal(Buffer.from(await (await api("r3", `/r3/blob/${fsha}`, {}, "read")).arrayBuffer()).toString(), "ONE\n2\n3\n4\n5\n6\n7\nEIGHT\n");
  // conflict: both sides change line 1
  await api("r3", "/r3/refs", { method: "POST", body: JSON.stringify({ ref: "refs/heads/fork/b", old: null, new: merged.commit }) });
  await api("r3", "/r3/commit", { method: "POST", body: JSON.stringify({ branch: "main", parent: merged.commit, message: "m", files: { "f.txt": b64("uno\n") } }) });
  await api("r3", "/r3/commit", { method: "POST", body: JSON.stringify({ branch: "fork/b", parent: merged.commit, message: "b", files: { "f.txt": b64("eins\n") } }) });
  const conflict = await api("r3", "/r3/merge", { method: "POST", body: JSON.stringify({ into: "main", from: "fork/b" }) });
  assert.equal(conflict.status, 409);
  assert.deepEqual((await conflict.json() as { conflicts: string[] }).conflicts, ["f.txt"]);
});

test("VolumeCore checkpoints as thin-pack pushes through the proxy", async () => {
  await api("r4", "", { method: "POST", body: JSON.stringify({ name: "r4" }) });
  const db = new DatabaseSync(":memory:");
  const sql: Sql = { exec: (q, ...p) => { const s = db.prepare(q); return /^\s*SELECT/i.test(q) ? (s.all(...(p as never[])) as never) : (s.run(...(p as never[])), []); } };
  const store = new GitsvcStore({ base: server.url, repo: "r4", key: KEY });
  const core = new VolumeCore(sql, store);
  core.init({ repo: "r4", remote: store.remote, branch: "main" });
  core.write("src/a.ts", new TextEncoder().encode("export const a = 1;\n"));
  const sha = await core.commit("first");
  const refs = await (await api("r4", "/r4/refs", {}, "read")).json() as Record<string, string>;
  assert.equal(refs["refs/heads/main"], sha);
});

test("replication gate ships packs before the ref moves; restore rebuilds the repo", { skip: !replicator }, async () => {
  await api("r5", "", { method: "POST", body: JSON.stringify({ name: "r5" }) });
  const c = await (await api("r5", "/r5/commit", { method: "POST", body: JSON.stringify({ branch: "main", parent: null, message: "x", files: { "a": b64("a\n") } }) })).json() as { commit: string };
  await api("r5", "/r5/refs", { method: "POST", body: JSON.stringify({ ref: "refs/heads/fork/z", old: null, new: c.commit }) });
  const restored = join(root, "restored.git");
  const result = await replicator!.restore("r5", restored);
  assert.equal(result.refs, 2);
  assert.equal(await git(["--git-dir", restored, "rev-parse", "refs/heads/fork/z"]), c.commit);
  await git(["--git-dir", restored, "fsck", "--connectivity-only", "--no-progress"]);
});

// End to end against the Node server with the real git CLI: API commits, clone (full and --depth 1), fsck,
// incremental fetch, branch + merge (clean, conflict, squash), ephemeral expiry + GC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer } from "../src/node.ts";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();

test("api + git clients", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gitapi-test-"));
  const port = 18700 + Math.floor(Math.random() * 200);
  // GITAPI_URL runs the same flow against `wrangler dev` (the Worker + Durable Object + local R2).
  const srv = process.env.GITAPI_URL ? { close() {} } : startServer(join(dir, "data"), port);
  const base = process.env.GITAPI_URL ?? `http://127.0.0.1:${port}`;
  const repo = `t${Date.now().toString(36)}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}/repos/${repo}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    return { status: r.status, body: t.startsWith("{") || t.startsWith("[") ? JSON.parse(t) : t };
  };
  try {
    const c1 = await api("POST", "/commits", { branch: "main", message: "init", expectedHead: null, files: { "README.md": { content: "hello\n" }, "src/a.ts": { content: "a1\na2\na3\na4\na5\n" }, "src/deep/b.ts": { content: "b\n" }, "bin/x.sh": { content: "#!/bin/sh\n", mode: "100755" } } });
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    // CAS
    assert.equal((await api("POST", "/commits", { branch: "main", message: "x", expectedHead: null, files: { "z": { content: "z" } } })).status, 409);

    // full clone + fsck, compare tree sha with the API's
    const clone = join(dir, "clone");
    await git(dir, "clone", "-q", `${base}/git/${repo}.git`, clone);
    await git(clone, "fsck", "--full", "--strict");
    assert.equal(await git(clone, "rev-parse", "HEAD"), c1.body.commit);
    assert.equal(await git(clone, "rev-parse", "HEAD^{tree}"), c1.body.tree);
    assert.equal(await readFile(join(clone, "src/a.ts"), "utf8"), "a1\na2\na3\na4\na5\n");

    // second commit (edit + delete) and an incremental fetch
    const c2 = await api("POST", "/commits", { branch: "main", message: "edit", expectedHead: c1.body.commit, files: { "src/deep/b.ts": null, "src/a.ts": { content: "a1\na2\na3\na4\na5\na6\n" } } });
    assert.equal(c2.status, 200);
    await git(clone, "pull", "-q", "--ff-only");
    await git(clone, "fsck", "--full");
    assert.equal(await git(clone, "rev-parse", "HEAD"), c2.body.commit);
    assert.equal(await git(clone, "ls-files"), "README.md\nbin/x.sh\nsrc/a.ts");

    // shallow clone, then a plain fetch into it
    const shallow = join(dir, "shallow");
    await git(dir, "clone", "-q", "--depth", "1", `${base}/git/${repo}.git`, shallow);
    assert.equal(await git(shallow, "rev-list", "--count", "HEAD"), "1");
    const c3 = await api("POST", "/commits", { branch: "main", message: "more", files: { "new.txt": { content: "n\n" } } });
    await git(shallow, "fetch", "-q", "origin");
    assert.equal(await git(shallow, "rev-parse", "origin/main"), c3.body.commit);
    await git(shallow, "fsck");

    // ephemeral branch: edit disjoint hunks on both sides, three-way merge
    assert.equal((await api("POST", "/branches", { name: "attempt/1", from: "main", ttlSeconds: 3600 })).status, 200);
    await api("POST", "/commits", { branch: "attempt/1", message: "fork edit", files: { "src/a.ts": { content: "A1\na2\na3\na4\na5\na6\n" }, "fork.txt": { content: "f\n" } } });
    await api("POST", "/commits", { branch: "main", message: "main edit", files: { "src/a.ts": { content: "a1\na2\na3\na4\na5\nA6\n" } } });
    const merged = await api("POST", "/merges", { into: "main", from: "attempt/1", deleteSource: true });
    assert.equal(merged.body.status, "merged", JSON.stringify(merged.body));
    const file = await fetch(`${base}/repos/${repo}/files/src/a.ts?ref=main`);
    assert.equal(await file.text(), "A1\na2\na3\na4\na5\nA6\n");
    assert.ok(!(await api("GET", "/refs")).body.some((r: { name: string }) => r.name === "attempt/1"));
    await git(clone, "pull", "-q", "--ff-only");
    await git(clone, "fsck", "--full");
    assert.equal(await git(clone, "rev-list", "--count", "--merges", "HEAD"), "1");

    // conflict: nothing written, both sides reported
    await api("POST", "/branches", { name: "attempt/2", from: "main" });
    await api("POST", "/commits", { branch: "attempt/2", message: "x", files: { "README.md": { content: "fork\n" } } });
    const before = (await api("GET", "/refs")).body.find((r: { name: string }) => r.name === "main").sha;
    await api("POST", "/commits", { branch: "main", message: "y", files: { "README.md": { content: "main\n" } } });
    const mid = (await api("GET", "/refs")).body.find((r: { name: string }) => r.name === "main").sha;
    assert.notEqual(before, mid);
    const conflict = await api("POST", "/merges", { into: "main", from: "attempt/2" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.conflicts[0].path, "README.md");
    assert.equal((await api("GET", "/refs")).body.find((r: { name: string }) => r.name === "main").sha, mid);

    // squash merge of a fresh attempt: single parent
    await api("POST", "/branches", { name: "attempt/3", from: "main", ttlSeconds: 1 });
    await api("POST", "/commits", { branch: "attempt/3", message: "s1", files: { "s.txt": { content: "1\n" } } });
    await api("POST", "/commits", { branch: "attempt/3", message: "s2", files: { "s.txt": { content: "2\n" } } });
    const sq = await api("POST", "/merges", { into: "main", from: "attempt/3", squash: true });
    assert.equal(sq.body.status, "merged");
    assert.equal((await api("GET", "/log?limit=1")).body[0].parents.length, 1);

    // diff / tree / log
    const d = await api("GET", `/diff?from=${c1.body.commit}&to=main`);
    assert.deepEqual(d.body.changes.map((c: { path: string; status: string }) => `${c.status} ${c.path}`).sort(), ["added fork.txt", "added new.txt", "added s.txt", "deleted src/deep/b.ts", "modified README.md", "modified src/a.ts"]);
    assert.ok((await api("GET", "/tree?recursive=1")).body.entries.length >= 6);

    // worktree: writes are rows, reads see them, per-file CAS, checkpoint makes one commit
    const wt = (path: string, init?: RequestInit) => fetch(`${base}/repos/${repo}/worktree${path}`, init);
    assert.equal((await wt("/notes/a.md?branch=main", { method: "PUT", body: "one\n" })).status, 200);
    const seen = await wt("/notes/a.md?branch=main");
    assert.equal(await seen.text(), "one\n");
    assert.equal(seen.headers.get("x-dirty"), "true");
    const sha = seen.headers.get("x-sha")!;
    assert.equal((await wt("/notes/a.md?branch=main", { method: "PUT", body: "two\n", headers: { "x-expect-sha": "0".repeat(40) } })).status, 409);
    assert.equal((await wt("/notes/a.md?branch=main", { method: "PUT", body: "two\n", headers: { "x-expect-sha": sha } })).status, 200);
    assert.equal((await wt("/README.md?branch=main", { method: "DELETE" })).status, 200);
    const cp = await (await wt("?branch=main&message=cp", { method: "POST" })).json();
    assert.ok(cp.commit);
    assert.deepEqual(await (await wt("?branch=main")).json(), []);
    assert.equal(await (await fetch(`${base}/repos/${repo}/files/notes/a.md`)).text(), "two\n");
    assert.equal((await fetch(`${base}/repos/${repo}/files/README.md`)).status, 404);
    // per-file expect on the commit API: a stale read of one file conflicts, an unrelated file does not
    assert.equal((await api("POST", "/commits", { branch: "main", message: "s", expect: { "notes/a.md": sha }, files: { "notes/a.md": { content: "3" } } })).status, 409);
    assert.equal((await api("POST", "/commits", { branch: "main", message: "s", expect: { "other.md": null }, files: { "other.md": { content: "3" } } })).status, 200);

    // expiry + GC: attempt/2 and attempt/3 die; attempt/3's s1 blob goes, attempt/2's README goes
    const beforeExpiry = (await api("GET", "/stats")).body;
    await api("PATCH", "/branches/attempt%2F2", { ttlSeconds: 1 });
    await new Promise((r) => setTimeout(r, 2500));
    const refs = (await api("GET", "/refs")).body.map((r: { name: string }) => r.name);
    assert.deepEqual(refs, ["main"]);
    // The Worker's alarm GC keeps a 60 s grace for young objects; an explicit pass with no grace reclaims now.
    await api("POST", "/gc", { graceMs: 0 });
    const stats = (await api("GET", "/stats")).body;
    const clone2 = join(dir, "clone2");
    await git(dir, "clone", "-q", `${base}/git/${repo}.git`, clone2);
    await git(clone2, "fsck", "--full", "--strict");
    assert.ok(stats.objects > 0 && stats.objects < beforeExpiry.objects, `expiry GC dropped objects: ${beforeExpiry.objects} -> ${stats.objects}`);
    await writeFile(join(dir, "ok"), "");
  } finally { srv.close(); }
});

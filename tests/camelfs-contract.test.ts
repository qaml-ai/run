import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { camelfsdClient, serveImportProxy } from "../jobhost/camelfsd.ts";
import { Guest } from "../jobhost/guest.ts";
import { camelfsStorage, StorageError } from "../backends/workers/src/repos/storage.ts";
import type { CommitInput, CommitResult } from "../backends/workers/src/repos/storage.ts";

// Only a real binary enables this test. CI requires it so a broken setup cannot skip.
test("camelFS contract: runtime storage, import, jobhost proxy and guest against real camelfsd", {
  skip: !process.env.CAMELFSD_BIN && process.env.CAMELFS_CONTRACT_REQUIRED !== "1"
    ? "set CAMELFSD_BIN to a camelfsd built from camelfsd/" : false,
  timeout: 120_000,
}, async t => {
  assert.ok(process.env.CAMELFSD_BIN, "CAMELFS_CONTRACT_REQUIRED=1 requires CAMELFSD_BIN");
  const binary = resolve(process.env.CAMELFSD_BIN);
  await access(binary, constants.X_OK);
  const timed = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try { return await run(); }
    finally { t.diagnostic(`${step}: ${(performance.now() - start).toFixed(1)} ms`); }
  };
  const dir = await mkdtemp(join(tmpdir(), "cfs-contract-"));
  const cleanup: (() => void | Promise<unknown>)[] = [() => rm(dir, { recursive: true, force: true })];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
  });
  const socketPath = join(dir, "api.sock"), vsock = join(dir, "job.vsock");
  // Reserve separate loopback ports for NBD and the daemon's runtime listener.
  const portServers = [createServer(), createServer()];
  await Promise.all(portServers.map(server => new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  })));
  const [port, apiPort] = portServers.map(server => (server.address() as { port: number }).port);
  await Promise.all(portServers.map(server => new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()))));
  const token = createHash("sha256").update(randomUUID()).digest("hex");
  const tokenFile = join(dir, "camelfs-api.env");
  await writeFile(tokenFile, `# jobhost env format\nCAMELFS_API_TOKEN=${token}\n`, { mode: 0o600 });
  const daemon = spawn(binary, ["host", "--socket", socketPath, "--data", join(dir, "data"),
    "--store", join(dir, "store"), "--nbd-listen", `127.0.0.1:${port}`,
    "--listen-api", `127.0.0.1:${apiPort}`, "--api-token-file", tokenFile,
    "--virtual-size", String(16 * 1024 * 1024)], {
    env: { ...process.env, CAMELFSD_TEST_NO_REFLINK: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "", spawnError: Error | undefined, completed = false;
  daemon.on("error", error => { spawnError = error; });
  for (const stream of [daemon.stdout, daemon.stderr]) stream.on("data", chunk => { logs = (logs + chunk).slice(-16_384); });
  const exited = new Promise<void>(resolve => daemon.once("close", () => resolve()));
  cleanup.push(async () => {
    daemon.kill("SIGTERM");
    const killTimer = setTimeout(() => daemon.kill("SIGKILL"), 3000);
    try { await exited; } finally { clearTimeout(killTimer); }
    if (!completed) t.diagnostic(`camelfsd output:\n${logs}`);
  });
  const client = camelfsdClient(socketPath);
  await timed("daemon health", async () => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (spawnError) throw spawnError;
      assert.equal(daemon.exitCode, null, `camelfsd exited: ${logs}`);
      try { if ((await client.health()).ok) return; } catch { /* socket not ready */ }
      assert.ok(Date.now() < deadline, `camelfsd health timed out: ${logs}`);
      await delay(50);
    }
  });

  await timed("daemon TCP import bridge and auth", async () => {
    const origin = `http://127.0.0.1:${apiPort}`;
    const blob = "tcp import\n", sha256 = createHash("sha256").update(blob).digest("hex");
    const blobPath = `/v0/blobs/${sha256}?lineage=contract:tcp`;
    const treeBody = JSON.stringify({ lineage: "contract:tcp", files: { "tcp.txt": { sha256 } } });
    for (const [method, path, body] of [["PUT", blobPath, blob], ["POST", "/v0/trees", treeBody]]) {
      const denied = await fetch(origin + path, { method, body });
      assert.equal(denied.status, 401);
      await denied.arrayBuffer();
      const allowed = await fetch(origin + path, { method, body, headers: { authorization: `Bearer ${token}` } });
      assert.equal(allowed.status, method === "PUT" ? 201 : 200, await allowed.text());
    }
    const deniedHost = await fetch(origin + "/v0/health", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(deniedHost.status, 404);
    await deniedHost.arrayBuffer();
  });

  // Read-only routes are deliberately absent from the import proxy.
  const get = <T>(path: string): Promise<T> => new Promise((resolve, reject) => {
    const req = request({ socketPath, path }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        try {
          assert.equal(res.statusCode, 200, Buffer.concat(chunks).toString());
          resolve(JSON.parse(Buffer.concat(chunks).toString()) as T);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error(`GET ${path} timed out`)));
    req.on("error", reject); req.end();
  });
  const lineage = "contract:first-mount";
  const proxy = await serveImportProxy({ socketPath, token, host: "127.0.0.1", port: 0 });
  cleanup.push(() => proxy.close());
  const proxyOrigin = `http://127.0.0.1:${proxy.port}`;
  const env = { CAMELFS: { fetch: (url: Request | string, init?: RequestInit) => {
    const parsed = new URL(typeof url === "string" ? url : url.url);
    return fetch(proxyOrigin + parsed.pathname + parsed.search, init);
  } }, CAMELFS_API_TOKEN: token };
  const contents = new Map([
    ["/README.md", Buffer.from("# Contract\n")],
    ["/src/a.txt", Buffer.from("alpha\n")],
    ["/src/b.txt", Buffer.from("bravo\n")],
  ]);
  const input = { lineage, files: [...contents].map(([path, bytes]) => ({
    path, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, key: path,
  })), read: async (file: { path: string }) => {
    const bytes = contents.get(file.path)!;
    return { size: bytes.length, body: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.subarray(0, 2)); controller.enqueue(bytes.subarray(2)); controller.close();
    } }) };
  } };
  // The Workers volume import bridge is deleted (spec 5); this test-local phase-1 importer seeds the daemon's
  // phase-1 mount the same way (POST /v0/trees, PUT only the missing blobs) until unit 11 deletes /v0.
  // TEMPORARY: removed with jobhost phase 2
  const importTree = async (environment: typeof env, treeInput: typeof input) => {
    const auth = { authorization: `Bearer ${environment.CAMELFS_API_TOKEN}` };
    const byHash = new Map(treeInput.files.map(f => [f.sha256, f]));
    const files = Object.fromEntries(treeInput.files.map(f => [f.path.replace(/^\/+/, ""), { sha256: f.sha256 }]));
    let uploaded = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await environment.CAMELFS.fetch("http://camelfs/v0/trees", { method: "POST",
        headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ lineage: treeInput.lineage, files }) });
      const value = await response.json() as { tree?: string; missing?: string[] };
      if (response.status === 200) return { tree: value.tree!, uploaded };
      assert.equal(response.status, 409, JSON.stringify(value));
      for (const hash of new Set(value.missing ?? [])) {
        const { body, size } = await treeInput.read(byHash.get(hash)!);
        const put = await environment.CAMELFS.fetch(`http://camelfs/v0/blobs/${hash}?lineage=${encodeURIComponent(treeInput.lineage)}`, {
          method: "PUT", headers: { ...auth, "content-type": "application/octet-stream", "content-length": String(size) },
          body, duplex: "half" } as RequestInit);
        assert.ok(put.status === 200 || put.status === 201, `blob ${put.status}`);
        await put.body?.cancel(); uploaded++;
      }
    }
    throw new Error("tree import retries exhausted");
  };
  const first = await timed("import streamed blobs through proxy", () => importTree(env, input));
  assert.match(first.tree, /^[a-f0-9]{40}$/);
  assert.equal(first.uploaded, 3);
  const second = await timed("re-import unchanged files", () => importTree(env, input));
  assert.deepEqual(second, { tree: first.tree, uploaded: 0 });

  // TEMPORARY: removed with jobhost phase 2
  await timed("phase-1 mount and heartbeat", async () => {
    await client.mount({ jobId: "contract-1", lineage, tree: first.tree, vsock });
    await client.heartbeat("contract-1");
    assert.equal((await get<{ legacyMounts: number }>("/v0/health")).legacyMounts, 1);
  });
  const guestroot = join(dir, "guestroot"), repo = join(guestroot, "repo");
  await mkdir(repo, { recursive: true });
  const oldUDS = process.env.CAMEL_VSOCK_UDS, oldConnect = process.env.CAMEL_VSOCK_CONNECT;
  process.env.CAMEL_VSOCK_UDS = vsock;
  delete process.env.CAMEL_VSOCK_CONNECT;
  cleanup.push(() => {
    if (oldUDS === undefined) delete process.env.CAMEL_VSOCK_UDS; else process.env.CAMEL_VSOCK_UDS = oldUDS;
    if (oldConnect === undefined) delete process.env.CAMEL_VSOCK_CONNECT; else process.env.CAMEL_VSOCK_CONNECT = oldConnect;
  });
  const guest = new Guest(guestroot, () => {});
  const handle = async (request: { op: string; [key: string]: unknown }) =>
    await guest.handle(request) as { ok: boolean; entries?: number; error?: string };
  const applied = await timed("guest apply", () => handle({ op: "camelfs_apply", jobId: "contract-1", timeoutMs: 30_000 }));
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.entries, 3);
  for (const [path, bytes] of contents) assert.deepEqual(await readFile(join(repo, path.slice(1))), bytes);
  await timed("edit guest files", async () => {
    await writeFile(join(repo, "README.md"), "# Updated contract\n");
    await unlink(join(repo, "src/b.txt"));
    await mkdir(join(repo, "src/new"));
    await writeFile(join(repo, "src/new/c.txt"), "charlie\n");
    await chmod(join(repo, "src/a.txt"), 0o755);
  });
  const [checkpoint, guestCheckpoint] = await timed("checkpoint daemon and guest", () => Promise.all([
    client.checkpoint("contract-1", 30_000, { trailers: { kind: "job", job: "contract-1", exitCode: 0 } }),
    handle({ op: "camelfs_checkpoint", jobId: "contract-1", timeoutMs: 30_000 }),
  ]));
  assert.equal(guestCheckpoint.ok, true, JSON.stringify(guestCheckpoint));
  assert.match(checkpoint.tree, /^[a-f0-9]{40}$/);
  assert.notEqual(checkpoint.tree, first.tree);
  const confirmed = await timed("guest checkpointed", () => handle({ op: "camelfs_checkpointed", tree: checkpoint.tree }));
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  assert.equal(confirmed.entries, 3);
  await timed("verify published tree and commit", async () => {
    const listing = await get<{ entries: { path: string; mode: string }[] }>(`/v0/trees/${checkpoint.tree}?lineage=${encodeURIComponent(lineage)}`);
    assert.deepEqual(listing.entries.map(entry => entry.path).sort(), ["README.md", "src/a.txt", "src/new/c.txt"]);
    assert.equal(listing.entries.find(entry => entry.path === "src/a.txt")?.mode, "100755");
    assert.match(checkpoint.commit, /^[a-f0-9]{40}$/, "the daemon answers the commit it wrote");
    const commit = await get<{ parents: string[]; trailers: Record<string, string> }>(`/v0/commits/${checkpoint.commit}?lineage=${encodeURIComponent(lineage)}`);
    assert.deepEqual(commit.parents, []);
    assert.equal(commit.trailers["Camel-Job"], "contract-1");
    assert.equal(commit.trailers["Camel-Exit"], "0");
  });
  await timed("release", () => client.release("contract-1"));
  completed = true;
});

// Error transport is independent of daemon setup. In particular the
// authorization check must never turn an incomplete walk into false/null.
async function storageContract(t: TestContext, origin: string, tokenFor: (lineage: string, acc?: string) => string) {
  const statuses: { method: string; path: string; status: number }[] = [];
  const fetchReal = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetchReal(url, init);
    if (!(url instanceof URL)) return response;
    statuses.push({ method: init?.method ?? "GET", path: url.pathname, status: response.status });
    return response;
  });
  const storage = camelfsStorage("agent:contract", ({ path, claims }, init) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${tokenFor(claims.lin, claims.acc)}`);
    return fetch(new URL(path, origin), { ...init, headers });
  });
  const lineage = "contract:storage";
  const bytes = (s: string) => new TextEncoder().encode(s);
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  const input = (parents: string[], changes: CommitInput["changes"] = [], extra: Partial<CommitInput> = {}): CommitInput => ({
    parents, changes, author: "agent:contract", message: "contract", trailers: { "Camel-Test": "storage" }, time: 123, ...extra,
  });
  const shape = (c: CommitResult, parents: string[]) => {
    assert.deepEqual(Object.keys(c).sort(), ["bytes", "changed", "commit", "parents", "time", "tree"]);
    assert.match(c.tree, /^[a-f0-9]{40}$/); assert.match(c.commit, /^[a-f0-9]{40}$/);
    assert.deepEqual(c.parents, parents); assert.equal(c.time, 123);
    assert.equal(typeof c.changed, "number"); assert.equal(typeof c.bytes, "number");
  };
  const empty = await storage.commit(lineage, input([]));
  shape(empty, []);
  assert.equal(empty.tree, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  assert.equal(empty.changed, 0); assert.equal(empty.bytes, 0);
  const content = "one\ntwo\nthree\nfour\nfive\n";
  const blob = await storage.putBlob(lineage, bytes(content));
  assert.deepEqual(blob, { blob: createHash("sha1").update(`blob ${bytes(content).length}\0`).update(content).digest("hex"),
    sha256: createHash("sha256").update(content).digest("hex"), size: bytes(content).length });
  assert.deepEqual(await storage.putBlob(lineage, bytes(content)), blob);
  const binaryBytes = Uint8Array.from([0, 255, 13, 10, 128, 45, 45]);
  const binary = await storage.putBlob(lineage, binaryBytes);
  const firstInput = input([empty.commit], [{ path: "shared.txt", blob: blob.blob }, { path: "dir/binary", blob: binary.blob }]);
  const first = await storage.commit(lineage, firstInput, "contract-first");
  shape(first, [empty.commit]);
  assert.equal(first.changed, 2); assert.equal(first.bytes, blob.size + binary.size);
  assert.deepEqual(await storage.commit(lineage, firstInput, "contract-first"), first);
  const noEdits = await storage.commit(lineage, input([first.commit]));
  shape(noEdits, [first.commit]); assert.equal(noEdits.tree, first.tree); assert.equal(noEdits.changed, 0); assert.equal(noEdits.bytes, 0);
  assert.equal(text(await storage.readBlob(lineage, blob.blob, first.tree, "shared.txt")), content);
  const ranged = await storage.openBlob(lineage, blob.blob, first.tree, "shared.txt", "bytes=0-2");
  assert.equal(ranged.status, 206); assert.equal(ranged.headers.get("x-camel-blob"), blob.blob);
  assert.equal(ranged.headers.get("x-camel-size"), String(blob.size)); assert.equal(await ranged.text(), "one");
  assert.deepEqual(await storage.readBatch(lineage, first.tree, ["dir/binary", "missing", "shared.txt"]), [
    { path: "dir/binary", blob: binary.blob, mode: "100644", size: binary.size, bytes: binaryBytes },
    { path: "missing", error: "not_in_tree" },
    { path: "shared.txt", blob: blob.blob, mode: "100644", size: blob.size, bytes: bytes(content) },
  ]);
  assert.deepEqual(await storage.readBatch(lineage, first.tree, []), []);
  const page = await storage.listTree(lineage, first.tree, { limit: 1 });
  assert.equal(page.entries.length, 1); assert.equal(page.entries[0].path, "dir"); assert.equal(page.entries[0].mode, "040000");
  assert("tree" in page.entries[0]); assert.match(page.entries[0].tree, /^[a-f0-9]{40}$/); assert.equal(page.next, "dir");
  assert.deepEqual(await storage.listTree(lineage, first.tree, { after: page.next }), { entries: [
    { path: "shared.txt", blob: blob.blob, mode: "100644", size: blob.size },
  ] });
  assert.deepEqual(await storage.listAll(lineage, first.tree, "dir"), [
    { path: "dir/binary", blob: binary.blob, mode: "100644", size: binary.size },
  ]);
  const oursBlob = await storage.putBlob(lineage, bytes("ONE\ntwo\nthree\nfour\nfive\n"));
  const theirsBlob = await storage.putBlob(lineage, bytes("one\ntwo\nthree\nfour\nFIVE\n"));
  const ours = await storage.commit(lineage, input([first.commit], [{ path: "shared.txt", blob: oursBlob.blob }]));
  const theirs = await storage.commit(lineage, input([first.commit], [{ path: "shared.txt", blob: theirsBlob.blob }]));
  assert.deepEqual(await storage.diff(lineage, first.tree, ours.tree), { changes: [
    { path: "shared.txt", status: "modified", oldBlob: blob.blob, newBlob: oursBlob.blob, oldMode: "100644", newMode: "100644", oldSize: blob.size, newSize: oursBlob.size },
  ] });
  assert.deepEqual(await storage.diff(lineage, first.tree, ours.tree, "dir"), { changes: [] });
  const merged = await storage.merge(lineage, { base: first.tree, ours: ours.tree, theirs: theirs.tree, mode: "merge" });
  assert("tree" in merged); assert.match(merged.tree, /^[a-f0-9]{40}$/);
  assert.deepEqual(merged.merged, ["shared.txt"]); assert.equal(typeof merged.took.ours, "number"); assert.equal(typeof merged.took.theirs, "number");
  const squash = await storage.merge(lineage, { base: first.tree, ours: ours.tree, theirs: theirs.tree, mode: "squash" });
  assert.deepEqual(squash, merged);
  const mergeCommit = await storage.commit(lineage, input([ours.commit, theirs.commit], [], { baseTree: merged.tree, message: "merge" }));
  shape(mergeCommit, [ours.commit, theirs.commit]); assert.equal(mergeCommit.tree, merged.tree);
  assert.deepEqual(await storage.getCommit(lineage, mergeCommit.commit), { tree: merged.tree, parents: [ours.commit, theirs.commit],
    author: "agent:contract", message: "merge", trailers: { "Camel-Test": "storage" }, time: 123 });
  assert.deepEqual((await storage.getCommit(lineage, empty.commit)).parents, []);
  assert.deepEqual((await storage.getCommit(lineage, first.commit)).parents, [empty.commit]);
  assert.equal(await storage.isAncestor(lineage, first.commit, mergeCommit.commit), true);
  assert.equal(await storage.isAncestor(lineage, theirs.commit, mergeCommit.commit), true);
  assert.equal(await storage.isAncestor(lineage, ours.commit, theirs.commit), false);
  assert.equal(await storage.isAncestor(lineage, first.commit, first.commit), true);
  assert.deepEqual(await storage.mergeBase(lineage, ours.commit, theirs.commit), { base: first.commit, tree: first.tree });
  assert.deepEqual(await storage.mergeBase(lineage, theirs.commit, mergeCommit.commit), { base: theirs.commit, tree: theirs.tree });
  const disjoint = await storage.commit(lineage, input([], [], { message: "disjoint" }));
  assert.equal(await storage.mergeBase(lineage, first.commit, disjoint.commit), null);
  assert.equal(await storage.isAncestor(lineage, first.commit, disjoint.commit), false);
  assert.deepEqual(await storage.entry(lineage, first.tree, "dir/binary"),
    { path: "dir/binary", mode: "100644", blob: binary.blob, size: binary.size });
  assert.deepEqual(await storage.entry(lineage, first.tree, "dir"), page.entries[0]);
  assert.equal(await storage.entry(lineage, first.tree, "absent"), null);
  const sizeChanges = await storage.commit(lineage, input([first.commit], [
    { path: "shared.txt", mode: "100755" }, { path: "dir/binary", delete: true },
    { path: "symlink", blob: blob.blob, mode: "120000" },
  ]));
  assert.deepEqual(await storage.entry(lineage, sizeChanges.tree, "symlink"),
    { path: "symlink", mode: "120000", blob: blob.blob, size: blob.size });
  assert.deepEqual(await storage.diff(lineage, first.tree, sizeChanges.tree), { changes: [
    { path: "dir/binary", status: "deleted", oldBlob: binary.blob, oldMode: "100644", oldSize: binary.size },
    { path: "shared.txt", status: "mode", oldBlob: blob.blob, newBlob: blob.blob, oldMode: "100644", newMode: "100755", oldSize: blob.size, newSize: blob.size },
    { path: "symlink", status: "added", newBlob: blob.blob, newMode: "120000", newSize: blob.size },
  ] });
  for (const [op, run] of [
    ["entry", () => storage.entry("other", first.tree, "dir")],
    ["isAncestor", () => storage.isAncestor(lineage, "f".repeat(40), first.commit)],
    ["mergeBase", () => storage.mergeBase(lineage, first.commit, "f".repeat(40))],
  ] as const) await assert.rejects(run(), (e: unknown) => e instanceof StorageError &&
    e.status === 404 && e.code === "not_found" && e.op === op && e.reason.length > 0);
  for (const [path, message] of [
    [`commits/${first.commit}/is-ancestor`, "missing field of"],
    ["merge-base", "missing field a"],
    [`merge-base?a=${first.commit}`, "missing field b"],
    [`merge-base?a=x&b=${first.commit}`, "invalid commit x"],
    [`trees/${first.tree}/entry?path=`, "missing field path"],
    [`trees/${first.tree}/entry?path=../x`, "invalid path ../x"],
  ]) {
    const r = await fetch(`${origin}/v1/lineages/${lineage}/${path}`, { headers: { authorization: `Bearer ${tokenFor(lineage)}` } });
    assert.equal(r.status, 400);
    const v = await r.json() as { error: { code: string; message: string } };
    assert.equal(v.error.code, "invalid_request"); assert(v.error.message.includes(message), JSON.stringify(v));
  }
  // Node's HTTP client sends real chunked framing, with no Content-Length.
  const chunked = Buffer.from("chunked contract blob\n");
  await new Promise<void>((resolve, reject) => {
    const req = request(`${origin}/v1/lineages/${lineage}/blobs`, { method: "PUT",
      headers: { authorization: `Bearer ${tokenFor(lineage)}`, "Transfer-Encoding": "chunked" } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("error", reject);
      res.on("end", () => { try {
        assert.equal(res.statusCode, 201);
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
          blob: createHash("sha1").update(`blob ${chunked.length}\0`).update(chunked).digest("hex"),
          sha256: createHash("sha256").update(chunked).digest("hex"), size: chunked.length,
        }); resolve();
      } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.write(chunked.subarray(0, 3)); req.end(chunked.subarray(3));
  });

  const entries = await storage.listAll(lineage, merged.tree);
  const shared = entries.find(e => e.path === "shared.txt"); assert(shared && "blob" in shared);
  assert.equal(text(await storage.readBlob(lineage, shared.blob, merged.tree, shared.path)), "ONE\ntwo\nthree\nfour\nFIVE\n");
  const conflictBlob = await storage.putBlob(lineage, bytes("OTHER\ntwo\nthree\nfour\nfive\n"));
  const conflictSide = await storage.commit(lineage, input([first.commit], [{ path: "shared.txt", blob: conflictBlob.blob }]));
  const conflict = await storage.merge(lineage, { base: first.tree, ours: ours.tree, theirs: conflictSide.tree, mode: "merge" });
  assert.deepEqual(conflict, { conflicts: [{ path: "shared.txt", base: blob.blob, ours: oursBlob.blob, theirs: conflictBlob.blob, reason: "both_modified" }] });
  const grep = await storage.grep(lineage, { tree: merged.tree, q: "^one$", regex: true, ignoreCase: true, path: "*.txt", context: 1 });
  assert.deepEqual(grep, { matches: [{ path: "shared.txt", line: 1, text: "ONE", after: ["two"] }], files: 1, truncated: false, indexed: "scan" });
  const current = await storage.commit(lineage, input([first.commit], [], { time: undefined }));
  assert(Number.isSafeInteger(current.time)); assert(Math.abs(current.time - Date.now() / 1000) < 10);
  for (const [badInput, field] of [[{ ...input([]), parents: undefined }, "parents"], [{ ...input([]), parent: null }, 'unknown field parent']] as const) {
    await assert.rejects(storage.commit(lineage, badInput as unknown as CommitInput), (e: unknown) =>
      e instanceof StorageError && e.status === 400 && e.code === "invalid_request" && e.message.includes(field));
  }
  await assert.rejects(storage.commit("other", input([first.commit])), (e: unknown) => e instanceof StorageError && e.status === 400 && e.code === "unknown_commit");
  assert(statuses.some(s => s.method === "PUT" && s.status === 201)); assert(statuses.some(s => s.method === "PUT" && s.status === 200));
  assert(statuses.some(s => s.path.endsWith("/merge") && s.status === 409));
}

test("camelFS contract: stateless API with runtime-signed tokens", {
  skip: !process.env.CAMELFSD_BIN && process.env.CAMELFS_CONTRACT_REQUIRED !== "1"
    ? "set CAMELFSD_BIN to a camelfsd built from camelfsd/" : false,
  timeout: 120_000,
}, async t => {
  assert.ok(process.env.CAMELFSD_BIN, "CAMELFS_CONTRACT_REQUIRED=1 requires CAMELFSD_BIN");
  const binary = resolve(process.env.CAMELFSD_BIN);
  const dir = await mkdtemp(join(tmpdir(), "cfs-api-contract-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const issuer = "https://runtime.contract.example";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid = "contract-key";
  const jwks = JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" }] });
  const tokenFor = (lin: string, acc = "w", extra: Record<string, unknown> = {}) => {
    const iat = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "EdDSA", kid, typ: "camelfs+jwt" })}.${encode({
      iss: issuer, aud: "camelrun:camelfs", sub: "agent:contract", iat, exp: iat + 120, lin, acc, refs: [], ...extra,
    })}`;
    return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
  };
  const jwksFile = join(dir, "jwks.json");
  await writeFile(jwksFile, jwks);

  for (const source of ["file", "env"]) await t.test(source, async t => {
    const env = { ...process.env };
    delete env.CAMELFS_JWKS;
    const flags = ["api", "--listen", "127.0.0.1:0", "--data", join(dir, source),
      "--store", join(dir, "store"), "--token-issuer", issuer];
    if (source === "file") flags.push("--jwks-file", jwksFile);
    else env.CAMELFS_JWKS = jwks;
    if (source === "file" && process.env.CAMELFS_DDB_LOCAL) {
      flags.push(...await refsTableFlags(t, process.env.CAMELFS_DDB_LOCAL));
    }
    const daemon = spawn(binary, flags, { env, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "", spawnError: Error | undefined, completed = false;
    daemon.on("error", error => { spawnError = error; });
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on("data", chunk => { logs = (logs + chunk).slice(-16_384); });
    const exited = new Promise<void>(resolve => daemon.once("close", () => resolve()));
    t.after(async () => {
      daemon.kill("SIGTERM");
      const killTimer = setTimeout(() => daemon.kill("SIGKILL"), 3000);
      try { await exited; } finally { clearTimeout(killTimer); }
      if (!completed) t.diagnostic(`camelfsd API output:\n${logs}`);
    });
    const until = async <T>(check: () => T | undefined): Promise<T> => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        if (spawnError) throw spawnError;
        assert.equal(daemon.exitCode, null, logs);
        const value = check();
        if (value !== undefined) return value;
        assert.ok(Date.now() < deadline, logs);
        await delay(50);
      }
    };
    const address = await until(() => /op=api listen=(127\.0\.0\.1:\d+)/.exec(logs)?.[1]);
    const origin = `http://${address}`;
    const health = await fetch(origin + "/v0/health");
    assert.equal(health.status, 200);
    const version = await health.json();
    assert.deepEqual(Object.keys(version), ["version"]);
    assert.match(version.version, /^\d+\.\d+\.\d+$/);
    const stats = async (token?: string) => {
      const response = await fetch(origin + "/v0/stats", token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
      await response.arrayBuffer();
      return response.status;
    };
    assert.equal(await stats(), 401);
    assert.equal(await stats(tokenFor("arbitrary", "r")), 200);

    if (source === "file") {
      if (process.env.CAMELFS_DDB_LOCAL) {
        const lineage = "contract:storage";
        const registration = await fetch(origin + "/v1/lineages/" + lineage, {
          method: "PUT",
          headers: { authorization: `Bearer ${tokenFor(lineage)}`, "content-type": "application/json" },
          body: JSON.stringify({ tenant: "contract", kind: "workspace", defaultBranch: "main" }),
        });
        assert.equal(registration.status, 201, await registration.text());
      }
      await storageContract(t, origin, tokenFor);
      if (process.env.CAMELFS_DDB_LOCAL) {
        await refsContract(request => fetch(request), origin, tokenFor);
      }
      await writeFile(jwksFile, "{");
      assert.ok(daemon.kill("SIGHUP"));
      await until(() => logs.includes("op=jwks-reload error=") || undefined);
      assert.equal(await stats(tokenFor("arbitrary", "r")), 200);
    }
    completed = true;
  });
});

test("camelFS storage client preserves too_deep and operation context", async t => {
  const storage = camelfsStorage("agent:contract", async () =>
    Response.json({ error: { code: "too_deep", message: "too_deep" } }, { status: 413 }));
  for (const [op, run] of [
    ["isAncestor", () => storage.isAncestor("l", "a", "b")],
    ["mergeBase", () => storage.mergeBase("l", "a", "b")],
    ["entry", () => storage.entry("l", "t", "p")],
    ["diff", () => storage.diff("l", "a", "b")],
  ] as const) await assert.rejects(run(), (e: unknown) => e instanceof StorageError &&
    e.status === 413 && e.code === "too_deep" && e.reason === "too_deep" && e.op === op);
});


async function refsTableFlags(t: import("node:test").TestContext, endpoint: string) {
  const cli = promisify(execFile);
  const run = (command: string, ...args: string[]) => cli("aws",
    ["dynamodb", command, "--endpoint-url", endpoint, "--region", "us-west-2", ...args], {
      env: { ...process.env, AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local",
        AWS_SESSION_TOKEN: "", AWS_PAGER: "" },
    });
  const suffix = randomUUID();
  const tables = {
    refs: `contract-refs-${suffix}`, lineages: `contract-lineages-${suffix}`, marks: `contract-marks-${suffix}`,
  };
  for (const [kind, name] of Object.entries(tables)) {
    const keys = kind === "refs" ? ["lineage", "name"] : ["lineage"];
    await run("create-table", "--table-name", name, "--billing-mode", "PAY_PER_REQUEST",
      "--attribute-definitions", ...keys.map(key => `AttributeName=${key},AttributeType=S`),
      "--key-schema", ...keys.map((key, i) => `AttributeName=${key},KeyType=${i ? "RANGE" : "HASH"}`));
    t.after(async () => { await run("delete-table", "--table-name", name); });
    await run("wait", "table-exists", "--table-name", name);
  }
  return ["--ddb-endpoint", endpoint, "--refs-table", tables.refs, "--lineages-table", tables.lineages, "--marks-table", tables.marks];
}

type RefToken = (lineage: string, access?: string, extra?: Record<string, unknown>) => string;

async function refsContract(send: (request: Request) => Promise<Response>, origin: string, tokenFor: RefToken,
  fake = false) {
  const lineage = "contract:refs";
  const runtime = tokenFor(lineage, "w", { sub: "runtime:contract", refs: ["main", "fork/*"] });
  const read = tokenFor(lineage, "r", { refs: ["main", "fork/*"] });
  const agent = tokenFor(lineage, "w", { refs: ["main"] });
  const call = async (method: string, path: string, status: number, options: {
    body?: unknown; code?: string; token?: string; key?: string;
  } = {}) => {
    const headers = new Headers({ Authorization: `Bearer ${options.token ?? runtime}` });
    if (options.key) headers.set("Idempotency-Key", options.key);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    const r = await send(new Request(`${origin}/v1/lineages/${lineage}${path}`, {
      method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }));
    const raw = await r.text();
    assert.equal(r.status, status, `${method} ${path}: ${raw}`);
    if (!raw) return undefined;
    const body = JSON.parse(raw);
    if (options.code) assert.equal(body.error.code, options.code, raw);
    return body;
  };
  const metadata = { tenant: "contract", kind: "workspace", defaultBranch: "main" };
  await call("PUT", "", 201, { body: metadata });
  await call("PUT", "", 200, { body: metadata });
  const item = await call("GET", "", 200, { token: read });
  for (const [key, value] of Object.entries(metadata)) assert.equal(item[key], value);
  const storage = camelfsStorage("runtime:contract", ({ path, claims }, init) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${tokenFor(claims.lin, claims.acc, { sub: "runtime:contract" })}`);
    return send(new Request(origin + path, { ...init, headers }));
  });
  const owner = "agent:contract";
  const commit = (parents: string[], changes: CommitInput["changes"] = [], message = "contract") =>
    storage.commit(lineage, { parents, changes, author: owner, message, time: 123, trailers: {} });
  const blob = await storage.putBlob(lineage, new TextEncoder().encode("refs contract"));
  const base = await commit([]);
  const tip = await commit([base.commit], [{ path: "nested/a", blob: blob.blob }]);
  const side = await commit([base.commit], [], "side");
  const create = { name: "main", version: base.commit, owner };
  const main = await call("POST", "/refs", 201, { body: create, key: "create" });
  assert.equal(main.createdBy, "runtime:contract");
  assert.equal(main.tree, base.tree);
  assert.deepEqual(await call("POST", "/refs", 201, { body: create, key: "create" }), main);
  await call("POST", "/refs", 409, { body: create, code: "ref_exists" });
  await call("POST", "/refs", 400, { body: { ...create, version: "f".repeat(40) }, code: "unknown_commit" });
  await call("POST", "/refs", 403, { body: { ...create, name: "outside" } });
  await call("POST", "/refs", 201, { body: { ...create, name: "fork/a", version: side.commit } });
  const list = await call("GET", "/refs?prefix=fork/&limit=1", 200, { token: read });
  assert.deepEqual(list.refs.map((ref: {name: string}) => ref.name), ["fork/a"]);
  assert.deepEqual(await call("GET", "/refs/main", 200, { token: read }), main);
  await call("GET", "/refs/fork%2Fa", 200, { token: read });
  await call("GET", "/refs/fork%2Fmissing", 404, { code: "ref_not_found" });
  const cas = { commit: tip.commit, expect: base.commit };
  await call("POST", "/refs/main/cas", 400, { body: { commit: tip.commit }, code: "invalid_request" });
  const moved = await call("POST", "/refs/main/cas", 200, { body: cas, key: "move" });
  assert.equal(moved.version, tip.commit);
  assert.equal(moved.tree, tip.tree);
  assert.equal(moved.files, 1);
  assert.equal(moved.bytes, blob.size);
  assert.deepEqual(moved.parents, [base.commit]);
  assert.equal(moved.diff[0].path, "nested/a");
  assert.deepEqual(await call("POST", "/refs/main/cas", 200, { body: cas, key: "move" }), moved);
  const stale = await call("POST", "/refs/main/cas", 412, { body: cas, code: "stale" });
  assert.equal(stale.error.details.current, tip.commit);
  await call("POST", "/refs/main/cas", 409, { body: { commit: side.commit, expect: tip.commit }, code: "not_fast_forward" });
  await call("PUT", "/refs/main/watchers/agent:contract", 204);
  await call("DELETE", "/refs/main/watchers/agent:contract", 204);

  const holder = { host: "contract-host", boot: 1, mount: "contract-mount" };
  const leaseBody = { holder, ttlMs: 60000 };
  await call("POST", "/refs/main/lease", 403, { token: agent, body: leaseBody });
  const lease = await call("POST", "/refs/main/lease", 200, { body: leaseBody, key: "lease" });
  assert.equal(lease.version, tip.commit);
  assert.equal(lease.tree, tip.tree);
  assert.deepEqual(await call("POST", "/refs/main/lease", 200, { body: leaseBody, key: "lease" }), lease);
  // The same holder re-acquiring keeps its epoch; another holder is refused.
  const again = await call("POST", "/refs/main/lease", 200, { body: leaseBody });
  assert.equal(again.epoch, lease.epoch);
  await call("POST", "/refs/main/lease", 409, { body: { holder: { ...holder, host: "other-host" }, ttlMs: 60000 }, code: "held" });
  const held = await call("GET", "/refs/main", 200);
  assert.deepEqual(held.holder, holder);
  await call("POST", "/refs/main/cas", 409, { body: { commit: tip.commit, expect: tip.commit }, code: "fenced" });
  const refused = await call("DELETE", "", 409, { code: "held" });
  assert.deepEqual(refused.error.details.held, ["main"]);
  assert.deepEqual(await call("GET", "/refs/main", 200), held);
  const fence = tokenFor(lineage, "w", { sub: "runtime:contract", refs: ["main"], fence: {
    holder: `${holder.host}:${holder.boot}:${holder.mount}`, epoch: lease.epoch,
  } });
  await call("POST", "/refs/main/lease/renew", 200, { token: fence, body: { ttlMs: 60000 } });
  await call("DELETE", "/refs/main/lease", 204, { token: fence });
  await call("DELETE", "/refs/main?expect=" + base.commit, 412, { code: "stale" });
  await call("DELETE", "/refs/main?expect=" + tip.commit, 204);
  const reborn = await call("POST", "/refs", 201, { body: create });
  assert.equal(reborn.leaseEpoch, lease.epoch);
  const metadataFor = { author: owner, message: "ref mutation", time: 321 };
  const write = (changes: unknown[], expect?: string) => ({ ...metadataFor, changes, expect });
  const edit = write([{ path: "inline", text: "hello", expectBlob: "none" }], base.commit);
  const written = await call("POST", "/refs/main/write", 201, { body: edit, key: "write" });
  assert.deepEqual(await call("POST", "/refs/main/write", 201, { body: edit, key: "write" }), written);
  assert.deepEqual(Object.keys(written).sort(), ["bytes", "changed", "files", "parents", "time", "tree", "version"]);
  assert.deepEqual(written.parents, [base.commit]);
  assert.equal(written.time, 321);
  assert.equal(written.files, 1);
  const [added] = written.changed;
  assert.deepEqual(added, {
    path: "inline", status: "added", newBlob: createHash("sha1").update("blob 5\0hello").digest("hex"),
    newSize: 5, mode: "100644",
  });
  const mismatch = await call("POST", "/refs/main/write", 412, {
    body: write([{ path: "inline", delete: true, expectBlob: "none" }]), code: "stale",
  });
  assert.deepEqual(mismatch.error.details, { current: written.version, path: "inline", blob: added.newBlob });
  await call("POST", "/refs/main/write", 413, {
    body: write([{ path: "huge", text: "x".repeat(8 * 1024 ** 2 + 1) }]), code: "too_large",
  });

  await call("POST", "/refs", 201, { body: { ...create, name: "fork/ff" } });
  const mergeBody = (theirs: string, mode: string) => ({ ...metadataFor, theirs, mode });
  const ff = await call("POST", "/refs/fork%2Fff/merge", 201, { body: mergeBody(written.version, "ff-only") });
  assert.equal(ff.version, written.version);
  assert.equal(ff.tree, written.tree);
  assert.equal(ff.ff, true);
  assert.deepEqual(ff.merged, []);
  assert.deepEqual(ff.took, { ours: 0, theirs: 1 });
  await call("POST", "/refs/main/merge", 409, { body: mergeBody(tip.commit, "ff-only"), code: "not_fast_forward" });
  const merged = await call("POST", "/refs/main/merge", 201, { body: mergeBody(tip.commit, "merge") });
  assert.equal(merged.ff, false);
  assert.deepEqual((await storage.getCommit(lineage, merged.version)).parents, [written.version, tip.commit]);
  const squashed = await call("POST", "/refs/fork%2Fff/merge", 201, { body: mergeBody(tip.commit, "squash") });
  assert.equal(squashed.ff, false);
  assert.deepEqual((await storage.getCommit(lineage, squashed.version)).parents, [written.version]);
  assert.equal(squashed.tree, merged.tree);
  const restored = await call("POST", "/refs/main/restore", 201, { body: { ...metadataFor, version: base.commit } });
  assert.equal(restored.tree, base.tree);
  assert.deepEqual((await storage.getCommit(lineage, restored.version)).parents, [merged.version]);
  if (!fake) {
    assert.deepEqual(Object.keys(ff).sort(), ["bytes", "ff", "files", "merged", "took", "tree", "version"]);
    assert.deepEqual(Object.keys(restored).sort(), ["bytes", "files", "tree", "version"]);
    assert.equal((await storage.getCommit(lineage, restored.version)).trailers["Camel-Op"], "restore");
    assert.equal((await storage.getCommit(lineage, written.version)).trailers["Camel-Op"], "api");
  }
  assert.deepEqual(await call("DELETE", "/refs?owner=" + owner, 200), { deleted: ["fork/a", "fork/ff", "main"], held: [] });
  await call("DELETE", "", 204);
  await call("GET", "", 410, { code: "lineage_deleted" });
  await call("GET", "/refs/main", 410, { code: "lineage_deleted" });
  await call("GET", "/commits/" + tip.commit, 410, { code: "lineage_deleted" });
}

test("camelFS refs contract: R2 fake", {
  skip: !process.env.CAMELFS_CONTRACT_FAKE_REFS && "set CAMELFS_CONTRACT_FAKE_REFS=1 once the R2 fake is available",
}, async () => {
  const issuer = "https://runtime.contract.example";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid = "refs-contract";
  const tokenFor: RefToken = (lin, acc = "w", extra = {}) => {
    const iat = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "EdDSA", kid, typ: "camelfs+jwt" })}.${encode({
      iss: issuer, aud: "camelrun:camelfs", sub: "agent:contract", iat, exp: iat + 120, lin, acc, refs: [], ...extra,
    })}`;
    return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
  };
  const { fakeCamelfsd } = await import(new URL("../backends/workers/test/fake-camelfsd.ts", import.meta.url).href);
  const fake = fakeCamelfsd("", { issuer, jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), kid }] } });
  await refsContract(fake.fetch, "http://camelfsd.test", tokenFor, true);
});

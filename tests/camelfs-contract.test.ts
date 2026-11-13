import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { camelfsdClient, serveImportProxy } from "../jobhost/camelfsd.ts";
import { Guest } from "../jobhost/guest.ts";

// Only a real binary enables this test. CI requires it so a broken setup cannot skip.
test("camelFS contract: runtime import, jobhost proxy and guest against real camelfsd", {
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
  // Reserve an ephemeral loopback port; NBD is unused by this tree/stream test.
  const portServer = createServer();
  await new Promise<void>((resolve, reject) => {
    portServer.once("error", reject);
    portServer.listen(0, "127.0.0.1", resolve);
  });
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()));
  const daemon = spawn(binary, ["host", "--socket", socketPath, "--data", join(dir, "data"),
    "--store", join(dir, "store"), "--nbd-listen", `127.0.0.1:${port}`,
    "--cold", "prehydrate", "--virtual-size", String(16 * 1024 * 1024)], {
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
  const token = randomUUID(), lineage = "contract:first-mount";
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
  // Workers has its own TypeScript project and Cloudflare fetch types. Load the
  // real module at runtime without pulling that project into the Node typecheck.
  const { importTree } = await import(new URL("../backends/workers/src/jobs/camelfs.ts", import.meta.url).href) as {
    importTree(environment: typeof env, treeInput: typeof input): Promise<{ tree: string; uploaded: number }>;
  };
  const first = await timed("import streamed blobs through proxy", () => importTree(env, input));
  assert.match(first.tree, /^[a-f0-9]{40}$/);
  assert.equal(first.uploaded, 3);
  const second = await timed("re-import unchanged files", () => importTree(env, input));
  assert.deepEqual(second, { tree: first.tree, uploaded: 0 });

  await timed("mount from empty parent", () => client.mount({ jobId: "contract-1", lineage, tree: first.tree, vsock, ...{ fence: { holder: "contract-runtime", epoch: 1 } } }));
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
    const commit = await get<{ trailers: Record<string, string> }>(`/v0/commits/${checkpoint.commit}?lineage=${encodeURIComponent(lineage)}`);
    assert.equal(commit.trailers["Camel-Job"], "contract-1");
    assert.equal(commit.trailers["Camel-Exit"], "0");
  });
  await timed("release", () => client.release("contract-1"));
  completed = true;
});

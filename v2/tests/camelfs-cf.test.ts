import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { unstable_startWorker } from "wrangler";
import { CamelRun } from "../sdk/src/index.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ADMIN_SECRET = "test-cf-camelfs-admin";
const VAULT_SECRET = "test-cf-camelfs-vault-secret-32b!!";
const INTERNAL_SECRET = "test-cf-camelfs-internal-blob-secret";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastErr)}`);
}

describe("camelRun v2 native Cloudflare camelFS (SDK <-> workerd <-> CamelfsLineageDO + R2 <-> live FUSE containerd)", () => {
  let tempDir: string;
  let containerProc: ChildProcess | undefined;
  let containerUrl: string;
  let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
  let workerUrl: string;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "camelrun-v2-cf-camelfs-"));

    // 1. Build and start the Cloudflare Container FUSE daemon locally
    const binPath = join(tempDir, "camelfs-cf-containerd");
    execFileSync("go", ["build", "-o", binPath, "./cmd/camelfs-cf-containerd"], {
      cwd: join(ROOT, "camelfsd"),
      stdio: "pipe",
    });

    const containerPort = await getFreePort();
    containerUrl = `http://127.0.0.1:${containerPort}`;
    containerProc = spawn(
      binPath,
      ["--listen", `127.0.0.1:${containerPort}`, "--data-dir", join(tempDir, "container-data")],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForHealth(`${containerUrl}/healthz`);

    // 2. Start real Cloudflare workerd with CAMELFS_BACKEND=cloudflare (NO external camelfsd!)
    const workerPort = await getFreePort();
    workerUrl = `http://127.0.0.1:${workerPort}`;
    const baseConfig = JSON.parse(
      readFileSync(join(ROOT, "worker/wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
    );
    const testConfigPath = join(tempDir, "wrangler.cf-test.json");
    writeFileSync(
      testConfigPath,
      JSON.stringify(
        {
          ...baseConfig,
          name: "camelrun-v2-cf-camelfs-test",
          main: join(ROOT, "worker/src/index.ts"),
          vars: {
            ADMIN_SECRET,
            VAULT_SECRET,
            CAMELFS_BACKEND: "cloudflare",
            CAMELFS_URL: "",
            CAMELFS_SELF_URL: workerUrl,
            CAMELFS_INTERNAL_SECRET: INTERNAL_SECRET,
            CAMELFS_CONTAINER_URL: containerUrl,
            DEFAULT_MODEL: "mock/default",
          },
          r2_buckets: [
            ...(baseConfig.r2_buckets ?? []),
            { binding: "CAMELFS_BUCKET", bucket_name: "camelrun-camelfs-v2-test" },
          ],
          durable_objects: {
            bindings: [
              ...(baseConfig.durable_objects?.bindings ?? []).filter(
                (b: { name?: string }) => b.name !== "CODEMODE_SANDBOX",
              ),
              { name: "CAMELFS_LINEAGE_DO", class_name: "CamelfsLineageDO" },
              { name: "CAMELFS_CONTAINER_DO", class_name: "CamelfsContainerDO" },
            ],
          },
          migrations: [
            {
              tag: "v1",
              new_sqlite_classes: ["TenantDO", "AgentDO", "VoiceCallDO", "CamelfsLineageDO", "CamelfsContainerDO"],
            },
          ],
        },
        null,
        2,
      ),
    );

    worker = await unstable_startWorker({
      config: testConfigPath,
      dev: {
        persist: join(tempDir, "wrangler-state"),
        server: { hostname: "127.0.0.1", port: workerPort },
        logLevel: "none",
      },
    });
    await waitForHealth(`${workerUrl}/healthz`);
  });

  after(async () => {
    await worker?.dispose().catch(() => {});
    const proc = containerProc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
          resolve();
        }, 3000);
      });
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("1. Repo CRUD, hot DO SQLite cache, async R2 archival, history, restore, and O(1) fork work natively on Cloudflare DO + R2", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "cf-native-repo-tenant",
      initialCreditsUsd: 25,
    });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });

    const repo = await camel.repos.create({ name: "cf-repo" });
    assert.ok(repo.repoId);
    assert.ok(repo.lineage.startsWith("lin_"));

    const w1 = await camel.repos.write(repo.repoId, {
      puts: [
        { path: "README.md", content: "# Native CF camelFS\n" },
        { path: "src/index.ts", content: "export const greeting = 'hello_cf';\n" },
      ],
      message: "initial files",
    });
    assert.equal(w1.changed.length, 2);

    const w2 = await camel.repos.write(repo.repoId, {
      puts: [{ path: "src/index.ts", content: "export const greeting = 'updated_cf';\n" }],
      message: "update greeting",
    });
    assert.notEqual(w2.commit, w1.commit);

    // Read, ls, grep, and history served from DO SQLite
    const rd = await camel.repos.read(repo.repoId, { path: "src/index.ts" });
    assert.equal(rd.content, "export const greeting = 'updated_cf';\n");

    const ls = await camel.repos.ls(repo.repoId, { recursive: true, glob: "**/*.ts" });
    assert.deepEqual(
      ls.entries.map((e) => e.path),
      ["src/index.ts"],
    );

    const grep = await camel.repos.grep(repo.repoId, { pattern: "updated_cf" });
    assert.equal(grep.matches.length, 1);
    assert.equal(grep.matches[0].path, "src/index.ts");

    const hist = await camel.repos.history(repo.repoId, { limit: 10 });
    assert.equal(hist.commits.length, 3); // initial + w1 + w2

    // Verify async R2 outbox flushes cleanly and commit exists in R2
    const outboxRes = await fetch(
      `${workerUrl}/v2/internal/camelfs/lineages/${encodeURIComponent(repo.lineage)}/outbox?flush=1&verifyR2Hash=${encodeURIComponent(w2.commit)}`,
      { headers: { "X-Admin-Key": ADMIN_SECRET } },
    );
    assert.equal(outboxRes.status, 200);
    const outbox = (await outboxRes.json()) as { pending: number; r2Exists: boolean };
    assert.equal(outbox.pending, 0);
    assert.equal(outbox.r2Exists, true);

    // O(1) fork shares R2 objects and isolates writes
    const forkRes = await fetch(`${workerUrl}/v2/repos/${encodeURIComponent(repo.repoId)}/fork`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "cf-repo-fork" }),
    });
    assert.equal(forkRes.status, 201);
    const forked = (await forkRes.json()) as { repoId: string; lineage: string };
    const forkRd = await camel.repos.read(forked.repoId, { path: "src/index.ts" });
    assert.equal(forkRd.content, "export const greeting = 'updated_cf';\n");

    await camel.repos.write(forked.repoId, {
      puts: [{ path: "src/index.ts", content: "export const greeting = 'fork_only';\n" }],
    });
    assert.equal(
      (await camel.repos.read(repo.repoId, { path: "src/index.ts" })).content,
      "export const greeting = 'updated_cf';\n",
    );
    assert.equal(
      (await camel.repos.read(forked.repoId, { path: "src/index.ts" })).content,
      "export const greeting = 'fork_only';\n",
    );

    // Restore rolls back to w1 commit cleanly
    await camel.repos.restore(repo.repoId, { targetCommit: w1.commit, message: "rollback" });
    assert.equal(
      (await camel.repos.read(repo.repoId, { path: "src/index.ts" })).content,
      "export const greeting = 'hello_cf';\n",
    );

    await camel.close();
  });

  it("2. Full Agent run with files + persistent bash over live Lazy FUSE, edit-while-VM-live, atomic R2 commit, and agent fork", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "cf-native-agent-tenant",
      initialCreditsUsd: 50,
    });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });

    const repo = await camel.repos.create({ name: "agent-app-repo" });
    const coder = await camel.agents.upsert("cf-coder", {
      model: "mock/default",
      repoId: repo.repoId,
      builtins: ["files", "bash"],
    });

    // Step A: Write seed file via file tool (DO SQLite write-through + async R2 flush)
    const r1 = await coder.run(
      `Seed file [CALL:write {"path":"notes.txt","content":"line1\\n","message":"seed"}]`,
    );
    assert.equal(r1.status, "completed");

    // Step B: Persistent bash over live FUSE fetches seed lazily from Worker/R2, sets cwd + env, writes app.txt
    const r2 = await coder.run(
      `Run bash [CALL:bash {"command":"cat notes.txt && mkdir -p src && cd src && export CF_MODE=native_r2 && echo \\"$CF_MODE\\" > app.txt && pwd"}]`,
    );
    assert.equal(r2.status, "completed");
    assert.match(r2.text, /line1/);

    // Step C: Second bash reuses the warm shell (cwd=/workspace/src and $CF_MODE preserved!)
    const r3 = await coder.run(
      `Check shell [CALL:bash {"command":"pwd && echo \\"ok=$CF_MODE\\" >> app.txt && cat app.txt"}]`,
    );
    assert.equal(r3.status, "completed");
    assert.match(r3.text, /\/src/);
    assert.match(r3.text, /ok=native_r2/);

    // Step D: Edit file via file tool while the VM holds the branch lease (live workspace sync!)
    const r4 = await coder.run(
      `Edit live [CALL:edit {"path":"notes.txt","oldText":"line1","newText":"line1-synced"}]`,
    );
    assert.equal(r4.status, "completed");

    // Step E: Verify live FUSE bash sees the edit immediately AND committed state is in repo API
    const r5 = await coder.run(
      `Verify sync [CALL:bash {"command":"cat ../notes.txt"}]`,
    );
    assert.equal(r5.status, "completed");
    assert.match(r5.text, /line1-synced/);

    assert.equal((await camel.repos.read(repo.repoId, { path: "src/app.txt" })).content, "native_r2\nok=native_r2\n");
    assert.equal((await camel.repos.read(repo.repoId, { path: "notes.txt" })).content, "line1-synced\n");

    // Step F: Fork agent creates an independent O(1) forked lineage reading parent's files from R2
    const forkedAgent = await coder.fork({ key: "cf-coder-fork" });
    const r6 = await forkedAgent.run(
      `Read forked [CALL:read {"path":"src/app.txt"}]`,
    );
    assert.equal(r6.status, "completed");
    assert.match(r6.text, /ok=native_r2/);

    await camel.close();
  });

  it("3. Decodes legacy AWS S3 zlib-packed objects (Sippy/Slurper raw copy) and idempotently imports DynamoDB lineages", async () => {
    const hashObj = (kind: string, data: Buffer) =>
      createHash("sha256").update(Buffer.concat([Buffer.from(`${kind} ${data.length}\0`), data])).digest("hex");
    const packS3 = (kind: string, data: Buffer) =>
      deflateSync(Buffer.concat([Buffer.from(`${kind}\0`), data]));

    const blobData = Buffer.from("legacy aws s3 payload!\n", "utf8");
    const blobHash = hashObj("blob", blobData);

    const treeData = Buffer.from(
      JSON.stringify([{ path: "legacy/hello.txt", type: "file", size: blobData.length, mode: 420, hash: blobHash }]),
      "utf8",
    );
    const treeHash = hashObj("tree", treeData);

    const commitData = Buffer.from(
      JSON.stringify({
        tree: treeHash,
        parents: [],
        author: "aws-migrator",
        message: "legacy commit",
        createdAt: 1795500000000,
      }),
      "utf8",
    );
    const commitHash = hashObj("commit", commitData);

    // Upload zlib-packed bytes WITHOUT customMetadata.kind (exact format copied by R2 Sippy / Super Slurper)
    for (const [kind, hash, data] of [
      ["blob", blobHash, blobData],
      ["tree", treeHash, treeData],
      ["commit", commitHash, commitData],
    ] as const) {
      const packed = packS3(kind, data);
      const putRes = await fetch(
        `${workerUrl}/v2/internal/camelfs/put-raw-r2?key=${encodeURIComponent(`objects/${hash.slice(0, 2)}/${hash}`)}`,
        {
          method: "POST",
          headers: { "X-Admin-Key": ADMIN_SECRET },
          body: packed,
        },
      );
      assert.equal(putRes.status, 200);
    }

    // Import the lineage via bulk import endpoint
    const impRes = await fetch(`${workerUrl}/v2/internal/camelfs/import-lineages`, {
      method: "POST",
      headers: { "X-Admin-Key": ADMIN_SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({
        lineages: [
          {
            lineage: "lin_legacy_aws_1",
            tenantId: "tnt_legacy",
            defaultRef: "refs/heads/main",
            createdAt: 1795500000000,
            refs: [{ name: "refs/heads/main", commit: commitHash, tree: treeHash, updatedAt: 1795500000000 }],
          },
        ],
      }),
    });
    assert.equal(impRes.status, 200);
    assert.deepEqual(await impRes.json(), { count: 1, importedRefs: 1, skippedNewerRefs: 0 });

    // Verify re-importing the same or older ref is a safe no-op
    const impAgain = await fetch(`${workerUrl}/v2/internal/camelfs/import-lineages`, {
      method: "POST",
      headers: { "X-Admin-Key": ADMIN_SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({
        lineages: [
          {
            lineage: "lin_legacy_aws_1",
            tenantId: "tnt_legacy",
            defaultRef: "refs/heads/main",
            createdAt: 1795500000000,
            refs: [{ name: "refs/heads/main", commit: commitHash, tree: treeHash, updatedAt: 1795500000000 }],
          },
        ],
      }),
    });
    assert.equal(impAgain.status, 200);
    assert.deepEqual(await impAgain.json(), { count: 1, importedRefs: 0, skippedNewerRefs: 1 });

    // Verify DO seamlessly unpacks legacy zlib commit, tree, and blob!
    const verRes = await fetch(
      `${workerUrl}/v2/internal/camelfs/lineages/lin_legacy_aws_1/verify?path=${encodeURIComponent("legacy/hello.txt")}`,
      { headers: { "X-Admin-Key": ADMIN_SECRET } },
    );
    assert.equal(verRes.status, 200);
    const ver = (await verRes.json()) as {
      entryCount: number;
      file: { content: string; commit: string };
    };
    assert.equal(ver.entryCount, 1);
    assert.equal(ver.file.commit, commitHash);
    assert.equal(ver.file.content, "legacy aws s3 payload!\n");
  });
});

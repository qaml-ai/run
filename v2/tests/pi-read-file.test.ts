import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { CamelRun } from "../sdk/src/index.ts";
import {
  executePiReadFile,
  isVirtualSkillPath,
  normalizePiReadPath,
} from "../worker/src/pi-fs-env.ts";
import { getSkillStore } from "../worker/src/skills.ts";
import type { Env } from "../worker/src/types.ts";

// Valid 1x1 transparent PNG
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("pi-fs-env path normalization (unit)", () => {
  it("normalizes repo paths, /workspace, /bot, and virtual /.skills paths", () => {
    assert.equal(normalizePiReadPath("src/index.ts"), "/src/index.ts");
    assert.equal(normalizePiReadPath("./src/index.ts"), "/src/index.ts");
    assert.equal(normalizePiReadPath("/workspace/src/index.ts"), "/src/index.ts");
    assert.equal(normalizePiReadPath("/bot/src/index.ts"), "/src/index.ts");
    assert.equal(normalizePiReadPath("/.skills/camel-bots/sql-storage/SKILL.md"), "/.skills/camel-bots/sql-storage/SKILL.md");
    assert.equal(normalizePiReadPath(".skills/camel-bots/sql-storage/references/sdk.d.ts"), "/.skills/camel-bots/sql-storage/references/sdk.d.ts");
    assert.equal(normalizePiReadPath("/workspace/.skills/deploy/SKILL.md"), "/.skills/deploy/SKILL.md");

    assert.equal(isVirtualSkillPath("/.skills/foo/SKILL.md"), true);
    assert.equal(isVirtualSkillPath(".skills/foo/SKILL.md"), true);
    assert.equal(isVirtualSkillPath("/bot/.skills/foo/SKILL.md"), true);
    assert.equal(isVirtualSkillPath("src/index.ts"), false);
  });
});

test("pi-durable read_file: large file truncation, offset/limit, at-commit reads, images, and virtual /.skills (unit + mock CamelFS)", async (t) => {
  const largeLines = Array.from(
    { length: 2500 },
    (_, i) => `line-${String(i + 1).padStart(4, "0")}: ${"x".repeat(90)}`,
  );
  const largeText = largeLines.join("\n") + "\n"; // ~250 KB

  const repoReads: Array<{ path: string; at: string }> = [];
  const filesByCommit: Record<string, Record<string, { content?: string; base64?: string; binary?: boolean }>> = {
    "refs/heads/main": {
      "big.log": { content: largeText },
      "src/app.ts": { content: "export const version = 2;\nconsole.log('v2');\n" },
      "assets/pixel.png": { base64: TINY_PNG_BASE64, binary: true },
    },
    "commit-v1": {
      "src/app.ts": { content: "export const version = 1;\nconsole.log('v1');\n" },
    },
  };

  const mockCamelfs: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.endsWith("/read")) {
      const at = url.searchParams.get("at") ?? "refs/heads/main";
      const filePath = url.searchParams.get("path") ?? "";
      repoReads.push({ path: filePath, at });
      const entry = filesByCommit[at]?.[filePath];
      if (!entry) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "not_found", message: `File '${filePath}' not found` } }));
        return;
      }
      const size = entry.base64
        ? Buffer.from(entry.base64, "base64").byteLength
        : Buffer.byteLength(entry.content ?? "", "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          commit: at,
          path: filePath,
          size,
          mode: 0o644,
          binary: Boolean(entry.binary),
          content: entry.binary ? null : (entry.content ?? ""),
          base64: entry.binary ? (entry.base64 ?? "") : null,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => mockCamelfs.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    mockCamelfs.closeAllConnections();
    mockCamelfs.close();
  });
  const addr = mockCamelfs.address();
  assert.ok(addr && typeof addr === "object");

  const fakeEnv = {
    CAMELFS_URL: `http://127.0.0.1:${addr.port}`,
    CAMELFS_DEV_TOKEN: "test-token",
  } as unknown as Env;

  let ensureRepoCalls = 0;
  const ensureRepo = async () => {
    ensureRepoCalls++;
    return { repoId: "repo_1", lineage: "lin_1", branch: "refs/heads/main" };
  };

  // Seed fallback store for direct virtual skill lookup
  const tenantId = "tnt_pi_unit";
  await getSkillStore(fakeEnv).upsertSkill(tenantId, "camel-bots/sql-storage", {
    description: "SQLite storage rules",
    markdown: "# SQL Storage\nLine 2\nLine 3\nLine 4\n",
    files: {
      "references/sdk.d.ts": "export interface SqlStorage {\n  exec(sql: string): void;\n}\n",
    },
  });

  // (a) Large 250 KB file truncates cleanly with pi-durable's 50KB cap + continuation diagnostic, with only 1 CamelFS read!
  repoReads.length = 0;
  const bigOut = await executePiReadFile({
    env: fakeEnv,
    tenantId,
    path: "/workspace/big.log",
    ensureRepo,
  });
  assert.equal(typeof bigOut, "string");
  const bigStr = bigOut as string;
  assert.ok(Buffer.byteLength(bigStr, "utf8") < 60 * 1024, "250KB file must never dump whole into context");
  assert.ok(bigStr.includes("line-0001:"));
  assert.match(bigStr, /Showing lines 1-\d+ of 2501 \(50\.0KB limit\)\. Use offset=\d+ to continue\./);
  assert.equal(repoReads.length, 1, "exists + openBinaryReader must share a single CamelFS fetch");

  // Offset + limit reads exact 1-indexed line range with continuation hint
  const slicedOut = await executePiReadFile({
    env: fakeEnv,
    tenantId,
    path: "big.log",
    offset: 1200,
    limit: 3,
    ensureRepo,
  });
  assert.equal(typeof slicedOut, "string");
  const slicedStr = slicedOut as string;
  assert.ok(slicedStr.includes("line-1200:"));
  assert.ok(slicedStr.includes("line-1201:"));
  assert.ok(slicedStr.includes("line-1202:"));
  assert.ok(!slicedStr.includes("line-1203:"));
  assert.match(slicedStr, /more lines in file\. Use offset=1203 to continue\./);

  // (b) Repo `at` commit read
  const headOut = await executePiReadFile({
    env: fakeEnv,
    tenantId,
    path: "/bot/src/app.ts",
    ensureRepo,
  });
  assert.equal(headOut, "export const version = 2;\nconsole.log('v2');\n");

  const v1Out = await executePiReadFile({
    env: fakeEnv,
    tenantId,
    path: "src/app.ts",
    at: "commit-v1",
    ensureRepo,
  });
  assert.equal(v1Out, "export const version = 1;\nconsole.log('v1');\n");

  // (c) Image read returns vision image block compatible with storeToolImages()
  const imgOut = (await executePiReadFile({
    env: fakeEnv,
    tenantId,
    path: "assets/pixel.png",
    ensureRepo,
  })) as { content: Array<{ type: string; text?: string; mimeType?: string; data?: string }> };
  assert.ok(Array.isArray(imgOut.content));
  const imgBlock = imgOut.content.find((b) => b.type === "image");
  assert.ok(imgBlock);
  assert.equal(imgBlock.mimeType, "image/png");
  assert.equal(imgBlock.data, TINY_PNG_BASE64);

  // (d) Virtual /.skills/<slug>/SKILL.md & nested reference file reads without touching CamelFS or ensureRepo!
  const repoCallsBeforeSkills = ensureRepoCalls;
  const skillMdOut = await executePiReadFile({
    env: fakeEnv,
    tenantId,
    path: "/.skills/camel-bots/sql-storage/SKILL.md",
    offset: 2,
    limit: 2,
    ensureRepo,
  });
  assert.equal(ensureRepoCalls, repoCallsBeforeSkills, "virtual skill read must not provision/touch repo");
  assert.equal(typeof skillMdOut, "string");
  assert.ok((skillMdOut as string).startsWith("Line 2\nLine 3"));
  assert.match(skillMdOut as string, /Use offset=4 to continue/);

  const skillRefOut = await executePiReadFile({
    env: fakeEnv,
    tenantId,
    path: "/.skills/camel-bots/sql-storage/references/sdk.d.ts",
    ensureRepo,
  });
  assert.equal(skillRefOut, "export interface SqlStorage {\n  exec(sql: string): void;\n}\n");
});

test("End-to-end Miniflare R2 skills CRUD (including large customMetadata fallback) + agent read_file on /.skills and large CamelFS file", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "camelrun-v2-pi-read-"));
  const adminSecret = "pi-read-admin";
  const vaultSecret = "pi-read-vault-32-bytes-minimum!!";

  const bigRepoContent =
    Array.from({ length: 2400 }, (_, i) => `repo-line-${i + 1}: ${"z".repeat(80)}`).join("\n") + "\n";

  // Mock CamelFS supporting lineage create + read
  const mockCamelfs: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/v1/lineages") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          lineage: "lin_test_pi",
          defaultRef: "refs/heads/main",
          commit: "c_head",
          tree: "t_head",
        }),
      );
      return;
    }
    if (req.method === "GET" && url.pathname.endsWith("/ls")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ commit: "c_head", entries: [] }));
      return;
    }
    if (req.method === "GET" && url.pathname.endsWith("/read")) {
      const filePath = url.searchParams.get("path") ?? "";
      const at = url.searchParams.get("at") ?? "refs/heads/main";
      if (filePath === "big.txt") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            commit: at,
            path: filePath,
            size: Buffer.byteLength(bigRepoContent, "utf8"),
            mode: 0o644,
            binary: false,
            content: bigRepoContent,
            base64: null,
          }),
        );
        return;
      }
      if (filePath === "notes.txt") {
        const content = at === "c_old" ? "old note\n" : "new note\n";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            commit: at,
            path: filePath,
            size: content.length,
            mode: 0o644,
            binary: false,
            content,
            base64: null,
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "Not found" } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  let llmStep = 0;
  const seenToolOutputs: Array<{ tool_call_id?: string; content: string }> = [];
  const mockLlm: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages?: Array<{ role: string; content: unknown; tool_call_id?: string }>;
    };
    const step = llmStep++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });

    const send = (delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, number>) => {
      res.write(
        `data: ${JSON.stringify({
          id: `cmpl-${step}`,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage ? { usage } : {}),
        })}\n\n`,
      );
    };

    if (step === 0) {
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_skill_virtual",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "/.skills/camel-bots/guide/SKILL.md" }),
            },
          },
          {
            index: 1,
            id: "call_big_repo",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "big.txt" }),
            },
          },
          {
            index: 2,
            id: "call_old_commit",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "notes.txt", at: "c_old" }),
            },
          },
        ],
      });
      send({}, "tool_calls", { prompt_tokens: 100, completion_tokens: 20 });
    } else {
      for (const m of body.messages ?? []) {
        if (m.role === "tool") {
          seenToolOutputs.push({ tool_call_id: m.tool_call_id, content: String(m.content ?? "") });
        }
      }
      send({ role: "assistant", content: "All read_file checks passed." });
      send({}, "stop", { prompt_tokens: 200, completion_tokens: 10 });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await Promise.all([
    new Promise<void>((resolve) => mockCamelfs.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => mockLlm.listen(0, "127.0.0.1", resolve)),
  ]);
  t.after(() => {
    mockCamelfs.closeAllConnections();
    mockCamelfs.close();
    mockLlm.closeAllConnections();
    mockLlm.close();
  });

  const fsAddr = mockCamelfs.address();
  const llmAddr = mockLlm.address();
  assert.ok(fsAddr && typeof fsAddr === "object");
  assert.ok(llmAddr && typeof llmAddr === "object");

  const wranglerConfig = join(dir, "wrangler.json");
  writeFileSync(
    wranglerConfig,
    JSON.stringify({
      name: "camelrun-v2-pi-read-test",
      main: fileURLToPath(new URL("../worker/src/index.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: adminSecret,
        VAULT_SECRET: vaultSecret,
        CAMELFS_URL: `http://127.0.0.1:${fsAddr.port}`,
        CAMELFS_DEV_TOKEN: "dev-token",
        DEFAULT_MODEL: "mock/default",
      },
      r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: "pi-read-test-media" }],
      durable_objects: {
        bindings: [
          { name: "TENANT_DO", class_name: "TenantDO" },
          { name: "AGENT_DO", class_name: "AgentDO" },
        ],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] }],
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worker = await unstable_startWorker({
    config: wranglerConfig,
    dev: { persist: false, logLevel: "none" },
  });
  t.after(() => worker.dispose());

  const origin = "https://pi-read.test";
  const fetcher = worker.fetch.bind(worker) as unknown as typeof fetch;
  const tenant = await CamelRun.createTenant({
    baseUrl: origin,
    fetch: fetcher,
    adminKey: adminSecret,
    name: "pi-read-tenant",
    initialCreditsUsd: 5,
  });
  const camel = new CamelRun({ baseUrl: origin, fetch: fetcher, apiKey: tenant.apiKey });
  t.after(() => camel.close());

  // Upsert a normal skill AND a skill whose metadata exceeds R2's 2 KiB customMetadata cap (45 long-named files)
  await camel.skills.upsert("camel-bots/guide", {
    description: "Guide for Camel Bots",
    tags: ["guide"],
    markdown: "# Camel Bots Guide\nAlways use R2-backed skills.\n",
  });

  const manyFiles: Record<string, string> = {};
  for (let i = 0; i < 45; i++) {
    manyFiles[`references/very_long_reference_module_name_${String(i).padStart(2, "0")}.d.ts`] =
      `export const n${i} = ${i};\n`;
  }
  const bigMetaSummary = await camel.skills.upsert("camel-bots/many-refs", {
    description: "D".repeat(900),
    tags: ["large-meta"],
    markdown: "# Many Refs\n",
    files: manyFiles,
  });
  assert.equal(bigMetaSummary.files.length, 45);

  const listed = await camel.skills.list({ prefix: "camel-bots/" });
  assert.deepEqual(
    listed.map((s) => s.slug),
    ["camel-bots/guide", "camel-bots/many-refs"],
  );
  const listedMany = listed.find((s) => s.slug === "camel-bots/many-refs")!;
  assert.equal(listedMany.files.length, 45);
  assert.equal(listedMany.description.length, 900);
  assert.deepEqual(listedMany.tags, ["large-meta"]);

  // Configure provider to mock LLM
  const provRes = await worker.fetch(`${origin}/v2/providers/openai`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${tenant.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      apiKey: "sk-test",
      baseUrl: `http://127.0.0.1:${llmAddr.port}/v1`,
      apiStyle: "openai-chat",
    }),
  });
  assert.equal(provRes.status, 200);

  const agent = await camel.agents.upsert("pi-read-agent", {
    model: "openai/gpt-4o-mini",
    builtins: ["files"],
    skills: ["camel-bots/guide"],
  });

  const run = await agent.run("Read skill, big file, and old commit", { wait: true });
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.equal(run.text, "All read_file checks passed.");

  const skillOut = seenToolOutputs.find((o) => o.tool_call_id === "call_skill_virtual")!;
  assert.ok(skillOut.content.includes("Always use R2-backed skills."));

  const bigOut = seenToolOutputs.find((o) => o.tool_call_id === "call_big_repo")!;
  assert.ok(bigOut.content.includes("repo-line-1:"));
  assert.match(bigOut.content, /Showing lines 1-\d+ of 2401 \(50\.0KB limit\)\. Use offset=\d+ to continue\./);
  assert.ok(Buffer.byteLength(bigOut.content, "utf8") < 60 * 1024);

  const oldOut = seenToolOutputs.find((o) => o.tool_call_id === "call_old_commit")!;
  assert.equal(oldOut.content, "old note\n");
});

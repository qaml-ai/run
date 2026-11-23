import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { CamelRun, CamelRunError } from "../sdk/src/index.ts";
import {
  buildSkillsPromptBlock,
  normalizeAndValidateSkill,
  parseSkillFrontmatter,
  readSkillFile,
  searchSkills,
  selectSkillsBySelectors,
  SKILL_MAX_BYTES,
  SKILL_MAX_FILES,
  validateSkillFilePath,
  validateSkillSlug,
  type SkillRecord,
} from "../worker/src/skills.ts";

describe("skills helpers (unit)", () => {
  it("validates flat and slash-namespaced slugs and rejects traversal/malformed slugs", () => {
    assert.equal(validateSkillSlug("sql-storage"), "sql-storage");
    assert.equal(validateSkillSlug("camel-bots/sql-storage"), "camel-bots/sql-storage");
    assert.equal(validateSkillSlug("a/b_c/d-1"), "a/b_c/d-1");

    for (const bad of [
      "",
      " ",
      "/leading",
      "trailing/",
      "camel-bots//sql",
      "camel-bots/../secret",
      "..hidden",
      "UpperCase",
      "has space",
      "-starts-with-dash",
      "a".repeat(129),
    ]) {
      assert.throws(() => validateSkillSlug(bad), /invalid_skill_slug|Invalid skill slug/i, `expected ${JSON.stringify(bad)} to fail`);
    }
  });

  it("validates reference file paths, file count cap, and 512 KiB size cap", async () => {
    assert.equal(validateSkillFilePath("references/sdk.d.ts"), "references/sdk.d.ts");
    assert.equal(validateSkillFilePath("examples/basic_bot.ts"), "examples/basic_bot.ts");

    for (const bad of ["", "/abs.ts", "dir/", "../escape.ts", "a/../b.ts", "a\\b.ts", "SKILL.md", "skill.md"]) {
      assert.throws(() => validateSkillFilePath(bad));
    }

    const tooManyFiles: Record<string, string> = {};
    for (let i = 0; i < SKILL_MAX_FILES + 1; i++) {
      tooManyFiles[`references/f${i}.txt`] = "ok";
    }
    await assert.rejects(
      () => normalizeAndValidateSkill("too-many", { description: "x", markdown: "# hi", files: tooManyFiles }),
      /at most 50/i,
    );

    await assert.rejects(
      () =>
        normalizeAndValidateSkill("too-big", {
          description: "x",
          markdown: "a".repeat(SKILL_MAX_BYTES + 1),
        }),
      /exceeds limit/i,
    );
  });

  it("parses YAML frontmatter including inline tags, block lists, and folded descriptions", async () => {
    const md = `---
name: SQL Storage
description: >-
  Durable SQLite storage
  rules for bots
tags:
  - storage
  - sql
---

# SQL Storage Guide
Always use parameterized queries.
`;
    const fm = parseSkillFrontmatter(md);
    assert.equal(fm.name, "SQL Storage");
    assert.equal(fm.description, "Durable SQLite storage rules for bots");
    assert.deepEqual(fm.tags, ["storage", "sql"]);
    assert.ok(fm.body.includes("# SQL Storage Guide"));

    const normalized = await normalizeAndValidateSkill("camel-bots/sql-storage", {
      markdown: md,
      tags: ["override-tag", "sql"],
    });
    assert.equal(normalized.name, "SQL Storage");
    assert.equal(normalized.description, "Durable SQLite storage rules for bots");
    assert.deepEqual(normalized.tags, ["override-tag", "sql"]);

    // Missing description in both input and frontmatter is rejected
    await assert.rejects(
      () => normalizeAndValidateSkill("no-desc", { markdown: "# Just markdown" }),
      /description/i,
    );
  });

  it("resolves exact, prefix glob, and wildcard selectors with deduplication and deterministic sort", () => {
    const all = [
      { slug: "zeta" },
      { slug: "camel-bots/sql-storage" },
      { slug: "camel-bots/bot-core" },
      { slug: "other/tool" },
    ];
    const selected = selectSkillsBySelectors(all, ["camel-bots/*", "camel-bots/bot-core", "zeta"]);
    assert.deepEqual(
      selected.map((s) => s.slug),
      ["camel-bots/bot-core", "camel-bots/sql-storage", "zeta"],
    );
    assert.deepEqual(
      selectSkillsBySelectors(all, ["*"]).map((s) => s.slug),
      ["camel-bots/bot-core", "camel-bots/sql-storage", "other/tool", "zeta"],
    );
  });

  it("builds deterministic <skills> prompt index and supports read_skill + search_skills", () => {
    const longLines = Array.from({ length: 450 }, (_, i) => `line content number ${i + 1}`).join("\n");
    const skills: SkillRecord[] = [
      {
        slug: "camel-bots/sql-storage",
        name: "sql-storage",
        description: "SQLite tables and parameterized queries",
        tags: ["sql", "storage"],
        version: 1,
        contentHash: "h1",
        markdown: "# SQL Storage\n\nUse `SqlStorage.exec` with bound parameters.\n\n## Migrations\nRun CREATE TABLE IF NOT EXISTS.\n",
        files: {
          "references/sdk.d.ts": [
            "// Camel Bots SQL SDK",
            "export interface SqlCursor<T> { toArray(): T[]; }",
            "export interface SqlStorage {",
            "  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T>;",
            "}",
          ].join("\n"),
          "references/large.txt": longLines,
        },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        slug: "camel-bots/bot-core",
        name: "bot-core",
        description: "Core bot entrypoints, manifest, and event lifecycle",
        tags: ["core"],
        version: 1,
        contentHash: "h2",
        markdown: "# Bot Core\n\nExport `default { fetch, onEvent }`.\n",
        files: {
          "references/sdk.d.ts": "export interface BotManifest { id: string; name: string; }\n",
        },
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    const promptBlock = buildSkillsPromptBlock(skills);
    assert.ok(promptBlock.startsWith("<skills>\n"));
    assert.ok(promptBlock.endsWith("\n</skills>"));
    const idxCore = promptBlock.indexOf("- camel-bots/bot-core:");
    const idxSql = promptBlock.indexOf("- camel-bots/sql-storage:");
    assert.ok(idxCore > 0 && idxSql > idxCore, "skills must be sorted deterministically by slug");
    assert.ok(promptBlock.includes("(refs: references/sdk.d.ts)"));
    assert.ok(promptBlock.includes("(refs: references/large.txt, references/sdk.d.ts)"));

    // readSkillFile: short suffix lookup + reference file + 1-indexed line slicing
    const slice = readSkillFile(skills, {
      name: "sql-storage",
      file: "references/sdk.d.ts",
      start_line: 3,
      end_line: 5,
    });
    assert.equal(slice.skill, "camel-bots/sql-storage");
    assert.equal(slice.file, "references/sdk.d.ts");
    assert.equal(slice.startLine, 3);
    assert.equal(slice.endLine, 5);
    assert.equal(slice.totalLines, 5);
    assert.equal(slice.truncated, false);
    assert.deepEqual(slice.availableFiles, ["SKILL.md", "references/large.txt", "references/sdk.d.ts"]);
    assert.equal(
      slice.content,
      "3: export interface SqlStorage {\n4:   exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T>;\n5: }",
    );

    // readSkillFile: truncation on >400 lines with continuation hint
    const capped = readSkillFile(skills, { name: "camel-bots/sql-storage", file: "references/large.txt" });
    assert.equal(capped.truncated, true);
    assert.equal(capped.endLine, 400);
    assert.equal(capped.nextStartLine, 401);
    assert.ok(capped.hint?.includes("start_line=401"));

    // searchSkills: prioritizes `.d.ts` interface declaration over prose mentions
    const hits = searchSkills(skills, { query: "SqlStorage" });
    assert.ok(hits.results.length >= 2);
    assert.equal(hits.results[0]!.skill, "camel-bots/sql-storage");
    assert.equal(hits.results[0]!.file, "references/sdk.d.ts");
    assert.equal(hits.results[0]!.line, 3);
    assert.ok(hits.results[0]!.snippet.includes("3: export interface SqlStorage {"));
  });
});

test("Skills API CRUD, tenant isolation, and end-to-end agent turn with read_skill & search_skills", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "camelrun-v2-skills-"));
  const adminSecret = "skills-test-admin";
  const vaultSecret = "skills-test-vault-32-bytes-minimum!!";

  interface CapturedModelReq {
    instructions: string;
    toolNames: string[];
    messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }>;
  }
  const capturedRequests: CapturedModelReq[] = [];
  let mockTurnStep = 0;

  const mockLlmServer: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages?: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }>;
      tools?: Array<{ type: string; function?: { name: string } }>;
    };

    const messages = body.messages ?? [];
    const sysMsg = messages.find((m) => m.role === "system");
    const instructions = typeof sysMsg?.content === "string" ? sysMsg.content : "";
    const toolNames = (body.tools ?? []).map((t) => t.function?.name ?? "").filter(Boolean);
    capturedRequests.push({ instructions, toolNames, messages });

    const step = mockTurnStep++;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });

    const emitChunk = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: Record<string, number>) => {
      res.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-skills-${step}`,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(usage ? { usage } : {}),
        })}\n\n`,
      );
    };

    if (step === 0) {
      // Step 1: call search_skills for SqlStorage symbol
      emitChunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_search_1",
            type: "function",
            function: {
              name: "search_skills",
              arguments: JSON.stringify({ query: "SqlStorage" }),
            },
          },
        ],
      });
      emitChunk({}, "tool_calls", { prompt_tokens: 120, completion_tokens: 18 });
    } else if (step === 1) {
      // Step 2: call read_skill on both references/sdk.d.ts (with line range + short suffix name) and bot-core SKILL.md
      emitChunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_read_ref",
            type: "function",
            function: {
              name: "read_skill",
              arguments: JSON.stringify({
                name: "sql-storage",
                file: "references/sdk.d.ts",
                start_line: 2,
                end_line: 4,
              }),
            },
          },
          {
            index: 1,
            id: "call_read_md",
            type: "function",
            function: {
              name: "read_skill",
              arguments: JSON.stringify({ name: "camel-bots/bot-core" }),
            },
          },
        ],
      });
      emitChunk({}, "tool_calls", { prompt_tokens: 210, completion_tokens: 34 });
    } else {
      // Step 3 (or plain agent without skills): return final answer
      const lastToolMsgs = messages.filter((m) => m.role === "tool");
      const summary = lastToolMsgs.length > 0
        ? `Verified ${lastToolMsgs.length} skill tool results.`
        : "No skills attached.";
      emitChunk({ role: "assistant", content: summary });
      emitChunk({}, "stop", { prompt_tokens: 260, completion_tokens: 12 });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise<void>((resolve) => mockLlmServer.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => {
    mockLlmServer.closeAllConnections();
    mockLlmServer.close();
  });
  const addr = mockLlmServer.address();
  assert.ok(addr && typeof addr === "object");
  const mockLlmUrl = `http://127.0.0.1:${addr.port}/v1`;

  const wranglerConfigPath = join(dir, "wrangler.json");
  writeFileSync(
    wranglerConfigPath,
    JSON.stringify({
      name: "camelrun-v2-skills-test",
      main: fileURLToPath(new URL("../worker/src/index.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: adminSecret,
        VAULT_SECRET: vaultSecret,
        DEFAULT_MODEL: "mock/default",
      },
      r2_buckets: [
        { binding: "MEDIA_BUCKET", bucket_name: "skills-test-media" },
      ],
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
    config: wranglerConfigPath,
    dev: { persist: false, logLevel: "none" },
  });
  t.after(() => worker.dispose());

  const origin = "https://skills.test";
  const fetcher = worker.fetch.bind(worker) as unknown as typeof fetch;

  const tenantA = await CamelRun.createTenant({
    baseUrl: origin,
    fetch: fetcher,
    adminKey: adminSecret,
    name: "tenant-skills-a",
    initialCreditsUsd: 5,
  });
  const tenantB = await CamelRun.createTenant({
    baseUrl: origin,
    fetch: fetcher,
    adminKey: adminSecret,
    name: "tenant-skills-b",
    initialCreditsUsd: 5,
  });

  const camelA = new CamelRun({ baseUrl: origin, fetch: fetcher, apiKey: tenantA.apiKey });
  const camelB = new CamelRun({ baseUrl: origin, fetch: fetcher, apiKey: tenantB.apiKey });
  t.after(() => {
    camelA.close();
    camelB.close();
  });

  const sqlSkillMarkdown = `---
name: SQL Storage
description: Parameterized SQLite storage rules for Camel Bots
tags: [storage, sql]
---

# SQL Storage

Always bind query parameters using \`?1\`, \`?2\`, etc.
Never interpolate user strings directly into SQL.
`;

  const sqlSdkDts = [
    "// Camel Bots SQL Storage SDK",
    "export interface SqlCursor<T = Record<string, unknown>> {",
    "  toArray(): T[];",
    "}",
    "export interface SqlStorage {",
    "  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T>;",
    "}",
  ].join("\n");

  const botCoreMarkdown = `---
name: Bot Core
description: Core bot entrypoints, manifest, and event lifecycle
tags:
  - core
  - runtime
---

# Bot Core

Define your bot entrypoint with \`defineBot({ onMessage })\`.
`;

  const deployMarkdown = `---
description: Production deployment checklist
tags: [ops]
---

# Deploy Rules
Always verify typecheck before releasing.
`;

  await t.test("Skill CRUD, YAML frontmatter, idempotent contentHash versioning, filters, and tenant isolation", async () => {
    // 1. Upsert slash-namespaced and flat skills
    const createdSql = await camelA.skills.upsert("camel-bots/sql-storage", {
      markdown: sqlSkillMarkdown,
      files: { "references/sdk.d.ts": sqlSdkDts },
    });
    assert.equal(createdSql.slug, "camel-bots/sql-storage");
    assert.equal(createdSql.name, "SQL Storage");
    assert.equal(createdSql.description, "Parameterized SQLite storage rules for Camel Bots");
    assert.deepEqual(createdSql.tags, ["sql", "storage"]);
    assert.equal(createdSql.version, 1);
    assert.match(createdSql.contentHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(createdSql.files, ["references/sdk.d.ts"]);

    // 2. Idempotent upsert with unchanged content keeps version=1 and same contentHash
    const idempotent = await camelA.skills.upsert("camel-bots/sql-storage", {
      markdown: sqlSkillMarkdown,
      files: { "references/sdk.d.ts": sqlSdkDts },
    });
    assert.equal(idempotent.version, 1);
    assert.equal(idempotent.contentHash, createdSql.contentHash);
    assert.equal(idempotent.updatedAt, createdSql.updatedAt);

    // 3. Explicit override changes contentHash and bumps version -> 2
    const updatedSql = await camelA.skills.upsert("camel-bots/sql-storage", {
      description: "SQLite storage and query binding rules",
      markdown: sqlSkillMarkdown,
      files: { "references/sdk.d.ts": sqlSdkDts },
    });
    assert.equal(updatedSql.version, 2);
    assert.notEqual(updatedSql.contentHash, createdSql.contentHash);
    assert.equal(updatedSql.description, "SQLite storage and query binding rules");

    // 4. Upsert additional skills (slash-namespaced + flat)
    await camelA.skills.upsert("camel-bots/bot-core", {
      markdown: botCoreMarkdown,
      files: { "references/manifest.d.ts": "export interface BotManifest { slug: string; }\n" },
    });
    await camelA.skills.upsert("deploy-rules", {
      markdown: deployMarkdown,
    });

    // 5. List all -> sorted deterministically by slug
    const allSkills = await camelA.skills.list();
    assert.deepEqual(
      allSkills.map((s) => s.slug),
      ["camel-bots/bot-core", "camel-bots/sql-storage", "deploy-rules"],
    );

    // 6. List with prefix & tag filters
    const camelBotsSkills = await camelA.skills.list({ prefix: "camel-bots/" });
    assert.deepEqual(
      camelBotsSkills.map((s) => s.slug),
      ["camel-bots/bot-core", "camel-bots/sql-storage"],
    );
    const storageSkills = await camelA.skills.list({ tag: "storage" });
    assert.deepEqual(
      storageSkills.map((s) => s.slug),
      ["camel-bots/sql-storage"],
    );

    // 7. Get full skill returns markdown + files map
    const full = await camelA.skills.get("camel-bots/sql-storage");
    assert.equal(full.slug, "camel-bots/sql-storage");
    assert.equal(full.markdown, sqlSkillMarkdown);
    assert.equal(full.files["references/sdk.d.ts"], sqlSdkDts);
    assert.equal(full.version, 2);

    // 8. Missing skill returns 404
    await assert.rejects(
      () => camelA.skills.get("camel-bots/nonexistent"),
      (err: unknown) => err instanceof CamelRunError && err.status === 404,
    );

    // 9. Tenant isolation: tenantB sees zero skills and cannot read or delete tenantA's skills
    assert.deepEqual(await camelB.skills.list(), []);
    await assert.rejects(
      () => camelB.skills.get("camel-bots/sql-storage"),
      (err: unknown) => err instanceof CamelRunError && err.status === 404,
    );
    const crossDelete = await camelB.skills.delete("camel-bots/sql-storage");
    assert.deepEqual(crossDelete, { ok: true, deleted: false });

    // 10. Delete flat skill returns { ok: true, deleted: true }, second delete returns deleted: false
    const tempSkill = await camelA.skills.upsert("temp-flat", {
      description: "Temporary skill",
      markdown: "# Temp",
    });
    assert.equal(tempSkill.slug, "temp-flat");
    assert.deepEqual(await camelA.skills.delete("temp-flat"), { ok: true, deleted: true });
    assert.deepEqual(await camelA.skills.delete("temp-flat"), { ok: true, deleted: false });
  });

  await t.test("End-to-end agent turn injects <skills> index and executes search_skills + read_skill", async () => {
    // Configure OpenAI provider pointing at our local SSE mock server
    const providerRes = await worker.fetch(`${origin}/v2/providers/openai`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tenantA.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        apiKey: "sk-test-skills",
        baseUrl: mockLlmUrl,
        apiStyle: "openai-chat",
      }),
    });
    assert.equal(providerRes.status, 200);

    const agent = await camelA.agents.upsert("skills-e2e-agent", {
      model: "openai/gpt-4o-mini",
      instructions: "You are a Camel Bots expert.",
      builtins: [],
      skills: ["camel-bots/*"],
    });

    // Agent-scoped token must be rejected from tenant skill management routes
    const agentSkillListRes = await worker.fetch(`${origin}/v2/skills`, {
      headers: { Authorization: `Bearer ${agent.agentToken}` },
    });
    assert.equal(agentSkillListRes.status, 403);

    // Verify agent state persists `skills`
    const fetched = await camelA.agents.get("skills-e2e-agent");
    assert.deepEqual(fetched.summary.skills, ["camel-bots/*"]);

    capturedRequests.length = 0;
    mockTurnStep = 0;

    const run = await agent.run("How do I run parameterized SQL queries in Camel Bots?", { wait: true });
    assert.equal(run.status, "completed");
    assert.equal(run.text, "Verified 3 skill tool results.");
    assert.equal(run.toolCalls.length, 3);
    assert.deepEqual(
      run.toolCalls.map((tc) => ({ name: tc.name, ok: tc.ok })),
      [
        { name: "search_skills", ok: true },
        { name: "read_skill", ok: true },
        { name: "read_skill", ok: true },
      ],
    );

    // Verify 3 model steps occurred with byte-identical instructions (prompt-cache-friendly!)
    assert.equal(capturedRequests.length, 3);
    const [req0, req1, req2] = capturedRequests;
    assert.equal(req0!.instructions, req1!.instructions);
    assert.equal(req1!.instructions, req2!.instructions);

    // Verify exact <skills> index content (only camel-bots/*, sorted deterministically, NOT deploy-rules)
    assert.ok(req0!.instructions.startsWith("You are a Camel Bots expert.\n\n<skills>\n"));
    assert.ok(
      req0!.instructions.includes(
        "- camel-bots/bot-core: Core bot entrypoints, manifest, and event lifecycle (refs: references/manifest.d.ts)",
      ),
    );
    assert.ok(
      req0!.instructions.includes(
        "- camel-bots/sql-storage: SQLite storage and query binding rules (refs: references/sdk.d.ts)",
      ),
    );
    assert.ok(!req0!.instructions.includes("deploy-rules"));
    assert.ok(
      req0!.instructions.indexOf("camel-bots/bot-core") <
        req0!.instructions.indexOf("camel-bots/sql-storage"),
    );

    // Verify read_skill and search_skills were automatically exposed even though builtins was []
    assert.ok(req0!.toolNames.includes("read_skill"));
    assert.ok(req0!.toolNames.includes("search_skills"));

    // Verify tool outputs observed by the model in req2
    const toolMsgs = req2!.messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 3);

    const searchResult = JSON.parse(String(toolMsgs[0]!.content)) as {
      query: string;
      results: Array<{ skill: string; file: string; line: number; snippet: string }>;
    };
    assert.equal(searchResult.query, "SqlStorage");
    assert.equal(searchResult.results[0]!.skill, "camel-bots/sql-storage");
    assert.equal(searchResult.results[0]!.file, "references/sdk.d.ts");
    assert.equal(searchResult.results[0]!.line, 5);
    assert.ok(searchResult.results[0]!.snippet.includes("5: export interface SqlStorage {"));

    const readRefResult = JSON.parse(String(toolMsgs[1]!.content)) as {
      skill: string;
      file: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      truncated: boolean;
      availableFiles: string[];
      content: string;
    };
    assert.equal(readRefResult.skill, "camel-bots/sql-storage");
    assert.equal(readRefResult.file, "references/sdk.d.ts");
    assert.equal(readRefResult.startLine, 2);
    assert.equal(readRefResult.endLine, 4);
    assert.equal(readRefResult.totalLines, 7);
    assert.equal(readRefResult.truncated, false);
    assert.deepEqual(readRefResult.availableFiles, ["SKILL.md", "references/sdk.d.ts"]);
    assert.equal(
      readRefResult.content,
      "2: export interface SqlCursor<T = Record<string, unknown>> {\n3:   toArray(): T[];\n4: }",
    );

    const readMdResult = JSON.parse(String(toolMsgs[2]!.content)) as {
      skill: string;
      file: string;
      content: string;
    };
    assert.equal(readMdResult.skill, "camel-bots/bot-core");
    assert.equal(readMdResult.file, "SKILL.md");
    assert.ok(readMdResult.content.includes("defineBot({ onMessage })"));
  });

  await t.test("Agent without skills preserves clean instructions and omits skill tools", async () => {
    const plainAgent = await camelA.agents.upsert("plain-no-skills", {
      model: "openai/gpt-4o-mini",
      instructions: "Plain agent instructions.",
      builtins: [],
    });

    capturedRequests.length = 0;
    mockTurnStep = 2; // go directly to stop

    const run = await plainAgent.run("Hello", { wait: true });
    assert.equal(run.status, "completed");
    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0]!.instructions, "Plain agent instructions.");
    assert.ok(!capturedRequests[0]!.instructions.includes("<skills>"));
    assert.ok(!capturedRequests[0]!.toolNames.includes("read_skill"));
    assert.ok(!capturedRequests[0]!.toolNames.includes("search_skills"));
  });
});

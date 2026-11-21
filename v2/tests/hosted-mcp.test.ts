import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import ingressWorker from "../ingress/index.ts";
import { CamelRun } from "../sdk/src/index.ts";

const MCP_ACCEPT = "application/json, text/event-stream";

function parseSseJsonMessages(raw: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n");
    if (!payload) continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      // Ignore non-JSON SSE comments/data
    }
  }
  return out;
}

async function readMcpResponse(res: {
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}): Promise<{
  contentType: string;
  messages: Array<Record<string, any>>;
  resultMsg?: Record<string, any>;
}> {
  const contentType = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  if (contentType.includes("text/event-stream")) {
    const messages = parseSseJsonMessages(raw);
    const resultMsg = messages.find((m) => "result" in m || "error" in m);
    return { contentType, messages, resultMsg };
  }
  const parsed = raw ? JSON.parse(raw) : undefined;
  const messages = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const resultMsg = messages.find((m) => "result" in m || "error" in m);
  return { contentType, messages, resultMsg };
}

test("v2 hosted tenant MCP (/v2/mcp) and per-agent MCP (/v2/agents/:idOrKey/mcp) end-to-end", async (t) => {
  // 1. Mock OpenAI-compatible LLM server (supports normal replies + ask_human tool calls)
  const llmServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        messages?: Array<{ role: string; content?: unknown }>;
      };
      const messages = body.messages ?? [];
      const last = messages.at(-1);
      const userMsgs = messages.filter((m) => m.role === "user");
      const lastUserText = String(userMsgs.at(-1)?.content ?? "");

      res.setHeader("Content-Type", "application/json");
      if (last?.role === "tool") {
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: `Confirmed after input: ${String(last.content ?? "")}`,
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 12 },
          }),
        );
        return;
      }

      if (lastUserText.includes("NEEDS_INPUT")) {
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_human_1",
                      type: "function",
                      function: {
                        name: "ask_human",
                        arguments: JSON.stringify({
                          question: "Which environment should I deploy to?",
                          options: ["staging", "production"],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 15, completion_tokens: 10 },
          }),
        );
        return;
      }

      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: `Reply: ${lastUserText}`,
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
  t.after(() => llmServer.close());
  const llmPort = (llmServer.address() as { port: number }).port;

  // 2. Mock CamelFS HTTP server for repo file tools (list_repos, list_files, read_file, write_file, grep_files)
  let commitCounter = 1;
  const repoFiles = new Map<string, Map<string, string>>();
  const camelfsServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const body = rawBody ? (JSON.parse(rawBody) as Record<string, any>) : {};
      res.setHeader("Content-Type", "application/json");

      if (req.method === "POST" && url.pathname === "/v1/lineages") {
        const lineage = String(body.lineage || `lin_${commitCounter++}`);
        repoFiles.set(lineage, new Map());
        res.end(
          JSON.stringify({
            lineage,
            defaultRef: "refs/heads/main",
            commit: `cmt_${commitCounter++}`,
            tree: "tree_init",
          }),
        );
        return;
      }

      const lineageMatch = /^\/v1\/lineages\/([^/]+)\/(write|read|ls|grep|refs)$/.exec(
        url.pathname,
      );
      if (lineageMatch) {
        const lineage = decodeURIComponent(lineageMatch[1]!);
        const op = lineageMatch[2]!;
        const files = repoFiles.get(lineage) ?? new Map<string, string>();
        repoFiles.set(lineage, files);

        if (op === "write") {
          const changed: string[] = [];
          for (const put of (body.puts ?? []) as Array<{ path: string; content?: string }>) {
            files.set(put.path, put.content ?? "");
            changed.push(put.path);
          }
          const commit = `cmt_${commitCounter++}`;
          res.end(
            JSON.stringify({
              commit,
              tree: `tree_${commit}`,
              changed,
              totalBytes: [...files.values()].reduce((acc, v) => acc + v.length, 0),
            }),
          );
          return;
        }

        if (op === "ls") {
          const prefix = url.searchParams.get("path") ?? "";
          const entries = [...files.entries()]
            .filter(([p]) => !prefix || p.startsWith(prefix))
            .map(([path, content]) => ({
              path,
              type: "file",
              size: content.length,
              mode: 0o644,
              hash: `h_${path}`,
            }));
          res.end(JSON.stringify({ commit: `cmt_${commitCounter}`, entries }));
          return;
        }

        if (op === "read") {
          const filePath = url.searchParams.get("path") ?? "";
          if (!files.has(filePath)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: { code: "not_found", message: "File not found" } }));
            return;
          }
          const content = files.get(filePath)!;
          res.end(
            JSON.stringify({
              commit: `cmt_${commitCounter}`,
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

        if (op === "grep") {
          const pattern = String(body.pattern ?? "");
          const pathPrefix = body.pathPrefix ? String(body.pathPrefix) : "";
          const matches: Array<{ path: string; line: number; column: number; text: string }> = [];
          for (const [path, content] of files.entries()) {
            if (pathPrefix && !path.startsWith(pathPrefix)) continue;
            content.split("\n").forEach((lineText, idx) => {
              const col = lineText.indexOf(pattern);
              if (col >= 0) {
                matches.push({ path, line: idx + 1, column: col + 1, text: lineText });
              }
            });
          }
          res.end(JSON.stringify({ commit: `cmt_${commitCounter}`, matches }));
          return;
        }

        if (op === "refs") {
          res.end(
            JSON.stringify({
              refs: [
                {
                  name: "refs/heads/main",
                  commit: `cmt_${commitCounter}`,
                  tree: "tree_head",
                  updatedAt: Date.now(),
                },
              ],
            }),
          );
          return;
        }
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: "not_found", message: url.pathname } }));
    });
  });
  await new Promise<void>((resolve) => camelfsServer.listen(0, "127.0.0.1", resolve));
  t.after(() => camelfsServer.close());
  const camelfsPort = (camelfsServer.address() as { port: number }).port;

  // 3. Start isolated v2 Worker via Wrangler
  const dir = mkdtempSync(join(tmpdir(), "v2-hosted-mcp-"));
  const config = join(dir, "wrangler.json");
  const admin = "fixture-mcp-admin";
  writeFileSync(
    config,
    JSON.stringify({
      name: "v2-hosted-mcp-test",
      main: fileURLToPath(new URL("../worker/src/index.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: admin,
        VAULT_SECRET: "fixture-mcp-vault-32-bytes-minimum",
        CAMELFS_URL: `http://127.0.0.1:${camelfsPort}`,
        CAMELFS_DEV_TOKEN: "dev-camelfs-token",
        DEFAULT_MODEL: "openai/gpt-4o-mini",
        VOICE_PUBLIC_URL: "https://run.camelai.com",
      },
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

  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());
  const origin = "https://run.camelai.com";
  const fetcher = worker.fetch.bind(worker) as unknown as typeof fetch;

  const tenant = await CamelRun.createTenant({
    baseUrl: origin,
    fetch: fetcher,
    adminKey: admin,
    name: "mcp-test-tenant",
    initialCreditsUsd: 10,
  });

  // Configure BYOK openai provider pointing at our local mock LLM
  const provRes = await worker.fetch(`${origin}/v2/providers/openai`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${tenant.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      apiKey: "sk-mock-openai",
      baseUrl: `http://127.0.0.1:${llmPort}/v1`,
    }),
  });
  assert.equal(provRes.status, 200);

  const postMcp = (
    path: string,
    payload: unknown,
    token?: string,
    extraHeaders: Record<string, string> = {},
  ) =>
    worker.fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
        Accept: MCP_ACCEPT,
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

  // ---- A. CORS preflight, 401 WWW-Authenticate, 405 Method Not Allowed, Protected Resource Metadata ----

  for (const path of ["/v2/mcp", "/mcp", "/v2/agents/helper/mcp"]) {
    const preflight = await worker.fetch(`${origin}${path}`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204, `OPTIONS ${path}`);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Mcp-Session-Id/);
    assert.match(preflight.headers.get("access-control-expose-headers") ?? "", /WWW-Authenticate/);
    assert.equal(preflight.headers.get("access-control-max-age"), "86400");

    const unauth = await postMcp(path, { jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.equal(unauth.status, 401, `unauth ${path}`);
    const wwwAuth = unauth.headers.get("www-authenticate") ?? "";
    assert.match(wwwAuth, /^Bearer resource_metadata="https:\/\/run\.camelai\.com\/\.well-known\/oauth-protected-resource\//);
    assert.match(wwwAuth, /scope="agents"/);
    assert.equal(unauth.headers.get("access-control-allow-origin"), "*");

    const badAuth = await postMcp(
      path,
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      "cr_live_invalid_token",
    );
    assert.equal(badAuth.status, 401, `badAuth ${path}`);
    assert.match(badAuth.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  }

  // Protected-resource metadata endpoints
  const metaRes = await worker.fetch(`${origin}/.well-known/oauth-protected-resource/v2/mcp`);
  assert.equal(metaRes.status, 200);
  const metaJson = (await metaRes.json()) as { resource: string; scopes_supported: string[] };
  assert.equal(metaJson.resource, "https://run.camelai.com/v2/mcp");
  assert.deepEqual(metaJson.scopes_supported, ["agents"]);

  // 405 on GET / DELETE once authenticated on /v2/mcp
  for (const method of ["GET", "DELETE"]) {
    const res = await worker.fetch(`${origin}/v2/mcp`, {
      method,
      headers: { Authorization: `Bearer ${tenant.apiKey}` },
    });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  }

  // ---- B. Tenant Hosted MCP (`/v2/mcp`): initialize, tools/list, account, definitions, agents, runs, inputs ----

  const initRes = await postMcp(
    "/v2/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    },
    tenant.apiKey,
  );
  assert.equal(initRes.status, 200);
  const initParsed = await readMcpResponse(initRes);
  assert.equal(initParsed.resultMsg?.result?.serverInfo?.name, "camelrun");

  const listToolsRes = await postMcp(
    "/v2/mcp",
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    tenant.apiKey,
  );
  assert.equal(listToolsRes.status, 200);
  const listedTools = (await readMcpResponse(listToolsRes)).resultMsg?.result?.tools as Array<{
    name: string;
  }>;
  const toolNames = new Set(listedTools.map((tool) => tool.name));
  for (const expected of [
    "whoami",
    "list_models",
    "get_billing",
    "list_definitions",
    "upsert_definition",
    "list_agents",
    "get_agent",
    "upsert_agent",
    "delete_agent",
    "send_message",
    "get_history",
    "answer_input",
    "abort_agent",
    "list_repos",
    "list_files",
    "read_file",
    "write_file",
    "grep_files",
  ]) {
    assert.ok(toolNames.has(expected), `Missing tool ${expected}`);
  }

  let rpcId = 10;
  const callTenantTool = async (
    name: string,
    args: Record<string, unknown>,
    progressToken?: string,
  ) => {
    const res = await postMcp(
      "/v2/mcp",
      {
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          ...(progressToken ? { _meta: { progressToken } } : {}),
        },
      },
      tenant.apiKey,
    );
    assert.equal(res.status, 200, `tools/call ${name} failed with ${res.status}`);
    const parsed = await readMcpResponse(res);
    const result = parsed.resultMsg?.result as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    return {
      isError: Boolean(result?.isError),
      rawText: result?.content?.[0]?.text ?? "",
      json: () => JSON.parse(result?.content?.[0]?.text ?? "{}"),
      messages: parsed.messages,
      contentType: parsed.contentType,
    };
  };

  // Account & billing & models
  const whoami = await callTenantTool("whoami", {});
  assert.equal(whoami.isError, false);
  assert.equal(whoami.json().tenantId, tenant.tenantId);

  const billing = await callTenantTool("get_billing", {});
  assert.equal(billing.isError, false);
  assert.equal(billing.json().balanceUsd, 10);

  const models = await callTenantTool("list_models", { available: true, provider: "openai" });
  assert.equal(models.isError, false);
  assert.ok((models.json() as Array<{ id: string }>).some((m) => m.id === "openai/gpt-4o-mini"));

  // Definitions
  const upsertDef = await callTenantTool("upsert_definition", {
    slug: "support-bot",
    model: "openai/gpt-4o-mini",
    instructions: "SECRET_SYSTEM_PROMPT_DO_NOT_LEAK",
    builtins: ["human"],
  });
  assert.equal(upsertDef.isError, false);
  assert.equal(upsertDef.json().slug, "support-bot");

  const listDefs = await callTenantTool("list_definitions", {});
  assert.equal(listDefs.isError, false);
  assert.equal(listDefs.json().definitions.length, 1);

  // Upsert agent (must NOT leak agentToken)
  const upsertedAgent = await callTenantTool("upsert_agent", {
    key: "mcp-agent-1",
    definition: "support-bot",
  });
  assert.equal(upsertedAgent.isError, false);
  const agent1 = upsertedAgent.json() as { id: string; key: string; agentToken?: string };
  assert.equal(agent1.key, "mcp-agent-1");
  assert.equal(agent1.agentToken, undefined, "agentToken must not be exposed by MCP upsert_agent");

  const listedAgents = await callTenantTool("list_agents", {});
  assert.equal(listedAgents.isError, false);
  assert.ok(
    (listedAgents.json().agents as Array<{ key: string }>).some((a) => a.key === "mcp-agent-1"),
  );

  const gotAgent = await callTenantTool("get_agent", { agent: "mcp-agent-1" });
  assert.equal(gotAgent.isError, false);
  assert.equal(gotAgent.json().id, agent1.id);
  assert.equal(gotAgent.json().key, "mcp-agent-1");

  // send_message completing a normal turn (also exercises SSE streaming when progressToken provided)
  const msg1 = await callTenantTool(
    "send_message",
    { agent: "mcp-agent-1", message: "Hello from tenant MCP" },
    "prog-tenant-1",
  );
  assert.equal(msg1.isError, false);
  assert.match(msg1.contentType, /text\/event-stream/);
  assert.equal(msg1.json().status, "completed");
  assert.equal(msg1.json().text, "Reply: Hello from tenant MCP");

  // get_history
  const hist = await callTenantTool("get_history", { agent: "mcp-agent-1", limit: 10 });
  assert.equal(hist.isError, false);
  assert.ok(hist.json().messages.length >= 2);

  // send_message hitting input_required -> answer_input resumes to completed!
  const paused = await callTenantTool("send_message", {
    agent: "mcp-agent-1",
    message: "Please deploy NEEDS_INPUT",
  });
  assert.equal(paused.isError, false);
  const pausedData = paused.json() as {
    status: string;
    inputs: Array<{ id: string; kind: string; prompt: { question: string } }>;
  };
  assert.equal(pausedData.status, "input_required");
  assert.equal(pausedData.inputs.length, 1);
  assert.equal(pausedData.inputs[0]!.kind, "question");

  const resumed = await callTenantTool("answer_input", {
    agent: "mcp-agent-1",
    inputId: pausedData.inputs[0]!.id,
    approved: true,
    answer: "staging",
  });
  assert.equal(resumed.isError, false);
  assert.equal(resumed.json().status, "completed");
  assert.match(resumed.json().text, /Confirmed after input:.*staging/);

  // abort_agent
  const aborted = await callTenantTool("abort_agent", { agent: "mcp-agent-1" });
  assert.equal(aborted.isError, false);
  assert.equal(aborted.json().aborted, true);

  // ---- C. CamelFS repo tools via `/v2/mcp` ----

  const createRepoRes = await worker.fetch(`${origin}/v2/repos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenant.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "mcp-repo" }),
  });
  assert.equal(createRepoRes.status, 201);
  const createdRepo = (await createRepoRes.json()) as { repoId: string };

  const reposList = await callTenantTool("list_repos", {});
  assert.equal(reposList.isError, false);
  assert.ok(
    (reposList.json().repos as Array<{ repoId: string }>).some(
      (r) => r.repoId === createdRepo.repoId,
    ),
  );

  const writeRes = await callTenantTool("write_file", {
    repoId: createdRepo.repoId,
    path: "docs/readme.md",
    content: "CamelRun v2 Hosted MCP\nSupports CamelFS repos cleanly.\n",
    message: "add readme",
  });
  assert.equal(writeRes.isError, false);
  assert.deepEqual(writeRes.json().changed, ["docs/readme.md"]);

  const filesList = await callTenantTool("list_files", { repoId: createdRepo.repoId });
  assert.equal(filesList.isError, false);
  assert.equal(filesList.json().entries[0].path, "docs/readme.md");

  const readFileRes = await callTenantTool("read_file", {
    repoId: createdRepo.repoId,
    path: "docs/readme.md",
  });
  assert.equal(readFileRes.isError, false);
  assert.match(readFileRes.json().content, /Supports CamelFS repos cleanly/);

  const grepRes = await callTenantTool("grep_files", {
    repoId: createdRepo.repoId,
    pattern: "CamelFS",
  });
  assert.equal(grepRes.isError, false);
  assert.equal(grepRes.json().matches.length, 1);
  assert.equal(grepRes.json().matches[0].path, "docs/readme.md");

  // ---- D. Per-Agent Hosted MCP (`/v2/agents/:idOrKey/mcp`) ----

  // Create a second agent via REST so we have its scoped `agt_tok_*` token
  const putAgent2 = await worker.fetch(`${origin}/v2/agents/per-agent-demo`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${tenant.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      instructions: "TOP_SECRET_INSTRUCTIONS_NEVER_SHOWN",
      builtins: ["human"],
    }),
  });
  assert.equal(putAgent2.status, 201);
  const agent2 = (await putAgent2.json()) as { id: string; key: string; agentToken: string };
  assert.ok(agent2.agentToken.startsWith("agt_tok_"));

  // Scoped agent token is rejected on tenant `/v2/mcp` with 403
  const forbiddenOnTenant = await postMcp(
    "/v2/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    agent2.agentToken,
  );
  assert.equal(forbiddenOnTenant.status, 403);

  // Scoped agent token for agent2 is rejected on agent1's `/mcp` with 403
  const wrongAgent = await postMcp(
    `/v2/agents/${agent1.id}/mcp`,
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    agent2.agentToken,
  );
  assert.equal(wrongAgent.status, 403);

  // 405 on GET for authenticated per-agent MCP
  const agentGet = await worker.fetch(`${origin}/v2/agents/${agent2.key}/mcp`, {
    method: "GET",
    headers: { Authorization: `Bearer ${agent2.agentToken}` },
  });
  assert.equal(agentGet.status, 405);
  assert.equal(agentGet.headers.get("allow"), "POST");

  // Per-agent initialize + tools/list + message with scoped `agt_tok_*` token
  const agentInitRes = await postMcp(
    `/v2/agents/${agent2.key}/mcp`,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "agent-client", version: "1.0.0" },
      },
    },
    agent2.agentToken,
  );
  assert.equal(agentInitRes.status, 200);
  const sessionNoElicit = agentInitRes.headers.get("mcp-session-id");
  assert.ok(sessionNoElicit && sessionNoElicit.endsWith("."), `unexpected session: ${sessionNoElicit}`);

  const agentToolsRes = await postMcp(
    `/v2/agents/${agent2.key}/mcp`,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    agent2.agentToken,
  );
  assert.equal(agentToolsRes.status, 200);
  const agentTools = (await readMcpResponse(agentToolsRes)).resultMsg?.result?.tools as Array<{
    name: string;
    description: string;
  }>;
  assert.deepEqual(
    agentTools.map((x) => x.name),
    ["message"],
  );
  assert.ok(!agentTools[0]!.description.includes("TOP_SECRET_INSTRUCTIONS_NEVER_SHOWN"));

  // Call `message` using scoped agent token
  const agentMsg1Res = await postMcp(
    `/v2/agents/${agent2.key}/mcp`,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "message",
        arguments: { text: "Hi via scoped token" },
        _meta: { progressToken: "pt-agent-1" },
      },
    },
    agent2.agentToken,
    { "Mcp-Session-Id": sessionNoElicit! },
  );
  assert.equal(agentMsg1Res.status, 200);
  const agentMsg1 = await readMcpResponse(agentMsg1Res);
  assert.match(agentMsg1.contentType, /text\/event-stream/);
  assert.equal(agentMsg1.resultMsg?.result?.isError, undefined);
  assert.equal(agentMsg1.resultMsg?.result?.content?.[0]?.text, "Reply: Hi via scoped token");
  assert.equal(agentMsg1.resultMsg?.result?.structuredContent?.status, "completed");

  // Call `message` using tenant key when agent needs input (NO elicitation capability -> structured input_required)
  const reqId = "req_no_elicit_1";
  const agentPausedRes = await postMcp(
    `/v2/agents/${agent2.id}/mcp`,
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "message",
        arguments: { text: "Deploy now NEEDS_INPUT", requestId: reqId },
      },
    },
    tenant.apiKey,
    { "Mcp-Session-Id": sessionNoElicit! },
  );
  assert.equal(agentPausedRes.status, 200);
  const agentPaused = await readMcpResponse(agentPausedRes);
  const sc = agentPaused.resultMsg?.result?.structuredContent as {
    status: string;
    requestId: string;
    inputs: Array<{ id: string }>;
  };
  assert.equal(sc.status, "input_required");
  assert.equal(sc.requestId, reqId);
  assert.equal(sc.inputs.length, 1);

  // Answer via REST, then retry `message` with same requestId -> returns completed reply
  const ansRes = await worker.fetch(`${origin}/v2/agents/${agent2.id}/inputs/${sc.inputs[0]!.id}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenant.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ approved: true, answer: "production", wait: true }),
  });
  assert.equal(ansRes.status, 200);

  const retryRes = await postMcp(
    `/v2/agents/${agent2.id}/mcp`,
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "message",
        arguments: { text: "Deploy now NEEDS_INPUT", requestId: reqId },
      },
    },
    tenant.apiKey,
  );
  assert.equal(retryRes.status, 200);
  const retried = await readMcpResponse(retryRes);
  assert.equal(retried.resultMsg?.result?.structuredContent?.status, "completed");
  assert.match(
    retried.resultMsg?.result?.content?.[0]?.text ?? "",
    /Confirmed after input:.*production/,
  );

  // Per-agent elicitation flow: client declares `capabilities.elicitation.form` -> receives `elicitation/create`, replies with 202, stream completes!
  const elicitInitRes = await postMcp(
    `/v2/agents/${agent2.id}/mcp`,
    {
      jsonrpc: "2.0",
      id: 6,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: { elicitation: { form: {} } },
        clientInfo: { name: "elicit-client", version: "1.0.0" },
      },
    },
    agent2.agentToken,
  );
  assert.equal(elicitInitRes.status, 200);
  const elicitSession = elicitInitRes.headers.get("mcp-session-id");
  assert.ok(elicitSession && elicitSession.endsWith(".f"), `expected .f flag in ${elicitSession}`);

  const elicitStreamRes = await postMcp(
    `/v2/agents/${agent2.id}/mcp`,
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "message",
        arguments: { text: "Deploy again NEEDS_INPUT" },
        _meta: { progressToken: "pt-elicit-1" },
      },
    },
    agent2.agentToken,
    { "Mcp-Session-Id": elicitSession! },
  );
  assert.equal(elicitStreamRes.status, 200);
  assert.ok(elicitStreamRes.body);

  const reader = elicitStreamRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = "";
  let repliedElicit = false;
  let finalElicitResult: Record<string, any> | undefined;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    sseBuf += decoder.decode(chunk.value, { stream: true });
    const parts = sseBuf.split(/\r?\n\r?\n/);
    sseBuf = parts.pop() ?? "";
    for (const part of parts) {
      for (const msg of parseSseJsonMessages(part + "\n\n")) {
        if (msg.method === "elicitation/create" && typeof msg.id === "string" && !repliedElicit) {
          repliedElicit = true;
          assert.ok(msg.id.startsWith("input:"));
          const replyRes = await postMcp(
            `/v2/agents/${agent2.id}/mcp`,
            {
              jsonrpc: "2.0",
              id: msg.id,
              result: { action: "accept", content: { answer: "staging" } },
            },
            agent2.agentToken,
            { "Mcp-Session-Id": elicitSession! },
          );
          assert.equal(replyRes.status, 202);
        } else if (msg.id === 7 && "result" in msg) {
          finalElicitResult = msg.result;
        }
      }
    }
  }
  assert.equal(repliedElicit, true, "Expected server to emit elicitation/create request");
  assert.equal(finalElicitResult?.structuredContent?.status, "completed");
  assert.match(
    finalElicitResult?.content?.[0]?.text ?? "",
    /Confirmed after input:.*staging/,
  );

  // delete_agent via `/v2/mcp`
  const deleted = await callTenantTool("delete_agent", { agent: "mcp-agent-1" });
  assert.equal(deleted.isError, false);
  assert.equal(deleted.json().deleted, true);
});

test("v2 ingress routes /mcp, /v2/mcp, /v2/agents/:id/mcp, and protected-resource metadata directly to V2", async (t) => {
  const origin = t.mock.method(globalThis, "fetch", async () => new Response("origin", { status: 599 }));
  const v2Seen: string[] = [];
  const v2 = t.mock.fn(async (request: Request) => {
    v2Seen.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json({ routedTo: new URL(request.url).pathname });
  });
  const env = { V2: { fetch: v2 } };

  // 1. Bearer cr_live_... on /mcp routes directly to V2 at /v2/mcp
  const r1 = await ingressWorker.fetch(
    new Request("https://run.camelai.com/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer cr_live_tnt_0123456789abcdef.secret" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    }),
    env,
  );
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { routedTo: "/v2/mcp" });

  // 2. OPTIONS /mcp routes to V2 at /v2/mcp
  const r2 = await ingressWorker.fetch(
    new Request("https://run.camelai.com/mcp", { method: "OPTIONS" }),
    env,
  );
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), { routedTo: "/v2/mcp" });

  // 3. Unauthenticated POST /mcp routes to V2 at /v2/mcp
  const r3 = await ingressWorker.fetch(
    new Request("https://run.camelai.com/mcp", { method: "POST", body: "{}" }),
    env,
  );
  assert.equal(r3.status, 200);
  assert.deepEqual(await r3.json(), { routedTo: "/v2/mcp" });

  // 4. /v2/mcp, /v2/agents/:id/mcp, and protected-resource metadata route directly to V2
  for (const path of [
    "/v2/mcp",
    "/v2/agents/helper/mcp",
    "/.well-known/oauth-protected-resource/v2/mcp",
    "/.well-known/oauth-protected-resource/v2/agents/helper/mcp",
  ]) {
    const r = await ingressWorker.fetch(new Request(`https://run.camelai.com${path}`), env);
    assert.equal(r.status, 200, path);
    assert.deepEqual(await r.json(), { routedTo: path });
  }

  assert.equal(origin.mock.callCount(), 0);
  assert.equal(v2Seen.length, 7);
});

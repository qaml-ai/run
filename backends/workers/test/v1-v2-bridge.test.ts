import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleBridgedAgentCreate,
  handleBridgedAgentMutation,
  handleBridgedDefinitionRoutes,
  handleBridgedMediaOrDecision,
  handleBridgedStatelessRuns,
  mapV1BuiltinsToV2,
  v1ClientId,
  v1DefinitionId,
  v1SpecToV2Config,
} from "../src/v1-v2-bridge.ts";

function makeFakeBridge() {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const meta = new Map<string, unknown>();
  const agents = new Map<string, { tenantId: string; agentId: string; key: string; tokenHash: string }>();

  const bridge = {
    async route(_tenant: string, _agent: string, request: Request) {
      calls.push({ method: request.method, path: new URL(request.url).pathname, body: null });
      return Response.json({ deleted: true });
    },
    async bridge(_v1Tenant: string, path: string, request: Request) {
      const text = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
      const body = text ? JSON.parse(text) : null;
      calls.push({ method: request.method, path, body });
      if (path.startsWith("/v2/definitions/")) {
        return Response.json({ slug: path.slice("/v2/definitions/".length), config: body });
      }
      if (path.startsWith("/v2/agents/") && request.method === "PUT") {
        const key = decodeURIComponent(path.slice("/v2/agents/".length));
        const agtId = "agt_" + "1".repeat(16);
        agents.set(key, { tenantId: "tnt_" + "a".repeat(16), agentId: agtId, key, tokenHash: "h" });
        const hasPrompt = typeof (body as Record<string, unknown>)?.prompt === "string";
        return Response.json({
          id: agtId,
          key,
          agentToken: `cr_agt_tnt_${"a".repeat(16)}_${agtId}.secret`,
          model: (body as Record<string, unknown>)?.model ?? "azure/gpt-6.2-sol",
          created: true,
          ...(hasPrompt ? { run: { status: "completed", text: "ok", output: null, error: null, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 }, toolCalls: [], startedAt: 1, endedAt: 2 } } : {}),
        }, { status: 201 });
      }
      if (path === "/v2/runs" && request.method === "POST") {
        return Response.json({
          id: "run_1",
          status: "completed",
          text: "hello world",
          output: null,
          error: null,
          model: (body as Record<string, unknown>)?.model ?? "azure/gpt-6.2-sol",
          usage: { inputTokens: 12, outputTokens: 6, costUsd: 0.002 },
          toolCalls: [],
        });
      }
      if (path.endsWith("/abort") && request.method === "POST") {
        return Response.json({ aborted: true });
      }
      if (path.startsWith("/v2/agents/") && request.method === "DELETE") {
        return Response.json({ deleted: true });
      }
      if (["/v2/speech", "/v2/transcriptions", "/v2/images", "/v2/decisions"].includes(path)) {
        return Response.json({ proxied: path });
      }
      return Response.json({ ok: true });
    },
    async resolveBridgedAgent(_v1Tenant: string, idOrKey: string) {
      return agents.get(idOrKey) ?? null;
    },
    async putMeta(t: string, kind: string, id: string, data: unknown) {
      meta.set(`${t}:${kind}:${id}`, data);
    },
    async getMeta<T = unknown>(t: string, kind: string, id: string) {
      return (meta.get(`${t}:${kind}:${id}`) as T) ?? null;
    },
    async listMeta<T = unknown>(t: string, kind: string) {
      const prefix = `${t}:${kind}:`;
      const out: Array<{ id: string; data: T }> = [];
      for (const [k, v] of meta) {
        if (k.startsWith(prefix)) out.push({ id: k.slice(prefix.length), data: v as T });
      }
      return out;
    },
    async deleteMeta(t: string, kind: string, id: string) {
      return meta.delete(`${t}:${kind}:${id}`);
    },
  };

  return { bridge, calls, meta, agents };
}

const emptySql = {
  async query() {
    return { rows: [], rowCount: 0 };
  },
} as never;

test("translates v1 builtins and delegate definitions cleanly into v2 config", () => {
  assert.deepEqual(
    mapV1BuiltinsToV2({
      builtins: ["web_search", "web_fetch", "ask_user", "delegate", "unknown_v1_builtin"],
      fileTools: true,
      codeMode: true,
    }),
    ["web_search", "web_fetch", "human", "delegate", "files", "codemode"],
  );

  const cfg = v1SpecToV2Config({
    model: "anthropic/claude-sonnet-5-5",
    systemPrompt: "You are a coordinator.",
    builtins: ["delegate"],
    delegate: {
      agents: [{ name: "scout", definition: "trading-scout-v02" }],
      maxParallel: 4,
    },
    limits: { idleTtlSeconds: 600 },
    runLimits: { maxCostUsd: 2.5 },
  });
  assert.equal(cfg.model, "anthropic/claude-sonnet-5-5");
  assert.match(String(cfg.instructions), /You are a coordinator/);
  assert.match(String(cfg.instructions), /trading-scout-v02/);
  assert.deepEqual(cfg.builtins, ["delegate"]);
  assert.equal(cfg.idleTtlSeconds, 600);
  assert.equal(cfg.spendLimitUsd, 2.5);
});

test("bridges v1 definitions CRUD and syncs delegated subagent definitions to v2", async () => {
  const { bridge, calls } = makeFakeBridge();
  const env = { V2_LEGACY_RUNS: bridge } as never;

  const subRes = await handleBridgedDefinitionRoutes(
    new Request("https://run.camelai.com/v1/definitions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "trading-scout" },
      body: JSON.stringify({ name: "Scout", model: "google/gemini-3.8-flash", builtins: ["web_search", "web_fetch"], systemPrompt: "Scout." }),
    }),
    env,
    emptySql,
    "guillermogm89",
  );
  assert.equal(subRes?.status, 201);
  const sub = (await subRes!.json()) as { id: string; revision: number };
  assert.equal(sub.id, v1DefinitionId("guillermogm89", "trading-scout"));
  assert.equal(sub.revision, 1);

  const parentRes = await handleBridgedDefinitionRoutes(
    new Request("https://run.camelai.com/v1/definitions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Jefe",
        model: "anthropic/claude-sonnet-5-5",
        builtins: ["delegate"],
        delegate: { agents: [{ name: "scout", definition: "trading-scout" }] },
        systemPrompt: "Lead.",
      }),
    }),
    env,
    emptySql,
    "guillermogm89",
  );
  assert.equal(parentRes?.status, 201);
  const parent = (await parentRes!.json()) as { id: string; name: string };
  assert.ok(calls.some((c) => c.path === "/v2/definitions/trading-scout"));
  assert.ok(calls.some((c) => c.path === `/v2/definitions/${parent.id}`));

  const patchRes = await handleBridgedDefinitionRoutes(
    new Request(`https://run.camelai.com/v1/definitions/${parent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "azure/gpt-6-luna" }),
    }),
    env,
    emptySql,
    "guillermogm89",
  );
  assert.equal(patchRes?.status, 200);
  const patched = (await patchRes!.json()) as { revision: number; model: string };
  assert.equal(patched.revision, 2);
  assert.equal(patched.model, "azure/gpt-6-luna");

  const listRes = await handleBridgedDefinitionRoutes(
    new Request("https://run.camelai.com/v1/definitions"),
    env,
    emptySql,
    "guillermogm89",
  );
  assert.equal(((await listRes!.json()) as unknown[]).length, 2);

  const delRes = await handleBridgedDefinitionRoutes(
    new Request(`https://run.camelai.com/v1/definitions/${parent.id}`, { method: "DELETE" }),
    env,
    emptySql,
    "guillermogm89",
  );
  assert.deepEqual(await delRes!.json(), { deleted: true });
});

test("bridges v1 agent create, abort, delete, stateless runs, and media/decisions", async () => {
  const { bridge } = makeFakeBridge();
  const env = { V2_LEGACY_RUNS: bridge } as never;

  const createRes = await handleBridgedAgentCreate(
    new Request("https://run.camelai.com/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "eval-1", model: "openai/gpt-6.1-terra", systemPrompt: "Eval." }),
    }),
    env,
    emptySql,
    "guillermogm89",
  );
  assert.equal(createRes?.status, 201);
  const created = (await createRes!.json()) as { id: string; token: string };
  assert.equal(created.id, v1ClientId("guillermogm89", "eval-1"));
  assert.match(created.id, /^client_[a-f0-9]{40}$/);
  assert.match(created.token, /^cr_agt_/);

  const abortRes = await handleBridgedAgentMutation(
    new Request(`https://run.camelai.com/v1/agents/${created.id}/abort`, { method: "POST" }),
    env,
    emptySql,
    "guillermogm89",
    created.id,
    "/abort",
  );
  assert.deepEqual(await abortRes!.json(), { aborted: true });

  const delRes = await handleBridgedAgentMutation(
    new Request(`https://run.camelai.com/v1/agents/${created.id}`, { method: "DELETE" }),
    env,
    emptySql,
    "guillermogm89",
    created.id,
    "",
  );
  assert.deepEqual(await delRes!.json(), { deleted: true });

  const runRes = await handleBridgedStatelessRuns(
    new Request("https://run.camelai.com/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Say hi", model: "azure/gpt-6.2-sol" }),
    }),
    env,
    emptySql,
    "guillermogm89",
  );
  assert.equal(runRes?.status, 200);
  const runBody = (await runRes!.json()) as { id: string; status: string; text: string };
  assert.match(runBody.id, /^run_[a-f0-9]{40}$/);
  assert.equal(runBody.status, "completed");
  assert.equal(runBody.text, "hello world");

  const getRunRes = await handleBridgedStatelessRuns(
    new Request(`https://run.camelai.com/v1/runs/${runBody.id}`),
    env,
    emptySql,
    "guillermogm89",
  );
  assert.equal(((await getRunRes!.json()) as { text: string }).text, "hello world");

  const speechRes = await handleBridgedMediaOrDecision(
    new Request("https://run.camelai.com/v1/speech", { method: "POST", body: "{}" }),
    env,
    "guillermogm89",
  );
  assert.deepEqual(await speechRes!.json(), { proxied: "/v2/speech" });
});

// Which engine runs a tenant's js_exec: AGENT_JS_EXEC for the runtime, a tenants-file entry's
// `codeEngine` for an admin tenant, `PUT /v1/tenants/{id}/limits` for a self-serve one (the staged
// rollout: v8 by default, chiridion pinned to quickjs, then flipped). Code tells the engines apart
// by Intl, which only V8 has here; the metric line says which ran it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { Tenants } from "../src/tenants.ts";
import { v8ExecBinary } from "../src/v8-exec.ts";
import { OPERATOR, OTHER_OPERATOR, runtime, toolCall } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("a tenants-file entry's codeEngine is quickjs or v8", async () => {
  const load = (codeEngine: unknown) => new Tenants({ read: async () => JSON.stringify({ tenants: { pinned: { tokenSha256: sha(OPERATOR), codeEngine } } }) }).reload();
  await assert.rejects(load("node"), /invalid codeEngine/);
  for (const engine of ["quickjs", "v8"]) {
    const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { pinned: { tokenSha256: sha(OPERATOR), codeEngine: engine } } }) });
    await tenants.reload();
    assert.equal(tenants.codeLimits("pinned").engine, engine);
  }
});

test("v8 by default, an admin tenant pinned to quickjs, and a self-serve tenant set either way by the operator", { timeout: 120_000, skip: !existsSync(v8ExecBinary()) && "v8-exec is not built" }, async t => {
  const tenantsFile = {
    tenants: {
      // Like chiridion-prod during the rollout: pinned to QuickJS while every other tenant gets V8.
      alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" }, codeEngine: "quickjs" },
      bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
    },
    platformKeys: { openrouter: "fixture-platform-key" },
  };
  // One js_exec that reports its engine, then an answer.
  const r = await runtime(t, (body: any, index) => body.messages.some((message: any) => message.role === "tool")
    ? { role: "assistant", content: "done", usage: { prompt_tokens: 10, completion_tokens: 1 } }
    : { ...toolCall("js_exec", { code: 'return typeof Intl === "object" ? "v8" : "quickjs"' }, `call_${index}`), usage: { prompt_tokens: 10, completion_tokens: 1 } },
  { AGENT_JS_EXEC: "v8", AGENT_BILLING_ADMINS: "alice" }, tenantsFile);
  const engineOf = async (token?: string) => {
    const before = r.model.bodies.length;
    const agent = (await r.call("/v1/agents", { body: {}, token })).json;
    assert.equal((await r.prompt(agent.id, "which engine?", token)).outcome.result.reply, "done");
    const tool = r.model.bodies.slice(before).flatMap((body: any) => body.messages).find((message: any) => message.role === "tool");
    return String(tool.content).trim();
  };
  assert.equal(await engineOf(), "quickjs", "alice is pinned to quickjs");
  assert.equal(await engineOf(OTHER_OPERATOR), "v8", "bob gets the runtime's, v8");

  const made = await r.call("/v1/tenants", { body: { id: "lab-engine" } });
  assert.equal(made.status, 201, made.text);
  const token = made.json.token.token;
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "lab-engine", amount: 5_000_000, reason: "test", idempotencyKey: "engine:1" } })).status, 201);
  assert.equal(await engineOf(token), "v8");
  assert.equal((await r.call("/v1/tenants/lab-engine/limits", { method: "PUT", body: { codeEngine: "node" } })).status, 400);
  const pinned = await r.call("/v1/tenants/lab-engine/limits", { method: "PUT", body: { codeEngine: "quickjs" } });
  assert.deepEqual(pinned.json.limits, { codeEngine: "quickjs" });
  assert.equal(await engineOf(token), "quickjs");
  assert.deepEqual((await r.call("/v1/tenants/lab-engine/limits", { method: "PUT", body: { codeEngine: null } })).json.limits, {});
  assert.equal(await engineOf(token), "v8");

  // Each execution's metric line names its engine (agent processes write theirs to the runtime's log when it collects them).
  const lines = r.logs.map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(line => line?.type === "code_execution");
  if (lines.length) assert.deepEqual(lines.map(line => line.Engine), ["quickjs", "v8", "v8", "quickjs", "v8"]);
  const booted = r.logs.map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(line => line?.type === "listening");
  assert.equal(booted.sandbox.engine, "v8");
  assert.equal(booted.sandbox.engines.v8, "ok");
});

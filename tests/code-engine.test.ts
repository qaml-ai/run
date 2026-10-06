// js_exec has one engine, V8 (v8-exec), since QuickJS was removed. A tenant's `codeEngine` (tenants
// file, or `PUT /v1/tenants/{id}/limits`) pinned one of the two; what is left of it refuses QuickJS
// with a message that says how to clear it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { Tenants } from "../src/tenants.ts";
import { v8ExecBinary } from "../src/v8-exec.ts";
import { OPERATOR, OTHER_OPERATOR, runtime, toolCall } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("a tenants-file entry's codeEngine may only be v8, which changes nothing; quickjs says how to clear it", async () => {
  const load = (codeEngine: unknown) => new Tenants({ read: async () => JSON.stringify({ tenants: { pinned: { tokenSha256: sha(OPERATOR), codeEngine } } }) }).reload();
  await assert.rejects(load("quickjs"), /pinned has codeEngine "quickjs", but QuickJS was removed and js_exec runs on V8 only: remove codeEngine from its entry \(infra\/tenant\.sh clear-engine pinned\)/);
  await assert.rejects(load("node"), /QuickJS was removed/);
  await load("v8");
});

test("js_exec runs on V8 for every tenant, and the limits API refuses an engine", { timeout: 120_000, skip: !existsSync(v8ExecBinary()) && "v8-exec is not built" }, async t => {
  const tenantsFile = {
    tenants: {
      alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" }, codeEngine: "v8" },
      bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
    },
    platformKeys: { openrouter: "fixture-platform-key" },
  };
  // One js_exec that reports its engine (only V8 has Intl here), then an answer.
  const r = await runtime(t, (body: any, index) => body.messages.some((message: any) => message.role === "tool")
    ? { role: "assistant", content: "done", usage: { prompt_tokens: 10, completion_tokens: 1 } }
    : { ...toolCall("js_exec", { code: 'return typeof Intl === "object" ? "v8" : "other"' }, `call_${index}`), usage: { prompt_tokens: 10, completion_tokens: 1 } },
  { AGENT_BILLING_ADMINS: "alice" }, tenantsFile);
  const engineOf = async (token?: string) => {
    const before = r.model.bodies.length;
    const agent = (await r.call("/v1/agents", { body: {}, token })).json;
    assert.equal((await r.prompt(agent.id, "which engine?", token)).outcome.result.reply, "done");
    const tool = r.model.bodies.slice(before).flatMap((body: any) => body.messages).find((message: any) => message.role === "tool");
    return String(tool.content).trim();
  };
  assert.equal(await engineOf(), "v8");
  assert.equal(await engineOf(OTHER_OPERATOR), "v8");

  const made = await r.call("/v1/tenants", { body: { id: "lab-engine" } });
  assert.equal(made.status, 201, made.text);
  const token = made.json.token.token;
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "lab-engine", amount: 5_000_000, reason: "test", idempotencyKey: "engine:1" } })).status, 201);
  for (const codeEngine of ["quickjs", "v8"]) {
    const refused = await r.call("/v1/tenants/lab-engine/limits", { method: "PUT", body: { codeEngine } });
    assert.equal(refused.status, 400);
    assert.match(refused.text, /codeEngine was removed with QuickJS: js_exec runs on V8 only/);
  }
  const cleared = await r.call("/v1/tenants/lab-engine/limits", { method: "PUT", body: { codeEngine: null, codeCpuMs: 3_000 } });
  assert.equal(cleared.status, 200, cleared.text);
  assert.deepEqual(cleared.json.limits, { codeCpuMs: 3_000 });
  assert.equal(await engineOf(token), "v8");

  // The metric line keeps its Engine dimension, always v8 (agent processes write theirs to the runtime's log when it collects them).
  const lines = r.logs.map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(line => line?.type === "code_execution");
  if (lines.length) assert.deepEqual(new Set(lines.map(line => line.Engine)), new Set(["v8"]));
  const booted = r.logs.map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(line => line?.type === "listening");
  assert.equal(booted.sandbox.mode, "in-process");
});

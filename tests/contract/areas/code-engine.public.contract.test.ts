import { portedTest } from "../ported.ts";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {OPERATOR,OTHER_OPERATOR,runtime,toolCall} from "../support.ts";
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
portedTest("tools","tests/code-engine.test.ts:21")("codemode runs on V8 for every tenant, and the limits API refuses an engine", { timeout: 120_000 }, async t => {
  const tenantsFile = {
    tenants: {
      alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" }, codeEngine: "v8" },
      bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
    },
    platformKeys: { openrouter: "fixture-platform-key" },
  };
  // One codemode that reports its engine (only V8 has Intl here), then an answer.
  const r = await runtime(t, (body: any, index) => body.messages.some((message: any) => message.role === "tool")
    ? { role: "assistant", content: "done", usage: { prompt_tokens: 10, completion_tokens: 1 } }
    : { ...toolCall("codemode", { code: 'return typeof Intl === "object" ? "v8" : "other"' }, `call_${index}`), usage: { prompt_tokens: 10, completion_tokens: 1 } },
  { AGENT_BILLING_ADMINS: "alice" }, tenantsFile);
  const engineOf = async (token?: string) => {
    const before = r.model.bodies.length;
    const agent = (await r.call("/v1/agents", { body: {}, token })).json;
    assert.equal((await r.prompt(agent.id, "which engine?", token)).outcome.result.reply, "done");
    const tool = r.model.bodies.slice(before).flatMap((body: any) => body.messages).find((message: any) => message.role === "tool");
    return String(tool.content).trim();
  };
  assert.match(await engineOf(), /Output:\n+v8/);
  assert.match(await engineOf(OTHER_OPERATOR), /Output:\n+v8/);

  const made = await r.call("/v1/tenants", { body: { id: "lab-engine" } });
  assert.equal(made.status, 201, made.text);
  const token = made.json.token.token;
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "lab-engine", amount: 5_000_000, reason: "test", idempotencyKey: "engine:1" } })).status, 201);
  for (const codeEngine of ["quickjs", "v8"]) {
    const refused = await r.call("/v1/tenants/lab-engine/limits", { method: "PUT", body: { codeEngine } });
    assert.equal(refused.status, 400);
    assert.match(refused.text, /codeEngine was removed with QuickJS: code runs on V8 only/);
  }
  const cleared = await r.call("/v1/tenants/lab-engine/limits", { method: "PUT", body: { codeEngine: null, codeCpuMs: 3_000 } });
  assert.equal(cleared.status, 200, cleared.text);
  assert.deepEqual(cleared.json.limits, { codeCpuMs: 3_000 });
  assert.match(await engineOf(token), /Output:\n+v8/);

  // Runtime metric and boot-process assertions stay in the original Node suite.
});

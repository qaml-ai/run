import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";

test("a keyed upsert preserves definition-owned tool sources and records its configuration", { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  const request = async (path: string, body?: unknown, key?: string) => {
    const response = await fetch(fixture.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${fixture.token}`, "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json() as any;
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`);
    return value;
  };
  const definition = await request("/v1/definitions", { name: "Reader", builtins: ["web_fetch"] });
  const first = await request("/v1/agents", { definition: definition.id }, "reader");
  const again = await request("/v1/agents", { definition: definition.id }, "reader");
  assert.equal(again.id, first.id);
  assert.equal(typeof again.reconfigured.id, "string");
  assert.equal(again.reconfigured.state, "completed");
  assert.equal(again.reconfigured.outcome.result.changed, false);
  assert.deepEqual((await request(`/v1/agents/${first.id}`)).builtins, ["web_fetch"]);
  assert.deepEqual(await request(`/v1/agents/${first.id}/requests/${again.reconfigured.id}`), again.reconfigured);
});

test("a keyed upsert clears omitted tool sources and model settings while preserving language and model", { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  const request = async (path: string, body?: unknown, key?: string) => {
    const response = await fetch(fixture.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${fixture.token}`, "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json() as any;
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`);
    return value;
  };
  const first = await request("/v1/agents", {
    model: "test/echo", language: "es", builtins: ["web_fetch"],
    mcp: { tools: [{ name: "attached_echo", inputSchema: { type: "object", properties: {} } }] },
    mcpServers: [{ name: "unused", url: "http://127.0.0.1:9/mcp" }],
    fileTools: false, codeMode: false, thinkingLevel: "high", systemPromptAppend: "Temporary instructions.",
    maxOutputTokens: 512, temperature: 0.4, dataCollection: "deny", modelHeaders: { "X-Upsert-Test": "fixture" },
    runLimits: { maxResponses: 2, maxSeconds: 30 },
  }, "replace-tools");
  const replaced = await request("/v1/agents", {}, "replace-tools");
  assert.equal(replaced.id, first.id);
  assert.equal(replaced.reconfigured.outcome.result.changed, true);
  const detail = await request(`/v1/agents/${first.id}`);
  assert.equal(detail.model, "test/echo");
  assert.equal(detail.language, "es");
  assert.deepEqual(detail.builtins ?? [], []);
  assert.deepEqual(detail.tools, []);
  assert.deepEqual(detail.mcpServers, []);
  assert.deepEqual([detail.fileTools, detail.codeMode, detail.thinkingLevel, detail.systemPromptAppend], [true, true, "off", ""]);
  assert.deepEqual([detail.maxOutputTokens, detail.temperature, detail.dataCollection, detail.modelHeaders, detail.runLimits], [null, null, null, null, null]);
  assert.equal(detail.toolSources.some((source: { kind: string; name: string }) => source.kind === "application" || source.kind === "mcp" || source.name === "web_fetch"), false);
  const unchanged = await request("/v1/agents", {}, "replace-tools");
  assert.equal(unchanged.configHash, replaced.configHash);
  assert.equal(unchanged.reconfigured.outcome.result.changed, false);
});

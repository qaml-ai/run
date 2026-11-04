import assert from "node:assert/strict";
import test from "node:test";
import { agentToken, configuration, digest } from "../src/api-contract.ts";

test("SDK empty MCP declaration is accepted; executable tools are rejected", () => {
  assert.deepEqual(configuration({ mcp: { tools: [] }, systemPrompt: "Help", codeMode: false }, "test/echo").config,
    { model: "test/echo", systemPrompt: "Help", codeMode: false });
  assert.throws(() => configuration({ mcp: { tools: [{ name: "pay" }] } }, "test/echo"), /Attached tools/);
});

test("unsupported enforcement fields and automatic expiry fail explicitly", () => {
  for (const input of [{ spendLimit: { usd: 1 } }, { runLimits: { maxResponses: 1 } }, { ttlSeconds: 86400 }, { tools: [] }, { initialMessages: [] }]) {
    assert.throws(() => configuration(input, "test/echo"));
  }
  assert.equal(configuration({ ttlSeconds: null }, "test/echo").ttlSeconds, null);
  assert.throws(() => configuration({ fileTools: "false" }, "test/echo"), /boolean/);
});

test("agent credentials are stable, scope-bound, and change with operator secret", async () => {
  const first = await agentToken("operator-secret-for-unit-testing-only", "client_a");
  assert.equal(first, await agentToken("operator-secret-for-unit-testing-only", "client_a"));
  assert.notEqual(first, await agentToken("operator-secret-for-unit-testing-only", "client_b"));
  assert.notEqual(first, await agentToken("different-operator-secret-unit-testing", "client_a"));
  assert.match(first, /^cat_[0-9a-f]{64}$/);
  assert.match(await digest("agent-key"), /^[0-9a-f]{64}$/);
});

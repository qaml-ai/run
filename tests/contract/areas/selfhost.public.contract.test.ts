import { portedTest } from "../ported.ts";
import assert from "node:assert/strict";
import { runtime } from "../support.ts";
const TOKEN = "selfhost-operator-token-at-least-24-chars";

portedTest("selfhost", "tests/selfhost.test.ts:39")("a runtime bootstrapped from AGENT_TENANT and AGENT_OPERATOR_TOKEN serves that tenant", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "Self-hosted." }), {
    AGENT_TENANTS_FILE: "", AGENT_TENANT: "acme", AGENT_OPERATOR_TOKEN: TOKEN, AGENT_TENANT_API_KEYS: JSON.stringify({ openrouter: "fixture-model-key" }),
  });
  assert.equal((await r.call("/v1/me", { token: TOKEN })).json.tenant, "acme");
  const agent = (await r.call("/v1/agents", { body: {}, token: TOKEN })).json.id;
  assert.equal((await r.prompt(agent, "Hi", TOKEN)).outcome.result.reply, "Self-hosted.");
});

portedTest("selfhost", "tests/selfhost.test.ts:48")("on a runtime configured by AGENT_TENANT, a run without a model key also names AGENT_TENANT_API_KEYS", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), { AGENT_TENANTS_FILE: "", AGENT_TENANT: "acme", AGENT_OPERATOR_TOKEN: TOKEN });
  const agent = (await r.call("/v1/agents", { body: {}, token: TOKEN })).json.id;
  const record = await r.prompt(agent, "Hi", TOKEN);
  assert.equal(record.status, "failed");
  assert.equal(record.outcome.result.code, "model_key_missing");
  assert.match(record.error, /PUT \/v1\/providers\/\S+\/key.*AGENT_TENANT_API_KEYS in its environment/);
});

portedTest("selfhost", "tests/selfhost.test.ts:57")("a private runtime names no URL to browsers: AGENT_BROWSER_URL overrides the browser token's url, or empty leaves it out, and links carry their path on the runtime", async t => {
  const hidden = await runtime(t, () => ({ role: "assistant", content: "ok" }), { AGENT_BROWSER_URL: "" });
  const agent = (await hidden.call("/v1/agents", { body: {} })).json.id;
  const minted = (await hidden.call(`/v1/agents/${agent}/browser-tokens`, { body: {} })).json;
  assert.ok(minted.token);
  assert.equal("url" in minted, false);
  const link = (await hidden.call(`/v1/agents/${agent}/links`, { body: { path: "/workspace/a.txt", method: "PUT" } })).json;
  assert.match(link.urlPath, /^\/v1\/links\/[^/]+\/a\.txt$/, "a proxy serves it at its own origin");
  assert.equal(link.url, `https://agents.example.test${link.urlPath}`);

  const proxied = await runtime(t, () => ({ role: "assistant", content: "ok" }), { AGENT_BROWSER_URL: "https://chat.example/agents/" });
  const other = (await proxied.call("/v1/agents", { body: {} })).json.id;
  assert.equal((await proxied.call(`/v1/agents/${other}/browser-tokens`, { body: {} })).json.url, "https://chat.example/agents");
});


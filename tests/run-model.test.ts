import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OPERATOR, runtime, until } from "./runtime-server.ts";
import { anthropic, gateway } from "./provider-fixtures.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("a prompt's model runs its turn on another model of the agent's provider, on the same history; the agent keeps its own", async t => {
  const endpoint = await gateway(t, (_body, index) => anthropic([{ type: "text", text: `answer ${index}` }], "end_turn"));
  const r = await runtime(t, () => ({ role: "assistant", content: "platform model" }), { AGENT_HOSTING: "inline" }, { tenants: {
    alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" }, modelEndpoints: { chiridion: { baseUrl: endpoint.url } } },
  } });
  const created = await r.call("/v1/agents", { body: { model: "chiridion/openrouter/anthropic/claude-sonnet-5" } });
  const agent = created.json.id as string;

  const fast = await r.prompt(agent, "first question", undefined, { model: "chiridion/openrouter/anthropic/claude-sonnet-5:nitro" });
  assert.equal(fast.outcome.result.reply, "answer 0");
  assert.equal(fast.model, "chiridion/openrouter/anthropic/claude-sonnet-5:nitro", "the record says which model it asked for");
  assert.equal(endpoint.requests[0].body.model, "anthropic/claude-sonnet-5:nitro");
  assert.equal((await r.call(`/v1/agents/${agent}`)).json.model, "chiridion/openrouter/anthropic/claude-sonnet-5", "the agent's own model is unchanged");

  // The next prompt, without one, is on the agent's model, and sees the turn before.
  const next = await r.prompt(agent, "second question");
  assert.equal(next.model, undefined);
  assert.equal(endpoint.requests[1].body.model, "anthropic/claude-sonnet-5");
  const said = JSON.stringify(endpoint.requests[1].body.messages);
  assert.match(said, /first question/);
  assert.match(said, /answer 0/);
  // Each turn's metrics are under the model it ran on.
  const lines = () => r.logs.map(line => { try { return JSON.parse(line); } catch { return {}; } }).filter(line => line.type === "turn_metrics");
  await until(() => lines().length >= 2, "two turn_metrics lines");
  assert.deepEqual(lines().map(line => line.Model), ["openrouter/anthropic/claude-sonnet-5:nitro", "openrouter/anthropic/claude-sonnet-5"]);

  // Refused: another provider (its key is not the agent's), an unknown model, a steer, and anyone but the tenant.
  for (const [body, status, error] of [
    [{ text: "x", model: "openrouter/openai/gpt-4o-mini" }, 400, /of its agent's provider \(chiridion\)/],
    [{ text: "x", model: "chiridion/openrouter/no-such/model" }, 400, /Unknown model/],
    [{ text: "x", model: 7 }, 400, /expected string/],
    [{ text: "x", model: "chiridion/openrouter/anthropic/claude-sonnet-5:nitro", whileRunning: "steer" }, 400, /model is for a prompt that starts its own turn/],
  ] as const) {
    const refused = await r.call(`/v1/agents/${agent}/prompt`, { body });
    assert.equal(refused.status, status, `${JSON.stringify(body)}: ${refused.text}`);
    assert.match(refused.text, error);
  }
  const own = await fetch(`${r.base}/clients/${agent}/requests`, {
    method: "POST", headers: { Authorization: `Bearer ${created.json.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "own_1", method: "prompt", params: { text: "x", model: "chiridion/openrouter/anthropic/claude-sonnet-5:nitro" } }),
  });
  assert.equal(own.status, 403);
  assert.match((await own.json()).error, /Only the tenant can choose a run's model/);
  assert.equal(endpoint.requests.length, 2, "no refused prompt reached the model");
});

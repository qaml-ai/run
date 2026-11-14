import assert from "node:assert/strict";
import test from "node:test";
import { Agents } from "../../../clients/agents.ts";
import { fakeModel, free, toolCall, until } from "../../../tests/contract/http.ts";
import { startFixture } from "./fixture.ts";

test("a debit between the two model calls of a turn refuses the second call", { timeout: 90_000 }, async t => {
  const firstCall = Promise.withResolvers<void>();
  t.after(() => firstCall.resolve());
  const model = await fakeModel(t, free((_body, index) => index === 0
    ? { ...toolCall("ls", { path: "/workspace" }), wait: firstCall.promise }
    : { role: "assistant", content: "The second call should have been refused" }));
  const tenant = "provider-balance";
  const fixture = await startFixture({ tenant, vars: { TEST_MODEL: "0", MODEL: "openai/gpt-4o-mini" } });
  t.after(() => fixture.stop());
  const provider = await fetch(fixture.url + "/v1/providers/credit-fixture", {
    method: "PUT",
    headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      type: "openai-completions", baseUrl: model.url,
      models: [{ id: "echo", contextWindow: 32768 }],
    }),
  });
  assert.ok(provider.ok, await provider.text());
  const agents = new Agents({ url: fixture.url, apiKey: fixture.token, connection: "lazy", pollMs: 10 });
  t.after(() => agents.close());
  const agent = await agents.upsert("provider-balance", { model: "credit-fixture/echo", codeMode: false, fileTools: true });
  const run = agent.run("Use the tool and then reply", { timeoutMs: 25_000, throwOnError: false });
  try {
    await until(() => model.bodies.length === 1, "the first call reaches the provider");
    const debit = await fixture.db.query("update credit_accounts set balance=0 where tenant=$1", [tenant]);
    assert.equal(debit.rowCount, 1);
  } finally {
    firstCall.resolve();
  }
  const result = await run;
  assert.equal(result.stoppedReason, "budget_reached", JSON.stringify(result));
  assert.equal(result.limit, "credit");
  assert.equal(result.usage?.responses, 1);
  assert.equal(model.bodies.length, 1);
});

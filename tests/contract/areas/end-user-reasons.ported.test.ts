import { portedTest } from '../ported.ts';
const test = portedTest("credits", "tests/end-user-reasons.test.ts");

import assert from "node:assert/strict";

import { runtime, until } from "../support.ts";

const AT_COST = { AGENT_OPENROUTER_CREDIT_MULTIPLIER: "1", AGENT_MODEL: "openai/gpt-4.1" };

test("a queued run refused as it starts for the agent's spend limit carries spend_limit and which limit", async t => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const r = await runtime(t, (_body: any, index: number) => ({ content: "ok", ...(index === 0 ? { wait: barrier } : {}), usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.1 } }), AT_COST);
  const { id } = (await r.call("/v1/agents", { body: { spendLimit: { usd: 0.05 } } })).json;
  assert.equal((await r.call(`/v1/agents/${id}/prompt`, { body: { text: "one", requestId: "first" } })).status, 202);
  await until(async () => r.model.bodies.length >= 1, "the first call to reach the provider");
  assert.equal((await r.call(`/v1/agents/${id}/prompt`, { body: { text: "two", requestId: "second" } })).status, 202);
  release();
  const record = await until(async () => {
    const value = (await r.call(`/v1/agents/${id}/requests/second`)).json;
    return value.state === "completed" && value;
  }, "the second to end", 30_000);
  assert.deepEqual([record.status, record.outcome.result?.code, record.outcome.result?.limit], ["paused", "spend_limit", "agent"], JSON.stringify(record));
});

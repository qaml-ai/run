import { portedTest } from "../ported.ts";
import assert from "node:assert/strict";
import {fakeModel,runtime} from "../support.ts";
const LOCAL={AGENT_OUTBOUND_ALLOW_HTTP:"true",AGENT_OUTBOUND_ALLOW_CIDRS:"127.0.0.1/32"};
const FLASH_1017="deepseek/deepseek-v4.1-flash-1017";
portedTest("models","tests/added-models.test.ts:62")("an agent on it calls OpenRouter's Chat Completions with the 1017 id and the reasoning it asks for", async t => {
  const model = await fakeModel(t, () => ({ role: "assistant", content: "Snapshot." }));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: model.url } });
  const agent = (await r.call("/v1/agents", { body: { model: `openrouter/${FLASH_1017}`, keyScope: "hosted", thinkingLevel: "high" } })).json.id;
  const done = await r.prompt(agent, "Hi");
  assert.equal(done.outcome.result.reply, "Snapshot.");
  const sent = model.bodies.at(-1)!;
  assert.ok(Array.isArray(sent.messages), "Chat Completions (deepseek-replay.ts)");
  assert.equal(sent.model, FLASH_1017);
  assert.equal(sent.reasoning?.effort, "high");
  assert.deepEqual(sent.provider, { ignore: ["inference-net", "wafer", "relace", "coreweave"] }, "OpenRouter's routing, but never InferenceNet, Wafer, Relace or CoreWeave: no only, order or sort");
  // No more than every host of its full context serves (DeepInfra's, Prime Intellect's and InferenceNet's 131,072).
  const most = sent.max_completion_tokens ?? sent.max_tokens;
  assert.ok(most <= 131_072, String(most));
});

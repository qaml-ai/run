import assert from "node:assert/strict";
import test from "node:test";
import { Agents, schema, tool } from "../../../clients/node.ts";
import { createWorkersFixture } from "../../../tests/contract/fixtures/workers.ts";
import { OPERATOR, toolCall, toolResults } from "../../../tests/contract/http.ts";

test("a synchronous tool may block its SDK event loop within its declared deadline", { timeout: 90_000 }, async t => {
  const runtime = await createWorkersFixture(t, { respond: (body, index) => index === 0
    ? toolCall("blocking", {})
    : { role: "assistant", content: `Tool said ${toolResults(body).at(-1)}` } });
  const agents = new Agents({ url: runtime.base, apiKey: OPERATOR });
  t.after(() => agents.close({ drainMs: 0 }));
  const agent = await agents.upsert("blocking-sdk", { tools: { blocking: tool({
    description: "A synchronous operation", input: schema.Object({}), timeoutMs: 10_000,
    execute: () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_500);
      return "finished";
    },
  }) } });
  const run = await agent.run("run the operation");
  assert.deepEqual(run.toolErrors, []);
  assert.match(run.text, /finished/);
});

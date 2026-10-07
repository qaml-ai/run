import { test } from "node:test";
import assert from "node:assert/strict";
import { executeCode, presentResult } from "../src/codemode.ts";
import { fakeExecutor } from "./fake-executor.ts";

// js_exec behind the CodeExecutor seam: the runtime's side (limits, tool calls, results, failures) with an in-process guest.
const bridge = {
  definitions: [{ name: "add", description: "Adds", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }],
  call: async (_name: string, args: any) => ({ sum: args.a + args.b }),
};

test("an execution runs on the executor it is given: its tool calls, output and value", async () => {
  const executor = fakeExecutor();
  const result = await executeCode({ code: "print adding\ntool add {\"a\":2,\"b\":3}", bridge, pool: executor });
  assert.equal(executor.opened, 1);
  assert.deepEqual(result.output, ["adding", "{\"sum\":5}"]);
  assert.equal(presentResult(result), "Logged:\nadding\n\nReturned:\n{\"sum\":5}");
});

test("an executor's failures and latency reach the caller as the real sandbox's would", async () => {
  await assert.rejects(executeCode({ code: "crash", bridge, pool: fakeExecutor() }), /Codemode sandbox process exited \(SIGKILL\)/);
  await assert.rejects(executeCode({ code: "tool nope {}", bridge, pool: fakeExecutor() }), /Unknown tool/);
  await assert.rejects(executeCode({ code: "return 1", bridge, pool: fakeExecutor({ latencyMs: 500 }), timeoutMs: 50 }), /timed out after 50ms/);
});

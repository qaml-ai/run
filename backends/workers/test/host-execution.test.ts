import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry, type ToolRegistration } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createModels } from "@earendil-works/pi-ai";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { abortHostExecution, executionOutput, executionParams, hostExecutionTool, startHostExecution, waitHostExecution } from "../src/host-execution.ts";

test("host execution uses Pi's durable task, returns raw output and deduplicates request IDs", async () => {
  const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
  let calls = 0;
  const called: ToolRegistration = { name: "echo", description: "Echo", parameters: { type: "object" }, replay: "safe", async execute() { calls++; return { output: [{ type: "text", text: "hello" }] }; } };
  const execute = hostExecutionTool(sandbox), registry = createRegistry();
  registry.install({ name: "host", tools: [execute, called] });
  const pi = await Harness.open(new MemoryStorage(), { registry, models: createModels() }, context);
  try {
    const root = await pi.root(context, { agent: { tools: [called] } });
    const params = { code: 'text("first"); return await tools.echo({})' };
    const task = await startHostExecution(pi, root, "stable", params, execute);
    const repeated = await startHostExecution(pi, root, "stable", params, execute);
    assert.equal(repeated, task);
    assert.deepEqual((await waitHostExecution(pi, task)).output, ["first", "hello"]);
    assert.equal(calls, 1);
    assert.deepEqual((await root.entries({}, 10, undefined, context)).items, []);
    await assert.rejects(startHostExecution(pi, root, "stable", { code: 'return "different"' }, execute), /reused/);
    const failed = await startHostExecution(pi, root, "failed", { code: 'throw new TypeError("bad input")' }, execute);
    assert.deepEqual((await waitHostExecution(pi, failed)).error, { kind: "script", name: "TypeError", message: "bad input" });
    const cancelled = await startHostExecution(pi, root, "cancelled", { code: 'await new Promise(() => {});' }, execute);
    await abortHostExecution(pi, "cancelled");
    assert.equal((await waitHostExecution(pi, cancelled)).error?.kind, "aborted");
  } finally { await pi.close(context); await sandbox.close(); }
});

test("host execution bounds output and validates supplied limits", () => {
  assert.throws(() => executionParams({ code: "", maxOutputCharacters: 128_001 }));
  assert.equal(executionParams({ code: "", timeoutMs: 999_999 }).timeoutMs, 120_000);
  assert.deepEqual(executionOutput({ ok: true, output: [{ type: "text", text: "1234" }], value: "5678", calls: [], storeWrites: { set: {}, delete: [] } }, 6), { output: ["1234", "56"], truncated: true });
});

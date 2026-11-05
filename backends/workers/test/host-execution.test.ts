import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry, type ToolRegistration } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createModels } from "@earendil-works/pi-ai";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { abortHostExecution, admitHostExecution, executionOutput, executionParams, hostExecutionRequest, hostExecutionTool, startHostExecution, waitHostExecution } from "../src/host-execution.ts";
import { AttachedTools } from "../src/attached-tools.ts";
import { answerHuman, HumanInputs } from "../src/human.ts";

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
  assert.equal(executionParams({ code: "" }).timeoutMs, 30_000);
  assert.deepEqual(executionOutput({ ok: true, output: [{ type: "text", text: "1234" }], value: "5678", calls: [], storeWrites: { set: {}, delete: [] } }, 6), { output: ["1234", "56"], truncated: true });
});

test("nested tools identify their own concurrent host request without a model run", async () => {
  const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
  const execute = hostExecutionTool(sandbox), registry = createRegistry();
  let pi: Harness;
  const identify: ToolRegistration = {
    name: "identify", description: "Return the request owning this tool call", parameters: { type: "object" }, replay: "safe",
    async execute(_input, api) {
      return { output: [{ type: "text", text: await hostExecutionRequest(pi, api.conversationId) ?? "missing" }] };
    },
  };
  registry.install({ name: "host", tools: [execute, identify] });
  pi = await Harness.open(new MemoryStorage(), { registry, models: createModels() }, context);
  try {
    const root = await pi.root(context, { agent: { tools: [identify] } });
    assert.equal(await hostExecutionRequest(pi, root.id), undefined);
    const tasks = await Promise.all(["first-script", "second-script"].map(id =>
      startHostExecution(pi, root, id, { code: 'return await tools.identify({})' }, execute)));
    const outcomes = await Promise.all(tasks.map(task => waitHostExecution(pi, task)));
    assert.deepEqual(outcomes.map(result => result.output), [["first-script"], ["second-script"]]);
    assert.deepEqual((await root.entries({}, 10, undefined, context)).items, []);
  } finally { await pi.close(context); await sandbox.close(); }
});

test("attached tools keep identity and the stable call key across a durable approval", async () => {
  const attached = new AttachedTools(), frames: any[] = [];
  const handle = attached.attach(frame => {
    const message = (frame as any).message;
    if (!message.id) return;
    const result = message.method === "initialize" ? {} : frames.push(message) === 1
      ? { resultType: "input_required", inputRequests: { approval: { method: "agent-runtime/approval" } } }
      : { content: [{ type: "text", text: JSON.stringify({ approved: !!message.params._meta["agent-runtime/identity"].approval }) }] };
    queueMicrotask(() => attached.receive({ id: message.id, result }, handle.id));
  });
  handle.start();
  const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() }), execute = hostExecutionTool(sandbox), registry = createRegistry();
  const tools = attached.tools([{ name: "save", inputSchema: { type: "object" } }], async () => ({ claims: { tenant: "tenant", agent: "agent", sub: "subject", act: "actor" } }));
  registry.install({ name: "host", tools: [execute, ...tools] });
  const pi = await Harness.open(new MemoryStorage(), { registry, models: createModels() }, context);
  try {
    const root = await pi.root(context, { agent: { tools } });
    const task = await startHostExecution(pi, root, "approval", { code: 'return await tools.save({})' }, execute), result = waitHostExecution(pi, task);
    let pending: string | undefined;
    for (let attempts = 0; attempts < 100 && !pending; attempts++) {
      pending = Object.keys((await pi.snapshot(HumanInputs, context))?.requests ?? {})[0];
      if (!pending) await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(pending, "approval was recorded durably");
    assert.equal((await pi.snapshot(HumanInputs, context))?.requests[pending].requestId, "approval");
    await pi.commit(async tx => {
      const request = (await tx.doc(HumanInputs)).requests[pending!];
      Object.assign(request, answerHuman(request, { action: "accept", actor: "operator" }));
    }, context);
    const outcome = await result;
    assert.equal(outcome.error, undefined, JSON.stringify(outcome));
    assert.deepEqual(outcome.output, ['{"approved":true}']);
    assert.equal(frames.length, 2);
    assert.match(frames[0].params._meta["agent-runtime/idempotencyKey"], /^[0-9a-f]{32}$/);
    assert.equal(frames[0].params._meta["agent-runtime/idempotencyKey"], frames[1].params._meta["agent-runtime/idempotencyKey"]);
    assert.equal(frames[1].params._meta["agent-runtime/identity"].act, "actor");
  } finally { attached.close(); await pi.close(context); await sandbox.close(); }
});

test("host admission persists identity before dispatch and rejoins after an interrupted acceptance", async () => {
  const values = new Map<string, unknown>();
  let failAcceptance = true, effects = 0, task: number | undefined;
  const storage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put<T>(key: string, value: T) {
      if ((value as any).accepted && failAcceptance) throw new Error("Interrupted after Pi committed");
      values.set(key, structuredClone(value));
    },
  };
  const candidate = { id: "recover", fingerprint: "same", accepted: false, state: "queued" };
  const start = async () => {
    assert.deepEqual(await storage.get("request:recover"), candidate, "identity is durable before dispatch");
    if (task === undefined) { effects++; task = 17; }
    return task;
  };
  await assert.rejects(admitHostExecution(storage, "request:recover", candidate, start), /Interrupted/);
  assert.equal((await storage.get<any>("request:recover")).state, "queued");
  failAcceptance = false;
  const recovered = await admitHostExecution(storage, "request:recover", candidate, start);
  assert.equal(recovered.task, 17);
  assert.equal(recovered.accepted, true);
  assert.equal(effects, 1, "recovery joins the already committed native task");
  assert.deepEqual(await admitHostExecution(storage, "request:recover", candidate, async () => { throw new Error("dispatched twice"); }), recovered);
  await assert.rejects(admitHostExecution(storage, "request:recover", { ...candidate, fingerprint: "different" }, start), /reused/);
});

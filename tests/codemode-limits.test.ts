import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { codeCapacity, CodeGate, executeCode } from "../src/codemode.ts";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { checkable, validateToolCall } from "../src/tool-policy.ts";
import { keywordScores } from "../src/tool-search.ts";
import { codeErrorClass, recordCodeExecution, recordV8Exec, setMetricSink } from "../src/metrics.ts";
import type { ToolBridge } from "../src/protocol.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

// Hard limits on js_exec: nothing a tenant supplies runs on the runtime's thread, every execution's CPU is
// bounded from outside its guest, and one tenant cannot take every sandbox worker on a node. The executions
// run on v8-exec (npm run build:v8-exec); tests/v8-exec.test.ts has its own workings.

const none: ToolBridge = { definitions: [], call: async () => null };

test("a hot loop is stopped at the CPU budget, which time spent waiting on tools does not count against", { timeout: 60_000 }, async t => {
  const started = performance.now();
  await assert.rejects(executeCode({ code: "while (true) {}", bridge: none, timeoutMs: 60_000, limits: { cpuMs: 300 } }), /CPU (or wall-clock )?limit exceeded/);
  assert.ok(performance.now() - started < 1_500);
  // Two seconds of waiting on a tool, a moment of CPU: well within 300 ms of CPU.
  const slow: ToolBridge = { definitions: [{ name: "slow", description: "Waits", parameters: { type: "object" } }], call: () => sleep(2_000).then(() => "done") };
  assert.deepEqual((await executeCode({ code: "return await tools.slow({})", bridge: slow, limits: { cpuMs: 300 } })).output, ["done"]);
});

test("a tenant's longest timeoutMs cuts a longer one, and its timeout says so", async t => {
  const hang: ToolBridge = { definitions: [{ name: "hang", description: "Never answers", parameters: { type: "object" } }], call: (_name, _args, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) };
  // Warm first, so a slow machine's worker start does not take the whole deadline before the tool is called.
  await executeCode({ code: "return 1", bridge: hang });
  const started = performance.now();
  await assert.rejects(executeCode({ code: "await tools.hang({})", bridge: hang, timeoutMs: 120_000, limits: { maxTimeoutMs: 1_500 } }), /timed out after 1500ms while tools\.hang was still running; external side effects may have completed$/);
  assert.ok(performance.now() - started < 4_000);
  await assert.rejects(executeCode({ code: "await tools.hang({})", bridge: hang, timeoutMs: 1_000, limits: { maxTimeoutMs: 1_500 } }), /Pass a larger timeoutMs \(at most 1500\)/);
});

test("the gate admits each tenant up to its own limit, and waiting tenants in turn", async () => {
  const gate = new CodeGate(3);
  const never = new AbortController().signal;
  const a1 = await gate.acquire("a", 2, never);
  const a2 = await gate.acquire("a", 2, never);
  const order: string[] = [];
  const a3 = gate.acquire("a", 2, never).then(release => { order.push("a3"); return release; });
  // Tenant a is at its limit, but b is not held back by it.
  const b1 = await gate.acquire("b", 2, never);
  assert.equal(gate.running, 3);
  const b2 = gate.acquire("b", 2, never).then(release => { order.push("b2"); return release; });
  const c1 = gate.acquire("c", 2, never).then(release => { order.push("c1"); return release; });
  // A waiter that gives up leaves no trace.
  const gaveUp = new AbortController();
  const cancelled = gate.acquire("d", 2, gaveUp.signal);
  gaveUp.abort(new Error("gave up"));
  await assert.rejects(cancelled, /gave up/);
  a1();
  a1();
  await sleep(0);
  // The node was full: the slot a gave back goes to the first waiting tenant, a, which then goes last.
  assert.deepEqual(order, ["a3"]);
  b1();
  await sleep(0);
  assert.deepEqual(order, ["a3", "b2"]);
  a2();
  await sleep(0);
  assert.deepEqual(order, ["a3", "b2", "c1"]);
  for (const release of await Promise.all([a3, b2, c1])) release();
  assert.equal(gate.running, 0);
  // A tenant without a limit (an admin tenant) is admitted at once even when the node is full, and takes no slot.
  const full = await Promise.all([gate.acquire("b", 3, never), gate.acquire("b", 3, never), gate.acquire("b", 3, never)]);
  const admin = await Promise.all(Array.from({ length: 12 }, () => gate.acquire("chiridion", Infinity, never)));
  assert.equal(gate.running, 3);
  for (const release of [...full, ...admin]) release();
  assert.equal(gate.running, 0);
  assert.equal(gate.count("a"), 0);
});

test("one tenant saturating its executions on a node does not stop another's", { timeout: 30_000 }, async t => {
  const gate = new CodeGate(4);
  const release = Promise.withResolvers<void>();
  const hang: ToolBridge = { definitions: [{ name: "hang", description: "Blocks until released", parameters: { type: "object" } }], call: () => release.promise.then(() => "released") };
  const run = (tenant: string, code: string, timeoutMs = 10_000) => executeCode({ code, bridge: hang, timeoutMs, admit: signal => gate.acquire(tenant, 2, signal) });
  const held = [run("a", "return await tools.hang({})"), run("a", "return await tools.hang({})")];
  await sleep(200);
  // Tenant a's third waits for its turn (and times out waiting); tenant b runs at once.
  await assert.rejects(run("a", "return 1", 500), /timed out after 500ms waiting for a sandbox worker/);
  assert.deepEqual((await run("b", "return 2")).output, ["2"]);
  release.resolve();
  assert.deepEqual((await Promise.all(held)).map(result => result.output), [["released"], ["released"]]);
  assert.equal(gate.running, 0);
});

test("tenants with a limit share 16 executions at once on a node, or AGENT_CODE_WORKERS_MAX", () => {
  const configured = process.env.AGENT_CODE_WORKERS_MAX;
  try {
    delete process.env.AGENT_CODE_WORKERS_MAX;
    assert.equal(codeCapacity(), 16);
    for (const [value, capacity] of [["4", 4], ["40", 40], ["", 16]] as const) {
      process.env.AGENT_CODE_WORKERS_MAX = value;
      assert.equal(codeCapacity(), capacity);
    }
  } finally {
    if (configured === undefined) delete process.env.AGENT_CODE_WORKERS_MAX; else process.env.AGENT_CODE_WORKERS_MAX = configured;
  }
});

test("host-side checks of guest input stay linear: tenant regexes are not run, and large inputs get no quadratic work", () => {
  const definitions = [{
    name: "lookup", description: "Finds a record",
    parameters: { type: "object", properties: { key: { type: "string", pattern: "^(a+)+$" }, pattern: { type: "string" }, tags: { type: "array", uniqueItems: true } }, patternProperties: { "^(x+)+$": { type: "number" } }, additionalProperties: false },
  }];
  let started = performance.now();
  // Backtracking ^(a+)+$ against 40 characters would take hours.
  assert.equal(validateToolCall(definitions, "lookup", { key: `${"a".repeat(40)}!`, xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: 1 }).tool.name, "lookup");
  // A property named "pattern" is still a property.
  assert.throws(() => validateToolCall(definitions, "lookup", { pattern: 1 }), /pattern/);
  // Many duplicates in a large array: typebox's account of them is quadratic, so only the signature is given.
  assert.throws(() => validateToolCall(definitions, "lookup", { tags: new Array(60_000).fill(0) }), /^Error: Invalid arguments for tool: lookup\. It takes/);
  assert.ok(performance.now() - started < 1_000, `${Math.round(performance.now() - started)} ms`);
  assert.deepEqual(checkable({ type: "object", properties: { pattern: { type: "string", pattern: "x" } }, const: { pattern: "kept" } }), { type: "object", properties: { pattern: { type: "string" } }, const: { pattern: "kept" } });

  started = performance.now();
  const tools = Array.from({ length: 4096 }, (_, i) => ({ name: `ns__tool_${i}`, description: `Tool number ${i} does things with records and files` }));
  keywordScores(tools, Array.from({ length: 20_000 }, (_, i) => `word${i}`).join(" "));
  assert.ok(performance.now() - started < 2_000, `search: ${Math.round(performance.now() - started)} ms`);
});

test("an agent process that stops answering is killed, and its turn is closed on restart", { timeout: 60_000, skip: (process.env.AGENT_HOSTING ?? "process") !== "process" && "agent processes only" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "camelai-watchdog-test-"));
  const supervisor = new AgentSupervisor(join(root, "sessions"), { runtime: process.env.AGENT_RUNTIME, hosting: "process" as Hosting, pingMs: 50, unresponsiveMs: 500 });
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  let requests = 0;
  const requested = Promise.withResolvers<void>();
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    requests++;
    requested.resolve();
    if (requests === 1) return; // Stalls: the turn is open when the process freezes.
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Back." }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const model = {
    id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024,
  } as Model<Api>;
  const bridge: ToolBridge = { definitions: [], call: async () => null };
  await supervisor.start("frozen", { model, apiKey: "fixture" }, bridge);
  const running = supervisor.request("frozen", "prompt", { text: "Interrupted" });
  const rejected = assert.rejects(running, /exited|stopped/);
  await requested.promise;
  const handle = supervisor.agents.get("frozen") as { child: { pid: number } };
  // Stuck as if in something synchronous: it answers no ping.
  process.kill(handle.child.pid, "SIGSTOP");
  const stopped = performance.now();
  await rejected;
  assert.ok(performance.now() - stopped < 3_000);
  assert.equal(supervisor.agents.has("frozen"), false);
  await supervisor.stop("frozen");
  assert.throws(() => process.kill(handle.child.pid, 0), { code: "ESRCH" });
  const restarted = await supervisor.start("frozen", { model, apiKey: "fixture" }, bridge);
  assert.equal(restarted.recovered, true);
  assert.match((await supervisor.request("frozen", "history")).messages.at(-1).content, /interrupted by a restart/);
  assert.equal((await supervisor.request("frozen", "prompt", { text: "Carry on" })).error, null);
});

test("each execution writes a metric line with its duration, CPU and timeoutMs, and failures name the limit that stopped them", async t => {
  const lines: any[] = [];
  setMetricSink(line => lines.push(JSON.parse(line)));
  t.after(() => setMetricSink());
  recordCodeExecution({ tenant: "acme", ms: 1234, requestedTimeoutMs: 120_000, timeoutMs: 60_000, cpuMs: 12 });
  recordCodeExecution({ tenant: "acme", ms: 2300, timeoutMs: 30_000, error: new Error("Codemode CPU limit exceeded: the execution kept its thread busy for over 2000 ms") });
  recordV8Exec({ event: "killed", signal: "SIGSYS" });
  assert.deepEqual(lines.map(({ _aws, ...line }) => line), [
    { type: "code_execution", tenant: "acme", timeoutMs: 60_000, requestedTimeoutMs: 120_000, ErrorClass: "none", Engine: "v8", CodeExecutions: 1, CodeDurationMs: 1234, CodeCpuMs: 12 },
    { type: "code_execution", tenant: "acme", timeoutMs: 30_000, ErrorClass: "cpu_limit", Engine: "v8", CodeExecutions: 1, CodeDurationMs: 2300 },
    { type: "v8_exec", signal: "SIGSYS", Event: "killed", V8ExecFailures: 1 },
  ]);
  for (const [message, expected] of [
    ["Codemode timed out after 500ms waiting for a sandbox worker (all 4 busy)", "timeout_waiting_worker"],
    ["Codemode timed out after 30000ms while tools.camel__analysis_exec was still running; external side effects may have completed", "timeout_tool"],
    ["Codemode CPU or wall-clock limit exceeded", "guest_limit"],
    ["Codemode worker exited", "worker_exited"],
    ["Codemode memory limit exceeded", "memory_limit"],
    ["RangeError: Array buffer allocation failed", "memory_limit"],
    ["Codemode sandbox process exited (SIGSYS: a system call outside its seccomp allowlist)", "sandbox_seccomp"],
    ["Codemode sandbox process exited (SIGXCPU: a resource limit)", "sandbox_rlimit"],
    ["Codemode sandbox process exited (SIGKILL)", "worker_exited"],
    ["Codemode sandbox process could not start (ENOENT)", "spawn_failed"],
    ["Error: file not found: /workspace/x.csv", "guest_error"],
  ]) assert.equal(codeErrorClass(message), expected, message);
});

test("an admin tenant's executions waiting on slow tools are not held to the node's memory-sized capacity", { timeout: 30_000 }, async t => {
  const gate = new CodeGate(2);
  const release = Promise.withResolvers<void>();
  let waiting = 0;
  const all = Promise.withResolvers<void>();
  const slow: ToolBridge = { definitions: [{ name: "analysis", description: "Slow", parameters: { type: "object" } }], call: () => { if (++waiting === 12) all.resolve(); return release.promise.then(() => "done"); } };
  const runs = Array.from({ length: 12 }, () => executeCode({ code: "return await tools.analysis({})", bridge: slow, timeoutMs: 20_000, admit: signal => gate.acquire("chiridion-prod", Infinity, signal) }));
  // All twelve wait on their tool at once, each holding a worker; a capped tenant still gets the gate's slots.
  await all.promise;
  assert.deepEqual((await executeCode({ code: "return 3", bridge: slow, admit: signal => gate.acquire("acme", 4, signal) })).output, ["3"]);
  release.resolve();
  assert.equal((await Promise.all(runs)).length, 12);
});

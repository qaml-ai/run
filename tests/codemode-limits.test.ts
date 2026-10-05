import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { CodeGate, CodePool, defaultCodeWorkers, executeCode } from "../src/codemode.ts";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { checkable, validateToolCall } from "../src/tool-policy.ts";
import { keywordScores } from "../src/tool-search.ts";
import { prepareCodeModeUserCode } from "../shared/code-mode-source.ts";
import { codeErrorClass, recordCodeExecution, setMetricSink } from "../src/metrics.ts";
import type { ToolBridge } from "../src/protocol.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

// Hard limits on js_exec: nothing a tenant supplies runs on the runtime's thread, every execution's CPU is
// bounded from outside its guest, and one tenant cannot take every sandbox worker on a node.

const none: ToolBridge = { definitions: [], call: async () => null };
/** Sucrase backtracks exponentially on this: about a second at 19 levels, doubling with each. */
const sucraseBomb = (levels: number) => `1<2; x = ${"a ? (b): c => ".repeat(levels)}d`;

/** The longest the runtime's thread went without running a 10 ms timer while `work` ran. */
async function longestStall(work: () => Promise<unknown>) {
  let last = performance.now(), longest = 0;
  const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 10);
  try { await work(); } finally { clearInterval(timer); }
  return Math.max(longest, performance.now() - last);
}

test("hostile TypeScript is stripped in the worker under the CPU budget: the runtime's thread never stalls, and abort works", { timeout: 60_000 }, async t => {
  const pool = new CodePool({ min: 1, max: 2 });
  t.after(() => pool.close());
  // Warm: the first execution loads tool policy on this thread.
  assert.deepEqual((await executeCode({ code: "const n: number = 1; return n", bridge: none, pool })).output, ["1"]);
  let error: Error | undefined;
  const started = performance.now();
  const stall = await longestStall(() => executeCode({ code: sucraseBomb(30), bridge: none, pool, timeoutMs: 60_000 }).catch(caught => { error = caught; }));
  assert.match(String(error?.message), /CPU limit exceeded/);
  assert.ok(performance.now() - started < 4_000, `stopped at its 2 s budget, not hours later (${Math.round(performance.now() - started)} ms)`);
  assert.ok(stall < 200, `the runtime's thread kept running (longest stall ${Math.round(stall)} ms)`);

  // Cancelled while the worker is deep in sucrase, the execution ends at once.
  const controller = new AbortController();
  const running = executeCode({ code: sucraseBomb(30), bridge: none, pool, signal: controller.signal, timeoutMs: 60_000 });
  await sleep(300);
  const aborted = performance.now();
  controller.abort();
  await assert.rejects(running, /aborted/);
  assert.ok(performance.now() - aborted < 100);
  // And the pool serves the next one.
  assert.deepEqual((await executeCode({ code: "const f = <T,>(x: T) => x; return f<number>(2)", bridge: none, pool })).output, ["2"]);
});

test("built-ins QuickJS cannot interrupt are stopped at the CPU budget, not the wall-clock timeout", { timeout: 60_000 }, async t => {
  const pool = new CodePool({ min: 1, max: 1 });
  t.after(() => pool.close());
  for (const [code, cpuMs] of [['return "a".repeat(2e6).indexOf("a".repeat(1e6) + "b")', 1_000], ['return BigInt("9".repeat(300000)).toString().length', 500]] as const) {
    const started = performance.now();
    await assert.rejects(executeCode({ code, bridge: none, pool, timeoutMs: 60_000, limits: { cpuMs } }), new RegExp(`CPU limit exceeded: the execution kept its thread busy for over ${cpuMs} ms`));
    const took = performance.now() - started;
    assert.ok(took >= cpuMs && took < cpuMs + 1_500, `${code}: ${Math.round(took)} ms`);
  }
  assert.deepEqual((await executeCode({ code: "return 1", bridge: none, pool })).output, ["1"]);
});

test("a hot loop is stopped at the CPU budget, which time spent waiting on tools does not count against", { timeout: 60_000 }, async t => {
  const pool = new CodePool({ min: 1, max: 1 });
  t.after(() => pool.close());
  const started = performance.now();
  await assert.rejects(executeCode({ code: "while (true) {}", bridge: none, pool, timeoutMs: 60_000, limits: { cpuMs: 300 } }), /CPU (or wall-clock )?limit exceeded/);
  assert.ok(performance.now() - started < 1_500);
  // Two seconds of waiting on a tool, a moment of CPU: well within 300 ms of CPU.
  const slow: ToolBridge = { definitions: [{ name: "slow", description: "Waits", parameters: { type: "object" } }], call: () => sleep(2_000).then(() => "done") };
  assert.deepEqual((await executeCode({ code: "return await tools.slow({})", bridge: slow, pool, limits: { cpuMs: 300 } })).output, ["done"]);
});

test("a tenant's longest timeoutMs cuts a longer one, and its timeout says so", async t => {
  const pool = new CodePool({ min: 1, max: 1 });
  t.after(() => pool.close());
  const hang: ToolBridge = { definitions: [{ name: "hang", description: "Never answers", parameters: { type: "object" } }], call: (_name, _args, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) };
  const started = performance.now();
  await assert.rejects(executeCode({ code: "await tools.hang({})", bridge: hang, pool, timeoutMs: 120_000, limits: { maxTimeoutMs: 300 } }), /timed out after 300ms while tools\.hang was still running; external side effects may have completed$/);
  assert.ok(performance.now() - started < 1_500);
  await assert.rejects(executeCode({ code: "await tools.hang({})", bridge: hang, pool, timeoutMs: 200, limits: { maxTimeoutMs: 300 } }), /Pass a larger timeoutMs \(at most 300\)/);
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
  assert.equal(gate.count("a"), 0);
});

test("one tenant saturating its executions on a node does not stop another's", { timeout: 30_000 }, async t => {
  const pool = new CodePool({ min: 2, max: 4 });
  t.after(() => pool.close());
  const gate = new CodeGate(4);
  const release = Promise.withResolvers<void>();
  const hang: ToolBridge = { definitions: [{ name: "hang", description: "Blocks until released", parameters: { type: "object" } }], call: () => release.promise.then(() => "released") };
  const run = (tenant: string, code: string, timeoutMs = 10_000) => executeCode({ code, bridge: hang, pool, timeoutMs, admit: signal => gate.acquire(tenant, 2, signal) });
  const held = [run("a", "return await tools.hang({})"), run("a", "return await tools.hang({})")];
  await sleep(200);
  // Tenant a's third waits for its turn (and times out waiting); tenant b runs at once.
  await assert.rejects(run("a", "return 1", 500), /timed out after 500ms waiting for a sandbox worker/);
  assert.deepEqual((await run("b", "return 2")).output, ["2"]);
  release.resolve();
  assert.deepEqual((await Promise.all(held)).map(result => result.output), [["released"], ["released"]]);
  assert.equal(gate.running, 0);
});

test("the pool is sized from memory, so a full pool cannot run a task out of it", () => {
  assert.equal(defaultCodeWorkers(2 * 1024 ** 3), 6);
  assert.equal(defaultCodeWorkers(512 * 1024 ** 2), 2);
  assert.equal(defaultCodeWorkers(64 * 1024 ** 3), 32);
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

  started = performance.now();
  assert.equal(prepareCodeModeUserCode(`1${" ".repeat(64 * 1024)}x`.replace("x", "")).startsWith("return 1"), true);
  assert.ok(performance.now() - started < 100, `trailing whitespace: ${Math.round(performance.now() - started)} ms`);
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
  assert.deepEqual(lines.map(({ _aws, ...line }) => line), [
    { type: "code_execution", tenant: "acme", timeoutMs: 60_000, requestedTimeoutMs: 120_000, ErrorClass: "none", CodeExecutions: 1, CodeDurationMs: 1234, CodeCpuMs: 12 },
    { type: "code_execution", tenant: "acme", timeoutMs: 30_000, ErrorClass: "cpu_limit", CodeExecutions: 1, CodeDurationMs: 2300 },
  ]);
  for (const [message, expected] of [
    ["Codemode timed out after 500ms waiting for a sandbox worker (all 4 busy)", "timeout_waiting_worker"],
    ["Codemode timed out after 30000ms while tools.camel__analysis_exec was still running; external side effects may have completed", "timeout_tool"],
    ["Codemode CPU or wall-clock limit exceeded", "guest_limit"],
    ["Codemode worker exited", "worker_exited"],
    ["Error: file not found: /workspace/x.csv", "guest_error"],
  ]) assert.equal(codeErrorClass(message), expected, message);
});

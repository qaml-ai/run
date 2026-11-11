import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { RemoteCodemodeSandbox, serveCodemodeRemote, type CodemodeRemote } from "@earendil-works/pi-codemode/portable";
import { SANDBOX_LIMITS } from "../../../src/limits.ts";
import { CODE_MODE_EXCHANGE, EXCHANGE_CEILINGS, SANDBOX_HEAP_BYTES, type ExchangeParameters, type ExchangeRequest } from "../codemode/exchange.ts";
import { serveExchange, SANDBOX_INTERRUPT_BUDGET } from "../codemode/limits.ts";
import { hostExchange, isolatedSandboxRemote, type KeepResult } from "../codemode/routing.ts";

const wasm = loadQuickJSWasm();

/** The sandbox Worker as deployed: `CodemodeSandbox.execute` minus the Durable Object. */
const sandboxWorker = (seen?: unknown[][]): CodemodeRemote => ({
  execute: async (request, exchange) => serveExchange(request, seen ? async messages => { seen.push(messages); return exchange(messages); } : exchange,
    async (served, bounded) => serveCodemodeRemote(served, bounded, { wasm: await wasm, maxInterruptBudget: EXCHANGE_CEILINGS.interruptBudget, maxMemoryLimitBytes: SANDBOX_HEAP_BYTES })),
});
/** The sandbox Worker from before protocol 2 (mid-rollout): it ignores `exchange` and serves code mode's caps. */
const protocolOneWorker = (): CodemodeRemote => ({
  execute: (request, exchange) => sandboxWorker().execute({ ...request, exchange: undefined } as ExchangeRequest, exchange),
});

type Tool = { name: string; execute: (args: unknown) => Promise<unknown> };
const echo: Tool = { name: "echo", execute: async args => args };

/** One script through the agent Worker's routing (protocol 2) to `worker`. */
async function run(code: string, parameters: ExchangeParameters, options: { worker?: CodemodeRemote; tools?: Tool[]; keep?: KeepResult } = {}) {
  const sandbox = new RemoteCodemodeSandbox({
    tools: (options.tools ?? [echo]) as never,
    remote: isolatedSandboxRemote({ agentKey: "session", exchange: parameters, keep: options.keep, getByName: () => options.worker ?? sandboxWorker() }),
  });
  try { return await sandbox.execute(code); } finally { await sandbox.close(); }
}
/** One script sent straight to `worker` as an agent Worker from before protocol 2 sent it: no `exchange`. */
async function runProtocolOne(code: string, tools: Tool[] = [echo]) {
  const sandbox = new RemoteCodemodeSandbox({ tools: tools as never, remote: sandboxWorker });
  try { return await sandbox.execute(code); } finally { await sandbox.close(); }
}
const caps = (changes: Partial<ExchangeParameters["caps"]>, results: ExchangeParameters["results"] = "inline"): ExchangeParameters =>
  ({ ...CODE_MODE_EXCHANGE, caps: { ...CODE_MODE_EXCHANGE.caps, ...changes }, results });
const shape = (result: Awaited<ReturnType<typeof run>>) => result.ok ? { ok: true, value: result.value } : { ok: false, kind: result.error.kind, message: result.error.message };

test("code mode's exchange is exactly the caps the sandbox fixed before they were parameters", () => {
  assert.deepEqual(CODE_MODE_EXCHANGE, {
    protocol: 2, results: "inline",
    caps: { calls: 256, inFlight: 32, argumentBytes: 128 * 1024, resultBytes: 1024 * 1024 - 1024, totalResultBytes: 8 * 1024 * 1024, interruptBudget: 10_000 },
  });
  assert.equal(SANDBOX_INTERRUPT_BUDGET, 10_000);
  assert.equal(SANDBOX_LIMITS.toolCalls, 256);
});

test("code mode behaves the same over protocol 2 as an agent Worker from before it got over protocol 1", { timeout: 60_000 }, async () => {
  const big: Tool = { name: "big", execute: async args => "x".repeat((args as { n: number }).n) };
  const cases = [
    "return 6 * 7",
    // The 257th call ends the script.
    "for (let i = 0; i < 300; i++) await tools.echo({ i }); return 'unreachable'",
    // 40 at once wait their turn past 32.
    "return (await Promise.all(Array.from({ length: 40 }, (_, i) => tools.echo({ i })))).length",
    // One result over the per-call cap fails that call; 9 results of 1 MiB - 2 KiB exceed 8 MiB in all.
    "try { await tools.big({ n: 1024 * 1024 }) } catch (error) { return String(error) }",
    "let last; for (let i = 0; i < 9; i++) { try { await tools.big({ n: 1024 * 1024 - 2048 }) } catch (error) { last = String(error) } } return last",
    `await tools.echo({ s: "${"y".repeat(128 * 1024)}" })`,
    "while (true) {}",
  ];
  for (const code of cases) {
    const now = shape(await run(code, CODE_MODE_EXCHANGE, { tools: [echo, big] }));
    const before = shape(await runProtocolOne(code, [echo, big]));
    assert.deepEqual(now, before, code.slice(0, 60));
  }
  // And the cases mean what they say.
  assert.equal(shape(await run(cases[1]!, CODE_MODE_EXCHANGE)).message, "Pi tool call limit or invalid call id");
  assert.equal(shape(await run(cases[2]!, CODE_MODE_EXCHANGE)).value, 40);
  assert.match(String(shape(await run(cases[3]!, CODE_MODE_EXCHANGE, { tools: [big] })).value), /a script gets at most 1,047,552 from one call/);
  assert.match(String(shape(await run(cases[4]!, CODE_MODE_EXCHANGE, { tools: [big] })).value), /more than 8,388,608 bytes in all/);
  assert.match(String(shape(await run(cases[6]!, CODE_MODE_EXCHANGE)).message), /interrupt budget of 10000/);
});

test("a protocol 2 exchange opens with the sandbox's hello, which the host drops; protocol 1 has none", { timeout: 20_000 }, async () => {
  const seen: unknown[][] = [];
  assert.deepEqual(shape(await run("return await tools.echo({ a: 1 })", CODE_MODE_EXCHANGE, { worker: sandboxWorker(seen) })), { ok: true, value: { a: 1 } });
  assert.deepEqual(seen[0]![0], { type: "exchange", protocol: 2 });
  assert.equal(seen.flat().filter(message => (message as { type: string }).type === "exchange").length, 1);
  const old: unknown[][] = [];
  const sandbox = new RemoteCodemodeSandbox({ tools: [echo] as never, remote: () => sandboxWorker(old) });
  try { assert.equal((await sandbox.execute("return 1")).ok, true); } finally { await sandbox.close(); }
  assert.equal(old.flat().some(message => (message as { type: string }).type === "exchange"), false);
});

test("a caller's caps are what the sandbox enforces", { timeout: 30_000 }, async () => {
  assert.equal(shape(await run("for (let i = 0; i < 4; i++) await tools.echo({ i })", caps({ calls: 3 }))).message, "Pi tool call limit or invalid call id");
  assert.equal(shape(await run("for (let i = 0; i < 3; i++) await tools.echo({ i }); return 'ok'", caps({ calls: 3 }))).value, "ok");
  let out = 0, most = 0;
  const slow: Tool = { name: "slow", execute: async () => { most = Math.max(most, ++out); await new Promise(resolve => setTimeout(resolve, 5)); out--; return 1; } };
  assert.equal(shape(await run("return (await Promise.all(Array.from({ length: 10 }, () => tools.slow({})))).length", caps({ inFlight: 2 }), { tools: [slow] })).value, 10);
  assert.equal(most, 2);
  assert.match(String(shape(await run("try { await tools.echo({ s: 'x'.repeat(200) }) } catch (error) { return String(error) }", caps({ resultBytes: 100 }))).value), /at most 100 from one call/);
  assert.equal(shape(await run("await tools.echo({ s: 'x'.repeat(200) })", caps({ argumentBytes: 100 }))).message, "Pi call arguments exceed limit");
  assert.match(String(shape(await run("while (true) {}", caps({ interruptBudget: 500 }))).message), /interrupt budget of 500\b/);
});

test("an exchange the sandbox cannot serve fails clearly, before a VM starts", { timeout: 20_000 }, async () => {
  // Past the ceilings, or another protocol: the agent Worker refuses to open it at all.
  assert.throws(() => isolatedSandboxRemote({ agentKey: "s", exchange: caps({ calls: EXCHANGE_CEILINGS.calls + 1 }), getByName: sandboxWorker }), /caps\.calls must be an integer from 1 to 10000/);
  assert.throws(() => isolatedSandboxRemote({ agentKey: "s", exchange: caps({ interruptBudget: 10_001 }), getByName: sandboxWorker }), /caps\.interruptBudget/);
  assert.throws(() => isolatedSandboxRemote({ agentKey: "s", exchange: caps({}, "handle"), getByName: sandboxWorker }), /needs keep/);
  // An agent Worker a version ahead of the sandbox: the sandbox refuses the request, naming both.
  let started = 0;
  const counting: CodemodeRemote = { execute: (request, exchange) => serveExchange(request, exchange, async () => { started++; }) };
  const ahead = new RemoteCodemodeSandbox({ tools: [], remote: () => ({ execute: (request, exchange) => counting.execute({ ...request, exchange: { ...CODE_MODE_EXCHANGE, protocol: 3 } } as never, exchange) }) });
  try {
    const result = await ahead.execute("return 1");
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error.message, /^Remote sandbox failed: Code mode exchange: protocol 3 is not 2, the one this sandbox speaks; the agent and sandbox Workers run different versions/);
  } finally { await ahead.close(); }
  assert.equal(started, 0);
});

test("mid-rollout, a protocol 1 sandbox still serves code mode, and refuses any other exchange clearly", { timeout: 20_000 }, async () => {
  assert.deepEqual(shape(await run("return await tools.echo({ a: 1 })", CODE_MODE_EXCHANGE, { worker: protocolOneWorker() })), { ok: true, value: { a: 1 } });
  for (const parameters of [caps({ calls: 2_000 }), caps({ resultBytes: 8192 }, "handle")]) {
    const result = shape(await run("return await tools.echo({ a: 1 })", parameters, { worker: protocolOneWorker(), keep: () => "kept" }));
    assert.equal(result.ok, false);
    assert.equal(result.message, "Remote sandbox failed: The sandbox speaks code mode exchange protocol 1, not 2: the agent and sandbox Workers run different versions.");
  }
  // A sandbox a version ahead (rolled back agent Worker): its hello names its protocol.
  const host = hostExchange(CODE_MODE_EXCHANGE, async () => { throw new Error("must not reach Pi"); });
  assert.deepEqual(await host.exchange([{ type: "exchange", protocol: 3 } as never, { type: "call", id: 1, target: "tool", name: "echo", args: "{}" }]), { type: "stop" });
  assert.match(host.refused() ?? "", /protocol 3, not 2/);
});

test("a handle exchange keeps result bodies over its result cap on the host; the guest gets a handle", { timeout: 20_000 }, async () => {
  const body = { rows: Array.from({ length: 2_000 }, (_, i) => ({ i, text: `row ${i}` })) };
  const json = JSON.stringify(body);
  const kept = new Map<string, string>();
  const keep: KeepResult = (text, call) => { const ref = `wf/results/${call.name}/${call.id}`; kept.set(ref, text); return ref; };
  const tools: Tool[] = [echo, { name: "rows", execute: async () => body }];
  const result = shape(await run("const small = await tools.echo({ a: 1 }); const large = await tools.rows({}); return { small, large }", caps({ resultBytes: 8192 }, "handle"), { tools, keep }));
  assert.deepEqual(result, {
    ok: true,
    value: { small: { a: 1 }, large: { $handle: "wf/results/rows/2", bytes: Buffer.byteLength(json), sha256: createHash("sha256").update(json).digest("hex") } },
  });
  assert.deepEqual(JSON.parse(kept.get("wf/results/rows/2")!), body);
  assert.equal(kept.size, 1, "a body within the cap stays inline");
  // The same call inline is refused, as code mode refuses it.
  assert.match(String(shape(await run("try { await tools.rows({}) } catch (error) { return String(error) }", caps({ resultBytes: 8192 }), { tools })).value), /at most 8,192 from one call/);
});

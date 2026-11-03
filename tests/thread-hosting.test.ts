import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import type { ToolBridge } from "../src/protocol.ts";
import type { RequestMethod } from "../shared/client-protocol.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { supervisorMessages } from "./fixtures/journal-messages.ts";

// AGENT_HOSTING=thread: each agent is a worker thread of the server process. One that runs out of heap, loops, or
// crashes ends alone, as an agent process does, and the agents beside it go on answering. The faults come from
// tests/fixtures/misbehaving-agent.ts, the real host with a way to misbehave.

const ENTRY = "../tests/fixtures/misbehaving-agent.ts";

/** A model that answers "Hi." to each request, or holds the requests `stall` picks open (a turn in flight). */
async function modelServer(t: { after: (fn: () => Promise<void>) => void }, stall: (request: number) => boolean = () => false) {
  let requests = 0;
  const requested = Promise.withResolvers<void>();
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    requested.resolve();
    if (stall(++requests)) return;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Hi." }, finish_reason: null }] })}\n\n`);
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
  return { model, requested: requested.promise };
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, hosting: Hosting, options: { stall?: (request: number) => boolean; heapMb?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "camelai-thread-hosting-test-"));
  const supervisor = new AgentSupervisor(join(root, "sessions"), {
    hosting, entry: ENTRY, pingMs: 50, unresponsiveMs: 500, maxAgents: 8,
    ...(options.heapMb ? { threadLimits: { maxOldGenerationSizeMb: options.heapMb } } : {}),
  });
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const { model, requested } = await modelServer(t, options.stall);
  const bridge = (): ToolBridge => ({ definitions: [], call: async () => null });
  const start = (id: string) => supervisor.start(id, { model, apiKey: "fixture" }, bridge());
  const fault = (id: string, kind: "spin" | "grow" | "crash") => supervisor.request(id, kind as RequestMethod);
  const reply = async (id: string) => {
    const result = await supervisor.request(id, "prompt", { text: "Hello" });
    assert.equal(result.error, null);
    return result;
  };
  return { supervisor, start, fault, reply, requested };
}

test("thread hosting: an agent past its heap limit ends alone; the others answer and it starts again", { timeout: 60_000 }, async t => {
  const { supervisor, start, fault, reply } = await fixture(t, "thread", { heapMb: 64 });
  await Promise.all(["a", "b", "c"].map(start));
  const before = process.memoryUsage().heapUsed;
  await assert.rejects(fault("a", "grow"), /memory limit|Thread exited/);
  assert.equal(supervisor.agents.has("a"), false);
  // The heap it filled was its thread's, and went with it.
  assert.ok(process.memoryUsage().heapUsed - before < 32 * 1024 * 1024);
  await Promise.all(["b", "c"].map(reply));
  assert.equal((await start("a")).recovered, false);
  await reply("a");
});

for (const hosting of ["thread", "process"] as const) {
  test(`${hosting} hosting: an agent stuck in a loop is ended by the watchdog without holding up the node, and its turn closes on restart`, { timeout: 60_000 }, async t => {
    const { supervisor, start, fault, reply, requested } = await fixture(t, hosting, { stall: request => request === 1 });
    await Promise.all(["a", "b"].map(start));
    // A turn in flight when it gets stuck: the model's first request stays open.
    const turn = supervisor.request("a", "prompt", { text: "Interrupted" });
    const failed = assert.rejects(turn, /stopped|exited/);
    await requested;
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    void fault("a", "spin").catch(() => {});
    const stuck = performance.now();
    // The other agent answers while it spins, and the server's own loop stays responsive.
    await reply("b");
    await failed;
    assert.ok(performance.now() - stuck < 5_000);
    delay.disable();
    assert.ok(delay.max < 200e6, `event loop delay ${delay.max / 1e6} ms`);
    assert.equal(supervisor.agents.has("a"), false);
    const restarted = await start("a");
    assert.equal(restarted.recovered, true);
    assert.match(((await supervisorMessages(supervisor, "a")) as any[]).at(-1).content, /interrupted by a restart/);
    await reply("a");
  });

  test(`${hosting} hosting: an agent that crashes leaves the others answering`, { timeout: 60_000 }, async t => {
    const { supervisor, start, fault, reply } = await fixture(t, hosting);
    await Promise.all(["a", "b", "c"].map(start));
    const handle = supervisor.agents.get("a")!;
    // Its exit, not its error (which `once` would reject with).
    const exited = new Promise(resolve => (handle.kind === "thread" ? handle.worker : handle.kind === "process" ? handle.child : assert.fail()).once("exit", resolve));
    await fault("a", "crash").catch(() => {});
    await exited;
    await Promise.all(["b", "c"].map(reply));
    assert.equal(supervisor.agents.has("a"), false);
    await assert.rejects(supervisor.request("a", "status"), /Agent not found/);
    await start("a");
    await reply("a");
  });
}

test("thread hosting: closing the supervisor ends every agent thread", { timeout: 60_000 }, async t => {
  const { supervisor, start, fault } = await fixture(t, "thread");
  await Promise.all(["a", "b", "c"].map(start));
  const workers = [...supervisor.agents.values()].map(handle => handle.kind === "thread" ? handle.worker : assert.fail());
  // One of them busy for good: it ends too.
  void fault("c", "spin").catch(() => {});
  await sleep(50);
  await supervisor.close();
  assert.equal(supervisor.agents.size, 0);
  assert.deepEqual(workers.map(worker => worker.threadId), [-1, -1, -1]);
  assert.equal(process.getActiveResourcesInfo().filter(kind => kind === "MessagePort" || kind === "Worker").length, 0);
});

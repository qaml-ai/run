import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A model whose first answer streams slowly (a chunk every 50 ms for 10 s), and later ones at once. */
async function slowModel(t: { after(fn: () => Promise<void>): void }) {
  const calls: { started: number; ended?: number; cut?: boolean }[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    const call: { started: number; ended?: number; cut?: boolean } = { started: Date.now() };
    calls.push(call);
    res.on("close", () => { call.ended = Date.now(); call.cut = !res.writableFinished; });
    const chunk = (delta: object, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (calls.length === 1) for (let index = 0; index < 200 && !res.destroyed; index++) { chunk({ role: "assistant", content: "slow " }); await sleep(50); }
    else chunk({ role: "assistant", content: "answered" });
    if (!res.destroyed) { chunk({}, "stop"); res.end("data: [DONE]\n\n"); }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const model = {
    id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    reasoning: false, input: ["text"], cost: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
  } as Model<Api>;
  return { calls, model };
}

test("a stale lease cuts the model request in flight, the next waits for a fresh one, and the turn then completes with one answer", async t => {
  const fake = await slowModel(t);
  const root = await mkdtemp(join(tmpdir(), "model-gate-"));
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined });
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true }); });
  // The node's lease, as Ownership.whenFresh answers it: open, or held until it is fresh again.
  let fresh: PromiseWithResolvers<void> | undefined;
  let leases = 0;
  const lease = async () => { leases++; await fresh?.promise; };
  await supervisor.start("gated", { model: fake.model, apiKey: "fixture", retry: { maxAttempts: 0, baseDelayMs: 10 } }, { definitions: [], async call() { return null; }, lease });
  const events: any[] = [];
  const turn = supervisor.request("gated", "prompt", { text: "hello" }, event => events.push(event));
  for (let tries = 0; fake.calls.length < 1 || Date.now() - fake.calls[0].started < 300; tries++) { assert.ok(tries < 200, "the model call began"); await sleep(10); }
  assert.equal(leases, 1, "the model request waited for the lease");

  fresh = Promise.withResolvers<void>();
  supervisor.interrupt();
  for (let tries = 0; fake.calls[0].ended === undefined; tries++) { assert.ok(tries < 200, "the stream was cut"); await sleep(10); }
  assert.equal(fake.calls[0].cut, true);
  // The retry waits for the lease: no model call while it is stale.
  await sleep(300);
  assert.equal(fake.calls.length, 1, "no new model call while the lease is stale");
  assert.equal(leases, 2);
  fresh.resolve();
  const result = await turn;
  assert.equal(result.error, null, "an interrupted request is retried, even with no retries left for provider failures");
  assert.equal(result.reply, "answered");
  assert.equal(fake.calls.length, 2);
  assert.ok(events.some(event => event.type === "message_retracted"), "the cut response is not history");
  const history = (await supervisor.request("gated", "history")).messages;
  assert.deepEqual(history.map((message: any) => message.role), ["user", "assistant"]);
});

test("an abort while waiting for the lease ends the turn as an abort, without a model call", async t => {
  const fake = await slowModel(t);
  const root = await mkdtemp(join(tmpdir(), "model-gate-"));
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined });
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true }); });
  const stale = Promise.withResolvers<void>();
  t.after(() => stale.resolve());
  await supervisor.start("waiting", { model: fake.model, apiKey: "fixture" }, { definitions: [], async call() { return null; }, lease: () => stale.promise });
  const turn = supervisor.request("waiting", "prompt", { text: "hello" });
  await sleep(200);
  await supervisor.request("waiting", "abort");
  const result = await turn;
  assert.match(String(result.error), /abort/i);
  assert.equal(fake.calls.length, 0);
});

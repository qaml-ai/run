import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { fileAppendLog } from "../shared/append-log.ts";
import { MIGRATION_MAX_BYTES } from "../src/pi-durable/migration.ts";
import { transcriptPath, type TranscriptRecord } from "../src/transcript.ts";
import { agentEngine } from "../src/pi-durable/config.ts";

test("Pi is an explicit operator switch with a legacy default", () => {
  assert.equal(agentEngine(undefined), "legacy");
  assert.equal(agentEngine("legacy"), "legacy");
  assert.equal(agentEngine("pi-durable"), "pi-durable");
  assert.throws(() => agentEngine("pi"), /AGENT_ENGINE/);
});

for (const hosting of ["inline", "process"] as Hosting[]) test(`session migration retains history, IDs and request dedup across reopen and rollback (${hosting})`, { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-switch-"));
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain request */ }
    calls++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: `answer ${calls}` }, null], [{}, "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: `response-${calls}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const model = {
    id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", reasoning: false,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024,
  } as Model<Api>;
  const bridge = { definitions: [], call: async () => { throw new Error("No application tools"); } };
  const supervisors: AgentSupervisor[] = [];
  t.after(async () => {
    await Promise.all(supervisors.map(supervisor => supervisor.close()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const open = async (engine: "legacy" | "pi-durable") => {
    const supervisor = new AgentSupervisor(root, { hosting, engine });
    supervisors.push(supervisor);
    const init = await supervisor.start("same-public-session", { model, apiKey: "fixture", codeMode: false }, bridge);
    return { supervisor, init };
  };
  const first = await open("legacy");
  assert.equal(first.init.engine, "legacy");
  assert.equal((await first.supervisor.request("same-public-session", "prompt", { text: "first", requestId: "old-request" })).reply, "answer 1");
  const original = await first.supervisor.history("same-public-session");
  await first.supervisor.close();

  const switched = await open("pi-durable");
  assert.equal(switched.init.engine, "pi-durable");
  assert.equal(switched.init.migration.state, "migrated");
  assert.deepEqual(await switched.supervisor.history("same-public-session"), original);
  assert.equal((await switched.supervisor.request("same-public-session", "prompt", { text: "duplicate", requestId: "old-request" })).taken, true);
  assert.equal(calls, 1);
  assert.equal((await switched.supervisor.request("same-public-session", "prompt", { text: "second", requestId: "pi-request" })).reply, "answer 2");
  const withPi = await switched.supervisor.history("same-public-session");
  assert.deepEqual(withPi.slice(0, original.length), original);
  assert.equal(withPi.length, 4);
  await switched.supervisor.close();

  const reopened = await open("pi-durable");
  assert.equal(reopened.init.migration.state, "existing");
  assert.deepEqual(await reopened.supervisor.history("same-public-session"), withPi);
  assert.equal((await reopened.supervisor.request("same-public-session", "prompt", { text: "duplicate", requestId: "pi-request" })).taken, true);
  assert.equal(calls, 2);
  await reopened.supervisor.close();

  const rolledBack = await open("legacy");
  assert.equal(rolledBack.init.engine, "legacy");
  assert.deepEqual(await rolledBack.supervisor.history("same-public-session"), withPi);
  assert.equal((await rolledBack.supervisor.request("same-public-session", "prompt", { text: "third", requestId: "rollback-request" })).reply, "answer 3");
  const afterRollback = await rolledBack.supervisor.history("same-public-session");
  await rolledBack.supervisor.close();

  const enabledAgain = await open("pi-durable");
  assert.deepEqual(await enabledAgain.supervisor.history("same-public-session"), afterRollback);
  assert.equal((await enabledAgain.supervisor.request("same-public-session", "prompt", { text: "fourth", requestId: "again" })).reply, "answer 4");
  assert.equal((await enabledAgain.supervisor.history("same-public-session")).length, 8);
});


for (const hosting of ["inline", "process"] as Hosting[]) test(`oversized migration stays usable on legacy without partial import (${hosting})`, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-size-limit-"));
  const id = "large-session", directory = join(root, id);
  const log = fileAppendLog<TranscriptRecord>(transcriptPath(directory));
  const records: TranscriptRecord[] = [
    { t: "message", message: { role: "user", content: "x".repeat(MIGRATION_MAX_BYTES), timestamp: 1, requestId: "old" } as any },
    { t: "compaction", summary: "Earlier history", cut: 1, tokensBefore: 100, at: 2 },
  ];
  await log.rewrite(() => records);
  const supervisors: AgentSupervisor[] = [];
  t.after(async () => { await Promise.all(supervisors.map(s => s.close())); await log.close(); await rm(root, { recursive: true, force: true }); });
  const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", reasoning: false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 } as Model<Api>;
  const bridge = { definitions: [], call: async () => { throw new Error("No tools expected"); } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const supervisor = new AgentSupervisor(root, { hosting, engine: "pi-durable" });
    supervisors.push(supervisor);
    const init = await supervisor.start(id, { model, codeMode: false }, bridge);
    assert.equal(init.engine, "legacy");
    assert.deepEqual(init.migration, { state: "deferred", reason: "size_limit" });
    assert.equal((await supervisor.request(id, "prompt", { text: "duplicate", requestId: "old" })).taken, true);
    assert.deepEqual(await supervisor.history(id), [records[0].t === "message" ? records[0].message : undefined]);
    await supervisor.close();
  }
  assert.deepEqual((await log.read()).slice(0, 2), records, "all original records remain intact");
});

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
import { historyOf, transcriptPath, type TranscriptRecord } from "../src/transcript.ts";
import { openPiJournalReader, openPiStorage } from "../src/pi-durable/storage.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { rollBack } from "./fixtures/pi-rollback.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

for (const hosting of ["inline", "process"] as Hosting[]) test(`a legacy session imports with its history, IDs and request dedup, and one rolled back off Pi imports again (${hosting})`, { timeout: 60_000 }, async t => {
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
  const id = "same-public-session", directory = join(root, id);
  const log = fileAppendLog<TranscriptRecord>(transcriptPath(directory));
  const supervisors: AgentSupervisor[] = [];
  t.after(async () => {
    await Promise.all(supervisors.map(supervisor => supervisor.close()));
    await log.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const open = async () => {
    const supervisor = new AgentSupervisor(root, { hosting });
    supervisors.push(supervisor);
    const init = await supervisor.start(id, { model, apiKey: "fixture", codeMode: false }, bridge);
    return { supervisor, init };
  };
  /** A turn as the legacy engine wrote it to the agent's log. */
  const legacyTurn = (text: string, requestId: string, reply: string): TranscriptRecord[] => [
    { t: "turn", active: true },
    { t: "message", message: { role: "user", content: text, timestamp: 1, requestId } as any },
    { t: "message", message: fauxAssistantMessage(reply) },
    { t: "turn", active: false },
  ];
  await log.rewrite(() => legacyTurn("first", "old-request", "answer 0"));
  const original = historyOf(await log.read());

  const switched = await open();
  assert.deepEqual(switched.init.migration, { state: "migrated" });
  assert.deepEqual(await switched.supervisor.history(id), original);
  assert.equal((await switched.supervisor.request(id, "prompt", { text: "duplicate", requestId: "old-request" })).taken, true);
  assert.equal(calls, 0);
  assert.equal((await switched.supervisor.request(id, "prompt", { text: "second", requestId: "pi-request" })).reply, "answer 1");
  const withPi = await switched.supervisor.history(id);
  assert.deepEqual(withPi.slice(0, original.length), original);
  assert.equal(withPi.length, 4);
  await switched.supervisor.close();
  // The import wrote the archive and the context once, and the first Pi run found its context current.
  const journal = (await openPiJournalReader({ sessionId: id, directory }))!;
  const kinds: string[] = [];
  for (let cursor; ;) {
    const page = await journal.scanEntries({ conversationId: 1 as never, order: "ascending" }, 256, cursor, BACKGROUND_CONTEXT);
    kinds.push(...page.items.map(entry => entry.kind));
    if (!(cursor = page.next)) break;
  }
  await journal.close(BACKGROUND_CONTEXT);
  assert.equal(kinds.filter(kind => kind === "camel.legacy.context").length, 1);
  assert.equal(kinds.filter(kind => kind === "camel.host.archive").length, 1);
  assert.ok(!kinds.includes("camel.legacy.record"));
  assert.deepEqual(historyOf(await log.read()), original, "the legacy log is not written again");

  const reopened = await open();
  assert.deepEqual(reopened.init.migration, { state: "existing" });
  assert.deepEqual(await reopened.supervisor.history(id), withPi);
  assert.equal((await reopened.supervisor.request(id, "prompt", { text: "duplicate", requestId: "pi-request" })).taken, true);
  assert.equal(calls, 1);
  await reopened.supervisor.close();

  // An earlier release rolled the session back to its legacy engine, which ran a turn of its own.
  const storage = await openPiStorage({ sessionId: id, directory });
  await rollBack(storage, log);
  await storage.close(BACKGROUND_CONTEXT);
  for (const record of legacyTurn("third", "rollback-request", "answer on legacy")) log.append(record);
  await log.flush(true);
  const afterRollback = historyOf(await log.read());
  assert.equal(afterRollback.length, 6);

  const enabledAgain = await open();
  assert.deepEqual(enabledAgain.init.migration, { state: "adopted" });
  assert.deepEqual(await enabledAgain.supervisor.history(id), afterRollback);
  assert.equal((await enabledAgain.supervisor.request(id, "prompt", { text: "duplicate", requestId: "rollback-request" })).taken, true);
  assert.equal((await enabledAgain.supervisor.request(id, "prompt", { text: "fourth", requestId: "again" })).reply, "answer 2");
  assert.equal((await enabledAgain.supervisor.history(id)).length, 8);
});


for (const hosting of ["inline", "process"] as Hosting[]) test(`an import too large to copy keeps its archive in the legacy log, which its history reads first (${hosting})`, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-size-limit-"));
  const id = "large-session", directory = join(root, id);
  const log = fileAppendLog<TranscriptRecord>(transcriptPath(directory));
  const records: TranscriptRecord[] = [
    { t: "message", message: { role: "user", content: "x".repeat(MIGRATION_MAX_BYTES), timestamp: 1, requestId: "old" } as any },
    { t: "compaction", summary: "Earlier history", cut: 1, tokensBefore: 100, at: 2 },
  ];
  await log.rewrite(() => records);
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain request */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "on Pi" }, null], [{}, "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const supervisors: AgentSupervisor[] = [];
  t.after(async () => {
    await Promise.all(supervisors.map(s => s.close())); await log.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", reasoning: false,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 } as Model<Api>;
  const bridge = { definitions: [], call: async () => { throw new Error("No tools expected"); } };
  const original = historyOf(records);
  const open = async () => {
    const supervisor = new AgentSupervisor(root, { hosting });
    supervisors.push(supervisor);
    return { supervisor, init: await supervisor.start(id, { model, apiKey: "fixture", codeMode: false }, bridge) };
  };
  const first = await open();
  assert.deepEqual(first.init.migration, { state: "migrated", archive: "legacy-log" });
  assert.equal((await first.supervisor.request(id, "prompt", { text: "duplicate", requestId: "old" })).taken, true);
  assert.equal((await first.supervisor.request(id, "prompt", { text: "new", requestId: "new" })).reply, "on Pi");
  const history = await first.supervisor.request(id, "history");
  assert.deepEqual(history.messages.slice(0, 1), original);
  assert.deepEqual(history.messages.slice(1).map((message: any) => message.role), ["user", "assistant"]);
  await first.supervisor.close();
  // Nothing was copied: the journal holds no archive, and the legacy log is as it was.
  const journal = (await openPiJournalReader({ sessionId: id, directory }))!;
  const kinds: string[] = [];
  for (let cursor; ;) {
    const page = await journal.scanEntries({ conversationId: 1 as never, order: "ascending" }, 256, cursor, BACKGROUND_CONTEXT);
    kinds.push(...page.items.map(entry => entry.kind));
    if (!(cursor = page.next)) break;
  }
  await journal.close(BACKGROUND_CONTEXT);
  assert.ok(!kinds.includes("camel.host.archive") && !kinds.includes("camel.legacy.record"));
  assert.deepEqual(await log.read(), records);
  // Read cold (no host), and on the next start: the same whole history.
  const cold = new AgentSupervisor(root, { hosting });
  supervisors.push(cold);
  assert.deepEqual(await cold.history(id), history.messages);
  const second = await open();
  assert.deepEqual(second.init.migration, { state: "existing" });
  assert.deepEqual((await second.supervisor.request(id, "history")).messages, history.messages);
  assert.equal((await second.supervisor.request(id, "prompt", { text: "duplicate", requestId: "new" })).taken, true);
});

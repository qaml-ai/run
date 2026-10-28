import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentSupervisor, transcriptPath, type Hosting } from "../src/supervisor.ts";
import { fileAppendLog } from "../shared/append-log.ts";
import { openPiJournalReader, openPiStorage } from "../src/pi-durable/storage.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { rollBack } from "./fixtures/pi-rollback.ts";
import { copyFingerprint, historyOf, hostTranscriptSession, SEED_MAX_BYTES, setDualWrite, type TranscriptRecord } from "./fixtures/host-transcript.ts";

// Sessions a release before the host transcript's removal seeded, as nodes ran it then.
setDualWrite(true);
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

for (const hosting of ["inline", "process"] as Hosting[]) test(`a session whose history is still only in the legacy format is refused, loudly, and nothing is written; a new agent is seeded (${hosting})`, { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-refuse-"));
  const supervisors: AgentSupervisor[] = [];
  t.after(async () => { await Promise.all(supervisors.map(supervisor => supervisor.close())); await rm(root, { recursive: true, force: true }); });
  const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", reasoning: false, baseUrl: "http://127.0.0.1:9/v1",
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 } as Model<Api>;
  const bridge = { definitions: [], call: async () => { throw new Error("No application tools"); } };
  const start = (id: string) => { const supervisor = new AgentSupervisor(root, { hosting }); supervisors.push(supervisor); return supervisor.start(id, { model, apiKey: "fixture", codeMode: false }, bridge); };
  const kinds = async (id: string) => {
    const journal = await openPiJournalReader({ sessionId: id, directory: join(root, id) });
    if (!journal) return [];
    try { return (await journal.scanEntries({ conversationId: 1 as never, order: "ascending" }, 256, undefined, BACKGROUND_CONTEXT)).items.map(entry => entry.kind); }
    finally { await journal.close(BACKGROUND_CONTEXT); }
  };
  const turn: TranscriptRecord[] = [
    { t: "turn", active: true }, { t: "message", message: { role: "user", content: "first", timestamp: 1, requestId: "old" } as any },
    { t: "message", message: fauxAssistantMessage("answer") }, { t: "turn", active: false },
  ];

  // Only its legacy transcript holds its history: refused, its log as it was, no Pi storage made.
  const log = fileAppendLog<TranscriptRecord>(transcriptPath(join(root, "legacy-only")));
  await log.rewrite(() => turn);
  await assert.rejects(start("legacy-only"), /AGENT_NOT_MIGRATED: .*legacy format/);
  assert.deepEqual(await log.read(), turn);
  assert.deepEqual(await kinds("legacy-only"), []);
  await log.close();

  // Rolled back to the legacy engine by an earlier release: refused, its journal as it was.
  await hostTranscriptSession({ sessionId: "rolled-back", directory: join(root, "rolled-back") }, turn);
  const storage = await openPiStorage({ sessionId: "rolled-back", directory: join(root, "rolled-back") });
  await rollBack(storage, fileAppendLog<TranscriptRecord>(transcriptPath(join(root, "rolled-back"))));
  await storage.close(BACKGROUND_CONTEXT);
  const before = await kinds("rolled-back");
  await assert.rejects(start("rolled-back"), /AGENT_NOT_MIGRATED: .*missing or disabled/);
  assert.deepEqual(await kinds("rolled-back"), before);

  // Its host transcript written by the release before: retired as it starts, and its history kept.
  await hostTranscriptSession({ sessionId: "earlier", directory: join(root, "earlier") }, turn);
  assert.equal((await start("earlier")).messages, 2);
  assert.deepEqual(await supervisors.at(-1)!.history("earlier"), historyOf(turn));

  // A new agent: seeded with the marker every release reads first, its journal history's base and its context.
  assert.ok(await start("new"));
  assert.deepEqual(await kinds("new"), ["camel.legacy.migration", "camel.history.marker", "camel.legacy.context"]);
});


for (const hosting of ["inline", "process"] as Hosting[]) test(`a fork the release before kept in its legacy log (too large to copy) is retired with its history whole, read from there first (${hosting})`, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-size-limit-"));
  const id = "large-session", directory = join(root, id);
  const log = fileAppendLog<TranscriptRecord>(transcriptPath(directory));
  const records: TranscriptRecord[] = [
    { t: "message", message: { role: "user", content: "x".repeat(SEED_MAX_BYTES), timestamp: 1, requestId: "old" } as any },
    { t: "compaction", summary: "Earlier history", cut: 1, tokensBefore: 100, at: 2 },
  ];
  assert.equal(copyFingerprint(records), undefined, "past the copy budget");
  await hostTranscriptSession({ sessionId: id, directory }, records, { legacy: log });
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
  assert.equal((await first.supervisor.request(id, "prompt", { text: "duplicate", requestId: "old" })).taken, true);
  assert.equal((await first.supervisor.request(id, "prompt", { text: "new", requestId: "new" })).reply, "on Pi");
  const history = { messages: (await first.supervisor.history(id)) as any[] };
  assert.deepEqual(history.messages.slice(0, 1), original);
  assert.deepEqual(history.messages.slice(1).map((message: any) => message.role), ["user", "assistant"]);
  await first.supervisor.close();
  // Nothing was copied: the journal holds no archive, and the legacy log holds the records as seeded.
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
  assert.deepEqual(((await second.supervisor.history(id)) as any[]), history.messages);
  assert.equal((await second.supervisor.request(id, "prompt", { text: "duplicate", requestId: "new" })).taken, true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Cursor, EntryRecord } from "@earendil-works/pi-durable";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { openPiJournalReader } from "../src/pi-durable/storage.ts";
import { LEGACY_CONVERSATION_ID } from "../src/pi-durable/migration.ts";

async function kinds(directory: string, sessionId: string) {
  const journal = (await openPiJournalReader({ sessionId, directory }))!;
  const counts = new Map<string, number>();
  try {
    let cursor: Cursor | undefined;
    do {
      const page = await journal.scanEntries({ conversationId: LEGACY_CONVERSATION_ID, order: "ascending" }, 256, cursor);
      for (const entry of page.items as EntryRecord[]) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
      cursor = page.next;
    } while (cursor);
  } finally { await journal.close(); }
  return counts;
}

// Each prompt reassigns the host's messages; an unchanged context must not be written again (it once rewrote the
// whole working set per turn: 24,806 context records after 15 responses in production).
for (const hosting of ["inline", "process"] as Hosting[]) test(`an unchanged context is not checkpointed again each turn (${hosting})`, { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-checkpoint-"));
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
  const supervisor = new AgentSupervisor(root, { hosting, engine: "pi-durable" });
  t.after(async () => {
    await supervisor.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const id = "steady-session";
  await supervisor.start(id, { model, apiKey: "fixture", codeMode: false }, bridge);
  for (let turn = 1; turn <= 6; turn++) {
    assert.equal((await supervisor.request(id, "prompt", { text: `turn ${turn}` })).reply, `answer ${turn}`);
  }
  assert.equal((await supervisor.history(id)).length, 12);
  await supervisor.close();
  const counts = await kinds(join(root, id), id);
  // The import's, the host adoption's and the first run's checkpoints; every turn after it appends only its own messages.
  assert.ok((counts.get("camel.legacy.context") ?? 0) <= 3, `context checkpoints: ${JSON.stringify([...counts])}`);
  assert.ok((counts.get("camel.context.message") ?? 0) === 0, `copied context messages: ${JSON.stringify([...counts])}`);

  const reopened = new AgentSupervisor(root, { hosting, engine: "pi-durable" });
  t.after(() => reopened.close());
  await reopened.start(id, { model, apiKey: "fixture", codeMode: false }, bridge);
  assert.equal((await reopened.request(id, "prompt", { text: "after reopen" })).reply, "answer 7");
  assert.equal((await reopened.history(id)).length, 14);
});

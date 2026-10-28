import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentSupervisor, transcriptPath, type Hosting } from "../src/supervisor.ts";
import { fileAppendLog } from "../shared/append-log.ts";
import { openPiJournalReader, openPiStorage } from "../src/pi-durable/storage.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { rollBack } from "./fixtures/pi-rollback.ts";
import { copyFingerprint, hostTranscriptSession, SEED_MAX_BYTES, setDualWrite, type TranscriptRecord } from "./fixtures/host-transcript.ts";

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
  await hostTranscriptSession({ sessionId: "rolled-back", directory: join(root, "rolled-back") }, turn, { unretired: true });
  const storage = await openPiStorage({ sessionId: "rolled-back", directory: join(root, "rolled-back") });
  await rollBack(storage, fileAppendLog<TranscriptRecord>(transcriptPath(join(root, "rolled-back"))));
  await storage.close(BACKGROUND_CONTEXT);
  const before = await kinds("rolled-back");
  await assert.rejects(start("rolled-back"), /AGENT_NOT_MIGRATED: .*not_on_pi/);
  assert.deepEqual(await kinds("rolled-back"), before);

  // A host transcript no release retired: refused, its journal as it was (this release no longer reads its records).
  await hostTranscriptSession({ sessionId: "earlier", directory: join(root, "earlier") }, turn, { unretired: true });
  const earlier = await kinds("earlier");
  await assert.rejects(start("earlier"), /AGENT_NOT_MIGRATED: .*host_transcript/);
  assert.deepEqual(await kinds("earlier"), earlier);
  await assert.rejects(supervisors.at(-1)!.history("earlier"), /AGENT_NOT_MIGRATED: .*history_before_base/);

  // A new agent: seeded with the marker every release reads first, its journal history's base and its context.
  assert.ok(await start("new"));
  assert.deepEqual(await kinds("new"), ["camel.legacy.migration", "camel.history.marker", "camel.legacy.context"]);
});


for (const hosting of ["inline", "process"] as Hosting[]) test(`a fork the release before kept in its legacy log (too large to copy), never retired, is refused: its log and journal as they were (${hosting})`, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-size-limit-"));
  const id = "large-session", directory = join(root, id);
  const log = fileAppendLog<TranscriptRecord>(transcriptPath(directory));
  const records: TranscriptRecord[] = [
    { t: "message", message: { role: "user", content: "x".repeat(SEED_MAX_BYTES), timestamp: 1, requestId: "old" } as any },
    { t: "compaction", summary: "Earlier history", cut: 1, tokensBefore: 100, at: 2 },
  ];
  assert.equal(copyFingerprint(records), undefined, "past the copy budget");
  await hostTranscriptSession({ sessionId: id, directory }, records, { legacy: log, unretired: true });
  const supervisor = new AgentSupervisor(root, { hosting });
  t.after(async () => { await supervisor.close(); await log.close(); await rm(root, { recursive: true, force: true }); });
  const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", reasoning: false, baseUrl: "http://127.0.0.1:9/v1",
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 } as Model<Api>;
  const entries = async () => {
    const journal = (await openPiJournalReader({ sessionId: id, directory }))!;
    try { return (await journal.scanEntries({ conversationId: 1 as never, order: "ascending" }, 256, undefined, BACKGROUND_CONTEXT)).items.length; }
    finally { await journal.close(BACKGROUND_CONTEXT); }
  };
  const before = await entries();
  await assert.rejects(supervisor.start(id, { model, apiKey: "fixture", codeMode: false }, { definitions: [], call: async () => { throw new Error("No tools expected"); } }), /AGENT_NOT_MIGRATED: .*host_transcript/);
  await assert.rejects(supervisor.history(id), /AGENT_NOT_MIGRATED/);
  assert.equal(await entries(), before);
  assert.deepEqual(await log.read(), records);
});

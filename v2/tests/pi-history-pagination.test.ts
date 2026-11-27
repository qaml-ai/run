import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import type { MappedHistoryResult } from "../worker/src/pi/migrate.ts";
import { estimateTokens } from "../worker/src/types.ts";
import type { HistoryFixtureEntry, HistoryFixtureRows } from "./fixtures/pi-history-worker.ts";

const text = (value: string) => ({ type: "text", text: value });
const image = { type: "image", mimeType: "image/png", data: "a".repeat(256 * 1024) };

function fixtureHistory() {
  const entries: HistoryFixtureRows["entries"] = [];
  const metadata: HistoryFixtureRows["metadata"] = [];
  const messages: MappedHistoryResult["messages"] = [];
  let id = 10;
  function append(
    kind: string,
    model?: HistoryFixtureEntry["model"],
    fields: Omit<Partial<HistoryFixtureEntry>, "id" | "kind" | "model"> = {},
  ) {
    // Pi allocates IDs across multiple record types, so entry IDs have gaps.
    const seq = id += 3;
    entries.push({ id: seq, kind, model, conversationId: 1, ...fields });
    return seq;
  }
  function message(
    seq: number,
    runId: string | null,
    role: "user" | "assistant" | "tool",
    content: MappedHistoryResult["messages"][number]["content"],
    timestamp: number,
  ) {
    messages.push({
      seq, runId, role, content,
      tokensEst: estimateTokens(String(content.text ?? "")), createdAt: timestamp,
    });
  }

  for (let i = 0; i < 210; i++) {
    const runId = i % 7 === 0 ? null : `run-${i}`;
    const timestamp = 1_000 + i;
    const user = `Prompt ${i}`;
    const userKind = ["camelrun.user", "pi.user", "fixture.user"][i % 3]!;
    const native = userKind === "camelrun.user";
    const files = [{ name: `file-${i}.txt` }];
    const nativeMeta = native ? { source: "native", actor: "alice", requestId: "req1" } : { source: "legacy" };
    const seq = append(userKind, [{ role: "user", content: user, timestamp }], {
      ...(native ? { data: { runId, files, meta: { source: "native" }, actor: "alice", requestId: "req1" } } : {}),
    });
    metadata.push({ id: seq, runId: native ? "overridden-by-native" : runId, meta: { source: "legacy", _files: files, i } });
    message(seq, runId, "user", { text: user, files, meta: { ...nativeMeta, i } }, timestamp);

    // A system kind is hidden even if it carries a user-role model message.
    append("pi.system", [{ role: "user", content: "Hidden", timestamp }]);
    if (i === 100) {
      for (let j = 0; j < 600; j++) {
        const hidden = append("fixture.internal");
        metadata.push({ id: hidden, runId: "hidden", meta: { hidden: true } });
      }
    }

    const calls = ["a", "b"].map((letter) => {
      const args = { i, letter };
      return { id: `${letter}-${i}`, name: "lookup", argumentsJson: JSON.stringify(args), args };
    });
    const assistant = append("pi.assistant", [{
      role: "assistant",
      timestamp,
      content: [
        text("Looking"), text(` up ${i}`),
        ...calls.map(call => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.args })),
      ],
    }]);
    const assistantRunId = i % 2 === 0 ? `assistant-${i}` : null;
    metadata.push({ id: assistant, runId: assistantRunId, meta: { i } });
    message(assistant, assistantRunId ?? runId, "assistant", { text: `Looking up ${i}`, toolCalls: calls, meta: { i } }, timestamp);

    for (const call of calls) {
      const large = i === 0 || i === 100 || i === 209;
      const result = large ? `${call.id} ${"z".repeat(128 * 1024)}` : `Result ${call.id}`;
      const tool = append("pi.tool-result", [{
        role: "toolResult",
        timestamp,
        toolCallId: call.id,
        toolName: call.name,
        content: [text(result), ...(large ? [image] : [])],
        isError: call.id.startsWith("b"),
      }]);
      // A null sidecar run ID falls back to the last user, even if the assistant
      // itself had a different run ID.
      metadata.push({ id: tool, runId: null, meta: { result: true } });
      message(tool, runId, "tool", {
        toolCallId: call.id, toolName: call.name, text: result,
        ...(large ? { toolImages: [{ contentType: "image/png" }] } : {}),
        ...(call.id.startsWith("b") ? { isError: true } : {}),
        meta: { result: true },
      }, timestamp);
    }
    append("pi.assistant", [{ role: "assistant", content: [text("Different conversation")], timestamp }], { conversationId: 2 });
  }
  const upToSeq = messages[16]!.seq;
  const marker = append("pi.compaction", [{ role: "user", content: "<summary>Older work</summary>" }], { head: upToSeq });
  const afterCompaction = append("pi.assistant", [{ role: "assistant", content: [text("New context")], timestamp: 2_000 }]);
  message(afterCompaction, null, "assistant", { text: "New context" }, 2_000);
  for (let i = 0; i < 800; i++) append("fixture.internal");
  return { rows: { entries, metadata }, messages, compaction: { id: `cmp_${marker}`, upToSeq, summary: "Older work" }, id };
}

test("AgentDO history seeks small pages in a long Pi transcript and reads only page metadata", async t => {
  const dir = mkdtempSync(join(tmpdir(), "camelrun-history-"));
  const config = join(dir, "wrangler.json");
  writeFileSync(config, JSON.stringify({
    name: "pi-history-pagination",
    main: fileURLToPath(new URL("./fixtures/pi-history-worker.ts", import.meta.url)),
    compatibility_date: "2026-03-01",
    compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
    durable_objects: { bindings: [{ name: "TEST_HISTORY", class_name: "AgentDO" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["AgentDO"] }],
  }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());

  const fixture = fixtureHistory();
  const { rows, messages, id } = fixture;
  let { compaction } = fixture;
  async function write(path: string, rowsToWrite: HistoryFixtureRows) {
    const response = await worker.fetch(`https://pi-history.test/${path}`, {
      method: "POST", body: JSON.stringify(rowsToWrite),
    });
    assert.equal(response.status, 204, response.status === 204 ? undefined : await response.text());
  }
  type Read = { query: string; rows: number };
  async function read(query: string): Promise<{ history: MappedHistoryResult; reads: Read[] }> {
    const response = await worker.fetch(`https://pi-history.test/history?${query}`);
    assert.equal(response.status, 200, response.ok ? undefined : await response.text());
    return response.json() as Promise<{ history: MappedHistoryResult; reads: Read[] }>;
  }
  await write("seed", rows);
  // A pre-existing transcript builds the partial indexes once in SQLite.
  await read("limit=1");

  async function check(query: string, start: number, end: number, after: number, nextBefore?: number | null) {
    const expected = messages.slice(start, end);
    const { history, reads } = await read(query);
    assert.deepEqual(history, {
      messages: expected,
      compaction,
      nextAfter: expected.at(-1)?.seq ?? after,
      ...(nextBefore === undefined ? {} : { nextBefore }),
    }, query);
    // rowsRead counts actual SQLite work, including rows tested by a predicate.
    const entryReads = reads.filter(read => /\bpi_entries\b/.test(read.query)).reduce((sum, read) => sum + read.rows, 0);
    const metadataReads = reads.filter(read => /\bpi_entry_meta\b/.test(read.query)).reduce((sum, read) => sum + read.rows, 0);
    assert.ok(entryReads > 0 && entryReads <= 8 * expected.length + 6, JSON.stringify({ query, entryReads, reads }));
    assert.ok(metadataReads <= 7 * expected.length, JSON.stringify({ query, metadataReads, reads }));
  }

  await check("limit=3", 0, 3, 0);
  await check(`after=${messages[2]!.seq}&limit=3`, 3, 6, messages[2]!.seq);
  await check(`after=${messages[400]!.seq}&limit=3`, 401, 404, messages[400]!.seq);
  await check(`after=${messages.at(-2)!.seq}&limit=5`, messages.length - 1, messages.length, messages.at(-2)!.seq);
  await check(`after=${messages.at(-1)!.seq}&limit=5`, messages.length, messages.length, messages.at(-1)!.seq);

  const length = messages.length;
  await check("before=latest&limit=4", length - 4, length, 0, messages[length - 4]!.seq);
  await check(`before=${messages[length - 4]!.seq}&limit=4`, length - 8, length - 4, 0, messages[length - 8]!.seq);
  await check(`before=${messages[402]!.seq}&limit=3`, 399, 402, 0, messages[399]!.seq);
  await check(`before=${messages[2]!.seq}&limit=3`, 0, 2, 0, null);
  await check(`before=${messages[0]!.seq}&limit=3`, 0, 0, 0, null);

  // Cursor adjacency may put a tool result on its own page. Each assistant
  // still carries both of its calls and results keep their call and run IDs.
  await check(`after=${messages[0]!.seq}&limit=1.9`, 1, 2, messages[0]!.seq);
  await check(`before=${messages[3]!.seq}&limit=1`, 2, 3, 0, messages[2]!.seq);
  await check("before=latest&limit=invalid", length - 50, length, 0, messages[length - 50]!.seq);

  await write("append", {
    entries: [{ id: id + 1, conversationId: 1, kind: "pi.reset", head: id + 1 }],
    metadata: [],
  });
  assert.equal((await read("limit=1")).history.compaction, null);
  const handoff = id + 2;
  await write("append", {
    entries: [{
      id: handoff, conversationId: 1, kind: "pi.reset", head: handoff,
      model: [{ role: "user", content: "  Handed over  " }],
    }],
    metadata: [],
  });
  compaction = { id: `rst_${handoff}`, upToSeq: handoff, summary: "Handed over" };
  await check("limit=1", 0, 1, 0);
});

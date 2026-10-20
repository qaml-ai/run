import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileAppendLog } from "../shared/append-log.ts";
import { Transcript, readTranscript, type TranscriptRecord } from "../src/transcript.ts";

async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "append-log-test-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return root;
}

test("appends are buffered until flushed and survive reopening", async t => {
  const path = join(await directory(t), "log.jsonl");
  const log = fileAppendLog<{ n: number }>(path);
  log.append({ n: 1 }); log.append({ n: 2 });
  assert.deepEqual(await fileAppendLog(path).read(), []);
  await log.flush(true);
  log.append({ n: 3 });
  await log.flush();
  await log.close();
  assert.deepEqual(await fileAppendLog(path).read(), [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test("an effect runs once, alone, before the records it goes with; one that fails keeps them for the next write", async t => {
  const path = join(await directory(t), "log.jsonl");
  const log = fileAppendLog<{ n: number }>(path);
  const ran: string[] = [];
  let fail = true;
  log.append({ n: 1 }, async sql => {
    assert.equal(sql, undefined);
    ran.push(String((await fileAppendLog(path).read()).length));
    if (fail) throw new Error("effect failed");
  });
  await assert.rejects(log.flush(true), /effect failed/);
  assert.deepEqual(await fileAppendLog(path).read(), []);
  fail = false;
  await log.flush(true);
  await log.flush(true);
  assert.deepEqual(await fileAppendLog(path).read(), [{ n: 1 }]);
  assert.deepEqual(ran, ["0", "0"], "before the record was written, and not again once it ran");
  await log.close();
});

test("a torn final record from a crash is dropped, but corruption elsewhere is an error", async t => {
  const path = join(await directory(t), "log.jsonl");
  await appendFile(path, '{"n":1}\n{"n":2}\n{"n":');
  assert.deepEqual(await fileAppendLog(path).read(), [{ n: 1 }, { n: 2 }]);
  await appendFile(path, '\n{"n":4}\n');
  await assert.rejects(fileAppendLog(path).read(), /Corrupt append log record 3/);
});

test("streamed replay preserves JSONL framing, large Unicode records, torn tails, and callback failures", async t => {
  const path = join(await directory(t), "streamed.jsonl");
  const log = fileAppendLog<{ text: string }>(path);
  const replay = async () => {
    const records: { text: string }[] = [];
    await log.replay!(record => records.push(record));
    return records;
  };
  assert.deepEqual(await replay(), [], "a missing log is empty");
  const large = { text: "你好 🐪\n".repeat(30_000) };
  await appendFile(path, `${JSON.stringify(large)}\n\n${JSON.stringify({ text: "last" })}`);
  assert.deepEqual(await replay(), await log.read(), "including a whole final record without a newline");
  await appendFile(path, '\n{"text":\n\n');
  assert.deepEqual(await replay(), await log.read(), "blank lines after a torn record");
  const callbackError = Object.assign(new Error("consumer failed"), { code: "ENOENT" });
  await assert.rejects(log.replay!(() => { throw callbackError; }), error => error === callbackError);
  await appendFile(path, '{"text":"after corruption"}\n');
  await assert.rejects(replay(), /Corrupt append log record 4/);
});

test("a writer after a crash appends after the last whole record, not onto a torn one", async t => {
  // Found by prop-append-log: the next record was glued onto the torn line, then dropped with it as torn.
  const path = join(await directory(t), "log.jsonl");
  await appendFile(path, '{"n":1}\n{"n":');
  const log = fileAppendLog<{ n: number }>(path);
  assert.deepEqual(await log.read(), [{ n: 1 }]);
  log.append({ n: 3 });
  await log.flush(true);
  log.append({ n: 4 });
  await log.flush(true);
  await log.close();
  assert.equal(await readFile(path, "utf8"), '{"n":1}\n{"n":3}\n{"n":4}\n');
});

test("a writer after a crash keeps a whole final record that lost only its newline", async t => {
  const path = join(await directory(t), "log.jsonl");
  await appendFile(path, '{"n":1}\n{"n":2}');
  const log = fileAppendLog<{ n: number }>(path);
  assert.deepEqual(await log.read(), [{ n: 1 }, { n: 2 }]);
  log.append({ n: 3 });
  await log.flush(true);
  await log.close();
  assert.deepEqual(await fileAppendLog(path).read(), [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test("rewrite folds the log from a snapshot taken inside the write sequence", async t => {
  const path = join(await directory(t), "log.jsonl");
  const log = fileAppendLog<{ n: number }>(path);
  const state: number[] = [];
  const add = (n: number) => { state.push(n); log.append({ n }); };
  add(1); add(2);
  const folding = log.rewrite(() => state.map(n => ({ n })));
  add(3); // Appended after the fold was requested, before it ran: the snapshot includes it.
  await folding;
  add(4);
  await log.flush();
  assert.equal(log.appendedSinceRewrite, 1);
  assert.deepEqual(await fileAppendLog(path).read(), [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
});

test("transcript appends one record per message", async t => {
  const root = await directory(t);
  const transcript = new Transcript(fileAppendLog<TranscriptRecord>(join(root, "transcript.jsonl")));
  await transcript.load();
  await transcript.setActive(true);
  await transcript.push({ role: "user", content: "first", timestamp: 1 });
  assert.equal(transcript.active, true);
  assert.equal(transcript.total, 1);
  await transcript.setActive(false);
  await transcript.push({ role: "user", content: "next", timestamp: 2 });
  await transcript.push({ role: "assistant", content: [], stopReason: "error", errorMessage: "503", timestamp: 3 } as any);
  await transcript.retract();
  const lines = (await readFile(join(root, "transcript.jsonl"), "utf8")).trim().split("\n");
  assert.deepEqual(lines.map(line => JSON.parse(line).t), ["turn", "message", "turn", "message", "message", "retract"]);
  assert.deepEqual((await readTranscript(root)).map(m => (m as { content: unknown }).content), ["first", "next"]);
});


test("bounded file reads reject oversized input and retain torn-tail semantics", async t => {
  const path = join(await directory(t), "bounded.jsonl");
  const text = '{"text":"é"}\n{"torn":';
  await appendFile(path, text);
  const log = fileAppendLog(path);
  const bytes = Buffer.byteLength(text);
  assert.equal(await log.readBounded!(bytes - 1), undefined);
  assert.deepEqual(await log.readBounded!(bytes), [{ text: "é" }]);
  assert.equal(await readFile(path, "utf8"), text, "bounded reads never modify the original");
  await appendFile(path, '\n{"later":true}\n');
  await assert.rejects(log.readBounded!(1024), /Corrupt append log record 2/);
});

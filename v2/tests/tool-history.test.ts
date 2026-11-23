import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import type { StoredMessage } from "../worker/src/types.ts";

const toolCall = (id: string) => ({ id, name: "test_tool", args: {}, argumentsJson: "{}" });
const result = (toolCallId: string, text: string, isError = false) => ({ toolCallId, text, isError });
type HistoryRow = [StoredMessage["runId"], StoredMessage["role"], StoredMessage["content"]];
type InputItem = { role?: string; content?: string; type?: string; call_id?: string; name?: string; arguments?: string; output?: string };

test("recorded tool history produces complete Azure Responses groups", async (t) => {
  const requests: InputItem[][] = [];
  const provider = createServer(async (req, res) => {
    const body = [];
    for await (const part of req) body.push(part);
    const rawBody = Buffer.concat(body).toString();
    if (/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/.test(rawBody)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "invalid_json", message: "lone surrogate in JSON body" } }));
      return;
    }
    const { input } = JSON.parse(rawBody) as { input: InputItem[] };
    requests.push(input);
    const pending = new Set<string>();
    let unpaired = false;
    for (let idx = 0; idx < input.length; idx++) {
      const item = input[idx]!;
      if (item.type === "function_call" && typeof item.arguments === "string" && item.arguments.length > 1_048_576) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: {
            code: "string_above_max_length",
            message: `Invalid 'input[${idx}].arguments': string too long. Expected a string with maximum length 1048576, but got a string with length ${item.arguments.length} instead.`,
          },
        }));
        return;
      }
      if (item.type === "function_call" && item.call_id) pending.add(item.call_id);
      else if (item.type === "function_call_output" && item.call_id) unpaired ||= !pending.delete(item.call_id);
      else unpaired ||= pending.size > 0;
    }
    if (unpaired || pending.size) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "missing_function_output" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const dir = mkdtempSync(join(tmpdir(), "camelrun-tool-history-"));
  const config = join(dir, "wrangler.json");
  writeFileSync(config, JSON.stringify({
    name: "tool-history-test",
    main: fileURLToPath(new URL("./fixtures/tool-history-worker.ts", import.meta.url)),
    compatibility_date: "2026-03-01",
    compatibility_flags: ["nodejs_compat"],
    vars: {
      AZURE_OPENAI_SOL_ENDPOINT: `http://127.0.0.1:${address.port}`,
      AZURE_OPENAI_SOL_API_KEY: "fixture-key",
    },
  }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());

  const ask = async (rows: HistoryRow[], expected: InputItem[]) => {
    const response = await worker.fetch("https://tool-history.test/", {
      method: "POST",
      body: JSON.stringify(rows.map(([runId, role, content], index) => ({
        seq: index + 1, runId, role, content, tokensEst: 1, createdAt: index,
      }))),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json() as { chunks: Array<{ type: string; delta?: string }>; storedUnchanged: boolean };
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.storedUnchanged, true);
    assert.deepEqual(payload.chunks[0], { type: "text_delta", delta: "ok" });
    assert.deepEqual(requests.at(-1), expected);
  };
  const callItem = (id: string) => ({ type: "function_call", call_id: id, name: "test_tool", arguments: "{}" });
  const outputItem = (id: string, output: string) => ({ type: "function_call_output", call_id: id, output });

  await t.test("a new turn drops an aborted call-only group with no recorded outcomes", async () => {
    await ask([
      ["aborted", "user", { text: "original question" }],
      ["aborted", "assistant", { text: "", toolCalls: [toolCall("unrecorded")] }],
      ["next", "user", { text: "new question" }],
    ], [{ role: "user", content: "original question" }, { role: "user", content: "new question" }]);
  });

  await t.test("a partly recorded parallel group keeps assistant text, success, and explicit tool errors", async () => {
    await ask([
      ["aborted", "assistant", { text: "visible text", toolCalls: [toolCall("success"), toolCall("error"), toolCall("unrecorded")] }],
      ["aborted", "tool", result("success", "actual output")],
      ["aborted", "tool", result("error", '{"error":"actual failure"}', true)],
      ["next", "user", { text: "carry on" }],
    ], [
      { role: "assistant", content: "visible text" }, callItem("success"), callItem("error"),
      outputItem("success", "actual output"), outputItem("error", '{"error":"actual failure"}'),
      { role: "user", content: "carry on" },
    ]);
  });

  await t.test("resumed and imported complete groups keep their recorded results in order", async () => {
    await ask([
      [null, "assistant", { toolCalls: [toolCall("imported")] }],
      [null, "tool", result("imported", "imported result")],
      ["paused", "user", { text: "pause and resume" }],
      ["paused", "assistant", { toolCalls: [toolCall("answered"), toolCall("after-answer")] }],
      ["paused", "tool", result("answered", "human answer")],
      ["paused", "tool", result("after-answer", "resumed output")],
    ], [
      callItem("imported"), outputItem("imported", "imported result"), { role: "user", content: "pause and resume" },
      callItem("answered"), callItem("after-answer"), outputItem("answered", "human answer"), outputItem("after-answer", "resumed output"),
    ]);
  });

  await t.test("orphan and foreign-run outputs cannot stand in for missing results", async () => {
    await ask([
      ["old", "tool", result("compacted", "out of context")],
      ["old", "assistant", { text: "still visible", toolCalls: [toolCall("unrecorded")] }],
      ["old", "tool", result("unrelated", "unrelated output")],
      ["other", "tool", result("unrecorded", "wrong run")],
      ["next", "user", { text: "new turn" }],
      ["old", "tool", result("unrecorded", "after intervening turn")],
    ], [{ role: "assistant", content: "still visible" }, { role: "user", content: "new turn" }]);
  });

  await t.test("lone UTF-16 surrogates in history are sanitized to U+FFFD while preserving valid emoji", async () => {
    await ask([
      ["s1", "assistant", { text: "", toolCalls: [toolCall("call_surr")] }],
      ["s1", "tool", result("call_surr", "coins 🪙\n\ud83c\nend")],
      ["s2", "user", { text: "hi \udfff ok" }],
    ], [
      callItem("call_surr"),
      outputItem("call_surr", "coins 🪙\n\ufffd\nend"),
      { role: "user", content: "hi \ufffd ok" },
    ]);
  });

  await t.test("oversized historical function_call arguments (> 1 MiB) are truncated to valid JSON without lone surrogates", async () => {
    // Place a surrogate-pair emoji across index 4000 so naive .slice(0, 4000) would split it.
    const prefix = '{"content":"' + "a".repeat(3987) + "🪙";
    assert.equal(prefix.length, 4001);
    const hugeArgsJson = prefix + "b".repeat(1_403_016) + '"}';
    assert.equal(hugeArgsJson.length, 1_407_019);
    const hugeCall = { id: "call_huge", name: "write_file", args: {}, argumentsJson: hugeArgsJson };

    const response = await worker.fetch("https://tool-history.test/", {
      method: "POST",
      body: JSON.stringify([
        { seq: 1, runId: "h1", role: "assistant", content: { text: "", toolCalls: [hugeCall] }, tokensEst: 1, createdAt: 1 },
        { seq: 2, runId: "h1", role: "tool", content: result("call_huge", "written"), tokensEst: 1, createdAt: 2 },
        { seq: 3, runId: "h2", role: "user", content: { text: "continue" }, tokensEst: 1, createdAt: 3 },
      ]),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json() as { chunks: Array<{ type: string; delta?: string }>; storedUnchanged: boolean };
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.storedUnchanged, true);
    assert.deepEqual(payload.chunks[0], { type: "text_delta", delta: "ok" });

    const sent = requests.at(-1)!;
    const sentCall = sent.find((item) => item.type === "function_call" && item.call_id === "call_huge");
    assert.ok(sentCall && typeof sentCall.arguments === "string");
    assert.ok(sentCall.arguments.length < 1_048_576, `Expected truncated arguments, got ${sentCall.arguments.length}`);
    const parsed = JSON.parse(sentCall.arguments) as { _truncated: boolean; originalLength: number; preview: string };
    assert.equal(parsed._truncated, true);
    assert.equal(parsed.originalLength, hugeArgsJson.length);
    assert.equal(parsed.preview.length, 4_000);
    assert.ok(parsed.preview.endsWith("\ufffd"), "Split high surrogate at slice boundary should be sanitized to U+FFFD");
    assert.doesNotMatch(parsed.preview, /[\uD800-\uDFFF]/);
  });
});

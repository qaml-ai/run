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
    const { input } = JSON.parse(Buffer.concat(body).toString()) as { input: InputItem[] };
    requests.push(input);
    const pending = new Set<string>();
    let unpaired = false;
    for (const item of input) {
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
});

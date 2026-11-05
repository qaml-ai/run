import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../../../clients/typescript.ts";
import { OPERATOR, toolCall } from "../../../tests/runtime-server.ts";
import { compatibilityRuntime } from "./compat-runtime.ts";

test("presented files are streamed and retained in results until agent deletion, including removed mounts", { timeout: 90_000 }, async t => {
  const r = await compatibilityRuntime(t, (_body: unknown, index: number) => [
    toolCall("write", { path: "/shared/report.txt", content: "version one" }),
    toolCall("present_file", { path: "/shared/report.txt", caption: "The report" }),
    { role: "assistant", content: "The report is ready." },
  ][index] ?? { role: "assistant", content: "done" });
  const sdk = new AgentRuntime({ url: r.base, apiKey: OPERATOR });
  const shared = await sdk.createVolume();
  const agent = await sdk.upsertAgent("presented-output", { tools: {}, mounts: [{ volumeId: shared.id, path: "/shared", mode: "rw" }] });
  const events: any[] = [];
  const abort = new AbortController();
  const stream = await fetch(`${r.base}/v1/agents/${agent.session.id}/events`, { headers: { authorization: `Bearer ${OPERATOR}` }, signal: abort.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const reading = (async () => {
    let pending = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += new TextDecoder().decode(chunk.value);
        let split;
        while ((split = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, split); pending = pending.slice(split + 2);
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (data) events.push(JSON.parse(data));
        }
      }
    } catch (error) { if (!abort.signal.aborted) throw error; }
  })();
  void reading.catch(() => {});
  t.after(async () => { abort.abort(); await reading.catch(() => {}); });
  const result = await r.prompt(agent.session.id, "Write and present the report", undefined, { idempotencyKey: "z-written" });
  assert.equal(result.outcome.result.reply, "The report is ready.", JSON.stringify(result));
  assert.deepEqual(result.outcome.result.files, [{ path: "/shared/report.txt", version: 1, size: 11, contentType: "text/plain" }]);
  const presented = result.outcome.result.presented;
  assert.equal(presented.length, 1);
  assert.equal(presented[0].caption, "The report");
  assert.equal(presented[0].volume, shared.id);
  assert.equal(presented[0].path, "/shared/report.txt");
  const event = events.find(item => item.event?.type === "file_presented");
  assert.ok(event, JSON.stringify(events));
  assert.equal(event.requestId, result.id);
  assert.deepEqual(event.event.file, presented[0]);
  assert.equal(await (await fetch(r.base + new URL(event.event.url).pathname)).text(), "version one");
  const readOnly = await r.prompt(agent.session.id, "Thanks", undefined, { idempotencyKey: "a-read-only" });
  assert.equal(readOnly.outcome.result.files, undefined);
  assert.equal(readOnly.outcome.result.presented, undefined);
  const state = await r.call(`/v1/agents/${agent.session.id}/state`);
  assert.equal(state.json.requests.at(-1).id, "a-read-only", "outcomes preserve request chronology rather than sorting by request ID");
  assert.equal(state.json.requests.at(-1).outcome.result.files, undefined);
  await sdk.volume(shared.id).write("report.txt", "version two");
  const gc = async (advance = 0) => {
    const response = await r.call(`/v1/volumes/${shared.id}/__gc?advance=${advance}`, { method: "POST" });
    assert.equal(response.status, 200, response.text);
    return response.json;
  };
  assert.equal((await gc()).removed, 0);
  assert.equal((await gc(86_400_010)).removed, 0, "the presented version is pinned");
  const remounted = await r.call(`/v1/agents/${agent.session.id}/mounts`, { method: "PUT", body: [] });
  assert.equal(remounted.status, 200, remounted.text);
  const deleted = await r.call(`/v1/agents/${agent.session.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal((await gc()).candidates, 1, "a removed mount's presented file was unpinned");
  assert.equal((await gc(86_400_010)).removed, 1);
});

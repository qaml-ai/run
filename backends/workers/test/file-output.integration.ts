import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../../../clients/typescript.ts";
import { openEventStream } from "../../../clients/event-transport.ts";
import { OPERATOR, toolCall } from "../../../tests/runtime-server.ts";
import { compatibilityRuntime } from "./compat-runtime.ts";

test("presented files are streamed and retained in results until agent deletion, including removed mounts", { timeout: 90_000 }, async t => {
  const r = await compatibilityRuntime(t, (_body: unknown, index: number) => [
    toolCall("write", { path: "/shared/report.txt", content: "version one" }),
    toolCall("present_file", { path: "/shared/report.txt", caption: "The report" }),
    { role: "assistant", content: "The report is ready." },
  ][index] ?? { role: "assistant", content: "done" });
  const sdk = new AgentRuntime({ url: r.base, apiKey: OPERATOR });
  const shared = (await r.call("/v1/repos",{body:{}})).json;
  const agent = await sdk.upsertAgent("presented-output", { tools: {}, mounts: [{ repo: shared.id, path: "/shared", mode: "rw" }] });
  const events: any[] = [];
  const abort = new AbortController();
  const stream = await openEventStream(fetch, `${r.base}/v1/agents/${agent.session.id}/events`, { headers: { authorization: `Bearer ${OPERATOR}` }, signal: abort.signal });
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
  assert.deepEqual(result.outcome.result.files, [{ path: "/shared/report.txt", version: result.outcome.result.files[0].version, size: 11, contentType: "text/plain" }]);
  const presented = result.outcome.result.presented;
  assert.equal(presented.length, 1);
  assert.equal(presented[0].caption, "The report");
  assert.equal(presented[0].repo, shared.id);
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
  const update=await fetch(`${r.base}/v1/repos/${shared.id}/files/report.txt`,{method:"PUT",headers:{authorization:`Bearer ${OPERATOR}`},body:"version two"});
  assert.equal(update.status,201);
  assert.equal(await (await fetch(r.base+new URL(event.event.url).pathname)).text(),"version one","presented version remains immutable after overwrite");
  const remounted = await r.call(`/v1/agents/${agent.session.id}/mounts`, {method:"PUT",body:{mounts:[]}});
  assert.equal(remounted.status,200,remounted.text);
  const deleted=await r.call(`/v1/agents/${agent.session.id}`,{method:"DELETE"});
  assert.equal(deleted.status,200,deleted.text);
  assert.equal((await r.call(`/v1/repos/${shared.id}`)).status,200,"shared repo survives agent deletion");
});

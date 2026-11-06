import assert from "node:assert/strict";
import test from "node:test";
import worker, { reply } from "../pilot-fakemodel/index.ts";

test("pilot fake produces valid streaming completions with billable synthetic usage", async () => {
  const response = await worker.fetch(new Request("https://fake.test/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "deterministic", stream: true, messages: [{ role: "user", content: "pilot:hello" }] }) }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /event-stream/);
  const frames = (await response.text()).split("\n\n").filter(frame => frame.startsWith("data: {")).map(frame => JSON.parse(frame.slice(6)));
  assert.equal(frames[0].choices[0].delta.content, "Echo: pilot:hello");
  assert.equal(frames[1].choices[0].finish_reason, "stop");
  assert.equal(frames[1].usage.total_tokens, 15);
  assert.equal(frames[1].usage.cost, 0.000015);
});

test("pilot fake issues each tool once, then includes its result", () => {
  for (const [prompt, name] of [["pilot:human", "ask_user"], ["pilot:code", "codemode"], ["pilot:delegate", "delegate"]]) {
    const messages = [{ role: "user", content: prompt }];
    const called = reply({ messages });
    assert.ok("tool_calls" in called);
    assert.equal(called.tool_calls[0].function.name, name);
    if (name === "ask_user") assert.deepEqual(JSON.parse(called.tool_calls[0].function.arguments), { questions: [{ question: "Approve the pilot smoke test?", header: "Approval", options: [{ label: "approved" }, { label: "rejected" }] }] });
    const returned = reply({ messages: [...messages, { role: "tool", content: "finished" }] });
    assert.ok("content" in returned);
    assert.equal(returned.content, "Tool result: finished");
  }
});

test("pilot fake verifies image delivery without retaining image bytes", () => {
  const result = reply({ messages: [{ role: "user", content: [{ type: "text", text: "pilot:images" }, { type: "image_url", image_url: { url: "data:image/png;base64,c2FmZQ==" } }] }] });
  assert.ok("content" in result);
  assert.equal(result.content, "Images received: 1; inline: 1; markers: 0; bytes: 4");
});

test("pilot fake bounds requests and rejects malformed payloads", async () => {
  assert.equal((await worker.fetch(new Request("https://fake.test/v1/chat/completions", { method: "POST", body: "broken" }))).status, 400);
  assert.equal((await worker.fetch(new Request("https://fake.test/v1/chat/completions", { method: "POST", body: "{}", headers: { "content-length": String(9 * 1024 * 1024) } }))).status, 413);
});

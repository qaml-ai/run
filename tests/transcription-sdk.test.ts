import { test } from "node:test";
import assert from "node:assert/strict";
import { Agents } from "../clients/node.ts";
import { HELLO, OPS, PAYG, start } from "./transcription-fixture.ts";

test("the TypeScript SDK: transcriptions.create from bytes, a Blob or a URL; audio attached to agent and stateless runs, by URL too", async t => {
  const { r, openai } = await start(t);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  const agents = new Agents({ url: r.base, apiKey: PAYG });
  t.after(() => agents.close());
  const alone = await agents.transcriptions.create({ file: new Uint8Array(HELLO), language: "en", context: { org: "o1" } });
  assert.deepEqual(alone, { text: "Hello from camelRun.", language: "en", durationSeconds: 5, model: "openai/gpt-transcribe", costUsd: 0.05 });
  assert.equal(openai.requests.at(-1)!.language, "en");
  const blob = await agents.transcriptions.create({ file: new File([HELLO], "voice.ogg", { type: "audio/ogg" }), timestamps: true });
  assert.equal(blob.segments?.length, 1);
  assert.equal((await agents.transcriptions.create({ url: `${openai.base}/hello.ogg` })).text, "Hello from camelRun.");
  await assert.rejects(agents.transcriptions.create({ file: new TextEncoder().encode("not audio") }), (error: any) => error.status === 415 && error.code === "UNSUPPORTED_AUDIO");
  await assert.rejects(agents.transcriptions.create({}), /file .* or url/);
  assert.equal(openai.requests.length, 3);

  const agent = await agents.upsert("voice");
  const heard = await agent.run("", { files: [{ name: "voice.ogg", data: new Uint8Array(HELLO), contentType: "audio/ogg" }] });
  assert.match(heard.text, /^heard: \[Audio \/workspace\/uploads\/[^/]+\/voice\.ogg \(audio\/ogg, 0:05, en\), transcript:\nHello from camelRun\.\n\]$/);
  const kept = await agent.run("keep", { files: [{ url: `${openai.base}/hello.ogg`, name: "kept.ogg", transcribe: false }] });
  assert.match(kept.text, /\[File \/workspace\/uploads\/[^/]+\/kept\.ogg \(audio\/ogg, 13 KB\)\]/);
  assert.equal(openai.requests.length, 4);
  const run = await agents.run({ input: "", files: [{ url: `${openai.base}/hello.ogg` }] });
  assert.match(run.text, /transcript:\nHello from camelRun\./);
  assert.equal(openai.requests.length, 5);
});

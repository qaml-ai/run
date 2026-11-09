import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startFixture } from "./fixture.ts";

test("an audio prompt consumes one run admission and a rejected prompt never calls transcription", { timeout: 90_000 }, async t => {
  let transcriptions = 0;
  const provider = createServer(async (request, response) => {
    for await (const _ of request) {}
    assert.equal(request.url, "/audio/transcriptions");
    transcriptions++;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "audio words", usage: { type: "duration", seconds: 1 } }));
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => new Promise<void>(resolve => provider.close(() => resolve())));
  const f = await startFixture({
    entrypoint: fileURLToPath(new URL("./prompt-admission-entry.ts", import.meta.url)),
    vars: { PLATFORM_OPENAI_KEY: "synthetic-only-key", MEDIA_BASE_URL: `http://127.0.0.1:${(provider.address() as any).port}` },
  });
  t.after(() => f.stop());
  await f.db.query("update tenants set limits=$1", [JSON.stringify({ runsPerMinute: 1 })]);
  const call = async (path: string, input?: unknown) => {
    const response = await fetch(f.url + path, { method: input === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const created = await call("/v1/agents", { model: "test/echo" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const base = `/v1/agents/${created.body.id}`;
  const files = [{ name: "voice.ogg", contentType: "audio/ogg", data: readFileSync(new URL("../../../tests/fixtures/audio/hello.ogg", import.meta.url)).toString("base64"), transcribe: true }];
  const input = { id: "audio-once", method: "prompt", params: { text: "Listen", files } };
  const accepted = await call(`${base}/requests`, input);
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  const result = await call(`${base}/requests/audio-once?wait=20`);
  assert.equal(result.body.state, "completed", JSON.stringify(result.body));
  assert.equal(transcriptions, 1);
  assert.equal((await call(`${base}/requests`, input)).status, 200, "a replay reuses both the admission and transcript");
  assert.equal(transcriptions, 1);
  const rejected = await call(`${base}/requests`, { ...input, id: "audio-rejected" });
  assert.equal(rejected.status, 429, JSON.stringify(rejected.body));
  assert.equal(transcriptions, 1, "rate rejection happens before any provider call");
});

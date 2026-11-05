import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { OPERATOR, toolCall } from "../../../tests/runtime-server.ts";
import { pngBytes } from "../../../tests/file-fixtures.ts";
import { compatibilityRuntime } from "./compat-runtime.ts";

test("agent image tools generate and edit through shared media, save mounted files and meter raw cost", { timeout: 90_000 }, async t => {
  const calls: string[] = [];
  const image = pngBytes(32, 16);
  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the bounded request. */ }
    calls.push(request.url!);
    assert.equal(request.headers.authorization, "Bearer fake-image-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: image.toString("base64") }], usage: { input_tokens: 10, output_tokens: 1000, input_tokens_details: { text_tokens: 10, image_tokens: 0 } } }));
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => { provider.closeAllConnections(); return new Promise<void>(resolve => provider.close(() => resolve())); });
  let input: string | undefined;
  const r = await compatibilityRuntime(t, (_body: unknown, index: number) => index % 2 === 0
    ? toolCall("generate_image", { prompt: "A synthetic fixture", ...(input ? { images: [input] } : {}) })
    : { role: "assistant", content: "The image is saved." }, {
    MEDIA_BASE_URL: `http://127.0.0.1:${(provider.address() as any).port}`,
    PLATFORM_OPENAI_KEY: "fake-image-key",
  });
  const created = await r.call("/v1/agents", { body: { codeMode: false, builtins: ["generate_image"], subject: "fixture-person", context: { project: "images" } } });
  assert.equal(created.status, 201, created.text);
  const id = created.json.id;
  const generated = await r.prompt(id, "Create the image", OPERATOR, { actor: "fixture-operator" });
  assert.equal(generated.outcome.result.reply, "The image is saved.", JSON.stringify(generated));
  assert.equal(generated.outcome.result.toolErrors.length, 0, JSON.stringify(generated));
  const first = generated.outcome.result.files[0];
  assert.match(first.path, /^\/workspace\/tool-outputs\/generate_image\/[^/]+\/image\.png$/);
  assert.equal(first.contentType, "image/png");
  assert.equal(first.size, image.length);
  assert.ok(generated.outcome.result.usage.imageCostUsd > 0, JSON.stringify(generated));
  const read = await fetch(`${r.base}/v1/agents/${id}/files${first.path}`, { headers: { authorization: `Bearer ${OPERATOR}` } });
  assert.equal(read.status, 200, await read.clone().text());
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), image);
  input = first.path;
  const edited = await r.prompt(id, "Edit the image", OPERATOR);
  assert.equal(edited.outcome.result.toolErrors.length, 0, JSON.stringify(edited));
  assert.equal(edited.outcome.result.files.length, 1);
  assert.notEqual(edited.outcome.result.files[0].path, first.path);
  assert.deepEqual(calls, ["/images/generations", "/images/edits"]);
  const usage = (await r.db.query("select model,responses from usage where model like 'image:%'")).rows;
  assert.deepEqual(usage.map(row => [row.model, Number(row.responses)]), [["image:openai/gpt-image-2.5-flare", 2]]);
  const receipts = (await r.db.query("select message from pi_usage_receipts where session_id=$1 and message ? '_workersAuxiliary'", [id])).rows;
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every(row => row.message._workersAuxiliary.kind === "image"));
  const catalog = await r.call(`/v1/agents/${id}/tool-sources`);
  assert.ok(catalog.json.some((source: any) => source.name === "generate_image"), catalog.text);
});

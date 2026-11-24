import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { unstable_startWorker } from "wrangler";
import { CamelRun } from "../sdk/src/index.ts";

test("inline history retains original raster bytes and ordered provider content in Workerd", async t => {
  const dir = mkdtempSync(join(tmpdir(), "inline-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const requests: Array<{ url: string; body: any }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url!, body: JSON.parse(body) });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (request.url?.includes("/responses")) {
      response.end(
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
      );
    } else if (request.url?.includes("/messages")) {
      response.end(
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      );
    } else if (request.url?.includes("streamGenerateContent")) {
      response.end(
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } })}\n\n`,
      );
    } else {
      response.end(
        `data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
      );
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = join(dir, "wrangler.json");
  writeFileSync(config, JSON.stringify({ name: "inline-history-test",
    main: fileURLToPath(new URL("./fixtures/inline-history-worker.ts", import.meta.url)),
    compatibility_date: "2026-03-01", compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
    vars: { ADMIN_SECRET: "fixture-admin", VAULT_SECRET: "fixture-vault-secret-32-bytes", DEFAULT_MODEL: "mock/default",
      CAMELFS_URL: "https://must-not-fetch-files.invalid", CAMELFS_DEV_TOKEN: "fixture" },
    durable_objects: { bindings: [{ name: "TENANT_DO", class_name: "TenantDO" }, { name: "AGENT_DO", class_name: "AgentDO" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] }],
  }));
  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());
  const origin = "https://inline-history.test";
  const owner = await CamelRun.createTenant({ baseUrl: origin, adminKey: "fixture-admin", name: "inline-owner",
    fetch: worker.fetch.bind(worker) as unknown as typeof fetch });
  const camel = new CamelRun({ baseUrl: origin, apiKey: owner.apiKey, fetch: worker.fetch.bind(worker) as unknown as typeof fetch });
  t.after(() => camel.close());
  const agent = await camel.agents.upsert("inline", { model: "mock/default", builtins: [] });
  const text = (text: string) => ({ type: "text", text });
  const images = await Promise.all((["png", "jpeg", "gif", "webp"] as const).map(async format => ({ type: "image",
    mimeType: `image/${format}`, data: (await sharp({ create: { width: 4, height: 3, channels: 4, background: "#abcdef" } }).toFormat(format).toBuffer()).toString("base64") })));
  const messages = [{ role: "user", content: [text("before"), images[0]!, text("between"), ...images.slice(1), text("after")], timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "fixture-call", name: "lookup", arguments: {} }], timestamp: 2 },
    { role: "toolResult", content: [text("done")], toolCallId: "fixture-call", toolName: "lookup", timestamp: 3 },
    { role: "assistant", content: [text("finished")], timestamp: 4 }];
  const imported = await agent.importV1History({ source: "fixture-v1", messages });
  assert.equal(imported.count, 4);
  assert.deepEqual(await agent.importV1History({ source: "fixture-v1", messages }), imported);
  const stored = await agent.history();
  assert.deepEqual(stored.map(row => (row.content as any).meta.v1), messages);
  assert.equal((stored[0]!.content as any).legacyInlineImages, true);
  assert.equal((stored[0]!.content as any).files, undefined);
  const proof = await worker.fetch(`${origin}/v2/agents/${agent.id}/history/import`, { headers: { Authorization: `Bearer ${owner.apiKey}` } });
  assert.equal((await proof.json() as { receipt: string }).receipt, imported.receipt);

  for (const provider of ["openai", "openai-responses", "anthropic", "gemini"]) {
    const response = await worker.fetch(`${origin}/_inline_fixture/${agent.id}/project`, {
      method: "POST", body: JSON.stringify({ provider, baseUrl }), signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, `${provider}: ${await response.text()}`);
    const body = requests.at(-1)!.body;
    const blocks = provider === "openai-responses" ? body.input[0].content
      : provider === "gemini" ? body.contents[0].parts : body.messages[0].content;
    assert.equal(blocks.length, 7, provider);
    assert.equal(blocks[0].text, "before");
    assert.equal(blocks[2].text, "between");
    assert.equal(blocks[6].text, "after");
    for (const [at, image] of [1, 3, 4, 5].map((at, index) => [at, images[index]!] as const)) {
      const actual = provider === "openai" ? blocks[at].image_url.url
        : provider === "openai-responses" ? blocks[at].image_url
        : provider === "anthropic" ? `data:${blocks[at].source.media_type};base64,${blocks[at].source.data}`
        : `data:${blocks[at].inlineData.mimeType};base64,${blocks[at].inlineData.data}`;
      assert.equal(actual, `data:${image.mimeType};base64,${image.data}`);
    }
  }

  for (const [key, content] of [
    ["pdf", [{ ...images[0], mimeType: "application/pdf" }]],
    ["damaged", [{ ...images[0], data: images[0]!.data.slice(0, 24) }]],
  ] as const) {
    const refused = await camel.agents.upsert(key, { model: "mock/default", builtins: [] });
    await assert.rejects(refused.importV1History({ source: "fixture", messages: [{ role: "user", content, timestamp: 1 }] }),
      (error: any) => error.status === 422);
    assert.equal((await refused.history()).length, 0);
  }
  const old = await camel.agents.upsert("old-reader", { model: "mock/default", builtins: [] });
  await assert.rejects(old.importV1History({ source: "fixture", messages }), (error: any) => error.status === 503);
  const plain = { role: "user", content: "Prior message", timestamp: 1 };
  const prior = await old.importV1History({ source: "fixture", messages: [plain] });
  await assert.rejects(old.importV1History({ source: "fixture", appendAfter: 1, previous: prior.receipt,
    messages: [{ ...plain, content: "New chunk" }] }), { status: 503 });
  assert.deepEqual((await old.history()).map(row => (row.content as any).meta.v1), [plain]);
  await assert.rejects(agent.importV1History({ source: "fixture-v1", appendAfter: 4, previous: imported.receipt,
    messages: [plain] }), { status: 409 });
  await assert.rejects(agent.importV1History({ source: "fixture-v1", appendAfter: 4, previous: imported.receipt,
    messages: messages.slice(0, 1) }), { status: 422 });
  const overBudget = await camel.agents.upsert("over-budget", { model: "mock/default", builtins: [] });
  await assert.rejects(overBudget.importV1History({ source: "fixture", messages: [{ role: "user", timestamp: 1,
    content: Array.from({ length: 41 }, () => images[0]!) }] }), (error: any) => error.status === 422);
  assert.equal((await overBudget.history()).length, 0);
  const largeRow = await camel.agents.upsert("large-row", { model: "mock/default", builtins: [] });
  const padded = { ...images[0]!, data: Buffer.concat([Buffer.from(images[0]!.data, "base64"), Buffer.alloc(2 * 1024 * 1024)]).toString("base64") };
  await assert.rejects(largeRow.importV1History({ source: "fixture", messages: [{ role: "user", timestamp: 1,
    content: [padded, padded, padded] }] }), (error: any) => error.status === 422);
  assert.equal((await largeRow.history()).length, 0);
  await assert.rejects(agent.importV1History({ source: "fixture-v1", messages: messages.slice(0, 2), previous: imported.receipt }),
    (error: any) => error.status === 422);
  assert.deepEqual((await agent.history()).map(row => (row.content as any).meta.v1), messages);
});

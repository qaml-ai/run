import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentSupervisor } from "../src/supervisor.ts";
import { supervisorMessages } from "./fixtures/journal-messages.ts";

test("an idle agent's history is its journal's", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "journal-backlog-"));
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "answer" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", reasoning: false, input: ["text"],
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 } as Model<Api>;
  const supervisor = new AgentSupervisor(root, { hosting: "inline" });
  t.after(async () => { await supervisor.close(); server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }); });
  const bridge = { definitions: [], call: async () => { throw new Error("no tools"); } };
  await supervisor.start("idle", { model, apiKey: "fixture", codeMode: false, tenant: "acme" } as never, bridge);
  await supervisor.request("idle", "prompt", { text: "one" });
  await supervisor.request("idle", "prompt", { text: "two" });
  await supervisor.stop("idle");
  assert.deepEqual((await supervisorMessages(supervisor, "idle")).map(message => message.role), ["user", "assistant", "user", "assistant"]);
});

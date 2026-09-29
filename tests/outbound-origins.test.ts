import { test } from "node:test";
import assert from "node:assert/strict";
import { listen, runtime, toolCall, toolResults } from "./runtime-server.ts";

test("an allowed origin serves a custom provider over http, while web_fetch still cannot reach it", async t => {
  // The application a self-hosted runtime serves, on loopback: a Chat Completions endpoint and a page.
  const app = await listen(t, async (req, res) => {
    if (req.url === "/page") return res.writeHead(200, { "Content-Type": "text/html" }).end("<p>internal</p>");
    for await (const _chunk of req) { /* the request */ }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "a", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "From the app." }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "a", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const r = await runtime(t, body => toolResults(body).length ? { role: "assistant", content: "done" } : toolCall("web_fetch", { url: `${app}/page` }), { AGENT_OUTBOUND_ALLOW_ORIGINS: app });
  const set = await r.call("/v1/providers/app", { method: "PUT", body: { type: "openai-completions", baseUrl: `${app}/v1`, apiKey: null, models: [{ id: "echo", contextWindow: 32768 }] } });
  assert.equal(set.status, 200, set.text);
  const agent = (await r.call("/v1/agents", { body: { model: "app/echo" } })).json.id;
  assert.equal((await r.prompt(agent, "Hi")).outcome.result.reply, "From the app.");

  const definition = (await r.call("/v1/definitions", { body: { name: "Reader", builtins: ["web_fetch"] } })).json;
  const reader = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;
  await r.prompt(reader, "read it");
  assert.match(toolResults(r.model.bodies.at(-1)).at(-1), /Only https:\/\/ URLs are allowed|private, local or reserved/);
  // Another port on the same host is not the origin.
  const other = await r.call("/v1/providers/other", { method: "PUT", body: { type: "openai-completions", baseUrl: `${app.replace(/:\d+$/, ":1")}/v1`, models: [{ id: "echo", contextWindow: 32768 }] } });
  assert.equal(other.status, 400);
});

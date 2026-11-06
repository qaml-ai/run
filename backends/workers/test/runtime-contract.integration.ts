import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Agents } from "../../../clients/agents.ts";
import { startFixture } from "./fixture.ts";

const text = (value: any) =>
  typeof value === "string"
    ? value
    : (value ?? []).map((part: any) => part.text ?? "").join("");
test(
  "paged history, context reset, compaction, scoped configuration and runtime limits on workerd",
  { timeout: 120000 },
  async (t) => {
    const calls: any[] = [];
    const provider = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      calls.push(body);
      const user = text(
        body.messages.findLast((message: any) => message.role === "user")
          ?.content,
      );
      if (user === "SLOW")
        await new Promise((resolve) => setTimeout(resolve, 4000));
      const loop = user === "LOOP";
      const delta = loop
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${calls.length}`,
                type: "function",
                function: { name: "final_output", arguments: '{"wrong":true}' },
              },
            ],
          }
        : { role: "assistant", content: "Local summary and answer" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
      res.end(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: loop ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 } })}\n\ndata: [DONE]\n\n`,
      );
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    t.after(() => {
      provider.closeAllConnections();
      return new Promise<void>((resolve) => provider.close(() => resolve()));
    });
    const fixture = await startFixture({
      modelURL: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
    });
    t.after(() => fixture.stop());
    const agents = new Agents({
      url: fixture.url,
      apiKey: fixture.token,
      connection: "lazy",
      pollMs: 10,
    });
    t.after(() => agents.close());
    const call = async (
      path: string,
      body?: unknown,
      token = fixture.token,
      method = body === undefined ? "GET" : "POST",
    ) => {
      const response = await fetch(fixture.url + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { response, body: (await response.json()) as any };
    };
    const imported = Array.from({ length: 1302 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content:
        index % 2
          ? [{ type: "text", text: `message-${index}` }]
          : `message-${index}`,
      timestamp: index + 1,
      ...(index % 2
        ? {
            api: "openai-completions",
            provider: "camel-test",
            model: "echo",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          }
        : {}),
    }));
    const created = await call("/v1/agents", {
      codeMode: false,
      fileTools: false,
      initialMessages: imported,
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const id = created.body.id,
      base = `/v1/agents/${id}`;
    const page = await call(base + "/history?limit=1");
    assert.equal(page.body.total, 1302);
    assert.deepEqual(
      page.body.entries.map((entry: any) => entry.index),
      [1300, 1301],
    );
    const reset = await call(base + "/context/reset", {
      summary: "Keep this summary",
      keepMessages: 2,
    });
    assert.equal(reset.response.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.keptMessages, 2);
    assert.ok(reset.body.after.bytes < reset.body.before.bytes);
    assert.equal((await call(base + "/history?limit=1")).body.total, 1302);
    // Keyless agents retain the credentials returned by creation (src/client-sessions/configuration.ts).
    const client = await agents.agent(created.body);
    await client.run("after reset", { timeoutMs: 15000 });
    const context = JSON.stringify(calls.at(-1).messages);
    assert.ok(context.includes("Keep this summary"));
    assert.ok(context.includes("message-1300"));
    assert.ok(!context.includes("message-0"));
    assert.equal((await call(base + "/compact", {})).response.status, 200);
    await client.run("after compact", { timeoutMs: 15000 });
    assert.equal((await call(base + "/history?limit=1")).body.total, 1306);
    const forbidden = await call(
      `/clients/${id}/requests`,
      {
        id: "denied-config",
        method: "configure",
        params: { keyScope: "other-user" },
      },
      created.body.token,
    );
    assert.equal(forbidden.response.status, 403);
    const safe = await call(
      `/clients/${id}/requests`,
      {
        id: "safe-config",
        method: "configure",
        params: { systemPrompt: "Be concise" },
      },
      created.body.token,
    );
    assert.equal(safe.response.status, 202, JSON.stringify(safe.body));
    const invalid = await call(base + "/requests", {
      id: "bad-spend",
      method: "prompt",
      params: { text: "hello", spendLimit: { usd: "invalid" } },
    });
    assert.equal(invalid.response.status, 400);
    const capped = await agents.upsert("limit-contract", {
      codeMode: false,
      fileTools: false,
      runLimits: { maxResponses: 2, maxSeconds: 10 },
    });
    const before = calls.length;
    const stopped = await capped.run("LOOP", {
      output: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
      timeoutMs: 15000,
      throwOnError: false,
    });
    assert.equal(stopped.status, "failed", JSON.stringify(stopped));
    assert.equal(stopped.error?.code, "turn_limit", JSON.stringify(stopped));
    assert.equal(calls.length - before, 2);
    const timed = await agents.upsert("time-contract", {
      codeMode: false,
      fileTools: false,
      runLimits: { maxSeconds: 1 },
    });
    const start = Date.now();
    const timeout = await timed.run("SLOW", {
      timeoutMs: 15000,
      throwOnError: false,
    });
    assert.equal(timeout.error?.code, "turn_limit", JSON.stringify(timeout));
    assert.ok(Date.now() - start < 3500);
  },
);

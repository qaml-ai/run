import test from "node:test";
import assert from "node:assert/strict";
import { normalizeContext } from "@earendil-works/pi-ai";
import { compile } from "@earendil-works/pi-schema";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { computerParameters, computerTool } from "../src/computers/tool.ts";

const valid = [
  { provider: "container", op: "exec", command: "pwd", timeoutMs: 1000 },
  { provider: "container", op: "exec", argv: ["pwd"] },
  { provider: "container", op: "read", path: "file.txt" },
  { provider: "container", op: "write", path: "file.txt", content: "hello" },
  { provider: "container", op: "parse", path: "file.json", format: "json" },
  { provider: "container", op: "snapshot", name: "saved" },
  { provider: "container", op: "restore", name: "saved" },
  { provider: "container", op: "sleep" },
];

test("computer schema retains all operation variants and rejects invalid arguments", () => {
  const schema = compile(computerParameters);
  for (const args of valid) assert.ok(schema.check(args), JSON.stringify(args));
  for (const args of [null, [], "sleep", {},
    { provider: "other", op: "sleep" },
    { provider: "container", op: "exec" },
    { provider: "container", op: "exec", command: "pwd", argv: ["pwd"] },
    { provider: "container", op: "exec", command: "pwd", timeoutMs: 600001 },
    { provider: "container", op: "read" },
    { provider: "container", op: "write", path: "file.txt" },
    { provider: "container", op: "parse", path: "file.txt", format: "pdf" },
    { provider: "container", op: "snapshot", name: "../outside" },
    { provider: "container", op: "sleep", extra: true },
  ]) assert.equal(schema.check(args), false, JSON.stringify(args));
});

for (const [api, stream] of [["openai-responses", responses], ["openai-completions", completions]] as const) {
  test(`computer has an object root on the ${api} wire`, async () => {
    const tool = computerTool({}, "schema-test");
    let payload: any;
    const model = { id: "schema-test", name: "schema-test", provider: "openai", api,
      baseUrl: "https://model.invalid/v1", reasoning: false, input: ["text"], contextWindow: 32768,
      maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const result = stream(model as never, normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }], tools: [tool] }), {
      apiKey: "test", maxRetries: 0,
      fetch: async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ error: { message: "fixture stops after capturing the wire request" } }),
          { status: 400, headers: { "Content-Type": "application/json" } });
      },
    });
    await result.result();
    assert.ok(payload, "provider serializer reached the mock transport without network access");
    const sent = api === "openai-completions" ? payload.tools[0].function : payload.tools[0];
    assert.equal(sent.name, "computer");
    assert.equal(sent.parameters.type, "object");
    assert.deepEqual(sent.parameters, JSON.parse(JSON.stringify(computerParameters)));
    assert.notEqual(sent.strict, true);
  });
}

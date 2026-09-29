import { test } from "node:test";
import assert from "node:assert/strict";
import { Api } from "../packages/cli/src/api.ts";

test("the default fetch keeps the global receiver for JSON and text requests", async t => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", function (this: unknown, input: string | URL | Request) {
    assert.equal(this, globalThis, "browser fetch rejects an API instance as its receiver");
    requests.push(String(input));
    return Promise.resolve(new Response(input.toString().endsWith("/v1/me") ? '{"tenant":"alice"}' : "# Docs"));
  });
  const api = new Api({ url: "https://example.invalid" });
  assert.equal((await api.me()).tenant, "alice");
  assert.equal(await api.text("/llms.txt"), "# Docs");
  assert.deepEqual(requests, ["https://example.invalid/v1/me", "https://example.invalid/llms.txt"]);
});

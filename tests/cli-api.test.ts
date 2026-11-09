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

test("usage defaults to daily totals and only requests grouping with --by", async t => {
  const { main } = await import("../packages/cli/src/cli.ts");
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json({ days: [], totals: {} });
  });
  const io = { out() {}, err() {}, tty: false, cwd: "/tmp", env: { CAMELAI_API_KEY: "test", CAMELAI_BASE_URL: "https://example.invalid" } };
  assert.equal(await main(["usage"], io), 0);
  assert.equal(new URL(urls[0]).searchParams.has("groupBy"), false);
  assert.equal(await main(["usage", "--rollup"], io), 0);
  assert.equal(new URL(urls[1]).searchParams.has("rollup"), false);
  assert.equal(await main(["usage", "--by", "agent", "--days", "7"], io), 0);
  assert.equal(new URL(urls[2]).searchParams.get("groupBy"), "agent");
  assert.equal(new URL(urls[2]).searchParams.get("days"), "7");
});

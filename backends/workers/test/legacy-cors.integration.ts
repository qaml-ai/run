import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startFixture } from "./fixture.ts";

test("legacy browser preflights preserve the Node read policy", { timeout: 180_000 }, async t => {
  const agent = `client_${"1".repeat(40)}`;
  const f = await startFixture({
    tenants: [{ id: "fixture", token: "art_fixture-preserved-tenant-key" }],
    entrypoint: fileURLToPath(new URL("./legacy-mcp-entry.ts", import.meta.url)),
  });
  t.after(() => f.stop());
  for (const host of ["run.camelai.com", "agents.camelai.dev"]) {
    for (const read of ["events", "state", "history", "inputs", "children"]) {
      const preflight = await fetch(`${f.url}/v1/agents/${agent}/${read}`, {
        method: "OPTIONS",
        headers: { origin: "https://console.example", "x-forwarded-host": host,
          "access-control-request-method": "GET", "access-control-request-headers": "Authorization, Last-Event-ID, Accept" },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
      assert.equal(preflight.headers.get("access-control-allow-methods"), "GET");
      assert.equal(preflight.headers.get("access-control-allow-headers"), "Authorization, Last-Event-ID, Accept");
      assert.equal(preflight.headers.get("access-control-max-age"), "86400");
      assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
      assert.equal(await preflight.text(), "");
    }
  }
  for (const path of [`/v1/agents/${agent}/prompt`, `/v1/volumes/vol_${"a".repeat(24)}/files`, `/clients/${agent}/events`]) {
    assert.equal((await fetch(f.url + path, { method: "OPTIONS", headers: { origin: "https://console.example" } })).status, 418);
  }
  assert.equal((await fetch(`${f.url}/v1/agents/${agent}/history`, { method: "OPTIONS" })).status, 418);
});

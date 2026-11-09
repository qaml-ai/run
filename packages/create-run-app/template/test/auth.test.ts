import assert from "node:assert/strict";
import { test } from "node:test";
import { sign, verify } from "../lib/session.ts";
import { githubIdentity } from "../lib/oauth.ts";
const secret = "test-only-".repeat(8);
test("sessions reject tampering, wrong purpose, expiry and missing configuration", async () => {
  const token = await sign({ userId: "github:1", name: "sam" }, secret, "session", 60);
  assert.equal((await verify(token, secret, "session"))?.userId, "github:1");
  assert.equal(await verify(`${token.slice(0, -8)}tampered`, secret, "session"), null);
  assert.equal(await verify(token, secret, "oauth"), null);
  assert.equal(await verify(token, undefined, "session"), null);
  assert.equal(await verify(await sign({}, secret, "session", -1), secret, "session"), null);
});
test("GitHub requires active membership and fails closed on lookup errors", async () => {
  for (const [status, state] of [[200, "active"], [200, "pending"], [404, ""], [500, ""]] as const) {
    const fetcher: typeof fetch = async (url, options) => {
      assert.equal(options?.redirect, "manual");
      return String(url).endsWith("/user") ? Response.json({ id: 1, login: "sam" }) : Response.json({ state }, { status });
    };
    if (status === 500) await assert.rejects(githubIdentity("test", "org", fetcher));
    else assert.deepEqual(await githubIdentity("test", "org", fetcher), state === "active" ? { userId: "github:1", name: "sam" } : null);
  }
});

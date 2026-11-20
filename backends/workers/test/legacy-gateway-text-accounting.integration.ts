import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startFixture } from "./fixture.ts";

test("native retries keep the elected v1 payer and debit actual Azure usage exactly once", { timeout: 150_000 }, async t => {
  const fixtureUser = `fixture_gateway_text_${randomBytes(8).toString("hex")}`;
  const grants = (await readFile(new URL("../ops/legacy-decisions-grants.sql", import.meta.url), "utf8"))
    .replaceAll(':"decision_role"', fixtureUser);
  const fixture = await startFixture({
    config: "test/legacy-gateway-text-accounting.wrangler.jsonc",
    noCamelfsTier: true,
    databaseRole: { fixtureUser, grants },
    entrypoint: fileURLToPath(new URL("./legacy-gateway-text-accounting-fixture.ts", import.meta.url)),
    tenants: [{ id: "fixture", token: "art_legacy-gateway-fixture" }],
  });
  t.after(() => fixture.stop());
  const now = Date.now();
  const run = {
    legacyTenant: "fixture", subject: "123456789012345678", bucket: "bot:0123456789abcdef",
    runId: `run_${"a".repeat(40)}`, fingerprint: "b".repeat(64), input: "fixture", json: false, timeoutMs: 25_000,
  };
  await fixture.db.query("insert into end_user_settings (tenant,enabled,updated_at) values ('fixture',true,$1)", [now]);
  await fixture.db.query("insert into end_users (tenant,id,balance,created_at,updated_at) values ('fixture',$1,10000,$2,$2)", [run.subject, now]);
  await fixture.db.query("insert into end_user_lots (tenant,end_user,key,amount,remaining,expires_at,created_at) values ('fixture',$1,'first',10000,10000,$2,$3)",
    [run.subject, now + 300_000, now]);
  async function call(state: string, body = run) {
    return fetch(fixture.url + "/fixture", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, run: body, startedAt: now }),
    });
  }
  const ledger = () => fixture.db.query("select end_user,bucket,amount,raw,metadata from end_user_ledger where tenant='fixture'");
  assert.equal((await call("pending")).status, 202);
  assert.equal((await call("missing")).status, 409);
  assert.equal((await ledger()).rowCount, 0);
  assert.equal((await call("ack-lost")).status, 202);
  const first = (await ledger()).rows;
  assert.equal(first.length, 1);
  assert.deepEqual([first[0].end_user, first[0].bucket, first[0].raw, first[0].amount, first[0].metadata.day],
    [run.subject, run.bucket, 2600, -2600, new Date(now).toISOString().slice(0, 10)]);
  const retry = await call("retry", { ...run, subject: "876543210987654321" });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { id: run.runId, status: "completed", text: "fixture",
    usage: { input: 1000, output: 50, cacheRead: 1000, cacheWrite: 0, costUsd: 0.0026 } });
  assert.equal((await call("expired")).status, 404);
  assert.equal((await call("settled")).status, 200);
  assert.deepEqual((await ledger()).rows, first);
  assert.equal((await call("pending", { ...run, legacyTenant: "other" })).status, 409);
});

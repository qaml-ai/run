import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pngBytes } from "../../../tests/file-fixtures.ts";
import { startFixture } from "./fixture.ts";

test("the original Camel Bots image request reaches Azure and the retained payer once", { timeout: 90_000 }, async t => {
  const calls: Array<{ path: string; key: string | string[] | undefined }> = [];
  const png = pngBytes(10, 10);
  const provider = createServer((request, response) => {
    calls.push({ path: request.url!, key: request.headers["api-key"] });
    request.resume();
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      data: [{ b64_json: png.toString("base64") }], usage: { input_tokens: 20, output_tokens: 50 },
    }));
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const port = (provider.address() as { port: number }).port;
  const fixtureUser = `fixture_images_${randomBytes(8).toString("hex")}`;
  const grants = (await readFile(new URL("../ops/legacy-decisions-grants.sql", import.meta.url), "utf8"))
    .replaceAll(':"decision_role"', fixtureUser);
  const token = "art_fixture-image-gateway";
  const authorization = `Bearer ${token}`;
  const f = await startFixture({
    config: "test/legacy-decisions.wrangler.jsonc",
    entrypoint: fileURLToPath(new URL("./legacy-bots-images-entry.ts", import.meta.url)),
    databaseRole: { grants, fixtureUser }, noCamelfsTier: true,
    tenants: [{ id: "camel-bots", token }],
    vars: {
      TEST_MODE: "1",
      AGENT_CREATE_DIAGNOSTICS: "1",
      AGENT_TENANTS_JSON: JSON.stringify({ platformKeys: { openai: "local-openai" }, tenants: {} }),
      AGENT_AZURE_OPENAI_ENDPOINT: `http://127.0.0.1:${port}`,
      AGENT_AZURE_OPENAI_API_KEY: "local-azure",
      AGENT_AZURE_IMAGE_DEPLOYMENT: "image-fixture",
      LEGACY_BOTS_IMAGES_AUTH_SHA256: createHash("sha256").update(authorization).digest("hex"),
    },
  });
  t.after(() => f.stop());
  const now = Date.now();
  await f.db.query("insert into end_user_settings (tenant,enabled,updated_at) values ('camel-bots',true,$1)", [now]);
  await f.db.query("insert into end_users (tenant,id,balance,created_at,updated_at) values ('camel-bots','fixture-owner',1000000,$1,$1)", [now]);
  await f.db.query("insert into end_user_lots (tenant,end_user,key,amount,remaining,expires_at,created_at) values ('camel-bots','fixture-owner','first',1000000,1000000,$1,$2)", [now + 300_000, now]);
  const bot = "0123456789abcdef";
  const body = { prompt: "A synthetic image", context: { bot }, subject: "fixture-owner", bucket: `bot:${bot}` };
  const send = (input: unknown, auth = authorization) => fetch(`${f.url}/v1/images`, {
    method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(input),
  });
  assert.equal((await send({ ...body, images: [{ data: "AAAA" }] })).status, 418);
  assert.equal((await send(body, "Bearer art_other")).status, 418);
  const refused = await send({ ...body, subject: "unfunded" });
  assert.equal(refused.status, 402, f.worker.logs());
  assert.equal((await refused.json() as { code: string }).code, "END_USER_CREDIT");
  assert.equal(calls.length, 0);

  const response = await send(body);
  const result = await response.json() as { costUsd: number; images: Array<{ data: string; contentType: string; width: number; height: number }> };
  assert.equal(response.status, 200, JSON.stringify(result) + f.worker.logs());
  assert.deepEqual(result.images, [{ data: png.toString("base64"), contentType: "image/png", width: 10, height: 10 }]);
  assert.deepEqual(calls, [{ path: "/openai/deployments/image-fixture/images/generations?api-version=2025-04-01-preview", key: "local-azure" }]);
  const debits = await f.db.query("select bucket,amount from end_user_ledger where tenant='camel-bots' and kind='usage'");
  assert.deepEqual(debits.rows, [{ bucket: body.bucket, amount: String(-Math.round(result.costUsd * 1e6)) }]);
  const usage = await f.db.query("select coalesce(sum(cost),0) cost from usage where tenant='camel-bots'");
  assert.equal(Math.round(Number(usage.rows[0].cost) * 1e6), Math.round(result.costUsd * 1e6));
});

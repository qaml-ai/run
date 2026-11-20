import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BrowserTokens } from "../src/browser-tokens.ts";
import { startFixture } from "./fixture.ts";

test("v1 decisions keep request, Jev result, credit refusals and settlement contracts", { timeout: 180_000 }, async t => {
  const calls: { authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const fakeProvider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.equal(request.url, "/decisions");
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    calls.push({ authorization: request.headers.authorization, body });
    response.setHeader("Content-Type", "application/json");
    if (body.state === "rejected") {
      response.statusCode = 422;
      response.end(JSON.stringify({ detail: "fixture rejection" }));
      return;
    }
    response.end(JSON.stringify({
      model: "typesafe/jev-1.14-fixture",
      answers: { matches: { type: "noul", noul: 0.92 } },
      usage: { input_tokens: 128, output_tokens: 8, cost: 0.0005 },
    }));
  });
  fakeProvider.listen(0, "127.0.0.1");
  await once(fakeProvider, "listening");
  t.after(() => { fakeProvider.closeAllConnections(); fakeProvider.close(); });
  const address = fakeProvider.address();
  assert.ok(address && typeof address === "object");

  const fixtureUser = `fixture_decisions_${randomBytes(8).toString("hex")}`;
  const grants = (await readFile(new URL("../ops/legacy-decisions-grants.sql", import.meta.url), "utf8"))
    .replaceAll(':"decision_role"', fixtureUser);
  const apiKey = "art_fixture-decision-tenant";
  const auth = `Bearer ${apiKey}`;
  const camelBotsAuth = "Bearer art_fixture-camel-bots-app";
  const tenantConfig = {
    tenants: {
      none: { tokenSha256: "0".repeat(64), billing: "none" },
      "camel-bots": { tokenSha256: "1".repeat(64), billing: "none", platformKeys: true, decisionConcurrency: 48 },
    },
    platformKeys: { openrouter: "fixture-platform-key" },
  };
  const f = await startFixture({
    config: "test/legacy-decisions.wrangler.jsonc",
    noCamelfsTier: true,
    databaseRole: { grants, fixtureUser },
    entrypoint: fileURLToPath(new URL("./legacy-decisions-entry.ts", import.meta.url)),
    tenants: [
      { id: "fixture", token: apiKey },
      { id: "none", token: "art_fixture-unbilled", billing: "none", seedCredit: false },
      { id: "camel-bots", token: camelBotsAuth.slice(7), billing: "none", seedCredit: false },
    ],
    vars: {
      TEST_MODE: "1", TEST_MODEL: "1", AGENT_CREATE_DIAGNOSTICS: "1",
      AGENT_DECISIONS_URL: `http://127.0.0.1:${address.port}`,
      AGENT_OPENROUTER_CREDIT_MULTIPLIER: "1.2",
      AGENT_TENANTS_JSON: JSON.stringify(tenantConfig),
      LEGACY_DECISIONS_BOTS_AUTH_SHA256: createHash("sha256").update(camelBotsAuth).digest("hex"),
    },
  });
  t.after(() => f.stop());
  const now = Date.now();
  await f.db.query("insert into end_user_settings (tenant,enabled,updated_at) values ('fixture',true,$1)", [now]);
  await f.db.query("insert into end_users (tenant,id,balance,created_at,updated_at) values ('fixture','wallet',1000,$1,$1)", [now]);
  await f.db.query("insert into end_user_lots (tenant,end_user,key,amount,remaining,expires_at,created_at) values ('fixture','wallet','first',1000,1000,$1,$2)", [now + 300_000, now]);
  await f.db.query("insert into webhook_endpoints (id,tenant,url,events,secret,created_at,set_by) values ($1,'fixture','https://fixture.invalid/hook','{usage.recorded}','{}',$2,'fixture')", [randomUUID(), now]);
  await f.db.query("insert into billing_alert_settings (tenant,threshold) values ('fixture',99999500)");
  await f.db.query("insert into billing_recipients (id,tenant,email,status,confirmation_hash,confirmation_expires,created_at) values ($1,'fixture','fixture@example.invalid','verified','fixture',$2,$2)", [randomUUID(), now]);
  const questions = { matches: { type: "noul", instructions: "Is it relevant?" } };
  const item = { state: "accepted", questions };
  const send = (value: unknown, authorization: string | null = auth, headers: Record<string,string> = {}) => fetch(f.url + "/v1/decisions", {
    method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}), ...headers },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  const expectError = async (response: Response, status: number, code: string) => {
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, status, JSON.stringify(body) + f.worker.logs());
    assert.equal(body.code, code);
    return body;
  };

  await expectError(await send(item, null), 401, "UNAUTHORIZED");
  await expectError(await send(item, "Bearer art_invalid"), 401, "UNAUTHORIZED");
  const token = new BrowserTokens(f.token).mint("fixture", `client_${"0".repeat(40)}`, { scopes: ["state"], ttlSeconds: 120 });
  await expectError(await send(item, `Bearer ${token.token}`), 403, "FORBIDDEN");
  const oauth = "aro_fixture_decision_access";
  await f.db.query("insert into oauth_grants (id,tenant,client_id,client_name,scope,resource,created_at) values ('fixture','fixture','fixture','fixture','agents','agents',$1)", [now]);
  await f.db.query("insert into oauth_tokens (sha256,kind,grant_id,expires_at) values ($1,'access','fixture',$2)", [
    createHash("sha256").update(oauth).digest("hex"), now + 60_000,
  ]);
  await expectError(await send(item, `Bearer ${oauth}`), 403, "FORBIDDEN");
  const session = randomBytes(32).toString("base64url");
  await f.db.query("insert into console_sessions (sha256,tenant,method,created_at,expires_at) values ($1,'none','github',$2,$3)", [
    createHash("sha256").update(session).digest("hex"), now, now + 60_000,
  ]);
  const consoleHeaders = { cookie: `ar_session=${session}`, "x-agent-runtime-console": "1" };
  await expectError(await send(item, null, { ...consoleHeaders, origin: "https://unrelated.invalid" }), 403, "FORBIDDEN");
  await expectError(await send("{bad-json"), 400, "INVALID_REQUEST");
  await expectError(await send({ ...item, subject: "wallet", bucket: "with a space" }), 400, "INVALID_REQUEST");
  await expectError(await send({ ...item, maxUsd: 1e-9 }), 402, "SPEND_LIMIT");
  const denied = await expectError(await send({ ...item, subject: "empty", bucket: "builder" }), 402, "END_USER_CREDIT");
  assert.deepEqual({ endUser: denied.endUser, bucket: denied.bucket, reason: denied.reason }, { endUser: "empty", bucket: "builder", reason: "balance" });
  assert.equal(calls.length, 0);

  const response = await send({ ...item, dataCollection: "deny", subject: "wallet", actor: "builder", bucket: "builder", context: { bot: "fixture" } });
  const answer = await response.json() as Record<string, unknown>;
  if (!response.ok) await setTimeout(300); // Wrangler flushes request diagnostics after the response.
  assert.equal(response.status, 200, JSON.stringify(answer) + f.worker.logs());
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(typeof answer.ms, "number");
  assert.deepEqual({ ...answer, ms: 0 }, { model: "typesafe/jev-1.14-fixture", answers: { matches: { type: "noul", noul: 0.92 } },
    usage: { inputTokens: 128, outputTokens: 8 }, costUsd: 0.0005, ms: 0 });
  assert.equal(calls[0]?.authorization, "Bearer fixture-platform-key");
  assert.deepEqual(calls[0]?.body.provider, { data_collection: "deny" });
  assert.equal((await f.db.query("select balance from end_users where tenant='fixture' and id='wallet'")).rows[0].balance, "400");
  assert.equal((await f.db.query("select remaining from end_user_lots where tenant='fixture' and end_user='wallet'")).rows[0].remaining, "400");
  const { rows: [debit] } = await f.db.query("select kind,amount,raw,bucket,metadata from end_user_ledger where tenant='fixture'");
  assert.equal(debit.raw, "600");
  assert.equal(debit.amount, "-600");
  assert.equal(debit.kind, "usage");
  assert.equal(debit.metadata.call, "decision");
  assert.equal(debit.bucket, "builder");
  const { rows: [paid] } = await f.db.query("select amount,metadata from credit_ledger where tenant='fixture' and kind='usage'");
  assert.equal(paid.amount, "-600");
  assert.equal(Number(paid.metadata.decision), 600);
  assert.equal((await f.db.query("select kind from billing_email_outbox where tenant='fixture'")).rows[0].kind, "low");
  const { rows: [event] } = await f.db.query("select body from webhook_deliveries where tenant='fixture'");
  assert.equal(event.body.data.kind, "decision");
  assert.equal(event.body.data.subject, "wallet");
  assert.equal(event.body.data.actor, "builder");
  assert.deepEqual(event.body.data.context, { bot: "fixture" });

  await expectError(await send({ ...item, state: "rejected", subject: "wallet" }), 400, "DECISION_REFUSED");
  assert.equal((await f.db.query("select count(*) from end_user_ledger where tenant='fixture'")).rows[0].count, "1");
  const batch = await send({ items: [{ ...item, state: "rejected" }, item], dataCollection: null }, "Bearer art_fixture-unbilled");
  const results = await batch.json() as { costUsd: number; results: Record<string, unknown>[] };
  assert.equal(batch.status, 200, JSON.stringify(results) + f.worker.logs());
  assert.equal(results.costUsd, 0.0005);
  assert.equal((results.results[0]?.error as { code: string }).code, "DECISION_REFUSED");
  assert.deepEqual(results.results[1]?.answers, { matches: { type: "noul", noul: 0.92 } });
  assert.equal((await f.db.query("select count(*) from credit_ledger where tenant='none'")).rows[0].count, "0");
  assert.equal((await f.db.query("select platform_cost from usage where tenant='none'")).rows[0].platform_cost, 0.0006);
  assert.equal((await send(item, null, { ...consoleHeaders, origin: f.url })).status, 200, f.worker.logs());
  assert.equal((await fetch(f.url + "/v1/me")).status, 418);

  const sendApp = (body: unknown, authorization: string | null = camelBotsAuth, host = "run.camelai.com") =>
    send(body, authorization, { "x-test-camel-bots": host });
  const priorCalls = calls.length;
  await expectError(await sendApp(item, auth), 401, "UNAUTHORIZED");
  await expectError(await sendApp(item, null), 401, "UNAUTHORIZED");
  await expectError(await sendApp(item, `Bearer ${oauth}`), 401, "UNAUTHORIZED");
  assert.equal((await sendApp(item, camelBotsAuth, "unrelated.example")).status, 418);
  await expectError(await sendApp("{"), 400, "INVALID_REQUEST");
  assert.equal(calls.length, priorCalls);

  await f.db.query("insert into end_user_settings (tenant,enabled,updated_at,allowances) values ('camel-bots',true,$1,$2)",
    [now, JSON.stringify({ "decide:allowance": 1000 })]);
  await f.db.query("insert into end_users (tenant,id,balance,created_at,updated_at) values ('camel-bots','app-wallet',1000,$1,$1)", [now]);
  await f.db.query("insert into end_user_lots (tenant,end_user,key,amount,remaining,expires_at,created_at) values ('camel-bots','app-wallet','first',1000,1000,$1,$2)", [now + 300_000, now]);
  await expectError(await sendApp({ ...item, subject: "empty", bucket: "decide:another-bot" }), 402, "END_USER_CREDIT");
  assert.equal(calls.length, priorCalls);
  const appDebit = await sendApp({ ...item, subject: "app-wallet", bucket: "decide:another-bot",
    context: { bot: "b1122334455667788" } }, camelBotsAuth, "agents.camelai.dev");
  const appAnswer = await appDebit.json() as { costUsd: number };
  assert.equal(appDebit.status, 200, JSON.stringify(appAnswer) + f.worker.logs());
  assert.equal(appAnswer.costUsd, 0.0005);
  const { rows: [appUsage] } = await f.db.query("select end_user, amount, bucket from end_user_ledger where tenant='camel-bots'");
  assert.deepEqual(appUsage, { end_user: "app-wallet", amount: "-600", bucket: "decide:another-bot" });

  const appAllowance = await sendApp({ ...item, subject: "no-paid-balance", bucket: "decide:allowance" });
  const allowanceAnswer = await appAllowance.json() as { costUsd: number };
  assert.equal(appAllowance.status, 200, JSON.stringify(allowanceAnswer) + f.worker.logs());
  assert.equal(allowanceAnswer.costUsd, 0.0005);
  const { rows: [allowance] } = await f.db.query("select amount, allowance from end_user_ledger where tenant='camel-bots' and end_user='no-paid-balance'");
  assert.deepEqual(allowance, { amount: "0", allowance: "600" });

  // The app's prompt categorizer sends standalone batches without a bot or wallet.
  const categorizer = await sendApp({ items: [item], actor: "ops:prompt-categories", dataCollection: "deny" });
  const categorized = await categorizer.json() as { costUsd: number };
  assert.equal(categorizer.status, 200, JSON.stringify(categorized) + f.worker.logs());
  assert.equal(categorized.costUsd, 0.0005);
  assert.equal(calls.length, priorCalls + 3);
  assert.equal((await f.db.query("select count(*) from end_user_ledger where tenant='camel-bots'")).rows[0].count, "2");
  assert.equal((await f.db.query("select sum(responses) as responses from usage where tenant='camel-bots'")).rows[0].responses, "3");
  const appKeyHash = createHash("sha256").update(camelBotsAuth.slice(7)).digest("hex");
  await f.db.query("update api_tokens set tenant='fixture' where sha256=$1", [appKeyHash]);
  await expectError(await sendApp(item), 401, "UNAUTHORIZED");
  assert.equal(calls.length, priorCalls + 3);

  const restricted = await f.db.connect();
  try {
    await restricted.query(`set role ${fixtureUser}`);
    await assert.rejects(restricted.query("delete from end_user_ledger where false"), { code: "42501" });
    await assert.rejects(restricted.query("select secret from webhook_endpoints limit 0"), { code: "42501" });
    await assert.rejects(restricted.query("update credit_ledger set kind='grant' where false"), { code: "42501" });
  } finally {
    await restricted.query("reset role");
    restricted.release();
  }
  // The original database token was used, including its stored hash.
  assert.equal((await f.db.query("select count(*) from api_tokens where sha256 = $1", [createHash("sha256").update(apiKey).digest("hex")])).rows[0].count, "1");
});

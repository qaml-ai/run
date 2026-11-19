import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { Accounts } from "../src/accounts.ts";
import { EndUserCredits } from "../src/end-user-credits.ts";
import { ATTEMPT_STALE_MS } from "../src/model-attempts.ts";
import { outboundFromEnvironment } from "../src/outbound.ts";
import { tenantsFromEnvironment } from "../src/tenants.ts";
import { runMaintenanceJobs, withMaintenanceElection } from "../src/v1-maintenance-election.ts";
import { enqueueEvents, signedHeaders, usageEvent, Webhooks } from "../src/webhooks.ts";
import { testDatabase } from "./database.ts";
import { listen, until } from "./runtime-server.ts";

test("active v1 ECS leases prevent election, including when a peer returns after startup", async () => {
  const { db } = await testDatabase();
  const peer = () => db.query("insert into runtime_nodes (node,session,expires_at) values ('http://old',gen_random_uuid(),now()+interval '1 minute')");
  await peer();
  const signal = new AbortController().signal;
  await assert.rejects(withMaintenanceElection(db, signal, async () => assert.fail("elected while old ECS is live")), /live lease/);
  await db.query("delete from runtime_nodes where node='http://old'");
  await assert.rejects(withMaintenanceElection(db, signal, async (selected, check) => {
    await peer();
    await runMaintenanceJobs([{ name: "never", intervalMs: 10, run: async () => assert.fail("polled while old ECS is live") }], selected, check, () => {});
  }), /live lease/);
});

test("one Postgres session keeps the election until its admitted poll drains", async () => {
  const { db } = await testDatabase();
  const stop = new AbortController();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const first = withMaintenanceElection(db, stop.signal, (selected, check) => runMaintenanceJobs([
    { name: "one", intervalMs: 10, run: async () => { started.resolve(); await finish.promise; } },
  ], selected, check, () => {}));
  try {
    await started.promise;
    const electAnother = () => withMaintenanceElection(db, new AbortController().signal, async () => assert.fail("elected alongside first runner"));
    await assert.rejects(electAnother(), /already holds/);
    stop.abort();
    await assert.rejects(electAnother(), /already holds/);
  } finally {
    stop.abort();
    finish.resolve();
    await first;
  }
  let elected = false;
  await withMaintenanceElection(db, new AbortController().signal, async () => { elected = true; });
  assert.equal(elected, true);
});

test("the standalone runner settles a stale attempt, expires credit once and retries both signed outboxes", async t => {
  const { db, url } = await testDatabase();
  const env = {
    AGENT_DATABASE_URL: url,
    AGENT_TENANT: "t",
    AGENT_OPERATOR_TOKEN: "test-mail-and-outboxes-operator",
    AGENT_SECRETS_KEY: "ab".repeat(32),
    AGENT_OUTBOUND_ALLOW_HTTP: "true",
    AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32",
    AGENT_SCHEDULER_INTERVAL_MS: "25",
    AGENT_USAGE_WEBHOOK_RETRY_MS: "25",
  };
  const received: { path?: string; id: string; signature: string; timestamp: string; body: string }[] = [];
  const hookUrl = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const retry = received.some(delivery => delivery.path === req.url);
    received.push({ path: req.url, id: String(req.headers["webhook-id"]), signature: String(req.headers["webhook-signature"]), timestamp: String(req.headers["webhook-timestamp"]), body });
    res.writeHead(retry ? 204 : 503).end();
  });
  const accounts = new Accounts({ tenants: await tenantsFromEnvironment(env), db, secretsKey: env.AGENT_SECRETS_KEY });
  const webhooks = new Webhooks({ db, accounts, outbound: outboundFromEnvironment(env) });
  const standard = await webhooks.create("t", { url: `${hookUrl}/standard`, events: ["usage.recorded"] });
  const legacy = await webhooks.setUsageWebhook("t", `${hookUrl}/legacy`);
  const event = usageEvent("t", "agent", { provider: "openrouter", model: "fixture", usage: { input: 1, output: 2 } })!;
  await enqueueEvents(db, [event]);
  const credits = new EndUserCredits(db);
  await credits.setSettings("t", { enabled: true, allowances: { "*": 0 } });
  await credits.post("t", "u", { kind: "grant", amount: 1_000_000, key: "expiring", expiresAt: Date.now()+60_000 });
  await db.query("update end_user_lots set expires_at=$1 where tenant='t' and end_user='u'", [Date.now()-1]);
  const attempt = randomUUID();
  await db.query(`insert into model_attempts (id,tenant,agent,provider,model,kind,platform,catalog_priced,prepaid,key_hash,started_at,updated_at,next_check_at)
    values ($1,'t','agent','openrouter','fixture','response',false,false,false,$2,$3,$3,$3)`, [attempt, createHash("sha256").update("").digest("hex"), Date.now()-ATTEMPT_STALE_MS-10_000]);

  const worker = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/v1-maintenance.ts", "--ecs-stopped"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const done = once(worker, "exit");
  let logs = "";
  worker.stdout.on("data", chunk => { logs += chunk; });
  worker.stderr.on("data", chunk => { logs += chunk; });
  try {
    await until(async () => {
      assert.equal(worker.exitCode, null, logs);
      const { rows: [state] } = await db.query(`select (select state from model_attempts where id=$1) as attempt,
        (select count(*)::int from end_user_ledger where kind='expiry') as expiries,
        (select count(*)::int from usage_webhook_outbox) + (select count(*)::int from webhook_deliveries) as due`, [attempt]);
      return state.attempt === "settled" && state.expiries === 1 && state.due === 0;
    }, "maintenance queues to settle");
  } finally {
    worker.kill("SIGTERM");
    assert.deepEqual(await done, [0, null], logs);
  }
  assert.doesNotMatch(logs, /v1_maintenance_poll_failed/);
  assert.deepEqual(received.map(delivery => delivery.path).sort(), ["/legacy", "/legacy", "/standard", "/standard"]);
  for (const delivery of received) {
    const isLegacy = delivery.path === "/legacy";
    assert.equal(delivery.id, isLegacy ? event.legacy?.id : event.id);
    assert.equal(delivery.signature, signedHeaders(delivery.id, delivery.body, [isLegacy ? legacy.secret! : standard.secret], Number(delivery.timestamp)*1_000)["webhook-signature"]);
  }
});

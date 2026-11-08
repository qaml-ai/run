import { inboxReceiptFixture } from "./inbox-receipts.ts";
import { seedInbox } from './inbox.ts';
import { createHash, randomBytes } from "node:crypto";
import { seedOpsAccount } from "./ops-seed.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "../../../src/db.ts";
import { EndUserCredits } from "../../../src/end-user-credits.ts";
import { seedJourneyAccount } from "./journey-state.ts";
import { channelQuery } from "./channel-state.ts";
import { EMAIL_TOPIC, snsSigner } from "./email.ts";
import { runtime } from "../../runtime-server.ts";
import { fakeLauncher } from "../../fake-launcher.ts";
import { OPERATOR, OTHER_OPERATOR, sleep, until, untilRequestState, type T } from "../http.ts";
import type { ContractFixture, FixtureOptions, ModelReply, TenantSeed } from "../fixture.ts";
import { fixtureSigner } from "./signing.ts";
import { observePollingResponse } from "../polling.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function createNodeFixture(t: T, options: FixtureOptions = {}): Promise<ContractFixture> {
  const runtimeEnv: Record<string, string> = { AGENT_SECRETS_KEY: randomBytes(32).toString("hex"), ...options.env };
  let respond: ModelReply = options.respond ?? (() => ({ role: "assistant", content: "ok" }));
  let index = 0;
  let imageResizeFailures = 0;
  const pendingDelays = new Set<() => void>();
  const cleanups: Array<() => Promise<void> | void> = [];
  let closed = false;
  // The legacy server helper leaves a scripted delay alive after its request
  // is aborted. Own those timers here so fixture teardown cancels them too.
  const scriptedReply: ModelReply = body => {
    const reply = respond(body, index++) as { delayMs?: number; wait?: Promise<unknown>; [key: string]: unknown };
    if (!reply.delayMs) return reply;
    const { delayMs, wait, ...delta } = reply;
    return { ...delta, wait: Promise.resolve(wait).then(() => new Promise<void>(resolve => {
      if (closed) return resolve();
      const finish = () => { clearTimeout(timer); pendingDelays.delete(finish); resolve(); };
      const timer = setTimeout(finish, delayMs);
      pendingDelays.add(finish);
    })) };
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const finish of pendingDelays) finish();
    const failures: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Node fixture cleanup failed");
  };
  // Register before starting the fake provider or child, so failed startup also
  // closes every resource the original runtime fixture has registered so far.
  t.after(close);
  const tenants: any = structuredClone(options.tenants ?? { tenants: {
    alice: { tokenSha256: hash(OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
    bob: { tokenSha256: hash(OTHER_OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
  } });
  let r: Awaited<ReturnType<typeof runtime>>;
  let sns: ReturnType<typeof snsSigner> | undefined;
  const execArgv: string[] = [];
  const priorModels: ContractFixture["model"][] = [];
  let db: pg.Pool;
  try {
    const databaseUrl = new URL(process.env.AGENT_TEST_DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:55432/postgres");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname)) throw new Error("Contract fixtures require local test Postgres");
    const admin = new pg.Client({ connectionString: databaseUrl.href, connectionTimeoutMillis: 5_000 });
    cleanups.push(() => admin.end());
    await admin.connect();
    const schema = `contract_${randomBytes(10).toString("hex")}`;
    await admin.query(`create schema ${schema}`);
    cleanups.push(async () => { await admin.query(`drop schema ${schema} cascade`); });
    databaseUrl.searchParams.set("options", `-c search_path=${schema}`);
    databaseUrl.searchParams.set("application_name", schema);
    db = new pg.Pool({ connectionString: databaseUrl.href, max: 5 });
    cleanups.push(() => db.end());
    await migrate(db);
    if (options.failImageResizeOnce) {
      const launcher = await fakeLauncher({ after: fn => cleanups.push(async () => { await fn(); }) }, (kind, client) => {
        if (kind !== "parse") return false;
        client.resume(); let head = Buffer.alloc(0);
        const first = (chunk: Buffer) => {
          head = Buffer.concat([head, chunk]);
          if (head.length < 4 || head.length < 4 + head.readUInt32BE(0)) return;
          client.off("data", first);
          if (head.subarray(4, 4 + head.readUInt32BE(0)).toString().includes('"fit":true') && !imageResizeFailures++) return void client.destroy();
          const job = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../../../src/parse-job.ts", import.meta.url))], { stdio: ["pipe", "pipe", "inherit"], env: {} });
          client.on("close", () => job.kill("SIGKILL"));
          job.stdin.on("error", () => {});
          job.stdin.write(head); client.pipe(job.stdin); job.stdout.pipe(client);
        };
        client.on("data", first);
        return true;
      });
      runtimeEnv.AGENT_SANDBOX_DIR = launcher.dir;
    }
    if (options.anthropicFederationEndpoint) runtimeEnv.TEST_ANTHROPIC_FEDERATION_ENDPOINT = options.anthropicFederationEndpoint;
    // Email channels: SES's notifications arrive through SNS, signed with a certificate the runtime fetches from the fixture.
    if (runtimeEnv.AGENT_EMAIL_DOMAIN) {
      sns = snsSigner();
      cleanups.push(sns.cleanup);
      Object.assign(runtimeEnv, { AGENT_EMAIL_SNS_TOPICS: EMAIL_TOPIC, TEST_SNS_CERT_FILE: sns.certFile, AGENT_EMAIL_REGION: "us-west-2",
        AWS_ACCESS_KEY_ID: "fixture", AWS_SECRET_ACCESS_KEY: "fixture-secret", ...options.env });
      execArgv.push("--import", new URL("./sns-fetch.mjs", import.meta.url).href);
    }
    if (options.anthropicFederationEndpoint) execArgv.push("--import", new URL("../../fixtures/anthropic-federation.mjs", import.meta.url).href);
    r = await runtime({ after: fn => cleanups.push(fn) }, scriptedReply, runtimeEnv,
      tenants, { databaseUrl: databaseUrl.href, ...(execArgv.length ? { execArgv } : {}) });
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Node fixture startup and cleanup failed"); }
    throw error;
  }
  const call: ContractFixture["call"] = async (path, init = {}) => {
    const token = init.token === undefined ? OPERATOR : init.token;
    const response = await fetch(r.base + path, {
      redirect: "manual", method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* non-JSON HTTP response */ }
    observePollingResponse(path, response.status, json, init.method ?? (init.body === undefined ? "GET" : "POST"));
    return { status: response.status, json, text, headers: response.headers };
  };
  const stop = async (crash = false) => {
    if (r.child.exitCode === null && r.child.signalCode === null) {
      const stopped = once(r.child, "exit");
      r.child.kill(crash ? "SIGKILL" : "SIGTERM");
      await stopped;
    }
  };
  const restart: ContractFixture["restart"] = async (settings = {}) => {
    const previous = r;
    await stop(settings.crash);
    priorModels.push(previous.model);
    Object.assign(runtimeEnv, settings.env);
    // A restart keeps the original data plane as well as its database. The
    // runtime helper's fresh root is only for the replacement process config.
    runtimeEnv.AGENT_DATA_DIR ??= previous.root;
    index = 0;
    r = await runtime({ after: fn => cleanups.push(fn) }, scriptedReply, runtimeEnv,
      tenants, { databaseUrl: previous.databaseUrl, ...(execArgv.length ? { execArgv } : {}) });
  };
  const model: ContractFixture["model"] = {
    get url() { return r.model.url; },
    get bodies() { return priorModels.length ? [...priorModels.flatMap(m => m.bodies), ...r.model.bodies] : r.model.bodies; },
    get keys() { return priorModels.length ? [...priorModels.flatMap(m => m.keys), ...r.model.keys] : r.model.keys; },
    get headers() { return priorModels.length ? [...priorModels.flatMap(m => m.headers), ...r.model.headers] : r.model.headers; },
  };
  return {
    get base() { return r.base; },
    get logs() { return r.logs; },
    model,
    stop: () => stop(), restart,
    signFileToken: (grant, expiresAt) => fixtureSigner(db, runtimeEnv.AGENT_SECRETS_KEY, r.base).fileToken(grant, expiresAt),
    signIdentityToken: (audience, claims) => fixtureSigner(db, runtimeEnv.AGENT_SECRETS_KEY, r.base).token(audience, claims),
    call,
    async prompt(agent, text, token, extra = {}) {
      const accepted = await call(`/v1/agents/${agent}/prompt`, { body: { text, ...extra }, token });
      if (accepted.status !== 202) throw new Error(`prompt: ${accepted.status} ${accepted.text}`);
      return untilRequestState(async () => (await call(`/v1/agents/${agent}/requests/${accepted.json.id}`, { token })).json,
        "completed", "the turn to end", 60_000);
    },
    setModel(next) { respond = next; index = 0; },
    async imageResizeFailureCount() { return imageResizeFailures; },
    async restartWithLegacyModel(agent, model) {
      await restart();
      const stored = { ...model, baseUrl: r.model.url };
      const updated = await db.query("update agents set header=jsonb_set(header::jsonb,'{config,model}',$2::jsonb)::json where id=$1", [agent, JSON.stringify(stored)]);
      if (updated.rowCount !== 1) throw new Error("Fixture legacy agent not found");
    },
    async seedTenant(id: string, seed: TenantSeed = {}) {
      const token = seed.token ?? (seed.operator === false ? `art_${randomBytes(32).toString("hex")}` : `fixture-${randomBytes(24).toString("hex")}`);
      if (seed.operator !== false) {
        tenants.tenants[id] = { ...tenants.tenants[id], tokenSha256: hash(token), apiKeys: { openrouter: "fixture-model-key" }, ...seed.config,
          ...(seed.billingMode ? { billing: seed.billingMode } : {}) };
        await writeFile(join(r.root, "tenants.json"), JSON.stringify(tenants));
        const before = r.logs.length;
        r.child.kill("SIGHUP");
        await until(() => r.logs.slice(before).some(line => line.includes("tenants_reloaded")), "tenant fixture reload");
      } else {
        await db.query("insert into tenants(id,created_at,billing) values($1,$2,$3) on conflict(id) do nothing", [id, Date.now(), seed.billingMode ?? "prepaid"]);
        await db.query("insert into api_tokens(sha256,id,tenant,name,prefix,created_at) values($1,$2,$3,'contract', 'fixture', $4) on conflict(sha256) do nothing", [hash(token), crypto.randomUUID(), id, Date.now()]);
      }
      if (seed.email) {
        await db.query("insert into tenant_passwords(tenant,email,hash,set_at) values($1,$2,'fixture',0) on conflict(tenant) do update set email=excluded.email", [id, seed.email]);
        if (seed.suppressed) await db.query("insert into billing_email_suppressions(email_hash,created_at) values($1,0) on conflict do nothing", [hash(seed.email)]);
      }
      if (seed.credits !== undefined) {
        if (!Number.isSafeInteger(seed.credits) || seed.credits < 0) throw new Error("Fixture credits must be nonnegative integer micro-USD");
        await db.query("insert into tenants(id,created_at,billing) values($1,$2,$3) on conflict(id) do update set billing=excluded.billing", [id, Date.now(), seed.billingMode ?? (seed.operator === false ? "prepaid" : tenants.tenants[id]?.billing ?? "none")]);
        if (seed.credits) await db.query("with input as (insert into credit_ledger(tenant,kind,amount,idempotency_key,created_at) values($1,'purchase',$2,$3,$4) returning tenant,amount) insert into credit_accounts(tenant,balance,purchased) select tenant,amount,amount from input on conflict(tenant) do update set balance=credit_accounts.balance+excluded.balance,purchased=credit_accounts.purchased+excluded.purchased", [id, seed.credits, `contract:${randomBytes(12).toString("hex")}`, Date.now()]);
      }
      return { id, token };
    },
    ...inboxReceiptFixture(db),
    seedInbox: rows => seedInbox(db, rows),
    async expireInputs(agent) {
      const result = await db.query("update agent_inputs set expires_at = 0 where agent = $1 and state = 'pending'", [agent]);
      if (!result.rowCount) throw new Error("Fixture inputs not found");
    },
    async setScheduleDueAt(agent, schedule, dueAt) {
      const result = await db.query("update schedules set due_at=$3 where agent=$1 and id=$2", [agent, schedule, dueAt]);
      if (result.rowCount !== 1) throw new Error("Fixture schedule not found");
    },
    async seedIdempotencyLock({ tenant, key, fingerprint, createdAt }) {
      await db.query("insert into idempotency_keys(tenant,key,fingerprint,created_at) values($1,$2,$3,$4)", [tenant, key, fingerprint, createdAt]);
    },
    async setScheduleLegacyHistory(agent, schedule, history) {
      const result = await db.query("update schedules set history=$3,due_at=0 where id=$1 and agent=$2", [schedule, agent, history]);
      if (result.rowCount !== 1) throw new Error("Fixture schedule not found");
    },
    async resetChildSettlement(parent) {
      const result = await db.query("update agent_children set ended_at=null,landed_at=null,landed_by=null,state='running',checked_at=0 where parent=$1", [parent]);
      if (!result.rowCount) throw new Error("Fixture child settlement not found");
    },
    async seedLegacyWorkflowDefinition(definition) {
      const result = await db.query(`update definitions set spec = (spec::jsonb || '{"builtins":["workflow"],"workflow":{"instructions":true}}'::jsonb)::json where id = $1`, [definition]);
      if (result.rowCount !== 1) throw new Error("Fixture definition not found");
    },
    async countOAuthRefreshTokens() {
      return (await db.query("select count(*)::int as n from oauth_tokens where kind='refresh' and grant_id is not null")).rows[0].n;
    },
    async ageUsedOAuthRefreshToken(token, milliseconds) {
      const result = await db.query("update oauth_tokens set used_at=used_at-$2 where sha256=$1", [hash(token), milliseconds]);
      if (result.rowCount !== 1) throw new Error("Fixture refresh token not found");
    },
    async revokeOAuthGrants() { await db.query("delete from oauth_grants"); },
    async seedOAuthAccessToken(grant) {
      await db.query("insert into oauth_grants(id,tenant,client_id,client_name,login,scope,resource,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)", [grant.grantId, grant.tenant, grant.clientId, grant.clientName, grant.login, grant.scope, grant.resource, Date.now()]);
      await db.query("insert into oauth_tokens(sha256,kind,grant_id,expires_at) values($1,'access',$2,$3)", [hash(grant.token), grant.grantId, grant.expiresAt]);
    },
    async seedOpsAccount(now) { await seedOpsAccount((text, values) => db.query(text, values), now); },
    async expireAccountEmailLinks() { await db.query("update account_email_links set expires_at=$1", [Date.now() - 1]); },
    async seedConsoleIdentity(tenant, identity) {
      const now = Date.now(), raw = randomBytes(32).toString("base64url");
      if (identity.method === "google") await db.query("insert into tenants(id,google_sub,google_email,created_at) values($1,$2,$3,$4)", [tenant, identity.subject, identity.email ?? null, now]);
      else await db.query("insert into tenants(id,github,github_id,created_at) values($1,$2,$3,$4)", [tenant, identity.login, identity.subject, now]);
      await db.query("insert into console_sessions(sha256,tenant,login,method,created_at,expires_at) values($1,$2,$3,$4,$5,$6)", [hash(raw), tenant, identity.login, identity.method, now, now + 3_600_000]);
      return `ar_session=${raw}`;
    },
    async seedEndUserUsage({ tenant, endUser, bucket, amount, key, metadata, at }) {
      await new EndUserCredits(db).charge(tenant, endUser, bucket, amount, key, metadata, at);
    },
    async seedStripeCustomer(tenant, { customer, legacyCustomer }) {
      await db.query("insert into billing_stripe_customers(tenant,livemode,request_id,customer,created_at) values($1,false,$2,$3,$4)", [tenant, crypto.randomUUID(), customer, Date.now()]);
      if (legacyCustomer) await db.query("insert into credit_accounts(tenant,balance,stripe_customer) values($1,0,$2) on conflict(tenant) do update set stripe_customer=excluded.stripe_customer", [tenant, legacyCustomer]);
    },
    async setRejectRunEvents(enabled) {
      if (enabled) await db.query(`create function reject_run_event() returns trigger language plpgsql as $$ begin
        if new.body->>'type' = 'run.completed' then raise exception 'run event unavailable'; end if;
        return new; end $$;
        create trigger reject_run_event before insert on webhook_deliveries for each row execute function reject_run_event()`);
      else await db.query("drop trigger reject_run_event on webhook_deliveries; drop function reject_run_event()");
    },
    async updateLegacyUsageWebhook(url) { await db.query("update usage_webhooks set url=$1 where tenant='alice'", [url]); },
    seedJourneyAccount: input => seedJourneyAccount(db, input),
    inputIndex: async (agent: string) => (await db.query("select state, version, priority, priority_rank, blocking, responders from agent_inputs where agent=$1 order by created_at, id", [agent])).rows,
    channelQuery: channelQuery(db),
    async deliverEmail(raw, receipt = {}) {
      if (!sns) throw new Error("Email channel cases set AGENT_EMAIL_DOMAIN");
      const response = await fetch(`${r.base}/channels/email/inbound`, { method: "POST", headers: { "Content-Type": "text/plain; charset=UTF-8" }, body: JSON.stringify(sns.notification(raw, receipt, runtimeEnv.AGENT_EMAIL_DOMAIN)) });
      await response.arrayBuffer();
      return response.status;
    },
    async drain() {
      const exited = once(r.child, "exit");
      r.child.kill("SIGTERM");
      await exited;
    },
    async waitForAgentIdle(agent) {
      await until(async () => !(await db.query("select node from actor_owners where actor=$1", [agent])).rows[0]?.node, "the idle agent to be released", 20_000);
    },
    async advanceInboxVersion(agent) {
      await db.query("update agent_inputs set version=version+1 where agent=$1 and state='pending'", [agent]);
    },
    async failInboxAgent(agent) {
      await until(async () => !(await db.query("select node from actor_owners where actor=$1", [agent])).rows[0]?.node, "unloaded inbox agent", 20_000);
      // Make the authoritative header unreadable, before any answer can be committed.
      await db.query("update agents set header=jsonb_set(header::jsonb,'{sources,builtins}','{}')::json where id=$1", [agent]);
    },
    async failAgentLoad(agent) {
      await db.query("update agents set pending_runs=true,header=jsonb_set(header::jsonb,'{version}','99')::json where id=$1", [agent]);
    },
    async agentRecovery(agent) {
      const row = (await db.query("select resume_failures,resume_after from agents where id=$1", [agent])).rows[0];
      if (!row) throw new Error("Fixture agent not found");
      return { failures: row.resume_failures, retryAt: Number(row.resume_after) };
    },
    async setAgentRecovery(agent, state) {
      await db.query("update agents set resume_failures=coalesce($2,resume_failures),resume_after=coalesce($3,resume_after) where id=$1", [agent, state.failures ?? null, state.retryAt ?? null]);
    },
    async failNextAdmissionWrite(agent) {
      // The fixture owns its schema; this fault affects only the named agent.
      if (!/^client_[a-zA-Z0-9_-]+$/.test(agent)) throw new Error("Invalid fixture agent id");
      await db.query(`create sequence mark_fails;
        create function mark_fails() returns trigger language plpgsql as $$ begin
          if new.id='${agent}' and not old.pending_runs and new.pending_runs and nextval('mark_fails')=1 then raise exception 'injected failure'; end if;
          return new; end $$;
        create trigger mark_fails before update on agents for each row execute function mark_fails();`);
    },
    async now() { return Date.now(); },
    async advanceTime(ms) { await sleep(ms); }, close,
  };
}

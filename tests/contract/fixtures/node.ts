import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { migrate } from "../../../src/db.ts";
import { EndUserCredits } from "../../../src/end-user-credits.ts";
import { runtime } from "../../runtime-server.ts";
import { OPERATOR, OTHER_OPERATOR, sleep, until, type T } from "../http.ts";
import type { ContractFixture, FixtureOptions, ModelReply, TenantSeed } from "../fixture.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function createNodeFixture(t: T, options: FixtureOptions = {}): Promise<ContractFixture> {
  let respond: ModelReply = options.respond ?? (() => ({ role: "assistant", content: "ok" }));
  let index = 0;
  const cleanups: Array<() => Promise<void> | void> = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
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
    r = await runtime({ after: fn => cleanups.push(fn) }, (body) => respond(body, index++), options.env,
      tenants, { databaseUrl: databaseUrl.href });
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
    return { status: response.status, json, text, headers: response.headers };
  };
  return {
    get base() { return r.base; },
    get logs() { return r.logs; },
    get model() { return r.model; },
    call,
    prompt: (agent, text, token, extra) => r.prompt(agent, text, token, extra),
    setModel(next) { respond = next; index = 0; },
    async restartWithLegacyModel(agent, model) {
      const previous = r;
      if (previous.child.exitCode === null && previous.child.signalCode === null) {
        const stopped = once(previous.child, "exit");
        previous.child.kill("SIGTERM");
        await stopped;
      }
      index = 0;
      r = await runtime({ after: fn => cleanups.push(fn) }, body => respond(body, index++), options.env,
        tenants, { databaseUrl: previous.databaseUrl });
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
    async countOAuthRefreshTokens() {
      return (await db.query("select count(*)::int as n from oauth_tokens where kind='refresh' and grant_id is not null")).rows[0].n;
    },
    async ageUsedOAuthRefreshToken(token, milliseconds) {
      const result = await db.query("update oauth_tokens set used_at=used_at-$2 where sha256=$1", [hash(token), milliseconds]);
      if (result.rowCount !== 1) throw new Error("Fixture refresh token not found");
    },
    async revokeOAuthGrants() { await db.query("delete from oauth_grants"); },
    async seedEndUserUsage({ tenant, endUser, bucket, amount, key, metadata, at }) {
      await new EndUserCredits(db).charge(tenant, endUser, bucket, amount, key, metadata, at);
    },
    async seedStripeCustomer(tenant, { customer, legacyCustomer }) {
      await db.query("insert into billing_stripe_customers(tenant,livemode,request_id,customer,created_at) values($1,false,$2,$3,$4)", [tenant, crypto.randomUUID(), customer, Date.now()]);
      if (legacyCustomer) await db.query("insert into credit_accounts(tenant,balance,stripe_customer) values($1,0,$2) on conflict(tenant) do update set stripe_customer=excluded.stripe_customer", [tenant, legacyCustomer]);
    },
    async waitForAgentIdle(agent) {
      await until(async () => !(await db.query("select node from actor_owners where actor=$1", [agent])).rows[0]?.node, "the idle agent to be released", 20_000);
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

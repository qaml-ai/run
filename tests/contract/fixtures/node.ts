import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { migrate } from "../../../src/db.ts";
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
    r = await runtime({ after: fn => cleanups.push(fn) }, (body) => respond(body, index++), {
      AGENT_VERIFY_KEYS: "false", ...options.env,
    }, tenants, { databaseUrl: databaseUrl.href });
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
    base: r.base, logs: r.logs, call, prompt: r.prompt, model: r.model,
    setModel(next) { respond = next; index = 0; },
    async seedTenant(id: string, seed: TenantSeed = {}) {
      const token = seed.token ?? `fixture-${randomBytes(24).toString("hex")}`;
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
    async now() { return Date.now(); },
    async advanceTime(ms) { await sleep(ms); }, close,
  };
}

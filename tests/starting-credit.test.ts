import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Accounts } from "../src/accounts.ts";
import { postLedger } from "../src/billing.ts";
import { migrate, type Db } from "../src/db.ts";
import { DEFAULT_PRICING, micros } from "../src/pricing.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";

const DAY = 86_400_000;
// Fixture policy, independent of production configuration.
const policy = { minAccountAgeMs: 7 * DAY };
const person = (id: number, login: string, ageDays = 100) => ({ id, login, createdAt: Date.now() - ageDays * DAY });
async function accountsOn(db: Db, startingGrant = micros(5)) {
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: {} }) });
  await tenants.reload();
  return new Accounts({ db, tenants, pricing: { ...DEFAULT_PRICING, startingGrant } });
}
const count = async (db: Db, table: string) => Number((await db.query(`select count(*) as n from ${table}`)).rows[0].n);

test("a refused signup is permanent across time, login changes and policy changes", async t => {
  const { db } = await testDatabase();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const account = await accountsOn(db);
  const user = person(701, "first", 1);
  const tenant = await account.tenantForGithub(user, policy);
  assert.deepEqual(await account.billing.startingCredit(tenant), { status: "not_eligible", amount: 0 });
  const decision = (await db.query("select * from starting_credit_decisions")).rows[0];
  now += 60 * DAY;
  const changed = await accountsOn(db, micros(12));
  assert.equal(await changed.tenantForGithub({ ...user, login: "renamed" }, { minAccountAgeMs: 0 }), tenant);
  assert.equal((await changed.billing.summary(tenant)).balance, 0);
  assert.equal(await count(db, "credit_ledger"), 0);
  assert.deepEqual((await db.query("select * from starting_credit_decisions")).rows[0], decision);
});

test("concurrent signups grant once and retain the awarded amount after configuration changes", async () => {
  const { db } = await testDatabase();
  const first = await accountsOn(db), second = await accountsOn(db);
  const user = person(702, "shared");
  assert.deepEqual(new Set(await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).tenantForGithub(user, policy)))), new Set(["shared"]));
  const changed = await accountsOn(db, micros(12));
  await changed.tenantForGithub(user, policy);
  assert.equal(await count(db, "tenants"), 1);
  assert.equal(await count(db, "starting_credit_decisions"), 1);
  assert.equal(await count(db, "credit_ledger"), 1);
  assert.deepEqual(await changed.billing.startingCredit("shared"), { status: "granted", amount: micros(5) });
  assert.equal((await changed.billing.summary("shared")).balance, micros(5));
});

test("missing profile or policy data cannot leave a partly created signup; existing accounts still sign in", async () => {
  const { db } = await testDatabase();
  const accounts = await accountsOn(db);
  for (const createdAt of [undefined, NaN, Infinity, -1, Date.now() + DAY]) {
    await assert.rejects(accounts.tenantForGithub({ id: 703, login: "retry", createdAt }, policy), /details are unavailable/);
  }
  await assert.rejects(accounts.tenantForGithub(person(703, "retry")), /not configured/);
  assert.equal(await count(db, "tenants"), 0);
  assert.equal(await count(db, "credit_ledger"), 0);
  assert.equal(await count(db, "starting_credit_decisions"), 0);
  await accounts.tenantForGithub(person(703, "retry"), policy);
  assert.equal(await accounts.tenantForGithub({ id: 703, login: "retry" }), "retry");
  assert.deepEqual(await accounts.billing.startingCredit("retry"), { status: "granted", amount: micros(5) });
});

test("signup rolls back its tenant and grant if recording the decision fails", async () => {
  const { db } = await testDatabase();
  let fail = true;
  const flaky = {
    query: (...args: any[]) => (db.query as any)(...args),
    connect: async () => {
      const client = await db.connect();
      const query = client.query.bind(client);
      return Object.assign(client, { query: async (...args: any[]) => {
        if (fail && String(args[0]).includes("insert into starting_credit_decisions")) { fail = false; throw new Error("recording failed"); }
        return (query as any)(...args);
      } });
    },
  } as unknown as Db;
  const accounts = await accountsOn(flaky);
  const user = person(704, "atomic");
  await assert.rejects(accounts.tenantForGithub(user, policy), /recording failed/);
  for (const table of ["tenants", "credit_ledger", "credit_accounts", "starting_credit_decisions"]) assert.equal(await count(db, table), 0, table);
  await accounts.tenantForGithub(user, policy);
  assert.equal((await accounts.billing.summary("atomic")).balance, micros(5));
});

test("support uses the signup key, preserves the decision and keeps its reason private", async () => {
  const { db } = await testDatabase();
  const accounts = await accountsOn(db);
  await accounts.tenantForGithub(person(705, "support", 1), policy);
  const before = (await db.query("select decision, signup_at from starting_credit_decisions")).rows[0];
  assert.equal((await accounts.billing.summary("support")).balance, 0); // Populate the balance cache.
  const grants = await Promise.all(Array.from({ length: 8 }, () => accounts.billing.grantStartingCredit("support", micros(9), "Reviewed private eligibility evidence", "operator")));
  assert.equal(new Set(grants.map(row => row.id)).size, 1);
  assert.equal(await count(db, "credit_ledger"), 1);
  assert.deepEqual(await accounts.billing.startingCredit("support"), { status: "granted", amount: micros(9) });
  assert.equal((await accounts.billing.summary("support")).balance, micros(9));
  assert.deepEqual((await db.query("select decision, signup_at from starting_credit_decisions")).rows[0], before);
  assert.deepEqual(grants[0].metadata, { reason: "Starting credit" });
  assert.equal((await db.query("select support_note from starting_credit_decisions")).rows[0].support_note, "Reviewed private eligibility evidence");
  assert.equal((await db.query("select idempotency_key from credit_ledger")).rows[0].idempotency_key, "grant:github:705");
  await assert.rejects(accounts.billing.grantStartingCredit("support", micros(10), "different", "operator"), /different starting-credit grant/);
  await accounts.tenantForGithub(person(705, "support"), { minAccountAgeMs: 0 });
  assert.equal(await count(db, "credit_ledger"), 1);
});

test("an identity cannot obtain another grant by recreating its tenant", async () => {
  const { db } = await testDatabase();
  const accounts = await accountsOn(db);
  await accounts.tenantForGithub(person(706, "original"), policy);
  await db.query("delete from tenants where id = 'original'");
  await accounts.tenantForGithub(person(706, "replacement"), policy);
  assert.deepEqual(await accounts.billing.startingCredit("replacement"), { status: "not_granted", amount: 0 });
  assert.equal((await accounts.billing.summary("replacement")).balance, 0);
  await assert.rejects(accounts.billing.grantStartingCredit("replacement", micros(5), "retry", "operator"), /another tenant/);
  assert.equal(await count(db, "credit_ledger"), 1);
});

test("a disabled signup grant is not awarded when grants are enabled later", async () => {
  const { db } = await testDatabase();
  const disabled = await accountsOn(db, 0);
  await disabled.tenantForGithub(person(707, "disabled"));
  const enabled = await accountsOn(db);
  await enabled.tenantForGithub(person(707, "disabled"), policy);
  assert.deepEqual(await enabled.billing.startingCredit("disabled"), { status: "not_applicable", amount: 0 });
  assert.equal(await count(db, "credit_ledger"), 0);
});

test("migration preserves historical grants and never gives legacy accounts catch-up credit", async () => {
  const { db } = await testDatabase({ migrate: false });
  const earlier = mkdtempSync(join(tmpdir(), "starting-credit-migration-"));
  try {
    const source = fileURLToPath(new URL("../migrations", import.meta.url));
    for (const name of readdirSync(source).filter(name => name < "031")) cpSync(join(source, name), join(earlier, name));
    await migrate(db, earlier);
    await db.query(`insert into tenants (id, github, github_id, created_at) values
      ('awarded', 'awarded', 708, 1), ('unawarded', 'unawarded', 709, 1), ('unlinked', 'unlinked', null, ${Date.now()})`);
    await postLedger(db, [{ tenant: "awarded", kind: "grant", amount: micros(3), key: "grant:github:708" }]);
    await migrate(db);
    const accounts = await accountsOn(db);
    assert.deepEqual(await accounts.billing.startingCredit("awarded"), { status: "granted", amount: micros(3) });
    assert.deepEqual(await accounts.billing.startingCredit("unawarded"), { status: "not_granted", amount: 0 });
    await accounts.tenantForGithub(person(709, "unawarded"), policy);
    await accounts.tenantForGithub(person(710, "unlinked"), policy);
    assert.deepEqual(await accounts.billing.startingCredit("unlinked"), { status: "not_granted", amount: 0 });
    assert.equal(await count(db, "credit_ledger"), 1);
    assert.equal(await count(db, "starting_credit_decisions"), 3);
  } finally { rmSync(earlier, { recursive: true }); }
});

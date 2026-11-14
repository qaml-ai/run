import assert from "node:assert/strict";
import test from "node:test";
import { Billing } from "../src/billing.ts";
import { AgentInvocation } from "../src/agent-invocation.ts";
import type { Db } from "../src/postgres.ts";
import { databaseTenants } from "../src/billing-host.ts";

function fixture() {
  const statements: string[] = [];
  let balance = 0;
  const db = {
    async query(sql: string) {
      if (sql.includes("from tenants")) {
        statements.push("tenant");
        return { rows: [{ billing: "prepaid", limits: { maxBusyAgents: 2 } }] };
      }
      assert.match(sql, /credit_spend_minutes/);
      statements.push("account");
      return { rows: [{ balance, purchased: 1, last_hour: "0", disputed: false }] };
    },
  } as unknown as Db;
  return { billing: new Billing({ db, tenants: databaseTenants }), statements, fund: () => { balance = 1; } };
}

test("pre-read tenant policy and account skip SQL, with the same refusal as the ordinary read", async () => {
  const { billing, statements } = fixture();
  const row = await billing.readTenant("tenant");
  const account = await billing.readAccount("tenant");
  statements.length = 0;
  const reads = { row: async () => row, account: async () => account };
  const refusal = await billing.creditLimit("tenant", reads);
  assert.equal(refusal?.code, "INSUFFICIENT_CREDIT");
  assert.deepEqual(await billing.busyLimit("tenant", undefined, reads), { limit: 2, source: "tenant" });
  assert.deepEqual(statements, []);

  assert.equal((await billing.creditLimit("tenant"))?.message, refusal.message);
  assert.deepEqual(statements, ["tenant", "account"]);
});

test("tenant reads join within an invocation and fresh balances bypass Billing's cache", async () => {
  const { billing, statements, fund } = fixture();
  const invocation = new AgentInvocation();
  assert.deepEqual(await Promise.all([
    billing.mode("tenant", undefined, invocation.tenant(billing, "tenant")),
    billing.mode("tenant", undefined, invocation.tenant(billing, "tenant")),
  ]), ["prepaid", "prepaid"]);
  await billing.mode("tenant", undefined, new AgentInvocation().tenant(billing, "tenant"));
  assert.equal((await billing.account("tenant")).balance, 0);
  fund();
  assert.equal((await billing.readAccount("tenant")).balance, 1);
  assert.deepEqual(statements, ["tenant", "tenant", "account", "account"]);
});

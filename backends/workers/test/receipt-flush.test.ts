import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Client } from "pg";
import { Accounts } from "../src/accounts.ts";
import { database } from "../src/postgres.ts";
import { createTenants, keyServices } from "../src/security-services.ts";

const env = { HYPERDRIVE: { connectionString: "postgres://localhost/unused" } };

function recordBalanceQueries(t: TestContext) {
  const queries: string[] = [];
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "end", async () => {});
  t.mock.method(Client.prototype, "query", async (sql: string) => {
    queries.push(sql);
    const rows = sql.includes("left join credit_accounts")
      ? [{ balance: 123, purchased: 0, last_hour: 0, disputed: false }]
      : [];
    return { rows, rowCount: rows.length };
  });
  return queries;
}

test("a Workers balance read only queries the balance", async t => {
  const queries = recordBalanceQueries(t);
  const { accounts } = await keyServices(env);

  assert.equal((await accounts.billing.account("tenant")).balance, 123);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /left join credit_accounts/);
});

test("Accounts flushes durable receipts before reading a balance by default", async t => {
  const queries = recordBalanceQueries(t);
  const accounts = new Accounts({ tenants: await createTenants({}), db: database(env) });

  assert.equal((await accounts.billing.account("tenant")).balance, 123);
  assert.equal(queries.length, 4);
  assert.equal(queries[0], "begin");
  assert.match(queries[1], /from pi_usage_receipts\s+where not accounted .*for update skip locked/);
  assert.equal(queries[2], "commit");
  assert.match(queries[3], /left join credit_accounts/);
});

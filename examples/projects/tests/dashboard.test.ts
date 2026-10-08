import assert from "node:assert/strict";
import { after, test } from "node:test";
import { SampleDb } from "../dashboard/db.ts";
import { dashboardValidator } from "../dashboard/validate.ts";
import { files } from "./fixtures.ts";

const db = new SampleDb();
after(() => db.close());
const validate = dashboardValidator(db);

const spec = (charts: unknown[]) => JSON.stringify({ title: "Sales", charts });
const revenue = { title: "Revenue by category", type: "bar", query: "queries/revenue.sql", x: "category", y: ["revenue"] };
const REVENUE_SQL = "SELECT p.category, SUM(o.quantity * p.price) AS revenue FROM orders o JOIN products p ON p.id = o.product_id GROUP BY 1";

test("a dashboard whose queries run and return its columns is published with only the files it uses", async () => {
  const result = await validate(files({ "dashboard.json": spec([revenue]), "queries/revenue.sql": REVENUE_SQL, "notes.md": "scratch" }));
  assert.deepEqual(result.problems, []);
  assert.deepEqual([...result.files!.keys()], ["dashboard.json", "queries/revenue.sql"]);
});

test("the spec is checked against its schema", async () => {
  assert.deepEqual((await validate(files({ "dashboard.json": "{" }))).problems[0].path, "dashboard.json");
  const { problems } = await validate(files({ "dashboard.json": spec([{ ...revenue, type: "pie", query: "revenue.sql" }]) }));
  assert.deepEqual(problems, [
    { path: "dashboard.json", message: "/charts/0/type: must be one of bar, line, table, number" },
    { path: "dashboard.json", message: "/charts/0/query: must match pattern \"^queries/[A-Za-z0-9_-]+\\.sql$\"" },
  ]);
});

test("every query runs, read-only, and must return what its chart draws", async () => {
  const check = async (sql: string, chart: object = revenue) =>
    (await validate(files({ "dashboard.json": spec([chart]), "queries/revenue.sql": sql }))).problems.map(problem => problem.message);
  assert.deepEqual(await check("SELECT category, SUM(total) AS revenue FROM orders GROUP BY 1"), ["no such column: category"]);
  assert.deepEqual(await check("SELECT category, COUNT(*) AS n FROM products GROUP BY 1"),
    [`dashboard.json: charts[0] "Revenue by category": the query returns no column revenue (it returns category, n)`]);
  assert.deepEqual(await check("SELECT category, name AS revenue FROM products"), [`dashboard.json: charts[0] "Revenue by category": y column revenue must be numbers`]);
  assert.deepEqual(await check("DELETE FROM orders"), ["A query must return rows (a SELECT)"]);
  assert.deepEqual(await check("SELECT 1 AS category, 2 AS revenue; DROP TABLE orders"), ["One statement per query"]);
  assert.deepEqual(await check("SELECT * FROM orders"), ["Returns more than 1000 rows: aggregate, or add a LIMIT"]);
  assert.deepEqual(await check("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT 'all' AS category, COUNT(*) AS revenue FROM c"), ["Took longer than 2 s"]);
  // The data is still there, and queries run again after one was stopped.
  assert.deepEqual(await check(REVENUE_SQL), []);
  assert.deepEqual(await check("SELECT COUNT(*) AS orders FROM orders", { title: "Orders", type: "number", query: "queries/revenue.sql", y: ["orders"] }), []);
});

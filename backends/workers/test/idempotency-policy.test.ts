import { test } from "node:test";
import assert from "node:assert/strict";
import { withMoneyIdempotency, expireMoneyIdempotency } from "../src/money-idempotency.ts";
import { HttpError, errorCode, errorFields, errorHeaders, errorStatus } from "../src/errors.ts";
import { testDatabase } from "./billing-database.ts";

async function fixture() {
  const { db, url } = await testDatabase();
  const env = { HYPERDRIVE: { connectionString: url } };
  const request = (path: string, key: string, body: unknown = {}, method = "POST") => new Request("https://runtime.example.test" + path, {
    method, headers: { "Idempotency-Key": key, "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
  return { db, env, request };
}

test("source idempotency replays one normal response and rejects changed parameters; keys are tenant-scoped", async () => {
  const { db, env, request } = await fixture();
  let calls = 0;
  const handler = async (request: Request) => Response.json({ call: ++calls, input: await request.json() }, { status: 201 });
  const first = await withMoneyIdempotency(request("/v1/workspaces", "normal", { name: "shared" }), env, "alice", handler);
  const again = await withMoneyIdempotency(request("/v1/workspaces", "normal", { name: "shared" }), env, "alice", handler);
  assert.equal(first?.status, 201);
  assert.equal(again?.status, 201);
  assert.equal(again?.headers.get("Idempotent-Replayed"), "true");
  assert.deepEqual(await again!.json(), await first!.json());
  assert.equal(calls, 1);
  await assert.rejects(withMoneyIdempotency(request("/v1/workspaces", "normal", { name: "other" }), env, "alice", handler), (e: any) => e.status === 409 && e.code === "IDEMPOTENCY_CONFLICT");
  await assert.rejects(withMoneyIdempotency(request("/v1/billing/checkout", "normal", { name: "shared" }), env, "alice", handler), (e: any) => e.status === 409 && e.code === "IDEMPOTENCY_CONFLICT");
  assert.equal((await withMoneyIdempotency(request("/v1/workspaces", "normal", { name: "shared" }), env, "bob", handler))?.status, 201);
  assert.equal(calls, 2);
  assert.equal(Number((await db.query("select count(*) from idempotency_keys")).rows[0].count), 2);
});

test("secret-bearing successes are never stored or replayed, including experimental route aliases", async () => {
  const { db, env, request } = await fixture();
  const routes = ["/v1/tokens", "/v1/tenants", "/v1/webhooks", "/v1/webhooks/id/secret", "/v1/usage-webhook/secret", "/v1/api-keys", "/v1/webhooks/id/rotate-secret", "/v1/usage-webhook/rotate-secret"];
  let calls = 0;
  for (const path of routes) {
    const handler = async () => { calls++; return Response.json({ secret: "test-only-secret-shown-once" }, { status: 201 }); };
    const first = await withMoneyIdempotency(request(path, `secret-${path}`), env, "alice", handler);
    assert.equal(first?.status, 201);
    await assert.rejects(withMoneyIdempotency(request(path, `secret-${path}`), env, "alice", handler), (e: any) => e.status === 409 && e.code === "IDEMPOTENCY_CONFLICT" && /shown once/.test(e.message));
  }
  assert.equal(calls, routes.length);
  const rows = (await db.query("select status, body, content_type from idempotency_keys")).rows;
  assert.equal(rows.length, routes.length);
  assert.equal(rows.every(row => row.status === 201 && row.body === null && row.content_type === null), true);
});

test("returned failures and thrown errors release only their own lock so retries run", async () => {
  const { db, env, request } = await fixture();
  let calls = 0;
  const path = "/v1/workspaces";
  const handler = async () => ++calls === 1 ? Response.json({ error: "retry" }, { status: 503 }) : Response.json({ made: true }, { status: 201 });
  assert.equal((await withMoneyIdempotency(request(path, "retry"), env, "alice", handler))?.status, 503);
  assert.equal(Number((await db.query("select count(*) from idempotency_keys")).rows[0].count), 0);
  assert.equal((await withMoneyIdempotency(request(path, "retry"), env, "alice", handler))?.status, 201);
  assert.equal(calls, 2);
  await assert.rejects(withMoneyIdempotency(request(path, "throw"), env, "alice", async () => { throw new Error("abrupt handler failure"); }), /abrupt handler failure/);
  assert.equal(Number((await db.query("select count(*) from idempotency_keys where key='throw'")).rows[0].count), 0);
  assert.equal((await withMoneyIdempotency(request(path, "throw"), env, "alice", async () => Response.json({ retried: true })))?.status, 200);
});

test("in-flight requests conflict, and stale-lock takeover fences the previous response", { timeout: 10_000 }, async () => {
  const { db, env, request } = await fixture();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const path = "/v1/workspaces";
  const first = withMoneyIdempotency(request(path, "held"), env, "alice", async () => { enter(); await released; return Response.json({ old: true }); });
  await entered;
  try {
    await assert.rejects(withMoneyIdempotency(request(path, "held"), env, "alice", async () => Response.json({ wrong: true })), (e: any) => e.status === 409 && e.code === "IDEMPOTENCY_IN_PROGRESS");
    await db.query("update idempotency_keys set created_at=$1 where key='held'", [Date.now() - 120_001]);
    const replacement = await withMoneyIdempotency(request(path, "held"), env, "alice", async () => Response.json({ replacement: true }));
    assert.deepEqual(await replacement!.json(), { replacement: true });
  } finally { release(); }
  await first;
  const row = (await db.query("select body from idempotency_keys where key='held'")).rows[0];
  assert.deepEqual(JSON.parse(row.body), { replacement: true }, "the old request cannot overwrite its successor");
});

test("completed keys expire after a day and body size is bounded before a handler runs", async () => {
  const { db, env, request } = await fixture();
  let calls = 0;
  const handler = async () => Response.json({ call: ++calls });
  await withMoneyIdempotency(request("/v1/workspaces", "expired"), env, "alice", handler);
  await db.query("update idempotency_keys set created_at=$1", [Date.now() - 24 * 60 * 60_000 - 1]);
  await expireMoneyIdempotency(env);
  assert.equal(Number((await db.query("select count(*) from idempotency_keys")).rows[0].count), 0);
  await withMoneyIdempotency(request("/v1/workspaces", "expired"), env, "alice", handler);
  assert.equal(calls, 2);
  const oversized = new Request("https://runtime.example.test/v1/workspaces", { method: "POST", body: "{}", headers: { "Idempotency-Key": "huge", "Content-Length": String(9 * 1024 * 1024) } });
  await assert.rejects(withMoneyIdempotency(oversized, env, "alice", handler), (e: any) => e.status === 413 && e.code === "TOO_LARGE");
  assert.equal(calls, 2);
});

test("source-owned agent idempotency is skipped and an unmatched route stays unmatched", async () => {
  const { db, env, request } = await fixture();
  let calls = 0;
  const handler = async () => Response.json({ call: ++calls });
  await withMoneyIdempotency(request("/v1/agents", "owned-by-agent"), env, "alice", handler);
  await withMoneyIdempotency(request("/v1/agents", "owned-by-agent"), env, "alice", handler);
  assert.equal(calls, 2);
  assert.equal(Number((await db.query("select count(*) from idempotency_keys")).rows[0].count), 0);
  assert.equal(await withMoneyIdempotency(request("/v1/unknown", "unknown"), env, "alice", async () => undefined), undefined);
  assert.equal(Number((await db.query("select count(*) from idempotency_keys")).rows[0].count), 0);
});

test("HTTP error defaults and retry metadata use the unchanged source policy", () => {
  for (const [status, code] of [[403, "FORBIDDEN"], [404, "NOT_FOUND"], [409, "CONFLICT"], [413, "TOO_LARGE"], [429, "RATE_LIMITED"], [503, "UNAVAILABLE"]] as const) assert.equal(new HttpError(status, "example").code, code);
  assert.equal(new HttpError(400, "EXPLICIT_CODE: detail").code, "EXPLICIT_CODE");
  assert.equal(new HttpError(400, "detail", "CUSTOM_CODE").code, "CUSTOM_CODE");
  assert.equal(errorStatus(Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }), 500), 503);
  const conflict = Object.assign(new Error("serialization failure"), { code: "40001" });
  assert.equal(errorCode(conflict, 503), "DATABASE_RETRY");
  assert.deepEqual(errorHeaders(conflict), { "Retry-After": "1" });
  assert.deepEqual(errorFields({ details: { required: true }, limit: { name: "runs" } }), { required: true, limit: { name: "runs" } });
});

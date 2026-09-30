import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { listen, OPERATOR, OTHER_OPERATOR, runtime, until, type T } from "./runtime-server.ts";

/** Every entry of a zip, read through its central directory, as the export's reader would. */
export function unzip(zip: Buffer) {
  let end = zip.length - 22;
  while (zip.readUInt32LE(end) !== 0x06054b50) end--;
  let count = zip.readUInt16LE(end + 10), at = zip.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) {
    const record = Number(zip.readBigUInt64LE(end - 20 + 8));
    count = Number(zip.readBigUInt64LE(record + 32)); at = Number(zip.readBigUInt64LE(record + 48));
  }
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const compressed = zip.readUInt32LE(at + 20), nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    files.set(name, inflateRawSync(zip.subarray(data, data + compressed)));
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

/** A fake Stripe API: what the runtime deleted and expired. */
async function fakeStripe(t: T) {
  const calls: string[] = [];
  const url = await listen(t, (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === "/v1/customers/cus_gone") return void res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { code: "resource_missing", message: "No such customer" } }));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "x", deleted: true }));
  });
  return { url, calls };
}

test("an account exports everything it stores, then deletes it all but the ledger, and its identity signs up afresh without new credit", { timeout: 120_000 }, async t => {
  const stripe = await fakeStripe(t);
  const r = await runtime(t, () => ({ role: "assistant", content: "Noted: the launch code is 4321." }), {
    AGENT_VERIFY_KEYS: "false", AGENT_BILLING_ADMINS: "alice", STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture", AGENT_STRIPE_API_URL: stripe.url,
    AGENT_PURGE_INTERVAL_MS: "1000",
  });
  // Carol signs up with GitHub, and gets starting credit.
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db: r.db, pricing: { startingGrant: 5_000_000 } as never });
  const github = { login: "carol", id: 4242, createdAt: Date.now() - 365 * 86_400_000 };
  const tenant = await accounts.tenantForGithub(github, { minAccountAgeMs: 0 });
  assert.equal(tenant, "carol");
  const { token } = await accounts.createToken(tenant, "script");
  const as = (path: string, init: Parameters<typeof r.call>[1] = {}) => r.call(path, { ...init, token });
  assert.equal((await as("/v1/providers/openrouter/key", { method: "PUT", body: { apiKey: "sk-or-carol-own-key" } })).status, 200);

  // An agent with a history and a schedule, a volume with a file, a definition, a webhook, and a Stripe customer.
  const agent = (await as("/v1/agents", { body: { name: "diary" }, headers: { "Idempotency-Key": "diary" } })).json.id;
  await r.prompt(agent, "Remember the launch code 4321", token);
  assert.equal((await as(`/v1/agents/${agent}/schedules`, { body: { text: "check in", inSeconds: 3600 } })).status, 201);
  const volume = (await as("/v1/volumes", { body: { name: "notes" } })).json.id;
  const put = await fetch(`${r.base}/v1/volumes/${volume}/files/plans/secret.txt`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" }, body: "the secret plan" });
  assert.equal(put.status, 201);
  assert.equal((await as("/v1/definitions", { body: { name: "helper", systemPrompt: "Be brief" } })).status, 201);
  assert.equal((await as("/v1/webhooks", { body: { url: "https://hooks.example.com/runs", events: ["run.completed"] } })).status, 201);
  await r.db.query("insert into billing_stripe_customers (tenant, livemode, request_id, customer, created_at) values ($1, false, gen_random_uuid(), 'cus_carol', 1)", [tenant]);
  await r.db.query("insert into credit_accounts (tenant, balance, stripe_customer) values ($1, 0, 'cus_gone') on conflict (tenant) do update set stripe_customer = 'cus_gone'", [tenant]);
  await r.db.query("insert into billing_recipients (id, tenant, email, confirmation_hash, confirmation_expires, created_at) values (gen_random_uuid(), $1, 'carol@example.com', 'hash', 1, 1)", [tenant]);

  // The export: a zip of all of it, streamed.
  const exported = await fetch(`${r.base}/v1/account/export`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("content-type"), "application/zip");
  assert.match(exported.headers.get("content-disposition") ?? "", /^attachment; filename="camelrun-carol-\d{4}-\d{2}-\d{2}\.zip"$/);
  const files = unzip(Buffer.from(await exported.arrayBuffer()));
  const text = (name: string) => { const file = files.get(name); assert.ok(file, `${name} in ${[...files.keys()].join(", ")}`); return file.toString("utf8"); };
  assert.deepEqual(JSON.parse(text("account.json")).tenant, "carol");
  const config = JSON.parse(text(`agents/${agent}/agent.json`));
  assert.equal(config.name, "diary");
  assert.equal(config.schedules[0].text, "check in");
  const history = [...files].filter(([name]) => name.startsWith(`agents/${agent}/history/`)).map(([, data]) => data.toString()).join("");
  assert.match(history, /Remember the launch code 4321/);
  assert.match(history, /the launch code is 4321/);
  assert.equal(text(`volumes/${volume}/files/plans/secret.txt`), "the secret plan");
  assert.equal(JSON.parse(text("definitions.json"))[0].name, "helper");
  assert.equal(JSON.parse(text("webhooks.json"))[0].url, "https://hooks.example.com/runs");
  assert.match(text("billing/ledger.jsonl"), /"kind":"grant"/);
  assert.ok(!files.has("keys.json") || !text("keys.json").includes("sk-or-carol-own-key"), "keys never leave");
  assert.ok(!text("tokens.json").includes(token), "tokens never leave");

  // Deletion is the console's, signed in, with the account named; admin tenants and other operators cannot.
  assert.equal((await as("/v1/account", { method: "DELETE", body: { confirm: tenant } })).status, 403, "not with an API token");
  const signIn = await fetch(`${r.base}/console/auth/token`, { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Runtime-Console": "1" }, body: JSON.stringify({ token }) });
  const cookie = signIn.headers.getSetCookie()[0].split(";")[0];
  const console_ = (path: string, init: { method?: string; body?: unknown } = {}) => r.call(path, { ...init, token: null, headers: { Cookie: cookie, "X-Agent-Runtime-Console": "1" } });
  assert.equal((await console_("/v1/account", { method: "DELETE", body: { confirm: "someone-else" } })).status, 400);
  assert.equal((await r.call("/v1/tenants/bob", { method: "DELETE" })).status, 403, "an admin tenant is never deleted");
  assert.equal((await r.call("/v1/tenants/carol", { method: "DELETE", token: OTHER_OPERATOR })).status, 403, "only the platform operator deletes others");
  const deleting = await console_("/v1/account", { method: "DELETE", body: { confirm: tenant } });
  assert.equal(deleting.status, 202);
  assert.equal(deleting.json.state, "deleting");
  // At once: nothing authenticates as the account any more.
  assert.equal((await as("/v1/me")).status, 401);
  assert.equal((await console_("/v1/me")).status, 401);

  const done = await until(async () => { const status = await r.call("/v1/tenants/carol/deletion", { token: OPERATOR }); return status.json.state === "deleted" && status.json; }, "the deletion to finish", 60_000);
  assert.ok(done.completedAt >= done.requestedAt);
  assert.deepEqual(stripe.calls.filter(call => call.startsWith("DELETE")).sort(), ["DELETE /v1/customers/cus_carol", "DELETE /v1/customers/cus_gone"]);

  // Gone: everything but the ledger, usage, payment and starting-credit records.
  const count = async (sql: string, params: unknown[] = [tenant]) => Number((await r.db.query(sql, params)).rows[0].count);
  for (const table of ["api_tokens", "provider_keys", "definitions", "webhook_endpoints", "schedules", "volumes", "channels", "billing_recipients", "chunk_touches", "oauth_grants", "agent_inputs"]) {
    assert.equal(await count(`select count(*) from ${table} where tenant = $1`), 0, table);
  }
  assert.equal(await count("select count(*) from tenants where id = $1"), 0);
  assert.equal(await count("select count(*) from agents where tenant = $1"), 0);
  const [tombstone] = (await r.db.query("select header, tenant, model from agents where id = $1", [agent])).rows;
  assert.deepEqual(tombstone, { header: { version: 3, id: agent, revoked: true, purged: true }, tenant: "", model: "" });
  assert.equal(existsSync(join(r.root, "chunks", tenant)), false, "file contents are gone");
  assert.ok(await count("select count(*) from credit_ledger where tenant = $1") > 0, "the ledger stays");
  assert.equal(await count("select count(*) from starting_credit_decisions where github_id = 4242 and tenant = $1"), 1, "the starting-credit record stays");
  assert.equal(await count("select count(*) from billing_stripe_customers where tenant = $1"), 1, "which customer paid stays");

  // The same GitHub account signs up again: a new, empty tenant under a new id, with no second starting credit.
  const again = await accounts.tenantForGithub(github, { minAccountAgeMs: 0 });
  assert.notEqual(again, tenant);
  assert.equal(await count("select count(*) from credit_ledger where tenant = $1", [again]), 0);
  // A repeated request only reports the deletion.
  assert.equal((await r.call("/v1/tenants/carol", { method: "DELETE", token: OPERATOR })).json.state, "deleted");
});

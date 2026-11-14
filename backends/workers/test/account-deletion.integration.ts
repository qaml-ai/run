import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { unzip } from "../../../tests/unzip.ts";
import { startFixture } from "./fixture.ts";

// A pass deletes at most 25 agents (agentBatchSize). By default the account is small enough for every pull request
// and still takes several passes, with the process killed between them. WORKERS_SLOW_TESTS=1 (the nightly Workers
// run) deletes 2001 agents in 81 passes: about 8.5 minutes on a Sprite, more than half of it creating the agents.
const AGENTS = process.env.WORKERS_SLOW_TESTS === "1" ? 2001 : 101;

test(`queued account deletion resumes after interruption with ${AGENTS} agents and retains accounting`, { timeout: 900_000 }, async t => {
  const operator = "large-account-deletion-operator-token-32-characters";
  const otherToken = "other-pending-account-token-at-least-32-characters";
  const r = await startFixture({ tenants: [{ id: "camelrun-proto-local", token: "local-integration-only-token-with-at-least-32-characters" }, { id: "other-pending", token: otherToken }], entrypoint: fileURLToPath(new URL("./camelfs-worker.ts", import.meta.url)), vars: {
    AGENT_TENANTS_JSON: JSON.stringify({ tenants: { ops: { tokenSha256: createHash("sha256").update(operator).digest("hex"), apiKeys: {} } } }),
    AGENT_BILLING_ADMINS: "ops",
    AGENT_CREATE_DIAGNOSTICS: "1",
    AGENT_MAX_AGENTS: "2100", AGENT_MAX_AGENTS_PER_TENANT: "2100",
  } });
  t.after(() => r.stop());
  const tenant = "camelrun-proto-local";
  await r.db.query("update tenants set limits=$2 where id=$1", [tenant, { maxBusyAgents: 2100, agentCreatesPerMinute: 5000 }]);
  const call = (path: string, method = "GET", token = operator, body?: unknown) => fetch(r.url + path, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const createLogs = () => r.worker.logs().split("\n")
    .filter(line => /agent_create_(?:db|rpc)_failed|agent_http_failed|agent_start_(?:slow|stuck)|http_failed/.test(line))
    .join("\n");
  const createAgent = async (index: number) => {
    const key = `account-deletion-${index}`;
    const timeoutMs = 60_000;
    const signal = AbortSignal.timeout(timeoutMs);
    // Keep the one-day lifetime that unkeyed creates default to.
    const body = JSON.stringify({ model: "test/echo", spendLimit: { usd: 3 }, ttlSeconds: 86_400 });
    let lastPending = "";
    try {
      for (;;) {
        const response = await fetch(r.url + "/v1/agents", {
          method: "POST",
          headers: { authorization: `Bearer ${r.token}`, "content-type": "application/json", "Idempotency-Key": key },
          body,
          signal,
        });
        if (response.status === 201) return (await response.json() as { id: string }).id;
        const failure = await response.text();
        let code: unknown;
        if (response.status === 503) {
          try { code = JSON.parse(failure)?.code; } catch { /* Report the response body below. */ }
        }
        if (code !== "CONFIGURATION_PENDING") {
          assert.fail(`create ${key} returned ${response.status}: ${failure}\n${createLogs()}`);
        }
        lastPending = ` Last response: 503 ${failure}`;
        // The directory row was saved. Replay this keyed create to apply its configuration.
        await delay(250, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) throw error;
      assert.fail(`create ${key} did not return 201 within ${timeoutMs} ms.${lastPending}\n${createLogs()}`);
    }
  };
  const ids = [await createAgent(0)];
  let next = 1;
  // Limit concurrent creates because first agent starts are CPU-heavy in the single-threaded workerd fixture.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < AGENTS) {
      ids.push(await createAgent(next++));
    }
  }));
  assert.equal(ids.length, AGENTS);
  const tokenResponse = await call("/v1/tokens", "POST", r.token, { name: "revoked with account" });
  assert.equal(tokenResponse.status, 201);
  const { token } = await tokenResponse.json() as { token: string };
  assert.equal((await call("/v1/agents", "GET", token)).status, 200);
  const madeRepo = await call("/v1/repos", "POST", r.token, { key: "account-export", name: "Account files" });
  assert.equal(madeRepo.status, 201);
  const repo = await madeRepo.json() as { id: string };
  const written = await fetch(r.url + `/v1/repos/${repo.id}/files/hello.txt`, { method: "PUT", headers: { authorization: `Bearer ${r.token}` }, body: "exported repo content" });
  assert.equal(written.status, 201);
  const exported = await call(`/v1/tenants/${tenant}/export`);
  assert.equal(exported.status, 200);
  const archive = unzip(Buffer.from(await exported.arrayBuffer()));
  assert.equal(archive.get(`repos/${repo.id}/main/hello.txt`)?.toString(), "exported repo content");
  const info = JSON.parse(archive.get(`repos/${repo.id}/repo.json`)!.toString());
  assert.equal(info.name, "Account files"); assert.equal(info.key, "account-export");
  assert.ok(info.refs.some((ref: { name: string }) => ref.name === "main"));
  assert.ok(![...archive.keys()].some(name => name.startsWith("volumes/")));
  const before = (await r.db.query("select * from credit_ledger where tenant=$1 order by id", [tenant])).rows;
  const balance = (await r.db.query("select balance from credit_accounts where tenant=$1", [tenant])).rows[0].balance;
  const otherCreated = await call("/v1/repos", "POST", otherToken, { name: "Other pending account" });
  assert.equal(otherCreated.status, 201);
  const otherRepo = await otherCreated.json() as { id: string };
  // Another deletion with no agents must retain its index until its own repos are removed.
  await r.db.query("insert into account_deletions(tenant,requested_at,requested_by,claimed_until) values($1,$2,'test',now()+interval '1 day')", ["other-pending", Date.now()]);
  const started = Date.now();
  assert.equal((await call(`/v1/tenants/${tenant}`, "DELETE")).status, 202);
  assert.equal((await call("/v1/agents", "GET", token)).status, 401, "credentials stop authenticating before cleanup finishes");
  const count = async () => Number((await r.db.query("select count(*) n from agents where tenant=$1", [tenant])).rows[0].n);
  const firstDeadline = Date.now() + 90_000;
  while (await count() === AGENTS && Date.now() < firstDeadline) await new Promise(resolve => setTimeout(resolve, 100));
  const remaining = await count();
  assert.ok(remaining > 0 && remaining < AGENTS, `first bounded queue pass committed progress (remaining=${remaining}); ${r.worker.logs().split('\n').filter(line => /account_deletion_failed|http_failed|Error:/.test(line)).slice(-20).join('\n')}`);
  await r.restart({}, true);
  // Advance only the persisted lease clock, avoiding a five-minute test sleep.
  await r.db.query("update account_deletions set claimed_until=now()-interval '1 second' where tenant=$1", [tenant]);
  await r.worker.scheduled();
  const deadline = Date.now() + 720_000;
  let status: { state?: string } = {};
  while (Date.now() < deadline) {
    const response = await call(`/v1/tenants/${tenant}/deletion`);
    assert.equal(response.status, 200);
    status = await response.json();
    if (status.state === "deleted") break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(status.state, "deleted", "queue continues without a client waiting on cleanup");
  assert.equal(await count(), 0);
  await r.db.query("delete from account_deletions where tenant=$1", ["other-pending"]);
  const otherRead = await call(`/v1/repos/${otherRepo.id}`, "GET", otherToken);
  assert.equal(otherRead.status, 200, "deleting one account must not purge another pending account's repo index");

  assert.equal((await r.db.query("select count(*)::int n from agent_spend_limits where agent=any($1::text[])", [ids])).rows[0].n, 0);
  assert.deepEqual((await r.db.query("select * from credit_ledger where tenant=$1 order by id", [tenant])).rows, before);
  assert.equal((await r.db.query("select balance from credit_accounts where tenant=$1", [tenant])).rows[0].balance, balance);
  assert.equal((await call("/v1/agents", "GET", token)).status, 401);
  const attempts = Number((await r.db.query("select attempts from account_deletions where tenant=$1", [tenant])).rows[0].attempts);
  assert.ok(attempts >= (AGENTS - 1) / 25, "the agents were deleted across durable bounded passes");
  t.diagnostic(`Deleted ${AGENTS} agents in ${attempts} passes over ${Date.now() - started} ms, including process interruption`);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { CamelRun } from "../sdk/src/index.ts";

test("tenant-admin spend-limit CAS only changes the expected idle configuration", async t => {
  const dir = mkdtempSync(join(tmpdir(), "native-spend-limit-"));
  const config = join(dir, "wrangler.json");
  const admin = "fixture-spend-admin";
  writeFileSync(config, JSON.stringify({
    name: "native-spend-limit-test",
    main: fileURLToPath(new URL("./fixtures/spend-limit-worker.ts", import.meta.url)),
    compatibility_date: "2026-03-01", compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
    vars: { ADMIN_SECRET: admin, VAULT_SECRET: "fixture-spend-vault-32-bytes-minimum", DEFAULT_MODEL: "mock/default" },
    durable_objects: { bindings: [{ name: "TENANT_DO", class_name: "TenantDO" }, { name: "AGENT_DO", class_name: "AgentDO" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] }],
  }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());
  const origin = "https://spend.test";
  const fetcher = worker.fetch.bind(worker) as unknown as typeof fetch;
  const owner = await CamelRun.createTenant({ baseUrl: origin, fetch: fetcher, adminKey: admin, name: "spend-owner", initialCreditsUsd: 1 });
  const other = await CamelRun.createTenant({ baseUrl: origin, fetch: fetcher, adminKey: admin, name: "spend-other" });
  const camel = new CamelRun({ baseUrl: origin, fetch: fetcher, apiKey: owner.apiKey });
  t.after(() => camel.close());
  const patch = (key: string, body: unknown = { spendLimitUsd: 0, expectedSpendLimitUsd: 10 }, token = owner.apiKey) => worker.fetch(
    origin + `/v2/agents/${key}/spend-limit`, { method: "PATCH", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const fixture = (id: string, action: string, body?: unknown) => worker.fetch(origin + `/_spend_fixture/${id}/${action}`, {
    method: "POST", ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
  });
  const state = async (id: string) => await (await fixture(id, "state")).json() as {
    config: string; runs: unknown[]; messages: unknown[]; events: unknown[]; changes: number; alarm: number | null;
  };
  const create = (key: string) => camel.agents.upsert(key, { model: "mock/default", builtins: [] });

  await t.test("own tenant admin only, exact agent scope and validated numeric fields", async () => {
    const agent = await create("auth");
    const before = await state(agent.id);
    for (const [token, status] of [[agent.agentToken!, 403], [other.apiKey, 404], [admin, 401], ["invalid", 401]] as const) {
      assert.equal((await patch(agent.id, undefined, token)).status, status);
    }
    for (const scope of [{ tenantId: other.tenantId, agentId: agent.id }, { tenantId: owner.tenantId, agentId: "different" }, {}]) {
      assert.equal((await fixture(agent.id, "scope", scope)).status, 404);
    }
    for (const body of [null, {}, { spendLimitUsd: -1, expectedSpendLimitUsd: 10 }, { spendLimitUsd: 0, expectedSpendLimitUsd: -1 },
      { spendLimitUsd: "0", expectedSpendLimitUsd: 10 }, { spendLimitUsd: 0, expectedSpendLimitUsd: null }]) {
      assert.equal((await patch(agent.id, body)).status, 400);
    }
    assert.deepEqual(await state(agent.id), before);
  });

  await t.test("valid idle change preserves all other config, runs and history; retry is read-only", async () => {
    const agent = await create("idle");
    await fixture(agent.id, "seed", "completed");
    const before = await state(agent.id);
    assert.deepEqual(await (await patch("idle")).json(), { spendLimitUsd: 0, changed: true });
    const after = await state(agent.id);
    const previous = JSON.parse(before.config), current = JSON.parse(after.config);
    assert.equal(current.spendLimitUsd, 0);
    assert.ok(current.updatedAt > previous.updatedAt);
    assert.deepEqual({ ...current, spendLimitUsd: previous.spendLimitUsd, updatedAt: previous.updatedAt }, previous);
    assert.deepEqual({ runs: after.runs, messages: after.messages, events: after.events },
      { runs: before.runs, messages: before.messages, events: before.events });
    assert.equal(after.changes, before.changes + 1);
    assert.equal(after.alarm, before.alarm);
    assert.deepEqual(await (await patch(agent.id)).json(), { spendLimitUsd: 0, changed: false });
    assert.deepEqual(await state(agent.id), after);
    assert.deepEqual(await (await patch(agent.id, { spendLimitUsd: 3, expectedSpendLimitUsd: 0 })).json(), { spendLimitUsd: 3, changed: true });
    const intervened = await state(agent.id);
    const stale = await patch(agent.id);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { error: { code: string } }).error.code, "spend_limit_changed");
    assert.deepEqual(await state(agent.id), intervened);
  });

  for (const status of ["queued", "running", "input_required", "active"]) {
    await t.test(status + " refuses without changing work or recovering a cold queue", async () => {
      const agent = await create("busy-" + status);
      await fixture(agent.id, "seed", status);
      if (status !== "active") await fixture(agent.id, "cold");
      const before = await state(agent.id);
      const response = await patch(agent.id);
      assert.equal(response.status, 409);
      assert.equal((await response.json() as { error: { code: string } }).error.code, "agent_busy");
      assert.deepEqual(await state(agent.id), before);
    });
  }

  await t.test("an already applied target remains a read-only retry during later work", async () => {
    const agent = await create("busy-retry");
    assert.equal((await patch(agent.id)).status, 200);
    await fixture(agent.id, "seed", "queued");
    const before = await state(agent.id);
    assert.deepEqual(await (await patch(agent.id)).json(), { spendLimitUsd: 0, changed: false });
    assert.deepEqual(await state(agent.id), before);
  });

  await t.test("malformed stored cap fails closed", async () => {
    const agent = await create("corrupt");
    await fixture(agent.id, "corrupt");
    const before = await state(agent.id);
    const response = await patch(agent.id);
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "agent_config_invalid");
    assert.deepEqual(await state(agent.id), before);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { nodeConfig } from "../src/node-config.ts";
import { configurationUpdate, resolveModel, sessionConfig } from "../src/session-config.ts";
import { runtime, until } from "./runtime-server.ts";

test("idle compaction defaults on and accepts only an explicit per-agent boolean", () => {
  assert.equal(nodeConfig({}).idleCompaction, true);
  assert.equal(nodeConfig({ AGENT_IDLE_COMPACTION: "0" }).idleCompaction, false);
  assert.equal(nodeConfig({ AGENT_IDLE_COMPACTION: "1" }).idleCompaction, true);
  const model = resolveModel("openai/gpt-4o-mini");
  const create = (idleCompaction?: unknown) => sessionConfig({ idleCompaction }, model);
  assert.equal(Object.hasOwn(create(), "idleCompaction"), false);
  for (const value of [false, true]) {
    assert.equal(create(value).idleCompaction, value);
    assert.equal(configurationUpdate({ idleCompaction: value }).idleCompaction, value);
  }
  for (const invalid of [null, "false", 0, {}, []]) {
    assert.throws(() => create(invalid), /idleCompaction must be true or false/);
    assert.throws(() => configurationUpdate({ idleCompaction: invalid }), /idleCompaction must be true or false/);
  }
  for (const internal of ["idleCompactionEnabled", "idleTimeoutMs"]) {
    assert.throws(() => configurationUpdate({ [internal]: true }), /Unsupported scoped configuration field/);
  }
});

test("legacy agents keep the default and upsert omission preserves a persisted opt-out", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const headers = { "Idempotency-Key": "idle-compaction-config" };
  const made = await r.call("/v1/agents", { body: { ttlSeconds: null }, headers });
  assert.equal(made.status, 201, made.text);
  const path = `/v1/agents/${made.json.id}`;
  const original = await r.call(path);
  assert.equal(Object.hasOwn(original.json, "idleCompaction"), false);

  const disabled = await r.call(`${path}/configuration`, { method: "PATCH", body: { idleCompaction: false } });
  assert.ok([200, 202].includes(disabled.status), disabled.text);
  await until(async () => (await r.call(path)).json.idleCompaction === false, "idle compaction opt-out to persist");
  assert.equal((await r.call(path)).json.idleCompaction, false);
  const persisted = await r.db.query("select header from agents where id = $1", [made.json.id]);
  assert.equal(persisted.rows[0].header.config.idleCompaction, false);
  assert.equal(Object.hasOwn(persisted.rows[0].header.config, "idleTimeoutMs"), false);
  assert.equal(Object.hasOwn(persisted.rows[0].header.config, "idleCompactionEnabled"), false);

  const upsert = await r.call("/v1/agents", { body: { ttlSeconds: null, systemPromptAppend: "Updated context" }, headers });
  assert.equal(upsert.status, 201, upsert.text);
  assert.equal(upsert.json.id, made.json.id);
  assert.equal((await r.call(path)).json.idleCompaction, false);
  const enabled = await r.call("/v1/agents", { body: { ttlSeconds: null, idleCompaction: true }, headers });
  assert.equal(enabled.status, 201, enabled.text);
  await until(async () => (await r.call(path)).json.idleCompaction === true, "idle compaction to enable");
  const invalid = await r.call(`${path}/configuration`, { method: "PATCH", body: { idleCompaction: null } });
  assert.equal(invalid.status, 400, invalid.text);
});

test("definition defaults apply while an agent's explicit idle compaction override stays", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const definition = await r.call("/v1/definitions", { body: { name: "Idle policy", idleCompaction: false } });
  assert.equal(definition.status, 201, definition.text);
  const invalid = await r.call("/v1/agents", { body: { definition: definition.json.id, idleCompaction: null } });
  assert.equal(invalid.status, 400, invalid.text);
  const inherited = await r.call("/v1/agents", { body: { definition: definition.json.id } });
  const explicit = await r.call("/v1/agents", { body: { definition: definition.json.id, idleCompaction: false } });
  assert.equal(inherited.status, 201, inherited.text);
  assert.equal(explicit.status, 201, explicit.text);
  for (const agent of [inherited, explicit]) {
    assert.equal((await r.call(`/v1/agents/${agent.json.id}`)).json.idleCompaction, false);
  }
  const applied = await r.call(`/v1/definitions/${definition.json.id}`, {
    method: "PATCH", body: { idleCompaction: null, apply: "all" },
  });
  assert.equal(applied.status, 200, applied.text);
  await until(async () => (await r.call(`/v1/agents/${inherited.json.id}`)).json.idleCompaction === true, "definition default to enable idle compaction");
  assert.equal((await r.call(`/v1/agents/${explicit.json.id}`)).json.idleCompaction, false);
});

test("a definition-backed upsert preserves an omitted opt-out and accepts an explicit change", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const definition = await r.call("/v1/definitions", { body: { name: "Enabled idle policy", idleCompaction: true } });
  assert.equal(definition.status, 201, definition.text);
  const body = { definition: definition.json.id };
  const headers = { "Idempotency-Key": "definition-idle-opt-out" };
  const made = await r.call("/v1/agents", { body: { ...body, idleCompaction: false }, headers });
  assert.equal(made.status, 201, made.text);
  const path = `/v1/agents/${made.json.id}`;
  const omitted = await r.call("/v1/agents", { body: { ...body, systemPromptAppend: "New context" }, headers });
  assert.equal(omitted.status, 201, omitted.text);
  assert.equal(omitted.json.id, made.json.id);
  assert.equal((await r.call(path)).json.idleCompaction, false);

  const enabled = await r.call("/v1/agents", { body: { ...body, idleCompaction: true }, headers });
  assert.equal(enabled.status, 201, enabled.text);
  await until(async () => (await r.call(path)).json.idleCompaction === true, "idle compaction to enable");
  const disabled = await r.call(`${path}/configuration`, { method: "PATCH", body: { idleCompaction: false } });
  assert.ok([200, 202].includes(disabled.status), disabled.text);
  await until(async () => (await r.call(path)).json.idleCompaction === false, "idle compaction opt-out to persist");
  const omittedAgain = await r.call("/v1/agents", { body, headers });
  assert.equal(omittedAgain.status, 201, omittedAgain.text);
  assert.equal((await r.call(path)).json.idleCompaction, false);
});

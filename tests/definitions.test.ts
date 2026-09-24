import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "../clients/typescript.ts";
import { migrate } from "../src/db.ts";
import { testDatabase } from "./database.ts";
import { OTHER_OPERATOR, runtime, until } from "./runtime-server.ts";

const lookup = { name: "lookup", description: "Look something up", parameters: { type: "object", properties: { key: { type: "string" } } }, exposure: "direct" };
const systemText = (body: any) => body.messages.find((message: any) => message.role === "system" || message.role === "developer")?.content as string;

test("definitions are the tenant's own, validated, and revised", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const created = await r.call("/v1/definitions", { body: { name: "Support", systemPrompt: "You are support.", builtins: ["web_fetch"], limits: { ttlSeconds: 3600 } } });
  assert.equal(created.status, 201, created.text);
  const id = created.json.id;
  assert.match(id, /^def_[a-f0-9]{20}$/);
  assert.equal(created.json.revision, 1);
  assert.deepEqual(created.json.builtins, ["web_fetch"]);

  for (const body of [{ name: "" }, { systemPrompt: "no name" }, { name: "x", model: "nope/nope" }, { name: "x", limits: { ttlSeconds: 5 } }, { name: "x", thinkingLevel: "huge" }]) {
    assert.equal((await r.call("/v1/definitions", { body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await r.call("/v1/definitions", { body: { name: "Catalog model", model: "anthropic/claude-sonnet-5" } })).status, 201);

  // Another tenant sees none of it.
  assert.deepEqual((await r.call("/v1/definitions", { token: OTHER_OPERATOR })).json, []);
  for (const [method, path] of [["GET", `/v1/definitions/${id}`], ["PATCH", `/v1/definitions/${id}`], ["DELETE", `/v1/definitions/${id}`], ["GET", `/v1/definitions/${id}/agents`]]) {
    assert.equal((await r.call(path, { method, token: OTHER_OPERATOR, ...(method === "PATCH" ? { body: { name: "mine" } } : {}) })).status, 404, `${method} ${path}`);
  }
  assert.equal((await r.call("/v1/agents", { token: OTHER_OPERATOR, body: { definition: id } })).status, 404);

  const revised = await r.call(`/v1/definitions/${id}`, { method: "PATCH", body: { systemPrompt: "You are support, v2.", revision: 1 } });
  assert.equal(revised.status, 200, revised.text);
  assert.equal(revised.json.revision, 2);
  assert.deepEqual(revised.json.builtins, ["web_fetch"], "fields not given are kept");
  assert.equal((await r.call(`/v1/definitions/${id}`, { method: "PATCH", body: { name: "stale", revision: 1 } })).status, 409);
  const cleared = await r.call(`/v1/definitions/${id}`, { method: "PATCH", body: { builtins: null } });
  assert.equal(cleared.json.revision, 3);
  assert.equal("builtins" in cleared.json, false, "null removes a field");
  assert.equal((await r.call(`/v1/definitions/${id}`, { method: "PATCH", body: {} })).json.revision, 3, "an empty update changes nothing");
  assert.equal((await r.call(`/v1/definitions/${id}`)).json.systemPrompt, "You are support, v2.");
  assert.equal((await r.call(`/v1/definitions/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await r.call(`/v1/definitions/${id}`)).status, 404);
  assert.equal((await r.call("/v1/definitions")).json.length, 1);
});

test("agents are made from a definition, record its revision, and take a new one when it is applied", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const definition = (await r.call("/v1/definitions", { body: { name: "Support", systemPrompt: "You are support v1.", limits: { ttlSeconds: 3600 } } })).json;
  const created = await r.call("/v1/agents", { body: { definition: definition.id }, headers: { "Idempotency-Key": "first" } });
  assert.equal(created.status, 201, created.text);
  assert.ok(Math.abs(created.json.expiresAt - (Date.now() + 3_600_000)) < 60_000, "the definition's ttl applies");
  const first = created.json.id;
  let detail = (await r.call(`/v1/agents/${first}`)).json;
  assert.deepEqual(detail.definition, { id: definition.id, revision: 1 });
  assert.equal(detail.name, "Support");
  assert.equal(detail.systemPrompt, "You are support v1.");
  assert.deepEqual(detail.tools, [], "application tools come only from an attached server");
  for (const key of ["model", "systemPrompt", "thinkingLevel"]) {
    assert.equal((await r.call("/v1/agents", { body: { definition: definition.id, [key]: key === "model" ? "anthropic/claude-sonnet-5" : key === "thinkingLevel" ? "low" : "x" } })).status, 400, key);
  }
  assert.equal((await r.call("/v1/agents", { body: { definition: "def_00000000000000000000" } })).status, 404);
  await r.prompt(first, "hello");
  assert.match(systemText(r.model.bodies.at(-1)), /You are support v1\./);

  await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { systemPrompt: "You are support v2." } });
  // The same idempotency key still names the same agent, whatever the definition's revision.
  assert.equal((await r.call("/v1/agents", { body: { definition: definition.id }, headers: { "Idempotency-Key": "first" } })).json.id, first);
  const second = (await r.call("/v1/agents", { body: { definition: definition.id, name: "Second", ttlSeconds: null } })).json;
  assert.equal(second.expiresAt, null);
  assert.equal((await r.call(`/v1/agents/${second.id}`)).json.systemPrompt, "You are support v2.");
  assert.equal((await r.call(`/v1/agents/${first}`)).json.systemPrompt, "You are support v1.", "existing agents keep their revision");
  assert.deepEqual((await r.call(`/v1/definitions/${definition.id}/agents`)).json, [{ id: first, revision: 1 }, { id: second.id, revision: 2 }].sort((a, b) => a.id.localeCompare(b.id)));

  // The agent's own credential cannot apply a definition: only the tenant can.
  const configure = await fetch(`${r.base}/clients/${first}/requests`, {
    method: "POST", headers: { Authorization: `Bearer ${created.json.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "sneaky", method: "configure", params: { definition: { id: definition.id, revision: 2 } } }),
  });
  assert.equal(configure.status, 400);

  const applied = await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { systemPrompt: "You are support v3.", apply: "all" } });
  assert.equal(applied.status, 200, applied.text);
  assert.equal(applied.json.revision, 3);
  assert.deepEqual(applied.json.applied, { accepted: [first, second.id].sort(), failed: [] });
  await until(async () => (await r.call(`/v1/definitions/${definition.id}/agents`)).json.every((agent: any) => agent.revision === 3), "both agents to take revision 3");
  detail = (await r.call(`/v1/agents/${first}`)).json;
  assert.equal(detail.systemPrompt, "You are support v3.");
  assert.deepEqual(detail.definition, { id: definition.id, revision: 3 });
  await r.prompt(first, "again");
  assert.match(systemText(r.model.bodies.at(-1)), /You are support v3\./, "the running agent was reconfigured");

  // Applying again with nothing changed is a no-op per agent.
  assert.deepEqual((await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { apply: "all" } })).json.applied.failed, []);
  // Deleting the definition leaves its agents as they are.
  assert.equal((await r.call(`/v1/definitions/${definition.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await r.prompt(first, "still here")).outcome.result.reply, "ok");
});

test("the SDK makes an agent from a definition with its attached server's tools, which survive an apply", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const definition = (await r.call("/v1/definitions", { body: { name: "Desk", systemPrompt: "v1" } })).json;
  const runtimeClient = new AgentRuntime({ url: r.base, apiKey: "fixture-operator-token-at-least-24-chars" });
  const tool = (description: string) => ({ description, input: { type: "object", properties: {} } as const, execute: async () => ({ ok: true }) });
  const agent = await runtimeClient.createAgent({ definition: definition.id, tools: { lookup: tool("App's lookup"), extra: tool("Something else") } });
  t.after(() => agent.close());
  const names = async () => (await r.call(`/v1/agents/${agent.session.id}`)).json.tools.map((entry: any) => [entry.name, entry.description]);
  assert.deepEqual(await names(), [["lookup", "App's lookup"], ["extra", "Something else"]]);
  assert.deepEqual((await r.call(`/v1/agents/${agent.session.id}`)).json.definition, { id: definition.id, revision: 1 });

  await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { systemPrompt: "v2", apply: "all" } });
  await until(async () => (await r.call(`/v1/agents/${agent.session.id}`)).json.definition.revision === 2, "the apply");
  assert.deepEqual(await names(), [["lookup", "App's lookup"], ["extra", "Something else"]]);
});

test("the migration gives each existing channel a definition made from its template", async () => {
  const { db } = await testDatabase({ migrate: false });
  const all = fileURLToPath(new URL("../migrations", import.meta.url));
  const before = mkdtempSync(join(tmpdir(), "migrations-"));
  for (const name of readdirSync(all).filter(name => name < "006")) cpSync(join(all, name), join(before, name));
  await migrate(db, before);
  const template = { systemPrompt: "Be brief.", tools: [lookup] };
  await db.query("insert into channels (id, tenant, channel, created_at) values ($1, $2, $3, $4)",
    ["ch_0123456789abcdef0123", "alice", JSON.stringify({ id: "ch_0123456789abcdef0123", tenant: "alice", type: "telegram", name: "Support bot", template }), 1]);
  await db.query("insert into channels (id, tenant, channel, created_at) values ($1, $2, $3, $4)",
    ["ch_aaaaaaaaaaaaaaaaaaaa", "bob", JSON.stringify({ id: "ch_aaaaaaaaaaaaaaaaaaaa", tenant: "bob", type: "slack", name: "Empty", template: {} }), 2]);
  await migrate(db);
  const channels = (await db.query("select id, channel from channels order by id")).rows;
  const definitions = new Map((await db.query("select * from definitions")).rows.map(row => [row.id, row]));
  assert.equal(definitions.size, 2);
  for (const { id, channel } of channels) {
    const definition = definitions.get(channel.definition)!;
    assert.equal(definition.tenant, channel.tenant);
    assert.equal(definition.name, channel.name);
    assert.equal(definition.revision, 1);
    assert.equal(definition.spec.channel, id);
    assert.ok(channel.template, "the template stays for nodes of the previous release");
  }
  const support = definitions.get(channels.find(row => row.id === "ch_0123456789abcdef0123")!.channel.definition)!;
  assert.deepEqual({ systemPrompt: support.spec.systemPrompt, tools: support.spec.tools }, template);
  assert.deepEqual(await migrate(db), [], "nothing is left to apply");
});

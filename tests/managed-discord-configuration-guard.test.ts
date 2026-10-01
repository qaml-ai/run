import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientSessions } from "../src/client-sessions.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { configuredModel } from "../src/model.ts";
import { HttpError } from "../src/http.ts";
import { testDatabase } from "./database.ts";
import { until } from "./runtime-server.ts";

test("external agent configuration requires the managed authorization hook, including the operator bridge", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "managed-discord-config-guard-"));
  const supervisor = new AgentSupervisor(join(root, "agents"));
  const calls: { tenant: string; agent: string; authorization: string | null }[] = [];
  const sessions = new ClientSessions(supervisor, {
    db, root: join(root, "sessions"), secret: "managed-config-guard-fixture-secret", apiKeyFor: () => "fixture-only",
    authorizeConfiguration: async (request, tenant, agent) => {
      calls.push({ tenant, agent, authorization: request.headers.get("authorization") });
      throw new HttpError(403, "Connect Discord to verify server management permissions");
    },
  });
  t.after(async () => { await sessions.close(); await supervisor.close(); await rm(root, { recursive: true, force: true }); });
  const agent = await sessions.create([], { model: configuredModel(), systemPrompt: "Original prompt" }, undefined, {}, "managed-tenant");
  await until(() => supervisor.request(agent.id, "status").then(() => true, () => false), "the fixture agent to start");
  const url = `http://localhost/clients/${agent.id}/requests`;
  const body = JSON.stringify({ id: "change-prompt", method: "configure", params: { systemPrompt: "Unauthorized change" } });

  const own = await sessions.app.request(url, { method: "POST", headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" }, body }, {});
  const ownBody = await own.json() as any;
  assert.equal(own.status, 403, JSON.stringify(ownBody));
  assert.match(ownBody.error, /verify server management/);
  const bridge = await sessions.app.request(url, { method: "POST", headers: { Authorization: "Bearer fixture-operator", "Content-Type": "application/json" }, body }, { operatorTenant: "managed-tenant" });
  assert.equal(bridge.status, 403);
  assert.deepEqual(calls, [
    { tenant: "managed-tenant", agent: agent.id, authorization: `Bearer ${agent.token}` },
    { tenant: "managed-tenant", agent: agent.id, authorization: "Bearer fixture-operator" },
  ]);
  assert.equal(sessions.sessions.get(agent.id)?.requests.has("change-prompt"), false, "refused configuration is not queued");

  const status = await sessions.app.request(url, {
    method: "POST", headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "read-status", method: "status", params: {} }),
  }, {});
  assert.equal(status.status, 202, "ordinary agent requests do not require server management authorization");
  assert.equal(calls.length, 2);
  const internal = await sessions.submit(agent.id, "managed-tenant", { id: "internal-apply", method: "configure", params: { systemPrompt: "Authorized definition update" } });
  assert.equal(internal.id, "internal-apply", "trusted definition apply uses its existing authorization path");
  assert.equal(calls.length, 2);
  await until(() => sessions.sessions.get(agent.id)?.requests.get("internal-apply")?.state === "completed", "trusted configuration to complete");
  await sessions.submit(agent.id, "managed-tenant", { id: "unapplied-server-prompt", method: "prompt", params: { text: "Do not run old tools", allowDisconnected: true, requiredDefinition: "def_new_server" } });
  const refused = await until(() => {
    const record = sessions.sessions.get(agent.id)?.requests.get("unapplied-server-prompt");
    return record?.state === "completed" && record;
  }, "unapplied server configuration is refused before model execution");
  assert.match(refused.outcome?.error ?? "", /server configuration has not applied/);
  assert.equal(sessions.sessions.get(agent.id)?.requests.get("internal-apply")?.error, undefined);
});

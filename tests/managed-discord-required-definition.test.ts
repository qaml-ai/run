import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientSessions } from "../src/client-sessions.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { configuredModel } from "../src/model.ts";
import { testDatabase } from "./database.ts";
import { until } from "./runtime-server.ts";

test("a managed server's prompt waits for its configuration: an agent on another definition refuses it before any model call", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "managed-discord-required-definition-"));
  const supervisor = new AgentSupervisor(join(root, "agents"));
  const sessions = new ClientSessions(supervisor, { db, root: join(root, "sessions"), secret: "managed-required-definition-fixture-secret", apiKeyFor: () => "fixture-only" });
  t.after(async () => { await sessions.close(); await supervisor.close(); await rm(root, { recursive: true, force: true }); });
  const agent = await sessions.create([], { model: configuredModel(), systemPrompt: "Original prompt" }, undefined, {}, "managed-tenant");
  await until(() => supervisor.request(agent.id, "status").then(() => true, () => false), "the fixture agent to start");
  await sessions.submit(agent.id, "managed-tenant", { id: "unapplied-server-prompt", method: "prompt", params: { text: "Do not run old tools", allowDisconnected: true, requiredDefinition: "def_new_server" } });
  const refused = await until(() => {
    const record = sessions.sessions.get(agent.id)?.requests.get("unapplied-server-prompt");
    return record?.state === "completed" && record;
  }, "unapplied server configuration is refused before model execution");
  assert.match(refused.outcome?.error ?? "", /server configuration has not applied/);
});

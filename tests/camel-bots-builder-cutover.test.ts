import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { testDatabase } from "./database.ts";
import { fenceV1Agent, publishV2AgentRoute } from "../src/agent-v2-cutover.ts";
import { CamelRun } from "../v2/sdk/src/index.ts";
import { moveCamelBotsBuilder, validateBuilderAttachments } from "../v2/scripts/move-camel-bots-builders.ts";

test("builder cutover holds app admission, defers accepted v1 work, and recovers after runtime publication", async t => {
  const { db: bots } = await testDatabase({ migrate: false });
  const { db: runtime } = await testDatabase({ migrate: false });
  await bots.query(`
    create table users (id text primary key, banned_at timestamptz);
    create table builder_agents (
      owner text primary key, agent text, runtime text, v2_agent text unique, updated_at timestamptz default now()
    );
    create table builder_dm_turns (owner text, state text);
    create table manager_briefs (person text, state text);
    create table heal_attempts (agent text, state text);
    create table bot_workers (owner text, agent text, started_at timestamptz);
  `);
  await runtime.query(`
    create table agents (id text, tenant text, pending_runs boolean, revoked boolean default false, purged_at bigint, expires_at bigint,
      last_cursor bigint default 0, reserved_cursor bigint default 0);
    create table runtime_nodes (node text, session text, expires_at timestamptz);
    create table busy_agents (agent text, tenant text, node text, session text);
    create table agent_inputs (agent text);
    create table agent_children (parent text, child text, state text);
    create table schedules (agent text);
    create table channel_agents (agent text);
    create table agent_triggers (agent text, disabled_at bigint);
    create table voice_calls (agent text, tenant text, state text);
    create table agent_v2_cutovers (tenant text, agent text, operation uuid, primary key (tenant, agent));
    create table agent_v2_routes (tenant text, agent text, destination_tenant text, destination_agent text, event_base bigint,
      primary key (tenant, agent), foreign key (tenant, agent) references agent_v2_cutovers (tenant, agent));
    create table agent_v2_receipt_archives (tenant text, agent text, receipts jsonb, primary key (tenant, agent));
  `);
  await runtime.query(readFileSync(new URL("../migrations/147_agent_v2_admission_lock.sql", import.meta.url), "utf8"));
  const owner = "123456789012345678";
  const row = { owner, source: "client_builder", destination: "agt_0123456789abcdef", operation: randomUUID(), previous: "1".repeat(64) };
  const config = {
    source: { tenant: "v1", url: "https://v1.example.com", apiKey: "synthetic" },
    destinationTenant: "v2", builderOrigin: "https://bots.example.com",
  };
  const tools = config.builderOrigin + "/builder/mcp/v2";
  const target = new CamelRun({
    baseUrl: "https://v2.example.com", apiKey: "synthetic",
    fetch: async () => Response.json({
      id: row.destination, tenantId: "v2", toolIdentity: { subject: owner, context: { builder: "user" } },
      mcpServers: [{ name: "bot", url: tools, audience: tools, auth: { type: "runtime" } }],
    }),
  });
  t.after(() => target.close());
  await bots.query("insert into users (id) values ($1), ('other')", [owner]);
  await bots.query("insert into builder_agents (owner, agent, runtime) values ($1, $2, 'v1'), ('other', 'client_other', 'v1')", [owner, row.source]);
  await runtime.query("insert into agents (tenant, id, pending_runs) values ('v1', $1, true)", [row.source]);

  type Relocate = NonNullable<Parameters<typeof moveCamelBotsBuilder>[6]>;
  const route = async () => (await bots.query("select agent, runtime, v2_agent from builder_agents where owner = $1", [owner])).rows[0];
  let disrupt = false;
  let runs = 0;
  const relocate: Relocate = async (db, source, v2, destination, options) => {
    runs++;
    assert.equal((await route()).runtime, "hold");
    assert.equal(v2, target);
    assert.equal(options?.previous, row.previous);
    const key = { tenant: source.tenant, agent: source.agentId, operation: source.operation };
    if (!await fenceV1Agent(db, key.tenant, key.agent, key.operation)) {
      return { state: "deferred", source: key.agent, destination: destination.agent };
    }
    assert.equal(await publishV2AgentRoute(db, key, destination, []), true);
    if (disrupt) throw new Error("simulated lost publication acknowledgment");
    return { state: "published", source: key.agent, destination: destination.agent };
  };
  const apply = () => moveCamelBotsBuilder(bots, runtime, target, config, row, true, relocate);

  assert.equal((await apply()).state, "deferred");
  assert.deepEqual(await route(), { agent: row.source, runtime: "v1", v2_agent: null });
  assert.equal((await runtime.query("select * from agent_v2_cutovers")).rowCount, 0);
  await runtime.query("update agents set pending_runs = false");
  await bots.query("insert into builder_dm_turns values ($1, 'running')", [owner]);
  assert.equal((await apply()).state, "deferred");
  assert.equal(runs, 1);
  await bots.query("update builder_dm_turns set state = 'ended'");

  disrupt = true;
  await assert.rejects(apply, /lost publication acknowledgment/);
  assert.deepEqual(await route(), { agent: row.source, runtime: "hold", v2_agent: row.destination });
  assert.equal((await apply()).state, "published");
  assert.deepEqual(await route(), { agent: row.source, runtime: "v2", v2_agent: row.destination });
  assert.equal((await apply()).state, "published");
  assert.equal(runs, 2);
  assert.equal((await bots.query("select runtime from builder_agents where owner = 'other'")).rows[0].runtime, "v1");
});

test("builder history with a visible attachment requires a pinned copy at its original path", () => {
  const path = "/workspace/uploads/web/12345678-cat.png";
  const contentType = "image/png";
  const messages = [{ role: "user", content: `Use the attached image.
<attached>
The person attached this file.
${JSON.stringify({ path, name: "cat.png", type: contentType })}
</attached>` }];
  const manifest = [{ messageIndex: 0, files: [{ path, contentType, commit: "a".repeat(64) }] }];
  assert.throws(() => validateBuilderAttachments(messages, undefined), /builder_attachment_manifest_required/);
  assert.throws(() => validateBuilderAttachments(messages, [{ ...manifest[0]!, messageIndex: 1 }]), /builder_attachment_manifest_required/);
  assert.doesNotThrow(() => validateBuilderAttachments(messages, manifest));
});

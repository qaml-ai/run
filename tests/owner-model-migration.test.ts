import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { testDatabase } from "./database.ts";

// Migration 137 (the owner model's expand step): nodes migrate at boot and older nodes keep serving against the new
// schema mid-rollout, so their writes (no owner columns) must still succeed, and rows they wrote must read as owned by
// their agent.

const OLD_CHILD = `insert into agent_children (id, tenant, parent, child, request_id, name, depth, root, parent_run, tool_call_id, kind, made, checked_at, created_at, updated_at, payer, bucket)
  values ($1, 'payg', 'parent', 'child', $1, 'helper', 1, 'root', 'run-1', 'call-1', 'delegate', true, 1, 1, 1, null, 'default')`;
const OLD_INPUT = `insert into agent_inputs (id, agent, tenant, request_id, tool_call_id, kind, input, created_at, expires_at,
  priority, priority_rank, blocking, responders, root_agent, lineage, item_key, subject)
  values ($1, 'agent-1', 'payg', 'run-1', 'call-1', 'question', '{}', 1, 2, 'normal', 2, true, '{}', 'agent-1', '{agent-1}', null, null)`;

test("an older node's child and input rows still insert, and read as their agent's", async () => {
  const { db } = await testDatabase();
  await db.query(OLD_CHILD, ["old-child"]);
  await db.query(OLD_INPUT, ["old-input"]);
  const child = (await db.query("select owner_kind, owner_id, root_owner, chain, parent from agent_children where id='old-child'")).rows[0];
  assert.deepEqual(child, { owner_kind: "agent", owner_id: null, root_owner: null, chain: null, parent: "parent" });
  const input = (await db.query("select owner_kind, owner_id, agent from agent_inputs where id='old-input'")).rows[0];
  assert.deepEqual(input, { owner_kind: "agent", owner_id: null, agent: "agent-1" });
  // Until the contract deploy, a reader takes the old column where the new one is missing.
  assert.equal((await db.query("select coalesce(owner_id, agent) as owner from agent_inputs where id='old-input'")).rows[0].owner, "agent-1");
  assert.equal((await db.query("select coalesce(owner_id, parent) as owner from agent_children where id='old-child'")).rows[0].owner, "parent");
  // The unique keys older nodes' `on conflict do nothing` rely on are unchanged: the same insert again is a no-op.
  await db.query(OLD_CHILD.replace("'default')", "'default') on conflict do nothing"), ["old-child"]);
  await assert.rejects(db.query("insert into agent_children (id, tenant, parent, child, request_id, name, depth, root, parent_run, tool_call_id, checked_at, created_at, updated_at, owner_kind) values ('bad', 'payg', 'p', 'c', 'r', 'n', 1, 'r', 'run', 'call', 1, 1, 1, 'nobody')"), /check/);
});

test("the migration adds the owner columns without rewriting existing rows: they read as owned by their agent", async () => {
  const { db } = await testDatabase();
  // The schema as it was before 137, with an input in it.
  await db.query("alter table agent_inputs drop column owner_kind, drop column owner_id");
  await db.query("alter table agent_children drop column owner_kind, drop column owner_id, drop column root_owner, drop column chain");
  await db.query(OLD_INPUT, ["before"]);
  await db.query(OLD_CHILD, ["before-child"]);
  await db.query(readFileSync(new URL("../migrations/137_owner_model.sql", import.meta.url), "utf8"));
  assert.deepEqual((await db.query("select owner_kind, owner_id, coalesce(owner_id, agent) as owner from agent_inputs where id='before'")).rows[0], { owner_kind: "agent", owner_id: null, owner: "agent-1" });
  assert.equal((await db.query("select owner_kind from agent_children where id='before-child'")).rows[0].owner_kind, "agent");
});

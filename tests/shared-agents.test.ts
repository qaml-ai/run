import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SharedAgents, sharedPromptInput, requireActiveMember, inputAudience, supersedesInput } from '../src/shared-agents.ts';
import { testDatabase } from './database.ts';
import { runtimeRules } from "../src/system-prompt.ts";
import { runtimeRules as workerRules } from "../backends/workers/src/prompt-policy.ts";
import { SHARED_SENDER_INSTRUCTIONS, senderInput } from "../src/sender.ts";

const forbidden = (error: unknown) => (error as { status?: number }).status === 403;

test('owner membership cannot be capped, removed or restored, and rejected updates leave it unchanged', async () => {
  const { db } = await testDatabase();
  await db.query("insert into agent_members (id,tenant,agent,person,role,name,added_at) values ('m_owner','owner','agent','owner','owner','Owner',1)");
  const shares = new SharedAgents(db);
  for (const input of [{ dailyCapMicros: 1 }, { dailyCapMicros: 0 }, { dailyCapMicros: null }, { removed: false as const }, 'remove' as const]) {
    await assert.rejects(shares.change('owner', 'agent', 'm_owner', input), (error: unknown) => (error as { status?: number }).status === 400);
  }
  const row = (await db.query("select daily_cap, removed_at, revision from agent_members where id='m_owner'")).rows[0];
  assert.deepEqual(row, { daily_cap: null, removed_at: null, revision: 1 });
});

test('member admission requires a live membership of this tenant and agent', async () => {
  const { db } = await testDatabase();
  await db.query("insert into agent_members (id,tenant,agent,person,role,name,added_at) values ('m_guest','owner','agent','guest','guest','Guest',1)");
  await requireActiveMember(db, 'owner', 'agent', 'member:m_guest');
  await assert.rejects(requireActiveMember(db, 'other', 'agent', 'member:m_guest'), forbidden);
  await assert.rejects(requireActiveMember(db, 'owner', 'other', 'member:m_guest'), forbidden);
  await assert.rejects(requireActiveMember(db, 'owner', 'agent', 'member:missing'), forbidden);
  await db.query("update agent_members set removed_at=2 where id='m_guest'");
  await assert.rejects(requireActiveMember(db, 'owner', 'agent', 'member:m_guest'), forbidden);
  await db.query("delete from agent_members where id='m_guest'");
  await assert.rejects(requireActiveMember(db, 'owner', 'agent', 'member:m_guest'), forbidden);
  await requireActiveMember(db, 'owner', 'agent', 'normal-actor');
  await requireActiveMember(db, 'owner', 'agent');
});

const owner = { id: "owner", role: "owner" as const };
const guest = { id: "guest", role: "guest" as const };
const shared = { owner, members: [owner, guest] };
test("shared instructions match both hosts in every tools mode and disappear without members", () => {
  for (const mode of [{ codeMode: false, tools: [] }, { codeMode: false, tools: [{ name: "x" }] }, { tools: [] }, { tools: [], fileTools: false }]) {
    for (const rules of [runtimeRules, workerRules]) {
      assert.ok(rules({ ...mode, sharedAgent: shared } as never).includes(SHARED_SENDER_INSTRUCTIONS));
      assert.ok(!rules(mode as never).includes(SHARED_SENDER_INSTRUCTIONS));
    }
  }
  for (const role of ["owner", "guest"]) assert.throws(() => senderInput({ id: "spoof", role }));
});
test("only guest approvals replace their audience, excluding a guest also named as approver", () => {
  assert.deepEqual(inputAudience("approval", guest.id, guest, shared, [guest.id, "ops"]), ["owner", "ops"]);
  for (const kind of ["question", "form", "url"]) assert.deepEqual(inputAudience(kind, guest.id, guest, shared), ["guest"]);
  assert.deepEqual(inputAudience("approval", owner.id, owner, shared, ["ops"]), ["owner", "ops"]);
  assert.throws(() => inputAudience("approval", guest.id, guest, undefined));
});
test("shared prompts supersede only own or open questions; legacy prompts supersede all", () => {
  for (const kind of ["question", "approval", "form", "url"]) {
    for (const audience of [[], ["guest"], ["someone-else"]]) {
      const input = { kind, responders: { audience } };
      assert.equal(supersedesInput(input, true, "guest"), kind === "question" && (audience.length === 0 || audience.includes("guest")));
      assert.equal(supersedesInput(input, false, "guest"), true);
    }
  }
});

test("membership reads live active rows and returns runtime member ids", async () => {
  let count = 0;
  let rows = [{ id: "m_owner", name: "Owner", role: "owner" }, { id: "m_guest", name: "Guest", role: "guest" }];
  const service = new SharedAgents({ async query(sql: string, args: unknown[]) {
    count++; assert.match(sql, /removed_at is null/); assert.deepEqual(args, ["agent", "tenant"]); return { rows };
  } } as never);
  assert.deepEqual(await service.get("agent", "tenant"), { owner: { id: "member:m_owner", name: "Owner", role: "owner" }, members: rows.map(row => ({ ...row, id: `member:${row.id}` })) });
  rows = [];
  assert.equal(await service.get("agent", "tenant"), undefined);
  assert.equal(count, 2);
});
test("guest ingress admits only text and files", () => {
  sharedPromptInput({ text: "Hello", files: [] });
  for (const field of ["actor", "from", "metadata", "spendLimit", "output", "whileRunning", "bucket", "sharedAgent"])
    assert.throws(() => sharedPromptInput({ text: "Hello", [field]: null }));
});

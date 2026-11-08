import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { INBOX_CHANNEL, Inputs } from "../src/inputs.ts";
import { testDatabase } from "./database.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<V>(check: () => V | Promise<V>, what: string, timeoutMs = 5_000): Promise<Exclude<V, false | 0 | "" | null | undefined>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as Exclude<V, false | 0 | "" | null | undefined>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A second connection, listening on the inbox channel as a node's inbox watchers do. */
async function listening(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const heard: { channel: string; payload: string }[] = [];
  client.on("notification", message => { heard.push({ channel: message.channel, payload: message.payload ?? "" }); });
  await client.query(`listen "${INBOX_CHANNEL}"`);
  return { heard, close: () => client.end() };
}

const row = async (db: pg.Pool, id: string) =>
  (await db.query("select priority, blocking, subject, responders, root_agent, lineage, item_key, version, updated_at, state from agent_inputs where id = $1", [id])).rows[0];

test("an input's row carries the fields the inbox orders and filters by, and the tenant is told on the inbox channel", async () => {
  const { db, url } = await testDatabase();
  const inputs = new Inputs({ db });
  const listened = await listening(url);
  try {
    // A call that asks a question and an approval at once, as ask_user and an approval's tool call do: one audience, the
    // definition's approvers, and the asking agent's place in its chain.
    const base = {
      agent: "a1", tenant: "alice", requestId: "r1", toolCallId: "call_1", expiresAt: Date.now() + 60_000,
      responders: { audience: ["u1"] }, approvers: ["boss", "u1"], rootAgent: "lead", lineage: ["lead", "a1"],
      tool: "ask_user", argumentsHash: "h",
    };
    const [question, approval] = await inputs.create(base, [
      { kind: "question", message: "Which region?", detail: { questions: [] } },
      { kind: "approval", message: "Allow deploy to run?", detail: {} },
    ]);
    const asked = await row(db, question.id);
    assert.equal(asked.priority, "normal", "a question is normal");
    assert.equal(asked.blocking, true, "every input that exists today blocks its turn");
    assert.deepEqual(asked.responders, ["u1", "boss"], "the audience plus the definition's approvers, frozen now");
    assert.deepEqual([asked.root_agent, asked.lineage], ["lead", ["lead", "a1"]], "the chain from the root to the asking agent");
    assert.deepEqual([asked.subject, asked.item_key], [null, null], "the asker names those in later slices");
    assert.equal(asked.version, 1);
    assert.equal((await row(db, approval.id)).priority, "high", "an approval is high");
    // Versions and updated_at are left to their defaults, and the row says when it was made.
    assert.ok(Math.abs(asked.updated_at.getTime() - Date.now()) < 60_000);

    // The notify is written in the same transaction as the rows: a listener hears it once they commit.
    await until(() => listened.heard.length === 1, "the create's notification");
    assert.deepEqual(listened.heard[0], { channel: "inbox", payload: "alice" }, "the channel is 'inbox', the tenant its payload");

    // An input nobody is named for, and an agent that starts its own chain: no responders, itself as root.
    const [bare] = await inputs.create({ ...base, requestId: "r2", toolCallId: "call_2", responders: {}, approvers: [], rootAgent: "a1", lineage: ["a1"] },
      [{ kind: "question", message: "Which region?", detail: { questions: [] } }]);
    const bareRow = await row(db, bare.id);
    assert.deepEqual(bareRow.responders, []);
    assert.deepEqual([bareRow.root_agent, bareRow.lineage], ["a1", ["a1"]]);
    await until(() => listened.heard.length === 2, "the second create's notification");

    // Settling it changes it: the state, a new version and updated_at, and the tenant hears again.
    await sleep(5);
    const answer = { action: "accept" as const, content: { answers: { "Which region?": "EU" } }, by: { from: { id: "u1" }, via: "api" as const }, at: Date.now() };
    const settled = await inputs.settle(question.id, answer);
    assert.equal(settled?.state, "answered");
    const done = await row(db, question.id);
    assert.equal(done.state, "answered");
    assert.equal(done.version, 2, "the version increases on every change");
    assert.ok(done.updated_at > asked.updated_at, "updated_at moves with the change");
    await until(() => listened.heard.length === 3, "the settle's notification");
    assert.deepEqual(listened.heard[2], { channel: "inbox", payload: "alice" });

    // Settled already: nothing changes, and nothing is announced (a retry of the same answer is not a second change).
    assert.equal(await inputs.settle(question.id, answer), undefined);
    await sleep(100);
    assert.equal(listened.heard.length, 3);
    assert.equal((await row(db, question.id)).version, 2);
  } finally {
    await listened.close();
  }
});

test("each row of one settle bumps its own version; one transaction's notifications for a tenant arrive once", async () => {
  const { db, url } = await testDatabase();
  const inputs = new Inputs({ db });
  const listened = await listening(url);
  try {
    const base = {
      agent: "a1", tenant: "alice", requestId: "r1", toolCallId: "call_1", expiresAt: Date.now() + 60_000,
      responders: { audience: ["u1"] }, approvers: ["boss"], rootAgent: "lead", lineage: ["lead", "a1"],
      tool: "ask_user", argumentsHash: "h",
    };
    const asked = await inputs.create(base, [
      { kind: "form", message: "Name it", detail: { requestedSchema: { type: "object", properties: { name: { type: "string" } } } } },
      { kind: "url", message: "Sign in", detail: { url: "https://example.com", origin: "https://example.com" } },
    ]);
    const [form, urlStep] = asked.map(input => input.id);
    await until(() => listened.heard.length === 1, "the create's notification");
    const by = { from: { id: "u1" }, via: "api" as const };
    const settled = await inputs.settleAll([
      { id: form, answer: { action: "accept", content: { name: "Bob" }, by, at: Date.now() } },
      { id: urlStep, answer: { action: "cancel", by, at: Date.now() } },
    ]);
    assert.deepEqual(settled?.map(input => input.state), ["answered", "cancelled"]);
    assert.deepEqual(await Promise.all([row(db, form), row(db, urlStep)]).then(rows => rows.map(one => [one.priority, one.version])), [["normal", 2], ["normal", 2]]);
    // Both settles are announced in settleAll's one transaction, and Postgres delivers an identical channel and payload
    // once per transaction: the tenant hears that something of its changed, which is what the listeners re-read for.
    await until(() => listened.heard.length === 2, "the settle's notification");
    assert.ok(listened.heard.every(heard => heard.channel === "inbox" && heard.payload === "alice"));
  } finally {
    await listened.close();
  }
});

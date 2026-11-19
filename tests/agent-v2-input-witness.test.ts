import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { EntryId, SubmissionId } from "@earendil-works/pi-durable";
import type { RequestRecord } from "../shared/client-protocol.ts";
import { memoryStorage } from "../shared/storage.ts";
import { fenceV1Agent, publishV2AgentRoute, unfenceV1Agent } from "../src/agent-v2-cutover.ts";
import { ClosedV1InputWitness } from "../src/agent-v2-input-witness.ts";
import { visible, type JournalRecord } from "../src/client-sessions/state.ts";
import { postgresTail } from "../src/log-tail.ts";
import { HOST_USER_KIND, MARKER_KIND } from "../src/pi-durable/history.ts";
import { seedJournal, SESSION_CONVERSATION_ID } from "../src/pi-durable/seed.ts";
import { commitBatch, PostgresPiStorage } from "../src/pi-durable/storage.ts";
import { resumeId } from "../src/v1-client-state.ts";
import { testDatabase } from "./database.ts";

const tenant = "acme";
const agent = "client_builder";
const input = "inp_00000000000000000000000000000001";
const origin = "origin";
const resumed = resumeId(origin);
const receipt = (id: string, at: number, result: object, fields?: Partial<RequestRecord>): RequestRecord =>
  ({ id, startedAt: at, began: at, endedAt: at + 2, fingerprint: "fixture", method: "prompt", state: "completed", outcome: { result }, ...fields });

async function fixture() {
  const { db } = await testDatabase();
  await db.query(`insert into agents (id, tenant, header, revision, name, type, model, cursor_clean, last_cursor, reserved_cursor)
    values ($1, $2, '{}', 1, 'test', 'test', 'm', true, 100, 200)`, [agent, tenant]);
  await db.query("insert into actor_owners (actor, epoch) values ($1, 3)", [agent]);
  await db.query(`insert into agent_inputs (id, tenant, agent, request_id, tool_call_id, kind, state, input, answer, created_at, expires_at, version)
    values ($1, $2, $3, $4, 'call', 'question', 'answered', '{"message":"Question","detail":{"questions":[]},"responders":{}}', '{"action":"accept","by":{"via":"api"},"at":5}', 2, 100, 2)`,
  [input, tenant, agent, origin]);

  const pi = await PostgresPiStorage.open(db, agent);
  await seedJournal({ storage: pi, sessionId: agent, model: [] });
  const storage = memoryStorage(postgresTail(db, { unfenced: true }));
  const log = storage.log<JournalRecord>(`client-sessions/${agent}.journal`);
  function append(record: RequestRecord) { log.append({ t: "request", record }); }
  append(receipt(origin, 1, { stopped: "input_required", inputs: [{ id: input }] }));
  await log.flush(true);
  return { db, pi, storage, log, append, read: () => ClosedV1InputWitness.read(db, storage, tenant, agent) };
}

test("requires the resume after the recorded answer and rechecks archived receipts and revisions at publication", async () => {
  const { db, pi, storage, log, append, read } = await fixture();
  const key = { tenant, agent, operation: randomUUID() };
  const dest = { tenant: "v2-tenant", agent: "v2-builder" };
  assert.equal(await read(), undefined, "an answer was accepted but its deterministic resume is missing");
  assert.equal(await fenceV1Agent(db, tenant, agent, key.operation), false);

  const continuation = receipt(resumed, 6, { reply: "done" }, { method: "resume", suspension: origin, announce: true });
  append(continuation);
  await log.flush(true);
  assert.equal(await read(), undefined, "the ended webhook is awaiting delivery");
  log.append({ t: "announced", ids: [resumed] });
  await log.flush(true);
  const witness = await read();
  assert.ok(witness);
  assert.equal(await ClosedV1InputWitness.read(db, storage, "other", agent), undefined);
  assert.equal(await fenceV1Agent(db, "other", agent, key.operation, witness), false);
  assert.equal(await fenceV1Agent(db, tenant, agent, key.operation, witness), true);
  assert.equal(await publishV2AgentRoute(db, key, dest, [], witness), false, "the original resume receipt must be archived");
  const archive = [visible(continuation)];
  assert.equal(await publishV2AgentRoute(db, key, dest, archive), false, "publication must use the witness too");

  await db.query("update agent_inputs set version = version + 1 where id = $1", [input]);
  assert.equal(await publishV2AgentRoute(db, key, dest, archive, witness), false);
  assert.equal(await unfenceV1Agent(db, tenant, agent, key.operation), true);
  assert.equal(await fenceV1Agent(db, tenant, agent, key.operation, witness), false, "stale input version");

  const newWitness = await read();
  assert.ok(newWitness);
  await db.query("update pi_durable_metadata set next_seq = next_seq + 1 where session_id = $1", [agent]);
  assert.equal(await fenceV1Agent(db, tenant, agent, key.operation, newWitness), false, "stale Pi sequence");
  const latest = await read();
  assert.ok(latest);
  assert.equal(await fenceV1Agent(db, tenant, agent, key.operation, latest), true);
  assert.equal(await publishV2AgentRoute(db, key, dest, archive, latest), true);
  assert.equal(await unfenceV1Agent(db, tenant, agent, key.operation), false);
  await pi.close(context);
});

test("rejects drift during the read and only recognizes a superseding prompt with an original Pi user entry", async () => {
  const { db, pi, log, storage, append, read } = await fixture();
  await db.query(`update agent_inputs set state = 'superseded', answer = '{"action":"cancel","by":{"system":"superseded"},"at":6}'
    where id = $1`, [input]);
  const next = "next";
  append(receipt(next, 5, { reply: "done" }));
  await log.flush(true);
  assert.equal(await read(), undefined, "a later receipt alone does not attest execution");
  const entry = await pi.mintId<EntryId>();
  const submission = await pi.mintId<SubmissionId>();
  await commitBatch(pi, [
    { type: "entry", value: { id: entry, conversationId: SESSION_CONVERSATION_ID, kind: HOST_USER_KIND,
      data: { message: { role: "user", content: "Next", timestamp: 5, requestId: next } } } },
    { type: "submission", value: { id: submission, conversationId: SESSION_CONVERSATION_ID, requestId: next, type: "write",
      status: "done", entry } },
  ], context);
  assert.ok(await read(), "the placed message in the exact durable session closes the superseded input");
  const changedDuringRead = { log<T>(key: string) {
    const original = storage.log<T>(key);
    return { ...original, async read() {
      const records = await original.read();
      await db.query("update agents set revision = revision + 1 where id = $1", [agent]);
      return records;
    } };
  } };
  assert.equal(await ClosedV1InputWitness.read(db, changedDuringRead, tenant, agent), undefined);

  const waiting = await pi.mintId<EntryId>();
  await commitBatch(pi, [{ type: "entry", value: { id: waiting, conversationId: SESSION_CONVERSATION_ID, kind: MARKER_KIND,
    data: { t: "awaiting", calls: ["new-call"] } } }], context);
  assert.equal(await read(), undefined, "the raw Pi history still has a call awaiting input");
  const release = await pi.mintId<EntryId>();
  const queued = await pi.mintId<SubmissionId>();
  await commitBatch(pi, [
    { type: "entry", value: { id: release, conversationId: SESSION_CONVERSATION_ID, kind: MARKER_KIND,
      data: { t: "awaiting", calls: ["new-call"], released: true } } },
    { type: "submission", value: { id: queued, conversationId: SESSION_CONVERSATION_ID, requestId: "waiting", type: "input",
      status: "queued" } },
  ], context);
  assert.equal(await read(), undefined, "retained Pi submissions must drain too");
  await pi.close(context);
});

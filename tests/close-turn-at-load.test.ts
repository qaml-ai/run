import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fixture } from "./client-fixture.ts";
import { forkCut, recordedMessages, Transcript, transcriptPath, type TranscriptRecord } from "../src/transcript.ts";
import { fileAppendLog } from "../shared/append-log.ts";
import { fileStorage } from "../shared/storage.ts";
import { MAX_RESUMES } from "../src/client-sessions.ts";
import type { RequestRecord } from "../shared/client-protocol.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { interruptedTurnRepairs } from "../src/history.ts";

/**
 * A run that ends with no host to end it (past its resumes or stopped before its node was lost, at a load; or resumed
 * where its agent then fails to start) settles the turn it left open in the transcript before it is seen to end, as
 * the agent's next start would: a fork or history page in between holds it whole.
 */

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 }) as AgentMessage;

async function lostTurn(t: Parameters<typeof fixture>[0], run: Partial<RequestRecord>, options: { awaiting?: boolean } = {}) {
  const fx = await fixture(t);
  const agent = await fx.start({});
  const id = agent.session.id;
  // The node running the turn is lost: its host and session are gone, and what it left is what the logs hold.
  await fx.sessions.close();
  await fx.supervisor.close();
  const transcript = new Transcript(fileAppendLog<TranscriptRecord>(transcriptPath(join(fx.root, "agents", id))));
  await transcript.load();
  await transcript.setActive(true);
  await transcript.append([user("research it"), fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "look" }), fauxToolCall("approve", {}, { id: "ask" })], { stopReason: "toolUse" })]);
  if (options.awaiting) await transcript.await(["ask"]);
  await transcript.log.close();
  const journal = fileStorage(join(fx.root, "sessions")).log<unknown>(`${id}.journal`);
  const now = Date.now();
  journal.append({ t: "request", record: { id: "turn-1", fingerprint: "fixture", method: "prompt", state: "running", startedAt: now, began: now, ...run } });
  await journal.flush(true);
  await journal.close();
  // Another node takes the agent over.
  await fx.restartHost();
  const read = async () => {
    const response = await fetch(`${fx.url}/clients/${id}/requests/turn-1`, { headers: { Authorization: `Bearer ${agent.session.token}` } });
    return response.json() as Promise<RequestRecord>;
  };
  const records = () => fileAppendLog<TranscriptRecord>(transcriptPath(join(fx.root, "agents", id))).read();
  return { fx, id, read, records };
}

/** The transcript's state and messages as the records give them. */
function replayed(records: TranscriptRecord[]) {
  const transcript = new Transcript(undefined as never);
  for (const record of records) transcript.apply(record);
  return transcript;
}

function assertSettled(records: TranscriptRecord[], awaiting = false) {
  const transcript = replayed(records);
  assert.equal(transcript.active, false, "the turn is settled");
  const results = transcript.context.filter(message => message.role === "toolResult") as { toolCallId: string; content: { text: string }[] }[];
  // Calls still open are answered as unknown; one waiting on a person stays open, and the turn stays suspended on it.
  assert.deepEqual(results.map(result => result.toolCallId), awaiting ? ["look"] : ["look", "ask"]);
  for (const result of results) assert.match(result.content[0].text, /outcome is unknown/);
  assert.deepEqual(transcript.awaiting, awaiting ? ["ask"] : []);
  // A fork without a point holds the turn's prompt, unless the turn still waits on a person (it has not ended).
  const cut = forkCut(records);
  assert.equal(recordedMessages(cut.records).some(message => JSON.stringify(message).includes("research it")), !awaiting);
}

test("a run past its resumes ends uncertain at a load only once the turn it left open is settled", async t => {
  const { read, records } = await lostTurn(t, { resumes: MAX_RESUMES });
  const ended = await read();
  assert.equal(ended.state, "completed", JSON.stringify(ended));
  assert.equal(ended.outcome?.uncertain, true);
  assertSettled(await records());
  const transcript = replayed(await records());
  assert.match(JSON.stringify(transcript.context.at(-1)), /Runtime notice/, "closed with the notice a restart leaves, so a continue does not resubmit it");
});

test("a run stopped before its node was lost ends aborted at a load only once the turn it left open is settled", async t => {
  const { read, records } = await lostTurn(t, { abortedAt: Date.now() } as Partial<RequestRecord>);
  const ended = await read();
  assert.equal(ended.state, "completed");
  assert.equal((ended.outcome?.result as { code?: string } | undefined)?.code, "aborted");
  assertSettled(await records());
});

test("a turn suspended on a person's input keeps that call open when its run ends at a load, and the others closed", async t => {
  const { read, records } = await lostTurn(t, { resumes: MAX_RESUMES }, { awaiting: true });
  assert.equal((await read()).state, "completed");
  assertSettled(await records(), true);
});

test("a resumed run whose agent fails to start ends only once the turn it left open is settled, its lost calls never made", async t => {
  const { fx, read, records } = await lostTurn(t, { resumes: 0 });
  let starts = 0;
  fx.supervisor.start = async () => { starts++; throw new Error("the agent could not start"); };
  const ended = await (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const record = await read();
      if (record.state === "completed") return record;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("the run never ended");
  })();
  assert.ok(starts >= 1, "the resume tried to start the agent");
  assert.match(String(ended.outcome?.error), /could not start/);
  assertSettled(await records());
});

/** A supervisor over a fresh directory, and an agent's transcript there holding a lost turn (`awaiting`: one call waits on a person). */
async function lostTranscript(t: { after(fn: () => unknown): void }, awaiting: boolean) {
  const root = await mkdtemp(join(tmpdir(), "close-turn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const supervisor = new AgentSupervisor(root);
  const id = "agent";
  const path = transcriptPath(join(root, id));
  await mkdir(join(root, id), { recursive: true });
  const transcript = new Transcript(fileAppendLog<TranscriptRecord>(path));
  await transcript.load();
  await transcript.setActive(true);
  await transcript.append([user("research it"), fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "look" }), fauxToolCall("approve", {}, { id: "ask" })], { stopReason: "toolUse" })]);
  if (awaiting) await transcript.await(["ask"]);
  await transcript.log.close();
  return { supervisor, id, records: () => fileAppendLog<TranscriptRecord>(path).read() };
}

const notices = (records: TranscriptRecord[]) => replayed(records).context.filter(message => message.role === "user" && JSON.stringify(message).includes("Runtime notice")).length;

for (const awaiting of [false, true]) {
  const kind = awaiting ? "a turn waiting on a person" : "a lost turn";
  test(`closing ${kind} again, after or alongside another close, answers each open call once (closeTurn is idempotent)`, async t => {
    const { supervisor, id, records } = await lostTranscript(t, awaiting);
    // One after the other: the second finds the turn settled.
    assert.equal(await supervisor.closeTurn(id), true);
    assert.equal(await supervisor.closeTurn(id), false);
    assertSettled(await records(), awaiting);
    assert.equal(notices(await records()), awaiting ? 0 : 1);
  });

  test(`closes of ${kind} made at once (a load's and a run's, or two loads') are one close`, async t => {
    const { supervisor, id, records } = await lostTranscript(t, awaiting);
    const closed = await Promise.all([supervisor.closeTurn(id), supervisor.closeTurn(id), supervisor.closeTurn(id)]);
    assert.deepEqual(closed.filter(Boolean).length, 1, "exactly one of them settled it");
    assertSettled(await records(), awaiting);
    assert.equal(notices(await records()), awaiting ? 0 : 1);
  });
}

test("a turn's repairs never answer a call that has its result already", () => {
  const messages = [user("research it"), fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "look" }), fauxToolCall("approve", {}, { id: "ask" })], { stopReason: "toolUse" }) as AgentMessage];
  const first = interruptedTurnRepairs(messages, false, ["ask"]);
  assert.deepEqual(first.map(message => (message as { toolCallId?: string }).toolCallId), ["look"]);
  assert.deepEqual(interruptedTurnRepairs([...messages, ...first], false, ["ask"]), [], "repaired already: nothing more");
  assert.deepEqual(interruptedTurnRepairs([...messages, ...first], false).map(message => (message as { toolCallId?: string }).toolCallId), ["ask"], "only the call still open");
});

test("a closed node loads no agent: a request it is still sent answers 503, and the next owner alone settles the turn", async t => {
  const fx = await fixture(t);
  const agent = await fx.start({});
  const id = agent.session.id;
  await fx.sessions.close();
  const response = await fetch(`${fx.url}/clients/${id}/requests/turn-1`, { headers: { Authorization: `Bearer ${agent.session.token}` } });
  assert.equal(response.status, 503);
  await response.body?.cancel();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http.ts";
import type { VoiceCredit } from "../src/voice-sessions.ts";
import { EndUserCredits } from "../src/end-user-credits.ts";
import { discordGrant, fakeTranscriber, speak, until, voiceCluster } from "./voice-fakes.ts";

/** End users' credit as end-user-credits.ts keeps it, reduced to a balance (USD) per subject and the holds on it. */
function fakeCredit(balances: Record<string, number>) {
  const log: string[] = [];
  const credit: VoiceCredit = {
    async refusal(_tenant, endUser) {
      return (balances[endUser] ?? 0) > 0 ? undefined : { reason: "balance", message: `${endUser} has no credit left` };
    },
    async hold(_tenant, endUser, bucket, usd, call, metadata) {
      if ((balances[endUser] ?? 0) < usd) throw new HttpError(402, `${endUser} has no credit left`, "END_USER_CREDIT", { endUser, bucket, reason: "balance" });
      balances[endUser] -= usd;
      log.push(`hold ${endUser} ${bucket} ${usd.toFixed(4)} ${call} ${JSON.stringify(metadata)}`);
      return {
        settle: async actual => { balances[endUser] += usd - actual; log.push(`settle ${actual.toFixed(4)}`); },
        release: async () => { balances[endUser] += usd; log.push("release"); },
      };
    },
  };
  return { credit, log, balances };
}

const PER_SECOND = 6_000 / 60 / 1_000_000;

test("a session for an end user with no credit is refused; one without a subject is the tenant's alone", async t => {
  const { credit } = fakeCredit({ rich: 1 });
  const { node } = await voiceCluster(t, { credit });
  const a = await node("http://a");
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), subject: "broke", bucket: "bot:7" }),
    (error: HttpError) => error.status === 402 && error.code === "END_USER_CREDIT" && error.details?.reason === "balance" && error.details?.bucket === "bot:7");
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), subject: "rich", bucket: "not a bucket!" }), (error: HttpError) => error.status === 400);
  assert.equal((await a.voice.create("alice", { discord: discordGrant(), subject: "rich" })).subject, "rich");
  await a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000055" }) });
});

test("each utterance holds its cost of the subject's credit and settles it; running out ends the session (budget, end_user)", async t => {
  // Enough for two one-second utterances.
  const { credit, log, balances } = fakeCredit({ ada: 2 * PER_SECOND });
  const { fake, node, events, transcription } = await voiceCluster(t, { credit });
  const a = await node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant(), subject: "ada", bucket: "bot:7", silenceMs: 200 });
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  for (let index = 0; index < 2; index++) {
    speak(connection, "400000000000000004", 0.6);
    await until(async () => (await a.voice.get("alice", created.id)).utterances === index + 1, `utterance ${index + 1}`);
  }
  assert.deepEqual(log, [
    `hold ada bot:7 ${PER_SECOND.toFixed(4)} voice {"session":"${created.id}"}`, `settle ${PER_SECOND.toFixed(4)}`,
    `hold ada bot:7 ${PER_SECOND.toFixed(4)} voice {"session":"${created.id}"}`, `settle ${PER_SECOND.toFixed(4)}`,
  ]);
  assert.ok(Math.abs(balances.ada) < 1e-12);
  speak(connection, "400000000000000004", 0.6);
  await until(async () => (await a.voice.get("alice", created.id)).state === "ended", "the end");
  const session = await a.voice.get("alice", created.id);
  assert.equal(session.endReason, "budget");
  assert.equal(session.limit, "end_user");
  assert.equal(session.endUserReason, "balance");
  assert.equal(transcription.calls.length, 2, "the third was never sent");
  const [ended] = await events("voice.session.ended");
  assert.deepEqual([ended.data.reason, ended.data.limit, ended.data.endUserReason, ended.data.bucket], ["budget", "end_user", "balance", "bot:7"]);
});

test("a transcription that fails gives its hold back", async t => {
  const { credit, log, balances } = fakeCredit({ ada: 1 });
  const failing = fakeTranscriber(() => { throw new Error("provider down"); });
  const { fake, node } = await voiceCluster(t, { credit, transcriber: failing.transcriber });
  const a = await node("http://a");
  await a.voice.create("alice", { discord: discordGrant(), subject: "ada", silenceMs: 200 });
  const connection = await until(() => fake.open()[0], "the connection");
  speak(connection, "400000000000000004", 0.6);
  await until(() => log.length === 2, "the hold and its release");
  assert.match(log[0], /^hold ada default /);
  assert.equal(log[1], "release");
  assert.equal(balances.ada, 1);
});

test("with the runtime's end-user credits: a call's speech is held, posted to the subject's ledger, and ends the session when it runs out", async t => {
  // voiceCluster's database, read once it exists: the credit service is made on it before any session.
  let credits: EndUserCredits | undefined;
  const credit: VoiceCredit = { refusal: (...args) => credits!.refusal(...args), hold: (...args) => credits!.hold(...args) };
  const { fake, node, db } = await voiceCluster(t, { credit });
  credits = new EndUserCredits(db);
  await credits.setSettings("alice", { enabled: true, allowances: { "*": 0 } });
  // Two whole seconds of transcription, at $0.006 a minute.
  await credits.post("alice", "ada", { kind: "grant", amount: 200, key: "payment-1" });
  await assert.rejects(node("http://x").then(x => x.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000066" }), subject: "nobody" })),
    (error: HttpError) => error.status === 402 && error.code === "END_USER_CREDIT");
  const a = await node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant(), subject: "ada", bucket: "bot:7", silenceMs: 200 });
  const connection = await until(() => fake.open().find(open => open.credentials.guildId === "100000000000000001"), "the connection");
  connection.handlers.ready();
  speak(connection, "400000000000000004", 1.5);
  await until(async () => (await a.voice.get("alice", created.id)).utterances === 1, "the utterance");
  const { entries } = await credits.ledger("alice", "ada");
  const usage = entries.find(entry => entry.kind === "usage")!;
  assert.equal(usage.raw, 200, "two seconds");
  assert.equal(usage.bucket, "bot:7");
  assert.equal(Number((await db.query("select count(*) as count from end_user_holds")).rows[0].count), 0, "no hold left");
  speak(connection, "400000000000000004", 1.5);
  await until(async () => (await a.voice.get("alice", created.id)).state === "ended", "the end");
  const session = await a.voice.get("alice", created.id);
  assert.deepEqual([session.endReason, session.limit, session.endUserReason], ["budget", "end_user", "balance"]);
});

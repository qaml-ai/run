import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http.ts";
import type { VoiceCredit } from "../src/voice-sessions.ts";
import { EndUserCredits } from "../src/end-user-credits.ts";
import { REALTIME_LIMITS } from "../src/voice/realtime/brain.ts";
import { discordGrant, speak, until, voiceCluster } from "./voice-fakes.ts";

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

/** A response's usage that costs $0.04 on gpt-realtime-2.1 (625 output audio tokens at $64 a million). */
const FOUR_CENTS = { outputAudio: 625 };
const HOLD = REALTIME_LIMITS.holdUsd;

/** A live session for `subject`, its call's connection, and the model's: each `turn()` is someone speaking, and the model answering with `usage`. */
async function liveSession(cluster: Awaited<ReturnType<typeof voiceCluster>>, input: Record<string, unknown>) {
  const a = await cluster.node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant(), silenceMs: 200, ...input });
  const connection = await until(() => cluster.fake.open().find(open => open.credentials.guildId === "100000000000000001"), "the connection");
  connection.others = ["400000000000000004"];
  connection.handlers.ready();
  const model = await until(() => cluster.realtime.connections.at(-1), "the model");
  let turns = 0;
  const turn = async (usage: Record<string, number> = FOUR_CENTS) => {
    const asked = ++turns;
    speak(connection, "400000000000000004", 0.6);
    await until(() => model.responses === asked, `response ${asked} asked for`);
    await model.answer(`resp_${asked}`, { ms: 100, usage });
    await until(() => connection.played.length === asked && !connection.playing, `response ${asked} played`);
  };
  return { a, created, connection, model, turn };
}

test("each response holds of the subject's credit before it is asked for, and settles at what it cost; running out ends the session (budget, end_user)", async t => {
  // Enough for two responses: each holds $0.05 and costs $0.04.
  const { credit, log, balances } = fakeCredit({ ada: 0.1 });
  const cluster = await voiceCluster(t, { credit });
  const { a, created, model, turn } = await liveSession(cluster, { subject: "ada", bucket: "bot:7" });
  await turn();
  await turn();
  await until(() => log.length === 4, "two holds settled");
  assert.deepEqual(log, [
    `hold ada bot:7 ${HOLD.toFixed(4)} voice_realtime {"session":"${created.id}"}`, "settle 0.0400",
    `hold ada bot:7 ${HOLD.toFixed(4)} voice_realtime {"session":"${created.id}"}`, "settle 0.0400",
  ]);
  assert.ok(Math.abs(balances.ada - 0.02) < 1e-9);
  // The third cannot be held: its response is cancelled, unheard, and the session ends.
  speak(cluster.fake.open()[0], "400000000000000004", 0.6);
  await until(async () => (await a.voice.get("alice", created.id)).state === "ended", "the end");
  assert.ok(model.of("cancel").length >= 1, "the refused response was cancelled");
  const session = await a.voice.get("alice", created.id);
  assert.deepEqual([session.endReason, session.limit, session.endUserReason], ["budget", "end_user", "balance"]);
  const [ended] = await cluster.events("voice.session.ended");
  assert.deepEqual([ended.data.reason, ended.data.limit, ended.data.endUserReason, ended.data.bucket], ["budget", "end_user", "balance", "bot:7"]);
});

test("a response that costs nothing (cancelled before it made anything) gives its hold back", async t => {
  const { credit, log, balances } = fakeCredit({ ada: 1 });
  const cluster = await voiceCluster(t, { credit });
  const { turn } = await liveSession(cluster, { subject: "ada" });
  await turn({});
  await until(() => log.length === 2, "the hold and its release");
  assert.match(log[0], /^hold ada default /);
  assert.equal(log[1], "release");
  assert.equal(balances.ada, 1);
});

test("with the runtime's end-user credits: a call's responses are held, posted to the subject's ledger, and end the session when it runs out", async t => {
  // voiceCluster's database, read once it exists: the credit service is made on it before any session.
  let credits: EndUserCredits | undefined;
  const credit: VoiceCredit = { refusal: (...args) => credits!.refusal(...args), hold: (...args) => credits!.hold(...args) };
  const cluster = await voiceCluster(t, { credit });
  credits = new EndUserCredits(cluster.db);
  await credits.setSettings("alice", { enabled: true, allowances: { "*": 0 } });
  // $0.10, in micro-USD: two responses' holds and their cost.
  await credits.post("alice", "ada", { kind: "grant", amount: 100_000, key: "payment-1" });
  await assert.rejects(cluster.node("http://x").then(x => x.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000066" }), subject: "nobody" })),
    (error: HttpError) => error.status === 402 && error.code === "END_USER_CREDIT");
  const { a, created, turn } = await liveSession(cluster, { subject: "ada", bucket: "bot:7" });
  await turn();
  const usage = await until(async () => (await credits!.ledger("alice", "ada")).entries.find(entry => entry.kind === "usage"), "the response posted");
  assert.equal(usage.raw, 40_000, "what it cost");
  assert.equal(usage.bucket, "bot:7");
  await until(async () => Number((await cluster.db.query("select count(*) as count from end_user_holds")).rows[0].count) === 0, "no hold left");
  await turn();
  speak(cluster.fake.open()[0], "400000000000000004", 0.6);
  await until(async () => (await a.voice.get("alice", created.id)).state === "ended", "the end");
  const session = await a.voice.get("alice", created.id);
  assert.deepEqual([session.endReason, session.limit, session.endUserReason], ["budget", "end_user", "balance"]);
});

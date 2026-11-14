import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http.ts";
import type { VoiceCredit } from "../src/voice-sessions.ts";
import { EndUserCredits } from "../src/end-user-credits.ts";
import { discordGrant, speak, until, voiceCluster } from "./voice-fakes.ts";

function fakeCredit(balances: Record<string, number>) {
  const log: number[] = [];
  const keys = new Set<string>();
  const credit: VoiceCredit = {
    async refusal(_tenant, endUser, bucket) {
      return (balances[endUser] ?? 0) > 0 ? undefined : { endUser, bucket, reason: "balance", message: `${endUser} is out of credit` };
    },
    async debit(_tenant, endUser, _bucket, usd, key) {
      if (keys.has(key)) return;
      keys.add(key);
      balances[endUser] -= usd;
      log.push(usd);
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

test("a realtime session starts with any credit left, even a tiny balance, and is refused with none", async t => {
  const { credit } = fakeCredit({ short: 0.000001, none: 0 });
  const { node } = await voiceCluster(t, { credit });
  const a = await node("http://a");
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), subject: "none", bucket: "bot:7" }),
    (error: HttpError) => error.status === 402 && error.code === "END_USER_CREDIT" && error.details?.reason === "balance");
  assert.equal((await a.voice.create("alice", { discord: discordGrant(), subject: "short", bucket: "bot:7" })).subject, "short");
});

/** A response's usage that costs $0.04 on gpt-realtime-2.1 (625 output audio tokens at $64 a million). */
const FOUR_CENTS = { outputAudio: 625 };

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

test("a Discord response debits its full cost from a tiny balance and the next is refused", async t => {
  const { credit, log, balances } = fakeCredit({ ada: 0.000001 });
  const cluster = await voiceCluster(t, { credit });
  const { a, created, model, turn, connection } = await liveSession(cluster, { subject: "ada", bucket: "bot:7" });
  await turn();
  await until(() => log.length === 1, "response posted");
  assert.deepEqual(log, [0.04]);
  assert.equal(balances.ada, 0.000001 - 0.04);
  speak(connection, "400000000000000004", 0.6);
  await until(async () => (await a.voice.get("alice", created.id)).state === "ended", "the end");
  assert.equal(model.responses, 1, "the next response was never requested");
  const [ended] = await cluster.events("voice.session.ended");
  assert.deepEqual([ended.data.reason, ended.data.limit, ended.data.endUserReason, ended.data.bucket], ["budget", "end_user", "balance", "bot:7"]);
});

test("a zero-usage response has no debit", async t => {
  const { credit, log, balances } = fakeCredit({ ada: 1 });
  const cluster = await voiceCluster(t, { credit });
  const { turn } = await liveSession(cluster, { subject: "ada" });
  await turn({});
  assert.deepEqual(log, []);
  assert.equal(balances.ada, 1);
});

test("with the runtime's end-user credits: a call's responses are posted to the subject's ledger, and end the session when it runs out", async t => {
  // voiceCluster's database, read once it exists: the credit service is made on it before any session.
  let credits: EndUserCredits | undefined;
  const credit: VoiceCredit = { refusal: (...args) => credits!.refusal(...args), debit: (...args) => credits!.debit(...args) };
  const cluster = await voiceCluster(t, { credit });
  credits = new EndUserCredits(cluster.db);
  await credits.setSettings("alice", { enabled: true, allowances: { "*": 0 } });
  // $0.10, in micro-USD: enough for two responses and part of a third.
  await credits.post("alice", "ada", { kind: "grant", amount: 100_000, key: "payment-1" });
  await assert.rejects(cluster.node("http://x").then(x => x.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000066" }), subject: "nobody" })),
    (error: HttpError) => error.status === 402 && error.code === "END_USER_CREDIT");
  const { a, created, turn } = await liveSession(cluster, { subject: "ada", bucket: "bot:7" });
  await turn();
  const usage = await until(async () => (await credits!.ledger("alice", "ada")).entries.find(entry => entry.kind === "usage"), "the response posted");
  assert.equal(usage.raw, 40_000, "what it cost");
  assert.equal(usage.bucket, "bot:7");
  await turn();
  // $0.02 left, less than a response costs: a new call starts on it, as this one's next answer does.
  const last = await a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000068" }), subject: "ada", bucket: "bot:7" });
  await a.voice.end("alice", last.id);
  await turn();
  await until(async () => (await credits!.get("alice", "ada")).balance === -20_000, "the last response settles in full");
  assert.equal((await cluster.db.query("select sum(written_off)::int as lost from end_user_days where bucket = 'bot:7'")).rows[0].lost, 0, "the full cost was debited");
  speak(cluster.fake.open()[0], "400000000000000004", 0.6);
  await until(async () => (await a.voice.get("alice", created.id)).state === "ended", "the end");
  const session = await a.voice.get("alice", created.id);
  assert.deepEqual([session.endReason, session.limit, session.endUserReason], ["budget", "end_user", "balance"]);
  // Nothing left: a new call is refused as it starts.
  await assert.rejects(a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000067" }), subject: "ada", bucket: "bot:7" }),
    (error: HttpError) => error.status === 402 && error.code === "END_USER_CREDIT" && error.details?.reason === "balance");
});


test("voice uses the shared bot allowance and ends on budget after another bot spends it", async t => {
  let credits: EndUserCredits;
  const credit: VoiceCredit = { refusal: (...args) => credits.refusal(...args), debit: (...args) => credits.debit(...args) };
  const cluster = await voiceCluster(t, { credit });
  credits = new EndUserCredits(cluster.db);
  await credits.setSettings("alice", { enabled: true, sharedAllowances: { "bot:*": 100_000 } });
  const { a, created, turn } = await liveSession(cluster, { subject: "ada", bucket: "bot:voice" });
  await turn();
  await until(async () => (await credits.get("alice", "ada")).today.pools[0].allowanceSpent === 40_000, "voice settled to the pool");
  await credits.debit("alice", "ada", "bot:text", (60_000) / 1_000_000, "other-bot");
  speak(cluster.fake.open()[0], "400000000000000004", 0.6);
  await until(async () => (await a.voice.get("alice", created.id)).state === "ended", "shared pool exhaustion ends voice");
  const session = await a.voice.get("alice", created.id);
  assert.deepEqual([session.endReason, session.limit, session.endUserReason], ["budget", "end_user", "balance"]);
  const user = await credits.get("alice", "ada");
  assert.equal(user.balance, 0);
  assert.equal(user.today.pools[0].allowanceSpent, 100_000);
  assert.deepEqual(user.today.buckets.map(row => [row.bucket, row.allowanceSpent]), [["bot:text", 60_000], ["bot:voice", 40_000]]);
});

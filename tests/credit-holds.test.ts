import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { ModelAttempts } from "../src/model-attempts.ts";
import type { AttemptAck } from "../src/model-attempt.ts";
import type { Db } from "../src/db.ts";
import { testDatabase } from "./database.ts";
import { OPERATOR, runtime } from "./runtime-server.ts";

const KEY = "fixture-only", keyHash = createHash("sha256").update(KEY).digest("hex");
const USD = 1_000_000;
const PRO = "openai/gpt-5.5-pro"; // $30/$180 per million, $60/$270 past 272k input
const MILLION_IN = { inputTokens: 1_000_000, maxOutputTokens: 128_000, rates: { input: 0, output: 0 } };
const SMALL = { inputTokens: 1_000, maxOutputTokens: 128_000, rates: { input: 0, output: 0 } };

async function setup(balance: number, purchased = balance) {
  const { db } = await testDatabase();
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { payg: { tokenSha256: keyHash, billing: "prepaid" } }, platformKeys: { openrouter: KEY } }) });
  await tenants.reload();
  const account = new Accounts({ tenants, db });
  await db.query("insert into credit_accounts (tenant, balance, purchased) values ('payg', $1, $2)", [balance, purchased]);
  const attempts = new ModelAttempts(db, account);
  const begin = async (model: string, estimate: object | undefined, id = randomUUID(), platform = true) => ({ id, ack: await attempts.event("payg", "agent", platform, true, { type: "begin", id, provider: "openrouter", model, kind: "response", at: Date.now(), keyHash, ...(estimate ? { estimate } : {}) } as never) as AttemptAck | boolean });
  return { db, attempts, begin };
}
const held = async (db: Db) => Number((await db.query("select coalesce(sum(amount),0)::bigint as n from credit_holds")).rows[0].n);
const ack = (value: AttemptAck | boolean) => value as AttemptAck;

test("a dear call a small balance cannot pay for is refused before it is made, and leaves no attempt", async () => {
  const { db, begin } = await setup(USD / 100);
  const { id, ack: answer } = await begin(PRO, MILLION_IN);
  assert.equal(ack(answer).tracked, false);
  assert.match(ack(answer).refused!.message, /credit/);
  assert.equal(ack(answer).refused!.endUser, undefined, "the tenant's credit, not an end user's");
  assert.equal((await db.query("select 1 from model_attempts where id=$1", [id])).rowCount, 0);
  assert.equal(await held(db), 0);
});

test("the long-context tier counts: $60 per million past 272k input, not $30", async () => {
  const { begin } = await setup(45 * USD);
  assert.ok(ack((await begin(PRO, MILLION_IN)).ack).refused, "$45 covers the base rate, not the tier");
});

test("max_tokens is sized to what is left, so reasoning that never streams is bounded; holds leave room for other calls", async () => {
  const { db, begin, attempts } = await setup(USD);
  const first = await begin(PRO, SMALL);
  const answer = ack(first.ack);
  assert.equal(answer.tracked, true);
  // $1 less about $0.0317 of input (with OpenRouter's funding), at $180 * 1.055 per million out: about 5,100 tokens, not 128,000.
  assert.ok(answer.maxOutputTokens! > 4_500 && answer.maxOutputTokens! < 5_300, String(answer.maxOutputTokens));
  assert.ok(answer.stopAtChars! > 0 && answer.checkAtChars! <= answer.stopAtChars!);
  const before = await held(db);
  assert.ok(before > 0 && before < USD, "it holds what a reply takes, not all it may ask for");
  // Another call starts on what is left, and sees less.
  const second = await begin(PRO, SMALL);
  assert.ok(ack(second.ack).maxOutputTokens! < answer.maxOutputTokens!);
  // A long reply holds more as it streams, and stops being able to where the credit ends.
  const more = await attempts.event("payg", "agent", true, true, { type: "progress", id: first.id, chars: answer.checkAtChars! }) as AttemptAck;
  assert.ok(more.stopAtChars! > answer.stopAtChars!);
  assert.ok(await held(db) > before);
  const out = await attempts.event("payg", "agent", true, true, { type: "progress", id: first.id, chars: 40_000 }) as AttemptAck;
  assert.ok(out.refused, "past what the credit pays for");
  // Settling releases the hold and charges what it cost, once.
  await attempts.event("payg", "agent", true, true, { type: "finish", id: first.id, usage: { input: 100, output: 10, providerCost: 0.2, providerCreditCost: 0 }, chars: 40, completed: true });
  await attempts.event("payg", "agent", true, true, { type: "finish", id: second.id, usage: { input: 0, output: 0 }, chars: 0, completed: false });
  assert.equal(await held(db), 0);
  const balance = Number((await db.query("select balance from credit_accounts where tenant='payg'")).rows[0].balance);
  assert.ok(balance < USD && balance > 0.7 * USD, String(balance));
});

test("people can spend all they paid for: a last call starts within the shortfall, then nothing does", async () => {
  // About $0.37 of input and the least reply, on $0.12: within $0.25.
  const { db, begin } = await setup(120_000);
  const estimate = { inputTokens: 10_000, maxOutputTokens: 128_000, rates: { input: 0, output: 0 } };
  const last = ack((await begin(PRO, estimate)).ack);
  assert.equal(last.tracked, true);
  assert.equal(await held(db), 120_000, "all that is left");
  assert.ok(last.maxOutputTokens! >= 256, "a call that starts gets a short reply");
  assert.ok(ack((await begin(PRO, estimate)).ack).refused, "nothing left for another");
});

test("an unknown price holds at a mid-range one; a router's zero is unknown; :free holds nothing; no estimate, own key and no billing hold nothing", async () => {
  const { db, begin } = await setup(USD);
  const estimate = { inputTokens: 100_000, maxOutputTokens: 100_000, rates: { input: 0, output: 0 } };
  const unknown = ack((await begin("nobody/not-in-the-catalog", estimate)).ack);
  // $3/$15 with funding: $0.3165 of input.
  assert.ok(await held(db) > 0.3 * USD, "held at $3 per million in");
  assert.ok(unknown.maxOutputTokens! < 100_000 && unknown.maxOutputTokens! > 30_000, String(unknown.maxOutputTokens));
  const before = await held(db);
  assert.equal(ack((await begin("openrouter/auto", estimate)).ack).tracked, true);
  assert.ok(await held(db) > before, "a router's listed zero is not free");
  const routed = await held(db);
  assert.equal((await begin("meta-llama/llama-4-scout:free", estimate)).ack, true, ":free holds nothing");
  assert.equal((await begin(PRO, undefined)).ack, true, "no estimate");
  assert.equal((await begin(PRO, MILLION_IN, randomUUID(), false)).ack, true, "the tenant's own key");
  assert.equal(await held(db), routed);
});

test("on free credit a call is held within the hour's allowance, not the whole balance", async () => {
  const { begin } = await setup(5 * USD, 0);
  const estimate = { inputTokens: 100_000, maxOutputTokens: 1_000, rates: { input: 0, output: 0 } };
  assert.ok(ack((await begin(PRO, estimate)).ack).refused, "$3 of input on a $1 hour, with $5 of free credit");
  assert.equal(ack((await begin("deepseek/deepseek-v4.1-flash", estimate)).ack).tracked, true);
});

test("a run on a tenant with too little credit stops before any call, as a spend limit; a small balance caps the call's max_tokens", async t => {
  const tenants = { tenants: { alice: { tokenSha256: createHash("sha256").update(OPERATOR).digest("hex"), billing: "prepaid" } }, platformKeys: { openrouter: "fixture-platform-key" } };
  let calls = 0;
  const r = await runtime(t, () => { calls++; return { role: "assistant", content: "Done.", usage: { prompt_tokens: 10, completion_tokens: 2 } }; }, { AGENT_MODEL: PRO, AGENT_PRICE_AGENT_HOUR_USD: "0" }, tenants);
  await r.db.query("insert into credit_accounts (tenant, balance, purchased) values ('alice', $1, $1)", [USD / 2]);
  const agent = (await r.call("/v1/agents", { body: { systemPrompt: "Be brief." } })).json.id;
  const done = await r.prompt(agent, "Hello");
  assert.equal(done.outcome.result.reply, "Done.");
  const sent = r.model.bodies.at(-1)!;
  const asked = sent.max_output_tokens ?? sent.max_completion_tokens ?? sent.max_tokens;
  assert.ok(asked < 3_000, `$0.50 at $180 per million: ${asked}`);

  // Left with a cent, a request whose input is far past that is not made.
  await r.db.query("update credit_accounts set balance = $1 where tenant = 'alice'", [10_000]);
  calls = 0;
  const big = await r.prompt(agent, "x ".repeat(200_000));
  assert.equal(calls, 0, "no call was made");
  assert.equal(big.outcome.result.stopped, "spend_limit");
  assert.equal(big.outcome.result.limit, "credit");
});

test("a hold whose host went away lapses and stops counting", async () => {
  const { db, begin } = await setup(USD);
  await begin(PRO, SMALL);
  await db.query("update credit_holds set expires_at = 1");
  const next = ack((await begin(PRO, SMALL)).ack);
  assert.equal(next.tracked, true);
  assert.equal(Number((await db.query("select count(*) n from credit_holds")).rows[0].n), 1, "the lapsed one is gone");
});

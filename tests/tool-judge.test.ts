import { test } from "node:test";
import assert from "node:assert/strict";
import { Decider, DecisionFailed, type DecisionItem, type DecisionProvider, type ProviderDecision } from "../src/decisions.ts";
import { JUDGE_LIMITS } from "../src/limits.ts";
import { DENIED_PERMISSION, judgeable, judgedOutcome, judgeItem, judgeState, toolJudge, UNJUDGED, type JudgeInput } from "../src/tool-judge.ts";

const CALL: JudgeInput = { tool: "shop__delete_item", description: "Delete an item", args: { id: "a" }, intent: "Delete item a from the shop" };

/** A judge's answers, as the decisions provider gives them: one noul a question. */
const answers = (ordinary: number, irreversible: number, exfiltration: number) => ({
  ordinary: { type: "noul" as const, noul: ordinary },
  irreversible: { type: "noul" as const, noul: irreversible },
  exfiltration: { type: "noul" as const, noul: exfiltration },
});

/** A provider that records what it is asked and answers from `reply`. */
function provider(reply: (item: DecisionItem, index: number) => ProviderDecision | Promise<ProviderDecision>) {
  const seen: DecisionItem[] = [];
  const fake: DecisionProvider = {
    id: "openrouter",
    dataPolicy: true,
    async decide(item) { seen.push(structuredClone(item)); return await reply(item, seen.length - 1); },
  };
  return { fake, seen };
}
const decided = (ordinary: number, irreversible: number, exfiltration: number, cost = 0.00002): ProviderDecision =>
  ({ answers: answers(ordinary, irreversible, exfiltration), inputTokens: 400, outputTokens: 8, costUsd: cost });
const key = async () => ({ apiKey: "fixture-key", platform: true });
const noWait = async () => {};

test("a judged call asks three fixed questions about the request, the tool and its arguments", () => {
  const item = judgeItem(CALL);
  assert.deepEqual(Object.keys(item.questions).sort(), ["exfiltration", "irreversible", "ordinary"]);
  for (const question of Object.values(item.questions)) assert.equal(question.type, "noul");
  const state = JSON.parse(item.state as string);
  assert.deepEqual(state, { request: "Delete item a from the shop", tool: "shop__delete_item", description: "Delete an item", arguments: JSON.stringify({ id: "a" }) });
  // Nothing to authorize it by: the request is left out rather than made up.
  assert.equal(JSON.parse(judgeState({ ...CALL, intent: undefined })).request, undefined);
  assert.equal(JSON.parse(judgeState({ ...CALL, intent: "   " })).request, undefined);
});

test("a request longer than its limit keeps its start and its end, so a restriction said last is seen", () => {
  const intent = `${"x".repeat(JUDGE_LIMITS.intentChars)}…and never touch production.`;
  const state = JSON.parse(judgeState({ ...CALL, intent }));
  assert.ok(state.request.startsWith("x"));
  assert.ok(state.request.endsWith("and never touch production."), "the end is kept");
  assert.match(state.request, /left out/);
  assert.ok(state.request.length < intent.length);
  // A call within the limits is shown whole: an argument that is JSON stays JSON.
  assert.equal(JSON.parse(judgeState(CALL)).arguments, JSON.stringify({ id: "a" }));
  assert.equal(JSON.parse(judgeState({ ...CALL, intent: "  " })).request, undefined);
});

test("what the judge cannot see whole it does not judge: over-limit arguments or a description ask the person", async () => {
  const big = { ...CALL, args: { padding: "a".repeat(JUDGE_LIMITS.argumentsChars), action: "delete_everything" } };
  assert.equal(judgeable(CALL), true);
  assert.equal(judgeable({ ...CALL, args: { blob: "a".repeat(JUDGE_LIMITS.argumentsChars) } }), false, "arguments past their limit are not judged from a prefix");
  assert.equal(judgeable({ ...CALL, description: "d".repeat(JUDGE_LIMITS.descriptionChars + 1) }), false);
  // A description exactly at the limit is fine: tool-sources caps a model-facing description at the same length.
  assert.equal(judgeable({ ...CALL, description: "d".repeat(JUDGE_LIMITS.descriptionChars) }), true);

  let asked = 0;
  const seen: any[] = [];
  const judge = toolJudge(new Decider({ provider: provider(() => { asked++; return decided(0.99, 0, 0); }).fake, key }), { tenant: "t1", onJudged: (input, judged) => seen.push({ tool: input.tool, ...judged }) });
  assert.deepEqual(await judge(big, AbortSignal.timeout(5_000)), { ...UNJUDGED, reason: "unjudgeable" });
  assert.equal(asked, 0, "nothing was sent to the model: the person decides");
  assert.deepEqual(seen, [{ tool: big.tool, ...UNJUDGED, reason: "unjudgeable" }], "an ask it could not judge is still counted");
});

test("an ask the judge did not make is logged with why, and a spent budget sends nothing", async () => {
  const seen: any[] = [];
  const budgeted = toolJudge(new Decider({ provider: provider(() => decided(0.99, 0, 0)).fake, key }), { tenant: "t1", budget: async () => 0, onJudged: (_input, judged) => seen.push(judged.reason) });
  assert.equal((await budgeted(CALL, AbortSignal.timeout(5_000))).reason, "budget");
  assert.deepEqual(seen, ["budget"]);
  const failed: any[] = [];
  const failing = toolJudge(new Decider({ provider: provider(() => { throw new DecisionFailed(502, "down"); }).fake, key, sleep: noWait }), { tenant: "t1", onJudged: (_input, judged) => failed.push(judged.reason) });
  assert.equal((await failing(CALL, AbortSignal.timeout(5_000))).reason, "failed");
  assert.deepEqual(failed, ["failed"]);
});

test("the decision table: ordinary allows, anything that may be irreversible asks, exfiltration denies", () => {
  assert.deepEqual(judgedOutcome(answers(0.95, 0.01, 0)), { decision: "allow", risk: "low", likely: 0.95 });
  // Thresholds are read as probabilities: an ordinary call needs 0.75.
  assert.equal(judgedOutcome(answers(0.75, 0.01, 0)).decision, "allow");
  assert.equal(judgedOutcome(answers(0.74, 0.01, 0)).decision, "ask");
  // Medium wins over ordinary, high wins over both.
  assert.deepEqual(judgedOutcome(answers(0.99, 0.9, 0.01)), { decision: "ask", risk: "medium", likely: 0.9 });
  assert.deepEqual(judgedOutcome(answers(0.99, 0.01, 0.5)), { decision: "deny", risk: "high", likely: 0.5 });
  assert.deepEqual(judgedOutcome(answers(0, 0, 0.9)), { decision: "deny", risk: "high", likely: 0.9 });
  // A call that is neither ordinary nor risky is still not the judge's to allow.
  assert.equal(judgedOutcome(answers(0.3, 0.1, 0.05)).decision, "ask");
  assert.equal(judgedOutcome(answers(0.3, 0.1, 0.05)).risk, "medium");
  // An answer that is not there asks: a question the model left unanswered is not a yes.
  assert.deepEqual(judgedOutcome({}), UNJUDGED);
  assert.deepEqual(judgedOutcome({ ordinary: { type: "noul", noul: 1 } }), UNJUDGED);
});

test("a judge answers from the decisions service and records what it cost", async () => {
  const { fake, seen } = provider(() => decided(0.95, 0.01, 0));
  const decider = new Decider({ provider: fake, key });
  const usage: any[] = [];
  const judge = toolJudge(decider, { tenant: "t1", keyScope: "scope-1", dataCollection: "deny", record: record => usage.push(record) });
  assert.deepEqual(await judge(CALL, AbortSignal.timeout(5_000)), { decision: "allow", risk: "low", likely: 0.95 });
  assert.equal(seen.length, 1);
  assert.equal(JSON.parse(seen[0]!.state as string).request, CALL.intent, "the request is shown to the judge");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].kind, "decision");
  assert.equal(usage[0].model, "typesafe/jev-1.14");
  assert.equal(usage[0].usage.cost.total, 0.00002);
});

test("a judge that cannot answer asks a person instead, and never allows: no key, no budget, a failure, a bad answer", async () => {
  // No key decisions could use: the decider refuses before sending anything.
  const keyless = new Decider({ provider: provider(() => decided(0.99, 0, 0)).fake, key: async () => undefined });
  assert.deepEqual(await toolJudge(keyless, { tenant: "t1" })(CALL, AbortSignal.timeout(5_000)), { ...UNJUDGED, reason: "failed" });

  // A run with nothing left of its spend limit: nothing is sent, and the call asks.
  let asked = 0;
  const budgeted = toolJudge(new Decider({ provider: provider(() => { asked++; return decided(0.99, 0, 0); }).fake, key }), { tenant: "t1", budget: async () => 0 });
  assert.deepEqual(await budgeted(CALL, AbortSignal.timeout(5_000)), { ...UNJUDGED, reason: "budget" });
  assert.equal(asked, 0);

  // A provider that fails, once and finally (a 401 is not retried).
  const errors: unknown[] = [];
  const failing = toolJudge(new Decider({ provider: provider(() => { throw new DecisionFailed(502, "OpenRouter rejected the API key (HTTP 401)"); }).fake, key, sleep: noWait }), { tenant: "t1", onError: error => errors.push(error) });
  assert.deepEqual(await failing(CALL, AbortSignal.timeout(5_000)), { ...UNJUDGED, reason: "failed" });
  assert.equal(errors.length, 1);

  // An answer whose questions do not check out is a failure too: it fails closed, like no answer at all, and says so once.
  const malformedErrors: unknown[] = [];
  const malformed = toolJudge(new Decider({ provider: provider(() => ({ answers: { ordinary: "yes" }, inputTokens: 1, outputTokens: 0 })).fake, key }),
    { tenant: "t1", onError: error => malformedErrors.push(error) });
  assert.deepEqual(await malformed(CALL, AbortSignal.timeout(5_000)), { ...UNJUDGED, reason: "failed" });
  assert.equal(malformedErrors.length, 1);

  // A provider that answers too slowly asks too: a timed-out call is not a yes.
  const slowProvider: DecisionProvider = {
    id: "openrouter", dataPolicy: true,
    // Answers after the judge's own deadline: the call's signal aborts first, as a real provider's would.
    decide: async (_item, _model, _credentials, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 120);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted by the deadline")); }, { once: true });
      });
      return decided(0.99, 0, 0);
    },
  };
  const slow = toolJudge(new Decider({ provider: slowProvider, key, sleep: noWait, limits: { callTimeoutMs: 50, attempts: 1 } }), { tenant: "t1" });
  assert.deepEqual(await slow(CALL, AbortSignal.timeout(5_000)), { ...UNJUDGED, reason: "failed" });

  // A call that was aborted is not a judge that could not answer: nothing is asked, and the abort goes on.
  const controller = new AbortController();
  controller.abort(new Error("the turn was stopped"));
  const aborted = toolJudge(new Decider({ provider: provider(() => decided(0.99, 0, 0)).fake, key }), { tenant: "t1" });
  await assert.rejects(aborted(CALL, controller.signal), /the turn was stopped/);

  // A revoked data policy where the provider cannot pass it on: refused, and the call asks.
  const strict: DecisionProvider = { ...provider(() => decided(0.99, 0, 0)).fake, id: "other", dataPolicy: false };
  const refused = toolJudge(new Decider({ provider: strict, key }), { tenant: "t1", dataCollection: "deny" });
  assert.deepEqual(await refused(CALL, AbortSignal.timeout(5_000)), { ...UNJUDGED, reason: "failed" });
});

test("a denied call's result tells the model it did not run, without saying why or who decided", () => {
  const text = DENIED_PERMISSION("shop__delete_item");
  assert.match(text, /^Permission to use shop__delete_item has been denied/);
  assert.match(text, /Do not retry/);
  assert.ok(!/probab|Jev|decide|risk score/i.test(text), "the judge's own reading is not the model's to argue with");
});

test("the judge reads the session's scope and data policy at call time, not when the agent's tools were built", async () => {
  const scopes: (string | undefined)[] = [];
  const strict: DecisionProvider = { ...provider(() => decided(0.99, 0, 0)).fake, id: "other", dataPolicy: false };
  const decider = new Decider({ provider: strict, key: async (_tenant, keyScope) => { scopes.push(keyScope); return { apiKey: "k", platform: true }; } });
  const session: any = { header: { tenant: "t1", id: "a1", keyScope: "old", config: { dataCollection: null } }, running: new Map(), spend: undefined };
  const { judgeFor } = await import("../src/client-sessions/spend.ts");
  const judge = judgeFor({ options: { decider }, spent: () => {} } as any, session)!;
  assert.ok(judge, "a decider gives a judge");
  await judge(CALL, AbortSignal.timeout(5_000));
  assert.deepEqual(scopes, ["old"], "the key scope of the call");
  // A live configure changes the header without rebuilding the tools: the next call must use the new values.
  session.header.keyScope = "new";
  await judge(CALL, AbortSignal.timeout(5_000));
  assert.deepEqual(scopes, ["old", "new"], "the scope the session has now, not the one it had at build time");
  // The data policy the agent has now: this provider cannot pass it on, so the call asks and nothing is sent.
  session.header.config.dataCollection = "deny";
  const asked = await judge(CALL, AbortSignal.timeout(5_000));
  assert.equal(asked.decision, "ask");
  assert.deepEqual(scopes, ["old", "new"], "a refused data policy sends nothing");
});

import assert from "node:assert/strict";
import test from "node:test";
import { answerHuman, bindHumanInput, cancelledHumanInput, humanInputResult, humanInputView, sameHumanAnswer } from "../src/human.ts";
import { answerList, humanInputSettings, questionsInput } from "../src/input-policy.ts";

const questions = questionsInput([{ question: "Where?", header: "Region", options: [{ label: "EU" }, { label: "US" }] }]);
const input = { question: "Where?", kind: "question" as const, detail: { questions }, createdAt: 1000 };
const accept = { action: "accept", content: { answers: { "Where?": "EU" } } };

test("human input binds source audience and expiry once before it is published", () => {
  const settings = humanInputSettings({ expiresInSeconds: 60, approvers: ["boss"] });
  const bound = bindHumanInput(input, "run-a", "alice", settings, 40_000);
  assert.deepEqual(bound.responders, { audience: ["alice"] });
  assert.equal(bound.expiresAt, 40_000);
  assert.equal(bound.requestId, "run-a");
  assert.strictEqual(bindHumanInput(bound, "run-b", "mallory", undefined, null), bound);
  assert.deepEqual(humanInputView("input-a", bound, "agent-a", "run-a").responders, { audience: ["alice"] });
  for (const invalid of [{ expiresInSeconds: 59 }, { onExpire: "ignore" }, { approvers: [""] }, { unknown: true }])
    assert.throws(() => humanInputSettings(invalid));
});

test("human answers enforce source identity and produce source question metadata", () => {
  const bound = bindHumanInput(input, "run-a", "alice", undefined, null);
  bound.expiresAt = Date.now() + 60_000;
  assert.throws(() => answerHuman(bound, accept), /from or actor/);
  assert.throws(() => answerHuman(bound, { ...accept, actor: "mallory" }), error => (error as { status: number }).status === 403);
  assert.throws(() => answerHuman(bound, { ...accept, from: { id: "alice", extra: true } }), /from must/);
  const answer = answerHuman(bound, { ...accept, from: { id: "alice", name: "Ada" } });
  answer.answerDetail.at = 41_000;
  const settled = { ...bound, ...answer };
  assert.deepEqual(answer.answerDetail.by, { via: "api", from: { id: "alice", name: "Ada" } });
  assert.deepEqual(JSON.parse(humanInputResult(settled).output[0].text), { answers: { "Where?": "EU" }, answeredBy: "Ada", waited: "40s" });
  assert.equal(sameHumanAnswer(settled, answerHuman(bound, { ...accept, actor: "boss" }, "agent", ["boss"])), true, "retry identity does not rewrite the original answer");
  assert.equal(sameHumanAnswer(settled, answerHuman(bound, { action: "decline", actor: "alice" })), false);
  assert.equal(humanInputResult(cancelledHumanInput(bound)).output[0].text, "Cancelled by the application before anyone answered.");
  assert.equal(humanInputResult(cancelledHumanInput(bound)).isError, true);
});

test("legacy ask_human keeps its unstructured reply", () => {
  const answer = answerHuman({ question: "Continue?" }, { answer: "yes" });
  assert.equal(humanInputResult({ question: "Continue?", ...answer }).output[0].text, "yes");
});

test("batch answers reuse source validation", () => {
  assert.deepEqual(answerList({ answers: [{ id: "input-a", ...accept }] }), [{ id: "input-a", body: accept }]);
  for (const body of [{}, { answers: [null] }, { answers: [{ id: {} }] }]) assert.throws(() => answerList(body), /Send/);
});

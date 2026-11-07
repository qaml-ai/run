import assert from "node:assert/strict";
import test from "node:test";
import { answerHuman, bindHumanInput, cancelledHumanInput, humanInputResult, humanInputView, sameHumanAnswer, systemHumanAnswer } from "../src/human.ts";
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
  for (const invalid of [{ expiresInSeconds: 59 }, { onExpire: "resume" }, { approvers: [""] }, { unknown: true }])
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
  assert.equal(humanInputResult(cancelledHumanInput(bound)).control?.terminate, true);
  const expired = { ...bound, ...systemHumanAnswer("expired") };
  assert.equal(humanInputResult(expired).control?.terminate, false);
  const auto = JSON.parse(humanInputResult(expired).output[0].text);
  assert.deepEqual([auto.answers, auto.timedOut, auto.answeredBy], [{}, true, "the runtime"]);
  assert.match(auto.message, /^The user did not respond in a timely manner\. Continue\. \(An automatic answer from the runtime/);
  assert.equal(humanInputResult({ ...expired, resumeOnExpire: false } as typeof expired).control?.terminate, false, "an input bound before onExpire was removed resumes too");
  assert.match(humanInputResult({ ...bound, ...systemHumanAnswer("superseded") }).output[0].text, /sent a new message instead/);
});

test("legacy ask_human keeps its unstructured reply", () => {
  const answer = answerHuman({ question: "Continue?" }, { answer: "yes" });
  assert.equal(humanInputResult({ question: "Continue?", ...answer }).output[0].text, "yes");
});

test("batch answers reuse source validation", () => {
  assert.deepEqual(answerList({ answers: [{ id: "input-a", ...accept }] }), [{ id: "input-a", body: accept }]);
  for (const body of [{}, { answers: [null] }, { answers: [{ id: {} }] }]) assert.throws(() => answerList(body), /Send/);
});

test("ask_user: a header longer than its 12 characters is clipped, not a refused question", () => {
  const [question] = questionsInput([{ question: "How should halves round?", header: "Rounding mode", options: [{ label: "Up" }, { label: "Even" }] }]);
  assert.equal(question.header, "Rounding mod");
  // A missing or blank header is the question's first words (DeepSeek V4.1 Flash left it out).
  assert.equal(questionsInput([{ question: "Q?", header: " ", options: [{ label: "a" }, { label: "b" }] }])[0].header, "Q?");
  assert.equal(questionsInput([{ question: "Should I invent the missing test file?", options: [{ label: "a" }, { label: "b" }] }])[0].header, "Should I");
});

test("ask_user: a question without options is answered in the person's own words; one option is still refused", () => {
  const [open] = questionsInput([{ question: "test/parser.test.js does not exist: what did you mean?", header: "Parser test" }]);
  assert.deepEqual([open.options, open.allowOther, open.multiSelect], [[], true, false]);
  assert.deepEqual(questionsInput([{ question: "What next?", header: "Next", options: [] }])[0].allowOther, true);
  assert.throws(() => questionsInput([{ question: "Q?", header: "H", options: [{ label: "only" }] }]), /2 to 4 options, each with a label, or none/);
});

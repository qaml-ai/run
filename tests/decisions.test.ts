import { test } from "node:test";
import assert from "node:assert/strict";
import { checkedAnswers, Decider, DecisionFailed, decisionRequest, type DecisionItem, type DecisionProvider, type ProviderDecision } from "../src/decisions.ts";
import { openrouterDecisions } from "../src/decision-providers.ts";
import { Outbound } from "../src/outbound.ts";
import { HttpError } from "../src/http.ts";
import { listen } from "./runtime-server.ts";

const QUESTIONS = {
  is_support: { type: "noul", instructions: "The message asks for account or technical help.", criteria: { true: "asks for help", false: "anything else" } },
  topic: { type: "choice", instructions: "Main topic of the message.", criteria: { billing: "payments, invoices", account: "login, password, access", bug: "something broken", other: "anything else" } },
  toxicity: { type: "score", instructions: "How abusive or hateful the message is.", criteria: ["not at all", "mildly rude", "insulting", "hateful or threatening"] },
};
const STATE = "hey can someone help me reset my password? i keep getting locked out";
/** What OpenRouter's decisions API answered Miguel's live call (2026-10-28) with these questions. */
const LIVE = {
  model: "typesafe/jev-1.14-20261014",
  answers: {
    is_support: { type: "noul", noul: 0.99 },
    topic: { type: "choice", choice: "account", probabilities: { billing: 0, account: 1, bug: 0, other: 0 }, confidence: 1 },
    toxicity: { type: "score", score: 0, legend: { 0: "not at all", 1: "mildly rude", 2: "insulting", 3: "hateful or threatening" }, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 }, confidence: 1 },
  },
  usage: { input_tokens: 444, output_tokens: 77, cost: 0.000018648 },
  id: "gen-dec-1793199963-4av9MgJ4FBe8X37C9nje", provider: "TypeSafe",
};
const CHECKED = {
  is_support: { type: "noul", noul: 0.99 },
  topic: { type: "choice", choice: "account", confidence: 1, probabilities: { billing: 0, account: 1, bug: 0, other: 0 } },
  toxicity: { type: "score", score: 0, confidence: 1, probabilities: [1, 0, 0, 0] },
};

test("decision requests are checked before anything is sent: one state or a batch, typed questions within the limits, a priced model", () => {
  const one = decisionRequest({ state: STATE, questions: QUESTIONS });
  assert.equal(one.batch, false);
  assert.equal(one.model, "typesafe/jev-1.14");
  assert.equal(one.items.length, 1);
  assert.equal(decisionRequest({ items: [{ state: { id: 1, text: "x" }, questions: QUESTIONS }, { state: ["a"], questions: QUESTIONS }] }).items.length, 2);
  const refused = (value: Record<string, unknown>, pattern: RegExp, status = 400) => assert.throws(() => decisionRequest(value), (error: any) => error instanceof HttpError && error.status === status && pattern.test(error.message));
  refused({ state: STATE }, /one state \(state and questions\)|questions is/);
  refused({ state: STATE, questions: QUESTIONS, items: [] }, /one of them/);
  refused({ items: [] }, /items is 1 to 100/);
  refused({ items: Array.from({ length: 101 }, () => ({ state: STATE, questions: QUESTIONS })) }, /items is 1 to 100/);
  refused({ state: "", questions: QUESTIONS }, /state is empty/);
  refused({ state: 42, questions: QUESTIONS }, /string, an object or an array/);
  refused({ state: "x".repeat(64_001), questions: QUESTIONS }, /at most 64000/, 413);
  refused({ state: STATE, questions: { "bad id": QUESTIONS.is_support } }, /Question ids/);
  refused({ state: STATE, questions: { q: { type: "maybe", instructions: "x" } } }, /type is noul, choice or score/);
  refused({ state: STATE, questions: { q: { type: "choice", instructions: "x", criteria: { only: "one" } } } }, /2 to 255 options/);
  refused({ state: STATE, questions: { q: { type: "choice", instructions: "x", options: ["a", "b"] } } }, /unknown fields: options/);
  refused({ state: STATE, questions: { q: { type: "score", instructions: "x", criteria: ["low"] } } }, /2 to 10 levels/);
  refused({ state: STATE, questions: { q: { type: "noul", instructions: "" } } }, /instructions is a non-empty string/);
  refused({ state: STATE, questions: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`q${index}`, QUESTIONS.is_support])) }, /at most 32/);
  refused({ state: STATE, questions: QUESTIONS, model: "~typesafe/jev-latest" }, /model is one of typesafe\/jev-1\.14, typesafe\/jev-1\.13/);
  refused({ state: STATE, questions: QUESTIONS, maxUsd: 0 }, /maxUsd/);
  refused({ state: STATE, questions: QUESTIONS, extra: 1 }, /Unknown fields: extra/);
});

test("answers are read as the live API gives them: a choice's probabilities by option, a score's by level, every question answered", () => {
  const { questions } = decisionRequest({ state: STATE, questions: QUESTIONS }).items[0]!;
  assert.deepEqual(checkedAnswers(questions, LIVE.answers), CHECKED);
  // A score's levels as a list, and probabilities clamped; an option the provider left out is 0.
  assert.deepEqual(checkedAnswers(questions, { ...LIVE.answers, topic: { choice: "bug", probabilities: { bug: 1.2 } }, toxicity: { score: 1.5, probabilities: [0, 0.5, 0.5, 0] } }).topic, { type: "choice", choice: "bug", confidence: 1, probabilities: { billing: 0, account: 0, bug: 1, other: 0 } });
  assert.deepEqual(checkedAnswers(questions, { ...LIVE.answers, toxicity: { score: 1.5, probabilities: [0, 0.5, 0.5, 0] } }).toxicity, { type: "score", score: 1.5, confidence: 0.5, probabilities: [0, 0.5, 0.5, 0] });
  const malformed = (answers: unknown, pattern: RegExp) => assert.throws(() => checkedAnswers(questions, answers), (error: any) => error instanceof DecisionFailed && error.status === 502 && pattern.test(error.message));
  malformed({ ...LIVE.answers, is_support: undefined }, /is_support is malformed \(missing\)/);
  malformed({ ...LIVE.answers, topic: { type: "choice", choice: "refunds" } }, /no option chosen of those given/);
  malformed({ ...LIVE.answers, is_support: { type: "score", score: 1 } }, /type score, asked noul/);
  malformed(null, /without answers/);
});

/** A provider that answers like the live call after `ms`, failing as `fail` says, and counts calls at once. */
function fakeProvider(options: { ms?: number; fail?: (item: DecisionItem, attempt: number) => Error | undefined } = {}) {
  const calls: { state: unknown; model: string; key: string }[] = [];
  let active = 0, most = 0;
  const attempts = new Map<unknown, number>();
  const provider: DecisionProvider = {
    id: "openrouter",
    async decide(item, model, credentials) {
      calls.push({ state: item.state, model, key: credentials.apiKey });
      const attempt = (attempts.get(item.state) ?? 0) + 1;
      attempts.set(item.state, attempt);
      active++; most = Math.max(most, active);
      try {
        await new Promise(resolve => setTimeout(resolve, options.ms ?? 5));
        const failure = options.fail?.(item, attempt);
        if (failure) throw failure;
        return { answers: LIVE.answers, model: LIVE.model, inputTokens: 444, outputTokens: 77, costUsd: LIVE.usage.cost } satisfies ProviderDecision;
      } finally { active--; }
    },
  };
  return { provider, calls, get most() { return most; } };
}

const key = async () => ({ apiKey: "fixture-key", platform: true });
const noWait = async () => {};

test("a batch fans out within the tenant's concurrency, and its usage is one record of the questions answered at what the provider charged", async () => {
  const fake = fakeProvider({ ms: 20 });
  const decider = new Decider({ provider: fake.provider, key, limits: { tenantConcurrent: 4 } });
  const request = decisionRequest({ items: Array.from({ length: 12 }, (_, index) => ({ state: `${STATE} #${index}`, questions: QUESTIONS })) });
  const decided = await decider.decide({ tenant: "t1" }, request, AbortSignal.timeout(10_000));
  assert.equal(fake.calls.length, 12);
  assert.equal(fake.most, 4, "never more than the tenant's calls at once");
  assert.equal(decided.model, "typesafe/jev-1.14-20261014");
  assert.ok(decided.results.every(result => "answers" in result && JSON.stringify(result.answers) === JSON.stringify(CHECKED)));
  assert.equal(decided.inputTokens, 444 * 12);
  assert.ok(Math.abs(decided.costUsd - 12 * LIVE.usage.cost) < 1e-12);
  assert.deepEqual({ ...decided.usage, timestamp: 0 }, { provider: "openrouter", model: "typesafe/jev-1.14", kind: "decision", platform: true, decisions: 36, timestamp: 0, usage: { input: 444 * 12, output: 77 * 12, cost: { total: decided.costUsd } } });
  // The estimate is above what the live call counted, so a hold covers it.
  assert.ok(decider.estimate(request.items.slice(0, 1), request.model) >= LIVE.usage.cost, `estimate ${decider.estimate(request.items.slice(0, 1), request.model)}`);
});

test("a call the provider fails for now is retried with backoff, honouring Retry-After; one it refuses fails alone, unbilled", async () => {
  const waits: number[] = [];
  const fake = fakeProvider({
    fail: (item, attempt) => item.state === "busy" && attempt < 3 ? new DecisionFailed(502, "OpenRouter failed the decision (HTTP 429)", { transient: true, retryAfterMs: 1_500 })
      : item.state === "down" ? new DecisionFailed(502, "OpenRouter failed the decision (HTTP 503)", { transient: true })
      : item.state === "refused" ? new DecisionFailed(400, "OpenRouter refused the decision request (HTTP 422: questions.q: bad)", { code: "DECISION_REFUSED" }) : undefined,
  });
  const decider = new Decider({ provider: fake.provider, key, sleep: async ms => { waits.push(ms); } });
  const decided = await decider.decide({ tenant: "t1" }, decisionRequest({ items: ["busy", "down", "refused", "fine"].map(state => ({ state, questions: QUESTIONS })) }), AbortSignal.timeout(10_000));
  assert.deepEqual(fake.calls.map(call => call.state).sort(), ["busy", "busy", "busy", "down", "down", "down", "fine", "refused"]);
  assert.deepEqual(decided.results.map(result => "error" in result ? [result.error.status, result.error.code] : "answered"), ["answered", [502, "DECISION_FAILED"], [400, "DECISION_REFUSED"], "answered"]);
  assert.ok(waits.filter(ms => ms === 1_500).length === 2, `Retry-After honoured: ${waits}`);
  assert.equal(decided.usage!.decisions, 6, "only the answered items are billed");
});

test("the estimate is checked against the run's budget and maxUsd before anything is sent, and a missing key says what to add", async () => {
  const fake = fakeProvider();
  const decider = new Decider({ provider: fake.provider, key, sleep: noWait });
  const request = decisionRequest({ items: Array.from({ length: 100 }, (_, index) => ({ state: `${STATE} ${index}`, questions: QUESTIONS })) });
  await assert.rejects(decider.decide({ tenant: "t1", budget: 0.0001 }, request, AbortSignal.timeout(1_000)), (error: any) => error.status === 402 && error.code === "SPEND_LIMIT" && /left of this run's spend limit/.test(error.message));
  await assert.rejects(decider.decide({ tenant: "t1" }, { ...request, maxUsd: 0.0001 }, AbortSignal.timeout(1_000)), (error: any) => error.status === 402 && /more than maxUsd/.test(error.message));
  assert.equal(fake.calls.length, 0);
  const keyless = new Decider({ provider: fake.provider, key: async () => undefined });
  await assert.rejects(keyless.decide({ tenant: "t1" }, decisionRequest({ state: STATE, questions: QUESTIONS }), AbortSignal.timeout(1_000)), (error: any) => error.code === "DECISIONS_UNAVAILABLE" && /PUT \/v1\/providers\/openrouter\/key/.test(error.message));
});

test("the OpenRouter adapter sends TypeSafe's body to /decisions with the key, reads the live answer, and says clearly when the alpha API moved or refused", async t => {
  const seen: { path: string; auth: string; body: any }[] = [];
  let reply: { status: number; body: unknown; headers?: Record<string, string> } = { status: 200, body: LIVE };
  const base = await listen(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url!, auth: String(req.headers.authorization), body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers }).end(JSON.stringify(reply.body));
  });
  const provider = openrouterDecisions({ outbound: new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] }), baseUrl: `${base}/api/alpha` });
  const item = decisionRequest({ state: STATE, questions: QUESTIONS }).items[0]!;
  const credentials = { apiKey: "or-key" };
  const answered = await provider.decide(item, "typesafe/jev-1.14", credentials, AbortSignal.timeout(5_000));
  assert.deepEqual(seen[0], { path: "/api/alpha/decisions", auth: "Bearer or-key", body: { model: "typesafe/jev-1.14", state: STATE, questions: QUESTIONS } });
  assert.deepEqual(answered, { answers: LIVE.answers, model: LIVE.model, inputTokens: 444, outputTokens: 77, costUsd: LIVE.usage.cost });

  const fails = async (status: number, body: unknown, check: (error: DecisionFailed) => boolean, headers?: Record<string, string>) => {
    reply = { status, body, ...(headers ? { headers } : {}) };
    await assert.rejects(provider.decide(item, "typesafe/jev-1.14", credentials, AbortSignal.timeout(5_000)), (error: any) => error instanceof DecisionFailed && check(error));
  };
  await fails(404, { error: { message: "Not Found", code: 404 } }, error => error.status === 502 && error.code === "DECISIONS_UNAVAILABLE" && !error.transient && /alpha/.test(error.message));
  await fails(410, {}, error => error.code === "DECISIONS_UNAVAILABLE");
  // A validation error names where, never the input it quotes.
  await fails(422, { detail: [{ loc: ["body", "questions", "q", "criteria"], msg: "Field required", type: "missing", input: STATE }] }, error => error.status === 400 && error.code === "DECISION_REFUSED" && /body\.questions\.q\.criteria: Field required/.test(error.message) && !error.message.includes("password"));
  await fails(429, { error: { message: "Rate limited" } }, error => error.transient && error.retryAfterMs === 2_000, { "Retry-After": "2" });
  await fails(529, {}, error => error.transient && error.status === 502);
  await fails(401, {}, error => !error.transient && /rejected the API key/.test(error.message));
  // An answer of another shape is a clear 502, not a crash.
  await fails(200, { choices: [{ message: { content: "account" } }] }, error => error.status === 502 && /may have changed shape/.test(error.message));
});

test("a tenant's waiting decisions are bounded on a node: past the queue a request is refused (429) at once, and the gate is dropped when idle", async () => {
  const fake = fakeProvider({ ms: 30 });
  const decider = new Decider({ provider: fake.provider, key, limits: { tenantConcurrent: 1, queued: 2 } });
  const items = (count: number, tag: string) => decisionRequest({ items: Array.from({ length: count }, (_, index) => ({ state: `${tag} ${index}`, questions: QUESTIONS })) });
  const first = decider.decide({ tenant: "t1" }, items(3, "first"), AbortSignal.timeout(10_000));
  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(decider.decide({ tenant: "t1" }, items(2, "second"), AbortSignal.timeout(10_000)), (error: any) => error.status === 429 && error.code === "RATE_LIMITED");
  // Another tenant is not held up.
  assert.equal((await decider.decide({ tenant: "t2" }, items(1, "other"), AbortSignal.timeout(10_000))).results.length, 1);
  assert.equal((await first).results.filter(result => "answers" in result).length, 3);
  assert.equal((decider as any).tenants.size, 0);
});

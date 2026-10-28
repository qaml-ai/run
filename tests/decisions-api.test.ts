import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { free, lastUser, listen, runtime, toolCall, toolResults, until, type T } from "./runtime-server.ts";

// POST /v1/decisions and the decide builtin, on a local stand-in for OpenRouter's decisions API.

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const PAYG = "payg-operator-token-at-least-24-chars";
const OWN = "own-operator-token-at-least-24-chars";
const OPS = "ops-operator-token-at-least-24-chars";
const tenantsFile = {
  tenants: {
    payg: { tokenSha256: sha(PAYG), apiKeys: {}, billing: "prepaid" },
    own: { tokenSha256: sha(OWN), apiKeys: { openrouter: "own-openrouter-key" }, platformKeys: false },
    ops: { tokenSha256: sha(OPS), apiKeys: { openrouter: "fixture-model-key" } },
  },
  platformKeys: { openrouter: "fixture-platform-model-key" },
};

const QUESTIONS = {
  is_support: { type: "noul", instructions: "The message asks for help." },
  topic: { type: "choice", instructions: "Main topic.", criteria: { billing: "", account: "login, password", other: "" } },
  toxicity: { type: "score", instructions: "How abusive it is.", criteria: ["not at all", "rude", "hateful"] },
};
const ANSWERS = {
  is_support: { type: "noul", noul: 0.99 },
  topic: { type: "choice", choice: "account", confidence: 0.9, probabilities: { billing: 0.05, account: 0.9, other: 0.05 } },
  toxicity: { type: "score", score: 0.1, confidence: 0.9, probabilities: [0.9, 0.1, 0] },
};

/** OpenRouter's decisions API: answers every question as ANSWERS does, at `cost` a call; a state "refused" is a 422. */
async function fakeOpenRouter(t: T, cost: number) {
  const requests: { key: string; model: string; state: unknown; questions: string[] }[] = [];
  const base = await listen(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url !== "/decisions") return res.writeHead(404).end();
    requests.push({ key: String(req.headers.authorization), model: body.model, state: body.state, questions: Object.keys(body.questions) });
    if (body.state === "refused") return res.writeHead(422, { "Content-Type": "application/json" }).end(JSON.stringify({ detail: [{ loc: ["body", "state"], msg: "bad state", input: body.state }] }));
    const answers = Object.fromEntries(Object.keys(body.questions).map(id => [id, (ANSWERS as any)[id] ?? { type: "noul", noul: 0.5 }]));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ model: "typesafe/jev-1.14-20261014", answers, usage: { input_tokens: 400, output_tokens: 70, cost }, id: "gen-dec-1", provider: "TypeSafe" }));
  });
  return { base, requests };
}

async function start(t: T, respond: (body: any, index: number) => object = () => ({ role: "assistant", content: "ok" }), cost = 0.01) {
  const openrouter = await fakeOpenRouter(t, cost);
  const r = await runtime(t, free(respond), {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_DECISIONS_URL: openrouter.base,
    AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0", AGENT_OPENROUTER_CREDIT_MULTIPLIER: "1",
  }, tenantsFile);
  return { r, openrouter };
}

test("POST /v1/decisions answers one state or a batch on the platform's OpenRouter key, bills what OpenRouter charged, and logs no state", async t => {
  const { r, openrouter } = await start(t);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  assert.equal((await r.call("/v1/webhooks", { body: { url: "https://hooks.example.test/usage", events: ["usage.recorded"] }, token: PAYG })).status, 201);

  const one = await r.call("/v1/decisions", { body: { state: "please reset my secret-password-123", questions: QUESTIONS, subject: "user_1", context: { org: "o1" }, actor: "user_2" }, token: PAYG });
  assert.equal(one.status, 200, one.text);
  assert.deepEqual({ ...one.json, ms: 0 }, { model: "typesafe/jev-1.14-20261014", answers: ANSWERS, usage: { inputTokens: 400, outputTokens: 70 }, costUsd: 0.01, ms: 0 });
  assert.deepEqual(openrouter.requests[0], { key: "Bearer fixture-platform-model-key", model: "typesafe/jev-1.14", state: "please reset my secret-password-123", questions: ["is_support", "topic", "toxicity"] });

  // A batch: each item answered or failed in order; the failed one is not billed.
  const batch = await r.call("/v1/decisions", { body: { items: [{ state: { id: 1 }, questions: { is_support: QUESTIONS.is_support } }, { state: "refused", questions: QUESTIONS }, { state: ["a", "b"], questions: QUESTIONS }] }, token: PAYG });
  assert.equal(batch.status, 200, batch.text);
  assert.deepEqual(batch.json.results.map((result: any) => result.error ? [result.error.status, result.error.code] : Object.keys(result.answers)), [["is_support"], [400, "DECISION_REFUSED"], ["is_support", "topic", "toxicity"]]);
  assert.equal(batch.json.costUsd, 0.02);

  // Refused before anything is sent.
  const sent = openrouter.requests.length;
  assert.equal((await r.call("/v1/decisions", { body: { state: "x", questions: { q: { type: "choice", instructions: "x", criteria: { a: "" } } } }, token: PAYG })).status, 400);
  assert.equal((await r.call("/v1/decisions", { body: { state: "x", questions: QUESTIONS, maxUsd: 1e-9 }, token: PAYG })).status, 402);
  // Until OpenRouter's decisions API is confirmed to take a data policy, deny is refused rather than sent.
  const denied = await r.call("/v1/decisions", { body: { state: "x", questions: QUESTIONS, dataCollection: "deny" }, token: PAYG });
  assert.equal(denied.status, 400, denied.text);
  assert.equal(denied.json.code, "DECISIONS_DATA_POLICY");
  assert.equal((await r.call("/v1/decisions", { body: { state: "refused", questions: QUESTIONS }, token: PAYG })).json.code, "DECISION_REFUSED", "one state's failure is the request's");
  assert.equal(openrouter.requests.length, sent + 1);

  // Three calls answered at a cent each: credit, a usage row of their own counting the questions, and an event each.
  await until(async () => (await r.call("/v1/billing", { token: PAYG })).json.balance === 970_000, "the decisions' charge");
  const usage = (await r.call("/v1/usage", { token: PAYG })).json.days;
  assert.deepEqual(usage.filter((day: any) => day.kind === "decision").map((day: any) => [day.model, day.responses, Math.round(day.platformCost * 1e6)]), [["openrouter/typesafe/jev-1.14", 7, 30_000]]);
  const ledger = (await r.call("/v1/billing/ledger", { token: PAYG })).json.entries.find((entry: any) => entry.kind === "usage");
  assert.deepEqual([ledger.metadata.decision, ledger.metadata.decisions], [30_000, 7]);
  await until(async () => (await r.db.query("select count(*)::int as n from webhook_deliveries where tenant = 'payg' and body->'data'->>'kind' = 'decision'")).rows[0].n === 2, "the events");
  const { rows } = await r.db.query("select body from webhook_deliveries where tenant = 'payg' and body->'data'->>'kind' = 'decision' order by created_at");
  const first = rows.map(row => row.body.data).find((data: any) => data.subject === "user_1");
  assert.deepEqual(first, {
    agentId: null, requestId: null, subject: "user_1", actor: "user_2", context: { org: "o1" }, keyScope: null, provider: "openrouter", model: "typesafe/jev-1.14", kind: "decision",
    input: 400, output: 70, cacheRead: 0, cacheWrite: 0, decisions: 3, cost: { usd: 0.01, source: "catalog" }, at: first.at,
  });
  assert.ok(r.logs.some(line => line.includes('"type":"decided"')));
  assert.ok(!r.logs.some(line => line.includes("secret-password-123")), "no state in the logs");
});

test("a tenant's own OpenRouter key answers its decisions, and is not charged", async t => {
  const { r, openrouter } = await start(t);
  const answered = await r.call("/v1/decisions", { body: { state: "hello", questions: { is_support: QUESTIONS.is_support } }, token: OWN });
  assert.equal(answered.status, 200, answered.text);
  assert.equal(openrouter.requests.at(-1)!.key, "Bearer own-openrouter-key");
});

/** A model that runs a batch through js_exec, then a decision directly, then says what came back. */
function decider(body: any) {
  const results = toolResults(body);
  if (/too dear/.test(lastUser(body) ?? "")) return body.messages.at(-1).role === "tool" ? { role: "assistant", content: `failed: ${results.at(-1)}` } : toolCall("decide", { state: "x", questions: QUESTIONS, maxUsd: 1e-9 }, "call_dear");
  if (results.length === 0) {
    const code = `const states = Array.from({ length: 150 }, (_, i) => "message " + i);
const questions = ${JSON.stringify({ is_support: QUESTIONS.is_support })};
let flagged = 0, failed = 0;
for (let start = 0; start < states.length; start += 100) {
  const { results } = await tools.decide({ items: states.slice(start, start + 100).map(state => ({ state, questions })) });
  for (const result of results) result.error ? failed++ : result.answers.is_support.noul > 0.9 && flagged++;
}
return { flagged, failed };`;
    return toolCall("js_exec", { code }, "call_bulk");
  }
  if (results.length === 1) return toolCall("decide", { state: "my login is broken", questions: QUESTIONS }, "call_one");
  return { role: "assistant", content: `bulk: ${results[0]} one: ${results[1]}` };
}

test("the decide builtin answers from js_exec in batches and directly, billed to the run and the agent", async t => {
  const { r, openrouter } = await start(t, decider, 0.001);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 10_000_000, reason: "test" }, token: OPS })).status, 201);
  const agent = (await r.call("/v1/agents", { body: { builtins: ["decide"], spendLimit: { usd: 5 } }, token: PAYG })).json.id;
  const record = await r.prompt(agent, "triage these", PAYG);
  assert.equal(record.outcome.result.code, undefined, JSON.stringify(record.outcome));
  assert.ok(r.model.bodies[0].tools.some((tool: any) => tool.function.name === "decide"), "decide is a direct tool too");
  assert.match(record.outcome.result.reply, /bulk: .*"flagged":150,"failed":0/s);
  assert.match(record.outcome.result.reply, /one: \{"model":"typesafe\/jev-1\.14-20261014","answers":\{"is_support"/);
  assert.equal(openrouter.requests.length, 151);
  // 151 calls at a tenth of a cent: the run's usage and the agent's spend.
  assert.ok(Math.abs(record.outcome.result.usage.decisionCostUsd - 0.151) < 1e-9, JSON.stringify(record.outcome.result.usage));
  await until(async () => (await r.call(`/v1/agents/${agent}`, { token: PAYG })).json.spendLimit?.spent >= 0.151 - 1e-9, "the agent's spend");

  // maxUsd refuses before anything is sent.
  const dear = await r.prompt(agent, "too dear", PAYG);
  assert.match(dear.outcome.result.reply, /^failed: .*more than maxUsd/);
  assert.equal(openrouter.requests.length, 151);
});

test("an agent that denies data collection is refused decide calls, and nothing is sent", async t => {
  const { r, openrouter } = await start(t, body => toolResults(body).length ? { role: "assistant", content: `result: ${toolResults(body).at(-1)}` } : toolCall("decide", { state: "private", questions: QUESTIONS }, "call_private"), 0.001);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  const agent = (await r.call("/v1/agents", { body: { builtins: ["decide"], dataCollection: "deny" }, token: PAYG })).json.id;
  const record = await r.prompt(agent, "classify", PAYG);
  assert.match(record.outcome.result.reply, /cannot honour dataCollection "deny"/);
  assert.equal(openrouter.requests.length, 0);
});

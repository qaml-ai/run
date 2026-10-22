import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { XSearch, X_SEARCH } from "../src/x-search.ts";
import { Outbound } from "../src/outbound.ts";
import { builtinWarnings } from "../src/builtins.ts";
import type { UsageRecord } from "../src/client-sessions/state.ts";
import { free, lastUser, listen, runtime, toolCall, toolResults, until, type T } from "./runtime-server.ts";

const answer = () => ({
  status: "completed", model: "grok-4.7",
  output: [{ type: "message", content: [{ type: "output_text", text: "A reported claim, not a verified fact.", annotations: [
    { type: "url_citation", url: "https://x.com/example/status/123", title: "Source post" },
    { type: "url_citation", url: "https://x.com/example/status/123", title: "Source post" },
    { type: "url_citation", url: "javascript:alert(1)" },
  ] }] }],
  usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30, cost_in_usd_ticks: 2_500_000_000,
    server_side_tool_usage_details: { x_search_calls: 2, x_posts_fetched: 40, x_users_fetched: 3 } },
});

async function fixture(t: T) {
  const calls: { key?: string; body: any }[] = [];
  let body: unknown = answer(), status = 200, raw: string | undefined;
  const endpoint = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    calls.push({ key: req.headers.authorization, body: JSON.parse(text) });
    res.writeHead(status, { "Content-Type": "application/json" }).end(raw ?? JSON.stringify(body));
  });
  return { endpoint, calls, reply(value: unknown, code = 200) { body = value; status = code; raw = undefined; }, raw(value: string) { raw = value; } };
}

function client(endpoint: string, key: string | undefined = "private-key") {
  const usage: UsageRecord[] = [];
  const outbound = new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] });
  const fetch = outbound.fetch.bind(outbound);
  // Check the production deadline, but do not leave two-minute timers from cancelled error bodies in tests.
  outbound.fetch = (input, init = {}) => {
    assert.equal(init.timeoutMs, X_SEARCH.timeoutMs);
    return fetch(input, { ...init, timeoutMs: 5_000 });
  };
  const search = new XSearch({ endpoint, outbound,
    key: async () => key ? { key, platform: true } : undefined, onSearch: (_tenant, _agent, value) => usage.push(value) });
  const run = (args: Record<string, unknown> = { query: "new chip announcements" }, signal = new AbortController().signal) => search.search({ tenant: "acme", agent: "a1" }, args, signal);
  return { run, usage };
}

test("X search sends bounded native search with filters, returns cited synthesis and accounts exact cost once", async t => {
  const f = await fixture(t), c = client(f.endpoint);
  const result = await c.run({ query: "  new chips  ", allowedHandles: ["@example", "example"], fromDate: "2026-10-01", toDate: "2026-10-22" });
  assert.equal(f.calls[0].key, "Bearer private-key");
  assert.deepEqual(f.calls[0].body.tools, [{ type: "x_search", allowed_x_handles: ["example"], from_date: "2026-10-01", to_date: "2026-10-22" }]);
  assert.equal(f.calls[0].body.store, false);
  assert.equal(f.calls[0].body.max_turns, X_SEARCH.maxTurns);
  assert.equal(f.calls[0].body.max_output_tokens, X_SEARCH.maxOutputTokens);
  assert.equal(result.query, "new chips");
  assert.deepEqual(result.citations, [{ url: "https://x.com/example/status/123", title: "Source post" }]);
  assert.deepEqual(result.usage, { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, searchCalls: 2, postsFetched: 40, profilesFetched: 3, costUsd: 0.25 });
  assert.deepEqual(c.usage, [{ provider: "xai", model: "x_search", platform: true, searches: 1,
    usage: { input: 80, cacheRead: 20, output: 30, cost: { total: 0.25 } } }]);
  await c.run({ query: "chips", excludedHandles: ["example"] });
  assert.deepEqual(f.calls[1].body.tools, [{ type: "x_search", excluded_x_handles: ["example"] }]);
});

test("invalid X filters and missing keys fail before contacting xAI", async t => {
  const f = await fixture(t), c = client(f.endpoint);
  for (const args of [
    { query: " " }, { query: "x".repeat(4001) }, { query: "q", allowedHandles: [] },
    { query: "q", allowedHandles: ["user"], excludedHandles: ["other"] },
    { query: "q", allowedHandles: ["bad/handle"] }, { query: "q", allowedHandles: Array(21).fill("user") },
    { query: "q", fromDate: "2026-02-30" }, { query: "q", toDate: "tomorrow" },
    { query: "q", fromDate: "2026-10-22", toDate: "2026-10-22" },
  ]) await assert.rejects(c.run(args), /x_search/);
  await assert.rejects(client(f.endpoint, "").run(), /add an xAI key/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await builtinWarnings({ builtins: ["x_search"] }, [], async () => () => false), ["X search isn't available for this account: add an xAI key under Models & keys (PUT /v1/providers/xai/key)"]);
  assert.deepEqual(await builtinWarnings({ builtins: ["x_search"] }, [], async () => id => id === "xai"), []);
});

test("X failures are redacted, malformed cost is rejected, and already billed incomplete answers retain their cost", async t => {
  const f = await fixture(t), c = client(f.endpoint);
  for (const status of [401, 402, 429, 500]) {
    f.reply({ error: "private-key" }, status);
    await assert.rejects(c.run(), new RegExp(`^Error: X search failed \\(xAI HTTP ${status}\\)$`));
  }
  f.reply(answer()); f.raw("not JSON private-key");
  await assert.rejects(c.run(), /returned invalid JSON/);
  for (const cost of [undefined, -1, NaN, "secret", Number.MAX_SAFE_INTEGER + 1]) {
    const value = answer(); value.usage.cost_in_usd_ticks = cost as any; f.reply(value);
    await assert.rejects(c.run(), /no valid provider cost/);
  }
  assert.equal(c.usage.length, 0);
  const partial = answer(); partial.status = "incomplete"; f.reply(partial);
  assert.equal((await c.run()).incomplete, true);
  const failed = answer(); failed.status = "failed"; failed.output = []; f.reply(failed);
  await assert.rejects(c.run(), /did not complete/);
  const empty = answer(); empty.output = []; f.reply(empty);
  await assert.rejects(c.run(), /no answer/);
  assert.equal(c.usage.length, 3, "charge usable, failed and empty provider responses with billed usage");
  assert.ok(c.usage.every(u => u.usage.cost.total === 0.25));
});

test("X search obeys cancellation and never sends credentials through redirects", async t => {
  const f = await fixture(t), c = client(f.endpoint);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(c.run(undefined, controller.signal));
  assert.equal(f.calls.length, 0);
  let reached = false;
  const target = await listen(t, (_req, res) => { reached = true; res.end(); });
  const redirect = await listen(t, (_req, res) => res.writeHead(302, { Location: target }).end());
  await assert.rejects(client(redirect).run(), /Redirects are not followed/);
  assert.equal(reached, false);
});

test("X search works in agents and stateless runs, uses tenant keys first and bills only platform requests", async t => {
  const f = await fixture(t);
  const own = "own-operator-token-at-least-24-chars", payg = "payg-operator-token-at-least-24-chars", ops = "ops-operator-token-at-least-24-chars";
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const r = await runtime(t, free(body => toolResults(body).length ? { role: "assistant", content: "Research complete." }
    : lastUser(body) === "Code research" ? toolCall("js_exec", { timeoutMs: 150000, code: 'return await tools.x_search({ query: "AI chips" });' })
    : toolCall("x_search", { query: "AI chips", allowedHandles: ["example"] })), {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_XAI_RESPONSES_URL: f.endpoint,
    AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0",
  }, { tenants: {
    own: { tokenSha256: sha(own), apiKeys: { openrouter: "model-key", xai: "own-xai-key" }, platformKeys: false },
    payg: { tokenSha256: sha(payg), apiKeys: {}, billing: "prepaid" },
    ops: { tokenSha256: sha(ops), apiKeys: { openrouter: "model-key" } },
  }, platformKeys: { openrouter: "model-key", xai: "platform-xai-key" } });
  const def = await r.call("/v1/definitions", { token: own, body: { name: "Research", builtins: ["x_search"] } });
  assert.equal(def.status, 201);
  assert.equal(def.json.warnings, undefined);
  const workspace = (await r.call("/v1/workspaces", { token: own, body: { name: "Research" } })).json.id;
  const made = await r.call("/v1/agents", { token: own, body: { definition: def.json.id, workspaceId: workspace, codeMode: false } });
  await r.prompt(made.json.id, "Research it", own);
  assert.equal(f.calls.at(-1)?.key, "Bearer own-xai-key");
  const ownUsage = (await r.call("/v1/usage", { token: own })).json.days.find((u: any) => u.model === "xai/x_search");
  assert.deepEqual([ownUsage.cost, ownUsage.platformCost, ownUsage.input, ownUsage.cacheRead], [0.25, 0, 80, 20]);
  assert.equal((await r.call(`/v1/usage?workspaceId=${workspace}`, { token: own })).json.totals.cost, 0.25);
  assert.equal((await r.call("/v1/billing/adjustments", { token: ops, body: { tenant: "payg", amount: 1_000_000, reason: "test" } })).status, 201);
  const paid = await r.call("/v1/agents", { token: payg, body: { builtins: ["x_search"], codeMode: false } });
  await r.prompt(paid.json.id, "Research it", payg);
  assert.equal(f.calls.at(-1)?.key, "Bearer platform-xai-key");
  await until(async () => (await r.call("/v1/billing", { token: payg })).json.balance === 750_000, "exact X search cost charged once");
  const entry = (await r.call("/v1/billing/ledger", { token: payg })).json.entries.find((row: any) => row.kind === "usage");
  assert.deepEqual([entry.amount, entry.metadata.web, entry.metadata.searches], [-250_000, 250_000, 1]);
  const calls = f.calls.length;
  const run = await r.call("/v1/runs?wait=30", { token: own, body: { input: "Research again", builtins: ["x_search"], codeMode: false } });
  assert.equal(run.status, 200);
  assert.equal(f.calls.length, calls + 1);
  const codeAgent = await r.call("/v1/agents", { token: own, body: { builtins: ["x_search"] } });
  await r.prompt(codeAgent.json.id, "Code research", own);
  assert.equal(f.calls.length, calls + 2, "js_exec can call the built-in X search without an external tool server");
  assert.equal(f.calls.at(-1)?.key, "Bearer own-xai-key");
  // A zero balance stops the next platform-backed request before it reaches xAI.
  await r.call("/v1/billing/adjustments", { token: ops, body: { tenant: "payg", amount: -750_000, reason: "test" } });
  const before = f.calls.length;
  await assert.rejects(r.prompt(paid.json.id, "Research once more", payg), /out of credit/);
  assert.equal(f.calls.length, before);
});

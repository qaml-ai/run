import {portedTest} from "../ported.ts";
const test = portedTest("search", "tests/x-search.test.ts");
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {free,lastUser,listen,runtime,toolCall,toolResults,until,type T} from "../support.ts";

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

test("X search works in agents and stateless runs, uses tenant keys first and bills only platform requests", async t => {
  const f = await fixture(t);
  const own = "own-operator-token-at-least-24-chars", payg = "payg-operator-token-at-least-24-chars", ops = "ops-operator-token-at-least-24-chars";
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const r = await runtime(t, free(body => toolResults(body).length ? { role: "assistant", content: "Research complete." }
    : lastUser(body) === "Code research" ? toolCall("codemode", { code: '// @options: {"timeout_ms": 150000}\nreturn await tools.x_search({ query: "AI chips" });' })
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
  assert.equal(f.calls.length, calls + 2, "codemode can call the built-in X search without an external tool server");
  assert.equal(f.calls.at(-1)?.key, "Bearer own-xai-key");
  // A zero balance stops the next platform-backed request before it reaches xAI.
  await r.call("/v1/billing/adjustments", { token: ops, body: { tenant: "payg", amount: -750_000, reason: "test" } });
  const before = f.calls.length;
  await assert.rejects(r.prompt(paid.json.id, "Research once more", payg), /out of credit/);
  assert.equal(f.calls.length, before);
});

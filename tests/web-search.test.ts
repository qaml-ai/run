import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { braveSearch } from "../src/web-search.ts";
import { listen, runtime, toolCall, toolResults, until, type T } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const PAYG = "payg-operator-token-at-least-24-chars";
const OWN = "own-operator-token-at-least-24-chars";
const OPS = "ops-operator-token-at-least-24-chars";
const tenantsFile = {
  tenants: {
    payg: { tokenSha256: sha(PAYG), apiKeys: {}, billing: "prepaid" },
    own: { tokenSha256: sha(OWN), apiKeys: { "*": "fixture-model-key" } },
    ops: { tokenSha256: sha(OPS), apiKeys: { "*": "fixture-model-key" } },
  },
  platformKeys: { "*": "fixture-platform-model-key", brave: "platform-brave-key" },
};
const PAGE = "<html><head><title>Agent runtime docs</title></head><body><h1>Agent runtime</h1><p>Hosts agents.</p></body></html>";

/** A Brave-shaped search API (and a page to fetch), recording each search. */
async function fakeBrave(t: T) {
  const searches: { token?: string; q: string | null; count: string | null; freshness: string | null }[] = [];
  let base = "";
  base = await listen(t, (req, res) => {
    const url = new URL(req.url!, base);
    if (url.pathname === "/page") return res.writeHead(200, { "Content-Type": "text/html" }).end(PAGE);
    if (url.pathname !== "/res/v1/web/search") return res.writeHead(404).end();
    const token = req.headers["x-subscription-token"] as string | undefined;
    searches.push({ token, q: url.searchParams.get("q"), count: url.searchParams.get("count"), freshness: url.searchParams.get("freshness") });
    if (token === "bad-brave-key") return res.writeHead(401, { "Content-Type": "application/json" }).end("{}");
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ web: { results: [
      { title: "Agent <strong>runtime</strong> docs", url: `${base}/page`, description: "How the <strong>agent runtime</strong> hosts agents &amp; tools.", page_age: "2026-09-01T10:00:00" },
      { title: "An FTP mirror", url: "ftp://example.com/runtime", description: "Not a web page" },
      { title: "Release notes", url: "https://example.com/releases", description: "What changed", age: "2 days ago" },
      { title: "Third", url: "https://example.com/third", description: "More" },
    ] } }));
  });
  return { url: `${base}/res/v1/web/search`, searches };
}

/** The model searches, reads the first result with web_fetch, then answers. */
const researcher = (body: any) => {
  const results = toolResults(body);
  const since = body.messages.length - 1 - [...body.messages].reverse().findIndex((message: any) => message.role === "user");
  const step = body.messages.slice(since).filter((message: any) => message.role === "tool").length;
  if (step === 0) return toolCall("web_search", { query: "agent runtime", count: 2, freshness: "week" }, `search_${body.messages.length}`);
  let found: any;
  try { found = JSON.parse(results.at(-1)); } catch { /* an error */ }
  if (step === 1 && found?.results) return toolCall("web_fetch", { url: found.results[0].url }, `fetch_${body.messages.length}`);
  return { role: "assistant", content: "done" };
};

test("Brave's answer becomes plain results", () => {
  const brave = braveSearch("https://search.example/api");
  const request = brave.request({ query: "a b", count: 3, freshness: "month" }, "k");
  assert.equal(request.url, "https://search.example/api?q=a+b&count=3&text_decorations=false&freshness=pm");
  assert.deepEqual(request.secrets, { "X-Subscription-Token": "k" });
  assert.deepEqual(brave.results({ web: { results: [{ title: "<b>A</b> &amp; B", url: "https://a.example", description: "x\n <em>y</em>", page_age: "2025-01-02T03:04:05" }] } }),
    [{ title: "A & B", url: "https://a.example", snippet: "x y", date: "2025-01-02" }]);
  assert.deepEqual(brave.results({}), []);
});

test("web_search uses the tenant's own search key, else the platform's billed to credit, and pairs with web_fetch", async t => {
  const brave = await fakeBrave(t);
  const r = await runtime(t, researcher, {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_BRAVE_SEARCH_URL: brave.url,
    AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0", AGENT_PRICE_WEB_SEARCH_USD: "0.25",
  }, tenantsFile);
  const make = async (token: string, builtins: string[]) => {
    const definition = (await r.call("/v1/definitions", { body: { name: "Researcher", builtins }, token })).json;
    return (await r.call("/v1/agents", { body: { definition: definition.id }, token })).json.id;
  };
  const lastResult = () => toolResults(r.model.bodies.at(-1)).at(-1);

  // A tenant without a search key: a model key under `*` never stands in for one.
  const own = await make(OWN, ["web_search", "web_fetch"]);
  const tools = r.model.bodies.length;
  await r.prompt(own, "look it up", OWN);
  assert.match(toolResults(r.model.bodies[tools + 1]).at(-1), /Web search is not set up for this tenant: it needs a brave API key \(PUT \/v1\/providers\/brave\/key\)/);
  assert.equal(brave.searches.length, 0);
  const listed = (await r.call("/v1/providers", { token: OWN })).json.find((provider: any) => provider.id === "brave");
  assert.deepEqual(listed, { id: "brave", kind: "search", models: 0, apiKey: true, key: null });

  // With its own key.
  const set = await r.call("/v1/providers/brave/key", { method: "PUT", body: { apiKey: "own-brave-key" }, token: OWN });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.verification.status, "unverified");
  await r.prompt(own, "look it up again", OWN);
  assert.deepEqual(brave.searches, [{ token: "own-brave-key", q: "agent runtime", count: "2", freshness: "pw" }]);
  const searched = JSON.parse(toolResults(r.model.bodies.at(-2)).at(-1));
  assert.deepEqual(searched, { query: "agent runtime", results: [
    { title: "Agent runtime docs", url: brave.url.replace("/res/v1/web/search", "/page"), snippet: "How the agent runtime hosts agents & tools.", date: "2026-09-01" },
    { title: "Release notes", url: "https://example.com/releases", snippet: "What changed", date: "2 days ago" },
  ] }, "text only, web links only, at most count");
  assert.equal(JSON.parse(lastResult()).title, "Agent runtime docs", "the model reads the first result with web_fetch");
  const ownUsage = (await r.call("/v1/usage", { token: OWN })).json.days.find((day: any) => day.model === "brave/web_search");
  assert.deepEqual([ownUsage.responses, ownUsage.platformResponses, ownUsage.platformCost], [1, 0, 0], "a search on the tenant's own key is not charged");

  // A key the provider rejects says so.
  await r.call("/v1/providers/brave/key", { method: "PUT", body: { apiKey: "bad-brave-key" }, token: OWN });
  await r.prompt(own, "once more", OWN);
  assert.match(lastResult(), /brave rejected the search API key \(HTTP 401\)/);

  // A prepaid tenant without a key searches on the platform's, and pays the price per search.
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  const payg = await make(PAYG, ["web_search"]);
  await r.prompt(payg, "look it up", PAYG);
  const offered = r.model.bodies.find(body => body.tools?.some((tool: any) => tool.function.name === "web_search") && !body.tools.some((tool: any) => tool.function.name === "web_fetch"));
  assert.doesNotMatch(offered.tools.find((tool: any) => tool.function.name === "web_search").function.description, /web_fetch/, "without web_fetch, web_search does not point at it");
  assert.equal(brave.searches.at(-1)!.token, "platform-brave-key");
  const usage = (await r.call("/v1/usage", { token: PAYG })).json.days.find((day: any) => day.model === "brave/web_search");
  assert.deepEqual([usage.responses, usage.platformResponses, usage.platformCost], [1, 1, 0.25]);
  await until(async () => (await r.call("/v1/billing", { token: PAYG })).json.balance === 750_000, "the search's charge");
  assert.ok((await r.call("/v1/providers", { token: PAYG })).json.some((provider: any) => provider.id === "brave" && provider.key?.source === "platform"));
});

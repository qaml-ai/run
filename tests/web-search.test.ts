import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { braveSearch, exaSearch, firecrawlSearch, parallelSearch, searchProvidersFromEnvironment, WebSearch, withinBudget, type SearchProviderId } from "../src/web-search.ts";
import { builtinDefinitions } from "../src/builtins.ts";
import type { UsageRecord } from "../src/client-sessions.ts";
import { Outbound } from "../src/outbound.ts";
import { micros } from "../src/pricing.ts";
import { free, listen, runtime, sleep, toolCall, toolResults, until, type T } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const PAYG = "payg-operator-token-at-least-24-chars";
const OWN = "own-operator-token-at-least-24-chars";
const OPS = "ops-operator-token-at-least-24-chars";
const ADMIN_KEYED = "admin-keyed-operator-token-at-least-24";
const tenantsFile = {
  tenants: {
    payg: { tokenSha256: sha(PAYG), apiKeys: {}, billing: "prepaid" },
    // An operator's tenant that keeps to its own keys: no fallback to the platform's.
    own: { tokenSha256: sha(OWN), apiKeys: { openrouter: "fixture-model-key" }, platformKeys: false },
    ops: { tokenSha256: sha(OPS), apiKeys: { openrouter: "fixture-model-key" } },
  },
  platformKeys: { openrouter: "fixture-platform-model-key", brave: "platform-brave-key" },
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

test("Exa, Parallel and Firecrawl are POSTed JSON, and their answers become plain results with the page text they carry", () => {
  const parse = (body: string | undefined) => JSON.parse(body!);
  const exa = exaSearch({ endpoint: "https://exa.example/search", type: "fast" });
  const exaRequest = exa.request({ query: "a b", count: 3, freshness: "week" }, "k");
  assert.deepEqual([exaRequest.url, exaRequest.secrets], ["https://exa.example/search", { "x-api-key": "k" }]);
  const exaBody = parse(exaRequest.body);
  assert.deepEqual([exaBody.query, exaBody.type, exaBody.numResults, exaBody.contents], ["a b", "fast", 3, { highlights: { maxCharacters: 1000 } }]);
  assert.ok(Math.abs(Date.now() - 7 * 86_400_000 - Date.parse(exaBody.startPublishedDate)) < 60_000);
  assert.deepEqual(exa.results({ results: [{ title: "A &amp; B", url: "https://a.example", publishedDate: "2026-09-16T20:17:37.000Z", highlights: ["first\n\n\n\npart", "second"] }, { title: "No date", url: "https://b.example" }] }), [
    { title: "A & B", url: "https://a.example", snippet: "first part … second", date: "2026-09-16", content: "first\n\npart\n…\nsecond" },
    { title: "No date", url: "https://b.example", snippet: "" },
  ]);

  const parallel = parallelSearch({ mode: "fast" });
  const parallelRequest = parallel.request({ query: "q", count: 2, freshness: "day" }, "k");
  assert.deepEqual([parallelRequest.url, parallelRequest.secrets], ["https://api.parallel.ai/v1/search", { "x-api-key": "k" }]);
  const parallelBody = parse(parallelRequest.body);
  assert.deepEqual([parallelBody.objective, parallelBody.search_queries, parallelBody.mode, parallelBody.max_chars_total, parallelBody.advanced_settings.max_results], ["q", ["q"], "fast", 2000, 2]);
  assert.match(parallelBody.advanced_settings.source_policy.after_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(parallel.results({ results: [{ url: "https://p.example", title: "P", publish_date: "2026-09-20", excerpts: ["one", "two"] }] }),
    [{ title: "P", url: "https://p.example", snippet: "one … two", date: "2026-09-20", content: "one\n…\ntwo" }]);

  const firecrawl = firecrawlSearch({ scrape: true });
  const firecrawlRequest = firecrawl.request({ query: "q", count: 5, freshness: "month" }, "k");
  assert.deepEqual(firecrawlRequest.secrets, { Authorization: "Bearer k" });
  const firecrawlBody = parse(firecrawlRequest.body);
  assert.deepEqual([firecrawlBody.limit, firecrawlBody.tbs, firecrawlBody.scrapeOptions.formats], [5, "qdr:m", ["markdown"]]);
  assert.equal(parse(firecrawlSearch().request({ query: "q", count: 5 }, "k").body).scrapeOptions, undefined);
  assert.deepEqual(firecrawl.results({ data: { web: [{ url: "https://f.example", title: "F", description: "[The Right Honourable](https://en.wikipedia.org/wiki/X) d ![logo](https://i.example/l.png \"L\")", markdown: "# F\n\nbody", metadata: { publishedTime: "2026-09-01T00:00:00Z" } }] } }),
    [{ title: "F", url: "https://f.example", snippet: "The Right Honourable d logo", date: "2026-09-01", content: "# F\n\nbody" }]);
  assert.deepEqual([exa.results({}), parallel.results(null), firecrawl.results({ data: {} })], [[], [], []]);
});

test("web_search uses the tenant's own search key, else the platform's billed to credit, and pairs with web_fetch", async t => {
  const brave = await fakeBrave(t);
  const r = await runtime(t, free(researcher), {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_BRAVE_SEARCH_URL: brave.url, AGENT_WEB_SEARCH_PROVIDERS: "brave",
    AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0", AGENT_PRICE_WEB_SEARCH_USD: "0.25",
  }, tenantsFile);
  const make = async (token: string, builtins: string[]) => {
    const definition = (await r.call("/v1/definitions", { body: { name: "Researcher", builtins }, token })).json;
    return (await r.call("/v1/agents", { body: { definition: definition.id }, token })).json.id;
  };
  const lastResult = () => toolResults(r.model.bodies.at(-1)).at(-1);

  // A tenant without a search key that may not use the platform's (platformKeys: false): it is told how to add one.
  const own = await make(OWN, ["web_search", "web_fetch"]);
  const tools = r.model.bodies.length;
  await r.prompt(own, "look it up", OWN);
  assert.match(toolResults(r.model.bodies[tools + 1]).at(-1), /Web search isn't available for this account: add a Brave key under Models & keys \(PUT \/v1\/providers\/brave\/key\)/);
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
  assert.deepEqual(searched, { query: "agent runtime", provider: "brave", results: [
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

/**
 * Exa, Brave and Parallel on one local server, each answering in its own shape, or as `behave` says:
 * an HTTP status, or "slow" (an answer later than the search's per-provider deadline).
 */
async function fakeProviders(t: T) {
  const behave: Partial<Record<SearchProviderId, number | "slow">> = {};
  const calls: { provider: string; key: string }[] = [];
  const base = await listen(t, async (req, res) => {
    const provider = new URL(req.url!, "http://x").pathname.slice(1) as SearchProviderId;
    for await (const _chunk of req) { /* the body */ }
    calls.push({ provider, key: String(req.headers["x-api-key"] ?? req.headers["x-subscription-token"] ?? "") });
    const how = behave[provider];
    if (how === "slow") await sleep(1_000);
    else if (typeof how === "number") return res.writeHead(how, { "Content-Type": "application/json" }).end("{}");
    const body = provider === "brave" ? { web: { results: [{ title: "Brave result", url: "https://brave.example/1", description: "from brave" }] } }
      : { results: [{ title: `${provider} result`, url: `https://${provider}.example/1`, ...(provider === "exa" ? { highlights: ["from exa"] } : { excerpts: ["from parallel"] }) }] };
    if (!res.destroyed) res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  const env = { AGENT_EXA_SEARCH_URL: `${base}/exa`, AGENT_BRAVE_SEARCH_URL: `${base}/brave`, AGENT_PARALLEL_SEARCH_URL: `${base}/parallel` };
  return { behave, calls, env };
}

function webSearch(env: Record<string, string>, keys: Partial<Record<SearchProviderId, string>>) {
  const usage: UsageRecord[] = [];
  const prices = { exa: micros(0.007), brave: micros(0.005), parallel: micros(0.001) };
  const search = new WebSearch({
    outbound: new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] }), ...searchProvidersFromEnvironment(env), timeoutMs: 300,
    key: async (_tenant, provider) => keys[provider as SearchProviderId] ? { key: keys[provider as SearchProviderId]!, platform: true } : undefined,
    price: provider => prices[provider], onSearch: (_tenant, _agent, record) => usage.push(record),
  });
  const run = (args: Record<string, unknown> = { query: "q" }, providers?: string[]) => search.search({ tenant: "acme", agent: "a1", ...(providers ? { providers } : {}) }, args, new AbortController().signal);
  return { run, usage };
}

test("the model gets each result's excerpt in place of its snippet, within a budget per result and per search", () => {
  const result = (i: number, content?: string) => ({ title: `t${i}`, url: `https://e.example/${i}`, snippet: `s${i}`, ...(content ? { content } : {}) });
  const long = "x".repeat(2_500);
  assert.deepEqual(withinBudget([result(1, long), result(2), result(3, "short")]), [
    { title: "t1", url: "https://e.example/1", content: "x".repeat(1_000) },
    { title: "t2", url: "https://e.example/2", snippet: "s2" },
    { title: "t3", url: "https://e.example/3", content: "short" },
  ], "1,000 characters each; a result without an excerpt keeps its snippet");
  const ten = withinBudget(Array.from({ length: 10 }, (_, i) => result(i, long)));
  assert.deepEqual(ten.map(hit => "content" in hit ? hit.content.length : `snippet ${hit.snippet}`), [1000, 1000, 1000, 1000, 1000, 1000, "snippet s6", "snippet s7", "snippet s8", "snippet s9"], "6,000 in all; past that, snippets");
  assert.deepEqual(withinBudget([result(1, long), result(2, long)], 1_000, 1_150).map(hit => "content" in hit ? hit.content.length : hit.snippet), [1000, "s2"], "no excerpt cut under 200 characters");
  assert.deepEqual(withinBudget([result(1, long), result(2, long)], 1_000, 1_300).map(hit => "content" in hit ? hit.content.length : hit.snippet), [1000, 300]);
});

test("web_search's description tells the model the excerpts often answer, and points at web_fetch only when it has it", () => {
  const [withFetch] = builtinDefinitions(["web_search", "web_fetch"]);
  assert.match(withFetch.description, /excerpts of the page relevant to the query \(up to 1,000 characters\), or a short `snippet`\. The excerpts often hold the answer, so you may not need to open the page; when they don't, or a result has only a snippet, read the page with web_fetch\./);
  const [alone] = builtinDefinitions(["web_search"]);
  assert.doesNotMatch(alone.description, /web_fetch/);
  assert.match(alone.description, /Answer from the excerpts and snippets: pages cannot be opened\.$/);
});

test("web_search tries Exa, Brave, then Parallel, moving on when one times out, fails or is rate limited, and charges the one that answered", async t => {
  const fake = await fakeProviders(t);
  const { run, usage } = webSearch(fake.env, { exa: "exa-key", brave: "brave-key", parallel: "parallel-key" });

  const first = await run();
  assert.deepEqual(first, { query: "q", provider: "exa", results: [{ title: "exa result", url: "https://exa.example/1", content: "from exa" }] }, "Exa's highlight in place of a snippet");
  assert.deepEqual(usage.at(-1), { provider: "exa", model: "web_search", usage: { cost: { total: 0.007 } }, platform: true, searches: 1 });

  fake.behave.exa = "slow";
  const slow = await run();
  assert.equal(slow.provider, "brave", "a provider slower than its deadline is given up on");
  assert.deepEqual(usage.at(-1), { provider: "brave", model: "web_search", usage: { cost: { total: 0.005 } }, platform: true, searches: 1 });
  assert.equal(usage.length, 2, "the timed-out search is not charged");

  fake.behave.exa = 503;
  fake.behave.brave = 429;
  const busy = await run();
  assert.equal(busy.provider, "parallel");
  assert.deepEqual(busy.results, [{ title: "parallel result", url: "https://parallel.example/1", content: "from parallel" }]);
  assert.equal(usage.at(-1)!.usage.cost.total, 0.001, "charged at Parallel's price");

  fake.behave.parallel = 500;
  await assert.rejects(run(), /Web search failed: exa search failed \(HTTP 503\); brave is rate limiting searches \(HTTP 429\); parallel search failed \(HTTP 500\)/);
  assert.equal(usage.length, 3, "nothing answered, nothing charged");

  // A request the provider calls bad is the request's fault: another provider is not asked.
  fake.behave.exa = 400;
  fake.calls.length = 0;
  await assert.rejects(run(), /exa refused the search request \(HTTP 400\)/);
  assert.deepEqual(fake.calls.map(call => call.provider), ["exa"]);

  // A key the provider refuses is that provider's problem: the next one answers.
  fake.behave.exa = 401;
  delete fake.behave.brave;
  assert.equal((await run()).provider, "brave");
});

test("web_search skips providers without a key, keeps to a definition's own order, and says which keys would set it up", async t => {
  const fake = await fakeProviders(t);
  const onlyParallel = webSearch(fake.env, { parallel: "parallel-key" });
  const answered = await onlyParallel.run();
  assert.equal(answered.provider, "parallel");
  assert.deepEqual(fake.calls, [{ provider: "parallel", key: "parallel-key" }], "providers without a key are never called");

  fake.calls.length = 0;
  const all = webSearch(fake.env, { exa: "exa-key", brave: "brave-key", parallel: "parallel-key" });
  assert.equal((await all.run({ query: "q" }, ["brave"])).provider, "brave");
  fake.behave.brave = 503;
  await assert.rejects(all.run({ query: "q" }, ["brave"]), /Web search failed: brave search failed \(HTTP 503\)$/, "a pinned provider has no fallback beyond its list");
  assert.equal((await all.run({ query: "q" }, ["brave", "parallel"])).provider, "parallel");
  assert.deepEqual(fake.calls.map(call => call.provider), ["brave", "brave", "brave", "parallel"]);
  await assert.rejects(all.run({ query: "q" }, ["bing"]), /webSearch.providers must list one or more of exa, brave, parallel/);

  const none = webSearch(fake.env, {});
  await assert.rejects(none.run(), /Web search isn't available for this account: add an Exa, Brave or Parallel key under Models & keys \(PUT \/v1\/providers\/<provider>\/key\)/);
  await assert.rejects(none.run({ query: "q" }, ["exa"]), /add an Exa key under Models & keys \(PUT \/v1\/providers\/exa\/key\)/);
  assert.throws(() => searchProvidersFromEnvironment({ AGENT_WEB_SEARCH_PROVIDERS: "exa,exa" }), /AGENT_WEB_SEARCH_PROVIDERS must list/);
  assert.deepEqual(searchProvidersFromEnvironment({}).order, ["exa", "brave", "parallel"]);
});

test("a definition pins web_search's providers; a platform search is charged at the answering provider's price and counted in the hour's ledger entry", async t => {
  const fake = await fakeProviders(t);
  const r = await runtime(t, free((body: any) => {
    const tool = body.messages.at(-1).role === "tool";
    return tool ? { role: "assistant", content: "done" } : toolCall("web_search", { query: "agent runtime" }, `search_${body.messages.length}`);
  }), {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", ...fake.env,
    AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0", AGENT_PRICE_WEB_SEARCH_PARALLEL_USD: "0.02",
  }, { ...tenantsFile, platformKeys: { openrouter: "fixture-platform-model-key", exa: "platform-exa-key", brave: "platform-brave-key", parallel: "platform-parallel-key" } });
  assert.equal((await r.call("/v1/definitions", { body: { name: "Bad", builtins: ["web_search"], webSearch: { providers: ["bing"] } }, token: PAYG })).status, 400);
  assert.equal((await r.call("/v1/definitions", { body: { name: "Bad", builtins: ["web_search"], webSearch: { providers: ["exa", "exa"] } }, token: PAYG })).status, 400);
  assert.equal((await r.call("/v1/definitions", { body: { name: "Bad", builtins: ["web_search"], webSearch: { order: ["exa"] } }, token: PAYG })).status, 400);
  const created = await r.call("/v1/definitions", { body: { name: "Pinned", builtins: ["web_search"], webSearch: { providers: ["parallel", "brave"] } }, token: PAYG });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.json.webSearch, { providers: ["parallel", "brave"] });
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  const agent = (await r.call("/v1/agents", { body: { definition: created.json.id }, token: PAYG })).json.id;
  await r.prompt(agent, "look it up", PAYG);
  assert.equal(JSON.parse(toolResults(r.model.bodies.at(-1)).at(-1)).provider, "parallel");
  assert.deepEqual(fake.calls, [{ provider: "parallel", key: "platform-parallel-key" }], "the definition's order, not the runtime's");
  const usage = (await r.call("/v1/usage", { token: PAYG })).json.days.find((day: any) => day.model === "parallel/web_search");
  assert.deepEqual([usage.responses, usage.platformResponses, usage.platformCost], [1, 1, 0.02]);
  await until(async () => (await r.call("/v1/billing", { token: PAYG })).json.balance === 980_000, "the search's charge at Parallel's price");
  const entry = (await r.call("/v1/billing/ledger", { token: PAYG })).json.entries.find((row: any) => row.kind === "usage");
  assert.equal(entry.amount, -20_000);
  assert.deepEqual([entry.metadata.searches, entry.metadata.renders, entry.metadata.web, entry.metadata.tokens], [1, 0, 20_000, 0], "the hour's entry counts the search apart from tokens");
  const rates = (await r.call("/v1/billing", { token: PAYG })).json.rates;
  assert.deepEqual([rates.webSearch, rates.webRender], [{ exa: 7_000, brave: 5_000, parallel: 20_000 }, 830]);
  const providers = (await r.call("/v1/providers", { token: PAYG })).json.filter((provider: any) => provider.kind !== "model").map((provider: any) => [provider.id, provider.kind]);
  assert.deepEqual(providers, [["brave", "search"], ["exa", "search"], ["firecrawl", "fetch"], ["parallel", "search"]]);
});

test("a search key the operator set for a tenant (its apiKeys) is used, and is not counted as the platform's", async t => {
  const brave = await fakeBrave(t);
  const r = await runtime(t, researcher, {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_BRAVE_SEARCH_URL: brave.url, AGENT_WEB_SEARCH_PROVIDERS: "brave",
    AGENT_PRICE_AGENT_HOUR_USD: "0", AGENT_PRICE_WEB_SEARCH_USD: "0.25",
  }, { ...tenantsFile, tenants: { admin: { tokenSha256: sha(ADMIN_KEYED), apiKeys: { openrouter: "fixture-model-key", brave: "admin-brave-key" } } } });
  const definition = (await r.call("/v1/definitions", { body: { name: "Researcher", builtins: ["web_search"] }, token: ADMIN_KEYED })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id }, token: ADMIN_KEYED })).json.id;
  await r.prompt(agent, "look it up", ADMIN_KEYED);
  assert.equal(brave.searches.at(-1)!.token, "admin-brave-key");
  const usage = await until(async () => (await r.call("/v1/usage", { token: ADMIN_KEYED })).json.days.find((day: any) => day.model === "brave/web_search"), "the search's usage");
  assert.deepEqual([usage.responses, usage.platformResponses, usage.platformCost], [1, 0, 0]);
});

test("an operator's tenant without a key of its own searches on the platform's, recorded as platform usage and never charged; its own key wins; platformKeys: false keeps the refusal", async t => {
  const brave = await fakeBrave(t);
  const r = await runtime(t, researcher, {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_BRAVE_SEARCH_URL: brave.url, AGENT_WEB_SEARCH_PROVIDERS: "brave",
    AGENT_PRICE_AGENT_HOUR_USD: "0", AGENT_PRICE_WEB_SEARCH_USD: "0.25",
  }, tenantsFile);
  const make = async (token: string) => {
    const definition = (await r.call("/v1/definitions", { body: { name: "Researcher", builtins: ["web_search"] }, token })).json;
    return { definition, agent: (await r.call("/v1/agents", { body: { definition: definition.id }, token })).json };
  };
  const braveUsage = (token: string) => until(async () => (await r.call("/v1/usage", { token })).json.days.find((day: any) => day.model === "brave/web_search"), "the search's usage");

  // Unbilled, with a model key but no search key: the platform's brave key answers, and the save warns of nothing.
  const ops = await make(OPS);
  assert.equal(ops.definition.warnings, undefined);
  assert.equal(ops.agent.warnings, undefined);
  await r.prompt(ops.agent.id, "look it up", OPS);
  assert.equal(brave.searches.at(-1)!.token, "platform-brave-key");
  const usage = await braveUsage(OPS);
  assert.deepEqual([usage.responses, usage.platformResponses, usage.platformCost], [1, 1, 0.25], "recorded as the platform's");
  const billing = (await r.call("/v1/billing", { token: OPS })).json;
  assert.deepEqual([billing.billing, billing.balance], ["none", 0], "never charged");
  assert.ok(!(await r.call("/v1/billing/ledger", { token: OPS })).json.entries.some((entry: any) => entry.kind === "usage"));
  assert.equal((await r.call("/v1/providers", { token: OPS })).json.find((provider: any) => provider.id === "brave").key.source, "platform");

  // Its own key wins over the platform's.
  assert.equal((await r.call("/v1/providers/brave/key", { method: "PUT", body: { apiKey: "own-ops-brave-key" }, token: OPS })).status, 200);
  await r.prompt(ops.agent.id, "look it up again", OPS);
  assert.equal(brave.searches.at(-1)!.token, "own-ops-brave-key");
  const after = await until(async () => { const day = await braveUsage(OPS); return day.responses === 2 && day; }, "the second search's usage");
  assert.deepEqual([after.platformResponses, after.platformCost], [1, 0.25], "the search on its own key is not the platform's");

  // platformKeys: false: no fallback, and saving a definition or an agent with web_search says why it will not search.
  const searches = brave.searches.length;
  const own = await make(OWN);
  const hint = /^Web search isn't available for this account: add a Brave key under Models & keys \(PUT \/v1\/providers\/brave\/key\)$/;
  assert.match(own.definition.warnings?.[0], hint);
  assert.match(own.agent.warnings?.[0], hint);
  const direct = (await r.call("/v1/agents", { body: { builtins: ["web_search", "web_fetch"] }, token: OWN })).json;
  assert.match(direct.warnings?.[0], hint);
  assert.equal((await r.call("/v1/agents", { body: { builtins: ["web_fetch"] }, token: OWN })).json.warnings, undefined, "web_fetch works without a renderer key");
  const patched = await r.call(`/v1/definitions/${own.definition.id}`, { method: "PATCH", body: { builtins: ["web_fetch"] }, token: OWN });
  assert.equal(patched.json.warnings, undefined);
  await r.prompt(own.agent.id, "look it up", OWN);
  assert.match(toolResults(r.model.bodies.at(-1)).at(-1), hint);
  assert.equal(brave.searches.length, searches);
  assert.ok(!(await r.call("/v1/providers", { token: OWN })).json.some((provider: any) => provider.key?.source === "platform"));
});

test("js_exec's searches on the platform's key stop once the tenant's credit is spent, without waiting for the next model request", async t => {
  const brave = await fakeBrave(t);
  const code = `const out = []; for (let i = 0; i < 4; i++) { try { out.push((await tools.web_search({ query: "q" + i })).provider); } catch (error) { out.push(String(error.message ?? error)); } } return JSON.stringify(out);`;
  const r = await runtime(t, (_body, index) => index === 0 ? toolCall("js_exec", { code }) : { role: "assistant", content: "done" }, {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_BRAVE_SEARCH_URL: brave.url, AGENT_WEB_SEARCH_PROVIDERS: "brave",
    AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0", AGENT_PRICE_WEB_SEARCH_USD: "0.6", AGENT_FREE_HOURLY_SPEND_USD: "100",
  }, tenantsFile);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  const definition = (await r.call("/v1/definitions", { body: { name: "Searcher", builtins: ["web_search"] }, token: PAYG })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id }, token: PAYG })).json.id;
  const outcome = await r.prompt(agent, "search a lot", PAYG);
  assert.equal(brave.searches.length, 2, "$1 of credit pays for the first search and starts the second; the rest are refused");
  const messages = (await r.call(`/v1/agents/${agent}/history`, { token: PAYG })).json.messages;
  const result = JSON.stringify(messages.find((message: any) => message.role === "toolResult"));
  assert.match(result, /brave.*brave.*out of credit.*out of credit/, result);
  assert.equal(r.model.bodies.length, 1, "the next model request is refused too");
  assert.match(JSON.stringify(outcome), /INSUFFICIENT_CREDIT|SPEND_LIMIT|credit/);
});

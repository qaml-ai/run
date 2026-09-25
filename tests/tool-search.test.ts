import { test } from "node:test";
import assert from "node:assert/strict";
import { executeCode } from "../src/codemode.ts";
import { CATALOG_LIMITS } from "../src/limits.ts";
import { validateDefinitions } from "../src/tool-policy.ts";
import { compose, defaultExposure, valueServer } from "../src/tool-servers.ts";
import { embeddingReranker, jevReranker, keywordScores, namespaces, rerankersFromEnv, searchQuery, searchTools, type Candidate, type Reranker } from "../src/tool-search.ts";
import { listen } from "./runtime-server.ts";

const tool = (name: string, description: string) => ({ name, description, parameters: { type: "object", properties: {} } });
const catalog = [
  tool("github__list_open_issues", "List a repository's open issues"),
  tool("github__create_issue", "Open a new issue in a repository"),
  tool("github__merge_pull_request", "Merge a pull request"),
  tool("remove_file", "Delete a file from the workspace"),
  tool("send_message", "Send a message to the person you are talking with"),
  tool("stripe__createCustomer", "Create a customer"),
  tool("stripe__listInvoices", "List invoices, newest first"),
];
const names = (hits: { name: string }[]) => hits.map(hit => hit.name);
/** A stage scoring one tool (by name) above all others. */
const favors = (name: string, maxCandidates = Infinity, seen?: Candidate[][]): Reranker => ({
  kind: "fake", maxCandidates,
  rerank: async (_query, candidates) => { seen?.push(candidates); return candidates.map(entry => entry.name === name ? 1 : 0); },
});

test("keyword search matches words, not a substring of the whole query", async () => {
  assert.equal(names(await searchTools(catalog, { query: "list issues" }))[0], "github__list_open_issues");
  // camelCase and underscores split into words; plurals and tenses meet their stem.
  assert.equal(names(await searchTools(catalog, { query: "create customers" }))[0], "stripe__createCustomer");
  assert.equal(names(await searchTools(catalog, { query: "invoice" }))[0], "stripe__listInvoices");
  assert.equal(names(await searchTools(catalog, { query: "merged pull requests" }))[0], "github__merge_pull_request");
  // The source (before "__") counts: "github" finds its tools, the best match first.
  const github = names(await searchTools(catalog, { query: "github issue" }));
  assert.deepEqual(github.slice(0, 2).sort(), ["github__create_issue", "github__list_open_issues"]);
  // Nothing matching comes back empty, and stopwords or single letters match nothing.
  assert.deepEqual(await searchTools(catalog, { query: "weather forecast" }), []);
  assert.deepEqual(await searchTools(catalog, { query: "email someone" }), [], "keywords alone miss synonyms");
  const scores = keywordScores(catalog, "delete a file");
  assert.equal(scores.indexOf(Math.max(...scores)), 3);
});

test("an empty query lists the catalog; namespace and limit narrow it; namespaces count the sources", async () => {
  assert.deepEqual(names(await searchTools(catalog, {})), catalog.map(entry => entry.name));
  assert.deepEqual(names(await searchTools(catalog, { namespace: "stripe" })), ["stripe__createCustomer", "stripe__listInvoices"]);
  assert.deepEqual(names(await searchTools(catalog, { query: "list", namespace: "github" })), ["github__list_open_issues"]);
  assert.ok((await searchTools(catalog, { query: "issue", limit: 1 })).length === 1);
  assert.deepEqual(namespaces(catalog), [{ namespace: "", tools: 2 }, { namespace: "github", tools: 3 }, { namespace: "stripe", tools: 2 }]);
  const long = await searchTools([tool("x", "y".repeat(1_000))], {});
  assert.equal(long[0].description.length, 300, "descriptions are shortened; describe has them whole");
  assert.deepEqual(searchQuery("q"), { query: "q" });
  assert.deepEqual(searchQuery({ query: "q", limit: 500 }), { query: "q", limit: 128 });
  assert.throws(() => searchQuery({ limit: 0 }), /positive integer/);
  assert.throws(() => searchQuery(5), /query string/);
});

test("rerank stages find what keywords miss, and keyword ranking answers when they fail or are slow", async () => {
  assert.equal(names(await searchTools(catalog, { query: "email someone" }, { rerankers: [favors("send_message")] }))[0], "send_message");
  assert.equal(names(await searchTools(catalog, { query: "delete file" }, { rerankers: [favors("remove_file")] }))[0], "remove_file");

  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  const broken: Reranker = { kind: "fake", maxCandidates: Infinity, rerank: async () => { throw new Error("down"); } };
  assert.equal(names(await searchTools(catalog, { query: "list issues" }, { rerankers: [broken], onError }))[0], "github__list_open_issues");
  const wrong: Reranker = { kind: "fake", maxCandidates: Infinity, rerank: async () => [1] };
  assert.equal(names(await searchTools(catalog, { query: "list issues" }, { rerankers: [wrong], onError }))[0], "github__list_open_issues");
  const slow: Reranker = { kind: "fake", maxCandidates: Infinity, rerank: (_query, _candidates, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))) };
  const started = Date.now();
  assert.equal(names(await searchTools(catalog, { query: "list issues" }, { rerankers: [slow], timeoutMs: 50, onError }))[0], "github__list_open_issues");
  assert.ok(Date.now() - started < 1_000);
  assert.equal(errors.length, 3);
  // A failed stage is left out; the next still runs.
  assert.equal(names(await searchTools(catalog, { query: "email someone" }, { rerankers: [broken, favors("send_message")], onError }))[0], "send_message");
  // An empty query never reranks.
  assert.equal((await searchTools(catalog, {}, { rerankers: [broken] })).length, catalog.length);
});

test("a stage that takes fewer candidates than the catalog gets the best of the stages before it", async () => {
  // 1000 tools; the one that answers "refund an order" shares no word with it.
  const big = Array.from({ length: 1000 }, (_, index) => tool(`ns${index % 40}__tool_${index}`, `Does thing number ${index}`));
  big[777] = tool("billing__give_money_back", "Return a payment to a customer");
  const seen: Candidate[][] = [];
  const hits = await searchTools(big, { query: "refund an order" }, { rerankers: [favors("billing__give_money_back"), favors("billing__give_money_back", 100, seen)] });
  assert.equal(hits[0].name, "billing__give_money_back");
  assert.equal(seen[0].length, 100, "the second stage took at most its limit");
  assert.equal(seen[0][0].name, "billing__give_money_back", "and its candidates came from the first stage's order");
  // Without a stage that sees everything, a limited stage gets keyword matches first, then catalog order.
  const cut: Candidate[][] = [];
  await searchTools(big, { query: "thing number 999" }, { rerankers: [favors("x", 10, cut)] });
  assert.equal(cut[0].length, 10);
  assert.equal(cut[0][0].name, "ns39__tool_999");
});

test("catalogs of thousands: limits, direct budget, names-only sandbox, host-side search and describe", async () => {
  const big = Array.from({ length: 4000 }, (_, index) => ({ ...tool(`src${Math.floor(index / 50)}__op_${index}`, `Operation ${index} of source ${Math.floor(index / 50)}`), parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }));
  validateDefinitions(big);
  assert.throws(() => validateDefinitions(Array.from({ length: CATALOG_LIMITS.tools + 1 }, (_, index) => tool(`t${index}`, ""))), /Too many tool definitions/);

  // 200 small sources would each be offered directly; only the first 64 tools are.
  const servers = Array.from({ length: 200 }, (_, index) => valueServer(defaultExposure([tool(`s${index}__only`, "One tool")]), async () => null));
  const { tools } = await compose(servers);
  assert.equal(tools.length, 200);
  assert.equal(tools.filter(entry => entry.exposure === "both").length, CATALOG_LIMITS.direct);
  assert.equal(tools.at(-1)!.exposure, "codemode");

  const calls: unknown[] = [];
  const bridge = { definitions: big, call: async (name: string, args: unknown) => { calls.push([name, args]); return { ok: true }; } };
  const started = performance.now();
  const result = await executeCode({ bridge, code: `
    const found = await tools.search({ query: "operation 3999", limit: 3 });
    const schema = await tools.describe(found[0].name);
    const sources = await tools.namespaces();
    const called = await tools[found[0].name]({ id: "x" });
    return { found: found.map(entry => entry.name), required: schema.parameters.required, sources: sources.length, first: sources[0], called, missing: await tools.describe("nope") };` });
  const value = JSON.parse(result.output[0]);
  assert.equal(value.found[0], "src79__op_3999");
  assert.deepEqual(value.required, ["id"]);
  assert.equal(value.sources, 80);
  assert.deepEqual(value.first, { namespace: "src0", tools: 50 });
  assert.deepEqual(value.called, { ok: true });
  assert.equal(value.missing, null);
  assert.deepEqual(calls, [["src79__op_3999", { id: "x" }]]);
  assert.ok(performance.now() - started < 5_000, "a 4000-tool catalog does not make js_exec slow");
});

test("tools.search in js_exec goes to the bridge's search when it has one", async () => {
  const asked: unknown[] = [];
  const bridge = { definitions: catalog, call: async () => null, search: async (query: unknown) => { asked.push(query); return [{ name: "send_message", description: "from the host" }]; } };
  const result = await executeCode({ bridge, code: `return [await tools.search("email someone"), await tools.search({ query: "x", limit: 1 })];` });
  assert.deepEqual(JSON.parse(result.output[0])[0], [{ name: "send_message", description: "from the host" }]);
  assert.deepEqual(asked, [{ query: "email someone" }, { query: "x", limit: 1 }]);
  await assert.rejects(executeCode({ bridge, code: `return await tools.search({ limit: -1 })` }), /positive integer/);
});

test("a relevance stage drops what it judges irrelevant, and everything when nothing fits", async () => {
  const judge = (relevant: string[]): Reranker => ({ kind: "fake", maxCandidates: Infinity, relevantAt: 0.5, rerank: async (_query, candidates) => candidates.map(entry => relevant.includes(entry.name) ? 0.9 : 0.1) });
  assert.deepEqual(names(await searchTools(catalog, { query: "open issues" }, { rerankers: [judge(["github__list_open_issues", "github__create_issue"])] })), ["github__list_open_issues", "github__create_issue"]);
  assert.deepEqual(await searchTools(catalog, { query: "order a pizza" }, { rerankers: [judge([])] }), []);
  // A relevance stage that fails filters nothing.
  const broken: Reranker = { kind: "fake", maxCandidates: Infinity, relevantAt: 0.5, rerank: async () => { throw new Error("down"); } };
  assert.equal((await searchTools(catalog, { query: "issue" }, { rerankers: [broken], onError: () => {} })).length, 2);
});

test("the embeddings and Jev backends speak their APIs; embeddings are cached and warmed", async t => {
  const seen: { path: string; body: any }[] = [];
  const url = await listen(t, async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    seen.push({ path: req.url!, body });
    assert.equal(req.headers.authorization, "Bearer key");
    const json = (value: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (req.url === "/v1/embeddings") return json({ data: body.input.map((text: string, index: number) => ({ index, embedding: text.includes("message") || text === "email someone" ? [1, 0] : [0, 1] })) });
    if (req.url === "/v1/systemone") return json({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]: [string, any]) => [id, { type: "noul", noul: question.instructions.startsWith("Could send_message ") ? 0.9 : 0.05 }])) });
    res.writeHead(404).end();
  });
  const base = `${url}/v1`;
  const embeddings = embeddingReranker({ url: base, apiKey: "key", model: "m" });
  embeddings.warm!(catalog);
  const embedded = () => seen.filter(entry => entry.path === "/v1/embeddings").map(entry => entry.body.input.length);
  for (let tries = 0; !embedded().length && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(embedded(), [catalog.length], "warming embeds the catalog");
  assert.equal(names(await searchTools(catalog, { query: "email someone" }, { rerankers: [embeddings] }))[0], "send_message");
  assert.deepEqual(embedded(), [catalog.length, 1], "a search then embeds only its query");

  // Jev asks one yes/no question per tool, and keeps only the tools it judges relevant.
  assert.deepEqual(names(await searchTools(catalog, { query: "email someone" }, { rerankers: [jevReranker({ url: base, apiKey: "key", model: "typesafe/jev-1.13" })] })), ["send_message"]);
  const jev = seen.find(entry => entry.path === "/v1/systemone")!.body;
  assert.equal(jev.state, "email someone");
  assert.equal(jev.model, "typesafe/jev-1.13");
  assert.equal(Object.keys(jev.questions).length, catalog.length);
  assert.equal(jev.questions.t3.type, "noul");
  assert.equal(jev.questions.t3.instructions, "Could remove_file (Delete a file from the workspace) do what is being searched for, or a step of it?");
});

test("rerank stages come from AGENT_TOOL_SEARCH", () => {
  assert.deepEqual(rerankersFromEnv({}), []);
  assert.deepEqual(rerankersFromEnv({ AGENT_TOOL_SEARCH: "keyword" }), []);
  for (const kind of ["embeddings", "jev"]) assert.equal(rerankersFromEnv({ AGENT_TOOL_SEARCH: kind, AGENT_TOOL_SEARCH_API_KEY: "k" })[0].kind, kind);
  assert.throws(() => rerankersFromEnv({ AGENT_TOOL_SEARCH: "rerank", AGENT_TOOL_SEARCH_API_KEY: "k" }), /not rerank/);
  const staged = rerankersFromEnv({ AGENT_TOOL_SEARCH: "embeddings, jev", AGENT_TOOL_SEARCH_API_KEY: "k" });
  assert.deepEqual(staged.map(stage => [stage.kind, stage.maxCandidates]), [["embeddings", Infinity], ["jev", 100]]);
  assert.throws(() => rerankersFromEnv({ AGENT_TOOL_SEARCH: "jev" }), /needs AGENT_TOOL_SEARCH_API_KEY/);
  // A key read from a secret that has no value yet: keywords only, rather than failing to start.
  assert.deepEqual(rerankersFromEnv({ AGENT_TOOL_SEARCH: "embeddings,jev" }, null), []);
  assert.equal(rerankersFromEnv({ AGENT_TOOL_SEARCH: "embeddings,jev" }, "from-secret").length, 2);
  assert.throws(() => rerankersFromEnv({ AGENT_TOOL_SEARCH: "vectors", AGENT_TOOL_SEARCH_API_KEY: "k" }), /not vectors/);
  assert.throws(() => rerankersFromEnv({ AGENT_TOOL_SEARCH: "jev,jev", AGENT_TOOL_SEARCH_API_KEY: "k" }), /twice/);
});

test("a search while the catalog is still warming waits for those embeddings instead of repeating them", async t => {
  const inputs: number[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const url = await listen(t, async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    inputs.push(body.input.length);
    // Hold the warm-up's answer until the search has asked for its own embeddings.
    if (inputs.length === 1) await held;
    res.writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ data: body.input.map((text: string, index: number) => ({ index, embedding: text.includes("message") || text === "email someone" ? [1, 0] : [0, 1] })) }));
  });
  const embeddings = embeddingReranker({ url: `${url}/v1`, apiKey: "key", model: "m" });
  embeddings.warm!(catalog);
  for (let tries = 0; !inputs.length && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  const searched = searchTools(catalog, { query: "email someone" }, { rerankers: [embeddings] });
  for (let tries = 0; inputs.length < 2 && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  release();
  assert.equal(names(await searched)[0], "send_message");
  assert.deepEqual(inputs, [catalog.length, 1], "the search embedded only its query");
});

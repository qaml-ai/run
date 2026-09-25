// Benchmarks web search providers for the web_search built-in: latency, errors, cost, relevance
// (graded blind by a judge model), answerability of known-answer questions from each provider's
// results alone, and freshness of news results. Keys come from the environment only (EXA_API_KEY,
// PARALLEL_API_KEY, FIRECRAWL_API_KEY, BRAVE_API_KEY, ANTHROPIC_API_KEY) and never reach a file.
//
//   node --experimental-strip-types scripts/bench-search.ts [--phase search|judge|judge-equal|answer|report|all] [--entries a,b] [--retry-errors] [--dry-run]
//
// Phases resume from bench/search/results/raw.json: a search, grade or answer already recorded is not redone.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { braveSearch, exaSearch, firecrawlSearch, parallelSearch, type Freshness, type SearchProvider, type SearchResult } from "../src/web-search.ts";

const ROOT = new URL("../bench/search/", import.meta.url).pathname;
const RAW = `${ROOT}results/raw.json`;
const SUMMARY = `${ROOT}results/summary.md`;
const TODAY = "2026-09-25";
const FRESH_SINCE = "2026-09-18";
const COUNT = 5;
const TIMEOUT_MS = 30_000;
/** What the product allows a search (SEARCH.timeoutMs); slower answers are counted as would-be timeouts. */
const PRODUCT_TIMEOUT_MS = 15_000;
const JUDGE_MODEL = "claude-sonnet-5";
/** Claude Sonnet 5, USD per token (platform.claude.com/docs/en/about-claude/pricing). */
const JUDGE_PRICE = { input: 2 / 1e6, output: 10 / 1e6 };
/** What the judge sees of each result, and the answerer's budgets: the same for every provider. */
const JUDGE_CHARS = 700;
const ANSWER = { native: { perResult: 1_600, total: 8_000 }, equalized: { perResult: 300, total: 1_500 } } as const;

/**
 * Per-request prices, from each provider's published pricing (read 2026-09-25):
 * - Exa (exa.ai/pricing): search $7 / 1k requests up to 10 results, any of instant/fast/auto; its answer
 *   carries costDollars, which is used when present (highlights were not billed extra in our runs).
 * - Parallel (parallel.ai/pricing): Search API per 1k requests (10 results): turbo/fast $1, basic/advanced $5.
 * - Firecrawl (firecrawl.dev/pricing, docs.firecrawl.dev/features/search): search is 2 credits per 10 results,
 *   plus 1 credit per scraped page; credits at the Standard plan's rate ($83/month annual for 100k = $0.00083).
 *   The Hobby plan ($16 for 5k) is $0.0032 per credit, ~4x.
 * - Brave (brave.com/search/api): $5 / 1k requests on the Search plan.
 */
const FIRECRAWL_CREDIT = 83 / 100_000;

type Entry = { id: string; key: string; provider: SearchProvider; label: string; price(body: any, results: number): number };
const ENTRIES: Entry[] = [
  { id: "exa-auto", key: "EXA_API_KEY", label: "Exa, type auto (default), highlights", provider: exaSearch({ type: "auto" }), price: body => body?.costDollars?.total ?? 0.007 },
  { id: "exa-instant", key: "EXA_API_KEY", label: "Exa, type instant, highlights", provider: exaSearch({ type: "instant" }), price: body => body?.costDollars?.total ?? 0.007 },
  { id: "parallel-advanced", key: "PARALLEL_API_KEY", label: "Parallel, mode advanced (default), excerpts", provider: parallelSearch({ mode: "advanced" }), price: () => 0.005 },
  { id: "parallel-fast", key: "PARALLEL_API_KEY", label: "Parallel, mode fast, excerpts", provider: parallelSearch({ mode: "fast" }), price: () => 0.001 },
  { id: "firecrawl", key: "FIRECRAWL_API_KEY", label: "Firecrawl, search only (highlight descriptions)", provider: firecrawlSearch(), price: body => (body?.creditsUsed ?? 2) * FIRECRAWL_CREDIT },
  { id: "firecrawl-scrape", key: "FIRECRAWL_API_KEY", label: "Firecrawl, search + scrape markdown", provider: firecrawlSearch({ scrape: true }), price: (body, results) => (body?.creditsUsed ?? 2 + results) * FIRECRAWL_CREDIT },
  { id: "brave", key: "BRAVE_API_KEY", label: "Brave web search", provider: braveSearch(), price: () => 0.005 },
];

type Query = { id: string; category: string; style: string; query: string; lang?: string; changed?: boolean; expected?: string; accept?: string };
type Search = {
  entry: string; query: string; run: 1 | 2 | "fresh"; at: string; latencyMs: number; status?: number; error?: string; count: number; cost: number;
  results?: (SearchResult & { content?: string })[];
};
/**
 * `judge` is the judge prompt's version (absent: 1); the report uses the current one's grades, all graded in one batch.
 * `chars` marks a check graded with every result's text cut to that many characters (--phase judge-equal).
 */
type Grade = { entry: string; query: string; scores: number[]; overall: number; note: string; cost: number; judge?: number; chars?: number };
type Answer = { entry: string; query: string; variant: keyof typeof ANSWER; answer: string; verdict: "correct" | "incorrect" | "not_found"; reason: string; cost: number };
type Raw = { searches: Search[]; grades: Grade[]; answers: Answer[]; notes?: string[] };

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const phase = flag("phase") ?? "all";
const dryRun = args.includes("--dry-run");
const queries: Query[] = JSON.parse(readFileSync(`${ROOT}queries.json`, "utf8")).queries;
const wanted = flag("entries")?.split(",");
const entries = ENTRIES.filter(entry => (!wanted || wanted.includes(entry.id)) && process.env[entry.key]);
const skipped = ENTRIES.filter(entry => (!wanted || wanted.includes(entry.id)) && !process.env[entry.key]);

/** Any key value in a string (an error message, an echoed request) replaced before it is logged or saved. */
const SECRETS = ["EXA_API_KEY", "PARALLEL_API_KEY", "FIRECRAWL_API_KEY", "BRAVE_API_KEY", "ANTHROPIC_API_KEY"].map(name => process.env[name]).filter((value): value is string => !!value && value.length >= 8);
const scrub = (text: string) => SECRETS.reduce((out, secret) => out.split(secret).join("[redacted]"), text);

const raw: Raw = existsSync(RAW) ? JSON.parse(readFileSync(RAW, "utf8")) : { searches: [], grades: [], answers: [] };
const save = () => { mkdirSync(dirname(RAW), { recursive: true }); writeFileSync(RAW, scrub(JSON.stringify(raw, null, 1)) + "\n"); };
let spent = 0;

async function search(entry: Entry, query: Query, run: Search["run"]): Promise<Search> {
  const request = entry.provider.request({ query: query.query, count: COUNT, ...(run === "fresh" ? { freshness: "week" as Freshness } : {}) }, process.env[entry.key]!);
  const at = new Date().toISOString();
  const started = performance.now();
  try {
    const response = await fetch(request.url, {
      method: request.body === undefined ? "GET" : "POST", body: request.body,
      headers: { ...request.headers, ...request.secrets }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) return { entry: entry.id, query: query.id, run, at, latencyMs, status: response.status, error: scrub(text.slice(0, 300)), count: 0, cost: 0 };
    const body = JSON.parse(text);
    const results = entry.provider.results(body).filter(result => /^https?:\/\//i.test(result.url)).slice(0, COUNT);
    const cost = entry.price(body, results.length);
    spent += cost;
    // The first run keeps its results (for grading, answering and freshness), trimmed to what any reader here sees.
    const keep = run !== 2 ? results.map(result => ({ ...result, ...(result.content ? { content: result.content.slice(0, ANSWER.native.perResult) } : {}) })) : undefined;
    return { entry: entry.id, query: query.id, run, at, latencyMs, status: response.status, count: results.length, cost, ...(keep ? { results: keep } : {}) };
  } catch (error) {
    return { entry: entry.id, query: query.id, run, at, latencyMs: Math.round(performance.now() - started), error: scrub(String((error as Error)?.message ?? error)), count: 0, cost: 0 };
  }
}

const shuffle = <T>(items: T[]) => { const out = [...items]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; };
const retryErrors = args.includes("--retry-errors");
const has = (entry: string, query: string, run: Search["run"]) => raw.searches.some(s => s.entry === entry && s.query === query && s.run === run && !(retryErrors && s.error));

async function searchPhase() {
  const news = queries.filter(query => query.category === "news");
  // Entries run side by side, each through its queries one at a time: first run, then the second, then news with freshness=week.
  await Promise.all(entries.map(async entry => {
    for (const run of [1, 2, "fresh"] as const) {
      for (const query of run === "fresh" ? news : queries) {
        if (has(entry.id, query.id, run)) continue;
        raw.searches = raw.searches.filter(s => !(s.entry === entry.id && s.query === query.id && s.run === run));
        const result = await search(entry, query, run);
        raw.searches.push(result);
        if (result.error) console.log(`${entry.id} ${query.id} run ${run}: ${result.status ?? ""} ${result.error.slice(0, 120)}`);
        save();
      }
      console.log(`${entry.id}: run ${run} done`);
    }
  }));
}

// ---- The judge: Claude, blind to which provider produced a list.

const client = () => new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const cost = (usage: Anthropic.Usage) => usage.input_tokens * JUDGE_PRICE.input + usage.output_tokens * JUDGE_PRICE.output;

async function structured<T>(system: string, user: string, schema: Record<string, unknown>, maxTokens = 1024): Promise<{ value: T; cost: number }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const message = await client().messages.create({
        model: JUDGE_MODEL, max_tokens: maxTokens, system, thinking: { type: "disabled" },
        output_config: { format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: user }],
      });
      const text = message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("");
      const spend = cost(message.usage);
      spent += spend;
      return { value: JSON.parse(text) as T, cost: spend };
    } catch (error) {
      if (attempt >= 3 || (error instanceof Anthropic.APIError && error.status !== undefined && error.status < 500 && error.status !== 429)) throw new Error(scrub(String(error)));
      await new Promise(resolve => setTimeout(resolve, 2_000 * (attempt + 1)));
    }
  }
}

/** A result list as every reader here sees it, whichever provider it came from. */
const render = (results: SearchResult[], perResult: number, total = Infinity) => {
  let left = total;
  return results.map((result, i) => {
    const body = (result.content || result.snippet || "").replace(/\s+/g, " ").trim();
    const text = body.slice(0, Math.max(0, Math.min(perResult, left)));
    left -= text.length;
    return `[${i + 1}] ${result.title || "(untitled)"}\nURL: ${result.url}\nDate: ${result.date ?? "unknown"}\nText: ${text || "(none)"}`;
  }).join("\n\n");
};

const JUDGE_VERSION = 2;
const graded = (g: Grade) => (g.judge ?? 1) === JUDGE_VERSION && g.chars === undefined;
/** The text each result shows the judge in the equal-length check: about a Brave snippet's length. */
const EQUAL_CHARS = 300;
const JUDGE_SYSTEM = `You grade web search results for an AI agent that will use them to answer or research the query. Today is ${TODAY}.
The results may report events, releases and papers from after your training data: take today's date as given and judge them on their sources and consistency, not on whether you already knew of them.
Grade each result 0-3:
3 = directly answers or is exactly what the query needs, from a credible source, and current if the query is time-sensitive;
2 = relevant and useful, but partial, secondary, or somewhat dated for a time-sensitive query;
1 = tangentially related, thin, or outdated for a time-sensitive query;
0 = irrelevant, spam, broken, or wrong.
Judge from the title, URL, date and text shown. Then grade the whole list's usefulness to the agent 1-5 (5 = everything needed is here; 1 = useless). Be consistent and strict; do not reward length for its own sake.`;

async function judgePhase(chars?: number) {
  const done_ = (g: Grade) => chars === undefined ? graded(g) : g.chars === chars && g.judge === JUDGE_VERSION;
  const lists = raw.searches.filter(s => s.run === 1 && !s.error && entries.some(entry => entry.id === s.entry) && !raw.grades.some(g => done_(g) && g.entry === s.entry && g.query === s.query));
  const byId = new Map(queries.map(query => [query.id, query]));
  let done = 0;
  await pool(shuffle(lists), 6, async list => {
    const query = byId.get(list.query)!;
    const results = list.results ?? [];
    if (!results.length) { raw.grades.push({ entry: list.entry, query: list.query, scores: [], overall: 1, note: "no results", cost: 0, judge: JUDGE_VERSION, ...(chars ? { chars } : {}) }); return; }
    const schema = { type: "object", additionalProperties: false, required: ["scores", "overall", "note"], properties: {
      scores: { type: "array", items: { type: "integer", enum: [0, 1, 2, 3] }, description: `One grade per result, in order (${results.length})` },
      overall: { type: "integer", enum: [1, 2, 3, 4, 5] }, note: { type: "string", description: "One short sentence on the list's main strength or failure" },
    } };
    const { value, cost } = await structured<{ scores: number[]; overall: number; note: string }>(JUDGE_SYSTEM, `Query: ${query.query}\n\nResults (${results.length}):\n\n${render(results, chars ?? JUDGE_CHARS)}`, schema);
    raw.grades.push({ entry: list.entry, query: list.query, scores: value.scores.slice(0, results.length), overall: value.overall, note: value.note, cost, judge: JUDGE_VERSION, ...(chars ? { chars } : {}) });
    if (++done % 20 === 0) { save(); console.log(`judged ${done}/${lists.length}, spent so far $${spent.toFixed(3)}`); }
  });
  save();
}

const ANSWER_SYSTEM = `Answer the question using ONLY the search results given, not your own knowledge. Today is ${TODAY}. Be brief: the answer itself, then at most one sentence. If the results do not contain the answer, reply exactly NOT FOUND.`;
const GRADE_SYSTEM = `You check an answer against the expected answer. Reply "correct" if it gives the expected answer (following the notes on what counts), "not_found" if it says it could not find the answer, else "incorrect".`;

async function answerPhase() {
  const known = queries.filter(query => query.expected);
  const jobs = raw.searches.filter(s => s.run === 1 && entries.some(entry => entry.id === s.entry) && known.some(query => query.id === s.query))
    .flatMap(s => (Object.keys(ANSWER) as (keyof typeof ANSWER)[]).map(variant => ({ search: s, variant })))
    .filter(({ search, variant }) => !raw.answers.some(a => a.entry === search.entry && a.query === search.query && a.variant === variant));
  await pool(shuffle(jobs), 6, async ({ search, variant }) => {
    const query = known.find(q => q.id === search.query)!;
    const results = search.results ?? [];
    let answer = "NOT FOUND", spend = 0;
    if (results.length) {
      const context = render(results, ANSWER[variant].perResult, ANSWER[variant].total);
      const { value, cost } = await structured<{ answer: string }>(ANSWER_SYSTEM, `Search results:\n\n${context}\n\nQuestion: ${query.query}`,
        { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } }, 400);
      answer = value.answer; spend += cost;
    }
    const { value: grade, cost } = await structured<{ verdict: Answer["verdict"]; reason: string }>(GRADE_SYSTEM,
      `Question: ${query.query}\nExpected: ${query.expected}\nNotes: ${query.accept ?? ""}\nAnswer: ${answer}`,
      { type: "object", additionalProperties: false, required: ["verdict", "reason"], properties: { verdict: { type: "string", enum: ["correct", "incorrect", "not_found"] }, reason: { type: "string" } } }, 300);
    raw.answers.push({ entry: search.entry, query: search.query, variant, answer, verdict: grade.verdict, reason: grade.reason, cost: spend + cost });
  });
  save();
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await work(item); } catch (error) { console.log(`failed: ${scrub(String(error)).slice(0, 200)}`); }
    }
  }));
}

// ---- The report's tables.

const percentile = (values: number[], p: number) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const fmt = (value: number, digits = 2) => Number.isNaN(value) ? "–" : value.toFixed(digits);
const pct = (value: number) => Number.isNaN(value) ? "–" : `${Math.round(value * 100)}%`;

function summarize() {
  const ids = [...new Set(raw.searches.map(s => s.entry))].filter(id => ENTRIES.some(entry => entry.id === id));
  const categories = [...new Set(queries.map(query => query.category))];
  const category = new Map(queries.map(query => [query.id, query.category]));
  const lines: string[] = [];
  const row = (cells: (string | number)[]) => lines.push(`| ${cells.join(" | ")} |`);
  const stats = ids.map(id => {
    const mine = raw.searches.filter(s => s.entry === id && s.run !== "fresh");
    const ok = mine.filter(s => !s.error);
    const first = ok.filter(s => s.run === 1).map(s => s.latencyMs), second = ok.filter(s => s.run === 2).map(s => s.latencyMs), all = ok.map(s => s.latencyMs);
    const grades = raw.grades.filter(g => graded(g) && g.entry === id);
    const equal = raw.grades.filter(g => g.chars === EQUAL_CHARS && g.judge === JUDGE_VERSION && g.entry === id).map(g => g.scores.reduce((a, b) => a + b, 0) / (3 * COUNT));
    const earlier = raw.grades.filter(g => !graded(g) && g.chars === undefined && g.entry === id).map(g => g.scores.reduce((a, b) => a + b, 0) / (3 * COUNT));
    // Relevance@5: the five slots' grades over 15, a missing result counting 0; and the mean grade of results returned.
    const at5 = grades.map(g => g.scores.reduce((a, b) => a + b, 0) / (3 * COUNT));
    const perResult = grades.flatMap(g => g.scores);
    const answers = (variant: keyof typeof ANSWER) => raw.answers.filter(a => a.entry === id && a.variant === variant);
    const accuracy = (variant: keyof typeof ANSWER) => { const list = answers(variant); return list.length ? list.filter(a => a.verdict === "correct").length / list.length : NaN; };
    const news = raw.searches.filter(s => s.entry === id && s.run === 1 && category.get(s.query) === "news" && !s.error).flatMap(s => s.results ?? []);
    const freshNews = raw.searches.filter(s => s.entry === id && s.run === "fresh" && !s.error);
    const freshResults = freshNews.flatMap(s => s.results ?? []);
    const isFresh = (result: SearchResult) => !!result.date && /^\d{4}-\d{2}-\d{2}$/.test(result.date) && result.date >= FRESH_SINCE;
    return {
      id, calls: mine.length, errors: mine.length - ok.length, slow: ok.filter(s => s.latencyMs > PRODUCT_TIMEOUT_MS).length,
      p50: percentile(all, 50), p95: percentile(all, 95), p50first: percentile(first, 50), p50second: percentile(second, 50), p95first: percentile(first, 95), p95second: percentile(second, 95),
      cost: mean(ok.map(s => s.cost)), count: mean(ok.map(s => s.count)),
      relevance: mean(at5), earlierRelevance: mean(earlier), equalRelevance: mean(equal), equalCount: equal.length, perResult: mean(perResult), overall: mean(grades.map(g => g.overall)),
      native: accuracy("native"), equalized: accuracy("equalized"), answered: answers("native").length,
      fresh: news.length ? news.filter(isFresh).length / news.length : NaN, dated: news.length ? news.filter(r => r.date).length / news.length : NaN,
      freshParam: freshResults.length ? freshResults.filter(isFresh).length / freshResults.length : NaN, freshParamCount: mean(freshNews.map(s => s.count)),
      byCategory: Object.fromEntries(categories.map(c => [c, mean(grades.filter(g => category.get(g.query) === c).map(g => g.scores.reduce((a, b) => a + b, 0) / (3 * COUNT)))])),
    };
  });
  lines.push(`Generated ${new Date().toISOString()} from ${raw.searches.length} searches, ${raw.grades.filter(graded).length} lists graded by judge prompt v${JUDGE_VERSION}, ${raw.answers.length} graded answers.`, "");
  lines.push("### Summary", "");
  row(["entry", "p50 ms", "p95 ms", "errors", ">15 s", "results", "$/query", "relevance@5", "mean grade (0-3)", "list 1-5", "answer acc. (native)", "answer acc. (equal)", "news fresh ≤7d", "news fresh w/ freshness=week"]);
  row(Array(14).fill("---"));
  for (const s of stats) row([s.id, fmt(s.p50, 0), fmt(s.p95, 0), `${s.errors}/${s.calls}`, s.slow, fmt(s.count, 1), `$${s.cost.toFixed(4)}`, fmt(s.relevance), fmt(s.perResult), fmt(s.overall), `${pct(s.native)} (n=${s.answered})`, pct(s.equalized), `${pct(s.fresh)} (dated ${pct(s.dated)})`, `${pct(s.freshParam)} (${fmt(s.freshParamCount, 1)} results)`]);
  lines.push("", "### Latency, first vs second run (ms)", "");
  row(["entry", "p50 first", "p50 second", "p95 first", "p95 second"]); row(Array(5).fill("---"));
  for (const s of stats) row([s.id, fmt(s.p50first, 0), fmt(s.p50second, 0), fmt(s.p95first, 0), fmt(s.p95second, 0)]);
  lines.push("", "### Relevance@5 by category", "");
  row(["entry", ...categories.map(c => `${c} (n=${queries.filter(q => q.category === c).length})`)]); row(Array(categories.length + 1).fill("---"));
  for (const s of stats) row([s.id, ...categories.map(c => fmt(s.byCategory[c]))]);
  if (stats.some(s => !Number.isNaN(s.earlierRelevance))) {
    lines.push("", "### Relevance@5 under earlier judge prompts", "");
    row(["entry", `v${JUDGE_VERSION} (current)`, "earlier"]); row(Array(3).fill("---"));
    for (const s of stats) row([s.id, fmt(s.relevance), fmt(s.earlierRelevance)]);
  }
  if (stats.some(s => s.equalCount)) {
    lines.push("", `### Relevance@5 with every result's text cut to ${EQUAL_CHARS} characters`, "");
    row(["entry", "lists", `${EQUAL_CHARS} chars`, `${JUDGE_CHARS} chars (main)`]); row(Array(4).fill("---"));
    for (const s of stats.filter(s => s.equalCount)) row([s.id, s.equalCount, fmt(s.equalRelevance), fmt(s.relevance)]);
  }
  lines.push("", "### Known-answer questions (native context)", "");
  const known = queries.filter(query => query.expected);
  row(["query", "expected", ...ids]); row(Array(ids.length + 2).fill("---"));
  for (const query of known) row([`${query.id}${query.changed ? "*" : ""} ${query.query}`, query.expected!, ...ids.map(id => {
    const answer = raw.answers.find(a => a.entry === id && a.query === query.id && a.variant === "native");
    return answer ? ({ correct: "✓", incorrect: "✗", not_found: "–" } as const)[answer.verdict] : "";
  })]);
  lines.push("", "\\* the answer changed in 2026.", "", "### Spend", "");
  const searchSpend = Object.fromEntries(ids.map(id => [id, raw.searches.filter(s => s.entry === id).reduce((a, s) => a + s.cost, 0)]));
  const judgeSpend = raw.grades.reduce((a, g) => a + g.cost, 0), answerSpend = raw.answers.reduce((a, g) => a + g.cost, 0);
  for (const id of ids) lines.push(`- ${id}: $${searchSpend[id].toFixed(3)} over ${raw.searches.filter(s => s.entry === id).length} searches`);
  lines.push(`- judge (${JUDGE_MODEL}): $${judgeSpend.toFixed(3)} relevance, $${answerSpend.toFixed(3)} answering and grading`);
  lines.push(`- total: $${(Object.values(searchSpend).reduce((a, b) => a + b, 0) + judgeSpend + answerSpend).toFixed(2)}`);
  return lines.join("\n") + "\n";
}

function estimate() {
  const news = queries.filter(query => query.category === "news").length, known = queries.filter(query => query.expected).length;
  const searches = queries.length * 2 + news;
  const perSearch: Record<string, number> = { "exa-auto": 0.007, "exa-instant": 0.007, "parallel-advanced": 0.005, "parallel-fast": 0.001, firecrawl: 2 * FIRECRAWL_CREDIT, "firecrawl-scrape": 7 * FIRECRAWL_CREDIT, brave: 0.005 };
  const searchCost = entries.reduce((sum, entry) => sum + searches * perSearch[entry.id], 0);
  // Judge ~1.4k tokens in, 150 out per list; answers ~2.4k in (native) or 0.7k (equalized), each plus a ~250-token grade.
  const judge = entries.length * queries.length * (1_400 * JUDGE_PRICE.input + 150 * JUDGE_PRICE.output);
  const answer = entries.length * known * ((2_400 + 700) * JUDGE_PRICE.input + 2 * 60 * JUDGE_PRICE.output + 2 * (250 * JUDGE_PRICE.input + 60 * JUDGE_PRICE.output));
  console.log(`Entries: ${entries.map(entry => entry.id).join(", ")}${skipped.length ? ` (no key, skipped: ${skipped.map(entry => entry.id).join(", ")})` : ""}`);
  console.log(`Estimated spend: searches $${searchCost.toFixed(2)} (${searches} per entry), judge $${judge.toFixed(2)}, answers $${answer.toFixed(2)}; total ≈ $${(searchCost + judge + answer).toFixed(2)}`);
}

estimate();
if (!dryRun) {
  if (phase === "search" || phase === "all") await searchPhase();
  if (phase === "judge" || phase === "all") await judgePhase();
  if (phase === "judge-equal") await judgePhase(EQUAL_CHARS);
  if (phase === "answer" || phase === "all") await answerPhase();
  writeFileSync(SUMMARY, summarize());
  console.log(`Spent this run ≈ $${spent.toFixed(3)}; summary in ${SUMMARY}`);
}

# Web search provider benchmark (2026-09-25)

Which API should back the `web_search` built-in by default, and which should it fall back to? I ran 43 agent-style queries through seven provider configurations, twice each. A judge model graded every result list blind, all in one batch, and 16 known-answer questions were answered using only each provider's results. The tables here come from `results/summary.md`, which `scripts/bench-search.ts` generates from `results/raw.json` (not committed: it holds the providers' copies of third-party pages).

> **Adopted:** the order Exa (instant), Brave, Parallel (fast) is now `web_search`'s default, with per-provider prices and fallback (docs/guides/tools.md, "Built-ins a definition enables"). Firecrawl renders JavaScript-only pages for `web_fetch` instead of searching. The "before switching" items below are done.

## Recommendation

- **Default: Exa, `type: "instant"`.** It had the best relevance (0.87 relevance@5, 4.88/5 list usefulness) and no errors. Its first-run latency was p50 565 ms and p95 1.0 s. News freshness was 80% of results dated within 7 days, and 100% with `freshness: "week"`. It answered 16/16 known-answer questions. Its results also carry query-focused highlights, up to 3k characters per result, so an agent can often answer without calling web_fetch. Its relevance matched Exa's default `auto` mode (0.86) at half the latency, and both cost the same.
- **Fallback 1: Brave.** This is the existing provider, and it was the clear runner-up. It had 0.78 relevance, the tightest latency (p50 507 ms, p95 749 ms), no errors, and dates on every news result (78% within 7 days, 100% with the filter). It answered 16/16 and costs $5 per 1k. Its index is independent of Exa's: only 13% of their URLs overlapped.
- **Fallback 2: Parallel, `mode: "fast"`.** It costs $1 per 1k and returns dated excerpts, with a working date filter and no errors. Relevance was lower at 0.72, and weakest on technical and long-tail queries.
- **Not recommended:**
  - **Parallel `advanced`:** 0.76 relevance, but p50 3.3 s.
  - **Firecrawl:** 0.73 relevance, but its web results never carry a date, and it returned one 502.
  - **Firecrawl with `scrape`:** 0.68 relevance, about 4x the cost, p95 10 s, and 2 calls over the 15 s product timeout.

**Exa vs Brave is the closest call.** As returned, Exa leads Brave by 0.09. But Brave's snippets average about 225 characters, while the judge saw 700 characters of Exa's highlights. When every result's text was cut to 300 characters, Exa still led, but only by 0.04 (0.84 vs 0.80), which is about the noise level at this sample size. What Exa is really buying is somewhat better ranking plus much richer inline text, for $2 more per 1k searches. If cost or the current price matters more, Brave is a sound default: it is already the product default, its list price matches `pricing.webSearch`, and it had the best tail latency. In that case Exa would move to the fallback. Brave's `extra_snippets` option, not tested here, might close some of the text gap.

Two things need to happen before switching to Exa:
1. **Raise the platform price.** `pricing.webSearch` defaults to $0.005 (Brave's price), but Exa costs $0.007. `AGENT_PRICE_WEB_SEARCH_USD` needs to be at least 0.007.
2. **Make the providers selectable.** Exa, Parallel and Firecrawl implement `SearchProvider` (`src/web-search.ts`), but `SEARCH_PROVIDERS` and `AGENT_WEB_SEARCH_PROVIDER` still offer only Brave. Selection and fallback are the follow-up. That follow-up should also decide whether `content` (inline page text) goes to the model.

## Summary

Latency is wall time from this machine (US, residential). The "first" run is each query's first call. Exa caches repeated queries (its second-run p50 was about 90 ms), so first-run numbers are the realistic ones for an agent. Cost uses each provider's published price (sources below). Relevance@5 is the sum of the five result grades (0-3 each) divided by 15, with a missing result counting 0.

| entry | p50 first / second (ms) | p95 first / second (ms) | errors | $/query | relevance@5 | mean grade 0-3 | list 1-5 | answer acc. (native / equalized) | news ≤7 d (dated) | news ≤7 d with `freshness: week` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **exa-instant** | 565 / 90 | 1038 / 210 | 0/86 | $0.0070 | **0.87** | 2.61 | 4.88 | 100% / 100% | 80% (85%) | 100% |
| exa-auto | 1304 / 89 | 2325 / 236 | 0/86 | $0.0070 | 0.86 | 2.58 | 4.88 | 100% / 100% | 75% (83%) | 100% |
| **brave** | 507 / 120 | 749 / 369 | 0/86 | $0.0050 | 0.78 | 2.35 | 4.30 | 100% / 100% | 78% (100%) | 100% |
| parallel-advanced | 3329 / 1915 | 5417 / 3467 | 0/86 | $0.0050 | 0.76 | 2.27 | 4.33 | 94% / 94% | 65% (80%) | 74% |
| firecrawl | 964 / 548 | 1637 / 1041 | 1/86 | $0.0017* | 0.73 | 2.19 | 4.12 | 94% / 94% | 0% (0% dated) | 0% (undated) |
| parallel-fast | 829 / 744 | 1376 / 1106 | 0/86 | $0.0010 | 0.72 | 2.17 | 4.00 | 94% / 100% | 53% (83%) | 73% |
| firecrawl-scrape | 3600 / 1065 | 10162 / 2055 | 0/86 (2 over 15 s) | $0.0064* | 0.68 | 2.04 | 4.02 | 100% / 88% | 23% (35%) | 38% |

\* Firecrawl bills plan credits: 2 per search of up to 10 results, plus 1 per scraped page. Costs here use the Standard plan ($83/month billed annually for 100k credits = $0.00083 per credit). At Hobby rates ($16 for 5k) the costs are about 4x higher.

Every configuration returned 5 results per query. The one exception was Parallel advanced, which averaged 4.9 with the date filter on.

### Equal-length check

This is the same blind judge, but with every result's text cut to 300 characters, about the length of a Brave snippet. It separates ranking from how much text each provider returns.

| entry | relevance@5, 300 chars | relevance@5, as returned (700 chars) |
| --- | --- | --- |
| exa-instant | 0.84 | 0.87 |
| brave | 0.80 | 0.78 |
| parallel-fast | 0.69 | 0.72 |

### How much excerpt text to return

This check came after the routing was adopted. It uses the same blind judge (prompt v2) and the cached first-run results, with each result's text cut to a length and the list's to 6,000 characters. The cached page text was stored at up to 1,600 characters per result, so a 1,500-character view is a true one.

| entry | 300 chars | 700 chars (main) | 1,000 chars, 6,000 total | 1,500 chars, 6,000 total |
| --- | --- | --- | --- | --- |
| exa-instant | 0.84 | 0.87 | 0.87 | 0.85 |
| parallel-fast | 0.69 | 0.72 | – | 0.72 |

More text stops helping at about 700-1,000 characters, and 1,500 gained nothing (0.85 is within the noise). Answer accuracy can't separate these settings either: Exa was 100% with both 300 and 1,600 characters. So `web_search` returns excerpts of up to 1,000 characters each, 6,000 across a search. This check cost $0.88.

### Relevance@5 by category

| entry | known (16) | news (8) | technical (6) | research (5) | pricing (4) | long-tail (4) |
| --- | --- | --- | --- | --- | --- | --- |
| exa-instant | 0.88 | 0.96 | 0.83 | 0.80 | 0.78 | 0.88 |
| exa-auto | 0.86 | 0.93 | 0.81 | 0.83 | 0.83 | 0.87 |
| brave | 0.74 | 0.92 | 0.78 | 0.76 | 0.77 | 0.73 |
| parallel-advanced | 0.73 | 0.83 | 0.80 | 0.75 | 0.68 | 0.73 |
| firecrawl | 0.73 | 0.75 | 0.73 | 0.72 | 0.73 | 0.67 |
| parallel-fast | 0.73 | 0.78 | 0.64 | 0.75 | 0.80 | 0.60 |
| firecrawl-scrape | 0.70 | 0.70 | 0.69 | 0.65 | 0.65 | 0.58 |

One of the two Exa modes led every category. Brave was close to Exa on news (0.92) and technical docs (0.78), and furthest behind on known-answer queries (0.74), where its short snippets often don't contain the fact. Parallel fast was weakest on technical and long-tail queries: it returned generic zsh man pages for the `(j:,:)` join flag, and version-listing pages for `uuidv7()`.

The providers mostly find different pages. For the same query, Brave shared 13% of its URLs with Exa instant, 36% with Firecrawl and 30% with Parallel advanced. Exa auto shared 24% with Firecrawl and 21% with Parallel advanced. Exa's two modes shared 49%, and Parallel's two modes 20%. Firecrawl with and without scraping shared 97%: the same search, with different text shown.

## What was measured

- **Queries** (`queries.json`, 43 in total). There are 16 known-answer questions: 12 whose answer changed in 2026 (Fed and BoJ rate decisions, the UK PM, the Fed chair, the latest Rust, Python and Node releases, whether PostgreSQL 19 has shipped, and so on), plus Spanish and German questions. The rest are 8 news queries from the past week (one in Japanese), 6 technical/API-docs queries, 5 research queries, 4 product/pricing queries and 4 long-tail queries. They mix natural-language and keyword styles. Expected answers were checked against primary sources on 2026-09-25.
- **Searches.** Each configuration ran each query twice (5 results each time), then ran the 8 news queries once more with `freshness: "week"`. Configurations ran side by side, each working through its queries one at a time. Brave ran about an hour after the others, on the same queries. Requests came from the provider classes in `src/web-search.ts`, so the benchmark exercised the product's own request building and normalization. They were sent with plain `fetch` and a 30 s timeout; calls over 15 s count as would-be timeouts in the product.
- **Relevance.** `claude-sonnet-5` (thinking off, structured output) graded each first-run list on a fixed rubric: 0-3 per result, plus 1-5 for the whole list's usefulness. The judge never saw the provider's name. Every list was rendered the same way (title, URL, date, and the first 700 characters of the page text the provider returned, or its snippet if it returned no page text). All 300 lists from all seven configurations were graded in a single shuffled batch, each in its own call, using judge prompt v2. v2 adds one sentence: results may report events from after the judge's training data, and the stated date should be taken as given. Grades from the first prompt (v1, six configurations) stay in `raw.json`. Relevance@5 moved by 0.02 at most between v1 and v2, and the order of configurations did not change.
- **Answerability.** For the 16 known-answer questions, `claude-sonnet-5` answered from each provider's results alone ("answer using ONLY the search results … else NOT FOUND"). There were two context budgets: *native*, up to 1,600 characters per result and 8,000 in total, and *equalized*, 300 characters per result for every provider. A second call graded each answer against the expected answer and notes on what counts.
- **Freshness.** Of the news-query results, the share dated on or after 2026-09-18. Undated results count as not fresh. The share that carried a date at all is in parentheses.
- **Spend.** $7.59 in total. Searches cost $2.62 before Brave (Exa $1.32, Parallel $0.56, and Firecrawl $0.74 in credits at Standard-plan prices), plus Brave $0.47. The judge cost $4.49: v1 relevance $1.31, v2 relevance for all configurations $1.50, the equal-length check $0.52, and answering and grading $1.16. The first round cost $4.97; adding Brave, the re-judge and the equal-length check cost $2.62 more.

### Pricing sources (read 2026-09-25)

- Exa (exa.ai/pricing): search is $7 per 1k requests of up to 10 results, in any of the `instant`, `fast` and `auto` modes. Each response's `costDollars` confirmed $0.007 per query, and highlights were not billed separately.
- Brave (brave.com/search/api): $5 per 1k requests, the price `pricing.webSearch` already uses.
- Parallel (parallel.ai/pricing): the Search API costs $1 per 1k requests in `turbo`/`fast` mode and $5 per 1k in `basic`/`advanced` mode, for 10 results.
- Firecrawl (firecrawl.dev/pricing, docs.firecrawl.dev/features/search): 2 credits per search of up to 10 results, plus 1 credit per scraped page. Plans run from Hobby ($16/month for 5k credits) to Standard ($83/month for 100k).

## Notable failures

- **Stale versions.** Asked for the latest Python, Firecrawl and Parallel advanced both surfaced a python.org page for 3.14.6 (June). The answer model then answered 3.14.6 in both context budgets. Exa, Brave and Parallel fast all found 3.14.7.
- **Wrong year.** Parallel fast's results for "When does the extended US-China trade truce expire?" said "January 10", and the answer model filled in 2026. The results were fine; the answer model made the mistake. This shows how much answer quality depends on dated excerpts.
- **Firecrawl has no dates.** Plain Firecrawl web results never carry a publication date. With scraping, 35% of news results had one, taken from page metadata. An agent can't tell stale results from fresh ones without fetching the page. Brave, by contrast, dated every news result.
- **Scraped text makes a worse excerpt.** Firecrawl with and without scraping returned 97% of the same URLs. The scraped markdown starts at the top of the page (navigation, bylines), whereas Firecrawl's description is a query-relevant highlight, and the judge scored the scraped version 0.05 lower. In the equalized (300-character) answer test, scraping missed the Node Current version (NOT FOUND) and misread the BoJ rate as 1.00%.
- **Slow tails.** Firecrawl with scraping had a first-run p95 of 10.2 s, and 2 of its 86 calls took over 15 s (15.2 s and 17.0 s, both first runs). Parallel advanced had a first-run p95 of 5.4 s. Neither Exa mode exceeded 2.4 s at p95, and Brave's p95 was 0.75 s.
- **Errors.** There was a single Firecrawl 502 Bad Gateway (query n02, first run). No errors in 94 calls each from Exa (both modes), Parallel (both modes) or Brave. Parallel's account was out of credit at the start (HTTP 402) and was topped up before its runs.

## Caveats

- **The sample is small.** 43 queries and 16 known-answer questions, each list graded once. Differences of about 0.03-0.04 in relevance@5 are within the noise. That covers Exa instant vs auto, Parallel fast vs Firecrawl, and Exa vs Brave once text length is equalized.
- **Answerability hit the ceiling.** 88-100% everywhere: these questions were easy to find, so the test mostly failed to separate providers. Its useful signal is in the failures listed above (stale or undated pages). A harder set with multi-hop and obscure facts would discriminate better.
- **The judge's knowledge cutoff still biases some grades.** Even with the v2 prompt, the judge sometimes calls correct post-cutoff facts or 2026 arXiv IDs "suspicious" or "future-dated". About 20 of 300 v2 notes mention this, spread across all providers. The worst v1 case (Firecrawl's Kevin Warsh results, all 1s) rose to 10/15 under v2. The overall numbers moved by 0.02 at most.
- **The judge sees what each provider returns.** Exa and Parallel return query-focused excerpts (the judge saw the first 700 characters), Brave returns short snippets, and Firecrawl returns highlights. The equal-length check above shows that about half of Exa's lead over Brave comes from longer text. Exa's lead over Parallel does not: Parallel also returns long excerpts and scored well below it.
- **Freshness depends on dates the provider reports.** Undated results count as not fresh. That understates Firecrawl in particular, whose date-filtered results are probably recent but can't be checked from the response. Brave can return relative dates ("2 days ago"), which would count as undated; none of its results in this run had one.
- **One location, one day, one account per provider.** No rate-limit or throughput testing. Exa's and Brave's caches make repeated queries fast, which flatters their second-run numbers. Latency was measured from a client far from the product's servers; absolute numbers will shift, but the ordering should hold.
- **Normalization changed during the run.** Markdown links in snippets and page text are now reduced to their text (`unlink` in `src/web-search.ts`). Exa and Firecrawl results recorded before that change had the same transformation applied afterwards, so a few of their excerpts are slightly shorter than the cap. Parallel and Brave were recorded after the change.

## Reproducing

```sh
# keys in the environment only: EXA_API_KEY, PARALLEL_API_KEY, FIRECRAWL_API_KEY, BRAVE_API_KEY, ANTHROPIC_API_KEY
npm run bench:search -- --dry-run                                # entries with a key, and the spend estimate
npm run bench:search -- --entries exa-instant,brave              # search, judge, answer; resumes from results/raw.json
npm run bench:search -- --phase judge-equal --entries exa-instant,brave   # the equal-length check
npm run bench:search -- --phase report                           # just regenerate results/summary.md
```

`results/raw.json` (kept locally, not committed) holds every call: latency, status, errors (with keys scrubbed), cost, and the normalized first-run results with page text capped at 1,600 characters. It also holds every grade (v1, v2 and the equal-length check) and every answer.

# Web search provider benchmark (2026-09-25)

Which API should back the `web_search` built-in by default, and which should it fall back to? I ran 43 agent-style queries through six provider configurations, twice each. A judge model graded each result list blind, and 16 known-answer questions were answered using only each provider's results. The tables here come from `results/summary.md`, which `scripts/bench-search.ts` generates from `results/raw.json`. Brave was not measured because no `BRAVE_API_KEY` was available.

## Recommendation

- **Default: Exa, `type: "instant"`.** It had the best relevance of any configuration (0.87 relevance@5, 4.91/5 list usefulness), the fastest first-run latency (p50 565 ms, p95 1.0 s), no errors, and 5 results every time. News freshness was the best measured: 80% of news results were dated within 7 days, and 100% were with `freshness: "week"`. It answered all 16 known-answer questions. Its relevance matched Exa's default `auto` mode (0.85, inside the noise) at half the latency, and both cost the same, so `instant` is the better default. At $7 per 1k searches it is not the cheapest option.
- **Fallback 1: Parallel, `mode: "fast"`.** It costs $1 per 1k (the cheapest measured), runs at p50 829 ms, and had no errors. Its results are dated (83%), its date filter works, and it returns query-focused excerpts. Relevance was 0.72. It runs on infrastructure independent of Exa's, which matters for a fallback. Parallel `advanced` was a little more relevant (0.76) but 4x slower (p50 3.3 s, p95 5.4 s) and 5x the price, so it doesn't earn a place in the fallback chain.
- **Fallback 2: Firecrawl search, without scraping.** Relevance 0.73, p50 964 ms, $1.66 per 1k at Standard-plan credit prices (about $6.40 per 1k at Hobby rates, since credits are prepaid by plan). Web results carry **no dates**, so freshness can't be checked and a date filter (`tbs`) can't be verified from the answer. It returned one 502 in 86 calls. **Don't use `scrape`.** It adds 5 credits per query (about 4x the cost) and raises p50 to 3.6 s and p95 to 10 s (two calls took over 15 s, the product timeout). Relevance did not improve: the judge scored it lower, because page-top markdown is a worse excerpt than Firecrawl's own highlight.

Two things need to happen before switching:
1. **The platform search price is below Exa's cost.** `pricing.webSearch` defaults to $0.005, Brave's list price, but Exa charges $0.007. `AGENT_PRICE_WEB_SEARCH_USD` needs to be at least 0.007, or the default should be Parallel fast, whose relevance and freshness were clearly lower.
2. **The providers can't be selected yet.** Exa, Parallel and Firecrawl implement `SearchProvider` (`src/web-search.ts`), but `SEARCH_PROVIDERS` and `AGENT_WEB_SEARCH_PROVIDER` still offer only Brave. Selection and fallback are the follow-up. That follow-up also needs to decide whether `content` (inline page text) goes to the model: it is up to 3k characters per result, against a 500-character snippet.

## Summary

Latency is wall time from this machine (US, residential). The "first" run is each query's first call. Exa caches repeated queries (its second-run p50 was about 90 ms), so first-run numbers are the realistic ones for an agent. Cost uses each provider's published price (sources below). Relevance@5 is the sum of the five result grades (0-3 each) divided by 15, with a missing result counting 0.

| entry | p50 first / second (ms) | p95 first / second (ms) | errors | $/query | relevance@5 | mean grade 0-3 | list 1-5 | answer acc. (native / equalized) | news ≤7 d (dated) | news ≤7 d with `freshness: week` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **exa-instant** | 565 / 90 | 1038 / 210 | 0/86 | $0.0070 | **0.87** | 2.61 | 4.91 | 100% / 100% | 80% (85%) | 100% |
| exa-auto | 1304 / 89 | 2325 / 236 | 0/86 | $0.0070 | 0.85 | 2.56 | 4.86 | 100% / 100% | 75% (83%) | 100% |
| parallel-advanced | 3329 / 1915 | 5417 / 3467 | 0/86 | $0.0050 | 0.76 | 2.29 | 4.35 | 94% / 94% | 65% (80%) | 74% |
| firecrawl | 964 / 548 | 1637 / 1041 | 1/86 | $0.0017* | 0.73 | 2.19 | 4.14 | 94% / 94% | 0% (0% dated) | 0% (undated) |
| parallel-fast | 829 / 744 | 1376 / 1106 | 0/86 | $0.0010 | 0.72 | 2.17 | 3.98 | 94% / 100% | 53% (83%) | 73% |
| firecrawl-scrape | 3600 / 1065 | 10162 / 2055 | 0/86 (2 over 15 s) | $0.0064* | 0.66 | 2.00 | 4.02 | 100% / 88% | 23% (35%) | 38% |

\* Firecrawl bills plan credits: 2 per search of up to 10 results, plus 1 per scraped page. Costs here use the Standard plan ($83/month billed annually for 100k credits = $0.00083 per credit). At Hobby rates ($16 for 5k) the costs are about 4x higher.

Every configuration returned 5 results per query. The one exception was Parallel advanced, which averaged 4.9 with the date filter on.

### Relevance@5 by category

| entry | known (16) | news (8) | technical (6) | research (5) | pricing (4) | long-tail (4) |
| --- | --- | --- | --- | --- | --- | --- |
| exa-instant | 0.88 | 0.95 | 0.81 | 0.81 | 0.85 | 0.88 |
| exa-auto | 0.84 | 0.96 | 0.81 | 0.79 | 0.83 | 0.87 |
| parallel-advanced | 0.73 | 0.85 | 0.79 | 0.79 | 0.65 | 0.75 |
| firecrawl | 0.72 | 0.80 | 0.73 | 0.73 | 0.72 | 0.67 |
| parallel-fast | 0.72 | 0.83 | 0.59 | 0.76 | 0.80 | 0.60 |
| firecrawl-scrape | 0.67 | 0.68 | 0.64 | 0.69 | 0.65 | 0.60 |

Exa led in every category. Parallel fast was weakest on technical and long-tail queries: it returned generic zsh man pages for the `(j:,:)` join flag, and version-listing pages for `uuidv7()`. Parallel advanced closed most of that gap, except on pricing pages.

The three providers mostly find different pages. For the same query, Exa auto and Firecrawl shared 24% of their URLs, and Exa auto and Parallel advanced shared 21%. Exa's two modes shared 49%, and Parallel's two modes only 20%. Firecrawl with and without scraping shared 97%: the same search, with different text shown.

## What was measured

- **Queries** (`queries.json`, 43 in total). There are 16 known-answer questions: 12 whose answer changed in 2026 (Fed and BoJ rate decisions, the UK PM, the Fed chair, the latest Rust, Python and Node releases, whether PostgreSQL 19 has shipped, and so on), plus Spanish and German questions. The rest are 8 news queries from the past week (one in Japanese), 6 technical/API-docs queries, 5 research queries, 4 product/pricing queries and 4 long-tail queries. They mix natural-language and keyword styles. Expected answers were checked against primary sources on 2026-09-25.
- **Searches.** Each configuration ran each query twice (5 results each time), then ran the 8 news queries once more with `freshness: "week"`. Configurations ran side by side, each working through its queries one at a time. Requests came from the provider classes in `src/web-search.ts`, so the benchmark exercised the product's own request building and normalization. They were sent with plain `fetch` and a 30 s timeout; calls over 15 s count as would-be timeouts in the product.
- **Relevance.** `claude-sonnet-5` (thinking off, structured output) graded each first-run list on a fixed rubric: 0-3 per result, plus 1-5 for the whole list's usefulness. The judge never saw the provider's name. Every list was rendered the same way (title, URL, date, and the first 700 characters of the page text the provider returned, or its snippet if it returned no page text). Each list was graded in its own call, and the calls ran in random order.
- **Answerability.** For the 16 known-answer questions, `claude-sonnet-5` answered from each provider's results alone ("answer using ONLY the search results … else NOT FOUND"). There were two context budgets: *native*, up to 1,600 characters per result and 8,000 in total, and *equalized*, 300 characters per result for every provider. A second call graded each answer against the expected answer and notes on what counts.
- **Freshness.** Of the news-query results, the share dated on or after 2026-09-18. Undated results count as not fresh. The share that carried a date at all is in parentheses.
- **Spend.** $4.97 in total: Exa $1.32, Parallel $0.56, Firecrawl $0.74 in credits at Standard-plan prices, and the judge $2.34 ($1.31 relevance, $1.03 answering and grading). Probing the APIs by hand added about $0.05. The estimate printed before the runs was $4.61; the judge went over it.

### Pricing sources (read 2026-09-25)

- Exa (exa.ai/pricing): search is $7 per 1k requests of up to 10 results, in any of the `instant`, `fast` and `auto` modes. Each response's `costDollars` confirmed $0.007 per query, and highlights were not billed separately.
- Parallel (parallel.ai/pricing): the Search API costs $1 per 1k requests in `turbo`/`fast` mode and $5 per 1k in `basic`/`advanced` mode, for 10 results.
- Firecrawl (firecrawl.dev/pricing, docs.firecrawl.dev/features/search): 2 credits per search of up to 10 results, plus 1 credit per scraped page. Plans run from Hobby ($16/month for 5k credits) to Standard ($83/month for 100k).

## Notable failures

- **Stale versions.** Asked for the latest Python, Firecrawl and Parallel advanced both surfaced a python.org page for 3.14.6 (June). The answer model then answered 3.14.6 in both context budgets. Both Exa modes and Parallel fast found 3.14.7.
- **Wrong year.** Parallel fast's results for "When does the extended US-China trade truce expire?" said "January 10", and the answer model filled in 2026. The results were fine; the answer model made the mistake. This shows how much answer quality depends on dated excerpts.
- **Firecrawl has no dates.** Plain Firecrawl web results never carry a publication date. With scraping, 35% of news results had one, taken from page metadata. An agent can't tell stale results from fresh ones without fetching the page.
- **Scraped text makes a worse excerpt.** Firecrawl with and without scraping returned 97% of the same URLs. The scraped markdown starts at the top of the page (navigation, bylines), whereas Firecrawl's description is a query-relevant highlight, and the judge scored the scraped version 0.07 lower. In the equalized (300-character) answer test, scraping missed the Node Current version (NOT FOUND) and misread the BoJ rate as 1.00%.
- **Slow tails.** Firecrawl with scraping had a first-run p95 of 10.2 s, and 2 of its 86 calls took over 15 s (15.2 s and 17.0 s, both first runs). Parallel advanced had a first-run p95 of 5.4 s. Neither Exa mode exceeded 2.4 s at p95.
- **Errors.** There was a single Firecrawl 502 Bad Gateway (query n02, first run). Exa and Parallel returned no errors in 188 calls each (94 per mode, across both modes). Parallel's account was out of credit at the start (HTTP 402) and was topped up before its runs.

## Caveats

- **The sample is small.** 43 queries and 16 known-answer questions, each list graded once. Differences of about 0.03 in relevance@5 (for example, Exa instant vs auto, or Parallel fast vs Firecrawl) are within the noise. Exa's overall lead (0.09 or more over every other configuration) is larger than that. By category it led everywhere, but only narrowly (0.02) on technical and research queries, where Parallel advanced came close.
- **Answerability hit the ceiling.** 88-100% everywhere: these questions were easy to find, so the test mostly failed to separate providers. Its useful signal is in the failures listed above (stale or undated pages). A harder set with multi-hop and obscure facts would discriminate better.
- **The judge's knowledge cutoff biased some grades.** The judge (training data up to mid-2026) sometimes marked correct post-cutoff facts as "fabricated". For example, it gave Firecrawl's Kevin Warsh results a 1 each ("Powell's term runs to May 2026"), and it flagged 2026 arXiv IDs as "future-dated". About ten of 258 notes show this, spread across providers. The biggest single effect, Firecrawl on k03, moves Firecrawl's mean by about 0.01. For future runs the judge prompt should say that results may describe events after its training data and that the stated date is authoritative.
- **The judge sees what each provider returns.** Exa and Parallel return query-focused excerpts (the judge saw the first 700 characters), while Firecrawl's highlight is usually shorter. The scrape vs no-scrape comparison (same URLs, 0.07 apart) shows the displayed text moves grades a little. The gaps between providers are larger than that, and Parallel returns excerpts like Exa's yet scored well below it.
- **Freshness depends on dates the provider reports.** Undated results count as not fresh. That understates Firecrawl in particular, whose date-filtered results are probably recent but can't be checked from the response.
- **One location, one day, one account per provider.** No rate-limit or throughput testing. Exa's cache makes repeated queries almost free in latency, which flatters its second-run numbers. Latency was measured from a client far from the product's servers; absolute numbers will shift, but the ordering should hold.
- **Normalization changed during the run.** Markdown links in snippets and page text are now reduced to their text (`unlink` in `src/web-search.ts`). Exa and Firecrawl results recorded before that change had the same transformation applied afterwards, so a few of their excerpts are slightly shorter than the cap. Parallel was recorded after the change.

## Reproducing

```sh
# keys in the environment only: EXA_API_KEY, PARALLEL_API_KEY, FIRECRAWL_API_KEY, [BRAVE_API_KEY], ANTHROPIC_API_KEY
npm run bench:search -- --dry-run                        # entries with a key, and the spend estimate
npm run bench:search -- --entries exa-instant,brave      # search, judge, answer; resumes from results/raw.json
npm run bench:search -- --phase report                   # just regenerate results/summary.md
```

`results/raw.json` holds every call: latency, status, errors (with keys scrubbed), cost, and the normalized first-run results with page text capped at 1,600 characters. It also holds every grade and answer.

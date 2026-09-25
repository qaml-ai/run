Generated 2026-09-25T19:23:00.785Z from 658 searches, 300 lists graded by judge prompt v2, 224 graded answers.

### Summary

| entry | p50 ms | p95 ms | errors | >15 s | results | $/query | relevance@5 | mean grade (0-3) | list 1-5 | answer acc. (native) | answer acc. (equal) | news fresh ≤7d | news fresh w/ freshness=week |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| exa-instant | 242 | 887 | 0/86 | 0 | 5.0 | $0.0070 | 0.87 | 2.61 | 4.88 | 100% (n=16) | 100% | 80% (dated 85%) | 100% (5.0 results) |
| firecrawl | 833 | 1525 | 1/86 | 0 | 5.0 | $0.0017 | 0.73 | 2.19 | 4.12 | 94% (n=16) | 94% | 0% (dated 0%) | 0% (5.0 results) |
| firecrawl-scrape | 1400 | 7598 | 0/86 | 2 | 5.0 | $0.0064 | 0.68 | 2.04 | 4.02 | 100% (n=16) | 88% | 23% (dated 35%) | 38% (5.0 results) |
| exa-auto | 240 | 2090 | 0/86 | 0 | 5.0 | $0.0070 | 0.86 | 2.58 | 4.88 | 100% (n=16) | 100% | 75% (dated 83%) | 100% (5.0 results) |
| parallel-fast | 785 | 1299 | 0/86 | 0 | 5.0 | $0.0010 | 0.72 | 2.17 | 4.00 | 94% (n=16) | 100% | 53% (dated 83%) | 73% (5.0 results) |
| parallel-advanced | 2553 | 5057 | 0/86 | 0 | 5.0 | $0.0050 | 0.76 | 2.27 | 4.33 | 94% (n=16) | 94% | 65% (dated 80%) | 74% (4.9 results) |
| brave | 447 | 682 | 0/86 | 0 | 5.0 | $0.0050 | 0.78 | 2.35 | 4.30 | 100% (n=16) | 100% | 78% (dated 100%) | 100% (5.0 results) |

### Latency, first vs second run (ms)

| entry | p50 first | p50 second | p95 first | p95 second |
| --- | --- | --- | --- | --- |
| exa-instant | 565 | 90 | 1038 | 210 |
| firecrawl | 964 | 548 | 1637 | 1041 |
| firecrawl-scrape | 3600 | 1065 | 10162 | 2055 |
| exa-auto | 1304 | 89 | 2325 | 236 |
| parallel-fast | 829 | 744 | 1376 | 1106 |
| parallel-advanced | 3329 | 1915 | 5417 | 3467 |
| brave | 507 | 120 | 749 | 369 |

### Relevance@5 by category

| entry | known (n=16) | news (n=8) | technical (n=6) | research (n=5) | pricing (n=4) | longtail (n=4) |
| --- | --- | --- | --- | --- | --- | --- |
| exa-instant | 0.88 | 0.96 | 0.83 | 0.80 | 0.78 | 0.88 |
| firecrawl | 0.73 | 0.75 | 0.73 | 0.72 | 0.73 | 0.67 |
| firecrawl-scrape | 0.70 | 0.70 | 0.69 | 0.65 | 0.65 | 0.58 |
| exa-auto | 0.86 | 0.93 | 0.81 | 0.83 | 0.83 | 0.87 |
| parallel-fast | 0.73 | 0.78 | 0.64 | 0.75 | 0.80 | 0.60 |
| parallel-advanced | 0.73 | 0.83 | 0.80 | 0.75 | 0.68 | 0.73 |
| brave | 0.74 | 0.92 | 0.78 | 0.76 | 0.77 | 0.73 |

### Relevance@5 under earlier judge prompts

| entry | v2 (current) | earlier |
| --- | --- | --- |
| exa-instant | 0.87 | 0.87 |
| firecrawl | 0.73 | 0.73 |
| firecrawl-scrape | 0.68 | 0.66 |
| exa-auto | 0.86 | 0.85 |
| parallel-fast | 0.72 | 0.72 |
| parallel-advanced | 0.76 | 0.76 |
| brave | 0.78 | – |

### Relevance@5 with every result's text cut to 300 characters

| entry | lists | 300 chars | 700 chars (main) |
| --- | --- | --- | --- |
| exa-instant | 43 | 0.84 | 0.87 |
| parallel-fast | 43 | 0.69 | 0.72 |
| brave | 43 | 0.80 | 0.78 |

### Known-answer questions (native context)

| query | expected | exa-instant | firecrawl | firecrawl-scrape | exa-auto | parallel-fast | parallel-advanced | brave |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| k01* What is the federal funds target range after the Fed's September 2026 meeting? | 3.75% to 4.00% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| k02* current UK prime minister | Andy Burnham | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| k03* Who is the chair of the Federal Reserve right now? | Kevin Warsh | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| k04* latest stable rust version | Rust 1.98.1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| k05* What is the latest stable release of Python? | Python 3.14.7 | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ |
| k06* Has PostgreSQL 19 been released yet? | No: PostgreSQL 19 is still in beta (Beta 4 on 2026-09-24, GA expected October 2026); the latest stable major version is 18 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| k07* node.js current release version | Node.js v26.10.0 (Current); v24.x is the active LTS | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| k08* Who won the 2026 FIFA World Cup? | Spain | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| k09* wimbledon 2026 mens singles winner | Jannik Sinner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| k10* How long was Harvey Weinstein sentenced to in September 2026? | 15 years in prison | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| k11* Bank of Japan policy rate after September 2026 meeting | 1.25% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| k12* When does the extended US-China trade truce now expire? | January 10, 2027 | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ |
| k13 mount everest official height meters | 8,848.86 m | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| k14 ¿Quién es la presidenta de México actualmente? | Claudia Sheinbaum | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| k15 Wie hoch ist die Zugspitze? | 2,962 m | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| k16 Which physicists won the 2025 Nobel Prize in Physics? | John Clarke, Michel H. Devoret and John M. Martinis | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

\* the answer changed in 2026.

### Spend

- exa-instant: $0.658 over 94 searches
- firecrawl: $0.154 over 94 searches
- firecrawl-scrape: $0.587 over 94 searches
- exa-auto: $0.658 over 94 searches
- parallel-fast: $0.094 over 94 searches
- parallel-advanced: $0.470 over 94 searches
- brave: $0.470 over 94 searches
- judge (claude-sonnet-5): $3.336 relevance, $1.158 answering and grading
- total: $7.59

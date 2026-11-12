# Results

Measured 2026-11-12 on `rt-pool` sprites (8 vCPU, 8 GB RAM, Fly kernel 6.12, ripgrep 15.1.0, git 2.53.0, Universal
Ctags 6.2.1) with `bench/run.sh`. Raw `RESULT` lines are in `bench/results/`. The per-query tables come from
`bench/table.py`. The `*-queries-rerun.log` files re-ran the query set after the path-glob fix (commit "basename literal
precheck") against the same stores.

Corpora:

| corpus | files | content | unique blobs | source |
|---|---|---|---|---|
| gen-small / medium / large | 200 / 5,000 / 50,000 | 1 / 50 / 501 MB | all | the `proto/artifacts-volumes` generator (35-word vocabulary: the worst case for trigrams) |
| Kubernetes | 31,760 | 283 MB | 24,437 | `kubernetes/kubernetes` @ c80effae, depth 1 |
| Linux | 97,362 | 1.68 GB | 96,612 | `torvalds/linux` @ ee838993, depth 1 |

## Headline numbers

| | Kubernetes | Linux |
|---|---|---|
| base index build (wall, 8 vCPU, from git objects) | **4.0 s** | **22.6 s** |
| … with the ctags symbol index | 8.5 s | 44.5 s |
| trigram index `.idx` | 37.5 MB (**13 %** of content) | 178 MB (**11 %**) |
| verification copy `.dat` (blobs ≤ 1 MiB, not compressed) | 244 MB | 1.19 GB |
| symbols `.sym` | 15.5 MB (5 %) | 185 MB (11 %) |
| path table | 3.0 MB | 6.4 MB |
| checkpoint, 1 file changed: index work (read + index) | **4.5 ms** | **3.6 ms** |
| checkpoint, 100 files changed: index work | **36 ms** (delta `.idx` 474 KB) | **38 ms** (743 KB) |
| … plus `git ls-tree` of the whole tree (prototype only, §notes) | +150–220 ms | +270–330 ms |
| 100 files with symbols (ctags) | 116 ms | 414 ms |
| fork | **0.3 ms** (a ref) | **0.2 ms** |
| fork + 1-file change: index work | 3.7 ms | 3.0 ms |
| open a snapshot view (warm page cache) | 21–31 ms | 54 ms |
| process heap with the snapshot open | 6–11 MB | 17–22 MB |
| query p50 / p99, literal | **21 / 57 ms** | **16 / 38 ms** |
| query p50 / p99, regex | **10 / 79 ms** | **32 / 506 ms** |
| query p50 / p99, filtered (path / file / lang + text) | **2.4 / 4.7 ms** | **12 / 24 ms** |
| query p50 / p99, path only | **2.4 / 12 ms** | **9.0 / 11 ms** |
| symbol lookup (exact / prefix) | 0.2–0.8 ms | 0.06–0.5 ms |
| HTTP round trip, warm (curl, `limit=20&context=2`) | 4–6 ms | 8–12 ms |
| ripgrep, warm page cache, same queries: p50 range | 145–490 ms | 320–1,010 ms |
| `git grep <commit>`, same queries: p50 range | 570–760 ms | 1,230–2,020 ms |
| first query, new process, page cache dropped | 1.95 s | 1.81 s |
| ripgrep, page cache dropped (local disk) | 8.0 s | 15.8 s |
| ripgrep over a **cold lazy mount** (camelfs, 20 ms/blob) | **72 s** | **262 s** |
| … with 32 prefetchers | 13.5 s | 59.8 s |
| … warm host blob cache, page cache dropped | 2.5 s | 13.9 s |

The query p50/p99 rows cover all queries of a class, 20 timed runs each after one warm-up run. Every query is in the
tables below. "Index work" is `readMs + indexMs`: reading the new blobs from git and building the delta shard. In
the file service the checkpoint writer already holds those bytes, and the diff, so that is the whole cost.

## Per query: camelsearch vs ripgrep vs git grep

`files` counts matching **blobs**: distinct contents, so a file copied to several paths counts once, and ripgrep
counts paths. `(cap)` means the 2,000-matching-blob budget stopped verification (§4 of DESIGN.md), so ripgrep's
count is higher by design. Every uncapped row agrees with ripgrep. For `apiVersion: v1` (942 blobs here, 5,422
paths for ripgrep) a diff of the full path lists on the sprite was identical: Kubernetes ships the same YAML at
thousands of paths. ripgrep runs over a checkout with a warm page cache. git grep runs on the commit (`git grep -e
… <commit>`, so no checkout), which is the "search any snapshot" baseline.

### Linux (97k files, 1.68 GB)

| class | query | camelsearch p50 / p99 ms | files | candidates | rg warm p50 ms | git grep p50 ms | rg files |
|---|---|---|---|---|---|---|---|
| literal | `nvme_submit_sync_cmd` | 3.32 / 5.05 | 8 | 39 | 341.77 | 1260.18 | 8 |
| literal | `kmem_cache_create` | 6.32 / 9.18 | 317 | 531 | 318.63 | 1243.83 | 317 |
| literal | `spin_lock_irqsave` | 18.94 / 24.87 | 2007 (cap) | 3798 | 338.04 | 1270.79 | 3435 |
| literal | `EXPORT_SYMBOL_GPL` | 17.98 / 63.66 | 2006 (cap) | 3805 | 342.84 | 1262.85 | 3681 |
| literal | `return 0;` | 14.08 / 17.07 | 2006 (cap) | 30208 | 480.59 | 1415.81 | 29903 |
| literal | `CONFIG_PREEMPT_RT -i` | 25.73 / 36.96 | 126 | 322 | 340.67 | 1236.11 | 126 |
| literal | `copyright -i` | 17.00 / 23.10 | 2006 (cap) | 59276 | 658.56 | 1431.1 | 59424 |
| regex | `^static int \w+_probe\(` | 20.77 / 25.62 | 2005 (cap) | 11108 | 493.92 | 1282.81 | 9385 |
| regex | `spin_lock\w*\(&\w+->lock` | 25.30 / 30.37 | 2003 (cap) | 3770 | 354.69 | 1245.05 | 2391 |
| regex | `kmalloc\(.*GFP_ATOMIC` | 5.81 / 8.74 | 121 | 1034 | 334.23 | 1232.62 | 121 |
| regex | `struct \w+_ops \w+ = \{` | 47.16 / 63.14 | 2005 (cap) | 13217 | 394.95 | 1301.66 | 8927 |
| regex | `(?i)todo\|fixme` | 39.74 / 82.09 | 2006 (cap) | 5345 | 356.52 | 1451.5 | 5316 |
| regex | `\b[A-Z_]{24,}\b` (no trigram, no literal: full scan) | 461.48 / 606.67 | 2001 (cap) | 96612 | 1010.06 | 2015.33 | 34430 |
| filtered | `mutex_lock path:drivers/net/** lang:c` | 8.68 / 10.93 | 813 | 6052 | 57.31 | 93.37 | 813 |
| filtered | `compatible file:*.dts -i` | 22.12 / 29.01 | 2005 (cap) | 23027 | 68.93 | 114.06 | 3672 |
| filtered | `depends on file:Kconfig*` | 11.68 / 16.56 | 1758 | 6108 | 49.53 | 100.3 | 1758 |
| path | `path:drivers/net/**/*.c` | 9.66 / 17.16 | 3644 | – | 32.07 | 19.56 | 3644 |
| path | `file:*.dts` | 9.40 / 10.53 | 3782 | – | 32.6 | 36.77 | 3778 |
| path | `path:**/nvme/** file:*.h` | 1.81 / 2.72 | 8 | – | 31.61 | 29.24 | 8 |
| path | `file:Kconfig*` | 4.06 / 7.26 | 1964 | – | 36.35 | 30.93 | 1964 |
| symbol | `sym:kmalloc` | 0.40 / 0.60 | 20 (limit) | | | | |
| symbol | `sym:nvme_submit_sync_cmd` | 0.06 / 0.19 | 1 | | | | |
| symbol | `sym:tcp_v4_` (prefix) | 0.47 / 0.65 | 20 (limit) | | | | |
| symbol | `sym:^ext4_.*_inode$` (regex over all names) | 340.05 / 376.00 | 20 (limit) | | | | |

(`file:*.dts` 3782 vs 3778: the path search lists every tree entry, symlinks included, while ripgrep does not follow symlinks; not checked path by path.)

### Kubernetes (32k files, 283 MB)

| class | query | camelsearch p50 / p99 ms | files | candidates | rg warm p50 ms | git grep p50 ms | rg files |
|---|---|---|---|---|---|---|---|
| literal | `NewSharedInformerFactory` | 4.25 / 5.99 | 252 | 438 | 155.66 | 568.53 | 252 |
| literal | `klog.Errorf` | 2.65 / 3.26 | 166 | 326 | 157.11 | 686.8 | 166 |
| literal | `context.TODO()` | 6.41 / 7.66 | 574 | 595 | 203.52 | 591.87 | 574 |
| literal | `if err != nil {` | 21.11 / 27.83 | 2006 (cap) | 7174 | 208.8 | 623.5 | 6150 |
| literal | `apiVersion: v1` | 34.26 / 49.99 | 942 | 1339 | 225.45 | 710.85 | 5422 (paths) |
| literal | `podsecurity -i` | 44.66 / 57.49 | 572 | 1022 | 187.29 | 646.91 | 583 |
| literal | `license -i` | 34.96 / 39.53 | 2005 (cap) | 17566 | 487.27 | 756.78 | 17911 |
| regex | `func \(\w+ \*\w+Controller\) Run\(` | 3.49 / 4.60 | 49 | 224 | 176.56 | 603.26 | 49 |
| regex | `func \w+\(ctx context\.Context` | 10.17 / 12.21 | 826 | 2874 | 173.44 | 598.13 | 826 |
| regex | `errors\.New\("[^"]*not found` | 9.18 / 10.76 | 40 | 487 | 144.61 | 629.72 | 40 |
| regex | `(?i)todo\|fixme` | 73.12 / 88.19 | 2007 (cap) | 2562 | 182.86 | 645.77 | 2548 |
| regex | `\b[A-Z][a-z]+[A-Z][a-z]+Reconciler\b` | 2.93 / 4.05 | 1 | 435 | 154.9 | 700.25 | 1 |
| regex | `\bv1beta[0-9]\b` | 45.48 / 50.30 | 2007 (cap) | 3006 | 185.39 | 592.85 | 3534 |
| filtered | `t.Fatalf path:pkg/kubelet/** lang:go` | 2.73 / 4.24 | 110 | 1694 | 30.78 | 15.81 | 110 |
| filtered | `Deployment file:*.yaml` | 1.38 / 3.03 | 80 | 914 | 54.58 | 147.52 | 90 (paths) |
| filtered | `ResourceVersion file:types.go` | 3.52 / 4.79 | 13 | 2063 | 30.42 | 41.71 | 13 |
| path | `path:pkg/**/types.go` | 2.65 / 2.98 | 85 | – | 29.92 | 11.52 | 85 |
| path | `path:staging/** file:*_test.go` | 9.35 / 11.83 | 1573 | – | 30.75 | 24.25 | 1573 |
| path | `file:*.proto` | 1.49 / 2.37 | 136 | – | 30.64 | 30.42 | 136 |
| path | `path:cmd/**` | 2.38 / 3.67 | 645 | – | 34.91 | 9.89 | 645 |
| symbol | `sym:NewSharedInformerFactory` | 0.22 / 0.30 | 20 (limit) | | | | |
| symbol | `sym:Reconcile` (prefix) | 0.75 / 1.16 | 20 (limit) | | | | |
| symbol | `sym:NewController` | 0.47 / 1.32 | 20 (limit) | | | | |
| symbol | `sym:^New.*Admission$` | 38.62 / 53.73 | 1 | | | | |

### Synthetic trees (the sibling prototypes' generator)

These trees use 35 words, so nearly every blob contains nearly every trigram. That is the adversarial case for a
trigram index: candidates ≈ all blobs. Selective queries (`// file 4242`) still answer in ~1 ms, and unselective
ones fall back to a parallel scan of the `.dat` that is 3–10x faster than ripgrep.

| corpus | base build | `.idx` | literal p50/p99 | regex p50/p99 | path p50/p99 | rg warm (range) |
|---|---|---|---|---|---|---|
| gen-small (1 MB) | 0.16 s | 114 KB (11 %) | 1.0 / 2.0 ms | 0.6 / 1.1 ms | 0.01 / 0.01 ms | – |
| gen-medium (50 MB) | 1.2 s | 2.7 MB (5 %) | 10.9 / 23 ms | 14 / 22 ms | 0.12 / 0.16 ms | 22–56 ms |
| gen-large (501 MB) | 18.8 s¹ | 27 MB (5 %) | 21 / 92 ms | 66 / 122 ms | 1.3 / 2.6 ms | 180–650 ms |

¹ 14.8 s of it was `git ls-tree` on a page-cache-cold repo of 50k loose-ish objects; building the shards took 6.8
core-seconds.

## Incremental, forks, compaction

| corpus | step | new blobs | index work | delta `.idx` | shards in manifest |
|---|---|---|---|---|---|
| k8s | 1 file | 1 | 4.5 ms | 15 KB | 6 |
| k8s | 100 files on top | 100 | 36 ms | 474 KB | 7 |
| k8s | fork (ref) | 0 | 0.29 ms | – | 7 |
| k8s | 1 file on the fork | 1 | 3.7 ms | 14 KB | 8 |
| k8s | 20 more checkpoints × 5 files | 100 | ~3 ms each | | 25 |
| k8s | compact (21 small shards → 1) | 1,077 live | 156 ms | 2.1 MB | 5 |
| linux | 1 file | 1 | 3.6 ms | 70 KB | 26 |
| linux | 100 files on top | 100 | 38 ms | 743 KB | 27 |
| linux | fork (ref) | 0 | 0.18 ms | – | 27 |
| linux | 1 file on the fork | 1 | 3.0 ms | 52 KB | 28 |
| linux | 20 more checkpoints × 5 files | 100 | | | 45 |
| linux | compact (28 small shards → 1) | 5,703 live | 1.77 s | 7.8 MB | 18 |

Queries do not slow down as deltas pile up: Linux literal p50 was 16.3 ms on the base, 13.4 ms on the fork, 12.6 ms
with 45 shards and 12.3 ms compacted. Kubernetes was 21–26 ms in every state. A delta shard costs one more binary
search per trigram, which is noise next to verification. Compaction is about bounding file counts and dead bytes
(superseded blobs in shared shards), not latency. Queries on the fork return the fork's content and not the
parent's (`search_test.go` checks this against a brute-force oracle, and does the same for checkpoints, a two-parent
merge and compaction).

The prototype's measured "1-file" wall time includes `git ls-tree -r` of the whole tree to get the path table:
150–330 ms warm, and 7.3 s for Linux's first one after a page-cache drop. In the file service the path table comes
from the FS's own Merkle tree (DESIGN.md §3), so this cost does not exist there. The checkpoint's work is the
read + index column.

## Cold paths

| | Kubernetes | Linux |
|---|---|---|
| camelsearch, new process, page cache dropped: open + first query | 142 ms + 1.74 s | 124 ms + 1.65 s |
| ripgrep over the checkout, page cache dropped | 8.0 s | 15.8 s |
| git grep on the commit, page cache dropped | 2.8 s | 3.0 s |
| ripgrep over a cold camelfs lazy mount (20 ms per blob fetch, 8 rg threads) | 72.5 s | 262 s |
| … same, 32 background prefetchers | 13.5 s | 59.8 s |
| … warm host blob cache (another job on the same host), page cache dropped | 2.5 s | 13.9 s |
| camelfs mount time (manifest + tree in memory) | 0.2–3.3 s | 0.3–2.8 s |

The sprite's disk is slow when the page cache is cold (ripgrep reads 283 MB in 8 s). Cold camelsearch numbers are
disk-bound in the same way: the first query faults in the trigram tables and the candidates' `.dat` pages. On an
NVMe host (2–3 GB/s) the same reads are ~10x faster. The structural difference is that a cold *index* reads tens of
MB at known offsets, while a cold *mount* pays one remote fetch per file. That is why searching a fork through
its mount on a new host takes minutes, and through the index tens of milliseconds once its shards are local.

## Memory and storage per GB of code

Per GB of source content (Linux, Kubernetes):

| | per GB | notes |
|---|---|---|
| `.idx` (trigram postings + tables) | 0.11–0.13 GB | 0.05 on the 35-word synthetic tree |
| `.sym` (ctags) | 0.05–0.11 GB | C has more symbols per byte than Go |
| `.dat` (verification copy) | 0.7–0.9 GB raw | blobs over 1 MiB excluded; zstd would bring this to ~0.2–0.25 GB (not built) |
| path table | ~65 bytes/file | derived from the FS tree in production |
| build CPU | ~110 core-seconds/GB, ~215 with ctags | Linux: 22.6 s and 44.5 s wall on 8 vCPU |
| heap per open snapshot | ~180 bytes/file | 17 MB for Linux's 97k files |
| page cache for warm queries | the trigram tables + hot `.dat` pages | Linux bench process: RssFile 0.9 GB after all 20 queries × 21 runs |

S3 at $0.023/GB-month: ~$0.01 per GB of code per month for `.idx` + `.sym` + zstd `.dat`, before dedupe across
volumes. Forks and checkpoints add only their delta shards: 0.3–0.5 KB of `.idx` per KB of changed source for 100-file deltas,
and 15–70 KB for a 1-file delta (a small shard's trigram table is proportionally larger; compaction folds them).

## Notes and caveats

- One 8-vCPU machine. Queries fan out across shards and 64-blob work items on all cores. A bigger host scales the
  verification-bound queries close to linearly.
- The 2,000-matching-blob budget makes unselective queries cheap but changes their semantics: ranking happens over
  the first 2,000 verified blobs, not the best 2,000 overall. Zoekt and GitHub make the same trade-off. A
  "count everything" mode is one flag.
- The full-scan regex (`\b[A-Z_]{24,}\b`) is the true worst case: 460 ms on Linux against ripgrep's 1 s. Go's
  regexp is the bottleneck there. A Rust verifier (the `regex` crate, ripgrep's engine) would be ~3–5x faster.
- Regex symbol search scans all names (9M on Linux, 340 ms). A trigram index over symbol names would make it
  ~1 ms, the same as content search.
- `-i` literals fold a copy of each candidate. That costs ~2x a case-sensitive literal (`podsecurity -i` 45 ms on
  k8s). A folded `.dat` or SIMD case-insensitive search would remove it.

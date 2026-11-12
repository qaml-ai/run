# Results

Trigram search only: symbol and semantic search were dropped (product decision, 2026-11-12).

Two machines, same code and same corpora (pinned commits):

- **EC2**: the camel-fs prototype host, m8id.4xlarge (16 vCPU, 64 GiB, local instance-store NVMe at `/nvme`, xfs),
  kernel 7.0, ripgrep 14.1, git 2.43. Shards are also round-tripped through the prototype S3 bucket in us-west-2.
  These are the primary numbers. Log: `bench/results/ec2-k8s-linux.log`.
- **Sprite**: 8 vCPU, 8 GB, a slow network disk, ripgrep 15.1, git 2.53. Logs: `bench/results/gen-k8s.log`,
  `linux.log` and `*-queries-rerun.log`. These come from an earlier build that still had the symbol index and a
  full `ls-tree` per checkpoint. Query latency is unaffected by either.

Run with `bench/run.sh` (EC2 run: `SEARCH_BENCH_DIR=/nvme/... CORPORA_DIR=/nvme/... S3_URI=s3://<bucket>/proto-search
bash bench/run.sh k8s,linux`). The per-query tables come from `bench/table.py`.

| corpus | files | content | unique blobs | commit |
|---|---|---|---|---|
| Kubernetes | 31,760 | 283 MB | 24,437 | `kubernetes/kubernetes` c80effae |
| Linux | 97,362 | 1.68 GB | 96,612 | `torvalds/linux` ee838993 |
| gen-small / medium / large (sprite only) | 200 / 5k / 50k | 1 / 50 / 501 MB | all | `proto/artifacts-volumes` generator |

## Headline (EC2, 16 vCPU + NVMe)

| | Kubernetes | Linux |
|---|---|---|
| base index build, wall, from git objects | **1.2 s** | **2.6 s** |
| trigram index `.idx` / content | 37.5 MB / 283 MB = **13 %** | 178 MB / 1.68 GB = **11 %** |
| verification copy `.dat` (blobs ≤ 1 MiB, uncompressed) | 244 MB | 1.19 GB |
| checkpoint, 1 file: total (diff + path table + delta shard) | **26 ms** | **52 ms** |
| … of which reading the blob + building the delta shard | 1.4 ms | 1.7 ms |
| checkpoint, 100 files: total | **48 ms** | **100 ms** |
| … of which read + delta shard | 13 ms | 23 ms |
| fork | **0.13 ms** (a ref) | **0.08 ms** |
| fork, then 1 file on it: total | 25 ms | 50 ms |
| compaction (19 / 28 small shards → 1) | 87 ms | 559 ms |
| open a snapshot view | 12–14 ms | 39–46 ms |
| query p50 / p99, literal (7 queries) | **11 / 25 ms** | **9.4 / 14 ms** |
| query p50 / p99, regex (6 queries) | **5.3 / 34 ms** | **23 / 228 ms**¹ |
| query p50 / p99, path + text filters (3 queries) | **1.3 / 2.2 ms** | **7.0 / 14 ms** |
| query p50 / p99, path only (4 queries) | **1.4 / 5.2 ms** | **6.2 / 7.5 ms** |
| selective queries (a few hundred hits) | 1.4–5 ms | 2.8–6 ms |
| HTTP round trip (curl, `limit=20&context=2`) | 2.3–3.1 ms | 6.4–7.7 ms |
| **ripgrep, warm page cache**, same queries: p50 range | 32–51 ms (paths 11–16 ms) | 89–365 ms (paths 19–24 ms) |
| **git grep on the commit** (no checkout), p50 range | 345–387 ms | 932–1,445 ms |
| new process, page cache dropped: open + first query (×3) | 72–76 ms | 162–174 ms |
| **shards cold from S3**: `aws s3 sync` down, then first query | 2.3 s (282 MB) + 73 ms | 4.6 s (1.37 GB) + 165 ms |
| ripgrep, page cache dropped (local NVMe) | 393 ms | 1.3 s |
| git grep, page cache dropped | 611 ms | 1.7 s |
| ripgrep, **cold lazy mount** (camelfs, 20 ms per blob fetch) | 72 s² | **173 s** |
| … with 32 prefetchers | 12.0 s | 47.0 s |
| … warm host blob cache, page cache dropped | 0.71 s | 13.9 s² |

¹ One query in this class is `\b[A-Z_]{24,}\b`, which has no trigram and no required literal, so it is a full scan:
226 ms against ripgrep's 365 ms. Without it, Linux regex p99 is 27 ms.
² Measured on the sprite. On EC2, that camelfs mount hung or failed to come up twice. It is a harness or camelfs
problem, not a search one, and is left for `proto/mount`.

Query p50/p99 cover all queries of a class, 20 timed runs each after a warm-up run. Totals for checkpoints include
`git diff-tree`, reading and writing the 3–6 MB flat path table, and the delta shard. In the file service the path
table would come from the FS's Merkle tree (DESIGN.md §3), which leaves the read + delta-shard part: about 1.5 ms per
changed file batch, plus about 0.1–0.2 ms per changed file.

Query latency does not degrade as delta shards pile up, and is the same on a fork. EC2 class p50s:

| | base | fork (+2 deltas) | 23 deltas | compacted |
|---|---|---|---|---|
| k8s literal / regex / path | 11.2 / 5.3 / 1.4 ms | 11.2 / 5.5 / 1.5 | 11.2 / 5.3 / 1.5 | 11.2 / 5.4 / 1.5 |
| linux literal / regex / path | 9.4 / 23.1 / 6.2 ms | 9.9 / 23.4 / 6.3 | 9.5 / 23.3 / 6.3 | 9.5 / 23.0 / 6.2 |

## Per query on EC2: camelsearch vs ripgrep vs git grep

`files` counts matching **blobs** (distinct contents), while ripgrep counts paths. `(cap)` means the
2,000-matching-blob budget stopped verification (DESIGN.md §4). Every uncapped row agrees with ripgrep. For
`apiVersion: v1` (942 blobs, 5,422 paths), a diff of the full path lists on the sprite was identical: Kubernetes
ships the same YAML at thousands of paths.

### Linux (97k files, 1.68 GB)

| class | query | camelsearch p50 / p99 ms | files | candidates | rg warm p50 ms | git grep p50 ms | rg files |
|---|---|---|---|---|---|---|---|
| literal | `nvme_submit_sync_cmd` | 2.84 / 3.94 | 8 | 39 | 89.81 | 931.58 | 8 |
| literal | `kmem_cache_create` | 4.78 / 6.17 | 317 | 531 | 88.84 | 946.99 | 317 |
| literal | `spin_lock_irqsave` | 11.27 / 12.07 | 2014 (cap) | 3798 | 90.62 | 951.22 | 3435 |
| literal | `EXPORT_SYMBOL_GPL` | 9.25 / 10.21 | 2010 (cap) | 3805 | 89.69 | 951.84 | 3681 |
| literal | `return 0;` | 9.11 / 9.69 | 2014 (cap) | 30208 | 103.76 | 1016.23 | 29903 |
| literal | `CONFIG_PREEMPT_RT -i` | 13.25 / 14.46 | 126 | 322 | 99.95 | 952.79 | 126 |
| literal | `copyright -i` | 10.80 / 11.37 | 2011 (cap) | 59276 | 149.26 | 1023.76 | 59424 |
| regex | `^static int \w+_probe\(` | 13.75 / 14.40 | 2011 (cap) | 11108 | 145.11 | 976.38 | 9385 |
| regex | `spin_lock\w*\(&\w+->lock` | 13.93 / 15.38 | 2009 (cap) | 3770 | 94.22 | 955.48 | 2391 |
| regex | `kmalloc\(.*GFP_ATOMIC` | 4.31 / 5.19 | 121 | 1034 | 89.6 | 953.78 | 121 |
| regex | `struct \w+_ops \w+ = \{` | 24.07 / 24.66 | 2009 (cap) | 13217 | 106.23 | 980.38 | 8927 |
| regex | `(?i)todo\|fixme` | 26.44 / 27.44 | 2015 (cap) | 5345 | 100.11 | 1061.04 | 5316 |
| regex | `\b[A-Z_]{24,}\b` (full scan) | 226.15 / 228.23 | 2006 (cap) | 96612 | 364.86 | 1444.74 | 34430 |
| filtered | `mutex_lock path:drivers/net/** lang:c` | 6.30 / 7.67 | 813 | 6052 | 24.13 | 64.01 | 813 |
| filtered | `compatible file:*.dts -i` | 13.77 / 14.21 | 2015 (cap) | 23027 | 23.66 | 82.6 | 3672 |
| filtered | `depends on file:Kconfig*` | 6.74 / 7.59 | 1758 | 6108 | 19.98 | 66.22 | 1758 |
| path | `path:drivers/net/**/*.c` | 7.04 / 7.74 | 3644 | – | 18.67 | 10.52 | 3644 |
| path | `file:*.dts` | 6.30 / 7.13 | 3782 | – | 18.56 | 23.97 | 3778³ |
| path | `path:**/nvme/** file:*.h` | 1.39 / 1.44 | 8 | – | 18.93 | 19.38 | 8 |
| path | `file:Kconfig*` | 3.40 / 4.04 | 1964 | – | 18.72 | 18.6 | 1964 |

³ The path search lists every tree entry, symlinks included, and ripgrep does not follow symlinks. Not checked path
by path.

### Kubernetes (32k files, 283 MB)

| class | query | camelsearch p50 / p99 ms | files | candidates | rg warm p50 ms | git grep p50 ms | rg files |
|---|---|---|---|---|---|---|---|
| literal | `NewSharedInformerFactory` | 2.69 / 3.51 | 252 | 438 | 32.36 | 348.07 | 252 |
| literal | `klog.Errorf` | 1.43 / 2.25 | 166 | 326 | 32.32 | 347.45 | 166 |
| literal | `context.TODO()` | 3.61 / 4.38 | 574 | 595 | 31.91 | 351.15 | 574 |
| literal | `if err != nil {` | 11.19 / 12.16 | 2013 (cap) | 7174 | 34.82 | 366.58 | 6150 |
| literal | `apiVersion: v1` | 20.02 / 20.69 | 942 | 1339 | 36.1 | 367.4 | 5422 (paths) |
| literal | `podsecurity -i` | 20.62 / 24.98 | 572 | 1022 | 34.87 | 353.55 | 583 |
| literal | `license -i` | 14.03 / 14.65 | 2013 (cap) | 17566 | 51.49 | 387.32 | 17911 |
| regex | `func \(\w+ \*\w+Controller\) Run\(` | 2.09 / 3.32 | 49 | 224 | 35.05 | 344.59 | 49 |
| regex | `func \w+\(ctx context\.Context` | 5.45 / 5.94 | 826 | 2874 | 35.74 | 349.24 | 826 |
| regex | `errors\.New\("[^"]*not found` | 5.05 / 5.76 | 40 | 487 | 33.02 | 348.35 | 40 |
| regex | `(?i)todo\|fixme` | 28.43 / 36.19 | 2015 (cap) | 2562 | 35.46 | 377.42 | 2548 |
| regex | `\b[A-Z][a-z]+[A-Z][a-z]+Reconciler\b` | 1.60 / 2.24 | 1 | 435 | 32.07 | 362.05 | 1 |
| regex | `\bv1beta[0-9]\b` | 17.14 / 17.91 | 2015 (cap) | 3006 | 34.18 | 363.31 | 3534 |
| filtered | `t.Fatalf path:pkg/kubelet/** lang:go` | 1.25 / 1.87 | 110 | 1694 | 14.12 | 9.94 | 110 |
| filtered | `Deployment file:*.yaml` | 0.70 / 1.23 | 80 | 914 | 15.95 | 74.08 | 90 (paths) |
| filtered | `ResourceVersion file:types.go` | 1.65 / 2.26 | 13 | 2063 | 12.82 | 25.19 | 13 |
| path | `path:pkg/**/types.go` | 1.51 / 1.61 | 85 | – | 11.91 | 5.18 | 85 |
| path | `path:staging/** file:*_test.go` | 4.58 / 5.24 | 1573 | – | 12.74 | 8.58 | 1573 |
| path | `file:*.proto` | 0.84 / 0.86 | 136 | – | 12.36 | 11.61 | 136 |
| path | `path:cmd/**` | 1.17 / 1.68 | 645 | – | 11.36 | 4.81 | 645 |

### Where the index loses or ties

- Kubernetes' YAML-heavy **`apiVersion: v1`**, the **case-insensitive literals** and **`todo|fixme`** take 14–36 ms
  against warm ripgrep's 35–51 ms on EC2: close to a tie. Many candidates (and, for `-i`, a folded copy of each,
  DESIGN.md §4) make these verification-bound. Most selective queries are 9–30x faster than warm ripgrep, and
  unselective ones 3–11x faster, because of the budget.
- **git grep on a commit** is the honest "search any snapshot without an index" baseline (no checkout, no mount):
  0.35 s on Kubernetes and ~1 s on Linux per query, against milliseconds here.
- The **full-scan regex** is the only query that does not benefit from the index (226 ms against 365 ms).

## Sprite numbers (8 vCPU, slow disk)

Same queries. Earlier build: symbols present, `ls-tree` per checkpoint.

| | Kubernetes | Linux |
|---|---|---|
| base build | 4.0 s | 22.6 s |
| checkpoint read + delta shard, 1 / 100 files | 4.5 / 36 ms | 3.6 / 38 ms |
| … plus a full `ls-tree` (no longer used for single-parent checkpoints) | +150–220 ms | +270–330 ms (7.3 s cold) |
| literal p50 / p99 | 21 / 57 ms | 16 / 38 ms |
| regex p50 / p99 | 10 / 79 ms | 32 / 506 ms |
| path p50 / p99 | 2.4 / 12 ms | 9.0 / 11 ms |
| ripgrep warm p50 range | 145–490 ms | 320–1,010 ms |
| git grep p50 range | 570–760 ms | 1.2–2.0 s |
| first query, page cache dropped | 1.95 s | 1.81 s |
| ripgrep, page cache dropped | 8.0 s | 15.8 s |
| ripgrep, cold lazy mount / 32 prefetchers / warm host cache | 72 s / 13.5 s / 2.5 s | 262 s / 60 s / 13.9 s |

The synthetic trees (35-word vocabulary, so every blob contains nearly every trigram, the adversarial case) were
measured on the sprite only:

| corpus | base build | `.idx` | literal p50/p99 | regex p50/p99 | path p50/p99 | rg warm (range) |
|---|---|---|---|---|---|---|
| gen-small (1 MB) | 0.16 s | 114 KB (11 %) | 1.0 / 2.0 ms | 0.6 / 1.1 ms | 0.01 / 0.01 ms | – |
| gen-medium (50 MB) | 1.2 s | 2.7 MB (5 %) | 10.9 / 23 ms | 14 / 22 ms | 0.12 / 0.16 ms | 22–56 ms |
| gen-large (501 MB) | 18.8 s⁴ | 27 MB (5 %) | 21 / 92 ms | 66 / 122 ms | 1.3 / 2.6 ms | 180–650 ms |

⁴ 14.8 s of it was `git ls-tree` over a page-cache-cold repo.

## Memory and storage per GB of code

| | per GB of source | notes |
|---|---|---|
| `.idx` | 0.11–0.13 GB | 0.05 on the 35-word synthetic tree |
| `.dat` | 0.7–0.9 GB raw | blobs over 1 MiB excluded; zstd would make it ~0.2–0.25 GB (not built) |
| path table | ~65 bytes per file | from the FS tree in production |
| build CPU | ~25 core-seconds on EC2 (Linux: 2.6 s × 16 vCPU / 1.68 GB); ~110 on the sprite | |
| heap per open snapshot | ~180 bytes per file | 17 MB for Linux |
| page cache, warm | the trigram tables + touched `.dat` pages | Linux bench process: RssFile 0.9 GB after all queries |
| S3 round trip | 120–300 MB/s with one `aws s3 sync` | 1.37 GB down in 4.6 s |

S3 at $0.023/GB-month is about $0.008 per GB of code per month for `.idx` + zstd `.dat`, before dedupe.

## Caveats

- One host per number. The EC2 host is shared with other camel-fs prototypes, which were idle during the run (load
  0.4 at start).
- The 2,000-matching-blob budget changes semantics for unselective queries: ranking covers the first 2,000 verified
  blobs. A "count everything" mode is one flag.
- Go's regexp is the full-scan bottleneck. A Rust verifier (ripgrep's `regex` crate) would be ~2–3x faster there.
- `-i` folds a copy of each candidate. A pre-folded `.dat` or a SIMD case-insensitive search would remove the cost.

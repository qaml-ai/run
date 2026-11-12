# Search any snapshot, any fork, at once

A prototype of code search for camelRun's file system: content-addressed, git-compatible snapshots (every version an
immutable tree hash), O(1) forks, lazy mounts into Firecracker VMs, and an API for VM-less agents (siblings:
`proto/merkle`, `proto/gitsvc`, `proto/mount`, `proto/block`, `proto/artifacts-volumes`). Numbers are in
[RESULTS.md](RESULTS.md); the code is `*.go` here (one binary, `camelsearch`, ~2k lines of Go plus tests) and `bench/`.

## The shape in one paragraph

The index is built **per content-addressed blob, in shards**, and a snapshot's index is a **composition**: a short
list of shard ids plus the snapshot's path table (path → blob id, which the file system already has as its tree).
A shard is an immutable set of blobs with document-level trigram postings over them (Zoekt / codesearch / Blackbird
style) and a copy of the blobs' bytes for verification. A **checkpoint** indexes only
the blobs its parent did not have, into one small **delta shard**, and writes a manifest naming the parent's shards
plus the delta; a **fork** is a ref to the same tree and does no index work at all; a **merge** names both parents'
shards. Queries turn a literal or regexp into a trigram query (`AND`/`OR` of trigrams), intersect postings per shard,
drop blobs the snapshot no longer references (the **live mask**, built from its path table), apply path / filename /
language filters on paths, verify candidates on the bytes, rank, and return lines with context. Delta shards pile up
like an LSM tree's levels, so a background **compaction** merges small ones; shards are kept while any ref's snapshot
names them.

```
 checkpoint (tree T2, parent T1)                     query "spin_lock\w*\(&\w+->lock" on ref fork/42
 ─────────────────────────────────                    ────────────────────────────────────────────────
 diff T1→T2: blobs not in T1's shards                 resolve ref → tree T2 → manifest
   │ (the FS knows them: it just wrote them)          ├─ per shard (parallel): trigram query → postings ∩
   ▼                                                  │   → live mask (blob still in T2?) → path filters
 delta shard D (idx + dat + sym), ~ms per 100 files   │   → verify bytes: literal → that line → regexp
   │                                                  ├─ rank (matches, basename, path shape)       
   ▼                                                  └─ lines + context for the top N only
 manifest T2 = shards(T1) − dead + D, paths(T2)
   │
   ▼                          S3: search/<tenant>/shards/<id>.{idx,dat,sym}    (immutable, content-addressed)
 upload D + manifest  ───────▶     search/<tenant>/snaps/<tree>.json           (small)
                              host NVMe: same files, mmapped; LRU; the FS chunk cache's neighbour
```

## Decisions

### 1. Unit of indexing: the blob, grouped into shards

- **Why per blob.** Snapshots differ by a few blobs; forks share all of them. An index keyed by blob id is reused by
  every snapshot, fork and tenant volume that contains that blob, exactly as the FS's chunk cache is. A per-snapshot
  index (Zoekt's per-repo-branch shards, `git grep`'s "scan this tree") would re-index or re-scan per version.
- **Why shards, not one index per blob.** Postings per blob would make a query touch every blob's index (tens of
  thousands of opens and lookups). A shard of ~64 MB of content gives one sorted trigram table per shard; a query
  does one binary search per trigram per shard. Base builds produce ~64 MB shards (one per core during the build);
  checkpoints produce small delta shards that compaction merges.
- **Shard id = hash of its sorted blob ids**, so two builders that index the same blob set produce the same shard,
  and the store needs no coordination to deduplicate.
- **Document-level postings, not positional.** codesearch-style: a trigram lists the blobs that contain it, and the
  bytes are re-scanned to verify. The index is ~11–13 % of the content (measured on Linux and Kubernetes) instead of
  the ~3x of Zoekt's positional postings. Positions would only pay for very common literals across huge corpora. A
  2,000-blob budget (§4) caps verification instead.
- **Case folding at index time.** Trigrams are built over ASCII-folded bytes; queries are folded the same way (the
  regexp parse tree's literals lowered, classes given their lowercase twins), which is a superset for
  case-sensitive queries and exact for `-i`. One index serves both.
- **What is not indexed.** Blobs with a NUL byte (binary) and blobs over 1 MiB keep a blob-table entry (so path
  queries still list them) but no trigrams; symlinks and submodules are paths only. Zoekt and GitHub do the same.

### 2. A snapshot's index is a composition

`store/snaps/<tree>.json` names the shards; `store/paths/<tree>.paths` is the path table. Opening a snapshot maps
every blob id in its shards to `(shard, ordinal)` and builds the **live mask**: `live[shard][ordinal] = first path
index` (or −1), plus the rare extra paths of a blob that appears more than once. A shared shard can hold blobs a
later snapshot replaced; the mask hides them. Opening costs ~0.4 µs per file on EC2 (12–14 ms for Kubernetes' 32k paths,
39–46 ms for Linux's 97k; cached per tree afterwards), and two refs at the same tree share the opened view.

- **Checkpoint** (`Ingest(parent)`): the parent's path table + `git diff-tree parent..commit` gives the new path table
  (a linear merge; a full `ls-tree` only for a base or a merge). The changed blobs that the parent's shards lack
  (a binary search over their sorted blob tables) become one delta shard. Parent shards with no live blob left are
  dropped from the manifest. Measured on EC2: 26 ms (Kubernetes) and 52 ms (Linux) for a 1-file checkpoint, of
  which 1.4–1.7 ms is reading the blob and building the delta; the rest is the diff and rewriting the flat path
  table, which §3 removes.
- **Fork**: a ref. The prototype writes `refs/<name>` → tree; the FS's own ref does the same job. 0.1 ms.
- **Merge**: `Ingest(parents=[ours, theirs])`: the union of both parents' shards, the merged tree's path table, and a
  delta with whatever the merge created (conflict-resolved files).
- **Compaction** (`Compact`): small shards (default < 32 MB of content) of a snapshot are rewritten as one, keeping
  only the snapshot's live blobs. The rewritten shard is new and content-addressed; snapshots that still name the old
  shards keep them. Policy: compact when a manifest has more than ~8 delta shards or the deltas' dead fraction exceeds
  ~30 %, tiered like an LSM tree so a long-lived volume's history does not re-write its base.
- **GC**: a shard lives while some manifest reachable from a ref names it, the same reachability rule the FS uses
  for blobs. Old manifests go when their tree is no longer a ref, a recent checkpoint, or pinned by a workflow.

### 3. The path table is the FS's tree

The prototype stores a flat path table per tree (~94 bytes per path including the 20-byte id; 3 MB for Kubernetes).
In the file service it should be **derived from the Merkle tree the FS already stores**: flattening a tree of
32k paths is a walk the FS does for every mount manifest anyway (`proto/mount` builds the same table). Equal
subtrees then share their flattened form, which makes the table O(changed dirs) per checkpoint rather than O(files).
Path / filename / language queries run over this table (a hand-written segment-aware glob matcher; ~5 ms per 30k
paths); a trigram index over paths is the next step if path queries over 1M+ files matter.

### 4. Queries

- **Literal**: trigrams of the literal, AND; verify with `bytes.Index` (case-sensitive) or on a folded copy (`-i`).
- **Regexp**: Go's RE2 syntax, turned into a trigram query by codesearch's `RegexpQuery` (exact-set / prefix /
  suffix analysis over the parse tree). Verification is **line-oriented like grep**: the required literal set of the
  regexp (`todo|fixme` → {todo, fixme}; `kmalloc\(.*GFP_ATOMIC` → {GFP_ATOMIC}) is found with `bytes.Index`, and the
  regexp runs only on those lines. Without it, Go's regexp over whole files ran at ~12 MB/s in a local test (`(?i)todo|fixme` took
  830 ms on Kubernetes). With it, the cost is the literal scan (73 ms). Regexps with no required literal (`\b[A-Z_]{24,}\b`) scan every blob: that is the worst case and is
  measured.
- **Filters**: `path:` glob (gitignore rules: `pkg/**/types.go` is anchored, `*.pb.go` matches at any depth),
  `file:` basename glob, `lang:` from extension. They apply to candidates before verification.
- **Ranking**: `10·log2(1+matches)` + 40 if the basename matches − 25 for tests / vendor / generated / docs − 0.5
  per directory level. Ties break by path. The top N files get line context; the rest are counted.
- **Budget**: verification stops after `maxFiles` (2,000) matching files and the result says `truncated`; ranking is
  then over those. An agent asking `return 0;` across Linux gets 2,000 files in tens of ms, not 60,000 in seconds.

### 5. Where it runs in the file service

- **Storage**: shards and manifests in **S3** under the tenant (`search/<tenant>/shards/<id>.idx|dat`,
  `search/<tenant>/snaps/<tree>.json`), immutable, so any host can cache them forever. Public OSS blobs could be a
  shared, cross-tenant shard pool (content-addressed, and a query only sees blobs its own path table names), but
  start per tenant: it avoids reasoning about timing side channels.
- **Search nodes** are the FS's cache hosts (or their neighbours): NVMe-backed, mmapping shards, routed by **volume
  lineage** (consistent hash of the root volume id), so a lineage's shards, and all its forks', stay warm on one node
  and a replica. A miss fetches the shard from S3. Measured: Linux's 1.37 GB of shards came down in 4.6 s with one `aws s3
  sync`, and the first query then took 165 ms. A single 64 MB shard is a few hundred ms. A manifest is a few KB.
- **Verification content**. The `.dat` is a second copy of the blobs. Two options: (a) keep it, zstd-compressed in
  64 KB frames (code compresses ~4x), so verification is a sequential read local to the shard; or (b) drop it and
  read blobs from the FS chunk cache by id. (a) is what the measurements use and is simpler and faster for
  verification-heavy queries; (b) saves storage where the chunk cache is guaranteed warm. Recommend (a) with zstd.
- **Build at checkpoints**: the checkpoint writer (Volume object / gitsvc commit API / overlay upper-dir commit)
  already knows the changed blobs and has their bytes. It enqueues `{tree, parent, newBlobs}`; an indexer (the
  search node owning the lineage) builds the delta shard (~13–23 ms per 100 changed files on EC2), uploads it, and writes the
  manifest. Index lag after a checkpoint is well under a second. Big imports (a clone of Linux) build as a job:
  2.6 s on the 16-vCPU NVMe host for Linux's 1.68 GB (1.2 s for Kubernetes; RESULTS.md).
- **Uncommitted edits**: an agent searching its own volume between checkpoints must see its writes. The tool
  searches the last checkpoint's index **and** brute-forces the dirty set (the working layer's changed files, small by
  construction), then masks index hits for paths the dirty set changed or deleted. Not built; mechanical.

### 6. How agents call it

One tool, the same with or without a VM. It is trigram search only: no symbol or semantic index (a product
decision: simple is better).

```
search({ q, regex?, i?, path?, file?, lang?, context?, limit?, ref? })   → files[] {path, lines[{line, text, ranges, before, after}], score}
```

`ref` defaults to the caller's volume head (its working layer included, §5). Any snapshot or fork is addressable by
ref or tree hash, so a workflow's reviewer can search the fork a worker produced without mounting it.

- **VM-less agents** (the API path): the tool calls `GET /v1/snapshots/{ref}/search?...` on the search service
  through the runtime; nothing is materialised. Measured end to end through HTTP on a warm node: 2–8 ms (EC2).
- **Agents in a VM**: a `camel grep` CLI in the guest talks to the host agent over vsock, which forwards to the
  search node. Plain `rg` still works over the lazy mount for ad-hoc use, but cold it pays one fetch per file
  (RESULTS.md: minutes on a cold mount, vs milliseconds here), and a fork's mount starts cold on a new host.

### 7. Cost per GB of code

From the measurements (RESULTS.md): per GB of source content,

| item | size | note |
|---|---|---|
| trigram index (`.idx`) | 0.11–0.13 GB | doc-level postings + blob and trigram tables |
| verification copy (`.dat`) | 0.7–0.9 GB raw, ~0.2–0.25 GB zstd (not built) | blobs over 1 MiB excluded |
| path table | ~65 bytes per file | derived from the FS tree in production |
| build CPU | ~25 core-s (EC2 NVMe; ~110 on a slow-disk sprite) | per checkpoint: ~1.5 ms per batch + ~0.1–0.2 ms per changed file |

At S3's $0.023/GB-month that is ~$0.01 per GB of code per month with zstd, before cross-tenant dedupe. Memory: a node
holds the opened snapshot views (live mask and blob map: ~180 bytes per file, 6 MB of heap for Kubernetes and 17 MB for Linux) and relies on
the page cache for shards: a warm query touches the trigram tables (a few % of the index) and the candidates' bytes.
A node with 64 GB of RAM and 2 TB of NVMe keeps ~2 TB of indexed code on disk and the hot ~30–40 GB in page cache.

### 8. Scale

- **Per query**: the work is postings decode (proportional to the rarest trigrams' document counts) + verification of
  candidates (proportional to their bytes, spread over cores). A selective query over Linux verifies hundreds of
  blobs; the worst case (no usable trigram) scans all content at memory bandwidth.
- **Per node**: a 16-vCPU NVMe node answers selective queries over a Linux-sized snapshot in 3–6 ms and typical
  ones in 5–25 ms (literal p50 9.4 ms, p99 14 ms), so on the order of 100+ queries per second per node. The budget
  caps unselective queries. The one true worst case, a regexp with no trigram and no literal, is a full parallel
  scan: 0.23 s on Linux.
- **Per tenant**: many small volumes are cheap (a 5k-file volume opens in ~3 ms and queries in under a millisecond).
- **Monorepo scale** (10–100 GB): shard fan-out across nodes (Zoekt's and Blackbird's answer): manifests are lists of
  shards, so a coordinator can assign shard ranges to nodes and merge top-N. Not needed below ~10 GB per snapshot.
- **Fork fan-out**: 1,000 forks of one volume share its shards; each fork costs its own delta shards and its path table
  (or its tree, shared with the FS).

## Risks

- **Index lag versus agents' own writes.** Until the dirty-layer overlay (§5) exists, an agent may not see a write
  it just made, and it will distrust the tool. The overlay is required before launch, not optional.
- **Unselective queries.** The 2,000-blob budget keeps them fast, but ranking is then partial. Agents do run
  `return`-style queries. Positional postings for the top few thousand trigrams, or rank-ordered shards (Blackbird
  orders documents by quality, so early termination keeps the best ones), would fix ranking without a full scan.
- **Duplicated bytes.** `.dat` copies the content the FS already stores. zstd brings it to ~25 %, and reading the FS
  chunk cache instead removes it, at the cost of a dependency on that cache being warm.
- **Delta-shard sprawl** on long-lived, busy volumes with many forks: manifests grow by one shard per checkpoint
  until compaction runs. The policy (§2) needs a background worker, and GC needs reachability across all refs of a
  tenant. Both are mechanical but are real code in the file service.
- **Path tables per tree** cost ~65 bytes per file per indexed tree (Linux: 6 MB per checkpoint) unless they are
  derived from the FS's shared subtrees (§3). That integration is the main coupling with `proto/merkle`.
- **Go's regexp** is the worst-case bottleneck (0.23 s full scans on Linux on EC2). A Rust verifier, or the whole service in
  Rust, is the likely production step. The structure carries over unchanged.
- **Tenant isolation** if shards are ever shared across tenants: the live mask stops leaks through results, but
  timing and the candidate counts in stats would reveal shared content. Keep shards per tenant unless that is
  analysed.

## What is not built

Dirty-layer overlay (§5), a host cache with eviction and on-demand S3 fetch (the bench round-trips shards through S3 with `aws s3 sync`), zstd for `.dat`,
a trigram index over paths, query-time shard fan-out
across nodes, and the `camel grep` guest CLI.

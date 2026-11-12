# Results (2026-11-12)

Host: the exe.dev VM (4 vCPU, Linux 6.12), git 2.43, Node 22.21. Trees from the shared generator
(`prototypes/artifacts-volumes/bench`): small 200 files / 1 MB, medium 5k / 50 MB, large 50k / 500 MB (source-like text,
packs ≈ 24 % of raw). One run each; latencies are medians (10 one-file commits, 5 hundred-file commits, 20 reads, 50
worktree writes/reads, 10 branches, 3 merges of each kind). Raw JSON: `bench/results-worker.json`,
`bench/results-node.json`.

Two servers, same code (`RepoCore` + `http.ts`):

- **Worker** = `wrangler dev` (workerd, a local SQLite Durable Object, local Miniflare R2). Wall clock from the bench
  client; `server` = the Worker's own clock around the DO call. Local R2 is a floor: production R2 adds ~20–50 ms per
  operation from a Worker, and the wrangler dev proxy adds ~20 ms per request.
- **Node** = `src/node.ts` (node:sqlite, segments as files). Its **CPU** column (`process.cpuUsage` around the whole
  request, including the streamed pack) is the CPU-per-op proxy for Workers' limits; workerd runs the same V8 and the
  same `node:crypto` / `node:zlib`.
- Correctness: `npm test` runs the whole flow with the real git CLI against both (`GITAPI_URL=…` for the Worker):
  clone + `fsck --full --strict`, pull, `clone --depth 1` + plain fetch into it, merge clean/conflict/squash, worktree
  CAS + checkpoint, per-file `expect`, expiry + GC, clone after GC. Both pass.

## API ops

| op | Worker wall (server) | Node wall | Node CPU | notes |
|---|---:|---:|---:|---|
| commit, 1 file (S / M / L) | 56 / 45 / 46 ms (24 / 20 / 21) | 12 / 10 / 11 ms | **2.7 / 2.3 / 3.7 ms** | flat in tree size: only the 4 trees on the path are rewritten |
| commit, 100 files of 10 KB (S / M / L) | 100 / 132 / 212 ms (57 / 91 / 150) | 42 / 73 / 101 ms | 28 / 48 / 70 ms | 1 MB in, one R2 PUT |
| import commit, 2,500 files / 25 MB | ~1.4 s each (L: 20 commits, 38 s total) | ~1.1 s each (29 s total) | **~1.07 s each** | hashing + deflate of 25 MB; fits Workers' 30 s default CPU |
| worktree write, 10 KB | 28–33 ms (7–8) | 8 ms | **0.9 ms** | one SQLite row |
| worktree read (dirty) | 22–26 ms (1) | 1 ms | 0.5 ms | |
| checkpoint, 50 dirty files | 87–155 ms (54–131) | 27–78 ms | 15–52 ms | = a 50-file commit |
| readFile (cold blob) | 16–32 ms (3–5) | 1.5–2.3 ms | 0.8–1.1 ms | one R2 range read |
| readTree recursive (S / M / L entries) | 26 / 62 / 474 ms | 2 / 18 / 224 ms | 1 / 20 / 170 ms | SQLite only; 51k entries |
| diff, whole history (L: 48k changes) | 29 / 64 / 514 ms | 2 / 18 / 168 ms | 2 / 18 / 153 ms | skips equal subtrees |
| log 50 | 24–67 ms (1–3) | 1.5–3 ms | 1–2 ms | |
| branch create | 30–44 ms (6–10) | 6–7 ms | **0.6–1.1 ms** | one row, any size |
| merge, disjoint files (3 per side) | 43–51 ms (22–23) | 19–24 ms | **3.2–3.9 ms** | tree-level, no blob reads |
| merge, same file, disjoint hunks (diff3) | 48–56 ms (29–30) | 15–18 ms | 3.7–6.2 ms | reads 3 blobs |
| merge, fast-forward | 29–39 ms (8–9) | 13–15 ms | 1.1–1.7 ms | ref move only |
| GC, full mark + sweep (S / M / L) | 107 / 138 / 474 ms | 10 / 45 / 433 ms | 10 / 42 / **518 ms** | ∝ distinct trees + index rows |

Node wall times include an fsync per SQLite transaction (WAL); the CPU column is the cost that matters for Workers.

## Clone and fetch (jobs)

| | small | medium | large |
|---|---:|---:|---:|
| pack bytes (one commit's tree) | 0.27 MB | 12.0 MB | 119.7 MB |
| full clone, cold (pack built from segment ranges, teed into the cache) — Worker / Node | 0.21 / 0.09 s | 1.62 / 1.11 s | 19.4 / 14.1 s |
| full clone, warm (cached pack, one R2 read) — Worker / Node | 0.21 / 0.08 s | 1.36 / 1.04 s | 13.5 / 14.1 s |
| `clone --depth 1` cold / warm — Worker | 0.26 / 0.17 s | 1.68 / 1.39 s | 15.6 / 16.6 s |
| server CPU for a full clone (Node, streaming the whole pack + SHA-1) | 8 ms | 58 ms | **633 ms** (cold) / 868 ms (warm) |
| fetch of 15 commits / ~510 changed files — Worker / Node (CPU) | 0.23 / 0.11 s (37 ms) | 0.37 / 0.25 s (61 ms) | 0.42 / 0.24 s (61 ms) |
| **fetch of a 3-file commit** — Worker / Node (CPU) | 0.11 / 0.05 s (1.6 ms) | 0.09 / 0.05 s (1.4 ms) | 0.20 / 0.10 s (**1.8 ms**) |

- Clones are **client-bound**: index-pack + checkout of 50k files is ~11–14 s whatever the server does (the server
  spends 0.6–0.9 s CPU). For comparison, the sibling measured on the same host and trees: a local tar pipe (today's
  shape minus R2 reads) 0.06 / 3.0 / 14.8 s; Artifacts `clone --depth 1` 0.93 / 3.1 / 22.4 s.
- The cache helps the **server**, not the client: a warm clone is one R2 GET + a pipe; a cold clone reads every
  segment range (coalesced: the 50k tree was 20 runs) and hashes 120 MB. In production that is ~120 MB through a
  Worker either way; streaming keeps memory flat (8 MiB pieces, 4 in flight).
- Fetch moves only the delta and costs ~2 ms of server CPU for a small change at any tree size: the walk descends only
  into subtrees whose sha differs from the client's newest `have`.
- History here is short (1–20 import commits), so depth-1 and full clones move the same bytes. On a volume with
  thousands of checkpoints, `--depth 1` is the job default and is supported (`shallow`/`deepen N`).

## Ephemeral-branch lifecycle

Branch with `ttlSeconds: 2`, 10 checkpoints of 5 new 10 KB files each (≈0.5 s of API work on the Worker), wait:

| | small | medium | large |
|---|---:|---:|---:|
| branch gone after (TTL 2 s; alarm in the Worker, 1 s timer on Node) | 2.2 s | 2.2 s | 2.9 s |
| segments before → after reclaim | 55 → 45 | 56 → 46 | 74 → 64 |
| objects dropped (80 = 50 blobs + 20 trees + 10 commits) | 80 | 80 | 80 |

On the Worker the alarm's GC keeps a 60 s grace for young objects, so the explicit `POST /gc {graceMs: 0}` did the
reclaim (above); on Node the expiry timer's GC (grace 0) had already done it. Nothing else in the repo changed:
`fsck --full --strict` on a fresh clone after GC is part of `npm test`.

## Against Workers' limits

- **CPU** (30 s default, 5 min max per request): the heaviest ops are an import commit of 25 MB (~1.1 s), a 50k-file
  GC (~0.5 s), a 120 MB clone stream (~0.6–0.9 s, in the stateless Worker, not the object). Everything an agent does
  per turn is single-digit ms.
- **Memory** (128 MB per isolate): commits hold their body (JSON string + bytes + deflated entries ≈ 3× the payload),
  so imports are batched at ~25 MB; clones stream. GC holds the index in memory (50k rows ≈ 10 MB of JS objects; a
  500k-file repo would need a paged mark/sweep).
- **Request body** (100 MB): bounds a single commit; big files need a separate upload path.
- **DO SQLite**: 50k-file repo = 52k index rows + 0.6 MB of tree/commit bytes; rows ≤ 2 MB is why the worktree inlines
  only ≤ 1 MiB.
- **Single object per repo**: the Worker run serialised everything through one object without contention at bench
  rates (~30–50 writes/s through wrangler dev, request-latency bound).

## Not measured

Production R2 latency (all R2 here is local disk), concurrency against one repo object, repos past 50k files, a GitHub
mirror push, auth overhead.

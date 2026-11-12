# Results: mount, don't copy

Measured 2026-11-12 on rt-pool sprites (Fly.io Firecracker microVMs, 8 vCPU, 8 GiB, kernel 6.12.116-fly, FUSE
passthrough capability present), commit `c6e9e384` (`prototypes/mount/bench.sh`, run with `scripts/sprite-test HEAD
bash prototypes/mount/bench.sh small,medium,large 20ms` and `... repo 20ms`, on two sprites at once). Raw logs: the
`RESULT` lines quoted below.

Setup: the fake R2 (`camelfs serve`) runs on the same sprite and adds a fixed **20 ms first-byte latency per request**
(an R2 GET from a nearby region), no bandwidth cap. Cache, overlay upper dir and copies are on `/tmp` (the sprite's
ext4 disk). Page cache dropped before every cold/warm step. "8 readers" = the read workload opens files 8 at a time.

Sizes: `small` 200 files / 1 MB, `medium` 5k / 50 MB, `large` 50k / 500 MB (the shared bench sizes; own generator, as
the sibling branch's `bench/` was not pushed yet), and `repo` = a real tree: this repo's checkout with its
`node_modules` (80,720 files, 1.64 GB, 54,556 unique blobs), no `.git`.

## Time to first command

Today = the tree is in place before the command. Mount = manifest fetched + tree built + FUSE and overlay mounted +
`ls` ran.

| size | camel-sync tar (sequential, today) | host pull, 6 at a time (today) | parallel pull, 32 at a time | **mount** |
|---|---|---|---|---|
| small (200) | 5.0 s | 0.75 s | 0.18 s | **0.05 s** |
| medium (5k) | 103 s | 17.9 s | 3.4 s | **0.06 s** |
| large (50k) | ~1,000 s (files × 20 ms, not run) | 178 s | 33.9 s | **0.17 s** |
| repo (80.7k) | ~1,600 s (not run) | 286 s | 56.5 s | **0.28 s** |

Mount time is the manifest: 22 ms (small) to 195 ms (repo, an 80k-entry JSON manifest); the FUSE+overlay mount is
under 60 ms at every size.

## Reading the tree after mount (cold host cache unless said)

| size | read 10% lazy | read 100% lazy | read 100% + prefetch 32 | read 100% warm host cache | same, page cache hot | native copy, 100% |
|---|---|---|---|---|---|---|
| small | 0.05 s | 0.56 s | 0.13 s | 0.018 s | — | 0.006 s |
| medium | 1.4 s | 13.7 s | 3.4 s | 0.31 s | 0.20 s | 0.11 s |
| large | 14.1 s | 138 s | 33.5 s | 4.2 s | 1.7 s | 4.4 s |
| repo | 19.8 s | 149 s | 39.2 s | 10.7 s | 3.5 s | 14.0 s |

- Lazy reads are bound by the reader's own parallelism × latency (8 readers × 20 ms ≈ 400 files/s).
- **Prefetch with 32 fetchers ≈ the 32-way parallel copy** (33.5 s vs 33.9 s large, 39 s vs 57 s repo: the repo's
  duplicate content is fetched once), but the command starts at 0.2 s instead of after the copy.
- Warm host cache ≈ native disk for whole-tree reads (large 4.2 s vs 4.4 s; repo 10.7 s vs 14.0 s, both cold page
  cache). The repo's 10% lazy read hit 3,121 times on a cold cache: identical files in `node_modules` share a blob.

## Real workload: `tsc -p tsconfig.json --noEmit` on the repo (TypeScript 7, parallel reads)

| mode | time to first command | tsc | blobs fetched | total |
|---|---|---|---|---|
| copy 32-way, then tsc on native disk | 56.5 s | 9.1 s | 80,720 files | **65.6 s** |
| mount, cold, lazy | 0.24 s | 7.2 s | 4,831 (70 MB of 1.64 GB) | **7.4 s** |
| mount, cold, prefetch 32 | 0.25 s | 8.1 s | (prefetch competes) | 8.3 s |
| mount, warm host cache | 0.25 s | 6.0 s | 0 | **6.2 s** |

tsc opens ~6k of 80.7k files (7.5%), so lazy is the right default here; prefetch only competed with it. (tsc native
9.1 s includes reading a just-copied tree from a dropped page cache; treat tsc as ~6–9 s in every mode.)

## Single-file read latency (open + read whole, 100 random files, p50 / p90)

| | small | medium | large | repo |
|---|---|---|---|---|
| native ext4 | 0.08 / 0.10 ms | 0.07 / 0.10 | 0.10 / 0.15 | 0.11 / 0.15 |
| mount, cold (fetch) | 21.4 / 21.7 ms | 21.4 / 21.7 | 21.7 / 22.0 | 21.5 / 21.8 |
| mount, warm host cache | 0.28 / 0.37 ms | 0.32 / 0.43 | 0.56 / 0.69 | 0.59 / 0.77 |

A cold miss costs the store's latency + ~1.5 ms (hash check + rename); a warm open through FUSE + overlay is 3–5× a
native open (the tree is larger in memory as it grows). FUSE passthrough was granted by the kernel but made no
measurable difference for these small-file workloads (large: 4.25 s with, 4.16 s without), since the per-file
`LOOKUP`/`OPEN` round trips, not `READ`s, dominate; it would matter for large files.

## Commit and fork

A job on the mounted volume appends to every 20th file (5%) and adds 20 files; commit walks the overlay's upper dir,
hashes, uploads blobs the server lacks (HEAD + PUT, 16 at a time, at 20 ms each) and writes the new manifest. Fork =
manifest copy.

| size | changed files | changed bytes | commit | fork (manifest copy) |
|---|---|---|---|---|
| small | 30 | 39 KB | 0.13 s | 0.04 s |
| medium | 270 | 2.7 MB | 0.83 s | 0.07 s |
| large | 2,520 | 26.6 MB | 10.7 s | 0.28 s |

Commit cost is O(changed files), independent of tree size; at 20 ms per request it's dominated by the HEAD+PUT round
trips (a batch "which of these hashes do you lack" call would halve it).

## Cache hit ratio across forks

The fork of the commit, mounted on the same host, then read in full:

| size | hits | misses | hit ratio | read 100% |
|---|---|---|---|---|
| small | 220 | 0 | 100% | 0.022 s |
| medium | 5,020 | 0 | 100% | 0.30 s |
| large | 50,020 | 0 | 100% | 4.5 s |

Unchanged files share their base's blobs; changed files are in the cache because commit writes through (an earlier
local run without write-through: 190/220 = 86%, the misses exactly the committed files). On a *different* host the fork
costs exactly what its base costs there, plus its changed blobs.

## Caveats

- One host, loopback blob server: no bandwidth limit, so large-blob throughput is not tested; the 20 ms latency is
  modelled, not R2's real distribution (tails would hurt lazy reads more than prefetch).
- The sprite is itself a Firecracker guest, so this is "FUSE inside the guest" (DESIGN option A) with loopback HTTP in
  place of vsock.
- Manifest as JSON (80k entries = ~200 ms); a binary or paged manifest would cut mount time further.
- Whole-blob fetch on open; no range reads.

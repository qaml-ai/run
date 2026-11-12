# gitsvc bench results (2026-11-12)

**Server host:** Fly.io sprite `rt-pool-7` (x86_64, 8 vCPU, 8 GB, overlay disk; git 2.53, Node 22.23), standing in for
an NVMe host in us-west-2. **Bucket:** SeaweedFS's S3 gateway in Docker on the same host (MinIO's binaries and
images are no longer downloadable anonymously), so the replication gate's S3 latency here is a **floor**: real S3 in
region adds ~20–60 ms per PUT, R2 from us-west-2 more. **Trees:** the sibling prototype's generator, byte for byte
(`bench/trees.ts`). Single runs, except rows marked "median" (5–10 samples). Commands: `bench/sprite-server.sh`
(through `scripts/sprite-test`) and `bench/client.ts`.

The tests (`test/gitsvc.test.ts`) passed on the sprite with replication on: scoped tokens (read cannot push, other
repo refused, write token limited to `refs/heads/job/`), clone over protocol v2, server-side commit with CAS, fork
as a branch, merge-ort merge (disjoint hunks of one file + a delete) and a refused conflict, `VolumeCore` thin-pack
checkpoint through the proxy, and a restore from the bucket matching refs + passing `fsck --connectivity-only`.

## On the service host (loopback client)

| | small: 200 files, 1 MB | medium: 5k files, 50 MB | large: 50k files, 500 MB |
|---|---:|---:|---:|
| pack on the server (after import) | 0.3 MB | 12.2 MB | 121.7 MB |
| pack after 23 more writes + `git gc` (bitmaps) | 0.5 MB | 12.5 MB | 122.2 MB |
| import: one `git push` of the whole tree, no gate / with gate ¹ | 0.16 / 0.21 s | 5.5 / 1.1 s | 36.6 / 10.0 s |
| (a) today's shape, tar over a local pipe (lower bound) | 0.04 s | 1.5 s | 19.4 s |
| (b) cold host: full clone (v2) | 0.09 s | 1.04 s | 17.9 s |
| (b) cold host: `--depth 1` | 0.11 s | 1.05 s | 20.8 s |
| (b) cold host: blobless partial clone, no checkout | 0.08 s | 0.36 s | 5.1 s |
| (b) cold host: then a full checkout (lazy blob fetch) | 0.09 s | 2.4 s | 14.3 s |
| host mirror, cold (`clone --mirror`) | 0.24 s | 0.64 s | 7.1 s |
| (c) old job dir: `fetch` + `reset --hard` of a 3-file commit | 0.08 s | 0.61 s | 1.8 s |
| (d) warm mirror: `fetch` of that commit | 0.05 s | 0.07 s | 0.18 s |
| (d) new job dir from the mirror: `clone --shared` | 0.04 s | 0.53 s | 6.4 s |
| (d) new job dir from the mirror: `worktree add` | 0.02 s | 0.50 s | 5.8 s |
| 1-file `git push`, no gate / with gate (median) | 89 / 111 ms | 129 / 154 ms | 230 / 584 ms ² |
| 1-file checkpoint, `VolumeCore` thin pack (median) | 75 ms | 505 ms ³ | 628 ms ³ |
| 1-file checkpoint, **commit API** (`fast-import` + CAS, gated, median) | 105 ms | 137 ms | 157 ms |
| 100-file checkpoint, commit API | 208 ms | 284 ms | 265 ms |
| cold blob read, `GET /blob/:sha` (median) | 7 ms | 8 ms | 9 ms |
| index seed, `GET /tree/main` (`ls-tree -r -t -l`) | 18 ms, 16 KB | 115 ms, 401 KB | 859 ms, 4.1 MB |
| **fork** = create a branch (gated, median) | 24 ms | 25 ms | 29 ms |
| **merge** (merge-ort, 3 files each side + disjoint hunks of one file, gated) | 75 ms | 95 ms | 168 ms |
| refused conflicting merge | 16 ms | 20 ms | 43 ms |
| `git gc` of 23 packs + ship new pack + sweep 46 bucket objects | 0.27 s | 0.61 s | 2.8 s |
| **restore from the bucket** (download packs + idx, `update-ref`) | 0.07 s | 0.20 s | 1.19 s |
| `fsck --connectivity-only` after restore | 14 ms | 21 ms | 81 ms |
| restored refs equal the live repo's | yes | yes | yes |

¹ The un-gated push ran first: its client paid the first delta search over a cold page cache; the gated push
reused it. Read the two as "the gate adds well under the noise of a cold import", not as "the gate is faster".
The gate's own cost for a 122 MB pack is uploading it (S3 PUT at bucket bandwidth).
² The large repo carried 20+ un-repacked packs by then; the gate lists and diffs them per write, and the push's
ref advertisement grows with forks. Geometric repack (DESIGN §7) bounds both.
³ `VolumeCore.commit` re-reads `info/refs` and re-hashes the trees on the changed path; it is the sibling's client,
unchanged. The commit API avoids it entirely.

## From another machine (the exe.dev VM, through `sprite proxy` to the server sprite)

Making the sprite's URL public for a second sprite was refused by the session's permission policy (opening an external
ingress), so the remote client ran from the exe.dev VM over `sprite proxy` (a WebSocket tunnel: ~30 ms ICMP RTT, ~78 ms
per HTTP API call, and **~500 ms per git command** for the tunnel's connection setup — `ls-remote` alone is 0.5 s).
This is a pessimistic stand-in for "job host in the same region as the shard" (sub-ms RTT, 10–25 Gbit/s).

| | small | medium | large |
|---|---:|---:|---:|
| API round trip (median) | 78 ms | 78 ms | 77 ms |
| `ls-remote` (tunnel floor per git command, median) | 498 ms | 511 ms | 510 ms |
| full clone, cold | 0.81 s | 2.0 s | 12.5 s |
| blobless partial clone, no checkout | 0.69 s | 0.72 s | 0.83 s |
| host mirror, cold | 0.80 s | 1.4 s | 8.1 s |
| old job dir: `fetch` + `reset --hard` of a 3-file commit | 0.67 s | 1.1 s | 1.1 s |
| warm mirror `fetch` | 0.61 s | 0.61 s | 0.69 s |
| new job dir from the warm mirror (local) | 0.06 s | 0.74 s | 5.8 s |
| 1-file `git push` (median) | 1.5 s ⁴ | 0.71 s | 0.76 s |
| 1-file commit API (median) | 1.9 s ⁴ | 0.33 s | 0.35 s |
| cold blob read (median) | 85 ms | 91 ms | 92 ms |
| fork (median) | 97 ms | 98 ms | 103 ms |

⁴ The first size warmed the tunnel; the medium/large rows are the steady state.

## Against the sibling's numbers (`proto/artifacts-volumes/bench/RESULTS.md`)

| medium tree (5k files, 50 MB) | Artifacts | own Workers + R2 server (wrangler dev) | gitsvc (this, loopback / remote via tunnel) |
|---|---:|---:|---:|
| full clone, cold | 2.6 s | 2.1 s | 1.0 s / 2.0 s |
| incremental fetch, 3 files | 1.2 s | 1.2 s | 0.07 s (mirror) – 0.61 s / 0.61–1.1 s |
| 1-file checkpoint | 610–700 ms | 485 ms | 137 ms (API) / 326 ms |
| fork | 500–620 ms | 527 ms | 25 ms / 98 ms |
| merge | 570–630 ms | 672 ms | 95 ms (merge-ort, renames included) |
| cold blob read | 236 ms | 23 ms | 8 ms / 91 ms |
| partial clone | not supported | not supported | 0.36 s / 0.72 s |
| large tree: full clone / delta fetch | 18–22 s / 1.1 s | — | 17.9 s / 0.18 s (mirror) |

## Backup and restore: RPO / RTO

- **RPO = 0** for every acknowledged write, by construction: the `reference-transaction` hook ships packs + manifest
  before the ref commits, and a failed upload aborts the update (tested). Cost per write here: +22–25 ms on the small
  and medium repos over a loopback bucket; budget **+30–80 ms** against real S3/R2 in region (one parallel
  pack+idx PUT, then a sequential `refs.json` PUT).
- **RTO per repo = one parallel download of its packs**: 0.07 s / 0.20 s / 1.2 s for 0.5 / 12 / 120 MB here; from S3
  at ~100–300 MB/s per host that is **≤ 1 s for a typical source volume, a few seconds for a 500 MB tree**. With lazy
  restore on first touch (DESIGN §3), a shard's RTO is the host replacement time (minutes) plus that per repo.
- **Whole-shard bulk restore** (if wanted instead of lazy): 0.5 TB at ~1 GB/s aggregate ≈ **9 minutes**.

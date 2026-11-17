# Warm Git repository service trial

Exact prototype `6fd0531e86df0fe5783de3a284c159b77749b1f4`, based on integration `81bf799c`. Server `rt-pool-8` served HTTPS to client `rt-pool-10` through its Sprite URL. Both leased jobs passed on November 17, 2026.

| Fixture label | Actual payload | Verified 4 KiB first read | 32 reads, p50 | Full snapshot median, 3 trials | Local-source Git fill |
| --- | --- | --- | --- | --- | --- |
| 50 MiB | 49.0625 MiB / 10,010 files | 55.755 ms | 44.243 ms | 666.649 ms | 3.294 s |
| 500 MiB | 499.0625 MiB / 10,460 files | 54.392 ms | 43.608 ms | 1,557.382 ms | 37.809 s |

The first read fetched exactly `src/d000/f00000.ts`, verified its 4,096 bytes against the pinned Git blob hash, and recorded the remote connection peer `[2a09:8280:1::99:d7b3:0]:443` using client HTTP tracing. Snapshot transfers verified every file hash, size, mode and count through HTTP EOF. Their first archive entry was `assets/a0000.bin`. Snapshot payload bytes exclude tar framing.

Canonical-source fill used local fixture storage. Git files occupied 52,148,051 and 524,179,120 bytes. The warm transfer timings include native Git reads, HTTPS transport and client hashing. Firecracker boot, guest apply, ext4 writes and S3 fill have separate costs. These API figures have no paired comparison against the current API, which already caches small blob bytes in SQLite.

The server stopped and its temporary source and Git repositories were removed. Prior Sprite URL authentication `sprite` was restored and verified. Production and pilot services were untouched.

Focused Go roundtrip and fault tests, vet, build, documentation generation and both llms documentation tests passed. Tests cover modes and symlink payloads, missing paths, auth rejection, a missing Git object directory, truncation, wrong hashes and cancellation.

[Raw trials and aggregate](raw/summary.json) · [Server fill receipts](raw/shard-1/fill-500.jsonl) · [Client 50 MiB trials](raw/shard-2/client-50.jsonl) · [Client 500 MiB trials](raw/shard-2/client-500.jsonl) · [Cleanup receipt](raw/cleanup.json) · [URL restoration](raw/url-restored.json) · [Validation and binary checksum](raw/validation.json)

## Git compression follow-up

A separate fill-only trial used one new 499.0625 MiB fixture and fresh destination repositories. Default Git fill took 38.790 s, with 36.878 s user CPU and 3.768 s system CPU. Setting standard `core.compression=0` reduced fill to 24.491 s, with 22.665 s user CPU and 3.987 s system CPU. Both runs verified the identical canonical tree and passed native `git fsck --full`. The default run preceded compression 0, so source caches may have been warmer for the latter. Remaining CPU work was not individually profiled. Original HTTPS transfer timings above use the default-compression repositories.

[Compression trial summary](raw/compression/summary.json) · [Default fill](raw/compression/fill-default.jsonl) · [Compression 0 fill](raw/compression/fill-0.jsonl)

The shell cleanup follow-up `53abcdf3` clears stale STOP markers and routes INT/TERM through cleanup. A Sprite check exercised two consecutive server runs and TERM cancellation, checking each server process was reaped and its temporary directory removed. [Lifecycle receipts](raw/lifecycle/results.json) and [the executable check](raw/lifecycle/check.py) preserve the verification.

# Mount, don't copy

A prototype of one answer to "how should a job see a volume": the volume stays what it is today (a manifest of path →
sha256 in the Volume DO, blobs in R2), and a job machine **mounts** a version of it through FUSE instead of copying the
tree in before the command. Numbers are in [RESULTS.md](RESULTS.md); the code is `*.go` here (one binary, `camelfs`).

## The shape

```
             Volume DO                                 R2 (or S3 / MinIO / a local dir)
   manifest@version: path → (sha256, size, mode)        blob per file, keyed by its sha256
          │  (signed manifest URL, job token)                 │ (presigned GETs / PUTs, or via the runtime)
          ▼                                                   ▼
 ┌────────────────────────── job host ─────────────────────────────────────────┐
 │  camelfs (one per job)                    host blob cache (NVMe)             │
 │   tree built in memory from the manifest   cache/ab/abcd…  verified, 0444,  │
 │   open() → Ensure(hash) ──────────────────► shared by every job and fork    │
 │   read() → kernel passthrough to the blob                                   │
 │        ▲ lowerdir (read-only)                                                │
 │  overlayfs  upperdir = job-local scratch (copy-up on write, whiteouts)      │
 │        ▲                                                                     │
 │      /repo  ← the job's command                                              │
 │  commit: walk upperdir → hash → upload new blobs → new manifest (CAS on base)│
 └──────────────────────────────────────────────────────────────────────────────┘
```

- **Mount** = fetch one manifest + build the directory tree in memory + `mount`. No blob is read. `ls`, `stat`,
  `find`, `readdir` never touch the network (sizes and modes are in the manifest), so a tool that walks the tree
  before reading (git status, tsc's module resolution, jest's haste map) does not pay per-file round trips.
- **Read** = on first `open`, fetch the blob into the host cache (single-flight per hash, sha256-checked, renamed into
  place read-only), then hand the kernel the cached file. With FUSE passthrough (Linux ≥ 6.9, root daemon) reads of
  an open file never come back to the daemon at all.
- **Prefetch** (optional): N background fetchers walk the manifest; demand opens join an in-flight fetch. For "read
  most of the tree" jobs this turns N×latency into N×latency/32 and hides it behind the command's own startup.
- **Write** = kernel overlayfs. camelfs is read-only and tiny; the copy-on-write, rename, hardlink, whiteout and
  opaque-dir semantics come from the kernel, which has had them right for a decade.
- **Commit** = the overlay's upper dir *is* the diff: regular files → hash + upload if the server lacks the blob;
  char-device 0/0 → delete; `trusted.overlay.opaque` dir → drop the base's subtree. Optional `outputs` filter keeps
  only listed paths (the "only listed outputs are uploaded" mode). Committed blobs are written through into the host
  cache, so a fork of the commit starts 100% warm on that host (measured).
- **Fork** = copy the manifest (a metadata-only fork, as today). Because cache keys are content hashes, a fork shares
  every unchanged blob with its base in R2 *and* in every host cache.

What changes in camelRun: the job no longer gets `files`/`sync` (tar or host pull); it gets `{manifestUrl, blobBase,
token}`. The Volume DO needs (1) a manifest export at a pinned version (it already has `readSet(prefix, snapshot)`
and per-file sha256) and (2) a commit that takes a base version and a path-level diff and refuses or rebases on a
stale base (today's `commit()` is already all-or-nothing). R2 keys can stay as they are: the cache is keyed by sha256,
not by the R2 key, and the manifest carries both.

### Git-compatible hashes

Worth adding, not worth making the primary key. Store `gitSha1` (SHA-1 of `"blob <n>\0" + bytes`) next to sha256 at
commit (one extra hash pass over bytes we already read). A manifest then maps 1:1 onto git tree objects, computed on
demand, so a GitHub mirror is "push the commit, trees and the blobs that changed since the last mirrored version":
the diff is known from the manifest diff, no git server, no packfile store. History = the chain of `base` manifests.
Keep sha256 as the cache and integrity key (SHA-1 is not collision-safe for a shared cache).

## Consistency

- A job mounts **one immutable manifest version**: perfect snapshot isolation, no cache coherence problem at all
  (a blob at a hash never changes, so the kernel can cache attributes and data for an hour: `AttrTimeout`/`EntryTimeout`
  are 1 h and `FOPEN_KEEP_CACHE` is set).
- Writes are invisible to anyone else until commit; commit is compare-and-swap on the base version in the DO. Two jobs
  forked from v7 that both commit: the second either fails (today's semantics) or is rebased path-by-path when the
  diffs don't overlap (cheap: diffs are path sets).
- This is deliberately **not** Archil's model (one live, strongly consistent POSIX disk with multiple writers and
  async write-back). We don't need live multi-writer sharing between jobs; we need fast, cheap, isolated snapshots,
  and immutability is what makes the shared cache trivially correct.
- Crash: a dead job loses its upper dir (nothing was committed). A dead daemon makes the mount return `ENOTCONN`
  loudly — not empty listings (the sprite-mount failure mode the sprites skill warns about), because the tree lives in
  the daemon and FUSE errors when it is gone. The job fails; it is never silently wrong.

## VM vs host (Firecracker)

Firecracker has **no virtio-fs and no 9p** (its devices are virtio-blk, net, vsock, balloon, entropy). So:

| option | how | verdict |
|---|---|---|
| A. FUSE in the guest, blobs over vsock | `camelfs` runs in the guest; its blob backend is the host agent over vsock, which serves from the host NVMe cache and fetches misses from R2 | **recommended**. One extra copy (host cache → guest), but the host cache is shared and the guest's page cache does the rest. Overlay is in the guest too, upper on the guest's own disk. |
| B. Host FUSE + virtio-fs | needs Cloud Hypervisor/QEMU (virtiofsd) instead of Firecracker | best perf (DAX can map host cache pages), but changes the VMM |
| C. Host builds a block image | erofs/ext4 per manifest from cached blobs, attach as virtio-blk | materializes the whole tree again (the thing we're avoiding); fine only as a cache of "hot base images" |
| D. erofs over fscache on-demand (Nydus-style) | kernel-native lazy blobs in the guest, a guest daemon fills misses | fastest warm path, much more machinery, ties us to erofs image building |

The sprite measurements are themselves "FUSE inside a Firecracker guest with the blob server on the same box", which
is option A with vsock replaced by loopback HTTP; the vsock hop adds ~0.1 ms per miss, nothing per hit.

## Security (hostile root guest)

The guest owns its FUSE daemon and overlay, so it can only lie to itself. What crosses the boundary is the vsock blob
protocol, and the host agent enforces:

- **Reads**: only hashes in the job's manifest (the host loads the manifest itself with the job's token; the guest
  never sees the token or R2 credentials). Otherwise a guest could probe the host cache by hash ("does anyone on this
  host have file X?").
- **Cache poisoning**: impossible by construction: the host verifies sha256 before a blob enters the cache, and the
  cache is 0444 and never exposed writable to a guest.
- **Writes/commit**: the guest streams files; the host re-hashes them (never trusts a guest-supplied hash), enforces the
  job's byte/file limits, and uploads. A guest cannot make a manifest point at a blob it didn't send or wasn't given.
- **Cross-tenant timing**: a fast fetch reveals another job on this host used the same content. The guest already has
  the content (it's in its manifest), so this only leaks co-tenancy. Default: partition the cache by tenant
  (`cache/<tenant>/ab/…`); public content such as `node_modules` could later go in a shared partition.
- On Cloudflare/sprite-style "the job is the whole machine", the same daemon runs in the container with the token
  scoped to that one manifest.

## Cache eviction

Content-addressed and immutable makes eviction safe at any time: unlinking a blob that a mount has open keeps the
open fd valid (Linux), and the next `open` simply re-fetches. So: a high-watermark sweep (e.g. 80% of NVMe → 60%) in
LRU order of last open (the daemon logs opens; `atime` is unreliable with `noatime`), and blobs pinned by a running
job's manifest go last. No refcounts, no coordination with mounts. Per-tenant quotas if one tenant crowds others.

## Cost

- **Egress/ops**: R2 has no egress fees; Class B (GET) ops are $0.36/M. Lazy reading fetches only what a job opens:
  a job that reads 10% of a 50k-file repo is 5k GETs instead of 50k; a warm host is 0. Today every job re-reads the
  whole tree from R2 (100k-file limit = 100k GETs, $0.036 per job start at the limit).
- **Host**: NVMe cache space (cheap; the job-host image already has NVMe) and one small daemon per job.
- **Runtime/Workers CPU**: today the Worker reads and checksums every file per job (camel-sync) or proxies every file
  (host-side sync); with presigned GETs (or the host fetching R2 directly) that cost leaves the Worker entirely.

## LOC we'd own

Prototype: ~1,150 lines of Go (`main.go`, `fs.go`, `cache.go`, `server.go`, `manifest.go`) incl. the fake server and
bench commands. Production estimate:

| piece | LOC |
|---|---|
| guest daemon (FUSE tree, open/fetch, passthrough, prefetch, large-file chunked/range reads, metrics) | ~1.5k Go |
| host blob agent over vsock (auth by manifest, cache, eviction, R2 client, commit upload with re-hash) | ~1.5k (TS in `jobhost/` or Go) |
| Volume DO: manifest export at version, CAS commit from a path diff, gitSha1 column | ~400 TS |
| guest image: fuse kernel config, overlay, init wiring | small |

Plus dependency: go-fuse (or Rust `fuser`). We delete `camel-sync.ts`'s tar path and `pullFiles`' per-file base64 NDJSON
writes (~300 lines) and the 100k-file / 4 GiB sync limits become "cache size" limits.

## Cloudflare containers (no host cache)

Each container is its own machine with an ephemeral disk, so there's no shared host cache. Three layers still help:

1. **Lazy still wins** for jobs that read a fraction of the tree (time to first command is a manifest fetch, not a
   tree copy) — CF containers support FUSE (Cloudflare's own docs mount R2 via FUSE), so camelfs runs in the container
   with its cache on the container disk.
2. **Prefetch at 32-way** recovers most of a full-tree read (measured below).
3. A **regional read-through tier** (a Worker using the Cache API, or a Durable Object/R2 in the same location)
   in front of R2 shortens each miss; container snapshot/restore can carry a warmed cache between runs.

But the headline win (warm host cache across jobs and forks) is absent there. Measured: a cold full-tree read with
prefetch 32 takes about as long as a 32-way parallel copy (large 33.5 s vs 33.9 s), so for read-everything jobs on CF
the mount only buys an earlier start; for partial-read jobs (tsc on the repo: 7.4 s vs 65.6 s) it is the whole win.

## Node and self-host

- The Node backend's volumes map the same way: manifest from its DB, blobs from S3/MinIO/a local dir. A self-host on
  one box points camelfs at a local blob directory, and forks become instant with zero copy and zero extra disk.
- Requirement: `/dev/fuse` and `CAP_SYS_ADMIN` (or `--device /dev/fuse --cap-add SYS_ADMIN` in Docker; rootless
  `fuse-overlayfs` as an alternative to kernel overlay). That's friction for self-hosters on locked-down hosts and
  impossible on macOS, so **keep today's copy path as the fallback** behind the same job API (`mode: copy|mount`).

## Better / worse than today

Better:
- Time to first command is a manifest fetch + mount (50–280 ms measured, 200 to 80k files) instead of O(files ×
  latency): 0.17 s vs 178 s (today's 6-way host pull) for the 50k-file tree.
- Jobs pay only for files they open; a warm host pays nothing; forks share cache.
- Commit uploads only the diff (the overlay upper dir) instead of re-reading anything.
- The 100k-file / 4 GiB sync limits go away (they exist because the tree is copied).

Worse:
- New moving part in the data path (a FUSE daemon), new failure mode (daemon crash → `ENOTCONN` for the job).
- Cold, read-everything jobs without prefetch are slower than a 32-way parallel copy: lazy fetching is gated by the
  reader's own parallelism (tsc reads serially). Prefetch fixes it, but it is a heuristic to tune.
- Firecracker forces the FUSE into the guest (option A) — a guest-side daemon and a vsock protocol to own.
- Needs privileges (FUSE, overlay) that a plain copy doesn't, which matters for self-host and Docker-in-Docker.
- Large single files (> ~64 MiB) want range/chunked fetches, which the prototype doesn't do (it fetches whole blobs).

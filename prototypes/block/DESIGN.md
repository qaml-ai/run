# Block volumes: kernel-level files on our own hosts

The most ambitious arm of the file-model prototypes: what camelRun's volumes should be when a job runs in a
Firecracker VM on a host we own (EC2 Graviton with local NVMe, [job-hosts-plan](../../docs/design/job-hosts-plan.md)),
and file access inside the VM has to be the kernel's own, not FUSE's. Numbers are in [RESULTS.md](RESULTS.md); the
runnable slice is `lazyblk/` (Go, ~900 lines), `fuse-loop/` (the FUSE baseline) and `bench/run.sh`.

The brief's hypothesis was: chunks in S3, a version is a block map, a lazy block device on the host with a host-wide
NVMe chunk cache, dm-thin copy-on-write for writes, ext4 over virtio-blk in the VM, checkpoints that upload new
chunks and publish a root, a file index per checkpoint for Workers/merge/git, and a volume server for VM-less
agents. Most of it survives; three parts change (the version identity, where Workers read from, and the warm path):

1. **The version is the file tree, not the block map.** A block map is a *materialization* of a tree: ext4 metadata,
   allocation and journal make the same tree produce different blocks on different hosts, so block identity is
   useless for merge, for dedupe across volumes, and for the git edge. The tree hash (git-compatible) is the id;
   each checkpoint publishes a tree *and* the block map that materializes it, and a tree may have more than one.
2. **Workers read files straight from chunks, with no host in the loop.** The index records each file's extents
   (ext4's own FIEMAP at checkpoint), so a Worker reads a file by fetching the chunks under its extents from S3.
   Measured: one file = one chunk GET (16 ms at 15 ms S3 latency). There is no always-on volume server for reads.
3. **Warm reads must not cross into userspace.** A userspace block device (NBD here, ublk in production) is the lazy
   path only. dm-clone hydrates the version into a local NVMe file in the background; once a region is local the
   kernel serves it without the daemon. Measured on this prototype without dm-clone, the first-touch NBD round trip
   is the whole overhead; after that the guest page cache and the thin pool answer.

## The shape

```
                     S3 (content-addressed; one bucket, per-tenant prefixes)
   chunk/<sha256>   256 KiB device chunks                 blob/<sha256>  files written from Workers (pending)
   root/<sha256>    block map (chunk hash per 256 KiB)    tree/<sha256>  file index: path, mode, size, sha256, extents
   head/<volume>    → { tree, root, parents }             (the Volume DO owns heads, pins, leases; S3 holds objects)
           ▲ checkpoint: new chunks + root + tree              ▲ Worker file commit: blobs + tree (no root yet)
           │                                                   │
 ┌─────────┴────────────── job host (EC2, XFS reflink=1 on NVMe) ────────────────┐
 │  lazy device daemon (ublk; NBD in the prototype)                               │
 │    block map in memory; read miss → chunk GET → host-wide cache (NVMe, by hash)│
 │    → serve + sequential prefetch                                               │
 │        ▲ read-only origin                                                      │
 │  dm-clone (designed, not run here): hydrate the version into a local NVMe file,│
 │    serve hydrated regions in-kernel, detach the daemon when complete           │
 │        ▲ read-only origin                                                      │
 │  dm-thin pool on NVMe: one thin per mounted version, external origin = above;  │
 │    writes are COW'd 256 KiB blocks in the pool; snapshot = fork = checkpoint   │
 │        ▲ /dev/mapper/vol-<job>                                                 │
 │  Firecracker virtio-blk (io_engine Async) ──► guest: plain ext4, no agent      │
 │  checkpoint: freeze guest fs → thin snapshot (ms) → thin_delta → hash changed   │
 │    chunks → upload new → FIEMAP-index changed files → publish root + tree      │
 └────────────────────────────────────────────────────────────────────────────────┘
          ▲ fork = create_snap (O(1), unlimited, shares pool blocks and cache)
 Workers without a VM: read by tree + extents + chunks; write = file commit (blobs + new tree, CAS on the head);
 the next host to mount materializes the pending file commits onto the nearest block root (write files, checkpoint).
```

### What each layer is for

- **Chunk store.** 256 KiB chunks (what the thin pool's data block is, so a COW'd block is exactly one chunk; Lambda
  uses 512 KiB). A root is 32 bytes per chunk: 128 KiB for a 1 GiB image, fine to fetch whole. Zero chunks are holes.
  A checkpoint uploads only chunks whose hash changed against the base root, after a HEAD (or a per-host "known in
  S3" bloom), 16 in flight.
- **Lazy device.** The only userspace in the read path, and only on a miss. The prototype's NBD server is 300 lines:
  newstyle handshake, concurrent requests per connection, 4 connections, single-flight per chunk, 4-chunk sequential
  prefetch. ublk is the same shape over io_uring with lower per-request cost and crash recovery (`UBLK_F_USER_RECOVERY`);
  AL2023 6.18 ships it as a module. NBD is a fallback that every kernel has (`-persist` reconnect).
- **dm-clone.** Not on the sprite kernel (`CONFIG_DM_CLONE` unset), so designed only. It takes a read-only source
  (the lazy device) and a destination (a sparse file on the NVMe), hydrates regions in the background with a
  configurable region size (256 KiB, aligned with the chunks), serves hydrated regions from the destination in the
  kernel, and can be told to stop hydrating. For a hot volume (a repo every job mounts) the destination becomes a
  complete local image and the daemon is detached; for a one-off job it hydrates what the job touches. Without it,
  the NBD round trip (~100 µs on top of a cache-file read) is paid on every first touch of a block per guest.
- **dm-thin.** The COW and snapshot layer, in every kernel, metadata on NVMe, `create_snap` for forks and checkpoints
  (measured: 11–60 ms create, 1.1 s for the `suspend` that flushes a dirty ext4; with the guest doing `fsfreeze`
  before the snapshot, the suspend is a no-op). `thin_delta` between the last checkpoint's snapshot and the new one
  lists exactly the changed blocks, so a checkpoint reads O(delta), not O(mapped). Many thins per pool, pool per host.
- **ext4 in the guest.** Mounted plain over virtio-blk. Nothing to install in the image; `fsfreeze` is the only
  cooperation (the `camel-guest` binary already runs commands). XFS would do too; ext4 was chosen because `-O
  ^inline_data` keeps every file's bytes in extents (needed for the Workers read path) and `tune2fs -U random` was not
  even needed: ext4 mounts a fork with the same UUID beside its origin (measured; XFS needs `nouuid`).
- **File index.** Walk the mounted snapshot; files whose `(size, ino, mtime, ctime)` match the previous index keep
  their hash and extents, the rest are hashed and FIEMAP'd. Measured: full 5k-file index 240 ms, incremental 30 ms;
  the index is the git tree (sha256 now; a git sha1 column costs one more hash pass at commit).
- **Workers read path.** `tree` + `root` + chunks. A 10 KB file is one GET; a file spanning chunks is a few, in
  parallel. No daemon, no host, no DO on the path; it works for every version ever checkpointed. The prototype's
  `lazyblk read` is this path.
- **Workers write path.** A file commit: blobs to S3, a new tree whose entries for those paths point at blobs (no
  extents), CAS on the head. It is a real version (readable from Workers, mergeable, exportable to git) with no block
  materialization yet. When a host mounts the lineage it takes the nearest ancestor with a root, mounts a thin
  snapshot of it, writes the pending files (ms for a few files; `cp` of the whole 50 MB tree is 1.8 s if it has to
  start from an empty image), and checkpoints. A fork of a file-only version does the same.
- **Merge.** Three-way on trees (the same diff3 the sibling prototypes measured, 38–117 ms on Workers), producing a
  file commit. Block maps never merge.
- **GC.** Reachability from heads and pins: tree → blobs, head/pin → root → chunks. Chunks are shared along a lineage
  only (a 3-file change kept 4,078 of 4,096 chunks); blobs dedupe across every volume by content. Sweep after a
  reachability pass, as the git prototypes' repack job does.

### Where the hypothesis was wrong, or needs a caveat

- **Block-level dedupe is a lineage property, not a fleet property.** Two volumes with the same tree built separately
  share no chunks. Forks, versions and checkpoints of one volume share nearly everything. That is the dominant case
  (every job of a repo is a fork of its head), and the file view gives the cross-volume dedupe.
- **ext4 metadata amplifies small checkpoints.** A 3-file (15 KB) change produced 18 changed chunks (4.5 MiB):
  journal, inode tables, bitmaps, directory blocks. Per-checkpoint cost is dominated by this floor, not by the edit.
  Mitigations: a journal placed in its own chunks so it is always the same few (`data=ordered` already keeps it
  small), checkpoint batching (every 30 s / at job end, not per write), and the file commit path for tiny Worker
  edits.
- **Small random reads pull 256 KiB.** A 10 KB file costs a 256 KiB GET. Measured on the tree walks it is cheap
  because ext4 packs a directory's files together and the prefetcher runs ahead: the 50 MB medium tree read cold
  through NBD fetched ~200 chunks for ~50 MB of data. Lambda's answer (chunk-level access-pattern prefetch learned
  per image) applies as is: record the chunk sequence of a job's first run, prefetch it on the next.
- **Versions must be checkpointed to be visible.** A running VM's uncommitted writes are not in any tree. Automatic
  checkpoints every N seconds (freeze + snapshot is milliseconds; the upload is asynchronous from the snapshot) bound
  the window; a job's end always checkpoints.
- **One live mount per lineage.** Two VMs on the same head would diverge silently; the model is fork + merge, as in
  every sibling design. A Worker writing while a VM holds the head goes through the VM (the guest agent writes the
  files), which is what happens today when an agent edits a file a job uses.
- **A userspace daemon is in the fault path.** NBD without `-persist`, or a crashed ublk daemon, means EIO in the
  guest. ublk's user-recovery mode and NBD's reconnect cover a daemon restart; a host death loses the window since the
  last checkpoint, as it does for any local disk.

## Alternatives weighed

| | lazy chunks + dm-thin (this) | ZFS/Btrfs per host + send/receive to S3 | file-level mount (FUSE, `proto/mount`) | git clone per job (`proto/gitsvc`, `gitapi`, `artifacts`) |
|---|---|---|---|---|
| in-VM file ops | kernel ext4, native (measured = local) | native | FUSE: 5–10× per op on metadata/open; passthrough helps reads only | native after the clone |
| first access on a cold host | ms (mount 130 ms + one chunk) | full `receive` first | ms | seconds (2–9 s for 50–500 MB) |
| fork | O(1) thin snapshot, shares cache | O(1) clone, one host | metadata copy | ref + index copy |
| cross-host lazy | yes, any version anywhere | no (a volume lives on one host) | yes | no (copy) |
| Workers view without a host | yes, by extents | no | yes (manifest + blobs) | yes (trees in DO) |
| merge | file-level on trees | no | file-level | git |
| dedupe | lineage (chunks) + fleet (blobs) | lineage, on one host | fleet (blobs) | fleet (objects) |
| maturity we lean on | dm-thin, dm-clone, ublk/NBD, ext4, FIEMAP: all in-tree | ZFS out of tree on AL2023; Btrfs in-tree | FUSE, overlayfs | git |
| what we own | ~8–10k lines (below) | send/receive orchestration, host affinity | ~3–4k | 2–3k |

ZFS/Btrfs is the mature local answer and the wrong distributed one: send/receive moves whole streams between hosts,
so "any machine mounts any version with no copy" is exactly what it cannot do, and host affinity becomes a scheduler
constraint. Its snapshot/clone primitives are what dm-thin gives us in-tree. FUSE is the right tool for the Workers
and laptop edges and a 5–10× tax inside the job (measured below; passthrough removes only the data copy, every
open/stat/create still crosses to the daemon). Git-per-job is the simplest thing that works today and costs seconds
per job that this design makes milliseconds; the git edge stays for import, export and mirroring.

### Block vs file, honestly

File-level stores (the sibling prototypes) are simpler, dedupe across the fleet, merge natively and are the Worker's
natural shape. Their cost is at the job: either a copy (clone/tar) or FUSE. Block-level is the only way to give a VM
native file ops *and* lazy, copy-free mounts of any version, and its costs are the ones listed above: a second view
to maintain, lineage-only dedupe, metadata amplification. The recommendation pairs them: the block layer exists only
on job hosts, the tree is the identity everywhere, and the index ties them.

## Consistency, concurrency, failure

- **A mounted version is immutable** (external origin, read-only), and a thin is private to its job. No cache
  coherence problem exists: the host cache is keyed by content hash and chunks are verified on fetch.
- **Checkpoint atomicity.** Chunks first, then the root and tree, then the head CAS in the Volume DO (`parent` must
  equal the head). A crash before the head CAS leaves unreachable objects for GC. The thin snapshot taken at the
  checkpoint is kept until the next one so `thin_delta` has its base.
- **Head CAS also serializes Worker file commits** against host checkpoints; a loser rebases (trees) or forks.
- **Host loss**: the job fails as it does today (lease lapse → `container_failed` → rerun by key); the rerun mounts
  the last checkpoint. **Daemon loss**: ublk recovery / NBD reconnect; the thin and the guest see a stall, not EIO.
- **Pool full**: dm-thin `queue_if_no_space` stalls; the host agent sizes pools from the NVMe and reports; a job's
  writes past its disk cap fail as `disk_low` (the existing isolation suite rule).
- **Security**: chunk and blob keys are per-tenant prefixes; a HEAD-based dedupe check leaks "this content exists"
  only within the tenant. Hosts hold presigned URLs per job, as the job-hosts plan already says.

## Cost

S3 standard: $0.023/GB-month (R2 $0.015), GET $0.0004/1k, PUT $0.005/1k. A 500 MB tree is ~2,000 chunks: a cold
mount that reads it all is ~$0.001 of GETs; a checkpoint of a typical change is tens of PUTs; the host cache makes
the second job of a repo on a host free. Versions cost only their delta (chunks) plus their tree (~200 bytes per
file; 10 MB for 50k files, so trees should be stored as deltas or chunked by directory past ~10k files). Hosts' NVMe
holds the cache and pools: `r8gd.4xlarge` has 950 GB, which is the warm set of hundreds of repos.

## Phased path from today

Today: a Volume DO with a manifest, R2 blobs per file, metadata forks, and jobs that tar the tree in and out.

1. **Tree as the version id (Workers only, no hosts).** Give the Volume DO's manifest a tree hash and a parent chain;
   file commits with CAS; three-way merge on trees. This is the shared ground of every sibling prototype and is
   required for everything below. (~1.5k lines; this branch has the index and diff pieces in Go, the DO has the rest.)
2. **Block materialization service on job hosts.** The host agent gains: build an ext4 image from a tree (an empty
   image + write files: 1.8 s for 50 MB, 20 s for 500 MB, once per lineage), chunk + upload + root; mount a root
   lazily (daemon + thin); checkpoint at job end (freeze, snapshot, delta, upload, index, head CAS). Jobs stop
   tarring. The daemon is NBD first (every kernel; `-persist`), ublk when the host image ships it. (~3k lines Go in
   the host agent's tree, plus ~1k TypeScript for roots/heads/indexes in the DO.)
3. **Hydration and warmth.** dm-clone destinations per version, cache eviction by LRU with pinning of hot repos,
   access-pattern prefetch per lineage, automatic checkpoints every 30 s for long jobs. (~1.5k.)
4. **Workers read by extents; file commits materialized lazily.** The Worker file API reads any checkpointed version
   from S3 by tree + root; Worker writes are file commits; hosts fold pending file commits in at mount. R2 blobs per
   file remain only for versions never materialized. (~1.5k.)
5. **GC and the git edge.** Reachability over heads/pins → trees/roots → blobs/chunks; git export from trees (sha1
   column), import by materializing a tree. (~1k.)

Total owned: roughly 8–10k lines with tests, half of it in the host agent. The kernel pieces (dm-thin, dm-clone,
ublk/NBD, ext4, FIEMAP, fsfreeze) are in-tree and stable; `thin-provisioning-tools` is the one userspace dependency.

## Open risks

- **dm-clone and ublk are designed, not run.** The sprite kernel lacks both (`CONFIG_DM_CLONE` unset, ublk a module
  without a modules tree). AL2023 6.18 has both; verify on the first real host (the job-hosts plan's slice 6 suite is
  the place). Nitro Sandboxes' Firecracker takes a host block device as a drive, so the stack sits under virtio-blk
  unchanged, but the `Async` io_engine against a dm device, and the 447k IOPS figure, need re-measuring on a thin.
- **Checkpoint floor.** 4.5 MiB per checkpoint on a 1 GiB image from ext4 metadata; on a 4 GiB image the inode tables
  touched grow with the directories changed, not the image. Measure the floor at 4 GiB and with the journal pinned.
- **Index/extent correctness.** Inline data, encrypted or compressed files, and files with unwritten extents would
  break the Workers read path; the mkfs options exclude the first two, and the index verifies the hash on read
  (`lazyblk read` does) so a mismatch is loud. A file written by a Worker and read by a Worker never goes through
  extents at all.
- **The two views must agree.** The tree is derived from the block image at checkpoint by walking the mounted
  snapshot; a bug there is a wrong file in the Worker view. The derivation is simple (stat, hash, FIEMAP) and the
  verification is cheap (hash on read).
- **S3 tail latency.** 15 ms was injected; real S3 first-byte is 10–30 ms with a long tail, and a cold job that reads
  a tree serially pays it per miss. Prefetch and hydration are the mitigations; the cache makes repeat jobs immune.
- **Pool and daemon lifecycle on hosts.** Per-job thins, snapshots kept for deltas, cache eviction, and pool sizing are
  new host-agent state that must be reconciled after a host restart (dm state is gone; pools are rebuilt from the
  cache, and in-flight jobs were already lost).

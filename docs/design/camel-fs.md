# camelFS: the file system for agents, on our own AWS machines

Status: design, 2026-11-12, revised the same day after an adversarial review and Miguel's substrate decisions. Docs
only; nothing here creates AWS resources (Miguel applies every AWS change himself). It supersedes the file half of
[swarm-workflows.md](swarm-workflows.md) Part 2 (the repository object, layers, search, git without a VM,
`camel-sync`), the disk half of [job-hosts-plan.md](job-hosts-plan.md) (S3 snapshots, host-side sync) and #869
(whole-disk snapshots, parked). The host, VM, enrollment and placement halves of the job-hosts plan stand; this
design runs on them, moved from Graviton + Nitro Sandboxes to Intel + nested KVM (§1.4).

Decided by Miguel: a full-stack system on AWS, dropping Cloudflare containers; a new service if that is what it
takes; ambitious; fast search and grep, kept simple (trigrams only); **nested KVM now, `.metal` later**; larger
instances are fine; and before any production build, a **usable end-to-end prototype** (§4) to home in on the
shape. Hard rule from the #869 security review: **never parse a guest-controlled filesystem on the host**, and bound
every decompress and unpack.

## The ideal, and what this design gives

| Ideal | camelFS |
|---|---|
| Every version is an immutable content hash | A version is a git-compatible tree id; a commit records it with parents and the agent, run and call that made it |
| Unlimited O(1) forks | A fork is one conditional write in the ref table; on a host it is a reflink of the image file (1.5 ms); nothing is copied |
| Real three-way merges | Tree merge over (base, ours, theirs): whole subtrees by hash, diff3 by lines where both sides edited a file, conflicts answered with both sides and nothing written; rename detection by stock `git merge-tree` at the edge when asked |
| Any machine mounts any version, no copy, lazily, at kernel speed, no FUSE | A warm host attaches the image file over virtio-blk, plain ext4 in the guest (measured equal to local); a cold host attaches a lazy origin (ublk; NBD fallback) hydrating through dm-clone into that same file. FUSE measured 5–10× on every metadata op and is used nowhere |
| Local-fast writes, durable quickly, automatic snapshots per turn or tool call | Writes hit the guest's ext4 on NVMe; every turn (or 30 s of dirtiness, or every tool call on lineages that ask) a checkpoint publishes a durable version: changed files as blobs, new trees, one commit, one fenced CAS, and a new root composed by reflink |
| Retention by reachability, no pins, TTLs or janitors | One rule: an object lives while a ref reaches it. Refs are owned (by a volume, a workflow, a job, a mount) and die with their owner. One generational collector, driven by S3 Inventory, that cannot delete what a concurrent write names |
| No size limits, at S3 prices | Blobs and chunks in S3 Standard ($0.023/GB-month); hot trees and commits in DynamoDB, cold generations packed to S3; nothing on a host is more than a cache |
| Git only at the edges | Objects are git's byte format with git's ids; clone, fetch, push, mirror and import are served by stock git on API nodes against a lazily materialized bare repo. camelFS's own paths never run git; agents may run git inside their VM on a `.git` the tree ignores |
| Reachable with or without a VM | One HTTPS API (file ops, commit, fork, merge, diff, log, blame, grep, tokens) in us-west-2; VM-less agents on Workers are clients; a branch has one writer at a time, fenced by an epoch in every CAS |
| Instant search and grep over any snapshot or fork | A trigram index built per content-addressed shard at checkpoint; a snapshot or fork composes shards it shares with its parents; queries run where the shards are cached |
| Full history, diff, blame and per-agent attribution | Every commit carries agent, run and call ids as trailers; blame resolves lines to the commit that wrote them; a true two-parent merge keeps an attempt's chain reachable |

Numbers come from the prototypes on `proto/block`, `proto/merkle`, `proto/gitapi`, `proto/gitsvc`,
`proto/artifacts-volumes`, `proto/mount` and `proto/search` (`prototypes/*/DESIGN.md`, `RESULTS.md`), from the
2026-11-11 Nitro Sandboxes spike, and from the job-hosts code on `main`. The three tree sizes they share: small 200
files / 1 MB, medium 5k / 50 MB, large 50k / 500 MB. Where a number was measured on a sprite's network disk rather
than NVMe, or with injected rather than real S3 latency, it says so; Prototype v0 (§4) re-measures every such number
on the real host.

## 1. Architecture

```
                 Cloudflare (camelRun Workers backend)            laptops, CI, GitHub
    agents' file tools, workflows, jobs(), computers       git clone / push, the console
                     │ HTTPS + per-ref tokens                         │
 ════════════════════╪════════════════════════════════════════════════╪═══════════════ AWS us-west-2
                     ▼                                                ▼
             ┌─────────────────── camelfs API tier (stateless, ALB, 2+ AZs) ───────────────────┐
             │ file ops · commit/fork/merge/diff/log/blame · grep · tokens · git smart HTTP     │
             │ routing to the host that holds a live branch · GC · import/export                │
             └──────────────┬──────────────────────────────────────┬────────────────────────────┘
                            │ IAM                                  │ mTLS, one port, API-tier SG only
     ┌──────────────────────┴───────────────────────┐   ┌──────────┴──────────────────────────────────┐
     │ Storage plane (managed, the only truth)      │   │ Hosts = job hosts = computer hosts           │
     │  S3  o/<sha1>     blobs (file bytes)         │   │  m8id/c8id (Intel, nested KVM, local NVMe)   │
     │      c/<sha256>   256 KiB image chunks       │◄──┤  camelfsd: images as XFS reflink files       │
     │      r/<sha256>   roots (chunk map per image)│   │   cold: ublk/NBD origin → dm-clone → file    │
     │      s/<sha256>   search shards              │   │   checkpoint: freeze → stream → reflink →    │
     │      g/<gen>      cold-generation tree packs │   │     FIEMAP delta → chunks → root → CAS        │
     │      p/<commit>   cached clone packs         │   │   host-wide NVMe cache (chunks, trees, shards)│
     │  DynamoDB refs (fenced CAS) · trees+commits  │   │  Firecracker on KVM: virtio-blk, vsock,       │
     │      dirty rows · touches · warm-host hints  │   │   memory snapshot/restore                     │
     └──────────────────────────────────────────────┘   │   guest: ext4 + camel-guest (walk, stream)    │
                                                        └──────────────────────────────────────────────┘
```

Three parts, one binary:

- **The storage plane is managed services only.** S3 holds the bytes; DynamoDB holds every mutable fact (refs,
  dirty rows, touches) and the hot content-addressed objects (trees, commits). No host holds truth. A published
  version has RPO 0; a host can be terminated at any moment and the system loses only the unpublished part of the
  current turn on the branches it held live.
- **`camelfsd` runs in two roles.** `api` on a small stateless tier behind an ALB (what Workers, laptops and git talk
  to); `host` on every VM host (image files, the lazy origin, the cache, checkpoints, search indexing). Same Go
  module, same object and tree code.
- **Hosts are the job hosts.** The job-hosts plan's fleet gains the host role and the long-lived computers move onto
  it, replacing Cloudflare containers. The NVMe is the image store and the chunk cache.

### 1.1 Objects and versions

| object | id | where | bytes |
|---|---|---|---|
| blob | git SHA-1 of `blob <n>\0` + bytes, checked with sha1dc at ingest | S3 `o/<sha1>` | raw file bytes (header implied); multipart past 64 MiB; range reads |
| tree | git SHA-1 of git's tree encoding | DynamoDB `objects` (≤ 400 KB; a tree past that is an S3 object with a DynamoDB stub, and every walker follows stubs) | git's exact tree bytes |
| commit | git SHA-1 | DynamoDB `objects` | git's commit bytes: tree, parents, author `agent:<id>` / `user:<id>` / `job:<id>`, committer `camelfs`, trailers `Camel-Agent`, `Camel-Run`, `Camel-Call`, `Camel-Workflow` |
| chunk | sha256 | S3 `c/<sha256>` | 256 KiB of an image (Lambda uses 512 KiB); all-zero chunks are holes and are never stored |
| root | sha256 | S3 `r/<sha256>` | sparse map: (offset → chunk hash) for every non-hole 256 KiB of one image, plus `{ tree?, parentRoot, virtualSize, fsType }` |
| search shard | sha256 | S3 `s/<sha256>` | trigram postings for ~64 MB of content (§1.7) |
| generation pack | generation id | S3 `g/<gen>` | the trees and commits of a closed generation, with an index (§1.9) |
| clone pack | commit id | S3 `p/<commit>` | a git pack of one commit's tree, built on first clone |

**The tree is the identity of a workspace version.** `proto/block` tried block maps as the version and found what
Lambda found: a block map is a *materialization* of a tree (ext4 metadata, allocation and journal make the same
files produce different blocks on different hosts), so it is useless for merge, dedupe across volumes and the git
edge. A version is its tree; a root is a cache of one way to lay that tree out on a disk, and a tree may have zero,
one or several roots. A version without a root is still complete: readable, forkable, mergeable, exportable. A host
that mounts it applies the delta from the nearest ancestor that has a root, inside the guest (§1.3).

**What the tree contains: the ignore policy.** The tree holds the workspace's tracked files: regular files, their
exec bit, and symlinks, as git's trees do. It excludes a lineage-level ignore list, by default `.git/` and the
lineage's `.camelfsignore` (the same syntax as `.gitignore`; typical: `node_modules/`, `target/`, build outputs).
Ignored paths exist on the image (the root) and survive across sleeps, wakes and forks on hosts; they are not
versions, not searched, not exported, and are lost when a version has to be rebuilt from its tree alone. uid/gid,
mtimes, xattrs, device nodes and empty directories are likewise image-only. The image is the whole disk; the tree is
the part that has meaning across machines. A job's `outputs` are read from the image, never from the tree.

**Image lineages are block-only.** A base image (kernel, rootfs, toolchains) or a warm build snapshot
(`saveSnapshot: "bun-rust-warm"`) is a lineage whose versions are roots with no tree: it forks, mounts lazily, is
checkpointed and garbage-collected like any other, but it has no merge, no search and no git edge, because an OS
needs what a git tree cannot carry. A workspace lineage has both views; an image lineage has one.

**Git's ids, git's bytes.** Trees and commits are stored as git encodes them (`proto/merkle` verified byte equality
with `git write-tree`), so export is a copy, every tool reads the result, and `git fsck` is a check we can run.
sha1dc at ingest refuses collision-attack objects, as GitHub does. Gitlink entries (submodules) are refused at import
and never produced; symlinks are stored as git stores them and never followed by any walker. Chunks and roots are
not git objects and use sha256.

**Dedupe.** Blobs dedupe across the whole fleet by content; chunks dedupe within a lineage (a 3-file change kept
4,078 of 4,096 chunks) and almost never across lineages. The API never reveals existence: a write may reference an
object by id without bytes only when that object is reachable from the caller's own refs, so one tenant cannot ask
"does anyone have this file". No code path anywhere checks existence and then skips a write without recording a
touch (§1.9).

### 1.2 Refs, leases and the working layer (DynamoDB)

| table | key | holds |
|---|---|---|
| `refs` | `lineage`, `name` | `commit`, `tree`, `root?`, `owner` (`volume:<id>`, `workflow:<id>`, `job:<id>`, `cache:<key>`, `mirror:<remote>`), `expiresAt?`; the lease when a VM holds the branch: `holder` (host id, host boot epoch, mount id), `leaseEpoch`, `leaseDeadline`; `dirtySeq`; `createdAt`, `updatedAt` |
| `dirty` | `lineage#name`, `path` | the working layer of an API-held branch: `blob` (inline ≤ 256 KB, else S3), `mode`, `deleted`, `seq`; folded by checkpoint |
| `objects` | `id` | trees and commits (content-addressed; a put is unconditional and idempotent), `generation` |
| `touch` | `id` | an object named by id without bytes since the last mark began (§1.9); TTL = 2 × grace |
| `warm` | `lineage`, `host` | the image files this host holds, with the host's boot epoch, for placement |
| `lineages` | `lineage` | tenant, kind (`workspace` / `image`), quota, default branch, durability cadence, ignore list, last mark |

A **lineage** is a volume plus everything made from it (forks, job views, cache entries, mirrors); it is the
DynamoDB partition key and the unit of chunk sharing. DynamoDB's adaptive capacity splits a hot partition, so a
swarm's thousand forks of one lineage are a burst it absorbs; a single branch is bounded by its one writer, not by
the table. A **ref** is a name → commit inside a lineage.

**Every ref update is one fenced conditional write.** The condition names the expected `commit` **and** the lease
state the writer believes in: an API writer requires `holder` absent; a host requires `holder = me` and
`leaseEpoch = the epoch it took`. A merge that moves one ref and deletes another is one `TransactWriteItems`. A host
that was partitioned from DynamoDB, lost its lease and comes back late fails its CAS on the epoch; it cannot land a
version on a branch another mount has since taken (which gets a new epoch), and it cannot split the branch. A host
that reboots gets a new boot epoch, and every lease carrying the old one is dead on sight. There are no other locks.

**One writer per branch, fenced.** A branch is held either by a VM (`holder` names the host and mount; the host is
the writer) or by nobody (the API is the writer, through `dirty`). The rules, all of them:

- Taking the lease: `holder` absent and `dirtySeq = foldedSeq` (no unfolded working-layer rows); a mount of a branch
  with dirty rows checkpoints them first through the API, then takes the lease. A write racing the lease put is a
  transaction `{ ConditionCheck refs.holder absent, Put dirty, Update refs.dirtySeq }`, so it either lands before
  the lease (and is folded by the pre-mount checkpoint, which the host re-checks with a strongly consistent read
  after its lease put) or fails.
- While held, **every operation on the branch is routed to the holder or refused**: reads and writes are forwarded
  to the host and executed in the guest by `camel-guest` (a write's `expectBlob` is checked in the guest against
  the file's current hash, so edit tools keep read-modify-write safety); a merge *into* a held branch is refused with
  `held` (the workflow merges when the mount ends, or forks); a fork *of* a held branch triggers a checkpoint first
  (so "fork is 30 ms" is true of unheld branches and "a checkpoint plus 30 ms" of held ones). A forwarded write is
  durable at the next checkpoint, not before; §1.11 says so.
- A lease is renewed by the host's heartbeat; a lapsed lease (deadline passed) is taken over by the next mount, whose
  new epoch fences the old holder. The dead host's unpublished turn is lost.
- A host-side watchdog drops every lease the host holds when `camelfsd` has been down, the lazy origin has stalled
  past 30 s, or the image store is over its watermark, so the owner re-places instead of waiting on a wedged host.
- Prototype v0 (§4) implements the fence and the refusal but **no forwarding**: the API writes only to unheld
  branches, and reads of a held branch answer the last published version, labelled stale.

**Why DynamoDB, not Aurora or a Durable Object.** A DO would put the truth in another cloud from the hosts that need
it on every checkpoint, and Miguel decided on AWS. Postgres (camelRun's Node backend already has one) would work:
CAS is `UPDATE … WHERE commit = $old`, transactions are free, GC marks are SQL. It costs an instance to size and
fail over (the RDS swapping and ~4-minute failover we have lived through), and at 100× it becomes a sharding project.
DynamoDB gives conditional writes, transactions, single-digit-millisecond reads, point-in-time recovery and on-demand
scaling with no instance to run; the data is key-value shaped (refs, rows, content-addressed objects), so losing SQL
costs nothing on the hot path. The one thing it makes harder, enumerating objects for GC, is done from S3 Inventory
(§1.9). Trees and commits live here rather than in S3 because they are small, hot and latency-bound: the
`artifacts-volumes` prototype measured the split between a database index and object storage for blobs as the
difference between a 5 s and a 65 ms one-file commit on a large tree (its v1 kept packs and the fetch walk in R2;
its v2 moved trees and commits into SQLite). WCU is per KB, so a top-level tree of 2–3 KB is 2–3 WCU; the cost
section counts it.

### 1.3 Hosts: image files, the lazy origin, the checkpoint contract

The host stack is deliberately the one the job-hosts code already runs for a warm image, plus a lazy path for cold
ones. dm-thin, which `proto/block` measured, is not used: XFS reflink gives the same copy-on-write and snapshot
primitives on plain files, the job-hosts image already formats the NVMe `reflink=1`, and a file is what Firecracker
and dm-clone both take.

**Warm host (the common case: the host holds the image file of the branch's root or an ancestor).**

1. `cp --reflink=always <image> <mount>.img` (1.5 ms at any size), an XFS project quota on the mount's directory
   sized to the lineage's quota, then the file attached to Firecracker as virtio-blk with `io_engine: "Async"` and
   `cache_type: "Writeback"` (not the default `Unsafe`, which drops the guest's flushes; a snapshot under a frozen
   guest must see every byte the guest flushed).
2. If the requested tree is newer than the image's tree (a Workers-written version, a merge), `camel-guest` applies
   the delta between the two trees **inside the guest** before reporting ready: it fetches the changed blobs through
   the host (which proxies S3 and verifies hashes) and writes them with the tracked mode bits. A few files take
   milliseconds; a whole 50 MB tree into an empty image took 1.8 s and 500 MB ~20 s in `proto/block`, once per
   lineage. No root is ever built by the host. **The host never mounts, parses, grows, shrinks or checks a guest
   image**: no `e2fsck`, `resize2fs`, `dumpe2fs`, `debugfs` or libext2fs on the host, ever. Online growth is
   `resize2fs /dev/vdb` in the guest; space reclamation is `fstrim` in the guest with virtio discard on (a discard
   punches a hole in the file; a hole reads as zeros, which is correct for free blocks; roots encode holes as absent).
3. The guest mounts ext4 (`-O ^inline_data`, `data=ordered`, the journal in its own region so it dirties the same few
   chunks every time) and runs.

**Cold host (the image file is absent).** The host creates a sparse destination file of the image's virtual size,
exposes it as a loop device, and builds `dm-clone(source = lazy origin, destination = loop, region = 256 KiB)`. The
lazy origin is `camelfsd`'s ublk device for that root (NBD over a Unix socket on kernels without the module; the
prototype's measured device): a read miss fetches the chunk from the host cache, else from S3 (single-flight per
chunk, 16 in flight, 4-chunk sequential prefetch, plus the lineage's recorded access pattern from its last cold
mount, as Lambda does). dm-clone serves hydrated regions in the kernel and hydrates the rest in the background
(`hydration` off for one-off jobs that should pay only for what they touch; on for computers and hot images); when
hydration completes the file is a complete image and the next mount is a warm mount of a plain file. The VM attaches
the dm-clone device for this mount. If dm-clone fails on the real host (it is designed, not yet run; the m8id host's
kernel 7.0 has it), the fallback is full pre-hydration into the file before boot: a 500 MB image at S3 throughput is
a few seconds, and only cold hosts pay it.

**Measured on `proto/block`** (NBD + dm-thin on a sprite whose local disk read at ~90 MB/s; no NVMe, no KVM): per-op
latency on 2,000 small files equal to local ext4 on that disk (create 33 vs 34 µs, stat 9.0 vs 9.3 µs, warm read
10.3 vs 10.3 µs); a cold full read of the 500 MB tree 3.0 s at 15 ms *injected* per chunk GET with prefetch (that
disk's own cold read was 5.5 s); mount cold 130 ms (small) to 1.9 s (large); first file 26–79 ms; metadata-random
reads with a cold page cache ~3× slower through the userspace device than local (`grep -r` 33 s vs 11 s on the
large tree), which is what kernel-served hydration is for. Real S3 first-byte is 20–40 ms p50 with a p99 past
100 ms, so cold `ls -R` of the large tree is 10–15 s rather than the measured 7.8 s until the access-pattern prefetch
covers it; a warm host pays none of it. Against real NVMe the "equal to local" claim is a v0 measurement (§4).

**The checkpoint contract: the tree and the root are the same state, always.** A checkpoint of a held branch:

1. `camel-guest` **freezes** the filesystem (`fsfreeze -f`; reads continue, writers block, dirty pages and the
   journal are flushed) and, under the freeze, walks the tree: every tracked path's `(ino, size, mtime, ctime, mode)`
   against the last published index, which gives the dirty set exactly (modified, created, deleted, mode changes,
   directory renames). The walk is the truth; fanotify is a later optimization to skip it, not a replacement, because
   it misses `FAN_ATTRIB`, `MAP_SHARED` writers that never close, and children of renamed directories. `proto/block`
   measured an incremental index at 30–80 ms for 5–10k files; a 100k-file walk is ~1–2 s under the freeze. Files
   written through `MAP_SHARED` mappings that have not been `msync`ed carry a stale mtime; they are caught at the
   next checkpoint. Known gap, documented to agents.
2. Still frozen, the guest **streams the dirty files' bytes** over vsock. **The host hashes what it receives** (never
   a guest-supplied hash), bounded by the mount's quota, and PUTs the blobs. The freeze lasts for the stream: milliseconds
   for a tool call's few files, seconds for a `git add`-sized change, with the agent's processes blocked on writes
   only. The freeze is the window; there is no thaw-then-stream and no convergence loop.
3. Still frozen, the host **flushes and snapshots the image**: Firecracker's `Writeback` fd has been `fsync`ed by the
   guest's freeze flush; the host `fsync`s the file once more and takes `cp --reflink=always <mount>.img
   <snapshot>.img`. The copy is instantaneous and shares every extent.
4. The guest **thaws**. Everything after this point is off the agent's path.
5. The host **publishes the file tier**: the trees on the changed paths (3–5 tree objects for a one-file edit, read
   from its tree cache), one commit with the attribution trailers, and the fenced ref CAS. This is the **durable
   version**: every later reader, Worker, merge, search and git export sees it.
6. The host **publishes the root**, coalesced (every 30 s and at mount end; `durability: "call"` lineages do it per
   checkpoint): FIEMAP on the live image just before step 3 listed the extents **not shared** with the previous
   snapshot, which are exactly the ranges written since it (every extent is shared right after a reflink and a CoW
   write makes a private one); the host hashes those 256 KiB-aligned ranges from the snapshot file, PUTs the chunks
   S3 lacks (touching the ones it skips), writes a root `{ parentRoot, tree, offsets → hashes }`, and records it on
   the ref with the same fence. A reflink snapshot that fails to publish keeps the branch's previous root; the next
   checkpoint's delta is taken against the last *published* snapshot, so nothing is skipped.
7. Search shards for the changed files are built from the bytes the host already has (§1.7).

Because the tree is walked and streamed under the same freeze the snapshot is taken in, and the root is derived from
that snapshot, a root's tree is the tracked view of exactly that image. A guest can only make them disagree by lying
about its own files, which hurts only its own lineage. A periodic verify job (mount a sample root in a sacrificial
VM, walk, compare to the tree) catches drift from bugs on our side.

**Cadence.** A durable version **per turn, or after 30 s of dirtiness**, whichever first, and always before a fork,
a job, a merge, a sleep and at mount end. A lineage may set `durability: "call"` (a checkpoint at every tool call;
the freeze-stream is milliseconds for the usual few files) for interactive computers; the default is open (§6).
There are no host-local snapshots that are not versions: a version is the only thing a fork, a rollback or a job
can name, and rollback is a fork from an older version mounted fresh.

**Cache and image store.** One NVMe directory per host, keyed by hash for chunks, trees and shards, and by root id
for image files, shared by every tenant on the host; eviction is one LRU high-watermark sweep (80 % → 60 %) over
both, with the files of live mounts and their last published snapshot last. Decompress and unpack of anything (a
clone pack, an import tarball) is capped at the declared size and reserved in the budget before the first byte is
written. Nothing is pinned across hosts: an evicted image is re-hydrated lazily on the next mount. `m8id.4xlarge`
has 884 GB of NVMe (§1.4), the warm set of hundreds of repositories. A hostile guest cannot reach the cache: its
block device maps only its own image file (or its root's chunks through dm-clone), verified by hash when they entered
the cache.

### 1.4 The VM substrate: Firecracker on nested KVM now, `.metal` later

**Decided (Miguel, 2026-11-12): nested KVM.** The job-hosts work to date targeted Graviton (`r8gd`/`c8gd`) in
Nitro Sandboxes mode, where the host has no `/dev/kvm` and Firecracker runs through the Nitro Enclaves driver. The
facts that decide it, from Firecracker's `docs/nitro-sandboxes/comparison-with-kvm.md` and AWS's announcements
(verified by `proto-block` and by the v0 host):

| capability | Nitro Sandboxes (Graviton or Intel, no KVM) | Firecracker on KVM (nested now, metal later) | Cloud Hypervisor on KVM |
|---|---|---|---|
| virtio-blk backed by a host file **or block device** (dm-clone, ublk, NBD, loop) | yes, `io_engine: Async` | yes | yes (`--disk path=/dev/mapper/…`, io_uring, multiqueue) |
| vhost-user-blk (a userspace chunk server feeding the guest directly) | **rejected** | developer preview: guest memory becomes a shared memfd, page faults up to 24 % slower, no snapshots with it | mature |
| virtio-fs (+DAX) | no: Firecracker has block, net, vsock, entropy only | no | yes, **without DAX** ("DAX is not available in Cloud Hypervisor"): a FUSE-class daemon path, 5–10× per metadata op in our measurements |
| memory snapshot / restore, pause | **rejected** (no snapshots, no paused state) | yes: 35 ms restore, 32 at once p50 235 ms in the spike on `r8id.4xlarge` | yes, plus live migration |
| hot-plug / hot-unplug of block and net | plug opt-in, **unplug rejected**, no `virtio-mem`, no balloon | plug and unplug, `virtio-mem`, balloon | yes, hotplug of everything |
| vCPU / memory | ≤ 5× the parent's vCPUs in all, memory donated whole at boot (no overcommit), 32 PCIe devices per sandbox | the host's, overcommittable | the host's |
| isolation | the Nitro System, not the parent kernel; guest CPUs are not parent threads | KVM + the jailer; a second VT-x layer under Nitro's | KVM + seccomp |
| instance families | Graviton (`*8gd`) and Intel; sizes from `.xlarge` | Intel 8th generation only: **`c8i`/`m8i`/`r8i` (2026-02) and, since the 2026-06 expansion to more Intel platforms, the `-id` local-NVMe variants** (our `m8id.4xlarge` in us-west-2 has `/dev/kvm`); **no Graviton, no AMD**; `.metal` sizes of the same families for later | same |
| cold start | 0.83 s at 1 vCPU, 2.3 s p50 for 32 at once, CPU-bound on guest boot | 0.8 s cold; a restore is 35 ms | ~0.8 s to first command in the earlier Kata spike |
| maturity | launched 2026-11-09 | the production Firecracker | production at several clouds |

So: Nitro Sandboxes support exactly the block device this design needs (a dm-clone or ublk device as virtio-blk is
supported "in direct and confidential modes"), and nothing else it wants: no memory snapshots (a computer's wake is
always a boot), no unplug, no overcommit, no balloon. Nested KVM gives memory snapshot/restore (a sleeping computer
wakes in tens of milliseconds, better than Cloudflare's p50 and without its 30 s tails), overcommit, and the same
Firecracker we already drive, at the price of a second virtualization layer whose overhead is **unmeasured by us**:
published nested-KVM numbers put compute-bound overhead in the low single-digit percent (VMCS shadowing, EPT) and
I/O-heavy workloads higher because every virtio exit crosses two hypervisors; the spike's x86 build never completed
(`nasm` missing), so Prototype v0 measures a Bun build, the fsbench table and virtio-blk IOPS under nested KVM against
the host (§4), and those numbers set the metal trigger. The supported-family list is checked with
`aws ec2 describe-instance-types` and its nested-virtualization filter before any launch template is written.

**Firecracker over Cloud Hypervisor.** The design needs virtio-blk on a host block device or file, vsock, memory
snapshot/restore and the jailer, and Firecracker has all of them, is what `jobhost/firecracker.ts` drives today, and
is what the spike measured. Cloud Hypervisor's extras (mature vhost-user-blk, virtio-fs, hotplug, live migration) buy
nothing the storage design uses: vhost-user-blk puts userspace on every request where the kernel path crosses to
userspace only on a miss; virtio-fs without DAX is FUSE; hotplug would let a running guest see a new snapshot, which
the per-turn checkpoint makes unnecessary. Cloud Hypervisor stays the fallback if a measurement shows vhost-user-blk
beating the kernel path, and `jobhost/vm.ts`'s `VmLauncher` seam is where it would plug in.

**What changes in the job-hosts work** (`#849` AMI and `#850` OpenTofu, both Graviton): the AMI becomes x86-64 AL2023
with the same kernel line, no `nitro_enclaves` mempool or `pcie_slots`, `kvm_intel` loaded, Firecracker's x86 build;
`jobhost/firecracker.ts` drops the `enclave:` block and gains snapshot/restore; the launch templates move to
`m8id`/`c8id` (local NVMe, the `d`), `EnclaveOptions` goes, the nested-virtualization option is set; the pricing table
in `jobs/host-pricing.ts` gets the Intel prices; memory is ordinary host memory, so the "whole host per build" rule
becomes a cgroup and `cpu_overcommit` becomes KVM's normal overcommit. The guest, the vsock protocol, the netns pool,
the egress proxy, the isolation suite, enrollment and placement are unchanged.

**Metal later.** The same AMI and stack run unchanged on `m8id.metal-48xl`/`-96xl` (KVM directly on the hardware, no
second layer). Triggers: the measured nested overhead on builds exceeds the metal price premium for the build pool,
or a pool's steady demand exceeds ~8 `4xlarge` hosts (a metal host packs more VMs per dollar and per NVMe). Blast
radius: a metal host holds tens of tenants' VMs; the design already assumes any host can die (leases, re-placement),
so the cost is a bigger simultaneous re-place, bounded by the warm pool.

### 1.5 VMs: jobs and computers on one substrate

Both run as Firecracker microVMs on the fleet, with the job-hosts plan's image, netns pool, egress proxy and
isolation suite. The difference is the lease:

| | job (`job()`, `job_run`) | computer (an agent's long-lived machine) |
|---|---|---|
| mounts | `/repo` ← fork of the named tree (a `job:<id>` ref); root disk ← the job's image lineage | `/workspace` ← the agent's branch (a lease); root disk ← the computer's image lineage |
| writes | into its image copies; `outputs` are read from the final image; with `commit: true` the `/repo` fork is checkpointed at the end | checkpoints per turn (or per call), durable versions |
| end | checkpoint if asked, drop the files, destroy; the fork is merged by the workflow or garbage | sleep = checkpoint, then a Firecracker memory snapshot (nested KVM) or destroy; wake = restore (tens of ms) or boot (0.8–2.5 s) |
| fork | freeze, reflink, a new VM, O(1) | the same; a child computer is a reflink and a boot (or a restore of the parent's memory snapshot, for a true fork of a running machine) |

**Wake, step by step**, since it is the number that matters for computers: take the lease (one conditional write,
fenced); fold or apply any `dirty` rows that landed while asleep (in the guest, before ready); reflink the image if
the host has it, else build the cold stack; restore the memory snapshot if one exists and the image is unchanged
since it was taken, else boot; report ready. Warm host, no dirty rows, memory snapshot present: well under a second.
Cold host: the cold mount plus a boot, 2–4 s. The sleep path waits for the root publish before it returns, so a wake
never has to rebuild from a tree.

**What computers lose by leaving Cloudflare containers:** nothing in kind. Cloudflare's restore was p50 200–350 ms
with 30 s tails on a cold host; here a warm restore is tens of milliseconds and a cold boot is seconds without a
tail. What they gain: an 884 GB NVMe host, 16-vCPU VMs, forks in milliseconds, every turn a durable version, a
workspace reachable from Workers while the machine sleeps, and volumes mounted in the machine (today's native
computer has no volume at all: "Files are separate from agent volumes").

### 1.6 The API for VM-less agents

`camelfsd api`, stateless, in us-west-2 behind an ALB (HTTP/1.1 from Workers: the 2026-10-24 Cloudflare→ALB HTTP/2
stall), 2 AZs, autoscaled on CPU. A request carries a token (§1.10) naming the lineage and the refs it may read and
write; the tier resolves the ref, reads `dirty` + trees from DynamoDB and blobs from S3 (an in-process LRU of trees
and small blobs in front), and answers.

| op | what it does | expected latency from a Worker (us-west-2 round trip ~20–60 ms included) |
|---|---|---|
| `read(ref, path)`, `stat`, `ls`, `glob` | `dirty` overlay over the tree; blob from S3; on a held branch, forwarded to the holder (v0: the last version, labelled stale) | 30–80 ms cold, ~25 ms for trees only; + the host hop when forwarded |
| `write(ref, path, bytes, expectBlob?)` | the `{ConditionCheck, Put, Update}` transaction of §1.2; per-path optimistic concurrency; forwarded when held (v0: refused) | 30–60 ms |
| `checkpoint(ref)` | fold `dirty` into trees, one commit, fenced CAS; two nodes folding at once are safe because each deletes only the rows it folded (`seq ≤ folded`) and the loser's CAS fails on `commit` | 50–150 ms |
| `fork(from, name, owner, ttl?)` | one conditional put; a held source is checkpointed first | 30 ms unheld |
| `merge(into, from, mode)` | three-way on trees in the API node; diff3 on co-edited text; conflicts → 409 with both sides, nothing written; clean → two-parent commit + transactional ref move; `into` held → 409 `held`; `renames: true` runs stock `git merge-tree --write-tree` on the materialized repo (§1.8) | 50–200 ms for a few changed paths; proportional to changed paths, not tree size |
| `diff`, `log`, `blame` | tree walk skipping equal subtrees; first-parent log; blame from history over cached blobs, or stock git for deep histories | 30–300 ms |
| `grep` | §1.7 | 20–100 ms |

Consistency: an unheld branch's readers see the last durable version plus its `dirty` rows; a held branch's readers
see what the guest sees when forwarded, and the last version when not. The result-cache key and every "is this the
same content" question use the tree id (today's key is the volume's `seq`, `workflow-results.ts:65`).

Placement: Workers are wherever Cloudflare runs them; the API tier is the one place they talk to. If the Node
backend or a self-host runs in another region, it runs its own camelFS (the whole system is one binary plus a
bucket and a table); cross-region replication of lineages is a later feature (S3 replication + a DynamoDB global
table), not a design change.

### 1.7 Search: trigrams per shard, composed per snapshot

Miguel: simple is better. Trigrams only: literal and regex queries with path filters; no symbol index, no semantic
or embedding search. Shape, as built and measured on `proto/search` (`prototypes/search/DESIGN.md`, `RESULTS.md`,
on an 8-vCPU sprite; an NVMe rerun is coming):

- A **shard** is an immutable, content-addressed set of blobs (~64 MB of content in a base build; its id is the
  hash of its sorted blob ids) holding document-level trigram postings (which blobs contain each trigram, not
  positions) over ASCII-folded text. The prototype also keeps a copy of the blob bytes in the shard for
  verification; in camelFS the verification bytes come from the host's blob cache, so a shard is postings only.
- A **snapshot's index** is its list of shard ids plus its path table (path → blob id, keyed by the tree); on open a
  **live mask** hides blobs in shared shards that this tree no longer references. A **commit** puts the blobs its
  parent's shards lack into one delta shard; the new manifest is the parent's shards (fully dead ones dropped) plus
  the delta. A **fork** is a ref to the same tree: no index work. A **merge** is the union of both parents' shards.
  Compaction folds small delta shards LSM-style; a shard lives while a reachable snapshot names it (the GC rule of
  §1.9, nothing extra).
- A **query** turns the regex into an AND/OR trigram query (codesearch's `RegexpQuery`), intersects postings per
  shard, applies the live mask and the path filters, verifies candidates on their bytes (find a required literal,
  run the regex on that line only), ranks, and stops at 2,000 matching blobs. A pattern with no literal trigrams
  scans candidates directly.
- Indexing runs **on the host at checkpoint** for held branches (the dirty files are in hand and hashed) and on the
  API node at checkpoint for API-held ones; the shards go to S3 and the host cache. A snapshot made from a GitHub
  import is indexed by the import job. Index lag is the checkpoint cadence plus milliseconds; an agent inside a VM
  greps its own disk with `rg` as today, and the index serves the API, the console and every other agent.

Measured (Kubernetes 283 MB of source; Linux 1.68 GB):

| | Kubernetes | Linux |
|---|---:|---:|
| trigram index as a share of source | 13 % (37.5 MB) | 11 % (178 MB) |
| full build | 4.0 s | 22.6 s (~110 core-seconds per GB) |
| incremental per commit: 1 file / 100 files | 4.5 ms / 36 ms | 3.6 ms / 38 ms (a 0.5–0.7 MB delta shard) |
| fork | 0.2–0.3 ms | 0.2–0.3 ms |
| compaction of small shards into one | 21 → 1 in 156 ms | 28 → 1 in 1.8 s |
| query p50 / p99, warm: literal | 21 / 57 ms | 16 / 38 ms |
| regex | 10 / 79 ms | 32 / 506 ms (the p99 is a full-scan regex with no literal, 460 ms) |
| path-filtered | 2.4 / 12 ms | 9 / 11 ms |
| ripgrep warm, same queries | 145–490 ms | 320–1,010 ms |
| `git grep` on the commit | 570–760 ms | 1.2–2.0 s |
| cold: index in a new process, page cache dropped / ripgrep cold | 1.9 s / 8.0 s | 1.8 s / 15.8 s |
| ripgrep over a cold FUSE lazy mount at 20 ms per blob: lazy / 32 prefetchers / warm cache | 72 s / 13.5 s / 2.5 s | 262 s / 60 s / 13.9 s |

So a query is 10–30 ms p50 at any size with no slowdown at 45 shards, 10–30× faster than warm ripgrep and two
orders faster than anything cold; indexing a turn's commit costs single-digit milliseconds per file; a fork costs
nothing. The last row is also the clearest statement of why grep over a lazy mount is the wrong design: the index
is the only thing that makes "instant over any snapshot" true.

Why not one index per lineage, mutated in place: forks and snapshots would each need a copy or a versioned index;
content-addressed shards make a fork free and an old snapshot searchable forever.

Three things the prototype makes explicit, and the design's answer to each:

- **Unsaved edits are invisible to the index until a checkpoint.** An API-held branch's `dirty` rows are few and in
  hand, so `grep` scans them directly and overlays the result on the index (a dirty path masks its indexed blob);
  a held branch's unpublished turn is reachable only inside the VM, where the agent's own `rg` sees it, or through a
  forwarded `grep` to the holder; and `durability: "call"` closes the window to one tool call. Before launch the
  dirty-row overlay is required; the forwarded grep comes with forwarding (phase 2).
- **A cap of 2,000 matching files** per query, as the prototype has; the answer says it was capped, and the agent
  narrows with a path filter.
- **Compaction** runs on the host or API node that made the delta, when a snapshot's delta shards pass a count
  (the prototype: 21–28 small shards fold into one in 0.16–1.8 s), and is itself just a new content-addressed shard
  the next manifest names; old shards die by reachability.

Targets, now measured rather than guessed: ≤ 50 ms p50 warm at any tree size; cold ≤ 2 s plus shard GETs; index
≤ 0.15× the text it covers; per-commit index cost proportional to changed bytes.

### 1.8 The git edge

Git never sits in camelFS's own paths. It exists at four edges, all served by API nodes running **stock git**
against a bare repository materialized on the node's NVMe from the object store (a streaming export, since the
objects are already git's; a lazily restored, evictable cache, never truth; a 100k-commit lineage takes minutes of
object reads the first time and is kept warm after):

| edge | how |
|---|---|
| clone / fetch (a laptop, CI, a job that insists) | smart HTTP `upload-pack` by stock git on the materialized repo; a pack per commit is cached in S3 (`p/<commit>`) so repeat clones of one head are one GET; protocol v2, shallow and partial clone come free with stock git (`proto/gitsvc`: cold clone of the large tree 17.9 s, blobless partial clone 5.1 s, delta fetch 0.18 s, all client-bound) |
| push (a person pushes to a camelFS branch) | `receive-pack` by stock git; a `pre-receive` hook checks the token's ref policy; the **`reference-transaction` hook in its `prepared` state imports the new objects into the store and performs the fenced ref CAS before git moves its own ref** (the `gitsvc` gate), so an acknowledged push is in truth and a failed CAS is a refused push, never a divergence; a non-fast-forward is refused unless the token says otherwise; gitlinks refused |
| mirror to GitHub (`push()`) | a thin pack of what GitHub lacks since the `mirror/github:<branch>` ref, sent to `git-receive-pack` with the App installation token the runtime mints (hosts' egress allowlist, as today); the mirror ref is both the next export's `have` and a GC root |
| import from GitHub | `git clone --mirror` on an API node into NVMe (bounded by the declared size), objects imported with sha1dc verification, trees landing byte-identical, history included (it is only objects); upstream sync is a fetch into `upstream/<branch>` and a camelFS merge |

The materialized repo also serves `git log -p`, `blame` over renames, `merge-tree` with rename detection and
`bisect` for histories too deep for the API's own walkers; those run as commands on the API node with the result
returned, never in an agent's VM.

### 1.9 History, attribution, GC

**History.** A branch's first-parent chain is its checkpoint history; an attempt (a workflow child's fork) merges
with two parents, so its own commits stay reachable and attributable after the merge; `log --first-parent` is the
default view and shows one commit per accepted attempt. Rollback is a new commit whose tree is an old tree; history
is never rewritten. A snapshot a user names is a ref `snap/<name>`. Hot trees and commits live in DynamoDB; a
lineage's **generation** closes when its oldest commits are older than 30 days and unchanged, and the closed
generation's trees and commits are packed into one S3 object (`g/<gen>`) with an index and deleted from DynamoDB,
so the table holds the working set and S3 holds history at S3 prices. Walkers (mark, blame, export) read packs
through the same object interface.

**Attribution.** Every commit's author is `agent:<id>` (or `user:<id>`, `job:<id>`) and its trailers name the run,
the tool call and the workflow. With per-turn checkpoints the `Camel-Call` trailer names the call that closed the
turn and a line is attributed to the turn; with `durability: "call"` it is the call. `blame(ref, path)` gives, per
line, the commit, the agent and the call; `diff` between any two trees is O(changed paths). A merge's second parent
keeps an attempt's intermediate versions, so "which turn introduced this line" survives the merge.

**GC: reachability, generational, safe by construction.** The rules, in the order that makes a wrong deletion
impossible rather than unlikely:

1. **No existence-check-then-skip, anywhere.** Trees and commits are put unconditionally (idempotent). A blob or
   chunk a writer wants to skip because the store has it is **touched** first (a `touch` row keyed by id, TTL twice
   the grace); the sweep never deletes an object touched after the mark it is sweeping from began. A `{sha}`
   reference in an API commit is the same touch.
2. **S3 versioning on**, noncurrent expiry at **35 days ≥ the DynamoDB PITR window** (35 days), so a wrong sweep, or
   a PITR restore of refs to a point before a sweep, is a restore of noncurrent versions, not data loss. The
   `objects` table's deletes are mirrored into the generation packs first, so a swept tree is in `g/` before it leaves
   DynamoDB.
3. **A sweep needs a fresh mark from every lineage.** The mark is per lineage and incremental: a lineage whose refs
   have not changed since its last mark keeps that mark (its live set, stored in S3 as a sorted id list per
   generation); a lineage whose refs changed re-marks only from commits newer than its closed generations' frontier,
   and a ref deletion or a history-horizon change re-marks the lineage whole. A lineage with no mark newer than the
   inventory being swept **blocks the sweep** (nothing is deleted) until it is marked; a new lineage is marked at
   creation. The sweep is the inventory minus the union of every lineage's live set, restricted to objects older than
   the grace (24 h) and not touched since the marks began.
4. Roots of a mark: every unexpired `refs` row's `commit` and `root` (and the root's `parentRoot` chain back to the
   lineage's base image root, so a delta root never loses its base), every `dirty` row's blob, every held lease's
   last published snapshot root, every `mirror/*` ref's history.
5. Owners: a workflow's end deletes every `owner = workflow:<id>` ref; a job's end deletes its `job:<id>` ref; a
   mount's end clears its lease; an expired `expiresAt` ref is dropped by the mark. There are no pins, no snapshot
   TTLs, no per-feature janitor: every lifetime rule is "the ref dies with its owner". What remains on hosts (the
   image LRU, memory snapshots, materialized repos, clone packs) is cache eviction, and losing any of it loses nothing.
6. The collector ships in **audit mode** (counts and samples, no deletes) for a week after every change to it, and a
   canary lineage with known garbage is checked after every run.

Cost scales with the working generation, not with all history: a mark reads the trees of commits newer than the
frontier (`proto/gitapi` measured 42 ms of CPU for a 5k-file lineage, 518 ms for 50k) and reuses closed generations'
live sets; the sweep is a sorted merge over the inventory (daily, a few cents per million objects).

### 1.10 Security and tenancy

- **Hostile root VMs** see a block device of their own image copy and a vsock to `camelfsd`. The vsock protocol is
  small (freeze/thaw, the walk result, file streams, delta apply, forwarded ops) and the host trusts nothing in it:
  it hashes what it receives, enforces the mount's byte and file quotas, bounds every message, and maps the guest's
  device to one image file. No S3 or DynamoDB credential, no token, no other tenant's address exists in the guest.
  **The host never parses a guest filesystem**, mounts a guest image, runs e2fsprogs over it, or unpacks anything
  without a size cap and a reserved budget.
- **Hosts** hold an instance role scoped to the bucket prefixes and tables, as the job-hosts plan's role is scoped,
  and enroll with the STS attestation already landed (`shared/job-host-attest.ts`). They accept one mTLS port from
  the API tier's security group and nothing from the internet.
- **Tokens** are signed by camelRun (HMAC or ES256, key held by the runtime and the API tier): `{ lineage, read:
  [ref globs], write: [ref globs], scope, exp, subject }`. A workflow child's token writes `fork/<effect>` and reads
  `main`; a job's token reads one commit and writes `job/<id>`; a laptop clone token reads one branch for an hour.
  The API tier is the authorization boundary; the storage plane is reached by nothing else. Revocation is a key
  rotation (two keys valid during rollover) or a short deny-list of token ids in DynamoDB. A token's shape is checked
  before any storage call; unauthenticated routes bound their body reads.
- **Tenancy in the data.** Lineages belong to tenants; the API refuses cross-lineage references unless both are the
  caller's; cross-tenant dedupe is invisible (§1.1). The host cache is shared and unreachable by guests; timing
  side-channels on cache hits would reveal co-tenancy of public content only, and a tenant may opt into a private
  cache partition.
- **Quotas** per lineage (bytes, files, refs, dirty rows, image virtual size) and per tenant; enforced on the host
  by an XFS project quota per mount, so one VM filling its image stalls itself and never the host or another tenant;
  refused loudly, counted in usage.

### 1.11 Durability, HA, sharding

| | value | why |
|---|---|---|
| RPO, published version | 0 | S3 (11 nines, versioned) and DynamoDB (3 AZs, PITR) hold it before the CAS is acknowledged |
| RPO, held branch | the current turn (≤ 30 s of dirtiness, or one call with `durability: "call"`); forwarded writes included | the window between checkpoints lives in the host's image file |
| RPO, API-held branch | 0 | every write is a DynamoDB row |
| RTO, API tier | 0 (multi-AZ, stateless) | any node serves any request |
| RTO, a lost host | the job rerun / computer wake on another host: seconds to boot plus cache warmth | nothing on a host is truth; leases lapse at their deadline (30 s) and the owner re-places; the host-boot epoch kills stale leases instantly on a reboot |
| RTO, S3 or DynamoDB down | checkpoints and API writes fail loudly; VMs keep running on **hydrated** images (an unhydrated region's read blocks until S3 answers); the host retries checkpoints with backoff and keeps its snapshots | no degraded "unreplicated" mode |
| AZ loss | hosts in other AZs continue; the API tier continues; in-flight VMs in the AZ are lost and re-placed | S3 and DynamoDB are regional |
| region loss | down | one region by design, next to the hosts; a second region is a copy of the whole system plus replication, a later decision |

Sharding is by lineage: DynamoDB partitions on it, chunk sharing stops at it, marks are per lineage, leases are per
branch. There is no shard map to operate and no shard to rebalance. The API tier is horizontal.

**Pages at 3 a.m., and the runbook each needs:** the daemon down or the lazy origin stalled on a host (the watchdog
has dropped its leases; drain and replace the host); the image store or the chunk cache over watermark with live
mounts pinned (evict, then drain); a lineage throttled in DynamoDB (adaptive capacity usually splits it; otherwise
the branch's writer is misbehaving, rate-limit the token); checkpoint failures accumulating on a branch (S3 or
DynamoDB errors, or a quota; the branch's dirty age is the metric); GC audit discrepancies (stop the sweep, keep
marking); a blocked sweep (a lineage without a fresh mark; mark it).

### 1.12 Observability

Through the runtime's existing alarms (CloudWatch, email to Miguel) and dashboards:

- per op: count, latency p50/p99, errors, bytes, by role and tenant; the ref CAS conflict and fence-rejection rates
  per lineage; forwarded ops and refusals on held branches;
- hosts: cache hit rate (chunks, trees, shards, images), chunk GET latency and tail, ublk/NBD queue depth and stalls,
  dm-clone hydration progress, image store and cache fill, checkpoint duration by step (walk, stream, fsync,
  reflink, publish, root), freeze duration, dirty bytes per mount, mounts and memory snapshots per host, watchdog
  trips;
- durable versions per agent-hour, dirty age at checkpoint, root publish lag;
- search: index lag (checkpoint → shard visible), query latency, candidate ratio;
- GC: live/garbage counts per run, bytes reclaimed, mark duration per lineage, blocked sweeps, audit-mode
  discrepancies;
- storage: bytes by kind and tenant, DynamoDB consumed capacity, S3 request counts by kind (the cost drivers).
No file contents or paths in telemetry; lineage and tenant ids only.

### 1.13 Cost

List prices, us-west-2, 2026-11: S3 Standard $0.023/GB-month, PUT $5/M, GET $0.4/M; DynamoDB on-demand $1.25/M
write units (per KB; transactions 2×), $0.25/M reads, $0.25/GB-month; the API tier on `c8g.large` ~$60/month each
(the API tier runs no VM and can stay Graviton); hosts are the job/computer fleet's cost, paid for compute, with the
NVMe cache free on top.

Baseline load ("today", the figure the prototypes share): 1,000 concurrent agents × 20 durable versions/hour,
~200 file writes/hour each, 1 M job and computer mounts a month, 0.5 TB live with history. At 100×: 100,000 agents,
50 TB.

| item | baseline | 100× |
|---|---:|---:|
| durable versions: 14.6 M/month × (~4 trees of 1–3 KB + 1 commit ≈ 10 write units, ~2 blob PUTs, 1 fenced CAS ≈ 2 units) | ~$220 DynamoDB + ~$145 S3 | ~$37k |
| API-held writes: 144 M/month, each a 2-item transaction (`dirty` row + ref counter) | ~$360 | ~$36k |
| touches: ~1 per skipped object, ~2 per version | ~$35 | ~$3.5k |
| root publishes: ~1/3 of versions, ~20 chunks each after the ext4 floor | ~$50 | ~$5k |
| mounts: 1 M/month, cold ≈ the image's touched chunks (hundreds of GETs to a full image's ~2,000), warm ≈ 0 | ~$80–400 | ~$8–40k |
| reads (Workers and API nodes, cache misses) | ~$50 | ~$5k |
| storage: 0.5 TB S3 (+ versioning tail) + the hot generation in DynamoDB (~5 KB of trees per version × 30 days ≈ 70 GB) | ~$12 + ~$18 | ~$1.2k + ~$1.8k |
| generation packs: history at S3 prices, ~70 GB/month growth at baseline | ~$2/month, cumulative | ~$160/month, cumulative |
| search shards (0.13× of text, delta shards per commit, compacted) | ~$5 | ~$500 |
| API tier: 2 × `c8g.large` + ALB | ~$150 | ~$2k (autoscaled) |
| GC: Inventory + Batch Operations + marks | ~$10 | ~$500 |
| **camelFS total** | **~$1,100/month** | **~$100k/month** |

For comparison at the baseline: Artifacts ≈ $2,560, Pierre ≈ $1,800 of storage alone at $3.60/GB-month, the
`gitsvc` fleet ≈ $800–900 with two stateful hosts to run, the Workers-only git server ≈ $160 but with every job
paying seconds of clone. At 100× the two DynamoDB write lines are the ones to engineer down (tree segments: one
item per checkpoint's trees, ~3× fewer units; a single-item working layer for small dirty sets, halving the other);
both are mechanical and neither is needed before 10×. A job or computer that checkpoints a build tree publishes only
tracked files, so a 10k-file `target/` costs nothing in blobs (the ignore policy) and ~tens of chunks in the root.

**The fleet, on metal or not.** The storage design does not care; the pool math does. `m8id.4xlarge` (16 vCPU,
64 GiB, 884 GB NVMe) is ~$1.0/h on demand; `m8id.metal-48xl` (192 vCPU, 768 GiB, ~11 TB NVMe) ~$12/h: the same
per-vCPU price, 12× the blast radius, better packing (one NVMe cache and one chunk fetch serves 12× the VMs) and
no nested layer. A warm pool of 2 × `4xlarge` is ~$1,500/month; of 1 × metal ~$8,800/month, which is why nested
first and metal when a pool's steady demand fills one.

## 2. Choices, made

**Block-level, file-level or hybrid: hybrid, with the file tree as the only identity of a workspace.** File-level
stores (`merkle`, `gitapi`, `gitsvc`, `artifacts`) are the Worker's natural shape, dedupe across the fleet, merge
natively and export to git for free; their price is paid at the VM, as a copy (2–18 s per job by size, every job) or
as FUSE (5–10× per metadata op, measured). Block-level is the only way a VM gets native file operations *and* a
lazy, copy-free mount of any version; its price is a second view to keep consistent (§1.3's contract), lineage-only
chunk dedupe, and ext4 metadata amplification at checkpoints (kept off the hot path by the cadence). The hybrid takes
the file tree as truth everywhere, keeps the image as a derivable cache that exists only on hosts, and makes image
lineages block-only rather than pretend a tree can hold an OS.

**Reflink files + a lazy origin + dm-clone, not dm-thin, not NBD alone, not virtio-fs + DAX, not ZFS/Btrfs.**
XFS reflink is the CoW and snapshot primitive the hosts already use (1.5 ms clones, measured on the spike), works on
plain files that Firecracker, loop and dm-clone all take, and gives change detection through FIEMAP's shared-extent
flag; dm-thin would add a pool to size, metadata to repair and a block-granularity delta for no gain. Firecracker
has no virtio-fs; Cloud Hypervisor's has no DAX, and either way every open/stat/create would cross to a daemon. ZFS
is out of tree on AL2023; Btrfs is in tree but, like ZFS, is a per-host filesystem: send/receive moves whole streams,
so "any host mounts any version with no copy" is exactly what it cannot do. ublk gives the lazy origin with io_uring
and crash recovery; NBD is the fallback for any kernel and the device the prototype ran; dm-clone gives kernel-served
hydration into the very file the warm path uses, and full pre-hydration is the fallback if it disappoints.

**Nested KVM now, metal later; Firecracker, with Cloud Hypervisor as the fallback.** §1.4.

**DynamoDB for refs, trees and the working layer; S3 for everything else, including cold generations.** §1.2, §1.9.

**A new service, in the camelRun repo.** camelFS is its own deployable (`camelfs/` in `qaml-ai/run`: the Go module,
the host and API roles, its OpenTofu under `infra/camelfs/`), not a library inside the Workers or Node backend:
it has a fleet role, an IAM boundary and clients in two backends plus laptops and git. It is not a separate
repository: the host agent, the guest, the job protocol and the runtime's client all move together, and a
cross-repo version dance is the opposite of how we ship. Go, because the three kernel-adjacent prototypes
(`lazyblk`, `camelfs` mount, `camelsearch`) are Go and ~4k lines of it already exist; the tree, merge and token
code is ported from the TypeScript prototypes once. Rust with `libublk` is the alternative for the device daemon
if Go's ublk path is painful; NBD keeps that decision from blocking anything.

**Stock git at the edges, our own trees in the middle.** Owning the tree store (commit, fork, merge, diff, GC) is
~2–3k lines in every prototype and is the part that must be ours: it is the agent's model. Owning a git wire
server is not: `gitsvc` showed stock git on a node gives v2, partial clone, bitmaps, merge-ort and fsck for free,
and `artifacts-volumes` showed the own-server's hardest parts (streaming pack parsing, delta resolution) buy
nothing an agent needs. So the edges shell out to git over a materialized cache, with the ref CAS inside git's own
transaction hook.

**Checkpoints are versions; there are no snapshots that are not.** The earlier draft kept host-local per-tool-call
snapshots that were not versions; the review showed they could not be turned into one without a VM and could make
the next checkpoint's tree disagree with the image after a rollback. Gone. Per-call durability is a cadence setting,
not a second mechanism.

**Trigrams only for search.** No symbol index, no embeddings: agents grep, and the simplest index that makes grep
instant over any snapshot is the one to run.

**One fleet.** The volume hosts are the job hosts are the computer hosts. A separate storage fleet would hold caches
that the compute could not use locally, and the whole point of the image tier is locality.

**Not chosen, and why:** Cloudflare Artifacts (1 GB/repo, 32 MiB/file, 33× R2's price, no server-side writes, no
partial clone); Pierre (OpenAI acquired it 2026-11-04; $3.60/GB-month; its ephemeral branches, preview merge and
ref-policy tokens are copied here); Archil/JuiceFS-style POSIX mounts (FUSE in the hot path, multi-writer semantics
we do not want); EdenFS/Sapling (the right ideas, a Meta-sized client to run inside every VM); Piper/CitC (the same
"snapshot is a number, mount anywhere" model, built on a filesystem server we would have to write; ours is the
block device plus the tree store); Nitro Sandboxes (no memory snapshots, no unplug, no overcommit, Graviton-shaped
pools we would have to rebuild anyway).

## 3. Integration with camelRun

What exists today, from the code on `main` (the survey is precise; line references are to that revision):

| camelRun today | on camelFS | code that goes |
|---|---|---|
| `Volume` DO (`backends/workers/src/volume.ts`, 1,050 lines): a `files` table with a volume-wide `seq` as version, bytes whole in R2 under `files/<tenant>/<volume>/<uuid>/<sha256>` (a fresh key per write, no dedupe), snapshots as a JSON array of the whole file list (16 MiB cap), `pins`/`forwarded_pins`, read-set claims, `gc_candidates` with a 1-day grace, a daily alarm; `list()` loads every row and `write()` calls it (O(files) per write) | a workspace lineage with a `main` ref; the agent's file tools call the API with the volume's token; snapshots are `snap/<name>` refs; `read`/`write`/`ls`/`glob`/`stat`/`edit`/`present_file` map one to one, `expectBlob` replacing `expectedVersion` | ~800 lines of the DO: everything but the HTTP surface and quota accounting (`storage-quota.ts`, `tenant-storage.ts`), which become a thin client; `file-upload.ts` (R2 multipart) |
| `Volume.commit` / `volume-commit.ts` (125): atomic multi-file commit, per-path version check, refuses any shared path | `merge(into: main, from: fork/<effect>)`: disjoint hunks of one file merge; overlaps come back with both sides | all of it |
| `volume-policy.ts` limits (256 MiB/file, 100k files, 1,000-file listings, 16 MiB read-all, 10k-file archives) | quotas per lineage; the listing and read-all caps stay as API page sizes; the archive is a clone or a tar streamed from a tree | the sync- and copy-shaped limits |
| `workflow-volumes.ts` (115): a pinned base snapshot with a 7-day TTL, a keyed fork volume `workflow:<wf>:<key>:<attempt>`, `commitFork` diffing by R2-key inequality, ≤ 1,000 changed files; `workflow-forks.ts` (62): `ForkJanitor` deleting forks at workflow end with 60 s → 1 h retries | `fork(main, fork/<effect>, owner: workflow:<id>)`; the workflow's end is one `deleteOwned(workflow:<id>)` | both, replaced by ~30 lines |
| `workflow-results.ts` (203): cache key = canonical args + `@base:<seq>`; `adopt` takes a fork over; 7-day TTL, 2,000 entries | key = `(tree, command, inputs)`; a cached result's fork is `cache/<key>` with `owner: cache`; adopt = one update | the adopt and fork-ownership paths (~50) |
| `jobs/camel-sync.ts` (150): the Worker reads every file from R2, builds a tar, pipes it to `tar -x` on the container's stdin, whole tree every job; `jobs/hosts.ts` `HostJob.files/fetch` + `host-sync-store.ts`: ≤ 16 MiB inline as base64 in the WebSocket, else a per-file manifest the host pulls six at a time in 4 MiB base64 pieces through the guest `files{append}` op; `JOB_LIMITS.sync` 100k files / 64 MiB per file / 4 GiB | `job({ at: ref|tree })` mounts a `job:<id>` fork (reflink or lazy); `outputs` are read from the final image; `commit: true` checkpoints the fork for the workflow to merge. Inline `files: {…}` keep the current path for the few-file case | `camel-sync.ts`, `host-sync-store.ts`, `HostJob.files/fetch` (`hosts.ts:712-755`), `pullFiles` (`jobhost/agent.ts:187`), the `sync` half of `WireJob` and the guest `files` op past inline sizes |
| `jobhost/firecracker.ts`: `cp --reflink=always base.ext4` + `truncate` + `resize2fs -f` on the host; the planned `job_snapshots` table, S3 `snapshots/` prefix and image LRU (plan slice 5, unbuilt); `#869` whole-disk snapshots (parked) | image lineages, roots and the host's image store; `saveSnapshot` is a checkpoint of the image lineage; placement reads `warm`; growth is `resize2fs` in the guest | the host-side `resize2fs`, slice 5 and #869 |
| `computers/objects.ts` `ContainerComputer` (a Cloudflare container per agent; `read`/`write` run `node -e` inside it, 1 MiB cap; disk persists only as container snapshots, 30-day TTL, no delete API; `idle: "sleep"` snapshots before stop), `provider.ts` snapshot/base/sleep/fork (lines 599–786), `native-fork.ts`, `child-fork.ts`, `microvm.ts` (Lambda, 1 vCPU / 2 GiB, no snapshot or fork), `remote.ts` connections (Boat fork 9.6 s for 1.7 GB) | one `MicroVmComputer` provider on the hosts: a lease on the agent's branch mounted at `/workspace`, sleep as checkpoint + memory snapshot, wake as restore or boot, fork as reflink + boot; `read`/`write` become file-API calls on the branch (forwarded while held) | the Cloudflare container provider and its `wrangler.jsonc` `containers` block at the end of phase 2; Lambda MicroVM and Boat once the fleet has run a month; the remote-connection fork path |
| `history-pins.ts` (21): attachment pins inherited by forks | an agent's attachments are a tree under `agent/<id>` | all of it |
| Node backend `src/volumes.ts` (1,192: 1 MiB content-addressed chunks under `chunks/<tenant>/<aa>/<sha256>`, `chunk_pins`, `chunk_touches`, `gc_candidates`), `storage-gc.ts`, `gc-verify.ts`, `pin-backfill.ts` | the same client over the same API | ~1,700 lines; one implementation for both backends |
| `workflow-jobs.ts` `PUSH_SCRIPT` (`git clone --depth 1`, replace the tree, `git add -A; commit; push` in a job) | the API's mirror edge with the App token | the job-shaped push |
| `grep` bounded to 1,000 files / 32 MiB (`GREP_BYTES`) | the index; unbounded | the bound |

Agents' tools do not change shape: `read`, `write`, `edit`, `ls`, `glob`, `grep`, `present_file` keep their names
and the "changed since you read it" check (blob id instead of version). New for agents: `history`, `diff`, `blame`,
`fork`, `merge` as tools on a repo-kind volume, and `job_run` on any volume. The SDK's `VolumeHandle` keeps its
surface with `version` meaning a tree id; `Mount` (`{ volumeId, path, mode, subpath }`, ≤ 16 per agent) is unchanged
and now also means "mounted in the computer".

Migration: new volumes are lineages from day one (`backend: "camelfs"` on the volume row); an existing volume
migrates on first touch or by a sweep: read its file table, hash each unique blob (sha256 today → git SHA-1; one
GET, one PUT per unique file, in a job for big volumes), write the tree, make a `snap/<name>` ref per snapshot.
Pins need no migration (forks are short-lived; a volume with live forks migrates after its workflow ends). When
every volume is a lineage, the old paths and R2 keys go.

What camelRun keeps owning: tenants, quotas and billing (camelFS reports bytes and ops per tenant), workflows and
their effects, placement and host enrollment (`JobHostRegistry`, the WebSocket protocol minus `files`/`sync`), the
tokens' minting policy, the console. camelFS owns bytes, versions, refs, mounts, search and the git edge.

## 4. Prototype v0: the usable one

Miguel's direction: before any production build, a great, usable end-to-end prototype we can use and iterate on,
to home in on the shape and prove it is much better than today. v0 is the smallest **integrated** system that
exercises the real shape end to end, on real hardware, with one real camelRun path on it.

**Target.** The `m8id.4xlarge` in us-west-2 (Intel Xeon 6975P, nested KVM, kernel 7.0 with ublk and dm-thin,
884 GB NVMe, the private bucket `camel-fs-proto-904534089871-usw2` behind a bucket-scoped instance role). One host;
sprites for the parts that need no KVM (the API, the tree store, search). A second EC2 host only if a two-host
question (cold mount of a root made elsewhere) cannot be faked by evicting the first host's cache.

**What v0 builds** (the real shape, in the real places):

| piece | v0 form |
|---|---|
| chunk and object store | the real bucket, the real layout (`o/`, `c/`, `r/`, `s/`); versioning on |
| refs with CAS | DynamoDB on-demand if the instance role may create one table; otherwise SQLite inside `camelfsd` behind the same four-call interface, swapped before v1. The fence (lease + epoch in every CAS) is implemented either way |
| hosts | `camelfsd host` on the m8id: image files on XFS reflink; mount = reflink; checkpoint = freeze → walk → stream → fsync → reflink → FIEMAP delta → chunks → root → fenced CAS, exactly §1.3; cold path = ublk (NBD if ublk misbehaves) → dm-clone → the file, with full pre-hydration as the switchable fallback |
| guest | `camel-guest` extended with freeze/thaw, the stat walk against the last index, file streaming, and the tree-delta apply before ready; Firecracker on KVM from `jobhost/firecracker.ts` minus `enclave:`, plus memory snapshot/restore for the computer path |
| file index | the tree, computed by the checkpoint; `ls`/`stat`/`diff`/`log` served from it |
| VM-less API | `camelfsd api` on the same host (or a sprite): `read`/`write`/`ls`/`glob`/`checkpoint`/`fork`/`merge`/`diff`/`log`; tokens; **writes only to unheld branches**; reads of a held branch return the last version, labelled stale |
| search | `camelsearch` from `proto/search`, trigrams only, indexing at checkpoint, `grep` on the API with path filters |
| git edge | export of a branch as a bare repo on the API node + `git clone` over smart HTTP by stock git (read only); push, mirror and import are v1 |
| camelRun integration | **`job()` on the hosts driver with `at: <volume>`**: the runtime's `JobDriver` sends `{ lineage, tree, token }` instead of `files`/`sync`; the host mounts a `job:<id>` fork and checkpoints it if `commit: true`; outputs come from the image. Second, if time allows: one agent's `/workspace` as a lineage on a computer VM on the host, through the `MicroVmComputer` provider's first cut (lease, sleep, wake, fork) |

**The v0 contract** (agreed with the runtime side). The job itself takes the path that already exists:
`HostsJobDriver` → `HostJob` DO → the host's WebSocket → the TypeScript `jobhost` agent on the m8id, which boots
the VM. Nothing new runs a job over HTTP; what is new is how the tree gets there and what the host does with it.

- **Runtime → `camelfsd api`** (from the Worker, through a tunnel in v0; a shared bearer; no inbound port, no
  enrollment): `POST /v0/trees` `{ lineage, parentTree?, files: { path: { sha256, mode? } } }` → `{ tree }`, or
  `409 { missing: [sha256] }`; `PUT /v0/blobs/:sha256?lineage=` with raw bytes, which the daemon hashes itself
  (refusing a mismatch) and keys by git SHA-1 while remembering the sha256 per lineage. The driver sends sha256
  references only (the Volume DO already has every file's sha256), uploads what is missing, retries. Bytes cross
  once per lineage; a tree is imported **once per snapshot**, cached on the Volume DO as
  `camelfs_trees(snapshot → lineage, tree)` (a job's `at` is always an immutable snapshot); the lineage is
  `<tenant>:<volume>`. This is the bridge until volumes are lineages; it is never per job.
- **Wire to the host:** `WireJob.camelfs = { lineage, tree, commit? }` replaces `files`/`sync` for a volume job;
  `WireResult.camelfs = { tree?, root?, warm, mountMs, applyMs, checkpointMs }`. The runtime sends `camelfs` only to
  a host whose `registered` message lists `features: ["camelfs"]`, so an old agent can never run a job against an
  empty `/repo` silently.
- **`jobhost` → `camelfsd host`** (localhost, a Unix socket): `mount { jobId, lineage, tree }` → `{ image, warm,
  mountMs }` (a `job:<id>` fork; a reflink if the image is local, else the cold stack); the guest applies the tree
  delta before ready (`applyMs`); `checkpoint { jobId }` → `{ tree, root, checkpointMs }`, driven through the guest
  freeze/stream protocol of §1.3; `release { jobId }`. `outputs` are read from the image after the run, as today.

**Who boots the VM.** `jobhost/` does, as it does today: the TypeScript host agent (`jobhost/agent.ts`,
`firecracker.ts`, `network.ts`, the guest protocol) keeps the VM lifecycle, the netns pool, the egress proxy and the
isolation suite. `camelfsd` (Go) owns storage only: mount, fork, checkpoint, release, the trees and blobs import,
the chunk cache and the lazy origin. The two share nothing but the image file's path. This keeps v0 from rewriting
the working VM code in another language, and it is the production split too: the job-hosts plan's agent stays the
host's control plane, camelFS is its storage service.

**What v0 deliberately skips:** HA and a second AZ; more than one host; GC **sweep** (the mark runs and logs what it
would delete, nothing is deleted); forwarded writes and reads (one writer, refusal otherwise); per-tool-call
durability (per turn only); generation packing; quotas beyond a per-mount XFS project quota; the ignore list beyond
`.git/`; merges with rename detection; push/mirror/import; the console; metering; polish of any kind.

**What v0 does not guarantee:** a held branch's reads from the API may be a turn stale; a write to a held branch is
refused, not queued; a host crash loses the current turn of every branch it held and every memory snapshot; nothing
is ever deleted from the bucket, so cost grows; one host means one failure domain; S3 or DynamoDB latency is in the
cold path with no prefetch tuning; the fallback (pre-hydration) may be what runs if dm-clone or ublk disappoint.

**Who uses it, and how ("usable"):** camelCode's review loop on the pilot runs its typecheck-and-test jobs on the
m8id through `job()` for a week, on a chiridion-sized tree, instead of Cloudflare containers; Miguel and the agents
working on camelRun use one computer each backed by a v0 lineage for their own work on the repo; anyone on the team
can `git clone` a branch to a laptop and `grep` it from the console. It is usable when a day of that work produces
no lost write, no stale read anyone noticed, and jobs that start faster than today's.

**What v0 measures, to decide the shape** (each against today's number where one exists):

1. job placement → first command, warm host and cold host, by tree size (today: a tar of the whole tree, seconds to
   minutes; the hosts plan's bar is ≤ 2.5 s cold at 32 in parallel);
2. the fsbench per-op table (create, stat, open+read, overwrite, unlink) in a Firecracker guest over a reflinked
   file on NVMe vs the host's own ext4 on the same NVMe, and again over dm-clone during and after hydration;
3. checkpoint by step (walk, stream, fsync, reflink, publish, root) for a 3-file change, a 500-file change and a
   `git add` of the whole tree, on the medium and large trees; freeze duration as its own number;
4. the ext4 chunk floor per checkpoint at 1, 4 and 16 GiB virtual sizes, journal pinned and not;
5. root composition by reflink + changed chunks vs dm-clone re-hydration for a per-turn-changing root (the number
   that decides whether dm-clone is only for cold hosts);
6. nested-KVM overhead: a Bun build and a Rust test shard in the guest vs on the host; virtio-blk IOPS and bandwidth
   in the guest over the file and over the dm device; memory snapshot restore time for a 2 GiB and an 8 GiB guest;
7. S3 real latency per chunk GET (p50, p99) from the host, and the cold full-read of the large tree with and without
   the access-pattern prefetch;
8. API latency from a Worker on the pilot for `read`, `write`, `checkpoint`, `fork`, `merge`, `grep`;
9. search: index time per checkpoint, index size vs text, query latency vs `rg` warm;
10. the mark's cost and output on a week of lineages (what it would delete; any false positive is a stop-ship for
    the sweep design).

**Exit criteria for v0 → v1:** criteria 1–3 beat today's path at every size; the per-op table is within 10 % of
native on NVMe after hydration; no false positive in 10; a week of the camelCode loop with no lost write. Then the
phases below start from v0's code, not from scratch.

## 5. Phases after v0

Each phase ships behind the previous one's API; each has a measurable bar and lists the AWS resources it needs
(all as OpenTofu under `infra/camelfs/` and `infra/job-hosts/`, applied by Miguel). These stay rougher than v0 on
purpose; v0's measurements will reshape them.

### Phase 1: production storage plane, API and the hosts driver (4 weeks). Beats today on every job

- The v0 code hardened: DynamoDB for real, the fence everywhere, `touch`, GC mark in audit mode in production,
  tokens, quotas, metering, the ignore list, the ALB'd API tier, the Node and Workers clients; new volumes on
  `backend: "camelfs"`; workflows on `fork`/`merge`/`deleteOwned`; the result cache on tree ids; `job()` on the
  hosts driver for every tenant on the pilot; the x86 AMI and pools (§1.4).
- Bar: fork ≤ 50 ms unheld and O(1) in tree size; merge of 3 disjoint edits per side ≤ 200 ms at every size; a
  Worker file write ≤ 80 ms p50; job placement → first command ≤ 300 ms warm, ≤ 2.5 s cold for the large tree; a
  terminated host mid-job loses no published version and the rerun by key succeeds; cache hit ≥ 95 % for the second
  job of a lineage on a host; `git fsck --strict` clean on every exported test lineage; the GC audit reports zero
  live objects marked garbage over a week.
- AWS: S3 bucket `camelfs-prod` (SSE-KMS, versioning on with 35-day noncurrent expiry, Inventory daily, Batch
  Operations role), DynamoDB tables (`refs`, `dirty`, `objects`, `touch`, `warm`, `lineages`; on-demand, PITR on),
  an ALB + target group, an ECS Fargate service or a 2-host ASG for `camelfsd api` (Graviton), IAM roles (api, host),
  Secrets Manager for the token key, CloudWatch alarms and dashboards; the x86 AMI pipeline and the `m8id`/`c8id`
  launch templates with nested virtualization enabled; the vCPU quota for the Intel families. Fixed cost ~$150/month
  plus the pools.

### Phase 2: computers on the fleet; Cloudflare containers go (4 weeks)

- `MicroVmComputer`: leases, forwarded reads and writes with guest-side CAS, sleep as checkpoint + memory snapshot,
  wake as restore or boot, fork as reflink + boot or restore, `durability: "call"`, the watchdog, cold-path tuning
  (ublk, dm-clone or pre-hydration per v0's numbers, access-pattern prefetch).
- Bar: wake ≤ 300 ms p50 and ≤ 4 s p99 (lease + dirty apply + reflink + restore; cold boots included in the p99);
  fork of a computer ≤ 500 ms to a running child; durable version lag ≤ 30 s p99; a forwarded Worker write visible
  in the VM ≤ 200 ms; metadata-random reads of a hydrated lineage within 10 % of local; zero Cloudflare container
  minutes after cutover.
- AWS: a computers pool (`m8id`, more hosts, overcommit on), its quota, and alarms on image-store and cache pressure.

### Phase 3: search, the git edge, blame (3 weeks)

- Shards built at checkpoint on hosts and API nodes in production; `grep` on the API for every agent; the
  materialized bare repo cache on API nodes; clone/fetch/push with ref-policy tokens and the CAS in the transaction
  hook; import with history; mirror to GitHub from the API (`push()` stops being a job); `blame`, `log`, `diff` as
  agent tools; rename-aware merges through `merge-tree`; the console's history view.
- Bar: `grep` over a 50k-file snapshot ≤ 50 ms p50 warm / ≤ 2 s cold, index lag ≤ 5 s after checkpoint, index
  ≤ 0.15× text (`proto/search` measured 11–13 %); clone of the large tree within 1.2× of `gitsvc`'s stock-git
  number; a mirror push of a turn's commit ≤ 2 s; blame of a 2,000-line file ≤ 300 ms.
- AWS: API nodes with NVMe (`c8gd`) for the repo cache; egress to GitHub from the API tier's security group.

### Phase 4: the sweep, generations, 100× and the long tail

- The GC sweep turned on after its audit week; generation packing of cold trees; tree segments when the write bill
  says so; private cache partitions per tenant; content-defined chunking for large files that change (datasets,
  SQLite); the first `.metal` pool when a pool's demand fills one; a second region as a replicated copy; retention
  policies per lineage; the Node backend and self-host on the same binary with a directory or MinIO behind it.
- Bar: cost per agent-hour of storage flat or falling from phase 2 to 100× load in a synthetic run; GC reclaiming
  ≥ 95 % of deleted-workflow bytes within 48 h with zero false positives; p99 API latency unchanged at 10× the
  baseline request rate.

Cloudflare containers are deleted at the end of phase 2, not before: until then they are the computer provider and
the fallback. Boat and Lambda MicroVMs leave once the fleet has run a month.

## 6. Risks and open questions for Miguel

1. **ublk and dm-clone are designed, not run.** The sprite kernels lack both; the m8id's kernel 7.0 has them. v0
   measures them first (§4, items 2 and 5); NBD and full pre-hydration are measured fallbacks, so nothing blocks.
2. **Nested-KVM overhead is unmeasured by us.** v0 item 6 gives the build and I/O tax; it also sets the metal trigger.
   If the build tax is past ~10 %, the build pool goes to metal first.
3. **The checkpoint floor.** 4.5 MiB of changed chunks for a 15 KB edit on a 1 GiB image; v0 item 4 measures it at
   realistic sizes. If it is worse, roots are published less often, never the trees.
4. **The freeze window.** A `git add`-sized change streams under the freeze for seconds, with the agent's writers
   blocked. Acceptable at per-turn cadence? The later fix is a memory-safe userspace ext4 reader in a sandboxed,
   unprivileged process reading the snapshot, which removes the window and keeps the no-host-parsing rule (it is not
   root, not the kernel, and reads a reflink copy); it is a second implementation to own, so it waits for a reason.
5. **Trusting the guest's walk.** The host hashes bytes but relies on the guest for *which* paths changed. A hostile
   guest can only make its own tree disagree with its own image. Recommendation: accept, with the verify job.
6. **Workers' latency to us-west-2.** An agent on Workers pays ~20–60 ms per file op where the Volume DO paid ~0 for
   dirty rows. v0 item 8 measures it. A DO write-back cache in front of camelFS for Workers only is the mitigation
   and a second working layer with its own coherence; recommendation: not unless the measurement says so.
7. **DynamoDB write cost at 100×** (~$75k/month of the ~$100k). Tree segments and a single-item working layer cut it
   ~3× and are mechanical; not a v0–phase 2 concern.
8. **Go for the device daemon.** No mature ublk library in Go today; NBD is fine and measured; Rust's `libublk` is
   maintained by ublk's author. Decision asked: Go with NBD now and ublk through a thin cgo or Rust sidecar later,
   or Rust for the device daemon from the start.
9. **Default durability cadence.** Per turn (or 30 s) is ~$365/month of versions at the baseline; per tool call for
   the file tier is ~5× that. Recommendation: per call for interactive computers, per turn for workflow children and
   jobs. Decision asked: is per call the default for everything?
10. **History horizon and retention.** Reachability keeps everything a `main` ever was unless a lineage sets a
    horizon; with generation packing it costs S3 prices. Default: unlimited. Decision asked: a tenant-facing retention
    knob at all, or only an operator one?
11. **Self-host.** The design runs on a directory and SQLite in place of S3 and DynamoDB (the Go interfaces are four
    calls each), but the image tier needs root, KVM, XFS reflink and a kernel with NBD or ublk; self-hosters without
    them get the API and copy-mode jobs only. Acceptable for the self-host product line?
12. **Fallback providers.** Boat and Lambda stay only while the fleet proves itself; Cloudflare containers go at the
    end of phase 2. Confirm, or keep one managed fallback indefinitely?
13. **Idle computers on our hosts.** A sleeping computer is a memory snapshot on NVMe and costs nothing; a running
    idle one holds memory. Recommendation: idle timeout 5 minutes, then sleep, since wake is tens of milliseconds.
14. **Git features the tree store refuses.** Submodules are refused at import rather than flattened; LFS pointers are
    kept as pointers; signed commits keep their signatures. Confirm that imports with submodules may fail.
15. **Image-only state across machines.** Ignored paths, mtimes, empty directories and xattrs live on the image and
    survive on hosts but not in versions. A workspace rebuilt from its tree alone (a version written only from
    Workers, mounted on a host that has no ancestor image) starts without `node_modules` and `.git`. Acceptable, with
    the tree-delta apply making it rare?

## Appendix: what the prototypes settled

| question | answer | from |
|---|---|---|
| Is in-VM block access native? | yes on the sprite's disk: every op within noise of local ext4; NVMe is v0's measurement | `proto/block` fsbench |
| Is FUSE acceptable in the hot path? | no: 5–10× on every metadata op and open; passthrough fixes reads only | `proto/block`, `proto/mount` |
| Can a tree be the version while blocks are the transport? | yes, and it must be: block maps differ per materialization | `proto/block` |
| Which VM substrates take a host block device as virtio-blk? | all three: Nitro Sandboxes (direct and confidential), Firecracker on KVM, Cloud Hypervisor | Firecracker `docs/nitro-sandboxes/`, CH docs, via `proto-block` |
| Does Nitro Sandboxes support what computers need? | no: no memory snapshots, no pause, no unplug, no balloon, no overcommit; vhost-user-blk rejected | same |
| Is virtio-fs + DAX available? | no: not a Firecracker device; Cloud Hypervisor has virtio-fs without DAX | same |
| Which EC2 families have nested virtualization? | Intel 8th generation (`c8i`/`m8i`/`r8i`, launched 2026-02; more Intel platforms 2026-06; our `m8id.4xlarge` confirms the `-id` variants); no Graviton, no AMD | AWS announcements; the v0 host |
| Is a fork free? | yes: a ref row (0.6–25 ms) and a reflink (1.5 ms) | all |
| Do three-way merges work on trees? | yes: 38–168 ms for disjoint hunks, O(changed paths) | `merkle`, `gitapi`, `gitsvc` |
| Are our trees git's trees? | yes, byte for byte | `merkle` |
| Does stock git beat an own server at the edge? | yes: v2, partial clone, merge-ort, bitmaps, fsck for free | `gitsvc` |
| Index in a database, bytes in object storage? | yes: 5 s → 65 ms on a large-tree commit | `artifacts-volumes` |
| Is Artifacts the answer? | no: 1 GB/repo, 32 MiB/file, 33× price, no server-side writes | `artifacts-volumes` |
| Is a stateful git fleet the answer? | not as truth: 6/10, a fleet to page on; as a cache at the edge, yes | `gitsvc` |
| Does lazy mounting pay on cold full reads? | yes with prefetch (3.0 s vs 5.5 s local cold for 500 MB at 15 ms injected latency); it is the chunk GETs and nothing else | `proto/block` |
| Search over snapshots? | trigrams per content-addressed shard: 11–13 % of source, 10–30 ms p50 warm, ~4 ms per changed file to index, forks free; 10–30× warm ripgrep | `proto/search` |

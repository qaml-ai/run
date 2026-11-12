# camelFS: the file system for agents, on our own AWS machines

Status: design, 2026-11-12. Docs only; nothing here creates AWS resources (Miguel applies every AWS change himself).
It supersedes the file half of [swarm-workflows.md](swarm-workflows.md) Part 2 (the repository object, layers, search,
git without a VM, `camel-sync`) and the disk half of [job-hosts-plan.md](job-hosts-plan.md) (reflink clones, S3
snapshots, host-side sync); the host, VM and placement halves of that plan stand and this design runs on them.

Decided by Miguel: a full-stack system on AWS, dropping Cloudflare containers; a new service if that is what it
takes; ambitious; fast search and grep included. This document picks one architecture, says why over the
alternatives, maps camelRun onto it, and cuts it into phases with success criteria and the AWS resources each needs.

## The ideal, and what this design gives

| Ideal | camelFS |
|---|---|
| Every version is an immutable content hash | A version is a git-compatible tree id; a commit records it with parents and the agent that made it |
| Unlimited O(1) forks | A fork is one conditional write in the ref table; on a host it is also a dm-thin snapshot (ms); nothing is copied anywhere |
| Real three-way merges | Tree merge over (base, ours, theirs): whole subtrees by hash, diff3 by lines where both sides edited a file, conflicts answered with both sides and nothing written |
| Any machine mounts any version, no copy, lazily, at kernel speed, no FUSE | A lazy block device (ublk; NBD as the fallback) under dm-thin, hydrated by dm-clone into the host's NVMe, attached to Firecracker as virtio-blk; inside the VM it is plain ext4. Measured: in-VM file ops equal local ext4; FUSE is 5–10× on every metadata op |
| Local-fast writes, durable quickly, automatic snapshots per turn or tool call | Writes hit the thin device at NVMe speed; every tool call takes a local snapshot (ms); every turn (or 30 s of dirtiness) publishes a durable version: changed files as blobs, new trees, one commit, one CAS |
| Retention by reachability, no pins, TTLs or janitors | One rule: an object lives while a ref reaches it. Refs are owned (by a volume, a workflow, a job, a mount) and die with their owner. One collector, generational, driven by S3 Inventory |
| No size limits, at S3 prices | Blobs and chunks in S3 Standard ($0.023/GB-month); trees and commits in DynamoDB; nothing lives on a host that is not a cache |
| Git only at the edges | Objects are git's byte format with git's ids; clone, fetch, push, mirror and import are served by stock git on API nodes against a lazily materialized bare repo. No agent path touches git |
| Reachable with or without a VM | One HTTPS API (file ops, commit, fork, merge, diff, log, blame, grep, tokens) in us-west-2; VM-less agents on Workers are clients; a branch has one writer at a time, and the API routes to it |
| Instant search and grep over any snapshot or fork | A trigram + symbol index built per content-addressed shard at checkpoint; a snapshot or fork composes shards it shares with its parents; queries run where the shards are cached |
| Full history, diff, blame, per-agent attribution | Every commit carries agent, run and call ids as trailers; blame resolves lines to the agent and tool call that wrote them; a true two-parent merge keeps an attempt's chain reachable |

Numbers in this document come from the prototypes on `proto/block`, `proto/merkle`, `proto/gitapi`, `proto/gitsvc`,
`proto/artifacts-volumes`, `proto/mount` and `proto/search` (`prototypes/*/DESIGN.md`, `RESULTS.md`) and from the
2026-11-11 Nitro Sandboxes spike. The three tree sizes they share: small 200 files / 1 MB, medium 5k / 50 MB,
large 50k / 500 MB.

## 1. Architecture

```
                 Cloudflare (camelRun Workers backend)            laptops, CI, GitHub
    agents' file tools, workflows, jobs(), computers       git clone / push, the console
                     │ HTTPS + per-ref tokens                         │
 ════════════════════╪════════════════════════════════════════════════╪═══════════════ AWS us-west-2
                     ▼                                                ▼
             ┌─────────────────── camelfs API tier (stateless, ALB, 2+ AZs) ───────────────────┐
             │ file ops · commit/fork/merge/diff/log/blame · grep · tokens · git smart HTTP     │
             │ lease routing to the host that holds a live branch · GC · import/export          │
             └──────────────┬──────────────────────────────────────┬────────────────────────────┘
                            │ IAM                                  │ mTLS, one port, API-tier SG only
     ┌──────────────────────┴───────────────────────┐   ┌──────────┴──────────────────────────────────┐
     │ Storage plane (managed, the only truth)      │   │ Volume hosts = job hosts = computer hosts    │
     │  S3  o/<sha1>     blobs (file bytes)         │   │  camelfsd: ublk lazy device ← chunk GETs     │
     │      c/<sha256>   256 KiB device chunks      │◄──┤   dm-clone hydration → NVMe image            │
     │      r/<sha256>   roots (chunk map per image)│   │   dm-thin: CoW thin per mount, snapshot=fork │
     │      s/<sha256>   search shards              │   │   checkpoint: freeze → snap → delta → publish│
     │      p/<commit>   cached clone packs         │   │   host-wide NVMe cache (chunks, trees, shards)│
     │  DynamoDB refs (CAS) · trees+commits (CAS)   │   │  Firecracker (Nitro Sandboxes): virtio-blk   │
     │      leases · dirty rows · warm-host hints   │   │   guest: ext4 + camel-guest (fanotify, vsock) │
     └──────────────────────────────────────────────┘   └──────────────────────────────────────────────┘
```

Three parts, one binary:

- **The storage plane is managed services only.** S3 holds the bytes; DynamoDB holds every mutable fact (refs, leases,
  working-layer rows) and the small hot objects (trees, commits). No host holds truth. RPO for a published version is
  zero; a host can be terminated at any moment and the system loses only the current turn's unpublished writes of the
  branches it held live.
- **`camelfsd` runs in two roles.** `api` on a small stateless tier behind an ALB (what Workers, laptops and git talk
  to); `host` on every VM host (the lazy block device, the thin pool, the cache, checkpoints, search indexing). Same
  Go module, same object and tree code.
- **Hosts are the job hosts.** The job-hosts plan's Graviton fleet (`r8gd` build, `c8gd` test, 950 GB NVMe each,
  Firecracker in Nitro Sandboxes mode) gains the host role, and the long-lived computers move onto the same fleet,
  replacing Cloudflare containers. The NVMe is the chunk cache and the thin pool.

### 1.1 Objects and versions

| object | id | where | bytes |
|---|---|---|---|
| blob | git SHA-1 of `blob <n>\0` + bytes, checked with sha1dc at ingest | S3 `o/<sha1>` | raw file bytes (header implied); multipart past 64 MiB; range reads |
| tree | git SHA-1 of git's tree encoding | DynamoDB `objects` (≤ 400 KB); S3 stub past that | git's exact tree bytes |
| commit | git SHA-1 | DynamoDB `objects` | git's commit bytes: tree, parents, author `agent:<id>`, committer `camelfs`, message with trailers `Camel-Agent`, `Camel-Run`, `Camel-Call`, `Camel-Workflow` |
| chunk | sha256 | S3 `c/<sha256>` | 256 KiB of a block image (the thin pool's data block size); all-zero chunks are holes |
| root | sha256 | S3 `r/<sha256>` | chunk hash per 256 KiB of one image (128 KiB per GiB) + `{ tree, parentRoot, fsType, sizeBytes }` |
| search shard | sha256 | S3 `s/<sha256>` | trigram postings + symbols for ~64 MB of content (§1.6) |
| clone pack | commit id | S3 `p/<commit>` | a git pack of one commit's tree, built on first clone |

**The tree is the identity.** `proto/block` tried block maps as the version and found what Lambda found: a block
map is a *materialization* of a tree (ext4 metadata, allocation and journal make the same files produce different
blocks on different hosts), so it is useless for merge, dedupe across volumes and the git edge. A version is its
tree; a root is a cache of one way to lay that tree out on a disk, and a tree may have zero, one or several roots.
A version without a root is still complete: readable, forkable, mergeable, exportable. A host that mounts it builds
a root from the nearest ancestor that has one plus the changed files (ms for a few files; 1.8 s for a 50 MB tree
and ~20 s for 500 MB from an empty image, once per lineage).

**Git's ids, git's bytes.** Trees and commits are stored as git encodes them (`proto/merkle` verified byte equality
with `git write-tree`), so export is a copy, every tool reads the result, and `git fsck` is a check we can run.
sha1dc at ingest refuses collision-attack objects, as GitHub does; a tenant could only collide with its own lineage.
Chunks and roots are not git objects and use sha256.

**Dedupe.** Blobs dedupe across the whole fleet by content; chunks dedupe within a lineage (a 3-file change kept
4,078 of 4,096 chunks) and almost never across lineages. The API never reveals existence: a write may reference an
object by id without bytes only when that object is reachable from the caller's own refs, so one tenant cannot ask
"does anyone have this file".

### 1.2 Refs, leases and the working layer (DynamoDB)

| table | key | holds |
|---|---|---|
| `refs` | `lineage`, `name` | `commit`, `tree`, `root?`, `owner` (`volume:<id>`, `workflow:<id>`, `job:<id>`, `mount:<host>:<id>`, `cache:<key>`, `mirror:<remote>`), `expiresAt?`, `createdAt`, `updatedAt` |
| `leases` | `lineage`, `name` | which host holds the branch live (`host`, `mountId`, `renewedAt`, `deadline`); at most one |
| `dirty` | `lineage#name`, `path` | the working layer of an API-held branch: `blob` (inline ≤ 256 KB, else S3), `mode`, `deleted`, `seq`; cleared by checkpoint |
| `objects` | `id` | trees and commits (content-addressed, write-if-absent) |
| `warm` | `lineage`, `host` | roots this host holds, for placement |
| `lineages` | `lineage` | tenant, quota, default branch, created |

A **lineage** is a volume plus everything made from it (forks, job views, cache entries, mirrors); it is the
DynamoDB partition key and the unit of chunk sharing. A **ref** is a name → commit inside a lineage. Every ref
update is a conditional write (`commit = :expected`); a merge that moves one ref and deletes another is one
`TransactWriteItems`. There are no other locks.

**One writer per branch.** A branch is held either by a VM (a `leases` row; the host is the writer) or by nobody
(the API is the writer, through `dirty`). A VM-less agent writing to a branch a VM holds has its write forwarded by
the API tier to that host, whose guest agent writes the file inside the VM; a read is answered from the last published
version by default (at most one turn stale, usually seconds) or forwarded with `consistency: "live"`. Two VMs never
hold the same branch: the second mount forks.

**Why DynamoDB, not Aurora or a Durable Object.** A DO would put the truth in another cloud from the hosts that need
it on every checkpoint, and Miguel decided on AWS. Postgres (camelRun's Node backend already has one) would work:
CAS is `UPDATE … WHERE commit = $old`, transactions are free, GC marks are SQL. It costs an instance to size and
fail over (the RDS swapping and ~4-minute failover we have lived through), and at 100× it becomes a sharding project.
DynamoDB gives conditional writes, transactions, single-digit-millisecond reads, point-in-time recovery and on-demand
scaling with no instance to run; the data is key-value shaped (refs, rows, content-addressed objects), so losing SQL
costs nothing on the hot path. The one thing it makes harder, enumerating objects for GC, is done from S3 Inventory
and a scan of `objects` (§1.8). Trees and commits live here rather than in S3 because they are small, hot and
latency-bound: `proto/artifacts-volumes` measured this split (trees in a database, blobs in object storage) as the
difference between a 5 s and a 65 ms commit on a large tree.

### 1.3 Hosts: the lazy block device, thin pool, cache, checkpoint

The stack under a VM, bottom up, all in-tree kernel code plus one daemon:

1. **Lazy device** (`camelfsd host`, ublk; NBD over a Unix socket as the fallback every kernel has and the prototype
   measured). It serves one root read-only: a read miss fetches the chunk from the host cache, else from S3
   (single-flight per chunk, 16 in flight, 4-chunk sequential prefetch, plus the lineage's recorded access pattern
   from its last mount, as Lambda does). ublk gives io_uring submission and `UBLK_F_USER_RECOVERY`, so a daemon
   restart is a stall, not EIO. AL2023 6.18 ships it as a module.
2. **dm-clone** over the lazy device, destination a sparse file on the NVMe: hydrates regions (256 KiB, aligned to
   chunks) in the background and serves hydrated regions in the kernel; when complete the daemon is detached. This
   is what makes a hot lineage's second job native from the first byte, and what removes the userspace round trip
   that `proto/block` measured as a 3× penalty on metadata-random reads (`ls -R`, `grep -r` with a cold page cache).
   Designed, not yet run: the sprite kernel lacks it; the host image has it.
3. **dm-thin** pool on the NVMe (256 KiB blocks, metadata on NVMe): one thin per mount with the clone as external
   origin. Writes are CoW blocks in the pool. `create_snap` is a fork and a checkpoint (11–60 ms; with the guest's
   `fsfreeze` first the pool's `suspend` is a no-op; without it, 1.1 s to flush ext4). `thin_delta` between the last
   checkpoint's snapshot and the new one lists exactly the changed blocks, so a checkpoint reads O(delta).
4. **Firecracker virtio-blk** with `io_engine: "Async"` (447k IOPS on a reflinked file in the spike; to be
   re-measured on a thin). The guest sees `/dev/vdb` and mounts ext4 (`-O ^inline_data`, `data=ordered`, journal in
   its own chunks so it dirties the same few every time). Nothing to install in the image beyond `camel-guest`, which
   jobs already have.

Measured on `proto/block` (NBD, no dm-clone, sprite disk): mount cold 130 ms (small) to 1.9 s (large; superblock and
group descriptors); first file 26–79 ms; a cold full read of the 500 MB tree 3.0 s at 15 ms per chunk GET with
prefetch (the local disk's own cold read was 5.5 s); per-op latency on 2,000 small files identical to local ext4
(create 33 vs 34 µs, stat 9.0 vs 9.3 µs, warm read 10.3 vs 10.3 µs); FUSE loopback 5–10× on every op, kernel
passthrough recovering reads only. Fork: 61–92 ms for the snapshot plus 45–121 ms to mount beside the origin.

**Checkpoint** (per branch, on the host):

1. the guest's `camel-guest` has collected the dirty path set since the last checkpoint with fanotify
   (`FAN_MARK_FILESYSTEM`, create/modify/delete/move with `FAN_REPORT_DFID_NAME`); a queue overflow marks the set as
   unknown, and the fallback is a ctime walk (`proto/block` measured an incremental index at 30–80 ms for 5–10k
   files; a 100k-file walk is ~1–2 s and only runs on overflow);
2. `fsfreeze` in the guest; `create_snap` on the host; thaw. Milliseconds; the VM keeps running;
3. the guest streams the dirty files' bytes over vsock; **the host hashes them** (never a guest-supplied hash) and
   PUTs the blobs S3 lacks. The host never mounts a guest's filesystem: a hostile image would attack the host kernel's
   ext4 parser, so the only things the host parses are its own blocks and byte streams it hashes;
4. the host rewrites the trees on the changed paths (3–5 tree objects for a one-file edit; reads from its tree cache),
   writes one commit with the attribution trailers, and does the ref CAS. This is the **durable version**: every
   later reader, Worker, merge, search and git export sees it;
5. asynchronously and coalesced (every 30 s and at mount end): `thin_delta`, hash the changed chunks, PUT the new ones,
   publish a root for the new tree, record it on the ref. The block tier is a cache of the file tier, so this upload
   can lag or be skipped without losing anything; a tree whose root is missing is rebuilt from the nearest ancestor.

Cadence: a **local snapshot per tool call** (free; it is what makes "undo this tool call" and "fork from before that
call" instant on the host), a **durable version per turn, or after 30 s of dirtiness**, whichever first, and always
before a fork, a job, a merge, a sleep and at mount end. Snapshots between durable versions are published only if
something references them (a fork, a job). This keeps the durable rate at ~20 commits per agent-hour, not ~100, and
keeps ext4's metadata amplification (4.5 MiB of changed chunks for a 15 KB edit) out of the per-tool-call path.

**Cache.** One NVMe directory per host, keyed by hash, shared by every tenant on the host; eviction is an LRU
high-watermark sweep (80 % → 60 %) with chunks of live mounts last. Nothing is pinned and nothing is coordinated:
a chunk at a hash never changes, and an evicted chunk is re-fetched on the next miss. `r8gd.4xlarge` has 950 GB,
the warm set of hundreds of repositories. A hostile guest cannot reach the cache: its block device maps only its
root's chunks, verified by hash when they entered the cache.

### 1.4 VMs: jobs and computers on one substrate

Both run as Firecracker microVMs in Nitro Sandboxes mode on the fleet, with the job-hosts plan's image, netns pool,
egress proxy and isolation suite. The difference is the lease:

| | job (`job()`, `job_run`) | computer (an agent's long-lived machine) |
|---|---|---|
| mounts | `/repo` ← fork of the named tree (a `job:<id>` ref); root disk ← the job's image lineage | `/workspace` ← the agent's branch (a `mount` lease); root disk ← the computer's image lineage |
| writes | into its thins; `outputs` and (if `commit: true`) the `/repo` fork are published at the end | per-tool-call snapshots; durable versions per turn |
| end | publish, drop thins, destroy; the fork is merged by the workflow or garbage | sleep = checkpoint + destroy the VM; wake = boot a new VM on the same lineage (0.8–2.5 s cold boot by size; no memory snapshots on Nitro Sandboxes) |
| fork | `create_snap` of the job's thins + a new VM | the same: a child computer is a snapshot and a boot, O(1) |

The **root disk is a lineage too**: a base image (kernel, toolchains) is a tree with a root; a warm snapshot
(`saveSnapshot: "bun-rust-warm"`) is a checkpoint of the job's image lineage. The job-hosts plan's separate
`job_snapshots` table, S3 snapshot prefix, reflink clones and image LRU collapse into camelFS refs, roots and the
cache. Placement prefers hosts whose `warm` rows hold the lineage's roots, as the plan already does for snapshots.

**What computers lose by leaving Cloudflare containers:** memory snapshot restore (CF p50 200–350 ms, tails 30 s;
here 0.8–2.5 s cold boots, no tail), and nothing else. What they gain: a 950 GB NVMe host, 16 vCPU sandboxes, forks
in milliseconds, every file version durable, and a tenant's workspace reachable from Workers while the machine
sleeps. Interactive processes die at sleep on both.

### 1.5 The API for VM-less agents

`camelfsd api`, stateless, in us-west-2 behind an ALB (HTTP/1.1 from Workers: the 2026-10-24 Cloudflare→ALB HTTP/2
stall), 2 AZs, autoscaled on CPU. A request carries a token (§1.9) naming the lineage and the refs it may read and
write; the tier resolves the ref, reads `dirty` + trees from DynamoDB and blobs from S3 (an in-process LRU of trees
and small blobs in front), and answers.

| op | what it does | expected latency from a Worker (us-west-2 round trip ~20–60 ms included) |
|---|---|---|
| `read(ref, path)`, `stat`, `ls`, `glob` | `dirty` overlay over the tree; blob from S3 | 30–80 ms cold, ~25 ms for trees only |
| `write(ref, path, bytes, expectBlob?)` | one `dirty` row (inline ≤ 256 KB; else S3 blob + row); per-path optimistic concurrency | 30–60 ms |
| `checkpoint(ref)` | fold `dirty` into trees, one commit, CAS | 50–150 ms; ~6 object writes |
| `fork(from, name, owner, ttl?)` | one conditional put | 30 ms |
| `merge(into, from, mode)` | three-way on trees in the API node; diff3 on co-edited text; conflicts → 409 with both sides, nothing written; clean → two-parent commit + transactional ref move | 50–200 ms for a few changed paths; proportional to changed paths, not tree size |
| `diff`, `log`, `blame` | tree walk skipping equal subtrees; first-parent log; blame from history over cached blobs | 30–300 ms |
| `grep`, `symbols` | §1.6 | 20–100 ms |
| `mount` ops | forward to the lease's host | + the host hop |

Consistency: a branch's readers see the last durable version plus (for an API-held branch) its `dirty` rows; a
VM-held branch's `dirty` is empty by construction (writes go to the VM). The result-cache key and every "is this
the same content" question use the tree id.

Placement: Workers are wherever Cloudflare runs them; the API tier is the one place they talk to. If the Node
backend or a self-host runs in another region, it runs its own camelFS (the whole system is one binary plus a
bucket and a table); cross-region replication of lineages is a later feature (S3 replication + a DynamoDB global
table), not a design change.

### 1.6 Search: trigrams and symbols per shard, composed per snapshot

Shape (from `proto/search`, measured numbers to follow in its RESULTS):

- Content is grouped into **shards of ~64 MB** at index time; a shard is a content-addressed object holding, for its
  files, a trigram → file-id posting list, a symbol table (ctags-style: name, kind, line) and the file list with blob
  ids. A shard never changes.
- A **snapshot's index** is the list of shards that cover its tree, plus a small exclusion list for files the
  snapshot changed or removed since the shard was built. A **commit** on top of a snapshot indexes only its changed
  files into a delta shard; when deltas exceed a threshold they are compacted into a new base shard. A **fork**
  inherits its parent's shard list: zero work.
- A **query** turns the regex into a trigram set (Cox's trick; Zoekt's shape), intersects posting lists across
  the snapshot's shards, excludes stale file ids, runs the regex over the surviving candidates' bytes (from the
  cache), and ranks with a symbol boost. A pattern with no literal trigrams scans the candidates' bytes directly.
- Indexing runs **on the host at checkpoint** for VM-held branches (the dirty files are in hand and hashed) and on
  the API node at checkpoint for API-held ones; the shards go to S3 and the host cache. A snapshot made from a
  GitHub import is indexed by the import job.

Why not one index per lineage, mutated in place: forks and snapshots would each need a copy or a versioned index;
content-addressed shards make a fork free and an old snapshot searchable forever. Why trigrams and not an embedding
index: agents grep; semantic search is a different tool and can be built over the same shards later.

Targets: a query over a 50k-file snapshot in ≤ 50 ms warm (shards in the host or API cache) and ≤ 300 ms cold
(shard GETs), index cost per commit proportional to changed bytes, index size ≤ 0.4× the text it covers.

### 1.7 The git edge

Git never sits in an agent's path. It exists at four edges, all served by API nodes running **stock git** against
a bare repository materialized on the node's NVMe from the object store (a streaming export, since the objects are
already git's; a lazily restored, evictable cache, never truth):

| edge | how |
|---|---|
| clone / fetch (a laptop, CI, a job that insists) | smart HTTP `upload-pack` by stock git on the materialized repo; a pack per commit is cached in S3 (`p/<commit>`) so repeat clones of one head are one GET; protocol v2, shallow and partial clone come free with stock git (`proto/gitsvc`: cold clone of the large tree 17.9 s, blobless partial clone 5.1 s, delta fetch 0.18 s, all client-bound) |
| push (a person pushes to a camelFS branch) | `receive-pack` by stock git with a `pre-receive` hook that checks the token's ref policy, then an import of the new objects into the store and a ref CAS; a non-fast-forward is refused unless the token says otherwise |
| mirror to GitHub (`push()`) | a thin pack of what GitHub lacks since the `mirror/github:<branch>` ref, sent to `git-receive-pack` with the App installation token the runtime mints (hosts' egress allowlist, as today); the mirror ref is both the next export's `have` and a GC root |
| import from GitHub | `git clone --mirror` on an API node into NVMe, objects imported with sha1dc verification, trees landing byte-identical, history included (it is only objects); upstream sync is a fetch into `upstream/<branch>` and a camelFS merge |

The materialized repo also serves `git log -p`, `blame` over renames and `bisect` for histories too deep for the
API's own walkers; those run as commands on the API node with the result returned, never in an agent's VM.

### 1.8 History, attribution, GC

**History.** A branch's first-parent chain is its turn-by-turn history; an attempt (a workflow child's fork) merges
with two parents, so its own commits stay reachable and attributable after the merge; `log --first-parent` is the
default view and shows one commit per accepted attempt. Rollback is a new commit whose tree is an old tree; history
is never rewritten. A snapshot a user names is a ref `snap/<name>`.

**Attribution.** Every commit's author is `agent:<id>` (or `user:<id>`, `job:<id>`) and its trailers name the run,
the tool call and the workflow. `blame(ref, path)` gives, per line, the commit, the agent and the call; `diff`
between any two trees is O(changed paths). A merge's second parent keeps an attempt's intermediate versions, so
"which tool call introduced this line" survives the merge.

**GC: reachability, generational, from S3 Inventory.**

- Roots: every unexpired `refs` row's `commit` and `root`, every `dirty` row's blob, every `leases` row's mount
  snapshot root, and every object younger than the grace (24 h) in case its referencing row is in flight.
- Mark: walk commits → parents (to the lineage's history horizon: all of it by default; a retention policy can
  shorten it, and the `mirror/*` ref keeps exported history reachable), trees → subtrees and blobs, refs → roots →
  chunks. Trees are read from DynamoDB in batches; the mark set is a Bloom filter in memory per lineage, written to
  S3 per run.
- Sweep: S3 Inventory (daily) lists every object with its age; a sweep job deletes inventory entries older than the
  grace that the mark did not reach, with S3 Batch Operations; DynamoDB `objects` are deleted by the same key set.
  A wrong sweep loses data, so the sweep runs in audit mode first (counts and samples, no deletes) for each new
  version of the collector, and a canary lineage with known garbage is checked after every run.
- Owners: a workflow's end deletes every `owner = workflow:<id>` ref; a job's end deletes its `job:<id>` ref; a
  mount's end deletes its lease; an expired `expiresAt` ref is dropped by the sweep. There are no pins, no snapshot
  TTLs, no per-feature janitor: every lifetime rule is "the ref dies with its owner".
- Cost scales with live objects and inventory size, not with history × files; a mark of a 50k-file lineage is
  ~1,100 tree reads (`proto/gitapi` measured 42 ms of CPU for 5k files, 518 ms for 50k, in a Worker).

### 1.9 Security and tenancy

- **Hostile root VMs** see a block device of their own thins and a vsock to `camelfsd`. The vsock protocol is small
  (checkpoint request, dirty set, file stream, forwarded writes, freeze/thaw) and the host trusts nothing in it: it
  hashes what it receives, enforces the mount's byte and file quotas, and maps the guest's device to the chunks of
  one root. No S3 or DynamoDB credential, no token, no other tenant's address exists in the guest. The host never
  parses a guest filesystem.
- **Hosts** hold an instance role scoped to the bucket prefixes and tables, as the job-hosts plan's role is scoped,
  and enroll with the STS attestation already landed (`shared/job-host-attest.ts`). They accept one mTLS port from
  the API tier's security group and nothing from the internet.
- **Tokens** are signed by camelRun (HMAC or ES256, key held by the runtime and the API tier): `{ lineage, read:
  [ref globs], write: [ref globs], scope, exp, subject }`. A workflow child's token writes `fork/<effect>` and reads
  `main`; a job's token reads one commit and writes `job/<id>`; a laptop clone token reads one branch for an hour.
  The API tier is the authorization boundary; the storage plane is reached by nothing else. Revocation is a key
  rotation (two keys valid during rollover) or a short deny-list of token ids in DynamoDB.
- **Tenancy in the data.** Lineages belong to tenants; the API refuses cross-lineage references unless both are the
  caller's; cross-tenant dedupe is invisible (§1.1). The host cache is shared and unreachable by guests; timing
  side-channels on cache hits would reveal co-tenancy of public content only, and a tenant may opt into a private
  cache partition.
- **Quotas** per lineage (bytes, files, refs, dirty rows) and per tenant; refused loudly, counted in usage.

### 1.10 Durability, HA, sharding

| | value | why |
|---|---|---|
| RPO, published version | 0 | S3 (11 nines) and DynamoDB (3 AZs, PITR) hold it before the CAS is acknowledged |
| RPO, VM-held branch | the current turn (≤ 30 s of dirtiness) | the window between durable checkpoints lives in the host's thin pool |
| RPO, API-held branch | 0 | every write is a DynamoDB row |
| RTO, API tier | 0 (multi-AZ, stateless) | any node serves any request |
| RTO, a lost host | the job rerun / computer wake on another host: seconds to boot plus cache warmth | nothing on a host is truth; leases lapse and the owner re-places |
| RTO, S3 or DynamoDB down | checkpoints and API writes fail loudly; VMs keep running on their thins; the host retries checkpoints with backoff and keeps snapshots | the same posture as any managed-storage dependency; no degraded "unreplicated" mode |
| AZ loss | hosts in other AZs continue; the API tier continues; in-flight VMs in the AZ are lost and re-placed | S3 and DynamoDB are regional |
| region loss | down | one region by design, next to the hosts; a second region is a copy of the whole system plus replication, a later decision |

Sharding is by lineage: DynamoDB partitions on it, chunk sharing stops at it, GC marks per lineage, leases are per
branch. There is no shard map to operate and no shard to rebalance; a hot lineage is bounded by one writer per
branch and DynamoDB's per-partition limits (1,000 writes/s, far above a branch's rate). The API tier is horizontal.

### 1.11 Observability

Through the runtime's existing alarms (CloudWatch, email to Miguel) and dashboards:

- per op: count, latency p50/p99, errors, bytes, by role and tenant; the ref CAS conflict rate per lineage;
- hosts: cache hit rate (chunks, trees, shards), chunk GET latency and tail, ublk queue depth and stalls, dm-clone
  hydration progress, thin pool free space and metadata space, checkpoint duration by step (freeze, snapshot, stream,
  hash, publish), fanotify overflows, dirty bytes per mount, mounts per host;
- durable versions per agent-hour, dirty age at checkpoint, forwarded writes and reads (VM-held branches);
- search: index lag (checkpoint → shard visible), query latency, candidate ratio;
- GC: live/garbage counts per run, bytes reclaimed, mark duration, audit-mode discrepancies;
- storage: bytes by kind and tenant, DynamoDB consumed capacity, S3 request counts by kind (the cost drivers).
No file contents or paths in telemetry; lineage and tenant ids only.

### 1.12 Cost

List prices, us-west-2, 2026-11: S3 Standard $0.023/GB-month, PUT $5/M, GET $0.4/M, Inventory and Batch Operations
negligible; DynamoDB on-demand $1.25/M writes, $0.25/M reads, $0.25/GB-month; the API tier on `c8g.large` ~$60/month
each; hosts are the job/computer fleet's cost, paid for compute, with the NVMe cache free on top. R2's
$0.015/GB-month and free egress are irrelevant here: the data is where the compute is.

Baseline load ("today", the figure the prototypes share): 1,000 concurrent agents × 20 durable versions/hour,
~200 file writes/hour each, 1 M job and computer mounts a month, 0.5 TB live with history. At 100×: 100,000 agents,
50 TB.

| item | baseline | 100× |
|---|---:|---:|
| durable versions: 14.6 M/month × (~4 tree + 1 commit DynamoDB writes, ~2 blob PUTs, 1 CAS) | ~$110 DynamoDB + ~$145 S3 | ~$25k |
| API-held writes: 144 M/month DynamoDB rows | ~$180 | ~$18k |
| block tier: ~1/3 of versions publish a root, ~20 chunks each | ~$50 | ~$5k |
| mounts: 1 M/month, cold ≈ 200 chunk GETs, warm ≈ 0 | ~$80 | ~$8k |
| reads (Workers and API nodes, cache misses) | ~$50 | ~$5k |
| storage: 0.5 TB S3 + ~20 GB DynamoDB | ~$17 | ~$1.7k |
| search shards (0.3× of text, rebuilt per commit as deltas) | ~$10 | ~$1k |
| API tier: 2 × `c8g.large` + ALB | ~$150 | ~$2k (autoscaled) |
| GC: Inventory + Batch Operations | ~$5 | ~$200 |
| **camelFS total** | **~$800/month** | **~$65k/month** |

For comparison at the baseline: Artifacts ≈ $2,560, Pierre ≈ $1,800 of storage alone at $3.60/GB-month, the
`gitsvc` fleet ≈ $800–900 with two stateful hosts to run, the Workers-only git server ≈ $160 but with every job
paying seconds of clone. The hosts themselves (the compute) dominate everything above: one `r8gd.4xlarge` is ~$860
a month. At 100× the DynamoDB write lines are the ones to engineer down (tree segments: pack a checkpoint's trees
into one item, ~3× fewer writes); nothing else is worth touching before then.

## 2. Choices, made

**Block-level, file-level or hybrid: hybrid, with the file tree as the only identity.** File-level stores
(`merkle`, `gitapi`, `gitsvc`, `artifacts`) are the Worker's natural shape, dedupe across the fleet, merge natively
and export to git for free; their price is paid at the VM, as a copy (2–18 s per job by size, every job) or as FUSE
(5–10× per metadata op, measured). Block-level is the only way a VM gets native file operations *and* a lazy,
copy-free mount of any version; its price is a second view to keep consistent, lineage-only dedupe, and ext4
metadata amplification at checkpoints. The hybrid takes the file tree as truth everywhere, and keeps the block layer
as a derivable cache that exists only on hosts and only for versions a VM has used. The index that ties them is
produced by the checkpoint and verified by hash on every read.

**ublk + dm-clone + dm-thin, not NBD alone, not virtio-fs + DAX, not ZFS/Btrfs.** Firecracker has no virtio-fs
(virtio-blk, net, vsock, balloon, entropy only), and Nitro Sandboxes mean Firecracker; virtio-fs with DAX would
also keep every open/stat/create crossing to virtiofsd. ZFS is out of tree on AL2023; Btrfs is in tree but, like
ZFS, is a per-host filesystem: send/receive moves whole streams, so "any host mounts any version with no copy" is
exactly what it cannot do, and host affinity becomes a scheduler constraint. dm-thin gives the same snapshot and
clone primitives in tree; dm-clone gives kernel-served hydration; ublk gives the lazy origin with io_uring and
crash recovery. NBD is the fallback for any kernel and the device the prototype ran. XFS `reflink=1` stays on the
NVMe for the cache directory and the clone destinations.

**DynamoDB for refs, trees and the working layer; S3 for everything else.** §1.2.

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
nothing an agent needs. So the edges shell out to git over a materialized cache.

**Checkpoints at turns, snapshots at tool calls.** §1.3. Every tool call is recoverable on the host; every turn
is durable everywhere; nothing pays ext4's per-checkpoint floor a hundred times an hour.

**One fleet.** The volume hosts are the job hosts are the computer hosts. A separate storage fleet would hold caches
that the compute could not use locally, and the whole point of the block tier is locality.

**Not chosen, and why:** Cloudflare Artifacts (1 GB/repo, 32 MiB/file, 33× R2's price, no server-side writes, no
partial clone); Pierre (OpenAI acquired it 2026-11-04; $3.60/GB-month; its ephemeral branches, preview merge and
ref-policy tokens are copied here); Archil/JuiceFS-style POSIX mounts (FUSE in the hot path, multi-writer semantics
we do not want); EdenFS/Sapling (the right ideas, a Meta-sized client to run inside every VM); Piper/CitC (the same
"snapshot is a number, mount anywhere" model, built on a filesystem server we would have to write; ours is the
block device plus the tree store).

## 3. Integration with camelRun

| camelRun today | on camelFS | code that goes |
|---|---|---|
| `Volume` DO: file table, per-file versions, uploads, snapshots, pins, forwarded pins, read-set claims, `collectGarbage` + alarm (`backends/workers/src/volume.ts`, 1,050 lines) | a lineage with a `main` ref; the agent's file tools call the API with the volume's token; snapshots are `snap/<name>` refs; reads/writes/ls/glob/stat map one to one; per-file `expectBlob` replaces per-file versions | ~800 lines of the DO: everything but the HTTP surface and quota accounting, which become a thin client |
| `Volume.commit` / `volume-commit.ts` (atomic multi-file commit, refuses any shared path) | `merge(into: main, from: fork/<effect>)`: disjoint hunks of one file merge; overlaps come back with both sides | `volume-commit.ts` (125) |
| `volume-policy.ts` limits (256 MiB/file, 100k files, 4 GiB sync) | quotas per lineage; the sync limits disappear with the sync | most of it |
| `workflow-forks.ts` (`ForkJanitor`, alarm retries, in-flight check) and `workflow-volumes.ts` (fork at a snapshot, seed pins) | `fork(main, fork/<effect>, owner: workflow:<id>)`; the workflow's end is one `deleteOwned(workflow:<id>)` | both (62 + 115), replaced by ~30 lines |
| `workflow-results.ts` result cache keyed on volume version + inputs; `adopt` takes a fork over | key = `(tree, command, inputs)`; the cached result's ref is `cache/<key>` with `owner: cache`; adopt = one update | the adopt path (~50 lines) |
| `jobs/camel-sync.ts`, `WireJob.files` + `sync` (host-side sync past 16 MiB), the `/out` tar | `job({ at: ref|tree })` mounts a `job:<id>` fork lazily; `outputs` are read from the job's final snapshot and published; a writing job's fork is merged by the workflow. Inline `files: {…}` keep the tar for the few-file case | `camel-sync.ts` (150), the sync half of `shared/job-host-protocol.ts` and `jobhost/guest.ts` |
| `jobs/host-sync-store.ts`, `job_snapshots`, S3 `snapshots/`, reflink clones of images, image LRU (`jobhost/vm.ts`) | image lineages, roots and the chunk cache; `saveSnapshot` is a checkpoint; placement reads `warm` | the snapshot store and clone path |
| `computers/`: `ContainerComputer` (Cloudflare container DO), `microvm.ts` (Lambda), `native-fork.ts`, `child-fork.ts` snapshot/seed, `remote.ts` | one `MicroVmComputer` provider on the hosts: a mount lease on the agent's branch, sleep/wake as checkpoint/boot, fork as snapshot; Boat and Lambda stay behind `ComputerProvider` only while a region is down, then go | the Cloudflare container provider and its `wrangler.jsonc` `containers` block; Lambda MicroVM and Boat providers once the fleet has run a month |
| `history-pins.ts` (attachment pins inherited by forks) | an agent's attachments are a tree under `agent/<id>` | 21 lines |
| Node backend `src/volumes.ts` (1,192), `storage-gc.ts`, `gc-verify.ts`, `pin-backfill.ts` | the same client over the same API | ~1,700 lines, one implementation for both backends |
| `push()` to GitHub as a job | the API's mirror edge with the App token | the job-shaped push |
| `grep` bounded to 1,000 files / 32 MiB | the index; unbounded | the bound |

Agents' tools do not change shape: `read`, `write`, `edit`, `ls`, `glob`, `grep`, `cp` keep their names and the
"changed since you read it" check (blob id instead of version). New for agents: `history`, `diff`, `blame`,
`fork`, `merge` as tools on a repo-kind volume, and `job_run` on any volume. The SDK's `volumes.*` keeps its
surface with `version` meaning a tree id.

Migration: new volumes are lineages from day one (`backend: "camelfs"` on the volume row); an existing volume
migrates on first touch or by a sweep: read its file table, hash each unique blob (sha256 today → git SHA-1; one
GET, one PUT per unique file, in a job for big volumes), write the tree, make a `snap/<name>` ref per snapshot.
Pins need no migration (forks are short-lived; a volume with live forks migrates after its workflow ends). When
every volume is a lineage, the old paths and R2 keys go.

What camelRun keeps owning: tenants, quotas and billing (camelFS reports bytes and ops per tenant), workflows and
their effects, placement and host enrollment, tokens' minting policy, the console. camelFS owns bytes, versions,
refs, mounts, search and the git edge.

## 4. Phases

Each phase ships behind the previous one's API; each has a measurable bar and lists the AWS resources it needs
(all as OpenTofu under `infra/camelfs/`, applied by Miguel).

### Phase 0: the tree store and API (3 weeks). Beats today on forks, merges, cache keys, history

- `camelfs/` Go module: objects (blob, tree, commit, sha1dc), the DynamoDB tables, S3 layout, refs with CAS, the
  working layer, checkpoint, fork, three-way merge, diff, log, tokens; `camelfsd api` behind an ALB; a Node and
  Workers client; the Volume DO's file tools over the client for new volumes (`backend: "camelfs"`).
- Workflows: `fork`/`merge`/`deleteOwned` replace `workflow-forks.ts`, `workflow-volumes.ts`, `volume-commit.ts`;
  the result cache keys on the tree.
- Bar: fork ≤ 50 ms and O(1) in tree size; merge of 3 disjoint edits per side ≤ 200 ms at every tree size;
  an agent file write ≤ 80 ms p50 from a Worker; checkpoint of a one-file edit ≤ 150 ms; `git fsck --strict` clean on
  an export of every test lineage; GC in audit mode reports zero live objects marked garbage over a week of the
  camelCode loop.
- AWS: S3 bucket `camelfs-prod` (SSE-KMS, versioning off, Inventory daily, Batch Operations role), DynamoDB tables
  (`refs`, `leases`, `dirty`, `objects`, `warm`, `lineages`; on-demand, PITR on), an ALB + target group, an ECS
  Fargate service or a 2-host ASG for `camelfsd api` (Graviton), IAM roles (api, host), a KMS key for tokens' signing
  secret in Secrets Manager, CloudWatch alarms. Estimated fixed cost ~$150/month.

### Phase 1: lazy mounts on the job hosts (4 weeks). Beats today on every job

- `camelfsd host` on the job-hosts image: the lazy device (NBD first; ublk when the module is confirmed on the first
  real host), dm-thin pool, chunk cache, root build from a tree, mount at a tree, checkpoint at job end (freeze,
  snapshot, dirty files from `camel-guest`, publish), outputs from the final snapshot; the `job:<id>` ref; `warm` rows
  and placement affinity. Jobs stop syncing trees. Image lineages replace `job_snapshots`.
- Bar: time from job placement to first command on a warm host ≤ 300 ms for any tree size (today: seconds to
  minutes by size); cold ≤ 2.5 s for the 500 MB tree; in-VM file ops within 10 % of local ext4 on the fsbench
  suite; checkpoint of a 3-file change ≤ 500 ms to durable; a lost host loses no published version (chaos test:
  terminate a host mid-job, the rerun by key succeeds); chunk cache hit rate ≥ 95 % for the second job of a lineage
  on a host.
- AWS: the job-hosts pools (already planned) with the host role extended to the camelFS bucket prefixes and tables;
  a security-group rule API-tier → hosts on one port; the host image rebuilt with `camelfsd`, `dmsetup`,
  `thin-provisioning-tools`, `nbd`/`ublk` modules; a CloudWatch dashboard for the host metrics.

### Phase 2: computers on the fleet, per-tool-call snapshots, ublk + dm-clone (4 weeks). Cloudflare containers go

- `MicroVmComputer` on the hosts: a mount lease on the agent's branch, per-tool-call snapshots, durable versions per
  turn / 30 s, sleep = checkpoint + destroy, wake = boot, fork = snapshot; forwarded writes and `consistency: "live"`
  reads from the API; ublk replaces NBD; dm-clone hydration with LRU and access-pattern prefetch; automatic
  checkpoints for long jobs.
- Bar: wake ≤ 2.5 s p50 (CF today p50 0.2–0.35 s with 30 s tails; the bar is the tail: p99 ≤ 4 s); fork of a
  computer ≤ 500 ms to a running child; durable version lag ≤ 30 s p99; a forwarded Worker write visible in the VM
  ≤ 200 ms; metadata-random reads of a hydrated lineage within 10 % of local; zero Cloudflare container minutes
  after cutover.
- AWS: pool sizing for computers (a `computers` pool, likely `c8gd`/`m8gd` with more hosts and `cpu_overcommit`),
  the quota increases that implies, and alarms on thin-pool and cache pressure.

### Phase 3: search, the git edge, blame (3 weeks)

- Shards built at checkpoint on hosts and API nodes; `grep`/`symbols` on the API; the materialized bare repo cache
  on API nodes; clone/fetch/push with ref-policy tokens; import with history; mirror to GitHub from the API
  (`push()` stops being a job); `blame`, `log`, `diff` as agent tools; the console's history view.
- Bar: `grep` over a 50k-file snapshot ≤ 50 ms warm / ≤ 300 ms cold, index lag ≤ 5 s after checkpoint, index ≤ 0.4×
  text; clone of the large tree from the API within 1.2× of `gitsvc`'s stock-git number; a GitHub mirror push of a
  turn's commit ≤ 2 s; blame of a 2,000-line file ≤ 300 ms.
- AWS: API nodes get NVMe (`c8gd`) for the repo cache; egress to GitHub from the API tier's security group.

### Phase 4: 100× and the long tail

- Tree segments (one DynamoDB item per checkpoint's trees) when the write bill says so; generational GC with
  per-lineage marks on a schedule; private cache partitions per tenant; content-defined chunking for large files that
  change (datasets, SQLite); a second region as a replicated copy; retention policies per lineage (history horizon);
  the Node backend and self-host on the same binary with a directory or MinIO behind it.
- Bar: cost per agent-hour of storage flat or falling from phase 2 to 100× load in a synthetic run; GC reclaiming
  ≥ 95 % of deleted-workflow bytes within 48 h; p99 API latency unchanged at 10× the baseline request rate.

Order and parallelism: phase 0 and the host-role work of phase 1 start together (the device stack needs only the
object layout); phase 2 needs phase 1's host on real Nitro hardware; phase 3's search can start in phase 1 against
the object store. Cloudflare containers are deleted at the end of phase 2, not before: until then they are the
computer provider and the fallback.

## 5. Risks and open questions for Miguel

1. **ublk and dm-clone are designed, not run.** The sprite kernels lack both; AL2023 6.18 has them as modules. NBD
   is measured and sufficient for phase 1; the first real host (job-hosts slice 6's suite) must confirm ublk,
   dm-clone and the `Async` io_engine on a thin device before phase 2 commits to them. Decision asked: nothing; the
   order above already defers them.
2. **The checkpoint floor.** 4.5 MiB of changed chunks for a 15 KB edit, from ext4 metadata, on a 1 GiB image; the
   per-turn cadence and the file-tier-first publish keep it off the bill, but the floor at 4 GiB images and with the
   journal pinned is unmeasured. If it is worse, roots are published less often, never the trees.
3. **Trusting the guest's dirty set.** The host hashes bytes but relies on the guest for *which* paths changed. A
   hostile guest can only make its own tree disagree with its own image. Acceptable? The alternative, a userspace
   ext4 parser on the host over the thin snapshot, is a second implementation to own. Recommendation: accept, and
   run a periodic verify job (materialize the tree in a sacrificial VM, compare).
4. **Block images are per lineage; dedupe at the fleet level is file-level only.** A tenant with 1,000 near-identical
   repositories pays chunks per lineage until the file tier dedupes them. Fine at today's shape; a "root template"
   shared across lineages of one base image is the fix if it shows up.
5. **Workers' latency to us-west-2.** An agent on Workers pays ~20–60 ms per file op where the Volume DO paid ~0 for
   dirty rows. The prototypes' DO working layer could stay as a write-back cache in front of camelFS for Workers
   only; it is a second working layer with its own coherence rules. Recommendation: do not; measure the real number
   in phase 0 and add the cache only if agents on Workers are slower in wall time, which their model calls dwarf.
6. **DynamoDB write cost at 100×** (~$45k/month of the ~$65k). Tree segments cut it ~3×; S3 Express One Zone is
   another lever. Not a phase 0–2 concern.
7. **Nitro Sandboxes have no memory snapshots**, so a computer's wake is a boot (0.8–2.5 s) and processes die at
   sleep. Cloudflare's restore was faster at p50 and far worse at p99. If an interactive class needs 35 ms wakes,
   the nested-virt Intel pool from the swarm doc is the answer, behind the same provider seam.
8. **Go for the device daemon.** No mature ublk library in Go today; NBD is fine and measured; Rust's `libublk` is
   maintained by ublk's author. Decision asked: Go with NBD now and ublk through a thin cgo or Rust sidecar later,
   or Rust for the device daemon from the start (one more language in `jobhost/`'s neighborhood).
9. **History horizon and retention.** Reachability keeps everything a `main` ever was unless a lineage sets a
   horizon. Default: unlimited (it is cheap: a one-file checkpoint is ~5 KB of trees). Decision asked: a tenant-facing
   retention knob at all, or only an operator one?
10. **Self-host.** The design runs on a directory and SQLite in place of S3 and DynamoDB (the Go interfaces are
    four methods each), but the block tier needs root, dm-thin and a kernel with NBD; self-hosters without them get
    the API and copy-mode jobs only. Is that acceptable for the self-host product line?
11. **Fallback providers.** Boat and Lambda stay only while the fleet proves itself; Cloudflare containers go at the
    end of phase 2. Confirm, or keep one managed fallback indefinitely?
12. **The pool math for computers.** A long-lived computer holds a VM slot for its idle timeout; today Cloudflare
    bills the sleep as nothing. On our hosts an idle VM holds memory from the sandbox pool. Decision: a short idle
    timeout (5 minutes?) with instant wake, since wake is a boot and the branch is always durable.

## Appendix: what the prototypes settled

| question | answer | from |
|---|---|---|
| Is in-VM block access native? | yes: every op within noise of local ext4 | `proto/block` fsbench |
| Is FUSE acceptable in the hot path? | no: 5–10× on every metadata op and open; passthrough fixes reads only | `proto/block`, `proto/mount` |
| Can a tree be the version while blocks are the transport? | yes, and it must be: block maps differ per materialization | `proto/block` |
| Is a fork free? | yes: a ref row (0.6–25 ms) and a thin snapshot (11–92 ms) | all |
| Do three-way merges work on trees? | yes: 38–168 ms for disjoint hunks, O(changed paths) | `merkle`, `gitapi`, `gitsvc` |
| Are our trees git's trees? | yes, byte for byte | `merkle` |
| Does stock git beat an own server at the edge? | yes: v2, partial clone, merge-ort, bitmaps, fsck for free | `gitsvc` |
| Trees in a database, blobs in object storage? | yes: 5 s → 65 ms on a large-tree commit | `artifacts-volumes` |
| Is Artifacts the answer? | no: 1 GB/repo, 32 MiB/file, 33× price, no server-side writes | `artifacts-volumes` |
| Is a stateful git fleet the answer? | not as truth: 6/10, a fleet to page on; as a cache at the edge, yes | `gitsvc` |
| Does lazy mounting pay on cold full reads? | yes with prefetch (3.0 s vs 5.5 s local cold for 500 MB); it is the chunk GETs and nothing else | `proto/block` |
| Search over snapshots? | trigram + symbols per content-addressed shard, forks free | `proto/search` (numbers pending) |

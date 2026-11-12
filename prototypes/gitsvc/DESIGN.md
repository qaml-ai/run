# camelRun volumes on stock git, run as our own service

A decision aid, not a migration plan. One of several parallel prototypes; its sibling `proto/artifacts-volumes`
(`prototypes/artifacts-volumes/DESIGN.md`) designs the same volume object over Cloudflare Artifacts and over a git
server written on Workers + R2. This one keeps **the volume object and its working layer** from that design and swaps
the remote for **real `git`** on machines we run next to the job hosts. Numbers: `RESULTS.md`. Code: `src/`, `test/`,
`bench/` (same generated trees as the sibling).

## The shape in one paragraph

A **gitsvc shard** is one Linux host in us-west-2 with local NVMe, holding bare repos (`/srv/git/<repo>.git`) and
running one Node process: a ~270-line HTTP proxy that checks a short-lived HMAC token and then hands the request to
`git http-backend` (smart HTTP, protocol v0/v1/v2 negotiated by git itself), plus a small JSON API for what an agent
platform needs that git's wire protocol does not give: create/delete, ref compare-and-swap (a fork is a branch),
server-side **commit** from a file map (`git fast-import`), server-side **merge** (`git merge-tree --write-tree`, i.e.
git's own merge-ort with rename detection), a blob read, a tree listing, and gc. Every ref update — a push, a commit,
a merge, a fork — passes a **replication gate**: git's `reference-transaction` hook, in its `prepared` state, ships
every pack not yet in the bucket plus the new ref manifest to S3/R2 and only then lets the ref move. **The bucket is
the source of truth and the NVMe is a cache**; a lost host costs no acknowledged write, and its repos come back by
downloading their packs (no `index-pack`, the `.idx` files are shipped too). Agents keep editing in the **Volume DO's
working layer** (unchanged from the sibling design: in-object reads and writes, dirty rows, a blob cache); a
checkpoint is one HTTPS call from the object to the shard (a thin-pack push, or the commit API with the changed files).
Jobs **clone or fetch** from the shard with a read token; each job host keeps a **bare mirror per volume** and makes a
job's directory from it with `clone --shared` or `worktree add`, so a warm host moves only the delta.

```
 Cloudflare                                   AWS us-west-2
┌───────────────────────────┐   HTTPS + token  ┌──────────────────────────────────────────┐
│ Volume DO (per branch)     │ ───────────────▶ │ NLB ─▶ gitsvc shard host (NVMe)          │
│  index + dirty layer +     │  checkpoint:     │        node proxy ─▶ git http-backend    │
│  blob cache                │  push / commit   │        /api: refs CAS, commit, merge, gc │
│  mints tokens (HMAC key)   │  cold blob read  │        reference-transaction hook ──┐    │
└───────────────────────────┘                  │                                      ▼    │
                                               │   S3 bucket: repos/<r>/packs/*.{pack,idx} │
 job hosts (same region) ── clone/fetch ─────▶ │              repos/<r>/refs.json          │
   /var/cache/git/<repo>.git mirror            └──────────────────────────────────────────┘
```

## Decisions

### 1. What runs: stock git, a thin proxy, nothing else

`git http-backend` is the reference smart-HTTP server; GitHub, GitLab (Gitaly) and Gitea all run real git underneath
for the hard parts. Using it means **we write none of the protocol**: v2, shallow (`--depth`), partial clone
(`--filter=blob:none`, enabled per repo), `multi_ack`, side-band, bitmaps, delta compression, `fsck` — all already
there and battle-tested. The proxy's only jobs are authentication, mapping a token's scope onto the operation, and
the API. It spawns one `git` child per request (CGI); at ~5 ms per spawn that is not the bottleneck at our rate (§7).

### 2. Auth: HMAC tokens minted where the decision is made

`src/token.ts` (44 lines). A token is `base64url({repo, scope, exp, refs?}).hmac`. The volume object (Workers) and the
job dispatcher hold the signing key; the shard verifies with no lookup. Scopes:

| scope | allows | minted by | TTL |
|---|---|---|---|
| `read` | `info/refs`, `git-upload-pack`, blob/tree/refs reads | job dispatch; "clone to laptop" via our API | job timeout / 1 h |
| `write` (+ `refs` prefixes) | read + `git-receive-pack`, limited to `refs/heads/job/<id>` etc. by the `pre-receive` hook | job dispatch for writing jobs | job timeout |
| `admin` | write + the JSON API | the volume object only, per call | 60 s |

Tokens are per repo, so a leaked job token opens one volume, read-only, until it expires. Revocation before expiry
is a key rotation (two keys accepted during rollover) or a small deny-list of token ids; not built. Agents and end
users never see a token. The shard sits behind an NLB with TLS; a private link (VPC Lattice / PrivateLink) is
possible for job hosts but the Volume DO reaches it over the public internet, so TLS + tokens are the boundary.

### 3. Durability: the replication gate

`src/replicate.ts` (156 lines) + `hooks/reference-transaction` (8 lines of sh).

- **Invariant: no ref moves on the shard until the bucket has every pack it could need and the new manifest.**
  Every write path lands its objects as a pack before its ref update: pushes (`receive.unpackLimit=1`), the commit
  API (`git fast-import` with `fastimport.unpackLimit=0`), merges (`merge-tree` writes loose objects, so the API packs
  the new ones with `pack-objects` before the CAS). The hook, in state `prepared` (locks held, nothing committed),
  calls the proxy's internal endpoint, which uploads unshipped `pack-*.pack` then `.idx` (in parallel across packs),
  then `refs.json` with this transaction's updates applied. A failure exits non-zero and git aborts the update; the
  pusher sees `ng` and retries. **RPO = 0 for every acknowledged write.**
- The manifest is "last shipped manifest + this transaction", not `for-each-ref`, so two concurrent transactions on
  different refs do not drop each other (each holds only its own locks); uploads per repo are serialised in-process.
- **Restore** = list `repos/<r>/packs/`, download packs + idx in parallel, `update-ref --stdin` from `refs.json`.
  A pack without its `.idx` is ignored (an upload that died half-way is never referenced by a shipped manifest).
  Measured: 0.07 / 0.20 / 1.2 s for the 0.5 / 12 / 120 MB repos, followed by an optional `fsck --connectivity-only`.
- **Lazy restore** (design, not built): a shard that gets a request for a repo it does not have restores that repo
  from the bucket first. This turns host replacement into "start a host, claim the shard": repos come back on first
  touch, seconds each, rather than a bulk copy.
- **Fencing** (design, not built): `refs.json` is written with a conditional PUT (`If-Match` on the ETag; S3 and R2
  both support it), so a zombie shard that lost its claim cannot overwrite the new owner's manifest: its next gated
  write fails and aborts. The ETag lives in the shard's per-repo state next to `gitsvc-refs.json`.

### 4. Sharding and HA

- **Repo → shard** is a row in our control plane (the routing table a volume object already reads: `{repo, shard,
  epoch}`), assigned by consistent hash at create, moved only by an operator or on host loss. A shard is a host; we
  start with **2 shards**, each sized for all traffic (§7), so one can absorb the other.
- **Host loss:** the router bumps the epoch and points the shard at a fresh host (ASG with a baked image, ~2–3 min)
  or at the surviving shard; repos restore lazily from the bucket. Writes to that shard's repos fail for that window
  (the volume object keeps its dirty layer and retries; agents keep working in-object); reads by jobs fall back to
  their host mirror if the workflow allows a stale commit. **RTO ≈ minutes for the shard, seconds per repo after.**
- **No synchronous replica pair.** A hot standby (DRBD, or git's own `push --mirror` to a second host in the hook)
  halves RTO at twice the cost and a second consistency mechanism; the bucket gate already gives RPO 0, so a standby
  only buys minutes. Revisit if minute-long write outages per year matter more than ~$250/month.
- **AZ:** one AZ per shard, job hosts in all AZs; cross-AZ clone bytes cost $0.01/GB each way (§7).

### 5. Volumes, forks, merges, the result cache

Unchanged from the sibling design except where the server now does the work:

- **Volume = branch, repo per volume, Volume DO per branch** (the sibling's §1–2: index, dirty layer, blob cache,
  checkpoint at turn end / before a job / before a fork / by 30 s alarm).
- **Checkpoint** has two forms, both measured: (a) the sibling's `VolumeCore.commit` builds a thin pack in the object
  and pushes it with the head as CAS (`src/core/`, reused verbatim); (b) the **commit API** takes `{branch, parent,
  files}` and the shard builds the commit with `fast-import`, CAS on `parent`. (b) removes pack building from the
  object entirely: the object needs only blob hashing for its index, not the pack format.
- **Fork = `POST /refs {ref: fork/<id>, old: null, new: <head>}`**: one ref transaction, no bytes, nothing pinned.
- **`commit()` of a fork = `POST /merge {into, from}`**: git's merge-ort, so renames, directory renames and
  line-level three-way merges are git's (the sibling wrote a path+diff3 merge; this one writes none). Clean → a
  two-parent commit and a CAS on `into`; conflicts → 409 with the paths, nothing moves (the workflow's rebase-and-fix
  rule is unchanged). The object then re-seeds its index from `GET /tree/<commit>` (one call; `ls-tree -r -t -l`).
- **Result cache key = tree sha** of the commit a job ran at (sibling §4).
- **Cleanup**: deleting a fork is a ref delete; its objects become unreachable and gc reclaims them after the grace.

### 6. Jobs: clone, mirror, worktree

A job with `at: volume` gets `{remote, commit, read token}`. On the host:

- **cold host**: `git clone` (v2, full; history is short) — or `--filter=blob:none --no-checkout` + sparse checkout
  for a job that touches a corner of a big tree (partial clone works here; Artifacts lacks it);
- **warm host**: `git -C /var/cache/git/<repo>.git fetch` (delta only) then `git clone --shared` or `git worktree
  add --detach <dir> <commit>` (local, no network; the checkout of N files is the cost);
- **writing job**: pushes `refs/heads/job/<id>` with a write token scoped to that prefix; the workflow merges it with
  the merge API.

The tar stream (`camel-sync`) stays only for small inline `files: {…}`.

### 7. GC

All stock git, run by the shard on its own schedule, never inline in a push (`gc.auto=0`):

- every push/commit adds one pack (`receive.unpackLimit=1`), so a busy volume accumulates packs; **`git repack
  --geometric=2 -d`** every N writes keeps the count logarithmic and re-ships only the small rolled-up packs;
- nightly (or when packs > 50): **`git gc --prune=<grace>`** — one pack with bitmaps, unreachable objects (dropped
  forks, rewritten nothing) older than the grace removed. Git's gc is designed to run beside live pushes;
- then the replicator ships the new pack and **sweeps** bucket packs the repo no longer has, once older than the grace
  (`Replicator.sweep`). A sweep never deletes a pack the shard still holds, and restore tolerates extra packs, so the
  worst bug here leaks bytes rather than losing them — the opposite failure mode from a hand-written mark-and-sweep.
- Deleted volumes: rm the bare repo; the bucket prefix is deleted after the tombstone grace.

### 8. Outages

| what fails | agents | checkpoints / forks / merges | jobs |
|---|---|---|---|
| one shard host | unaffected (in-object) | that shard's repos fail ~2–5 min, layer retries | cold clones of those repos fail; warm mirrors can serve a pinned, already-fetched commit |
| the bucket (S3/R2) | unaffected | **all writes fail** (the gate is synchronous); reads keep working | unaffected |
| AZ | as one shard host | as one shard host | job hosts in other AZs unaffected |
| region us-west-2 | unaffected in-object, cold blob reads fail | all fail | job hosts are in the same region, so they are down too |
| Cloudflare ↔ AWS path | cold reads/checkpoints from the DO fail | queue in the layer | unaffected |

The bucket outage is the sharp edge: with a synchronous gate, S3/R2 being down means no checkpoints. A degraded mode
(let refs move, mark repos `unreplicated`, ship on recovery: RPO = outage length) is one flag, behind an alarm.

### 9. Node backend and self-host

This is the strongest part of the design. The gitsvc **is** the self-host story: the same `startServer()` runs
in-process in the Node backend over a directory on the node's disk, the bucket optional (`S3_*` unset → no gate;
operators back up a directory of bare repos with whatever they use). Self-hosters need `git` ≥ 2.38 and nothing from
Cloudflare or AWS; the on-disk format is the one every operator can inspect, clone and repair. The Workers backend and
the Node backend then share one file model, the Volume DO / Node volume table being the only per-backend part.

### 10. Cost at our scale (us-west-2 list prices, 2026-11)

Same load as the sibling: 1,000 concurrent agents × 20 checkpoints/h = **14.4 M writes/month** (~5.5/s average,
assume 30/s peak), **1 M job clones/fetches/month**, **0.5 TB** stored with history.

| item | monthly |
|---|---:|
| 2 × `i4i.xlarge` shards (4 vCPU, 32 GB, 937 GB NVMe), on-demand | ~$500 (~$320 with a 1-yr savings plan) |
| NLB (+ LCUs at this rate) | ~$25 |
| S3: 0.5 TB Standard | ~$12 |
| S3: 14.4 M writes × ~3 PUTs (pack, idx, refs.json) + gc re-ships | ~$220 (R2 class A: ~$195) |
| S3 GETs (restores, lazy restore) | < $5 |
| cross-AZ clone/fetch bytes (1 M × mostly deltas; ~5 TB if every clone were cold-ish) | $0–100 |
| Cloudflare → AWS egress into the NLB (checkpoints) | ~$0 (ingress free) |
| **total** | **~$800–900** (vs Artifacts ≈ $2,560, own Workers git server ≈ $160, today ≈ R2 ops + DOs) |

Capacity: a 1-file push through the proxy costs tens of ms of CPU (one `http-backend` + `receive-pack` + hook); one
4-vCPU host does well over 50 writes/s, i.e. one shard carries the whole peak. Two shards are for HA, not throughput.

Plus the cost that does not show on a bill: **a stateful fleet we patch, monitor and page on** (disk, inode,
`git` upgrades, hook latency, bucket gate errors, pack count per repo).

### 11. Lines of code we would own

| piece | prototype | production estimate |
|---|---:|---:|
| proxy + API (`server.ts`, `gitexec.ts`) | 307 | 600 (limits, metrics, streaming bodies, lazy restore, router/epoch) |
| replication gate + restore + sweep (`replicate.ts`, hooks) | 173 | 400 (conditional PUT fencing, degraded mode, multipart for big packs) |
| tokens | 44 | 80 (key rotation, deny-list) |
| volume object client (commit API, tree seed, blob read) | — (reuses sibling's core; API path needs ~100) | 300 + the sibling's index/layer (~250) |
| job host mirror/worktree manager | — | 200 |
| infra (AMI, ASG, NLB, alarms, Terraform) | — | ~400 HCL |
| **total** | 524 + tests 102 + bench 388 (core 489 reused from the sibling) | **~2,200** + Terraform |

Roughly the size of what it replaces (`volume.ts` 1,050 + `volume-commit.ts` 125 + `workflow-forks.ts` 62 +
`workflow-volumes.ts` 115 + `camel-sync.ts` 150 on Workers, `src/volumes.ts` 1,192 on Node): **one** implementation
for both backends instead of two, but with a server fleet attached.

## Better than today

1. **Jobs get trees by git**: compressed packs, bitmaps, partial clone, delta fetches into host mirrors; no per-file
   R2 GETs feeding a tar. A warm host's new job dir is a local `worktree add`.
2. **We write no git**: protocol, merges (merge-ort with renames), packing, gc and fsck are git's. The sibling's own
   server writes ~380 lines of protocol and needs streaming parsers and a hand-written mark-and-sweep; here GC's
   worst failure leaks bytes.
3. **Server-side commit and merge** (the code.storage shape) without a vendor: the volume object no longer needs the
   pack format, and `commit()` merges disjoint hunks and renames.
4. **Forks are refs, retention is reachability**: pins, snapshot TTLs and the fork janitor go away (as in the sibling).
5. **One file model for Workers, Node and self-host**, in a format operators already know.
6. **No caps but the disk**: no 1 GB repo / 32 MiB file / 64 MiB push limit (Artifacts), no 128 MB DO memory per push
   (own Workers server). Big binaries still belong in R2 pointers (sibling §7) because git is bad at them, not
   because the server refuses them.
7. **RPO 0** with the bucket as truth; restore is a parallel download.

## Worse than today

1. **A stateful server fleet in another cloud.** Today's volumes are DOs + R2: no hosts, no patching, no disks, no
   pager for storage. This adds all of that, and puts AWS in the checkpoint path of a Cloudflare-hosted object.
2. **Cross-cloud latency on the object's remote calls.** A checkpoint or cold read from a Volume DO crosses the
   internet to us-west-2 (tens of ms to ~150 ms depending on where the DO lives) plus the S3 gate (~20–60 ms in
   region). Measured through a tunnel at ~78 ms API RTT: checkpoint 0.33 s, cold read 91 ms (RESULTS). Today a cold read is one R2 GET from the same network.
3. **Writes depend on two systems** (shard + bucket) instead of one (R2), and the gate makes S3/R2 latency part of
   every checkpoint.
4. **Many small packs** until repack runs; the bucket sees a PUT pair per write (cheap, but it is ~$200/month of
   requests and a sweep to keep tidy).
5. **Shard routing, fencing and lazy restore are ours** and are where the correctness risk lives (the gate itself is
   small and testable; failover is not exercised by this prototype).
6. **Regional.** One region by design (next to job hosts); a second region doubles the fleet.

## Verdict for the comparison

Fit **6/10**. The data plane is the best of the three git options — stock git is faster to clone, has partial clone
and real merges, and costs us no protocol code — and its self-host story is the cleanest. What it costs is a fleet:
camelRun today owns no stateful hosts for files, and this design adds hosts, a router, fencing and an on-call surface
for a component whose main win (jobs) is already reachable with the sibling's Workers + R2 server. It is the right
answer if job hosts become the center of gravity (most reads from jobs, few from DOs) or if self-host/Node parity is
the priority; otherwise keep the Volume DO and its working layer from the sibling, and treat "real git on job hosts"
as the mirror/cache tier rather than the store.

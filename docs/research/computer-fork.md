# Forking a computer's disk for sub-agents

Measured 2026-11-06. Harness: `scripts/bench/computer-fork/`. Raw results: `scripts/bench/computer-fork/results/*.json`.

The question: when an agent spawns a sub-agent, how does the sub-agent get its own,
independent copy of the parent's project machine? The copy should have the repos
cloned, dependencies installed and build caches warm. Each sub-agent then works on
its own branch and runs builds and tests there. This is a disk fork, not a live
memory fork.

## Summary

| | Cloudflare Containers snapshot | Boat fork | exe.dev `cp` | Sprites checkpoint | Fresh machine (Boat) | One VM, N worktrees (Boat 4 vCPU) |
| --- | --- | --- | --- | --- | --- | --- |
| Make source forkable | `snapshotContainer` 29–30 s (1.3 GB stored) | stop 9.6 s, or saved snapshot 9.6 s with source running | 0 s (copies a running VM) | checkpoint 0.6 s | n/a | n/a |
| Fork call → first command, N=1 | **0.63 s** from the client (in-DO p50 0.2–0.35 s) | 3.4 s | 3.5 s | restore 23.3 s (same machine only) | 1.4 s create + 63 s clone/install | 0.2 s `git worktree add` + 36 s `npm ci` |
| N=5 p50 / p95 | **0.75 / 2.5 s** | 3.4 / 4.5 s (saved: 1.9 / 3.1 s) | 4.0 / 4.8 s | no fork | 43 / 63 s to ready | 350 s install |
| N=10 p50 / p95 | 2.2 / **27.7 s** | 4.6 / 7.1 s (saved: 3.0 / 9.2 s) | 5.1 / 7.1 s | no fork | 62 / 77 s to ready | see below |
| Build + test in fork, N=10 p50 / p95 (source alone) | 35.7 / 39.4 s (32.0 s) | 19.5 / 50.6 s (15.1 s) | 38.4 / 40.9 s (36.2 s) | 38.9 s (43.0 s) | 14.4 / 24.4 s | N=5: 210 s each (14.6 s alone) |
| Disk under the fork | btrfs on a block device (`/dev/vdb`), same as fresh | **FUSE** (`ascii-lazyfs`) until hydrated, then ext4 | ext4 on local NVMe, same as fresh | overlayfs | ext4 | ext4 |
| Fork disk vs fresh disk | equal | 11x slower cold reads until hydrated (~2–5 min), then equal | equal | 10x slower cold reads | — | — |
| Independent / source untouched | yes / yes | yes / yes | yes / yes | n/a | yes | shared CPU, RAM, ports |
| Survives stop + wake | only if snapshotted first (disk is lost on stop) | yes (stop 1.8 s, resume 5.2 s) | yes (reboot 3.0 s) | yes | yes | yes |
| Max disk / size | 20 GB, 4 vCPU, 12 GiB | 51–251 GB, up to 16 vCPU | 25 GB default (resizable), pool CPU | 100 GB overlay | — | — |
| Running price, 4 vCPU class | ~$0.11/h idle, ~$0.40/h busy (active-CPU) | $0.036/h | $0.21/h standalone, or a share of a pool | ~$0.33/h busy | same as provider | 1/N of one machine |

**Recommendation.** For the Workers pilot, the default should be Cloudflare
Containers native snapshots under the `durable_object` policy. Restores are the
fastest measured: 0.63 s alone and 0.75 s p50 for five. Each fork gets its own
Durable Object, which is the Workers model. A fork's disk is a real block device
with the same speed as a fresh container, with no overlay or FUSE. A sub-agent's
own snapshot stores only its changes.

The fallback, and the choice for heavy or long-lived work on the Node runtime, is
**Boat fork**. It is about 10x cheaper per hour, has faster CPUs (typecheck 5–6 s
vs 13–15 s), up to 16 vCPU and 251 GB, Docker, and a disk that persists. Its forks
run on a FUSE lazy-loading layer for the first few minutes. Until that hydration
finishes, a fork's first reads are slow (see Disk speed). If disk speed has to be
equal from the first second and Cloudflare's limits don't fit, use **exe.dev**.
It copies a running VM onto plain local NVMe in 3.5–5 s and the copy matches a
fresh VM. Our current plan shares 4 vCPU across all VMs, so scaling it needs a
Work pool or standalone VMs.

Cloudflare's weak points, measured:
- A snapshot takes 30 s for a 1.7 GB workspace, and taking it again unchanged is no faster.
- Restores have a tail: 1 of 10 of ours took 27.7 s, and 3 of about 60 in the standalone run took 22–63 s.
- The disk is gone when the container stops, so every sleep needs a snapshot first.
- 20 GB / 4 vCPU ceiling.
- CPUs are slower than Boat's.
- Snapshots and the `durable_object` policy are public beta.

## Workload and method

- **Source workspace.** Clone `qaml-ai/run` (public), `npm ci` at the root, then
  `npm ci` in `backends/workers`. That is 1.7 GB and 88k files: `.git` 72 MB, root
  `node_modules` 933 MB, workers `node_modules` 654 MB.
- **Fork job.** In each fork: `git checkout -b fork-<i>`, write `FORK_ID`, run
  root `tsc -p tsconfig.json`, then `backends/workers` `tsc`, then
  `node --test tests/config.test.ts`.
- **Independence.** Every fork must read back its own `FORK_ID` and branch with
  installs present. The source must still be on `main` with no `FORK_ID`.
- **Rounds.** For N = 1, 5 and 10 the harness forks in parallel. It records the
  fork call time, the time to the first successful command (polling `true`), the
  time until all N answer, and each build.
- **Disk probe.** One fresh fork and one freshly installed machine on the same
  provider each get:
  - the mount table (`df -T`, `findmnt`, `/proc/mounts`, `lsblk`);
  - a cold read of the whole installed tree after `drop_caches`;
  - fio direct I/O: 1M sequential and 4k random read/write, iodepth 16;
  - a node I/O script: fsync'd writes, sync'd 4k random writes, 5k small files;
  - real work: `git status`, `git log`, `npm ci` warm (`--prefer-offline`) and cold (empty cache), full `npm run typecheck`, one test file.
- **Sizes.** Boat `default` (4 vCPU / 8 GB), Cloudflare `standard-4` (4 vCPU /
  12 GiB / 20 GB), exe.dev default VM (2 vCPU, in our plan's shared 4 vCPU pool),
  Sprites default.
- Everything ran from a laptop in the US against public APIs, so call latencies
  include about one internet round trip.

## Credentials

| Provider | Status | Where it lives (names only) |
| --- | --- | --- |
| Cloudflare (pilot account `85bbd288…`) | present | `CLOUDFLARE_API_TOKEN` in the shell env; Account API token, can deploy Workers and Containers |
| Boat | present ($100 plan: 300 at once, 30/210/840 starts per min/hour/day) | `~/.config/boat/key` |
| exe.dev | present (Team plan Medium: 4 vCPU / 16 GB shared, 50 VMs, 200 GB disk, already 15.9 GB over) | SSH key registered with `exe.dev` |
| Sprites | present (org `camelai`) | `sprite` CLI login |
| Daytona | **missing** | none in env, `~/.config`, or the repos' `.env` / `.dev.vars` files |
| E2B | **missing** | same |
| Modal | present but not a disk-fork candidate | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` in `~/camel/camel/.env` |

To add Daytona and E2B, Miguel needs to provide:
- **Daytona.** A `DAYTONA_API_KEY` from an organization with sandbox create
  permission. `_experimental_fork` (`POST /sandbox/{id}/fork`) is in the current
  SDK; no special tier is documented.
- **E2B.** An `E2B_API_KEY` (team key) on a plan whose concurrent-sandbox limit
  is above 11, because fork `count` must stay under the team limit and the
  original keeps a slot. `sandbox.fork({ count })` shipped in `e2b@2.35.0`.

The harness takes either as a new adapter in `providers.ts`. Both drivers already
exist in `src/computers/providers.ts`.

## Fork latency in detail

Times are fork call to first successful command (ms). `call` is the provider
API's own reply time. The full rows are in the JSON.

| Provider | N | call p50 | first p50 | first p95 | all N answering | all N built |
| --- | --- | --- | --- | --- | --- | --- |
| Cloudflare snapshot | 1 | 458 | 632 | 632 | 632 | 36.3 s |
| | 5 | 615 | 751 | 2,461 | 2,461 | 40.7 s |
| | 10 | 2,104 | 2,186 | 27,709 | 27,711 | 68.7 s |
| Boat stop + fork | 1 | 588 | 3,371 | 3,371 | 3,371 | 77.0 s |
| | 5 | 769 | 3,394 | 4,528 | 4,528 | 79.9 s |
| | 10 | 1,292 | 4,631 | 7,058 | 7,060 | 110.9 s |
| Boat saved snapshot (source keeps running) | 5 | 729 | 1,938 | 3,069 | 3,069 | — |
| | 10 | 1,619 | 3,002 | 9,230 | 9,231 | build p95 114 s |
| exe.dev `cp` of running VM | 1 | 1,681 | 3,456 | 3,456 | 3,457 | 40.3 s |
| | 5 | 2,265 | 3,950 | 4,790 | 4,803 | 45.5 s |
| | 10 | 3,353 | 5,090 | 7,059 | 7,068 | 49.1 s |

- **Boat's "all N built" is much longer than first command + build.** The first
  command in a new fork answered in about 3.4 s, but the build script spent
  45–53 s before `tsc` even started. That command was the `git checkout`.
  A separate run (one fork, commands timed one by one) shows why. Each first
  touch of files waits for Boat's lazy loader:
  - `git rev-parse HEAD`: 4.3 s
  - `git status`: 5.5 s
  - `git checkout -b`: 1.0 s
  - `tsc -v`: 12.2 s

  All of these take milliseconds on a hydrated disk. Cloudflare and exe.dev
  forks show under 1 s of such overhead.
- **Cloudflare's N=10 p95 is one slow restore (27.7 s)**, with the other nine
  under 3 s. Waking a slept fork from its own new snapshot also took 27 s once.
  Cloudflare says the scheduler prefers hosts that already hold the image or
  snapshot. These look like restores on a host that had to download it first.
- **Boat fork vs saved snapshot.** A fork copies the newest snapshot. On a
  running source that snapshot is up to a minute old, so the documented exact
  fork stops the source first. A saved snapshot (9.6 s) is exact and the source
  keeps running. Forks from it were slightly faster to answer but built slower
  at N=10 (p95 114 s), with the same hydration effect.

## Disk speed: fork vs fresh machine

Miguel's priority is that disk speed must not suffer from an overlay, FUSE or a
network mount. A cold read of the whole installed tree (1.66 GB, after
`drop_caches`) is the number that shows lazy restore. fio is direct I/O on a new
file in the workspace.

| | Mount under the workspace | Cold tree read | fio seq read | fio seq write | fio 4k rand read IOPS | fio 4k rand write IOPS | `git status` | `npm ci` warm / cold | full `npm run typecheck` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Boat fork, at once | `ascii-lazyfs` FUSE on `/home/user` | **13–36 MB/s** | 2.7 GB/s | 46 MB/s | 142k | 9.0k | 216 ms | 12.8 / 19.0 s | 6.1 s |
| Boat fork, hydrated | FUSE retired (`/var/lib/ascii-lazy/retired`), ext4 | 145 MB/s | 9.6 GB/s | 48 MB/s | 143k | 9.9k | 20 ms | 10.6 / 13.9 s | 6.2 s |
| Boat fresh | ext4 `/dev/vda1` | 149–320 MB/s | 10.9 GB/s | 48 MB/s | 164k | 8.1k | 321 ms | 10.1 / 13.2 s | 5.6 s |
| Cloudflare fork | btrfs `/dev/vdb` (zstd), virtio block | 60–73 MB/s | 3.1 GB/s | 218 MB/s | 36.6k | 6.7k | 58–69 ms | 17.6 / 19.4 s | 14.9 s |
| Cloudflare fresh | btrfs `/dev/vdb` | 75–90 MB/s | 3.2 GB/s | 161 MB/s | 26.6k | 5.7k | 523–909 ms | 16.5 / 18.9 s | 13.3 s |
| exe.dev fork | ext4 `/dev/vda`, local NVMe | 140–160 MB/s | 18.6 GB/s | 3.1 GB/s | 199k | 120k | 22 ms | 15.8 / 18.3 s | 18.0 s |
| exe.dev fresh | ext4 `/dev/vda` | 138–147 MB/s | 15.7 GB/s | 1.9 GB/s | 157k | 65k | 393 ms | 14.5 / 18.9 s | 18.8 s |
| Sprites restored checkpoint | overlayfs (upper on `/mnt/user-data`) | **15 MB/s** | — | 148 MB/s (node, fsync) | — | 1.5k (node) | 106 ms | 16.4 / 22.5 s | 14.6 s |

- **Cloudflare.** The restored root filesystem is the same btrfs subvolume on a
  virtio block device as a fresh container. There is no overlay or FUSE on the
  workspace; the only overlays are bind-mounts of `/etc/hostname`, `/etc/hosts`
  and `resolv.conf`. Fork and fresh are equal within run-to-run noise. The fork
  was faster on `git status` because the fresh machine's git index was cold. The
  fio seq read figures are the kernel's direct path, not the device. Seq write
  and random IOPS are the meaningful ones: modest (160–220 MB/s, 6–7k sync IOPS)
  but equal.
- **Boat.** A fresh Boat sandbox is plain ext4. A fork mounts `/home/user`, `/etc`
  and `/app` through `ascii-lazyfs` (FUSE) and downloads content in the
  background:
  - Reads of not-yet-fetched files are 4–11x slower: 13 MB/s and 36 MB/s cold in
    two runs, against 149 and 320 MB/s fresh.
  - Real commands pay for it on first touch.
  - Once Boat reports `hydrated: true` (it had by the time the first probe ended,
    within about 5 minutes), the FUSE mounts are retired and every number matches
    a fresh machine.

  Boat's write path is slow in all cases: 46–48 MB/s direct sequential write,
  fork or fresh, which looks like a per-VM limit.
- **exe.dev.** The copy is a plain ext4 disk on local NVMe and is as fast as a
  fresh VM: GB/s sequential, 65–120k random write IOPS, the fastest disk here.
  CPU-bound work (typecheck, tests) is slower because these VMs share our plan's
  4 vCPU pool with 16 other VMs.
- **Sprites.** The root is an overlay. Restored data reads at 15 MB/s cold.

## Cloudflare specifics (durable_object policy, native snapshots)

Throwaway Worker `cfork-bench` on the pilot account. It had one Durable Object
class, `Machine`, owning `ctx.container`. Fork = a new DO name whose container
starts with `start({ containerSnapshot: { id } })`. The source is in
`scripts/bench/computer-fork/cloudflare/`.

**Snapshot time against workspace size** (snapshot of the whole container root):

| Stage | Root fs used | Snapshot stored | `snapshotContainer` | Same state again |
| --- | --- | --- | --- | --- |
| empty image | 410 MB | 0.2 MB | 4.4 s | 3.9 s |
| after clone | 525 MB | 103 MB | 7.6 s | 14.7 s |
| after root `npm ci` | 1.68 GB | 837 MB | 22.1 s | 22.3 s |
| after workers `npm ci` | 2.50 GB | 1.33 GB | 31.6 s | 26.2 s |

- Snapshots store only what changed from the image, compressed. They take
  about 20–25 s per stored GB.
- Snapshotting an unchanged container again costs as much as the first time.
- **A snapshot of a fork stores only the fork's changes.** We restored the 1.3 GB
  snapshot (2.7 s), changed files and wrote a 200 MB blob. The fork's snapshot
  stored 210 MB and took 11.1 s. Restoring it took 1.4 s and the files were
  correct. So sub-agents of sub-agents chain cheaply.

**Image-version coupling, tested.**
1. We snapshotted on image rev 1.
2. We redeployed the Worker with image rev 2. Restoring the rev-1 snapshot still
   worked (424 ms) and came back running rev 1, with `/etc/bench-image-rev` = 1
   and the files intact.
3. We then deleted the rev-1 image tag from the registry. The snapshot still
   restored (553 ms).

The snapshot pins its own image: a fork always gets the parent's image even after
a deploy. A new image only reaches a workspace when the workspace is rebuilt.
camelRun should store the image version with each snapshot handle and rebuild
base snapshots after an image change. Otherwise forks keep running old images
for up to the 30-day TTL, which each restore resets.

**Sleep.** A container's disk does not survive `destroy()`. We wrote a marker,
destroyed the container and started it again with no snapshot: the marker was
gone. The persistence check that passed did `snapshotContainer` + destroy
(5.8 s), then a start from that snapshot (27 s in that run). The standalone
Cloudflare benchmark confirmed that a container stopped by its inactivity
timeout comes back empty too. camelRun
must snapshot before every planned stop, and work since the last snapshot is
lost on a crash.

**Storage.** Snapshots appear as `rootfs-snapshot-*` and `rootfs-set-*` tags under
the app's image in the account registry. That means they count against the 50 GB
account image-storage limit, and deleting those tags is how we cleaned them up.
Snapshot storage pricing is not published. The limits page gives 20 GB per
snapshot and a 30-day TTL reset by each restore.

**Failure modes hit.**
- `max_instances` is rejected for `durable_object` containers; wrangler refuses
  the config.
- One restore in ten took 27.7 s.
- The legacy Sandbox `createBackup`/`restoreBackup` overlay path was dropped on
  Miguel's instruction and not benchmarked. For the record: in 0.12.x it mounts a
  squashfs through FUSE overlayfs that disappears on sleep, needs R2 S3 keys and
  has a 3-day default TTL. SDK 1.0.3's `DirectoryBackup`, which camelRun has now,
  extracts a tar instead.

**Cross-check with the standalone Cloudflare benchmark**
(`~/cf-container-bench/RESULTS.md`, same account and day, about 60 restores).
It agrees with ours and is the better source for Cloudflare's raw numbers:
- **Restore.** p50 203 ms sequential and 342 ms in bursts of 1/5/10, timed
  inside the Durable Object. Our 0.63 s is from the laptop and includes about one
  internet round trip. Restore time doesn't depend on snapshot size (base to
  5 GB). 3 of about 60 restores took 22–63 s; our 27.7 s outlier is one of these.
- **Snapshot.** About 3.5–4 s fixed, plus data: 846 MB of `node_modules` in 30 s.
  Its size is the delta since the container started, against its image or the
  snapshot it was restored from. Successive snapshots of one running container
  are not incremental with each other: a one-line edit after a 1 GB snapshot
  re-captured all 1.08 GB.
- **Lazy loading.** Restored blocks load on demand, so the first full read of
  the workspace takes about 1–2x a fresh cold read. Repeated restores of the same
  snapshot get faster, which fits host-side caching. After first touch, restored
  equals fresh on the same host.
- **Hosts and API gaps.**
  - 10–30% of placements land on a host 25–45% slower in CPU. This affects fresh
    and restored containers alike and explains most run-to-run spread.
  - There is no Worker API to list or delete snapshots. Deleting the registry
    tags with wrangler, as we did, is the only cleanup.

**Migrating camelRun's Workers computers to the `durable_object` policy.** It is
mostly done already:
- `backends/workers/src/computers/objects.ts` defines `ContainerComputer` and
  `SandboxComputer` as `DurableObject` classes using `this.ctx.container`.
- `wrangler.computers.test.jsonc` sets `scheduling_policy: "durable_object"` on
  both.
- No code uses the legacy `Container` class or `getSandbox`.
- `ContainerProvider.snapshot`/`restore` already call `snapshotContainer` and
  `start({ containerSnapshot })` and keep the handle in DO storage.

What remains (the separate `claude/workers-do-containers` branch owns this):
1. Add the containers block to `wrangler.pilot.jsonc`; today the pilot binds no
   computers.
2. Drop the `SandboxComputer` R2 `DirectoryBackup` path.
3. Snapshot before `sleep()`. Today `sleep()` destroys the container and loses
   its disk.
4. Pick the instance per start (`instance: "standard-4"`).
5. Add the fork operation: snapshot in the parent's DO, hand the
   `{ id, imageVersion }` to the child's DO, and start the child from it.

## Boat specifics

- **API.** `POST /sandboxes/{id}/fork` is one call: bearer key, `Idempotency-Key`
  supported, and it returns once provisioned. Commands then run immediately, or
  are held up to 60 s while the fork starts.
- **Staleness.** A fork of a running sandbox uses the last background snapshot,
  taken every minute, so it can miss the last minute of writes. For an exact fork,
  either stop the source (the source is then down) or save a saved snapshot
  (9.6 s, source keeps running) and create from it.
- **What a snapshot keeps.** `/home/user`, other homes, your changes in `/etc`,
  `/usr`, `/opt` and `/var`, and Docker volumes and containers. It skips
  `~/.cache`, `/tmp` and the Docker build cache. npm's cache is in `~/.npm`, so it
  is kept.
- **Limits.** On our $100 plan: 300 sandboxes at once and 30/210/840 starts per
  minute/hour/day. Each fork counts as a start; above the limit it fails with 429
  and paid bursts cost $0.03–0.07 per start. A stopped disk is kept at least 14
  days. Saved snapshots: 50 included, then $0.056 a day each.
- **Region and sizes.** EU only (OVH bare metal; our sandboxes' IPv6 was in
  OVH's range). small/default/large/xlarge: 2/4/8/16 vCPU, 51/51/111/251 GB.
- **Failure modes hit.**
  - First-touch stalls on unhydrated forks.
  - A fork ignored our `name` and was called `<source name> fork`, so cleanup
    must track IDs, not names.
  - Node `fetch` gives up on a synchronous `/commands` call after 300 s even
    though Boat allows 600 s; long steps have to be detached and polled.

## exe.dev specifics

- **API.** `ssh exe.dev cp <vm> [new]` copies a running VM in one synchronous
  call (1.7–3.4 s) onto local NVMe. There is also an HTTPS API. Auth is your SSH
  key. `restart` (reboot) kept the fork's disk: 1.5 s + 3.0 s to the next command.
  `pause`/`resume` (RAM to disk) exists but was not used.
- **Capacity.** VMs on a Personal/Team plan share one pool: ours is 4 vCPU /
  16 GB for every VM, so 10 forks building at once share 4 vCPU. The Work plan
  bills pools at $0.105 per 2 vCPU / 4 GiB unit-hour, up to 512 vCPU and 1,000 VMs
  per pool. Standalone VMs (own capacity, same rate, per second) need a plan with
  them and team-admin approval. Our account is already 15.9 GB over its 200 GB
  disk allowance.
- **Image.** The default image (`exeuntu`) has no Node; the harness installs Node
  24 when missing.

## Sprites specifics (baseline: same machine only)

- **API.** `sprite checkpoint create` took 0.6 s; it is copy-on-write and covers
  only the writable overlay. `sprite restore <version>` took 23.3 s to the next
  command, restarting the sprite and ending its sessions. It correctly undid a
  scribbled marker and a deleted `node_modules/typescript`.
- **No fork.** There is no fork API; the dashboard has an admin-only button.
  Checkpoint/restore only rewinds the same machine, so it cannot serve parallel
  sub-agents. The restored disk is an overlay with 15 MB/s cold reads.

## Baselines: fresh machine and worktrees

**Fresh Boat machines, clone + install from scratch** (Boat is the fastest
creator here, so this is the best case for "no fork"):

| N | first command p50 | ready to build p50 / p95 | all N ready | build p50 / p95 |
| --- | --- | --- | --- | --- |
| 1 | 1.4 s | 63 s | 77 s | 13.4 s |
| 5 | 0.9 s | 43 / 63 s | 77 s | 14.8 / 20.7 s |
| 10 | 0.8 s | 62 / 77 s | 101 s | 14.4 / 24.4 s |

A fork saves about 60–75 s per sub-agent against a fresh install of this
workspace. That grows with heavier installs, native builds, Docker images or
datasets. Fresh machines then build at full speed because their disk is local
from the start. A Boat fork's first build is slower than a fresh machine's until
it hydrates.

**One VM, N worktrees (Boat default, 4 vCPU / 8 GB).** Each worktree needs its
own `node_modules` (`npm ci --prefer-offline` from the warm cache):

| N | `git worktree add` | installs (parallel) | disk | each build (p50) | all built | load avg | port 8787 clashes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.2 s | 36 s | 3.4 GB | 14.6 s | 15.0 s | 4.7 | 0 of 1 |
| 5 | 0.9 s | 350 s | 10.1 GB | 209.7 s | 211.8 s | 17.6 | 4 of 5 |
| 10 | 2.0 s | 592 s, **4 of 10 OOM-killed** | 12.0 GB | root `tsc` still running after 1,064 s (4.9 s alone) | stopped by hand at 28 min | 32.2 | — |

Worktrees are cheap to create, but everything after that contends:
- Five parallel installs took 10x longer than one.
- Five simultaneous builds each took 14x longer than a lone build. At ten, four
  installs were OOM-killed and six `tsc` processes (1.1–1.5 GB RSS each) left
  64 MB of RAM free and swapping, so no build finished in 28 minutes.
- Every worktree's dev server wants the same port, so 4 of 5 failed to bind.
- Disk use grows by about 1.7 GB per worktree.

Worktrees only fit sub-agents that mostly edit and seldom build at the same time.

## Other providers (not measured)

- **E2B.** `sandbox.fork({ count })` snapshots a running sandbox once, memory
  included, and boots up to 20 forks per call. The SDK docs say 20; the API
  reference says 100. The original pauses during the fork, for longer the more
  disk changed since its last snapshot, and its connections drop. Forks default
  to a short lifetime (15 s in the docs). Pricing: $0.000014 per vCPU-s +
  $0.0000045 per GiB-s, about $0.33/h for 4 vCPU / 8 GiB. Missing credentials.
- **Daytona.** `sandbox._experimental_fork()` (`POST /sandbox/{id}/fork`) creates
  a sandbox with a copy of the filesystem. It is labeled experimental and
  extended to Windows sandboxes in 0.186.0. Pricing: $0.0504/vCPU-h,
  $0.0162/GiB-h, disk $0.000108/GiB-h after 5 GiB free, about $0.33/h for
  4 vCPU / 8 GiB. Missing credentials.
- **AWS Lambda MicroVMs** (camelRun's current managed default). They suspend and
  resume with a snapshot, but no fork to a new MicroVM is used or documented
  here. Not tested.

## Price per fork

Published prices, 4 vCPU class, running. Storage is for the base snapshot.

| | Running | Snapshot / stopped disk | Billing model | Source |
| --- | --- | --- | --- | --- |
| Cloudflare `standard-4` | memory 12 GiB × $0.0000025/GiB-s = $0.108/h; CPU $0.000020/vCPU-s active only, up to $0.288/h; disk 20 GB × $0.00000007/GB-s = $0.005/h. So $0.11–0.40/h | not published; counts toward 50 GB image storage | active CPU, provisioned memory and disk, 10 ms increments | developers.cloudflare.com/containers/pricing, …/platform-details/limits |
| Boat `default` | $0.036/h | stopped disk free ≥ 14 days; saved snapshot $0.056/day beyond plan | per second while running | docs.boat.dev/pricing |
| exe.dev | $0.21/h standalone 4 vCPU / 8 GiB; pool VMs share a pool billed by capacity | 100 GB disk per 2 vCPU of pool, then per GiB-month | per second (standalone), per hour (pool) | exe.dev/docs/standalone-vms, /docs/pools |
| Sprites | ~$0.33/h busy (CPU $0.0385/CPU-h, memory $0.021875/GB-h) | $0.02/GB-month cold | active CPU and used memory | sprites.dev pricing (camelRun notes 2026-11-03) |
| E2B | ~$0.33/h | n/a (fork snapshot is transient) | per second | e2b.dev pricing |
| Daytona | ~$0.33/h | $0.000108/GiB-h after 5 GiB | per second | daytona.io/pricing |

## Proposed camelRun API

Today a sub-agent made by `delegate` or `spawn_agent` gets its own computer
connection with the parent's settings and **no session**: its first
`computer_start` makes an empty machine. Forking adds one choice: start the
child's machine from a snapshot of the parent's current session.

### Requesting a fork

```jsonc
// spawn_agent / delegate tool arguments (and the same field on a sub-agent definition)
{ "task": "Fix the flaky cluster test on a branch", "computer": "fork" }   // "fork" | "fresh" (default) | "none"
```

```http
POST /v1/computers/{id}/fork            # id = the parent's connection
{ "agent": "agt_child", "count": 1 }    # → 201 { connections: [ { id, agent, provider, forkedFrom: { connection, session, snapshot, imageVersion, at } } ] }
```

- `computer: "fork"` creates the child's connection with a `seed`. The snapshot
  is taken **at the call**, so the child sees the parent's files as they were
  when it asked. The child's first `computer_start` restores from the seed;
  later sessions resume its own disk.
- One `delegate` call with N tasks takes **one** snapshot and makes N restores,
  matching Cloudflare's one handle for N DOs and Boat's saved snapshot + N
  creates.
- The REST route does the same for API users, and for "fork my computer to a
  new agent I already made".
- Forks are independent machines. Results come back the usual way: the child
  pushes a branch, or copies a `git bundle` or files to a shared volume. Merging
  stays the parent's job.
- Each fork is billed as its own session. The seed snapshot is billed (Boat saved
  snapshot) or counted against storage (Cloudflare). It is deleted when the last
  child seeded from it detaches. Cloudflare's 30-day TTL is the backstop.
- Errors:
  - `409 fork_unsupported`: the provider can't fork, as with Sprites or tunnels.
    The caller can retry with `"fresh"`.
  - `409 no_session`: the parent has no running machine to fork.

### Driver seam

```ts
interface ComputerDriver {
  // existing: create, call, close …
  snapshot?(ref: Reference, label: string): Promise<SnapshotRef>;   // { provider, id, imageVersion?, sizeBytes?, expiresAt? }
  create(id: string, seconds: number, allocated?: …, options?: { from?: SnapshotRef }): Promise<Reference>;
  dropSnapshot?(snap: SnapshotRef): Promise<void>;
}
```

| Provider | `snapshot` | `create({ from })` | Notes |
| --- | --- | --- | --- |
| Cloudflare (Workers) | parent DO: `ctx.container.snapshotContainer({ name })` → `{ id, size }` + image version | child DO: `ctx.container.start({ containerSnapshot: { id }, instance })` | handle is plain data; store it in the child DO. Snapshot before every sleep. Drop = delete the `rootfs-snapshot` tag or wait for the TTL |
| Boat | `POST /saved-snapshots { sandboxId, name }`, poll to `ready` (exact, source runs) | `POST /sandboxes { from: name, ttlSeconds }` with `Idempotency-Key` | cheaper variant: `POST /sandboxes/{id}/fork` (≤ 1 min stale). Optionally wait for `hydrated` or pre-read the repo before heavy builds |
| exe.dev | none needed | `cp <parentVm> <childVm> [--standalone]` | copies the running VM; needs pool capacity or standalone approval |
| E2B | `fork({ count })` does both | — | memory too; pauses the parent briefly |
| Daytona | `_experimental_fork()` | — | experimental |
| Lambda MicroVMs, Sprites, tunnel | unsupported → `fork_unsupported` | | |

## Machines created and deleted

Every machine, sandbox, Worker, container app, image and snapshot this work
created is deleted. Each harness run ends by deleting what it made and then
listing the provider's machines. The `leftovers` field in each results file is
the empty listing.

| Provider | Created | Deleted / proof |
| --- | --- | --- |
| Cloudflare | Worker `cfork-bench` (workers.dev), container app `cfork-bench` (`f11f5e98…`), image `cfork-bench-machine-workspace` with 27 tags (2 image builds + 25 snapshot tags), DOs `cfork-*`/`cfx-*` (about 35 containers) | `wrangler delete --name cfork-bench`; script API `GET /workers/scripts/cfork-bench` → 404; `https://cfork-bench.miguel-85b.workers.dev` → 404; `wrangler containers delete f11f5e98…`; `wrangler containers list` shows no `cfork`; all 27 image/snapshot tags deleted and `wrangler containers images list` shows no `cfork` repo. DO storage was cleared by each machine's `destroy`; the class went with the Worker |
| Boat | about 60 sandboxes (`cfork-*` sources, forks, fresh and worktree machines, `cfork-explore`, `cfork-gap-src` + its fork), 1 saved snapshot `cfork-*-base` | DELETE each (`X-ASCII-Confirm-Delete`), then `GET /sandboxes/{id}` → 404. Final `GET /sandboxes` and `GET /saved-snapshots` show no `cfork` entries (0 sandboxes in the account at 2026-11-06T22:34Z, no `cfork` saved snapshot) |
| exe.dev | about 24 VMs `cfork-*` (sources, forks, fresh, `cfork-probe-x`) | `ssh exe.dev rm`; final `ssh exe.dev ls` shows 0 `cfork` VMs at 22:34Z |
| Sprites | 1 sprite `cfork-*-src` + checkpoint v2 | `sprite destroy --force` (checkpoints go with it); final `sprite list` shows 0 `cfork` sprites at 22:34Z |
| Production / pilot | none touched | the pilot Worker `camelrun-pilot` and run-pilot.camelai.dev were never deployed to or called |

**Spend.** Boat: 3.53 default-equivalent VM-hours, within the plan's
included time ($0 billed, about $0.13 at list price). Cloudflare: about 35
`standard-4` container runs of a few minutes each, under $1 at list price and
within the Workers Paid included usage. exe.dev: within the plan, plus transient
disk. Sprites: one sprite for about 6 minutes, about $0.05.

## Reproduce

```sh
cd scripts/bench/computer-fork
node --experimental-strip-types bench.ts --provider boat            # stop + fork, N = 1,5,10, probe fork vs fresh
node --experimental-strip-types bench.ts --provider boat-saved --rounds 5,10 --skip-probe --skip-fresh
node --experimental-strip-types bench.ts --provider exe
node --experimental-strip-types bench.ts --provider fresh            # N fresh machines, clone + install
node --experimental-strip-types bench.ts --provider worktrees        # one machine, N worktrees
node --experimental-strip-types bench.ts --provider sprites          # checkpoint/restore on one sprite
# Cloudflare: deploy the throwaway Worker, set its token, run, then delete everything
(cd cloudflare && npm ci && npx wrangler deploy && openssl rand -hex 24 | tee /tmp/tok | npx wrangler secret put BENCH_TOKEN)
node --experimental-strip-types bench.ts --provider cloudflare --tokenFile /tmp/tok --url https://cfork-bench.<subdomain>.workers.dev
node --experimental-strip-types cloudflare-extras.ts --tokenFile /tmp/tok --checks size,chain,sleep
(cd cloudflare && npx wrangler delete --name cfork-bench && npx wrangler containers list)   # then delete the app and image tags
```

Use `--rounds 0` to run only the disk probe.

# Block volumes: measurements

What ran, where, and what could only be designed. The shape is in [DESIGN.md](DESIGN.md).

## Host

A Fly Sprite (`rt-pool-5`): 8 vCPU x86_64, 8 GB, kernel `6.12.116-fly`, root on an overlay over a network-backed
disk (local ext4 cold reads of a 500 MB tree run at ~90 MB/s here, so every "local" number is this disk, not an NVMe).
Root with `CAP_SYS_ADMIN`; no udev (`DM_DISABLE_UDEV=1`); no KVM. Kernel features found:

| feature | sprite | AL2023 6.18 job host | used here |
|---|---|---|---|
| dm-thin (`thin-pool`, `thin`, external origin), dm-snapshot, dm-cache, dm-writecache | built in | yes | thin pool + external origin |
| NBD (`CONFIG_BLK_DEV_NBD=y`, 16 devices) | built in | yes | the lazy device |
| ublk | `=m`, no modules tree, cannot load | module | designed only |
| dm-clone | unset | module | designed only |
| loop | built in | yes | pool data/metadata files, local baseline |
| ext4 | built in | yes | the filesystem |
| XFS, Btrfs, ZFS | none | XFS (reflink on the hosts' NVMe) | — |
| FUSE + passthrough (`CONFIG_FUSE_PASSTHROUGH=y`, libfuse 3.18, go-fuse 2.12) | yes | yes | FUSE baselines |
| KVM / Firecracker | no `/dev/kvm` | Nitro Sandboxes | designed only |

Userspace: `dmsetup` 1.02 / driver 4.48, `thin-provisioning-tools` (`thin_dump`), `nbd-client`, `fio` 3.x, Go 1.27, Node 22.

## What ran

`bench/run.sh <size>` (`lazyblk/` is the Go program), per size:

1. the shared bench tree (same generator and sizes as `prototypes/artifacts-volumes/bench`) copied into a fresh ext4
   image (`mkfs.ext4 -E lazy_itable_init=0,lazy_journal_init=0`; 1 GiB for small, 2 GiB medium, 4 GiB large);
2. `lazyblk store`: a stand-in S3 on localhost that adds **15 ms** to every chunk GET (S3 first-byte class) and
   nothing to PUT/HEAD; `lazyblk import` chunks the image at 256 KiB, uploads non-zero chunks, publishes a root;
3. `lazyblk serve`: the lazy NBD device for that root with an empty host chunk cache; `nbd-client -C 4`;
   a dm-thin pool (256 KiB blocks, data and metadata on loop files on the same disk); a thin with the NBD device as
   **external origin**; `mount` → cold first file, `ls -R`, `tar` of the tree cold, again with the page cache
   dropped but the chunk cache warm, again from the page cache; `grep -r`;
4. the same tree on a plain loop-mounted ext4 on the same disk, as the local baseline;
5. the "small change" (3 files rewritten) → checkpoint: `dmsetup suspend/create_snap/resume` (the snapshot),
   `thin_dump` of the snapshot's mappings, `lazyblk checkpoint` (hash mapped chunks, upload the changed ones, new
   root), `lazyblk diff` of the two roots;
6. `lazyblk index` (walk + sha256 + FIEMAP extents per file) full, then incremental after one more touched file;
   `lazyblk read` of two files **from the store alone by tree + extents** (the Workers path);
7. a fork: `create_snap` of the checkpoint snapshot, mounted beside the original; write isolation checked;
8. `git init && git add -A && git commit` on both mounts (hashes every file, writes ~1 object per file), then a second
   checkpoint of that larger delta;
9. `lazyblk fsbench`: 2,000 small files; median/p99 of create+write (4 KiB), stat cold (after `drop_caches`) and
   warm, open+read cold and warm, overwrite, unlink, on: local ext4; the NBD+thin ext4; a go-fuse loopback over the
   local ext4 with passthrough disabled; the same with kernel passthrough.

The first run of each size had the git workload *before* the small change, so its "checkpoint A" includes git's
objects; the medium rerun below has the corrected order (change → checkpoint A → git → checkpoint B).

## Numbers

Times in ms unless marked; one run each (medians over 2,000 ops for the per-op table).

### Getting a version onto a machine, and reading it

| | small (200 files, 1 MB) | medium (5k, 50 MB) | large (50k, 500 MB) |
|---|---:|---:|---:|
| image build: `cp` tree into ext4 (once per lineage) | 413 | 1,8xx | see below |
| import: chunk + hash + upload the image | 979 (17 chunks) | see rerun | 17,875 (2,510 chunks, 658 MB) |
| **mount cold** (NBD + thin + ext4 mount; superblock, group descriptors) | 130 | see rerun | 1,939 |
| **first file, cold** (after mount; 1 chunk GET) | 26 | see rerun | 79 |
| `ls -R` cold (directory + inode blocks, no data) | 10 | see rerun | 7,811 |
| full tree read, cold (chunk GETs in flight, 4-chunk prefetch) | 10 (11 GETs) | see rerun | 3,032 (1,237 GETs, 324 MB) |
| full tree read, page cache dropped, chunk cache warm (NBD round trips only) | 59 | see rerun | 4,525 |
| full tree read from the page cache | 8 | see rerun | 154 |
| local ext4, full tree read cold / page cache | 17 / 8 | see rerun | 5,485 / 150 |
| `grep -r` after `drop_caches`: NBD warm cache / local | 87 / 40 | see rerun | 32,674 / 11,464 |

Reading: the cold path costs the chunk GETs and nothing else (3.0 s for 500 MB at 15 ms per GET with prefetch,
against 5.5 s for the local disk's own cold read here). Once the chunk cache is warm, a *data-sequential* read
(`tar`) through NBD is as fast as local; a *metadata-random* one (`ls -R` cold, `grep -r` after dropping the page
cache) is ~3× slower, which is the per-request cost of a userspace block device on small random reads. That is the
case dm-clone hydration (and ublk) is for: after first touch the region is local and the kernel serves it.

### Checkpoint, fork, index, diff, the Workers read

| | small | medium (first run; A includes git's objects) | large |
|---|---:|---:|---:|
| thin snapshot (`suspend`+`create_snap`+`resume`+device) | 1,111 (ext4 flush in `suspend`) | 266 | see below |
| `thin_dump` of the snapshot's mappings | 78 | 78 | |
| checkpoint A: hash mapped chunks, upload changed, publish root | 62 (18 chunks, 4.5 MiB) | 234 (190 chunks, 47 MiB: git's objects) | 1,256 chunks |
| checkpoint B (second delta) | 324 (6 chunks) | 417 (34 chunks, 8 MiB) | |
| block diff of two roots | 0.2 | 0.4 | 0.8 |
| index, full (walk + sha256 + FIEMAP) | 23 (431 files incl. `.git`) | 177 (10,132 files incl. `.git`) | 14,762 (101k files incl. `.git`) |
| index, incremental (stat-unchanged files reuse hash + extents) | 16 (1 rehashed) | 79 (7 rehashed) | |
| file diff of two indexes | 2 | 35 | |
| **Workers read of one 10 KB file from chunks alone** | 16 (1 GET) | 16, 17 (1 GET each) | |
| fork: `create_snap` + device | 61 | 92 | |
| fork: mount beside the origin (same ext4 UUID accepted) | 45 | 121 | |
| fork: first file | 8 | 9 | |
| git add+commit of the tree: local / NBD+thin | 152 / 236 | 2,751 / 3,982 | 18,901 / |

### Per-op latency (µs, median / p99), 2,000 files of 4 KiB — medium run

| op | local ext4 | NBD + dm-thin ext4 | FUSE loopback, no passthrough | FUSE with kernel passthrough |
|---|---:|---:|---:|---:|
| create+write | 34 / 69 | 33 / 63 | 205 / 599 | 180 / 302 |
| stat, cold | 9.3 / 22 | 9.0 / 19 | 41 / 109 | 45 / 127 |
| stat, warm | 3.4 / 11 | 3.2 / 10 | 3.5 / 13 | 3.5 / 14 |
| open+read, cold | 45 / 352 | 53 / 4,741 | 179 / 580 | 165 / 603 |
| open+read, warm | 10.3 / 19 | 10.3 / 22 | 106 / 238 | 72 / 179 |
| overwrite | 52 / 84 | 58 / 165 | 237 / 442 | 226 / 449 |
| unlink | 29 / 48 | 29 / 51 | 98 / 249 | 66 / 155 |

The block path *is* local ext4: every op within noise (the cold open+read p99 is the thin pool's first-write COW and
the NBD round trip for the few base blocks the new files' metadata shares). FUSE is 5–10× on every metadata op and
on open; kernel passthrough takes the warm read from 106 to 72 µs (the data copy no longer crosses, but every
open/release still does) and does nothing for stat, create, unlink. Warm `stat` is the same everywhere because the
kernel's dentry/inode cache answers it (FUSE entry timeout 1 s here).

## Designed, not run

- **ublk** instead of NBD: no loadable modules on the sprite. Same protocol shape (per-request userspace handling),
  io_uring instead of TCP sockets, and `UBLK_F_USER_RECOVERY` for daemon restarts. Expect the "metadata-random after
  drop_caches" gap to shrink, not vanish.
- **dm-clone** between the lazy device and the thin pool: background hydration into a local NVMe file, kernel-served
  after that, detachable daemon. This is what turns "warm" into "native" for the first touch too.
- **Firecracker / Nitro Sandboxes**: the thin device as a virtio-blk drive with `io_engine: Async`; no KVM here. The
  job-hosts spike measured 447k IOPS on a reflinked file; a dm-thin device should be re-measured.
- **XFS reflink composition** of complete images from the chunk cache (zero-copy, dedupe kept by the filesystem) as
  the "fully warm, no daemon" fast path for hot repos.
- **S3 itself**: 15 ms was injected per chunk GET on localhost; real S3 adds bandwidth limits per connection and a
  tail. The GET counts above are the inputs for that estimate (1,237 GETs for a cold 500 MB tree read).
- **Automatic checkpoints, guest `fsfreeze`, `thin_delta`-based deltas, GC, merge**: described in DESIGN.md; the
  prototype checkpoints from `thin_dump` (all mapped blocks of the snapshot), which is why "mapped scanned" grows
  across checkpoints while "changed" stays the delta.

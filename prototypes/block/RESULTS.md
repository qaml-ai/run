# Block volumes: measurements

What ran, where, and what could only be designed. The shape is in [DESIGN.md](DESIGN.md). Two hosts: a real EC2
nested-KVM host with real S3 and local NVMe (the numbers that matter), and a Fly Sprite used first for the kernel
survey and a dry run (noisy, network-backed disk; kept as a cross-check).

## Hosts

**EC2 m8id.4xlarge nested** (created by Miguel for the prototypes): 16 vCPU Intel Xeon 6975P, 64 GiB, Ubuntu 24.04,
kernel `7.0.0-1014-aws`, `/dev/kvm` (nested), 884 GB instance-store NVMe formatted XFS `reflink=1` at `/nvme` (chunk
cache, pools, images, the local baseline), real S3 bucket `camel-fs-proto-904534089871-usw2` in `us-west-2` through
the instance role, udev present. Modules loaded: `ublk_drv`, `dm-thin-pool`, `dm-clone`, `nbd`. Cloud Hypervisor
v54.1 (static), guests boot the host kernel + initrd directly (`hypervisor-fw` cannot parse noble's grub config).

**Sprite `rt-pool-5`**: 8 vCPU x86_64, 8 GB, kernel `6.12.116-fly`, root on an overlay over a network-backed disk
(a 500 MB tree reads cold at ~90 MB/s), `CAP_SYS_ADMIN`, no udev (`DM_DISABLE_UDEV=1`), no KVM, no dm-clone, ublk
built as a module with no modules tree. dm-thin, NBD, loop, ext4, FUSE passthrough present; no XFS/Btrfs/ZFS.

## What ran

`bench/run.sh <size>` (`lazyblk/` is the Go program; `BENCH_DIR`, `STORE=s3://…`, `CLONE=1` select the EC2 setup):

1. the shared bench tree (same generator and sizes as `prototypes/artifacts-volumes/bench`) copied into a fresh
   ext4 image (`mkfs.ext4 -E lazy_itable_init=0,lazy_journal_init=0`; 1 GiB small, 2 GiB medium, 4 GiB large);
2. `lazyblk import`: chunk the image at 256 KiB, upload the non-zero chunks (16 in flight), publish a root. On EC2
   the store is real S3 (AWS SDK, instance role); on the sprite a localhost stand-in adding 15 ms per chunk GET;
3. `lazyblk serve`: the lazy NBD device for that root with an empty host chunk cache; `nbd-client -C 4`; on EC2 a
   **dm-clone** target over it (destination: a sparse file on the NVMe, 256 KiB regions, hydration off); a dm-thin
   pool (256 KiB blocks); a thin with the clone (EC2) or the NBD device (sprite) as **external origin**; `mount` →
   cold first file, `ls -R`, full tree read (`tar cf - | cat`, which does read the bytes; `tar cf /dev/null` does
   not, and a first run was discarded for that), the same with the page cache dropped but the chunk cache warm,
   from the page cache, and `grep -r`; on EC2 then `enable_hydration`, wait for 100%, and the reads again (a
   kernel-only path);
4. the same tree on a plain loop-mounted ext4 image on the same disk: the local baseline;
5. the small change (3 files) → checkpoint: `dmsetup suspend/create_snap/resume`, `thin_dump` of the snapshot,
   `lazyblk checkpoint` (hash mapped chunks, upload changed, publish root), `lazyblk diff` of the roots;
6. `lazyblk index` (walk + sha256 + FIEMAP extents) full, then incremental after one touched file; `lazyblk read`
   of two files **from the store alone by tree + extents** (the Workers path, no mount, no host);
7. a fork: `create_snap` of the checkpoint snapshot, mounted beside the original, isolation checked;
8. `git init && git add -A && git commit` on both mounts, then a checkpoint of that delta;
9. `lazyblk fsbench`: 2,000 files of 4 KiB; median/p99 of create+write, stat cold (after `drop_caches`) and warm,
   open+read cold and warm, overwrite, unlink on: local ext4; the lazy stack; go-fuse loopback over the local ext4
   without passthrough; the same with kernel passthrough;
10. `fio` 4 KiB random reads, direct, QD1 and QD16, on the raw local loop device and on the raw NBD device (chunk
    cache warm).

`bench/guest.sh` boots a Cloud Hypervisor guest (4 vCPU, 4 GiB, virtio-blk, `image_type=raw`) with a host device as
`/dev/vdc` and runs steps 3 and 9 inside it: once per state of the lazy stack (cold S3, warm cache, hydrated) and
once on a plain raw image on the NVMe.

## EC2 m8id.4xlarge nested: host side

Times in ms unless marked. Real S3: chunk GET 30–39 ms average measured inside the daemon (256 KiB objects).

### Getting a version onto the host, and reading it

| | small (200 files, 1 MB; 1 GiB image) | medium (5k, 50 MB; 2 GiB) | large (50k, 500 MB; 4 GiB) |
|---|---:|---:|---:|
| image build: `cp` tree into ext4 (once per lineage) | — | 140 | 5,045 |
| import: chunk + hash + upload to S3 | — (17 chunks) | 2,191 (262 chunks, 65 MB) | 14,092 (2,555 chunks, 655 MB) |
| **mount, cold** (NBD + clone + thin + ext4) | 79 | 45 | 75 |
| **first file, cold** (one chunk GET) | 67 | 72 | 323 |
| `ls -R`, cold | 2 | 16 | 569 |
| full tree read, cold (4-chunk sequential prefetch) | 179 (12 GETs) | 3,418 (254 GETs) | 40,281 (2,438 GETs, 639 MB) |
| full tree read, page cache dropped, chunk cache warm (NBD round trips) | 64 | 1,456 | 12,953 |
| `grep -r`, same state | 69 | 1,318 | 12,150 |
| **dm-clone full hydration** (whole image, zero regions included) | 1,018 | 1,801 | 6,448 |
| full tree read, page cache dropped, **hydrated** (no userspace in the path) | 47 | 843 | 7,351 |
| `grep -r`, hydrated | 36 | 822 | 8,286 |
| `ls -R`, hydrated | 13 | 24 | 132 |
| **local NVMe ext4**: full tree read cold / `grep -r` cold | 44 / 32 | 726 / 745 | 7,198 / 6,522 |
| full tree read from the page cache: lazy / local | 3 / 3 | 32 / 32 | 319 / 316 |

Reading it:

- **Cold is S3-bound and the prototype's prefetch is too shallow.** 2,438 GETs at ~37 ms with 4 in flight is the
  40 s; the same tree from the sprite's 15 ms stand-in took 3 s. With 32–64 chunks in flight (Lambda-style
  access-pattern prefetch, or whole-lineage hydration on first mount) the bound becomes S3 throughput, ~1–2 s for
  500 MB. It is a parameter, not a design limit, and was left at 4 so the numbers show the per-GET cost.
- **Warm through NBD costs ~1.8× local** on a metadata-heavy full read (13.0 s vs 7.2 s; 1.46 s vs 0.73 s). That
  is the per-request userspace round trip, measured directly below (+27 µs per 4 KiB at QD1).
- **Hydrated equals local** (7.35 s vs 7.20 s; 843 vs 726 ms; 47 vs 44 ms). dm-clone hydrates a 4 GiB image in
  6.4 s from the warm cache, and after that the daemon is out of the read path. This is the result the design
  rests on: kernel-native once warm, lazy before.
- The local NVMe "cold" numbers are slow in absolute terms (70 MB/s on 50k files) because they are 50k `open`s plus
  metadata reads after `drop_caches`, not bandwidth; the page-cache rows (316 ms) are the same tree without I/O.

### Checkpoint, fork, index, diff, the Workers read

| | small | medium | large |
|---|---:|---:|---:|
| thin snapshot (`suspend`+`create_snap`+`resume`+device) | 99 | 90 | 207 |
| `thin_dump` of the snapshot's mappings | — | 44 | 42 |
| **checkpoint of the 3-file change**: hash mapped, upload changed, publish | 331 (6 chunks, 1 MiB) | 485 (17 chunks, 4 MiB) | 882 (124 chunks, 31 MiB) |
| checkpoint after `git add`+`commit` (objects for every file) | 381 (16 chunks) | 979 (150 chunks, 37 MiB) | 8,258 (1,437 chunks, 359 MiB) |
| block diff of two roots | — | 0.4 | 0.5 |
| index, full (walk + sha256 + FIEMAP), 8 threads | 10 (200 files) | 124 (5,000) | 1,085 (50,000; 12 MB JSON) |
| index, incremental (stat-unchanged files keep hash + extents) | 5 (1 rehashed) | 32 (1 rehashed) | 300 (1 rehashed) |
| file diff of two indexes | — | 23 | 242 |
| **Workers read of one 10 KB file from S3 alone** (tree + extents → 1 GET) | — | 22, 34 | 59, 20 |
| fork: `create_snap` + device | 20 | 127 | 29 |
| fork: mount beside the origin (same ext4 UUID accepted) | 9 | 8 | 9 |
| fork: first file | 2 | 1 | 2 |
| `git add`+`commit` of the tree: local / lazy stack | — | 926 / 947 | 7,415 / 8,466 |

The 3-file checkpoint floor grows with the image: 1 → 4 → 31 MiB for 1 → 2 → 4 GiB. That is ext4 metadata and
journal blocks (bitmaps, group descriptors, inode tables, journal), not data, and it is the one cost of the block
view that the file view does not have. It is bounded per checkpoint, not per file, so batching (every 30 s, at job
end) keeps it small; pinning the journal to a fixed set of chunks and `thin_delta` against the previous snapshot
would cut the scan and the upload further.

### Per-op latency, host (µs, median / p99), 2,000 files of 4 KiB — medium run

| op | local NVMe ext4 | lazy stack (NBD → clone → thin → ext4) | FUSE loopback, no passthrough | FUSE, kernel passthrough |
|---|---:|---:|---:|---:|
| create+write | 8.4 / 22 | 8.4 / 21 | 156 / 617 | 136 / 194 |
| stat, cold | 3.3 / 11 | 2.5 / 13 | 34 / 76 | 37 / 277 |
| stat, warm | 1.2 / 4.8 | 0.9 / 3.6 | 1.0 / 3.9 | 1.1 / 4.1 |
| open+read, cold | 35 / 188 | 37 / 303 | 183 / 747 | 137 / 411 |
| open+read, warm | 2.9 / 5.0 | 2.9 / 4.2 | 96 / 311 | 65 / 92 |
| overwrite | 12.8 / 25 | 12.6 / 58 | 197 / 575 | 164 / 204 |

The lazy stack *is* local ext4 at the file-op level (the cold open+read p99 is the thin pool's first-write COW plus
an NBD round trip for the few base blocks new files share). FUSE is 10–40× on create, cold stat, open and
overwrite; kernel passthrough takes the warm read from 96 to 65 µs (still 22× native: open/release cross to the
daemon even when the read does not) and leaves everything else where it was. Warm `stat` is the same everywhere
because the dentry cache answers it.

### Raw device, 4 KiB random reads, direct (host)

| | QD1 iops / mean µs / p99 µs | QD16 iops / mean µs / p99 µs |
|---|---|---|
| NVMe (loop over a file on XFS) | 51,000 / 16 / 102 | 449,000 / 34 / 106 |
| NBD lazy device, chunk cache warm (Go daemon, 4 connections) | 18,700 / 44 / 163 | 102,000 / 149 / 330 |

+27 µs and 2.7× fewer IOPS at QD1, 4.4× fewer at QD16: the cost of a userspace block device on every request. It
is paid only before hydration; ublk over io_uring would reduce it, dm-clone removes it.

## EC2 m8id.4xlarge nested: guest side (Cloud Hypervisor on nested KVM, virtio-blk)

Medium tree (5k files, 50 MB, 2 GiB image). The guest gets the host device as `/dev/vdc`; `drop_caches` is the
guest's (the host's page cache stays, which is what a job host looks like too). Boot to ssh: 8.5–9.5 s (cloud-init
included; not optimized).

| | lazy stack, cold (S3) | lazy, chunk cache warm | lazy, **hydrated** | plain raw file on NVMe |
|---|---:|---:|---:|---:|
| first file, cold | 45 | 18 | 16 | 15 |
| full tree read, cold | 3,334 | 826 | 823 | 680 |
| full tree read, page cache | 75 | 74 | 66 | 62 |
| `grep -r`, cold | 503 (cache warm by then) | 779 | 643 | 370 |
| create+write (µs, median / p99) | 8.3 / 32 | 8.3 / 82 | 8.3 / 114 | 8.2 / 29 |
| stat cold / warm (µs) | 2.5 / 0.8 | 2.5 / 0.8 | 2.5 / 0.9 | 2.5 / 0.7 |
| open+read cold (µs) | 75 / 183 | 82 / 248 | 80 / 156 | 52 / 106 |
| open+read warm (µs) | 2.9 / 9.7 | 3.0 / 21 | 2.9 / 6.6 | 2.9 / 15 |
| overwrite (µs) | 11.5 / 48 | 17.2 / 70 | 13.7 / 70 | 27.4 / 70 |
| unlink (µs) | 5.3 / 25 | 6.0 / 28 | 5.3 / 25 | 5.4 / 25 |

- **Inside the guest the lazy volume is a local disk.** Every warm op matches the plain file (stat 2.5 µs, warm
  open+read 2.9 µs, create 8.3 µs, unlink 5.3 µs); the cold open+read of freshly created files is +25–30 µs
  because those blocks sit in the thin pool (loop over a file) rather than a raw file, a layering cost that a pool
  on a raw NVMe partition would not have.
- **Nested KVM costs nothing visible at the file level**: guest warm open+read 2.9 µs = host 2.9 µs, create 8.3 =
  8.4, stat 2.5 = 2.5. The virtio-blk exit cost shows only on cold I/O (+15–20 µs on cold open+read vs the host).
- **Cold S3 in the guest is the host's cold S3** (3.3 s vs 3.4 s for 50 MB at 4-deep prefetch); warm and hydrated
  full reads are 1.2× the plain file (826 / 823 vs 680 ms), the difference being the thin layer over loop files.
- The hydration itself (2.0 s for the 2 GiB image) ran between the warm and hydrated boots.

## Sprite (cross-check; 15 ms injected S3 latency, slow disk)

Same script, first run; a noisy host, so trends only. ms.

| | small | medium | large |
|---|---:|---:|---:|
| mount cold / first file cold | 130 / 26 | 278 / 28 | 1,939 / 79 |
| `grep -r`: NBD warm cache / local cold | 125 / 64 | 3,900 / 3,290 | 32,674 / 11,464 |
| checkpoint of the 3-file change | 27 (6 chunks) | 96 (18 chunks) | — |
| index full / incremental | 23 / 11 | 554 / 66 | 14,762 (101k files incl. `.git`) / 1,367 |
| Workers read of one file | 16 (1 GET) | 16, 17 | 30, 324 |
| fork create / mount | 67 / 46 | 92 / 121 | 49 / 430 |
| fio 4 KiB QD1: loop vs NBD (µs) | — | 77 vs 91 | — |
| open+read warm (µs): local / lazy / FUSE / FUSE-PT | 10 / 10 / 99 / 75 | 10 / 10 / 106 / 72 | 10 / 10 / 104 / 86 |

The same shape as EC2 with everything 3–10× slower. The sprite's `tar` rows were taken with `tar cf /dev/null` and
are metadata-only, which is why only `grep -r` is shown.

## Designed, not run

- **ublk** instead of NBD: the module loads on EC2 (`ublk_drv`), but no ublk userspace server was written in the
  timebox; the NBD daemon stands in. Expect the QD1 gap (+27 µs) to shrink, and `UBLK_F_USER_RECOVERY` to cover
  daemon restarts.
- **Deep prefetch / lineage hydration** from S3 (32–64 in flight; access-pattern replay): the cold numbers above are
  with 4 in flight.
- **`thin_delta`** between the previous checkpoint's snapshot and the new one (the prototype scans all mapped
  blocks of the snapshot).
- **Thin pool on a raw NVMe partition** rather than loop files (the +25–30 µs cold open+read in the guest).
- **Nitro Sandboxes**: no host; the Firecracker docs say a host block device as virtio-blk works there (DESIGN.md,
  "The guest device").
- **vhost-user-blk** from the daemon straight into the guest (Cloud Hypervisor supports it): not built; the kernel
  stack over virtio-blk is the recommendation and was the thing to measure first.
- **XFS reflink composition** of complete images from the chunk cache; automatic checkpoints; guest `fsfreeze`;
  GC; merge: in DESIGN.md.

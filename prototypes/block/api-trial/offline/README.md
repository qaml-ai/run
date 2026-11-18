# Edit a sleeping ext4 workspace

A workspace with a cleanly unmounted ext4 volume can accept a file edit without starting Firecracker. The two editors in this experiment read the same S3 blocks and conditional ref as the VM writer. Both write to a private copy and return success after the changed blocks, immutable map and new ref reach S3. The Linux mount exists only for one edit. The userspace editor uses libext2fs with a small IO adapter and never attaches a kernel device. Both paths were exercised on a trusted fixture.

## Native measurements

The file was an existing singly linked regular file replaced by a 33-byte value. The fixture, EC2 m8id.xlarge, 256 KiB storage blocks, instance-store NVMe and regional S3 bucket match the parent trial. Each editor ran three independent sequences. An initialized coordinator handled each request, checked the ownership state and loaded the block map. Each first edit started with an empty NVMe block cache. The next three edits in each sequence used its populated cache. No workspace VM was running during any timed edit.

| Durable edit, median | Empty cache, 3 edits | Populated cache, 9 edits | First edit after guest unmount, 3 edits |
| --- | ---: | ---: | ---: |
| Temporary Linux ext4 mount | 854 ms | 477 ms | 647 ms |
| Userspace libext2fs | 529 ms | 168 ms | 265 ms |

The userspace edit itself took a median 4.5 ms with cached blocks. In that condition it uploaded 256 KiB of block bodies per edit, plus a new map and ref. The Linux mount uploaded 768 KiB per edit. Both measurements include durable publication. The earlier wake-and-edit path took 1.73 s with an empty cache and 1.32 s with a populated cache. This is a comparison of separate runs on the same fixture. [Previous trial](../README.md)

## Handoff and integrity

In each sequence a real Firecracker guest booted from a fresh cache and checked the API edit from Bash. An offline candidate that staged a competing edit before the guest claimed the workspace lost its conditional publish with HTTP 412. An edit begun after the guest acquired ownership failed immediately. The guest then unmounted cleanly and published its sleeping state. The offline editor changed the workspace again, and a second guest verified that edit. A separate machine reconstructed all 48 published revisions from S3, checked every image with e2fsck and verified the edited and untouched files. Local fixture tests also covered growth across storage blocks, truncation to zero, regrowth, a corrupt block and a disk requiring journal replay. [Native trials](native.json) and [independent audit](verified.json)

## Relation to Fly Sprites

Fly describes its newer SBD backend as ext4 over NBD, with an in-Sprite daemon handling cached blocks, background writes and explicit flushes. Its earlier implementation used a modified JuiceFS and SQLite. Fly's public write-up describes the storage format and ownership of the running mount. The offline editors here are CamelFS experiments. [Fly SBD design](https://fly.io/blog/sprites-block-device/)

We also wrote a small file through the public filesystem endpoint on disposable Sprites, then read it back. In one trial the API reported cold immediately before the write, returned HTTP 200 in 214 ms, then reported warm. Subsequent exec saw the bytes. Status also changed between warm and cold during idle polling. These observations establish API responsiveness for those requests. Backend generation, exact wake sequence and durability at HTTP acknowledgment were unverified. [Observed cold-to-warm request](fly-context.json), [three fresh Sprites](fly-probe.json), [idle polling trial](fly-idle.json)

## Reproduction and scope

Use the native writer setup in the parent README. Install libext2fs development headers and compile the adapter with `cc -Wall -Wextra -Werror -O2 -shared -fPIC offline/edit.c -lext2fs -o offline/edit.so`. Rebuild the small initrd with `prepare.sh` so it includes the unmount RPC. Run `offline/trial.py <new-scratch-directory>` under a private mount namespace with the same environment as the parent trial. On a second host run `offline/audit.py <report.json> <verified.json>` with the experiment bucket and prefix. `offline/edge_cases.py` exercises locally created disposable images and needs no AWS account.

The userspace experiment supports one existing fixture path and regular file type. General writes need path resolution, permissions, hard-link and rename semantics, a broader ext4 feature matrix and isolation for parsing tenant-controlled images. The kernel editor also needs an isolation boundary for tenant images. Clean unmount is the tested handoff. Recovery of a dirty disk is a separate operation. There is one published writer at a time. No pilot routes were changed.

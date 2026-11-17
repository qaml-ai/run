# Workspace layout experiment

These programs run disposable Linux guests on a pool Sprite using unprivileged QEMU software emulation. Each guest boots a packaged kernel and a small initramfs. QEMU serves read-only HTTP ranges from a local origin process. Its 9p share carries test inputs, timestamps, and checkpoint output. The commands under test access the mounted workspace. No path uses FUSE.

| Layout | API edit with the workspace stopped | New guest | Publish a VM edit |
| --- | --- | --- | --- |
| Block snapshots | Boot a mutation guest, edit ext4, cleanly unmount | QEMU opens a fresh qcow2 overlay on a remote backing chain and reads by range | Sync and publish the immutable qcow2 layer, then conditionally advance the ref |
| Git archive | Write the changed Git blob and tree in a bare repository | Stream a full archive, unpack it into guest tmpfs, mount with a private Linux OverlayFS upper | Capture upper files and whiteouts, write Git objects, then conditionally advance the ref |
| Git checkout on a storage host | Same Git mutation | Update a separate native worktree and export it through read-only kernel 9p. A cold owner checks out the whole tree | Same Git publication as the archive design |
| Git plus lazy ext4 | Same Git mutation | Mount an older immutable ext4 image over HTTP ranges, verify reads with dm-verity, mount a private Linux OverlayFS upper, replay changed Git paths | Same Git publication as the archive design |

The hybrid tests a single prebuilt base per fixture. Each boot computes the difference between that base and the requested revision. A production implementation needs a durable mapping from base commits to images, authorization for range reads, and a policy for rebuilding bases. A digest stored in a trusted snapshot must authenticate the verity root. The scratch descriptor in this test is pinned by the harness.

Each mode generates the same deterministic payload, edits one existing file through its storage interface, forks at that version, starts a guest, reads the edited file, compiles C with 128 headers, hashes every regular file and modifies the workspace. Recovery starts a new QEMU process after reopening the ref database. It checks every expected file digest, the executable bit, the symlink target and deletion. A separate guest checks the earlier fork. A stale update must fail. The hybrid also injects a single flipped byte into an HTTP range and requires both a failed read and a kernel verity corruption message.

The host uses SQLite conditional ref updates and a local origin directory. These are trusted single-node benchmark substitutes. The bare Git object store uses Git's fsync setting. The block arm syncs the immutable object and origin directory before advancing a ref. The experiment does not qualify distributed leases, provider latency, crash consistency under power loss, or parsing untrusted checkpoint archives. All paths and archives come from the harness. The deliberate fault test covers the hybrid base. The writable guest is stopped at checkpoint here. Live Bash checkpointing needs separate qualification. Overlay whiteout handling here covers regular file renames/deletes. Opaque directories, conflicting path types and broader POSIX semantics need implementation and testing.

The owner arm keeps the bare Git database on the host throughout the run. Recovering this arm discards the entire worktree and its index before the next boot. A new owner would additionally have to fetch missing Git objects. Its workspace uses a second 9p device and its file traffic is unmetered. The exported checkout must stay pinned while a guest reads it. Concurrent revisions need isolated worktrees. Stock Firecracker needs a different transport for this design.

The seed and API mutation times include the work that creates the starting versions. The host first-read timer starts before export or disk setup and includes QEMU boot. The guest first-read timer begins after kernel boot and the control share mount. Range bytes count response bodies served by the origin. File delivery bytes count sizes staged in the exchange directory. Neither measures physical network traffic. Full scan times measure the in-guest hash walk. Absolute latencies depend on software emulation, 9p transport, same-machine origin and host scheduling.

Run from the repository root:

```sh
scripts/sprite-test --artifacts=layout-results --output=/tmp/layout-run HEAD bash prototypes/workspace-layouts/run.sh layout-results
scripts/sprite-test --artifacts=layout-results --output=/tmp/layout-large HEAD bash prototypes/workspace-layouts/run.sh layout-results --mib 500 --rounds 1 --modes hybrid block git
scripts/sprite-test --artifacts=layout-results --output=/tmp/layout-owner HEAD bash prototypes/workspace-layouts/run.sh layout-results --mib 500 --rounds 1 --modes owner
scripts/sprite-test --artifacts=churn-results --output=/tmp/layout-churn HEAD python3 prototypes/workspace-layouts/churn.py churn-results
```

The block arm draws on [Sprites Block Device](https://fly.io/blog/sprites-block-device/). The Git arms draw on [Code Storage's version and branch model](https://code.storage/changelog/introducing-code-storage). Immutable origin data with disposable local caches and durable publication draw on [turbopuffer's architecture](https://turbopuffer.com/docs/architecture). The prototype implements its own layouts and relies on Linux [OverlayFS](https://docs.kernel.org/filesystems/overlayfs.html) and [dm-verity](https://docs.kernel.org/admin-guide/device-mapper/verity.html).

For the handoff drill, run a single hybrid trial with `--export`, copy `handoff.tar.gz` to a second Sprite and verify its SHA-256 at both ends. On that Sprite use the same size and `--rounds 1 --modes hybrid --import-from /path/to/handoff.tar.gz`. The importer uses the stored refs and objects. It creates the deterministic source fixture independently only to compute expected hashes. The archive contains the SQLite ref database, the bare Git object repository, one base image and its descriptor. The prototype descriptor's `tree` field contains the Git base commit ID.

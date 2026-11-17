# File snapshots on a kernel EROFS mount

This independent CamelFS prototype stores paths, modes, symlink targets and content-addressed 64 KiB chunks. SQLite commits new chunks, immutable metadata and a conditional branch update in one transaction. A stale parent or a failed write aborts the transaction. Metadata uses 256 hash buckets. A one-path edit creates a new root and one new bucket. Supplying a byte range lets the API replace only the affected chunks of a regular file. A full-file PUT checks all its bytes.

On startup, the launcher reads the pinned snapshot and generates a metadata-only EROFS index. It writes tar headers with sparse holes for file bodies and asks mkfs.erofs to index them. The holes communicate offsets. This operation does not fetch any file bodies. The immutable index supplies names and permissions to Linux. Its external data device translates file offsets into reads of the same chunks used by the API. The disposable nbdkit process verifies every fetched chunk against the pinned manifest, and keeps up to 128 chunks. Sequential misses can request up to 16 adjacent chunks in one HTTP request. EROFS is mounted inside Linux with a private writable kernel OverlayFS upper. No FUSE path or writable base image is involved.

At checkpoint the harness exports regular files, symlinks and whiteouts from the upper, commits those changes and advances the ref. The guest stops here. A new guest can boot the new revision or an older branch. Mounting a revision regenerates the whole metadata index. In particular the VM path still scales with total path count, and the kernel overlay can copy an entire lower file on first write. The efficient byte-range patch is the API path.

See [measurements and decision](results.md). EROFS documents its [tar-index and external-device support](https://erofs.docs.kernel.org/en/latest/mkfs.html).

## Run

From the repository root, run on a pool Sprite. Each invocation creates its own scratch database, chunk origin, Linux guests and cold userspace caches. The shell wrapper installs the listed Ubuntu packages and copies the packaged kernel. QEMU and the storage processes run unprivileged. The Linux boot fixture, compiler and workload generator come from the older workspace-layout experiments.

```sh
scripts/sprite-test --artifacts=results --output=/tmp/file-snap-scan HEAD bash prototypes/file-snapshots/run.sh results 500 5 16
scripts/sprite-test --artifacts=results --output=/tmp/file-snap-single HEAD bash prototypes/file-snapshots/run.sh results 64 5 1
scripts/sprite-test --artifacts=results --output=/tmp/file-snap-batched HEAD bash prototypes/file-snapshots/run.sh results 64 5 16
scripts/sprite-test --artifacts=results --output=/tmp/file-snap-patch HEAD python3 prototypes/file-snapshots/patch_trial.py results
scripts/sprite-test --artifacts=results --output=/tmp/file-snap-crash HEAD python3 prototypes/file-snapshots/crash_trial.py results
```

Arguments after the output directory are payload MiB, synthetic delay per origin request in milliseconds and requested sequential batch size (1–16). The origin is loopback HTTP backed by SQLite. Cold means a new VM, device, manifest projection and userspace chunk cache; the OS and origin may have warm pages. Source bytes are verified chunk bodies and exclude HTTP framing, manifest and index. The 9p control share carries requests, markers and experiment output. It does not serve workspace files.

This is a trusted-fixture research harness. The storage prototype has no public HTTP writer, Git compatibility, merge engine, auth, replicated durability, lease epochs, GC or live checkpoint coordination. It exercises a subset of file semantics: regular files, executable mode, symlinks, rename and delete on controlled USTAR-compatible names. Private export archives are trusted test inputs. A production checkpoint importer would need to validate untrusted paths, sizes, modes and tree conflicts. Separate guests on a Sprite and server process death exercise different failure boundaries from physical host or availability-zone loss.

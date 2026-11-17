# Fresh file snapshot experiment

The prototype answered the file-sharing question. A guest opened a file just edited by the API while fetching 65,545 bytes of content from a 500 MiB workspace. A guest checkpoint then became a new revision readable by a freshly booted guest. Both paths used the same canonical chunks. An API edit did not have to produce a new disk image. The remaining startup cost is generating and loading a complete file index.

## Cold read and full scan

These are the first VM sessions after an API edit. Each configuration ran once on a pool Sprite. All three used the same protocol and injected 5 ms of delay per HTTP request. Each started with an empty device cache. Host page caches could be warm. The two 64 MiB runs used identical file contents on separately scheduled Sprites. Timings include scheduler noise.

| Workspace | Max chunks per request | Metadata preparation | Guest mount to first verified read | Host start to first verified read | Full checksum walk | Origin requests across session |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 64 MiB | 1 | 0.23 s | 0.13 s | 13.25 s | 9.09 s | 1,156 |
| 64 MiB | 16 | 0.11 s | 0.14 s | 12.51 s | 3.42 s | 88 |
| 500 MiB | 16 | 0.61 s | 0.17 s | 9.24 s | 30.89 s | 524 |

The 500 MiB fixture had 8,131 files. For the first read, metadata preparation produced a 664,064-byte EROFS index and an 804,074-byte flattened file manifest. The guest then fetched 65,545 bytes of canonical file content. The launcher generated that metadata locally, reading the whole snapshot directory from SQLite. Deploying the metadata store elsewhere would change this cost. The guest later compiled a C file and checked every regular file against an independently computed SHA-256. Across the session it fetched 524,362,933 bytes of content.

Host time starts when the launcher begins preparing the snapshot and includes the entire emulated boot. Guest time starts after boot and module loading, just before mounting the workspace. The checksum walk starts after compilation. QEMU used software emulation. The HTTP origin and the SQLite file shared the Sprite with QEMU. These timings cannot establish Firecracker cold-start latency, cross-host latency, or parity with Fly Sprites.

## Edits and failure behavior

- An API range edit changed one byte in a 32 MiB file among 8,001 paths. Both layouts added one 65,536-byte content chunk. Paging the file list reduced new logical metadata from 753,308 to 55,367 bytes and elapsed time from 18.39 to 3.06 ms in one trial each. The file's chunk list still gets rewritten. Byte counts describe the stored objects and exclude SQLite journaling and filesystem write amplification.
- The VM wrote and renamed files, changed an executable bit and added a symlink. A fresh guest after reopening the database recovered the updated files and verified their checksums. An older fork still read its original contents. A stale writer failed to advance the branch.
- Killing the writer after staging data inside the transaction left the old revision visible. Killing it immediately after commit returned left the new revision visible. A corrupted origin chunk caused a guest read error and an explicit device integrity error.
- The writable overlay can copy a whole file when the VM first modifies it. The range-edit result measures the API. The VM experiment checkpoints a stopped guest and exercises a subset of file operations.

## Decision

The design merits a native Firecracker comparison for workspaces where commands initially touch a small subset of files. It removes the need to synchronize separate API content and VM image contents. The price is a read-only block-serving process on the VM host, a checkpoint importer, and a complete metadata projection at mount. The 64 MiB comparison favors batched reads for scans. An end-to-end pilot decision still needs a real remote origin, native boot, a second host, and a representative mix of edits and scans against the current prebuilt ext4 baseline.

The raw [eight guest configurations](results/guest-trials.json) include edit, recovery, fork and fault phases and the source commit for each run. Earlier direct-SQLite and HTTP runs use earlier revisions of the experiment. Separate records cover the [flat range edit](results/flat-patch.json), [paged range edit](results/paged-patch.json) and [writer process deaths](results/process-death.json).

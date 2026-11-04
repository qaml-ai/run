# Round two native Containers

The test uses `camelrun-proto-r2-computers` and its only Container app/DO class,
`camelrun-proto-r2-native`. The shared bearer secret protects every route. The
Worker has no model binding, receives no Cloudflare credential, and creates no
R2 objects. Outbound Internet is enabled only for a public repository clone and
public npm dependencies. Each object has a 45-minute hard stop alarm and a
60-second idle timeout. The container image starts `sleep infinity`; all build
processes run through `ctx.container.exec`.

Commands use `bench/round2-containers.mjs` with stages `small`, `build`, `large`,
`repeat-build` and `cleanup`. Set `COMPUTER_BENCH_URL` to the prefixed endpoint.
The script reads the ignored bearer file and writes sanitized evidence to
`docs/round2-containers.json`.

The real repository is Microsoft TypeScript v5.9.3, commit
`c63de15a992d37f0d6cec03ac7631872838602cb`. Both instance types clone independently,
run `npm ci --no-audit --no-fund`, then `npm run build:compiler`. That builds the
actual TypeScript compiler and services; it does not run TypeScript's test suite.
The clone is shallow. No local fixture or shared npm cache substitutes for the
network install. Node 24's npm emits its default unapproved-install-script
warning for dprint and esbuild; no package-install security setting was changed.

The small snapshot captures about 240 KB of newly written workspace content.
The test writes an additional file outside `/workspace`, starts a separate sleep
process, takes a native snapshot, overwrites the workspace marker, destroys the
container, restores, and checks both files and the old process ID. This separates
filesystem recovery from process recovery. The large case snapshots the actual
public clone with its Linux dependencies after building, destroys the VM, then
checks file counts, byte counts and package/build artifacts after restoring.

Snapshot retention and the 20 GB maximum are documented platform properties,
not time-travel or maximum-size experiments. The measured handles include size;
expiry is estimated as the last successful restore plus 30 days. The test does
not create a 20 GB snapshot. Snapshot handles are retained only in sanitized
evidence after the object's data is removed.

Sources checked November 4, 2026:

- https://developers.cloudflare.com/containers/guides/snapshots/
- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/containers/platform/limits/
- https://developers.cloudflare.com/containers/platform/pricing/
- https://raw.githubusercontent.com/microsoft/TypeScript/v5.9.3/package.json

The native API size reports the snapshot itself, while its base image is a
separate referenced artifact. Treat comparisons with DirectoryBackup carefully:
DirectoryBackup serializes a directory to R2; native snapshots retain the
container's writable root filesystem and require the original image version.
The two runs also use different source trees. Their timings demonstrate the
mechanisms, not matched-content throughput.

The account registry exposed two aliases per snapshot: `rootfs-snapshot-<hash>`
and `rootfs-set-<hash>`. Their manifest annotations identify the snapshot UUID;
both aliases point to one manifest and one delta layer. The two native snapshots
share a converted base-image artifact. `docs/round2-snapshots.json` lists these
backing artifacts, their byte counts and estimated expiry. This is observed
registry implementation detail, not a documented snapshot-management API or a
guaranteed manual deletion mechanism.

Linux cgroup memory files were unavailable in this Container environment. Raw
CPU-stat output is retained for diagnosis but is not used as per-process CPU or
as a billing measurement. The Cloudflare usage dataset is authoritative for the
provisioned memory/disk and active CPU billed in this run.

The first basic build request used Node 22's `fetch`. Undici has a separate
five-minute response-header timeout, even when the AbortSignal deadline is
longer. A queued result read was started before the client patch and met the
same timeout. The runner now uses bounded `node:https` responses with the
explicit operation deadline. Recovery reads `/workspace/build.json` after the
original operation; it never dispatches a duplicate build. The initial transport
failures remain in the evidence.

## Measurements

Times below are command elapsed times inside Linux, except native snapshot
capture/restore, which are elapsed times in the controlling DO. Both placements
were `dfw05`, WNAM. These are single initial trials, plus one repeated build and
one repeated large restore.

| Workload | basic, 1/4 vCPU / 1 GiB | standard-2, 1 vCPU / 6 GiB |
| --- | ---: | ---: |
| Network shallow git clone | 214.693 s | 49.479 s |
| Fresh npm ci | 117.185 s | 25.836 s |
| TypeScript compiler/services build | Incomplete; timeout SIGKILL observed at 926.890 s | 101.553 s, passed |
| Repeated clean compiler build | Not repeated | 98.600 s GNU time; 98.707 s DO |
| Repeated build peak process RSS | Not measured | 1,055,220 KiB |

The basic job reached the configured 900-second timeout. Killing its process
group and draining the result completed after 926.890 seconds; the compiler
artifact was absent. The VM had no swap and reported `oom_kill=0`. Its cumulative
file-page scan/reclaim counters were 25,656,581 / 5,213,144 pages. The build interval
added 29.350 seconds user CPU and 199.932 seconds system CPU in the VM's cgroup.
This is consistent with memory/file-cache pressure, but the counters are not a
controlled attribution study. Do not call this an observed kernel OOM or a DO
CPU-limit rejection.

| Native snapshot | Small, basic | Large, standard-2 |
| --- | ---: | ---: |
| Prepared workspace | 240,044 bytes before PID marker | 670,559,277 bytes |
| Returned snapshot bytes | 94,514 | 300,560,180 |
| Capture | 3.305 s | 17.940 s |
| First restore after destroy | 0.808 s | 24.431 s |
| File-count/byte-count verification after first restore | 0.426 s, marker/process check | 8.260 s |
| Repeated restore of same handle | Not repeated before image deletion | 0.660 s |
| Aggregate all-file read/hash after repeated restore | — | 26.985 s |

The repeated large restore repaired a deliberately corrupted compiled artifact.
All 84,037 repository files, 670,548,134 bytes, matched aggregate SHA256
`379345167a547cf6241433eada2b4e4b6bce53e4bf5000bb474a602ad52cdabd` and the restored
compiler loaded as TypeScript 5.9.3. The remaining workspace bytes are benchmark
JSON records outside the repository. Restore readiness and reading all file
contents are separate measurements; the 0.660-second repeat is not a full-tree
read promise.

After the normal Wrangler image tag was deleted, the small snapshot restored in
1.370 seconds and ran Node v24.22.2 with both workspace and `/tmp` markers intact.
No account-wide registry garbage collection was requested. This proves immediate
restore after tag removal with referenced backing artifacts retained, not restore
after deleting those backing artifacts or after their retention window.

Both instances were stopped and their DO-held handles removed before handoff.
`docs/round2-snapshots.json` records the two permitted retained snapshots and four
registry aliases. Their deltas total 300,654,694 bytes; their shared converted base
adds 160,154,763 bytes of referenced layers, excluding JSON metadata and original
image-layer references. No R2 bucket or object was created by this native test.

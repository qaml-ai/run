# Round two: Computer workspace backends

Measured on Cloudflare on November 4, 2026. `@cloudflare/computer` 0.9.0,
`just-bash` 3.0.1, Wrangler 4.157.0. The isolated Worker, DO class and Container
application are named `camelrun-proto-r2-sync`. The Container uses standard-2
and the pinned computerd 0.9.0 image, with Node 24.22.2 and TypeScript 5.9.3.
All public routes require the generated benchmark bearer; an unauthenticated
request returned 401. There are no model calls, R2 buckets, or snapshots here.

The package README requires the `experimental` compatibility flag for
worker-shell. Cloud deployment rejected that flag with API code 10021. Removing
the flag allowed the Worker to deploy and the worker-shell backend to execute.
The first benchmark wrapper also omitted the mixin's `__getWorkspaceStub`
RPC accessor; that wrapper defect was fixed before successful sync measurements.
These setup failures are preserved separately in the raw records.

## Verified behavior

One Workspace registered `worker-shell` first and `container` second. A unique
marker written through DO files was read in worker-shell. A different marker
written in worker-shell was read inside the Container. A Container write was
then read in worker-shell. The successful fresh-object pass took 460 ms for the
first worker-shell command, 3,167 ms for the first Container command, and 51 ms
for the next worker-shell read. An earlier Container first start took 6,400 ms.
These are small samples, not latency percentiles.

The 5,000-file fixture consists of independent TypeScript modules with comments.
Its source preparation ran in the Container, followed by an explicit pull. A
real `tsc` compilation wrote 5,000 JavaScript outputs. `sync: "defer"` separated
the command from the following explicit pull; worker-shell verified the output
count and one compiled module.

| 5,000-file fixture | Measured |
| --- | ---: |
| Source generation, command's clock | 9.938 s |
| Source pull, client clock | 15.363 s |
| Source transfer progress bytes | 5,692,780 |
| TypeScript compilation, command's clock | 36.242 s |
| Build command with deferred sync, client clock | 37.034 s |
| Output pull, client clock | 14.536 s |
| Output transfer progress bytes | 5,652,780 |
| DO SQLite size after build | 20,070,400 bytes |
| computerd RSS, baseline | 91,112 KiB |
| computerd RSS, after source sync | 214,824 KiB |
| computerd RSS, after output sync | 274,888 KiB |
| computerd RSS high-water mark | 275,916 KiB |

RSS is read from `/proc/1/status` in the actual Container. It is the daemon's
resident process memory, not total Container memory or per-agent Worker heap.
The Node measurement subprocess was approximately 45 MiB. The cgroup memory
files were unavailable. GraphQL isolates are measured separately; filtering
by DO does not turn an isolate metric into a per-object allocation.

A one-second inactivity setting did not stop a 15-second sleeping command:
the SDK's heartbeat and live session kept activity alive. This is expected
behavior, not proof of an idle-sleep failure. To test loss during execution,
another request called native `destroy()` five seconds into a sleeping command.
The command failed after 5.432 seconds with
`WritableStream RPC stub was disposed without calling close()`. Previously
synced files remained readable through worker-shell, but the write made just
before destruction was absent. The following Container command succeeded in
28.537 seconds and pushed 10,008 durable entries to the replacement runtime.
Thus recovery restores synced files, not the interrupted command or its
unsynced writes. Applications must surface the failed/uncertain operation and
decide whether it is safe to retry.

## Larger flat-directory stress

A separate workspace generated 20,000 source modules in 109.469 seconds. Its
explicit source pull took 125.013 seconds and reported 20,001 entries and
22,797,780 transfer-progress bytes. Both operations grew much faster than the
fourfold increase in file count. This fixture deliberately puts all modules
in a single directory; do not treat the ratio as a generic repository result.

The 20,000-file compiler request failed at the HTTP client after 301.181 seconds
with `fetch failed`; no HTTP response arrived. At approximately 346 seconds,
a separate Container command still found the compiler running. Its RSS was
833,460 KiB and peak 836,256 KiB, while computerd RSS was 330,220 KiB. The wrapper
process also remained present. Thus losing the client did not terminate the
build. The benchmark had supplied `timeoutMs: 300000`; this observation does
not establish a safely enforced process-tree timeout.

An explicit pull made during the still-running compiler took 98.641 seconds
and transferred 16,718 entries. Worker-shell then saw only 16,717 output files.
To inspect the abandoned request, a diagnostic deployment added execution-ID
lookup and result recovery; the deployment interrupted the old session. The
recovered compiler execution was `cancelled`, exit 143. Later reconciliation
made all 20,000 output files visible, and the final DO database was 80,068,608
bytes. **There is no successful 20,000-file build-duration measurement.** The
partial pull timing is also not the time to sync the complete final output.

The larger failure needs durable execution IDs, reconnection, explicit process
tree termination, and presentation of incomplete sync before this backend can
serve long builds. Keeping generated dependency trees outside the synced
workspace avoids a substantial part of this cost; that optimization was not
measured here.

At the 20:41 UTC GraphQL read, the two measured DOs had 105.729 seconds of CPU,
360.127 seconds of active time and 46.096 GB-seconds of duration in the delayed
dataset. Their isolate-memory p99 samples were 39.984 and 41.330 MiB. The
CPU-exceeded, memory-exceeded and fatal-error counters were zero. The invocation
dataset contained one error in 32 requests. These are incomplete aggregate
samples, including setup, interruption and recovery; they are not per-build
CPU or per-DO heap allocations. The separate front Worker had 60 requests,
zero errors and about 12.47 MiB p99 isolate memory.

At 20:41:28 UTC, the account's instance list showed both `shared` and `large`
stopped with exit code 0. They ran in `dfw13`, WNAM, each with 1 vCPU, 6 GiB
memory and 12 GB disk. The root run still needs to remove the Worker, its DO
namespace, its Container app and both uploaded image tags. No snapshot or R2
resource was created by this test.

## Reproduce

The worker-shell peer is pinned at `just-bash@3.0.1`; run `npm ci` inside
`backends/cloudflare`. Use
`cloud-run.mjs deploy-private`, then `secret`, then `enable` with
`bench/round2-computer-wrangler.jsonc`. The runner reads the ignored bearer file,
never a token argument. Run `node bench/round2-computer-run.mjs smoke`, then
`build shared 5000`, then `failure shared`. Run `close shared` before teardown.
`round2-computer-telemetry.mjs` reads only this benchmark namespace's GraphQL
metrics. Typecheck uses `npx tsc -p bench/round2-computer-tsconfig.json`.

Primary references: [package and backend status](https://github.com/cloudflare/computer/tree/main/packages/computer),
[Container example](https://github.com/cloudflare/computer/tree/main/examples/container),
[sync and filesystem performance](https://github.com/cloudflare/computer/blob/main/docs/19_performance.md).

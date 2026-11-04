# Isolated computer measurement harness

`computer-prepare.mjs` copies this backend's source, tests, package manifests,
and installed dependencies into an isolated temporary build context. It does
not install dependencies, clone a repository, or copy credentials. The current
prepared fixture has 20 small-repository files (241,635 bytes) and 23,851
dependency files (566,809,911 bytes). Native macOS optional dependencies are
included in the file workload but are not executed; the command workload uses
pure JavaScript TypeScript transpilation.

The generated `computer-wrangler.jsonc` contains absolute source and build
context paths. Create its `camelrun-proto-computer-backups` R2 bucket explicitly
before deployment. Set `API_TOKEN` as a Worker secret before exposing a temporary
endpoint. The checked-in configuration leaves workers.dev and preview URLs off.
No route, DNS record, existing binding, or production Worker is referenced.

The HTTP router has two fixed names for each of the two providers: `lite` and
`basic`. No caller can choose a different object name. Runtime instance size is
passed to `ctx.container.start()`. The 15-minute Durable Object alarm stops its
container; the runner caps normal work at 14 minutes and always attempts cleanup.
Every endpoint requires the operator token, including status and unknown routes.
Commands run without Internet access and have a maximum 180-second deadline and
64 KiB stdout/stderr limits. Nothing logs or passes the token into a container.

Wrangler 4.157.0 rejects `max_instances` for `durable_object` scheduling policy.
This is a platform restriction, not an omitted configuration: this harness caps
instances with its fixed routing names instead. The deployment build deduplicates
both providers' identical image contexts. Wrangler derives the image repository
from Worker name, exported class name, and image key, so it begins with
`camelrun-proto-`.

## Running

Run `node bench/computer-prepare.mjs` from this backend and retain its returned
temporary configuration path. The operator owns image publication, deployment,
temporary endpoint setup, and final account-level cleanup.

`computer-run.mjs` reads `COMPUTER_BENCH_URL` and either `API_TOKEN` or
`COMPUTER_BENCH_TOKEN_FILE`; it never prints the token. `COMPUTER_BENCH_OUTPUT`
selects the raw JSON output path. The default matrix is native/SDK and
lite/basic. `COMPUTER_BENCH_PROVIDERS` and `COMPUTER_BENCH_SIZES` can narrow it.
Each slot has cold and three warm exec samples, small and large file preparation
and source workloads, inactivity/wake, then stop and backup deletion. SDK slots
also back up to R2, destroy, restore, and verify exact file counts and byte totals.

Native cloud snapshots are disabled by default. The current public API has no
snapshot-delete method. Stored handles are not the snapshots, and deleting a
handle does not delete its snapshot. Native snapshots last 30 days after capture
or restore. `COMPUTER_BENCH_NATIVE_SNAPSHOTS=1` is appropriate only after retention
is explicitly authorized, or for a fully removable isolated local test. This
experiment's complete-cleanup requirement therefore excludes native cloud
snapshot creation.

## Published cost basis

The November 4, 2026 documentation lists lite as 1/16 vCPU, 256 MiB, 2 GB disk,
and basic as 1/4 vCPU, 1 GiB, 4 GB disk. After included allowances, active CPU
costs $0.000020/vCPU-second, provisioned memory $0.0000025/GiB-second, and
provisioned disk $0.00000007/GB-second. At full CPU, lite is approximately
$0.007254/hour and basic $0.028008/hour. Both sizes in both providers for the
entire 15-minute safety window would total about $0.017631 in container compute,
before Workers, Durable Objects, R2, network, and any account plan charge.
This is an upper-bound model for that duration, not measured billing.

Snapshots save filesystem state, not live processes or memory. R2 directory
backups can restore into another image and have application-controlled deletion.

Sources:

- https://developers.cloudflare.com/containers/platform/pricing/
- https://developers.cloudflare.com/containers/platform/limits/
- https://developers.cloudflare.com/containers/guides/snapshots/
- https://developers.cloudflare.com/sandbox/reference/directory-backups/
- https://developers.cloudflare.com/sandbox/files/save-a-sandbox-automatically/
- https://developers.cloudflare.com/sandbox/files/save-and-restore-a-workspace/
- Installed `node_modules/wrangler/wrangler-dist/cli.js`,
  `buildDurableObjectImageTag` and Durable Object-managed config validation.

Validation so far: TypeScript, Node syntax checks, and Worker-only dry-run bundle
passed. The complete config passed validation after removing the unsupported
`max_instances`; its image build requires elevated access to the existing Docker
daemon. The daemon is running Docker 29.3.1. No cloud measurements are claimed by
these preparation checks.

## Measured in Cloudflare on 2026-11-04

The real deployment used the existing prefixed resources left by the interrupted
attempt. Both providers ran the same Node 24.22.2 image at `dfw14` (WNAM).
The account API confirmed lite as 0.0625 vCPU, 256 MiB memory and 2,000 MB disk.
Timings below are client wall time; they include the HTTP round trip. Each size
operation has one sample. These are not a statistical latency distribution.

| Operation | Native lite | SDK 1.0.3 lite |
| --- | ---: | ---: |
| First placement from interrupted run | 10,877 ms | Not captured |
| Start after destroy, image already present | 803 ms | 1,155 ms |
| Warm exec, three samples | 146 / 137 / 83 ms | 415 / 260 / 206 ms |
| Small directory backup to R2, 241,635 bytes / 20 files | Not taken | 1,486 ms |
| Small restore after destroy | Not taken | 2,026 ms |
| Large directory backup to R2, 567,051,546 bytes / 23,871 files | Not taken | 177,302 ms |
| Large restore after destroy | Not taken | 76,702 ms |

The small and large restored directories passed exact byte count, file count and
marker checks. The compressed R2 objects were 83,090 and 192,860,817 bytes.
The large fixture was copied from this checkout and its installed dependencies
into the image, then extracted into `/workspace`. It was not a network clone.
Mac-specific optional packages were present but not executed. The execution
workload transpiled the 60,310-byte TypeScript source with pure JavaScript.
The large extract/transpile samples varied considerably (native 52.2 s / 40.5 s,
SDK 8.0 s / 1.2 s); do not infer provider CPU superiority from one sample.

The first runner checked inactivity only ten seconds after the last request;
both providers were still running. That check was too short to verify the
platform's definition of Durable Object inactivity. The harness now clears its
operation timers, and the separate idle runner observes the account instance API
without issuing requests to the Durable Object. With a 5-second configured
inactivity timeout, native stopped 25.1 seconds after the response and SDK stopped
25.1 seconds after the response (backend timestamps; polls first observed these
at 30.3 and 27.3 seconds). Wake exec took 798 and 1,037 ms. Both lost the unsaved
file as expected. The configured delay starts after the Durable Object becomes
inactive, not immediately when exec returns. This test does not isolate the
contribution of the cleared timers from the platform's inactivity grace period.

No native cloud snapshot was created. Cloudflare documents a 30-day snapshot TTL,
no Worker API to list snapshots, and that deleting a stored snapshot handle does
not delete the snapshot. No documented account API for snapshot deletion or
verifiable parent-deletion cleanup was found. Taking one would prevent proving
the requested keep-nothing cleanup. The R2 backups above are explicitly deletable;
the runner deleted both after verification. Native snapshot latency is still
unmeasured in the cloud.

Sources for this distinction:

- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/containers/guides/snapshots/
- https://developers.cloudflare.com/sandbox/files/save-and-restore-a-workspace/

The uploaded image is the deduplicated repository
`camelrun-proto-computers-camelrun-proto-computer-native-workspace`, tag
`wrangler-mw2iverl`. Account-level cleanup must delete that image as well as the
Worker, container applications and empty R2 bucket.

The basic comparison used the same image, region and command with 0.25 vCPU,
1,024 MiB memory and 4,000 MB disk. It did not repeat the large R2 backup.

| Operation | Native basic | SDK 1.0.3 basic |
| --- | ---: | ---: |
| Start after destroy | 805 ms | 804 ms |
| Warm exec, three samples | 232 / 167 / 110 ms | 166 / 89 / 104 ms |
| Wake after inactivity stop | 504 ms | 683 ms |

Both basic instances stopped after about 25 seconds from the final response with
a configured 5-second inactivity timeout. Both discarded the unsaved file.
No extra image or application was created for the runtime size change.

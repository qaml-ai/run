# Direct clone/build benchmark — Lambda MicroVMs

Measured November 4, 2026, in `us-west-2` using the production managed-computer
image `arn:aws:lambda:us-west-2:904534089871:microvm-image:camelrun-computers`,
version `1.0`. No model runs in this benchmark. Results and lifecycle evidence
are in [results.json](results.json) and [node22-results.json](node22-results.json), [rust-results.json](rust-results.json),
[typescript-results.json](typescript-results.json), and
[typescript-go127-results.json](typescript-go127-results.json);
the paid opt-in harness is [run.ts](run.ts).

Seven one-hour-lease VMs were used: three startup trials, one Node 22 comparison,
one for two extra Rust installs, and two TypeScript prerequisite recoveries.
All cloud writes were limited to these VMs. Final cleanup evidence is below.

## Results

All values are wall seconds. Build/install/test values come from GNU time in
the guest. First exec and resume include client transport, driver and proxy
round trips. Medians use three observations where shown; other rows are single
observations. A failed test timing is not a successful workload result.

| Configuration | First exec | Express clone | npm install | npm test | Rust install | ripgrep clone | release build |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Stock Node 18 | 9.463 | 0.440 | 6.370 | 3.060 failed | 6.190 | 0.610 | 17.120 |
| Node 22.23.3 parity run | 8.375 | 0.470 | 7.610 | 3.070 | Not repeated | Not repeated | Not repeated |

| Step | Individual observations | Median / observation | Status |
| --- | --- | ---: | --- |
| RunMicrovm to first successful exec | 19.407, 3.262, 9.463 | 9.463 | Three fresh VMs |
| Express shallow clone | 3.370, 0.440, 0.410 | 0.440 | Three separate workspaces |
| Express npm install | 6.580, 6.220, 6.370 | 6.370 | Three isolated npm caches |
| Express npm test, stock Node | 4.770, 3.060, 3.040 | 3.060 | Exit 2; see failures |
| Express clone, Node 22 | 2.290, 0.470, 0.450 | 0.470 | All successful |
| Express install, Node 22 | 7.470, 7.690, 7.610 | 7.610 | Cold npm cache per trial |
| Express test, Node 22 | 3.150, 3.070, 3.070 | 3.070 | 1,290 passing each |
| Rust minimal install | 6.480, 6.190, 5.750 | 6.190 | Three fresh toolchain directories, two VMs |
| ripgrep shallow clone | 0.540, 0.610, 0.630 | 0.610 | Three shallow checkouts |
| cargo build --release | 17.120, 17.020, 17.170 | 17.120 | Three clean targets and crate caches |
| cargo build --release -j 4 | 16.680 | 16.680 | Separate clean target; warm crate cache |
| TypeScript shallow clone, Go 1.27 run | 6.490 | 6.490 | Fresh checkout |
| TypeScript npm ci, Go 1.27 run | 5.390 | 5.390 | Successful |
| TypeScript npx hereby local, Go 1.27 run | 279.030 | 279.030 | Failed: disk full |
| Forced suspend to observed SUSPENDED | 1.043, 0.612, 0.593 | 0.612 | API plus state polling |
| Suspended to first successful exec | 1.232, 4.381, 4.468 | 4.381 | Auto-resume through driver |

The first fresh VM took 19.407 seconds; the immediately following VM took
3.262 seconds, and the third took 9.463 seconds. The second launch was faster,
but three variable observations do not establish a stable warm-pool effect.
AWS internal host placement and cache state are not exposed.

## Guest and workload

The untouched image reported `aarch64`, `nproc=4`, 8,016 MiB RAM, no swap,
and a 7.8 GiB root filesystem with 6.3 GiB initially free. The configured
baseline is 1 vCPU / 2 GiB. AWS documents a 4 vCPU / 8 GiB peak for this baseline;
guest-visible capacity is not proof of constant use or constant four-core billing.
See [MicroVM sizing](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html).

Stock software was Node **18.12.1**, npm **8.19.2**. Node was already present,
so Node installation took zero steps, not a measured zero-second installation.
A separate fourth VM installed public Node 22.23.3 / npm 10.9.9 in 2.780 guest
seconds. All three Express trials then passed 1,290 tests; clone/install/test
medians were 0.470 / 7.610 / 3.070 seconds. The first Go recovery VM installed the same Node version in 8.300 seconds;
the final Go 1.27 recovery installed it in 2.600 seconds. Stock measurements remain intact.

The image lacked build prerequisites. Installing GNU time, GCC/G++, make,
Perl and pkg-config took **43.209 client seconds**, outside the workload timings.
The installed compiler was GCC 11.5.0 and GNU time 1.9.

Rust and Cargo were 1.99.1. The default build used 58.79, 58.77 and 58.91
CPU-seconds (user plus system), about 3.4 cores averaged over wall time. The
explicit `-j 4` build used 58.74 CPU-seconds over 16.68 seconds. Default Cargo
already exploits the four visible CPUs; this does not establish a benefit from
`-j 4`. The crate-cache difference also prevents a controlled comparison.

The stock VM ended with 2.9 GiB disk free. Its ripgrep revision was
`91f5d22ef48bde459d90a8c7dbeab416e97d0f2b` (15.2.0), matching Cloudflare.
The TypeScript revision was `e1a9b0b84997afa3757edd9d079bb499669ed20d`.
The Express revision already matches Cloudflare:
`43fca52d28a422c8be48fd489cbd4f2d6152bab6`.

The measured commands are:

```sh
git clone --depth 1 https://github.com/expressjs/express
npm install
npm test
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
git clone --depth 1 https://github.com/BurntSushi/ripgrep
cargo build --release
cargo build --release -j 4
git clone --depth 1 https://github.com/microsoft/TypeScript
npm ci
npx hereby local
```

Each command runs in the corresponding checkout. Repetitions use separate
`/root/bench-N` directories, distinct npm caches and distinct Cargo homes.
No repeat reuses an existing build target. The explicit `-j 4` build uses a new
target directory but repetition one's downloaded crate cache; its wall time
therefore cannot isolate the effect of changing parallelism. Cargo's default
parallelism also follows the guest-visible CPU count, which is already four.
GNU time records user/system CPU seconds and maximum RSS alongside elapsed time.

## Method

The harness imports the actual `microvmApi` and `microvmMachines` from
`src/computers/microvm.ts`. It uses the production `Outbound` transport and
an in-memory PGlite ownership table solely to satisfy the driver's database
interface. It reads no production database and invokes no model, runtime agent
loop, ECS service or secret store. Credentials are resolved locally through the
normal AWS provider chain and checked for the authorized account and principal.

Creation calls RunMicrovm with the pinned image, then the driver's health probe
and a `true` exec. Exec calls use GetMicrovm, port-8080 scoped authentication,
POST `/exec` and repeated GET `/exec/<key>?wait=25`, exactly as the runtime does.
Long-running processes remain guest jobs while the client long-polls. GNU time
measures commands inside the guest; client wall times remain separately in the
raw evidence. Output is stored in guest logs with short tails returned.

The deployed agent has no standalone files HTTP route. File persistence checks
use shell reads/writes through its authenticated exec route. Before suspend,
the harness creates a marker, records the ripgrep binary hash and checkout size,
and detaches `setsid sleep 3600` with redirected standard streams. A plain
`sleep 3600 &` would be killed by this agent's process-group cleanup. Suspend
is forced through the API and timed until GetMicrovm reports SUSPENDED; the next
driver exec triggers auto-resume. All three cycles returned the marker and
the same sleeper PID 3974/start time (22:14:12 UTC), binary SHA-256
`6e0aba4113650478904e67d4816a135632ca2e56d666cf56f3c5f3a1bc51d2f9`,
and checkout size 202,179,950 bytes. The binary executed successfully after
each resume. The offline summarizer asserts these matches.

Image creation/build time is excluded. The existing image was not rebuilt.
Each benchmark invocation has a one-hour lease per VM, below the authorized two-hour
maximum. The two launch-only VMs are terminated immediately after their probe.

## Failures and limits

All three stock Node 18 Express test repetitions fail with exit 2: the sendFile socket-error test
reports `socket failed` and then `done() called multiple times`. The captured summaries show 1,284 passing, two pending and two failures. This differs from
Cloudflare's Node 22 runs, which reported 1,290 passing tests. The benchmark does
not alter tests or silently treat this timing as a pass.

Stock Node 18 TypeScript `npm ci` succeeded with engine warnings, but the
build failed in 0.570 seconds on an unsupported `.mts` extension. Node 22
advanced through generators, then failed in 21.010 seconds because `go` was
missing. This commit is the Go-native TypeScript repository: `local` builds
the native compiler, and its Go workspace requires Go 1.27. Node 22.23.3 meets
the package engine requirement, although CONTRIBUTING recommends Node 24.
See the pinned [build rules](https://github.com/microsoft/TypeScript/blob/e1a9b0b84997afa3757edd9d079bb499669ed20d/Herebyfile.mjs)
and [prerequisites](https://github.com/microsoft/TypeScript/blob/e1a9b0b84997afa3757edd9d079bb499669ed20d/CONTRIBUTING.md).
The distribution Go package installed in 4.470 seconds, but was 1.26.10.
The build then failed in 21.020 seconds: this repository sets
`GOTOOLCHAIN=local`, so it would not download Go 1.27 automatically. The final
recovery installs the official checksum-verified Go 1.27.3 archive instead.
The seventh VM installed checksum-verified Go 1.27.3 in **7.340 seconds**.
The correct-toolchain build then ran **279.030 seconds**, completing generation
in 234.4 seconds and failing in `tsc:build` with repeated **no space left on
device** errors. The final `df` showed 273 MiB free on the 7.8 GiB root disk
after Go removed temporary build data. No OOM was observed. GNU time recorded
743.15 user + 37.63 system CPU-seconds (2.80 cores on average) and maximum
child RSS 2,681,612 KiB (2.56 GiB). This is a disk-capacity failure, not a
successful TypeScript build time. The process RSS exceeds the configured
2 GiB baseline; this VM is not a hard 2 GiB memory container.

Two labelled operator probes during this final build observed 587 then
1,546 MiB used memory and progressing compiler processes. They are saved in
`operator-diagnostics.json` and `operator-diagnostics-2.json`; their brief
read-only commands are included in the trial wall time. Cgroup peak-memory
files were unavailable, so the report does not claim a whole-VM peak. No tests were skipped
and no manual source changes were made. Diagnostic `du` calls can exit 1 for absent directories;
their status is separate from the build status.

| Limit | Documented / implemented boundary | Observation |
| --- | --- | --- |
| Disk | 8 GB for the 2 GB / 1 vCPU baseline | 7.8 GiB visible; final TypeScript build hit ENOSPC; 273 MiB free after failure |
| Memory / CPU | 2 GB / 1 vCPU baseline, up to 8 GB / 4 vCPU | 8,016 MiB/four CPUs visible; Cargo ~3.4 cores; TypeScript max child RSS 2.56 GiB; no OOM |
| RunMicrovm | 5 TPS, burst 5, per account/Region | Seven serial starts across runs; no account saturation test |
| Proxy connections | Eight concurrent connections for 1 vCPU | Sequential long-polls; no saturation test |
| Proxy bandwidth | 4 MB/s for this baseline | No throughput saturation test |
| Exec output | 65,536 bytes per stdout and stderr stream | 70,001 bytes per stream became 65,536; truncated=true; exit 0 |
| Exec timeout / jobs | 1,800 s maximum; four active jobs; 4,096 retained keys | No timeout or job-capacity failure; capacity not saturated |

Quota values come from [AWS Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html#compute-and-storage).
The [networking bandwidth limit](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html#microvms-networking-bandwidth)
applies to requests/responses through the VM endpoint, not automatically to
outbound GitHub/npm/Cargo downloads made directly by the guest. No account-wide
quota load test was used because it could affect unrelated production starts.
The output and job limits come from `sandbox/microvm/agent.py` and the production
driver's additional result slicing. No operation ended with a rate-limit error.
The driver retries internally; this does not prove that no transient 429 occurred.
Bandwidth, connection count and account TPS are documented boundaries, not
measured saturation thresholds in this run. No claim of a fixed 2 GiB OOM limit
is made: this image can burst to 8 GiB, and RSS is the maximum of individual
child processes rather than a measured whole-VM high-water mark.

## Cost and cleanup

The source constant `MICROVM_HOUR` is **$0.12610008 per baseline running hour**.
This differs slightly from the rounded value in the older operations document.
AWS bills the baseline while running plus active resource use above baseline.
A second estimate charges four times the baseline for the entire running period;
it bounds the compute component at the documented peak but is not an invoice.
[Pricing](https://aws.amazon.com/lambda/pricing/) also charges snapshot reads on
launch/resume, writes on suspend, and suspended storage.

For the implementation's assumed 2 GiB snapshots, seven image launches cost
`7 * 2 * $0.00155 = $0.02170`; three suspend/resume cycles cost
`3 * 2 * ($0.0038 + $0.00155) = $0.03210`; suspended storage costs
`2 * suspended_seconds * $0.08 / (30 * 86400)`. Actual snapshots can differ from
this assumption, especially after a larger memory footprint. An 8 GiB snapshot
sensitivity estimate is four times those amounts; actual snapshot bytes were
not reported, so it is not a verified storage bound. Existing image storage is not newly
created by this benchmark. Network transfer is additional and not reconciled.

| Estimate | Amount |
| --- | ---: |
| Observed lifetime charged at baseline, plus 2 GiB snapshot assumptions | $0.08665 |
| Full observed lifetime at four-times compute, plus 8 GiB snapshot sensitivity | $0.34660 |
| All seven one-hour leases at four-times compute, plus 8 GiB snapshot sensitivity | Less than $3.76 before transfer |

These are estimates, not AWS billing receipts. The lease envelope is below the
approximately $5 benchmark budget. These calculations use 937.793 seconds of
combined VM lifetime from AWS start/termination timestamps, conservatively
including suspended intervals. Baseline compute contributes $0.03285 and
2 GiB snapshot operations contribute $0.05380. Suspended-storage charges are
below $0.0001 for this run; network transfer is unmetered here. A 16 GiB
snapshot-size sensitivity, with full four-times compute, is about $0.562.
The runtime's built-in estimator does not account for above-baseline compute
or initial image-read charges; the report adds both sensitivities explicitly.

The initial paginated ListMicrovms inventory was **empty**. The API exposes no
per-VM name/tag field, so each launch uses a `camelrun-bench-*` client token and
hook payload, and its returned ID is recorded before subsequent operations.
Only IDs created by this run may be suspended, resumed or terminated.

Final paginated ListMicrovms and per-ID GetMicrovm audit at **2026-11-04T22:24:54.200Z**
returned seven retained terminal records, **zero active VMs**, and zero active
benchmark VMs. All seven image versions were `1.0`, with 3,600-second leases.
No pre-existing or unrelated VM was stopped or changed. See
[cleanup-audit.json](cleanup-audit.json), whose initial inventory is `[]`.
AWS retains terminated inventory records; an empty active inventory does not
require an empty historical list.

| Created VM | Final state |
| --- | --- |
| `microvm-3d6c94d7-f22e-3345-9bc7-17caf15a3cae` | TERMINATED |
| `microvm-fe74ce58-d015-37e1-9145-35ec5fa82ae3` | TERMINATED |
| `microvm-449c9829-a65e-3cb9-9ba0-d44be429da86` | TERMINATED |
| `microvm-9781c897-b1ae-37f1-b84c-048599f4d9fe` | TERMINATED |
| `microvm-a41c4faf-affc-33e7-9f4f-e189b7702a5b` | TERMINATED |
| `microvm-fdcd33b6-06b1-322b-88a3-ed1b26062181` | TERMINATED |
| `microvm-0503274a-32af-3211-9dd7-b746b17ecbd4` | TERMINATED |


## Comparison with Cloudflare

Cloudflare values below are copied from
[`backends/cloudflare/docs/BENCH-clone-build.md` at `6c1ac43e`](https://github.com/qaml-ai/run/blob/6c1ac43e19d866937429578fd16b273f9531e8e3/backends/cloudflare/docs/BENCH-clone-build.md).
They are single observations from November 4. That experiment used a real model
in the loop. Its first-agent-exec value includes a model turn after start;
its native-readiness column is the closer comparison to this direct driver
experiment. Clone/install/test/build values use guest GNU time in both reports.

| Backend | First agent exec / direct first exec | Express clone | npm install | npm test | Rust install | ripgrep clone | release build |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Lambda MicroVM stock image, median | 9.463 | 0.440 | 6.370 | 3.060 failed | 6.190 | 0.610 | 17.120 |
| Lambda MicroVM Node 22.23.3 parity | 8.375 | 0.470 | 7.610 | 3.070 | Not repeated | Not repeated | Not repeated |
| CF Container basic | 14.744 | 3.09 | 154.11 | 55.35 | 123.89 | 2.52 | 842.58 |
| CF Container standard-2 | 13.225 | 1.83 | 32.42 | 9.98 | 18.95 | 2.40 | 159.07 |
| CF Container standard-4 | 13.364 | 0.79 | 9.37 | 3.46 | 10.34 | 0.62 | 25.25 |
| CF Sandbox SDK 1.0.3 default | 16.283 | 17.69 | >1,200; stalled | not reached | not reached | not reached | not reached |
| CF Computer 0.9.0 ContainerBackend | 10.657 | 1.79 | 19.65 | 4.64 | 12.42 | 1.56 | 74.90 assisted |

| Backend | Allocation | Guest RAM / root disk | Start tool / native readiness |
| --- | --- | --- | ---: |
| Lambda MicroVM | 1 vCPU / 2 GiB baseline; 4 vCPU / 8 GiB peak | 8,016 MiB / 7.8 GiB | Direct first exec median 9.463 |
| CF basic | 1/4 vCPU, 1 GiB, 4 GB | 974 MiB / 3.8 GiB | 8.877 / 8.355 |
| CF standard-2 | 1 vCPU, 6 GiB, 12 GB | 6,094 MiB / 12 GiB | 8.160 / 7.666 |
| CF standard-4 | 4 vCPU, 12 GiB, 20 GB | 12,238 MiB / 19 GiB | 10.876 / 10.581 |
| CF SDK default (lite) | 1/16 vCPU, 256 MiB, 2 GB | 206 MiB / 1.9 GiB | 10.013 / 9.415 |
| CF Computer | 1 vCPU, 6 GiB, 12 GB | 6,094 MiB / 12 GiB | 7.313 / 6.719 |

| Backend | Suspend / snapshot | Resume / wake | Built checkout | Live process |
| --- | ---: | ---: | --- | --- |
| Lambda | 0.612 suspend | 4.381 auto-resume first exec | Preserved | Preserved |
| CF basic | 17.729 snapshot | 0.623 wake; 0.674 restore + 0.649 verification | Lost on sleep; snapshot restored | Not preserved by snapshot |
| CF standard-2 | 15.146 snapshot | 0.548 wake; 0.935 restore + 0.647 verification | Lost on sleep; snapshot restored | Not preserved by snapshot |
| CF standard-4 | 10.097 snapshot | 0.641 wake; 0.649 restore + 0.623 verification | Lost on sleep; snapshot restored | Not preserved by snapshot |
| CF SDK | Unavailable | Unavailable | No build | Unverified |
| CF Computer | 9.179 snapshot | 0.864 restore + 0.905 verification | Snapshot restored; did not sleep within 60 s | Not preserved by snapshot |

A Cloudflare fresh wake that loses writable state is not equivalent to a Lambda
memory/process resume. Its snapshot restoration is a separate filesystem
operation. The Computer result required operator guidance after an `EXDEV`
rename failure and reused downloaded Cargo crates. The SDK default stalled at
npm install and later exec/stop commands did not complete. These outcomes do
not provide successful full-workload comparisons.

All Cloudflare guests were x86_64; Lambda is ARM64. Cloudflare used Node 22.23.3,
npm 10.9.9 and Rust 1.99.1; its Computer used Node 22.23.4. Stock Lambda uses
Node 18.12.1 / npm 8.19.2. Architecture, versions, available RAM, burst behavior,
network placement and upstream caches differ. This is a practical provider/image
comparison, not a controlled equal-resource throughput study.

The cited Cloudflare report contains **no microsoft/TypeScript repository build**.
Its TypeScript comparison cell is unavailable; no result is inferred from the
separate small TypeScript transpilation fixture.

| Larger workload | Lambda MicroVM | Cloudflare report |
| --- | ---: | --- |
| TypeScript shallow clone, stock Node 18 | 3.310 | Not measured |
| TypeScript shallow clone, Node 22 parity | 6.250 | Not measured |
| npm ci, stock Node 18 | 9.560 | Not measured |
| npm ci, Node 22 parity | 5.410 | Not measured |
| npx hereby local, stock Node 18 | 0.570 failed | Not measured |
| npx hereby local, Node 22 parity | 21.010 failed: Go missing | Not measured |
| npx hereby local, distribution Go 1.26 | 21.020 failed: Go 1.27 required | Not measured |
| Go 1.27.3 installation | 7.340 | Not measured |
| TypeScript shallow clone, Go 1.27 run | 6.490 | Not measured |
| npm ci, Go 1.27 run | 5.390 | Not measured |
| npx hereby local, Go 1.27 run | **279.030 failed: disk full** | Not measured |

## Reproduction

Run from the repository with dependencies installed and the explicitly authorized
AWS credentials. This creates paid, isolated MicroVMs and downloads public code.
Do not run it as a test or against an arbitrary account.

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning benchmarks/lambda-clone-build/run.ts run
node --experimental-strip-types --disable-warning=ExperimentalWarning benchmarks/lambda-clone-build/run.ts node22 node22-new.json
node --experimental-strip-types --disable-warning=ExperimentalWarning benchmarks/lambda-clone-build/run.ts rust-repeats rust-new.json
node --experimental-strip-types --disable-warning=ExperimentalWarning benchmarks/lambda-clone-build/run.ts typescript typescript-new.json
node --experimental-strip-types --disable-warning=ExperimentalWarning benchmarks/lambda-clone-build/run.ts cleanup results.json
```

`typescript` now uses Go 1.27.3; the earlier distribution-package failure is
retained as evidence, not repeated by the final harness. `audit.ts` reads the
five checked-in ledgers and verifies their recorded VMs without mutations.
`node benchmarks/lambda-clone-build/summarize.mjs` derives medians, CPU usage,
persistence assertions and cost estimates offline.

Use a distinct results path for every run. Preserve the output file until cleanup
is verified. The cleanup command acts only on that file's recorded VM IDs.
No production deployment, image build, main push or merge is part of this work.

## Validation

`npm run typecheck`, targeted TypeScript checks for the harness/audit, all five
`tests/microvm.test.ts` tests, `npm run docs`, both `llms.txt` tests, and
`git diff --check` passed. The local v8-exec binary was built for the docs
server test. `summarize.mjs` verifies all three process/file persistence results
and requires a fresh audit covering every created VM. No main push, merge,
image rebuild or production deployment was performed.

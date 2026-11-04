# Agent clone/build benchmark — Cloudflare

Measured November 4, 2026, on isolated `camelrun-proto-bench-*` resources in
camelAI. This experiment leaves the other Cloudflare prototype and production
unchanged. Each variant runs one fresh agent and one computer: these are
single observations, not latency percentiles.

## Method

The actual prototype `CamelAgent`/PiHarness runs Workers AI
`@cf/zai-org/glm-5.3-flash`. The agent receives the same
`backends/cloudflare/bench/clone-build/prompt.txt`, calls `computer(start)` itself,
then executes system diagnostics, public shallow clones, installation, tests
and the release build. Every tool request/result and model transcript is saved.
Model dispatches are capped at 100 per agent and 4,096 output tokens per dispatch.
No model credentials are available inside the computer.

The benchmark adapter adds explicit start, up to 20-minute command waits,
Internet access, timing and a two-hour machine lifetime. The normal prototype
computer provider is unchanged. Node 22 and native compiler prerequisites are
preinstalled in Debian Bookworm images. The experimental Computer image required
Debian Trixie for FUSE 3.17 or newer. Repositories, node_modules, Rust and
build outputs are absent from the image. Image build/upload/preparation time is
excluded from VM startup and clone/build timings.

`/usr/bin/time` measures individual command wall seconds inside the computer.
The DO also measures complete tool-call wall time. Start time covers the agent's
start request through a successful command probe. Decision-to-diagnostic time
also includes the intervening model turn and the first diagnostic exec. Client
HTTP timing includes the local network round trip. Commands save full logs in
the container and return short tails to avoid the 64 KiB output limit.

After the agent finishes, authenticated operator calls measure file read/write,
snapshot, sleep and restore on the same machine. These are lifecycle probes,
not additional model decisions. A five-second inactivity timeout is followed by
60 seconds with no requests to the machine object, then status and a command.
Snapshot verification compares the ripgrep binary hash, directory sizes and a
marker. Native snapshots capture the writable root filesystem; they do not
preserve live processes, RAM or separately mounted filesystems. See the
[Container API](https://developers.cloudflare.com/containers/api/durable-object-container/).

## Results

All times are wall seconds. The first exec column ends when the real agent's
diagnostic command returns; it includes the model turn after `computer(start)`.
The start probe column below isolates machine readiness. A dash means no
successful measurement, not zero.

| Backend | First agent exec | Express clone | npm install | npm test | Rust install | ripgrep clone | release build |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Container basic | 14.744 | 3.09 | 154.11 | 55.35 | 123.89 | 2.52 | 842.58 |
| Container standard-2 | 13.225 | 1.83 | 32.42 | 9.98 | 18.95 | 2.40 | 159.07 |
| Container standard-4 | 13.364 | 0.79 | 9.37 | 3.46 | 10.34 | 0.62 | 25.25 |
| Sandbox SDK 1.0.3 default | 16.283 | 17.69 | >1,200; stalled | not reached | not reached | not reached | not reached |
| Computer 0.9.0 ContainerBackend | 10.657 | 1.79 | 19.65 | 4.64 | 12.42 | 1.56 | 74.90 assisted |
| Lambda MicroVM, Miguel's run | pending | pending | pending | pending | pending | pending | pending |

| Backend | Allocation | Guest RAM / root disk | Start tool / native readiness |
| --- | --- | --- | ---: |
| basic | 1/4 vCPU, 1 GiB, 4 GB | 974 MiB / 3.8 GiB | 8.877 / 8.355 |
| standard-2 | 1 vCPU, 6 GiB, 12 GB | 6,094 MiB / 12 GiB | 8.160 / 7.666 |
| standard-4 | 4 vCPU, 12 GiB, 20 GB | 12,238 MiB / 19 GiB | 10.876 / 10.581 |
| SDK default (`lite`) | 1/16 vCPU, 256 MiB, 2 GB | 206 MiB / 1.9 GiB | 10.013 / 9.415 |
| Computer ContainerBackend | 1 vCPU, 6 GiB, 12 GB | 6,094 MiB / 12 GiB | 7.313 / 6.719 |

All Cloudflare guests are x86_64. `nproc` reports 1 even for the fractional CPU
instances; the allocation comes from the Container configuration/API, not that
rounded guest value. Node is 22.23.3 (22.23.4 on the Trixie Computer image), npm
10.9.9, rustc/cargo 1.99.1. Successful Express tests report 1,290 passing tests.
Both repositories were shallow-cloned from GitHub during the run:

- Express: `43fca52d28a422c8be48fd489cbd4f2d6152bab6`.
- ripgrep: `91f5d22ef48bde459d90a8c7dbeab416e97d0f2b` (15.2.0).

The three native Container runs were completed by the real agent without
operator guidance or command substitution. On basic and standard-2, Cargo ran
as a background job and the agent polled its saved status. Standard-4 completed
in one foreground call. The table uses `/usr/bin/time` from the build,
not elapsed polling intervals. These are one-off cold workspaces, with no
preinstalled npm dependencies, Rust toolchain, Cargo cache or build outputs.
The runs overlapped in time. Placement, network conditions, host CPU and upstream
caches were not controlled, so these observations are not normalized throughput
measurements. No native run hit a confirmed disk, memory, output or exec-timeout
limit; one basic client trace poll was retried without affecting the VM job.

### Failures and recovery

The experimental Computer image initially failed three start attempts. A
bounded diagnostic exposed `computerd needs libfuse 3.17 or newer`; replacing
the Bookworm image with Trixie fixed startup. The compatibility flag
`experimental` was also rejected at deployment and removed. The table uses a
fresh agent with the same original prompt after this image correction.

That agent encountered `EXDEV` when Cargo renamed a temporary directory to
`/workspace/ripgrep/target`. This adapter deliberately excludes `node_modules`
and `target` from Workspace synchronization so large build products stay on
the container disk. Its mounted/native directory boundary caused the rename
failure. Three timed failed builds took 1.01, 0.13 and 0.14 seconds, each exit
101; an additional `strace` diagnostic also failed. After unproductive retries,
the operator aborted the prompt and supplied factual recovery guidance. The
same real agent pre-created `target/`, then ran the unchanged `cargo build
--release` successfully in 74.90 seconds. This is an assisted result with a
different base image and filesystem layout, not a clean ranking against the
native standard-2 run. Its failed first attempt had already downloaded Cargo
crates, so the successful retry also benefits from that cache. No host-side
script ran the build.

The adjacent WorkerShellBackend starts and executes its `echo` builtin (337 ms
cold probe). It cannot run this Linux build workload: `npm --version` returned
exit 127, `bash: npm: command not found`. Its probe was an operator diagnostic,
not an additional real-agent clone/build trial.

SDK 1.0.3 exposes native Container execution and its `Files` helper rather than
the old Sandbox class. Omitting an instance selects `lite`, not `basic`: this
run had only 1/16 vCPU and 206 MiB of guest-visible RAM. `npm install` did not
return by its 1,200-second deadline. The original adapter's AbortSignal targets
the immediate shell, so surviving children can retain its output pipes. An
isolated Worker update added GNU `timeout` process-group handling and unqueued
status/stop operations. The same real agent automatically retried a diagnostic
exec, but that also failed to return within its 120-second deadline; a status
call still reported the VM running. The guest was no longer usable, so later
steps were not reached. No OOM or disk-full diagnosis is claimed without logs.
The SDK stop and agent-abort calls also failed to finish. Deleting its isolated
Container app through the Cloudflare control plane terminated it. No SDK
snapshot or sleep-persistence result could be obtained.

### Sleep and snapshots

| Backend | Observed asleep after 60 s | Wake command | Marker after sleep | Snapshot | Restore ready / verification exec | Built checkout restored |
| --- | --- | ---: | --- | ---: | ---: | --- |
| basic | yes | 0.623 | lost | 17.729 | 0.674 / 0.649 | yes |
| standard-2 | yes | 0.548 | lost | 15.146 | 0.935 / 0.647 | yes |
| standard-4 | yes | 0.641 | lost | 10.097 | 0.649 / 0.623 | yes |
| SDK default | unavailable | — | unverified | — | — | no build |
| Computer ContainerBackend | **no** | — | unverified | 9.179 | 0.864 / 0.905 | yes |

The Computer adapter closed its Workspace and set a five-second inactivity
timeout, but the container was still running after 60 seconds. Its next command
took 0.289 seconds while already awake; that is not wake latency or proof of
file persistence across sleep. Its explicit snapshot restart changed the
backend runtime identity and restored the marker, binary and full build tree.
The Computer source files and marker also have DO-backed Workspace storage;
the ignored `target/` tree is native container data. Its restored binary and
target size are the direct snapshot proof. Restores were tested within the
same owning DO; portability into a new DO was not measured.

For successful restores, both the binary SHA-256 and separate checkout/target
byte totals match. Native target trees were 194,848,656–194,848,658 bytes; the
Computer target was 194,827,185 bytes. The native binaries share SHA-256
`3801acf3f72920a75fa58f32a3d3aca9ed23c465853c6ce33fba365f31a38063`;
the Trixie Computer binary is
`29c8b62525684c8b82aacbc6c70bddd54950a0e7406ac97a2a840d12a7e9acb0`.
Sleep does not preserve the native writable filesystem automatically.

## Comparison with Lambda

Miguel's comparison computer is ARM64, 1 vCPU and 2 GiB. The prior spike's supplied
expectations are about 2.5 seconds to first exec when warm and 0.8 seconds to
resume. Lambda clone/install/test/build times remain pending Miguel's run.
Cloudflare's filesystem snapshot restore is not a process/RAM resume.
The native Container start tool calls took 8.160–10.876 seconds here. Their
0.548–0.641-second wake commands started fresh filesystems; they cannot be
compared as equivalent persistent resumes to Lambda's supplied 0.8-second
expectation. Neither Lambda build performance nor a winner is inferred.

## Cost and cleanup

Published Container rates are $0.000020 per active vCPU-second, $0.0000025 per
allocated GiB-second and $0.00000007 per allocated GB-disk-second, before plan
allowances. CPU allocation alone is not billable active CPU usage. Egress,
Workers, Durable Objects and Workers AI are additional. Use the measured usage
when available; delayed empty analytics are not zero spend. See
[Container pricing](https://developers.cloudflare.com/containers/platform/pricing/).

Container analytics returned HTTP 200 with empty rows for all five app IDs,
including the query after deletion at 21:47 UTC. Actual Container CPU/RAM/disk
and egress spend therefore remains unavailable. Worker/DO data below is a
partial observation through 21:45:51 UTC; model costs use the SDK's prices and
saved token usage rather than a billing receipt.

| Run | Observed Worker/DO cost | Model estimate | Container allocation envelope |
| --- | ---: | ---: | ---: |
| basic | $0.00419 | $0.01511 | $0.01268 |
| standard-2 | $0.00124 | $0.00756 | $0.05877 |
| standard-4 | $0.00055 | $0.00387 | $0.17989 |
| SDK default | $0.00487 | $0.00167 | $0.00323 |
| Computer, including failed agent | $0.00368 | $0.03072 | $0.05623 |

The Container envelope charges full nominal CPU, memory and disk from each
app's first start until the final empty app inventory at 21:47:25 UTC, even
while stopped. It includes the Computer diagnostics/recovery interval and
bounds the SDK machine whose stop call did not return. The successful native
start-to-stop allocation estimates alone are $0.01131, $0.01964 and $0.03500.
The intentionally conservative total envelope is **$0.3843**, comprising
$0.3108 Container allocation, $0.05893 model estimates and $0.01453 observed
Worker/DO charges. This is not an invoice or a metered Container cost. It
excludes unreported egress, registry/snapshot storage, logs, SQLite, allowances
and billing rounding. Identified usage is comfortably within the $100 run
budget; retained snapshot storage has no verified price in this report.

Only explicitly prefixed resources are created or removed. Cleanup deletes
apps, performs DO class-delete migrations, deletes Workers and removes orphan
registry references without account-wide layer garbage collection. Retained native
snapshots have an implicit 30-day TTL refreshed on restore; the API has no
snapshot list/delete method. Snapshot IDs, sizes, last-restore-based expiry and
the final resource inventory are recorded with the results.

Retained snapshots, including their registry backing references:

| Backend | Snapshot ID | Bytes | Approximate expiry (UTC) |
| --- | --- | ---: | --- |
| basic | `d2d508c1-afb5-43cd-aeab-4fb2c7ce90fb` | 511,089,655 | December 4, 21:44:29 |
| standard-2 | `285398e2-48e9-4571-b061-26d1a85ea347` | 463,964,757 | December 4, 21:29:13 |
| standard-4 | `632ea536-0f07-4098-bbec-987e9a27b681` | 463,418,071 | December 4, 21:25:44 |
| Computer | `44550244-f0c4-41d0-a30e-2837d030c493` | 493,825,379 | December 4, 21:44:15 |

Expiry is inferred from the documented 30 days after the last restore, not a
server-returned expiration timestamp. Restoring again extends that TTL. The
four logical snapshot sizes total 1,932,297,862 bytes; backing-tag sizes are not
added again. Snapshot storage pricing was not exposed in the queried usage.
The registry's snapshot manifests reference Btrfs-chain manifests which in turn
reference the original deploy image manifests. Those reachable dependencies
and their aliases must remain for usable snapshots. They are retained as part
of the snapshot exception, not as running Container apps.

Cleanup removed all five Workers, all five Container apps and all 15 benchmark
DO namespaces. No benchmark R2 buckets or queues remain; none were created.
All five Worker URLs return 404. The registry's six-page final scan at 21:54:24
UTC found zero ordinary deploy images/tags, 12 protected snapshot/dependency
manifests (36 successful reference checks), and two generated orphan artifacts.
Their ordinary image subjects now return 404, but Cloudflare rejects deletion
of the generated artifacts with HTTP 409 `SINGLETON_ARTIFACT_EXISTS`:

| Internal artifact | Remaining digest | Manifest bytes | Expiry |
| --- | --- | ---: | --- |
| Old Computer image conversion | `sha256:1ff4e754043c695f95179368d948652187cd344e5fc24fcaa6a45a6610799cd6` | 4,257 | not reported |
| SDK image conversion | `sha256:cfeb5a36bacc3be5a31120b4c9b0713937d78c4c456d6be5421cdb2381b63789` | 4,246 | not reported |

These are `application/vnd.cloudchamber.btrfs-chain.v1` artifacts. Manifest
bytes do not measure their referenced layer storage. No documented scoped
deletion method was found for this rejection, so this part of cleanup remains
blocked by Cloudflare. No account-wide garbage collection or unrelated resource
change was performed. Full errors and remaining references are in the evidence.

## Reproduction and evidence

The checked-in harness is `backends/cloudflare/bench/clone-build/`. Each config
has an isolated prefixed Worker, three DO classes and one Container app. A
fresh Worker bearer is installed as `API_TOKEN`; the runner accepts its local
file path and never writes its value into evidence. Keep that file ignored.
Deploy only the selected benchmark config, then invoke `runner.mjs run` with
the URL, bearer-file path, output path and label. Invoke its `lifecycle` mode
on that saved run afterward. `collect.mjs` derives the timing observations;
the `large/cost-summary.mjs` tool derives cost estimates from saved analytics.
Use `retire.mjs` on each config, followed by `images.mjs delete` and `audit.mjs`,
to remove only this experiment's resources. Registry snapshot roots and their
transitive image dependencies are explicitly retained. These operations spend
money and are not part of tests.

The [raw evidence](clone-build-evidence-2026-11-04.json) includes the prompt,
tool traces, model history, lifecycle results, failures, usage queries and
cleanup inventories. A poll shell's exit status is not used as Cargo's status;
ambiguous observations remain null. No scripted tool-call sequence substituted
for an agent run. Operator lifecycle probes, diagnostics and recovery guidance
are labelled separately.

Validation includes the backend unit and local workerd integration suites,
root and backend TypeScript checks, benchmark parser/lifecycle/scope regression
tests, docs generation and the `llms.txt` tests. No production deployment or
main-branch merge was performed.

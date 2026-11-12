# Our own job hosts: implementation plan (phase 2)

Phase 2 of [Durable multi-agent workflows](swarm-workflows.md) ("Our own job hosts"; phases table). It turns that
section and the 2026-11-11 Firecracker spike into PR slices. **Nothing here creates AWS resources.** Every slice that
touches AWS infrastructure lands as code and stops before `apply`; resources are created only after Miguel's go-ahead,
through the guarded apply scripts, as camelRun's other infrastructure is.

## What is decided (inputs, not options)

From the design doc and the spike (`r8gd.4xlarge`, AL2023 arm64 kernel 6.18, Firecracker 1.18.0, direct mode):

- **Substrate:** AWS Nitro Sandboxes on Graviton. The instance is launched with `--enclave-options Enabled=true`, and
  there is no nested virtualization. Every job boots cold from a disk clone: Nitro Sandboxes have no memory snapshots
  and no pause.
- **Firecracker config:**
  - `enclave: { direct_mode: true, cpu_overcommit: true }`; `cpu_overcommit` is `false` for a build sandbox;
  - `--no-api`, run as root;
  - every drive with `"io_engine": "Async"` (447k IOPS, against 13k on the default engine);
  - kernel arguments `panic=1 initcall_blacklist=i8042_init quiet` (`quiet` halves the boot: 0.83 s against 2.0 s).
- **Host setup:**
  - the memory pool is reserved at boot (`nitro_enclaves.mempool=<size>@0` set with grubby, then a reboot);
  - `pcie_slots` is written at boot (36 of 80 on the 4xlarge);
  - `169.254.169.254` is dropped by us.
- **Disks:** XFS `reflink=1` on the instance NVMe, and `cp --reflink=always` per job (1.5 ms). Base images and warm
  snapshots are pulled from S3 on first use and kept while the host lives.
- **Pools:**
  - `r8gd` build hosts run nothing but their sandbox, each with one build sandbox started before it is needed;
  - `c8gd` spot test hosts are scaled on queue depth.
- **Targets (phase 2 acceptance):**
  - build overhead ≤ 2%;
  - test-shard start p50 ≤ 2.5 s at 32 in parallel;
  - build-sandbox start ≤ 7 s on an idle host;
  - cost per job reported next to Cloudflare's.

## How it fits the runtime

**Hosts dial out; nothing dials in.** A Worker cannot reach a private EC2 address, and we want no inbound ports on a
host. Each host agent holds one authenticated WebSocket to the runtime, and the runtime pushes assignments down it.
- **On Workers:** the socket ends at a `JobHost` Durable Object per host (hibernatable). Phase 2 is Workers only
  (decided 2026-11-12): no Node driver or route.
- **Job data:** the host pulls a job's files (`camel-sync`) and pushes its outputs through the runtime's volume API
  with a job-scoped token, as a container job does today.
- **Uploads to S3:** only saved snapshots and the large outputs past the inline cap go to S3, via presigned URLs the
  runtime issues per job.

**The `JobDriver` seam stays the boundary.** `jobs/driver.ts` today has one provider. Phase 2 adds a second one
behind the same `run(spec)` and `stop(id)` calls:

```ts
interface JobDriver {
  readonly provider: "cloudflare-containers" | "camelrun-hosts";
  run(spec: JobSpec): Promise<JobResult>;   // unchanged: the whole lifecycle in one call, every outcome a result
  stop(id: string): Promise<{ stopped: boolean }>;
}
jobDriver(env, { provider?: JobProvider, tenant }): { ok: true; driver } | JobsUnavailable
```

`HostsJobDriver.run` goes through one `HostJob` Durable Object per job id. It does what `ContainerComputer.runJob`
does for a container today, reusing the same pieces:
1. admit the payer (`meterBilling.admit`, the same check as #820 and #825);
2. reserve a computer slot (`reserveComputer`);
3. place the job (below), and send it to the host's `JobHost` object;
4. meter the run from the host's `started` event to `destroyed` (`ComputerMeter`, the session named `job:<id>`, so a
   rerun is charged once);
5. answer the `JobResult` the host reports.

If the host is lost, its lease lapses. The sweep then fails the job with `container_failed` and the workflow reissues
it by key. That's the path a dead container already takes. `JobSpec` and `JobResult` stay as they are, except for two
generalizations:
- `instance` widens from Cloudflare's names to a host shape (`{ vcpu, memoryMiB, diskMiB }` plus a pool), and
  `jobInstance()` picks the smallest shape a pool offers;
- `costUsd` comes from the host meter's rates.

Which driver runs a job:
- `job({ provider })` names one explicitly;
- otherwise the tenant's default;
- otherwise `camelrun-hosts` where configured, else Cloudflare.

Cloudflare, Boat and Lambda stay as fallbacks when our pools are at zero.

**Placement** lives in the runtime, not on the hosts. `job_hosts` (Postgres) holds each host's row:
- the host and its pool;
- its heartbeat;
- its capacity: total and free cores, memory and NVMe;
- the snapshots it holds and its state (`active`, `draining`, `gone`).

`placeJob(spec)` locks the candidate rows and picks the first match from:
1. a host that holds the job's snapshot and has free cores and memory;
2. any host with room;
3. none, which queues the job and raises the queue-depth metric the test pool scales on.

A job's hold is a `job_host_leases` row, with a deadline the host renews in its heartbeat. The existing
uncertain-cleanup sweep pattern ends leases whose host stopped renewing.

**Metering.** Host time is charged with a `ComputerCharge` under provider `camelrun-hosts`:
- the model is the pool shape;
- the rate per vCPU-second and GiB-second comes from that pool's EC2 price (a config table, checked in);
- billing runs through `meterBilling`, so receipts, usage rows, spend limits and #820's workflow payer all apply
  unchanged.

The admin dashboard gains cost per job by driver.

## PR slices

**Status (2026-11-12):** slices 2 and 3 have landed in fake mode, with the runtime side of slice 4 (no `job_hosts`
table yet: a `JobHostRegistry` object holds the connected hosts). The pieces are `jobhost/guest.ts`, `jobhost/vm.ts`,
`jobhost/agent.ts`, `shared/job-host-protocol.ts` and `backends/workers/src/jobs/hosts.ts`, tested end to end by
`backends/workers/test/job-hosts.integration.ts`. The bindings are in the test config only.

Per-host enrollment from slice 4 has landed too (`shared/job-host-attest.ts`), replacing the shared host token. A host
enrolls at `POST /v1/internal/job-hosts/enroll` with an attestation, and gets a credential bound to the host id the
attestation proves:
- **Attestors:** in production, a SigV4-signed `sts:GetCallerIdentity`. The runtime checks it, sends it to STS once,
  and accepts an allowlisted instance role (`JOB_HOST_ROLE_ARNS`); the host id is the role session, which is the
  instance id. Tests use a test secret (`TEST_MODE`). `JOB_HOST_ATTESTORS` says which attestors a deployment takes.
- **Credential:** it lasts an hour, and only its hash is kept. It is the socket's first message, and the socket closes
  when it ends; the host enrolls again before then.
- **Revoking:** an admin account revokes a host with `DELETE /v1/job-hosts/:host`. That drops its credentials, closes
  its socket and fails its jobs in flight, and the host can enroll again only after `POST /v1/job-hosts/:host/allow`.
  `GET /v1/job-hosts` lists the hosts.
- **Unauthenticated enroll:** the Worker runs the attestor's checks and the STS call. The registry object only claims
  the signed request (once; given back when STS refuses it) and issues the credential, so forged requests can't tie up
  the one registry object. Bodies over 16 KiB are refused unread, and callers get only a fixed refusal. A host keeps
  at most its two newest credentials. `JOB_HOST_ENROLL_LIMITER`, a Cloudflare rate limiting binding keyed by the
  client address, limits enrollments. The aws attestor refuses to run without it (outside tests), as it does without
  `AGENT_PUBLIC_URL` and `JOB_HOST_ROLE_ARNS`; no config has it yet.
- **Required trust policy (slice 7's Terraform must enforce it):** the host id is the role session name, and whoever
  assumes the role chooses it. EC2 sets it to the instance id, but any other principal allowed to assume an allowlisted
  role could name a running instance and take its jobs and their secrets. Each role in `JOB_HOST_ROLE_ARNS` must
  therefore trust only `ec2.amazonaws.com`: no user, role or account holds `sts:AssumeRole` on it, and it does not
  trust itself. A later hardening could also check the instance with `ec2:DescribeInstances`, or ask for the signed
  instance identity document.


Each slice is reviewable alone. Slices 1–4 need no AWS resources: they test against fakes, and a single host is used
for the host-level tests only after the go-ahead.

| # | Slice | Contents | Tests |
|---|---|---|---|
| 1 | Host image, as code | `infra/job-hosts/image/`: a Packer (or EC2 Image Builder) template for AL2023 arm64 kernel 6.18. It covers: grubby mempool (sized per pool); a boot unit that writes `pcie_slots`, formats the NVMe as XFS `reflink=1` and mounts it; Firecracker 1.18.0 pinned by sha256; the guest kernel (the host's EFI vmlinuz) and a dracut initrd that switch_roots into the job's ext4 root; nftables base rules (IMDS dropped, no forwarding but per-job chains); no SSH (SSM only) | Template validation in CI; a local script that checks the produced files' hashes. AMI build waits for the go-ahead |
| 2 | Guest side | `camel-guest`, a small static arm64 binary in the base rootfs, the vsock command channel. It runs the command with the job's pid cap and timeout, streams stdout and stderr with caps, runs `camel-sync` and the free-space check, and tars `/out`. It replaces the spike's `socat` + bash | Unit tests; an integration test in a local Firecracker on a KVM sprite (direct mode needs Nitro, so locally it runs plain KVM) |
| 3 | Host agent | `jobhost/` (TypeScript on Node 22, one SEA binary). It: registers and heartbeats over the WebSocket; pulls images and snapshots from S3 (sha256 checked) into an LRU cache on NVMe; clones with reflink; keeps a pool of pre-made netns and taps; writes the Firecracker config and launches with `--no-api`; drives `camel-guest`; reports `started`, `destroyed` and timings; renews leases; drains on a spot interruption notice or SIGTERM. A fake-Firecracker mode runs it on any Linux box | Unit tests and the sim-style tests the runtime uses; the fake mode in Workers integration |
| 4 | Runtime: hosts, placement, driver | An expand-only migration for `job_hosts`, `job_host_leases` and `job_snapshots` (`{ id, tenant, baseImage, sizeBytes, s3Key }` plus its hosts). Host enrollment (landed): the host signs an STS `GetCallerIdentity` request; the runtime checks it, sends it to STS, matches the role, and issues a short-lived credential bound to the instance id. The `JobHost` and `HostJob` Durable Objects, `placeJob`, `HostsJobDriver` and driver selection, on Workers only | Unit tests for placement (ties, draining, snapshot affinity, capacity races under concurrent places); a Workers integration test with the fake-mode host agent: admit, place, run, a rerun charged once, host loss turning into `container_failed`, and the retry by key |
| 5 | Snapshots | `saveSnapshot` on hosts promotes the job's clone to a snapshot (an upload to S3 with presigned multipart, then a `job_snapshots` row); the image cache records what each host holds and placement prefers holders; snapshot expiry and GC | Integration test with the fake host and a local S3 (MinIO) |
| 6 | Isolation suite | The egress allowlist per job (registries and GitHub granted by the definition, the runtime API, nothing else), IMDS unreachable, no host services, no cross-job routes, the pid cap, disk full failing as `disk_low`. Written as a test suite the host agent runs against a real host | Runs on a real host after the go-ahead; until then, against a KVM sprite |
| 7 | AWS infrastructure, as code | Root module `infra/job-hosts/terraform/` (own state; [README](../../infra/job-hosts/README.md)) and the guarded `infra/job-hosts/apply.sh`, for the resources listed below. Plan only | `tofu validate` and `tofu test` with mock providers (the trust-policy invariant among them); a plan against the prod account, read-only; apply after the go-ahead |
| 8 | Pools and scaling | Queue-depth metric from the runtime; the test pool's target tracking; the build pool's fixed warm size with one build sandbox started before it is loaded (and nothing else placed on it); a drain on scale-in and spot notice | Fake-host integration; then a canary on real pools |
| 9 | Acceptance run | The phase 2 dogfood: the camelCode review loop with jobs on our hosts, including a Bun-class build. Measure the four targets above and cost per job against Cloudflare, and publish the numbers in the design doc | Real pools |

Order: slices 1–4 in parallel (image, guest, agent, runtime), then 5–6, then 7 at the go-ahead, then 8–9.

## AWS resources (none created yet; each needs Miguel's go-ahead)

In the camelRun prod account and region (to confirm: the same as the ECS runtime), all in Terraform:

- **AMI pipeline:** an Image Builder pipeline (or a Packer run from CI), producing one AMI per pool kind (the
  mempool size differs: build hosts reserve most of the memory, test hosts less).
- **S3 bucket** `camelrun-job-images-<env>`: base images, warm snapshots and large outputs, with SSE-KMS, no public
  access, and lifecycle rules (outputs 7 days, unreferenced snapshots 30 days). Plus a **KMS key** for it.
- **IAM:**
  - a host instance role that reads images, writes snapshots and outputs under its own prefixes through presigned
    URLs, and has the SSM core permissions;
  - nothing else: no runtime database, no secrets.
- **Networking:**
  - private subnets for the pools;
  - an S3 gateway endpoint;
  - egress through NAT for the allowlisted registries and GitHub (the allowlist is enforced on the host, per job);
  - a security group with no inbound rule and egress on 443 only.
- **Launch templates:** two (`r8gd` build, `c8gd` test) with `EnclaveOptions.Enabled=true`, IMDSv2 required with a
  hop limit of 1 (the host's own agent uses it; jobs cannot reach it), and the NVMe instance store mapped.
- **Auto Scaling groups:**
  - build: `r8gd.4xlarge` (8xlarge for ASAN), on-demand (decided 2026-11-12, for the testing phase), a fixed warm size of 2;
  - test: `c8gd.4xlarge` (a list, for more sizes), on-demand too (decided 2026-11-12; spot stays a switch, off), min 0, max 16, scaled on the runtime's queue-depth metric;
  - capacity-rebalance and lifecycle hooks on both, for draining.
- **Quotas:** On-Demand and Spot vCPU quota increases for the Graviton families, if the current limits are below the
  pool maxima.
- **CloudWatch:**
  - the queue-depth metric (written by the runtime);
  - alarms on stuck leases, failed boots and heartbeat loss, which email Miguel as the runtime's alarms do.
- **SSM parameters:** the runtime URL and the enrollment audience for hosts. No long-lived secrets are stored on a
  host.

Cost at list: the build pool's warm 2 × `r8gd.4xlarge` is the fixed cost (a few dollars an hour on-demand; reserved
pricing can come after the testing phase). The spot test pool scales from zero. The ASG maxima are the spend cap: proposed 4 build and 16 test hosts
until the acceptance run says otherwise.

## Decisions and open questions

Decided by Miguel (2026-11-12):
- **Runtime:** Workers only in phase 2 (the pilot and camel-code). No Node driver or route.
- **Build pool:** on-demand instances for the testing phase, not reserved.

Still open, with the plan's defaults until answered:
1. **Account and region:** confirm the same account and region as the ECS runtime.
2. **Pool maxima:** the starting ASG maxima. Default: 4 build and 16 test hosts.
3. **Host agent language:** TypeScript or Rust. Default: TypeScript (shared job types, `camel-sync`, our test
   harness; the hot path is Firecracker's and the agent mostly does I/O). The fake-mode agent (`jobhost/`) is TypeScript.

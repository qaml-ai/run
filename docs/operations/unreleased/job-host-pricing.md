### Workers: jobs on our own hosts are priced from what the hosts cost, for the time their VM ran

A job on our own job hosts (`camelrun-hosts`, `docs/design/job-hosts-plan.md`; on in test configs only) was charged
Cloudflare Containers' rates for its instance type. It is now priced from the host it runs on.

**What is priced: the VM the host boots for the job.** Its shape is the job's `limits`, or else its instance type's
vCPUs (rounded up to whole vCPUs) and memory; the host is sent exactly that shape. The usage row's model names the
pool and shape, for example `test-1vcpu-4096mib`.

**Test pool** (`c8gd.4xlarge`, jobs up to 8 vCPUs and 16 GiB):
- A job pays its share of the host: the larger of its share of the host's 16 vCPUs and its share of the 24 GiB of
  sandbox memory (dominant-resource pricing).
- Test VMs share vCPUs but not memory, so hosts fill on memory; pricing the two apart would leave a full host's cost
  unrecovered.
- At the defaults: a 1 vCPU / 4 GiB job costs about $0.17 an hour, a 2 vCPU / 8 GiB job about $0.33, and a 4 vCPU /
  8 GiB shard about $0.33.
- That is more than a Cloudflare container of the same size (about $0.22 an hour for 2 vCPU / 8 GiB). With
  `JOB_PROVIDER=auto`, jobs that fit a container go there, and hosts take the larger ones.

**Build pool** (`r8gd.4xlarge`, anything larger): a build host runs one job, so the job pays for the whole host, about
$1.48 an hour.

**Host cost:**
- The on-demand list price in `us-west-2` (about $0.784 and $1.176 an hour), plus each host's public IPv4 address
  and root volume, times `JOB_HOST_PRICE_MARKUP`.
- The markup defaults to 1.25, which breaks even with hosts sold 80% of their time.
- `JOB_HOST_PRICE_BUILD_HOUR_USD` and `JOB_HOST_PRICE_TEST_HOUR_USD` override a pool's host price.
- A setting that doesn't parse refuses the job (`admission_refused`); it never charges nothing. The rate is fixed when
  the job is admitted, so a setting changed while it runs can't change or strand its charge.

**What is charged: the time the VM ran.**
- The span runs from the host's report that the VM started to its result.
- If the host goes away, the span ends when the host was last heard from. The job then ends `container_failed` 30
  seconds after the host left, not at its deadline.
- A VM that never started is not charged.
- Each job is charged once (`job:<id>`).

**Pools and placement:**
- A host's pool is its attested role's: each pool has its own IAM role, and `JOB_HOST_ROLE_ARNS` is now `pool=arn`
  entries. It is never what the host says.
- A build host must report one slot.
- Placement puts a job only where its VM's memory fits in what the pool's sandbox memory has left, so no VM is sent to
  a host that can't boot it.

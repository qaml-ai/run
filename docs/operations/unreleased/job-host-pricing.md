### Workers: jobs on our own hosts are priced from what the hosts cost

A job on our own job hosts (`camelrun-hosts`, `docs/design/job-hosts-plan.md`; on in test configs only) was charged
Cloudflare Containers' rates for its instance type. Now it is priced from the host it runs on.
- **What is metered:** the VM the host boots for the job. Its shape is the job's `limits`, or else its instance type's
  vCPUs (rounded up to whole vCPUs) and memory. It is metered from dispatch to result. The usage row's model names
  the pool and shape, for example `test-1vcpu-4096mib`.
- **Test pool** (`c8gd.4xlarge`), for jobs up to 8 vCPUs and 16 GiB: a job pays for its VM's vCPUs and memory, at
  rates set so that a host whose 16 vCPUs and 24 GiB are all sold recovers what the host costs. At the defaults that
  is about $0.0514 per vCPU-hour and $0.0070 per GiB-hour, so a 2 vCPU / 8 GiB job costs about $0.16 an hour.
- **Build pool** (`r8gd.4xlarge`), for anything larger: the host runs only that job, so the job pays for the whole
  host, about $1.48 an hour at the defaults.
- **Host cost:** the on-demand list price in `us-west-2` (about $0.784 and $1.176 an hour), plus each host's public
  IPv4 address and root volume. That is multiplied by a markup, `JOB_HOST_PRICE_MARKUP`, which defaults to 1.25. The
  markup covers idle and partly packed hosts, boots, and the image bucket; at 1.25, hosts sold 80% of their time break
  even.
- **Settings:** `JOB_HOST_PRICE_BUILD_HOUR_USD` and `JOB_HOST_PRICE_TEST_HOUR_USD` override a pool's host price.
  A setting that doesn't parse refuses the job (`admission_refused`); it never charges nothing.
- **Charging:** as before, the price doesn't depend on how busy the host was, and each job is charged once
  (`job:<id>`).
- **Hosts report their pool:** a host now says its pool in its hello (the image's `POOL`), and placement sends it only
  that pool's jobs. A host that doesn't say is a test host. A build host takes one job at a time.

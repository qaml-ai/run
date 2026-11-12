### Workers: JOB_PROVIDER chooses where jobs run, and auto sends each job to the one that suits it

`jobDriver()` was all or nothing: our own job hosts wherever they were configured, else Cloudflare Containers. Jobs
also couldn't ask for more than a container's largest instance (4 vCPUs, 12 GiB).

`JOB_PROVIDER` now chooses:
- **`containers`:** Cloudflare Containers.
- **`hosts`:** our own job hosts.
- **`auto`:** both. A job that fits a container, or needs one (it starts from a snapshot, saves one, or names an
  image other than `workspace`), runs in a container. A larger job runs on our hosts.
- **Unset:** it behaves as before, hosts where they are configured, else containers.

A provider that is asked for but not configured, or an unknown value, is `JOBS_UNAVAILABLE`: it never falls back
silently.

**Limits on hosts:** our hosts take jobs past a container's limits, up to a build host's: 16 vCPUs, 96 GiB of memory,
400 GiB of disk. A job past those is a spec error before anything starts.

**What hosts refuse:** a job on hosts that needs a snapshot or another image is refused (`start_failed`), never run
without it. Our hosts run the workspace image only, without snapshots, until slice 5.

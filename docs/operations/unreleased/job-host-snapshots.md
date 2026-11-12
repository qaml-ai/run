### Workers: jobs on our own hosts can save a snapshot and start from one

A job on our own job hosts (`camelrun-hosts`, `docs/design/job-hosts-plan.md` slice 5; on in test configs only) can
now save its disk as a snapshot (`saveSnapshot`) and start from one, as a Cloudflare container job can. It is on
wherever the runtime's R2 bucket is bound (with `AGENT_PUBLIC_URL`), and needs no other setting or key.

- **Saving:** after the command exits 0, the host saves the job's disk as one gzip archive: a Firecracker VM's ext4
  (synced, checked and shrunk first), or fake mode's directory as a tar. It uploads the archive through the runtime in
  64 MiB parts, with a token for that one job, and the runtime streams each part into an R2 multipart upload at
  `snapshots/<tenant>/<id>.gz`. The result's handle has the id `host:<id>:<sha256>`, the archive's size, the image
  `workspace`, and expires 30 days after it was saved. A failed save leaves the job's result standing, with
  `snapshotError`; an upload left unfinished is aborted when the job ends.
- **Starting from one:** the host downloads it through the runtime with the job's token, which reads only the snapshot
  that job's spec names, under the payer's tenant: a handle used by another tenant reads nothing. The host keeps a cache
  of snapshots on its disk, bounded by bytes and evicted least recently used first, and checks size and sha256 before
  the VM boots. A handle that has expired, was replaced or deleted, does not match what was saved, or is a container's,
  fails `start_failed` and says why.
- **Deletion:** a newer save of the same name by the same payer (its agent or workflow) deletes the older one, and the
  runtime deletes snapshots past their expiry.
- **Placement:** each host reports the snapshots it holds (up to 256), and a job from one goes to a host that holds it,
  among those with room.
- **Routing (`JOB_PROVIDER=auto`):** a job from a host snapshot goes to hosts. A container snapshot or another image
  still goes to containers. A job that saves a snapshot goes by its size, like any other job.
- **Host agent 0.2.0:** new flags `--cache <dir>` (default `/var/lib/camel/nvme/snapshots`) and `--cache-bytes`
  (default 200 GiB).
- **Backstop:** [infra/job-hosts/README.md](../../infra/job-hosts/README.md#snapshots) describes the R2 lifecycle rules
  to add on the runtime's bucket.

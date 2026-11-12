### Workers: a job waits for a host of its pool, and a scaler sizes the pools from that demand

A job on our own hosts used to fail at once (`start_failed`) when no host of its pool had a free slot. With pools that
scale from zero, it now waits its turn:
- **Waiting:** jobs wait in order of arrival per pool, for up to `JOB_HOST_WAIT_SECONDS` (10 minutes by default), and
  fail `start_failed` if no host frees up by then. A waiting job holds no computer slot; it takes one once it has a
  host. Stopping a waiting job ends its wait.
- **Demand:** waiting jobs are the pool's demand. `GET /v1/internal/job-hosts/demand` reads, per pool:
  - each live host: its slots, running jobs, whether it drains, and since when it has been idle;
  - the jobs running and waiting, and the oldest wait.
- **Draining:** `POST /v1/internal/job-hosts/<host>/drain` stops new placements on a host, and `DELETE` on the same
  path undoes it. An operator's `allow` clears a drain too. An unknown host is a 404.
- **Who can call them:** the scaler, with its own credential (`JOB_HOST_SCALER_TOKEN`, at least 32 characters, checked
  in constant time). They read no job, payer or secret. Without the token, the paths don't exist.

The scaler (`infra/job-hosts/scaler`, a Lambda every minute, applied by Miguel with the rest of
`infra/job-hosts/terraform`) decides from that demand:
- **Scale out:** it raises a group's desired count when jobs wait and the live and booting hosts can't take them.
- **Scale in:** it drains a host that has been idle for 10 minutes, then ends it the next minute if it is still idle,
  never below the group's minimum.
- **Undraining:** while jobs wait, it undrains a draining host that is still in service, before it grows a pool.
- **Terminations:** it completes a termination hook once its host runs nothing and was already draining, or once the
  host has been gone 5 minutes. A missed heartbeat or two is not "gone", and the hook's own 15 minutes is the
  backstop.
- **Housekeeping:** demand lists each host's `lastSeenAt` and the hosts recently gone. Hosts not heard from in a day are
  forgotten (a revoked one stays revoked).

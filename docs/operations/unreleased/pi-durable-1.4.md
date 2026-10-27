### Pi durable 1.4.0

The runtime moves to `@earendil-works/pi-durable` 1.4.0 with `pi-ai`, `pi-agent-core` and `chord` 1.4.0 (`pi-ai` was 1.1.0
at the top level, 1.3.0 inside pi-durable; there is now one copy).

- **No migration.** Pi 1.4.0 adds a `sleeping` task status (durable sleeps for retry and deferred-poll backoff) and a
  `restarts` count on task records. `pi_durable_tasks.status` already allows `sleeping` (078), and `restarts` lives in the
  JSON `record`. Pi's own SQLite schema-2 rebuild does not apply to the Postgres storage.
- **Rolling deploy and rollback are safe.** Generation retry is off (`retry.enabled: false`, so compaction retry is
  off as well), and no provider returns deferred responses, so this release never writes a `sleeping` task. A 1.3.0 node that
  opens a session after a 1.4.0 node ignores `restarts`. It carries the field along unchanged, without the reset on
  progress, so during the rollout a task's count can be stale; `AGENT_MAX_RESUMES` still ends turns first (below).
  Rolling back needs nothing.
- **Crash-loop guard (Pi default, 5).** Opening a session counts a restart for each task that was running when its node was
  lost, and parks a task after 5 restarts in a row without progress. A clean close (drain, retire, memory hand-off) does not
  count. `AGENT_MAX_RESUMES` (default 2) still ends a turn first: the third node loss fails the run with `resume_limit`
  before Pi's count reaches 5. Pi's guard is a backstop for work our count does not cover, and for `AGENT_MAX_RESUMES` ≥ 5.
  A resumed run whose generation Pi parked now fails at once instead of waiting forever. The error is "cut off by repeated
  node failures", and the turn's abort handler settles what it left open. New input then runs normally. `pi_report` logs
  now carry `report` (for example `task_parked`, `task_faulted`) and the task kind and id.
- **No Pi attribution headers.** Pi 1.4.0 attributes every model request to pi by default: OpenRouter `HTTP-Referer:
  https://pi.dev` and `X-OpenRouter-Title: pi`, plus NVIDIA and OpenCode origin headers. The runtime sets `identity: {
  attribution: null }`, so it sends none of these (as before). `User-Agent` stays pi-ai's default `pi/<version> (…)`,
  as with 1.1.0.

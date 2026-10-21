### Pi migration sweep

`AGENT_PI_SWEEP=dry-run|on` (off by default) migrates retained agents still on the legacy engine
without waiting for them to be opened. Every node opens one at a time, from a shared cursor, only
while it has memory (`AGENT_PI_SWEEP_MAX_MEMORY_BYTES`, `AGENT_MEMORY_HIGH_BYTES`) and database
connections to spare, and never one that is hosted anywhere. The operator's mode
(`infra/pi-sweep.sh off|dry-run|on`, `PUT /v1/operations/pi-sweep`) chooses within the setting and
starts in `dry-run`, which logs what each agent's open would do and writes nothing; `off` stops the
fleet within seconds without a deploy. Progress is in `pi_sweep_agent`, `pi_sweep_progress`,
`pi_sweep_backoff` and `pi_sweep_pass_done` log lines. The admin health page gains an "Agents on the
legacy engine" count.

Candidates and the sweep's `remaining` count include canary rollbacks whose current host
snapshot has `enabled: false`, as well as agents with no host snapshot. The query uses the
document address index and latest base revision index (one row each); snapshot-only deltas
do not change `enabled`. The import-only start adopts a disabled transcript into a new enabled
generation, so subsequent passes leave it alone.

The sweep's start only imports: the host imports the session and stops, recovering no turn and
writing no configuration change (its next open does), warming no tool search, and listing tool
sources only for a transcript with no leading system message. A dry run's lines carry `system`,
`bytes` and `contextBytes`, to size what the imports will write. Nodes also back off while their
turns' p95 `TimeToFirstRequestMs` is past `AGENT_PI_SWEEP_MAX_FIRST_REQUEST_MS` (8 s).

A large pass, off by default (`infra/pi-sweep.sh large on`), imports the sessions too large to copy
by reference once the on pass has finished: one at a time across the fleet, only while a node's
container memory is under `AGENT_PI_SWEEP_LARGE_MAX_MEMORY_BYTES` (Terraform: 35% of the task),
`AGENT_PI_SWEEP_LARGE_PACE_MS` (30 s) apart (migration 082).

An agent a node holds but never started (a watcher's or an upsert's load) is imported by that node's
own sweep, in place, instead of being skipped as held on every pass.

The sweep's latency gate reads this node's last 10 minutes of turns and needs 5 of them (was 5
minutes and 10), so small nodes in a large fleet have one. `turn_metrics` gains
`FirstRequestStorageMs` (a turn's time in Pi storage before its first model request), `firstTurn`,
`sweepImport` (a Pi sweep import ran beside it on this node), and, for a first request 2 s late or
more, `slowFirstRequest`: `storage`, `sweep_import`, `first_turn` or `other`.

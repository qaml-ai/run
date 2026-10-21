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

### The legacy engine and its importer are removed

The pi-agent-core loop that ran agents before Pi durable is gone, with its host
compaction, the `AGENT_ENGINE` switch, the Pi canary allowlists, the rollback
from Pi to it, the one-way importer of legacy sessions and the migration sweep
(`AGENT_PI_SWEEP`, `/v1/operations/pi-sweep`, `infra/pi-sweep.sh`). A node with
`AGENT_ENGINE`, `AGENT_PI_CANARY_AGENTS`, `AGENT_PI_CANARY_TENANTS` or
`AGENT_PI_SWEEP` set still starts, ignores them and logs `settings_ignored` once.

Every format the imports wrote is still read, including imports too large to copy,
whose history reads their legacy log first. A session whose history is still only
in the legacy format is refused with 409 `AGENT_NOT_MIGRATED` (logged as
`legacy_session_not_imported`), and nothing is written. New agents and forks are
seeded straight into Pi. See `docs/operations/pi-durable.md`.

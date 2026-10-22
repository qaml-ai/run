### Remove Pi migration scaffolding

Remove the unused rollback helper, the migration dashboard check and temporary system-prompt hash logging.
Persisted journal kinds and seed metadata stay unchanged. Bounded legacy-import reads are replaced by log
emptiness checks; the unused importer replay path is removed. First-load host transcript retirement,
history-index backfill, old-row reads, forks, compaction and both reclaim stages remain.

Terraform no longer sets `AGENT_ENGINE` or accepts `agent_engine`. A human Terraform apply removes the env
from the ECS task definition. Retired runtime settings remain accepted with a `settings_ignored` warning until
infrastructure stops setting them. Rollback below the host transcript's removal is no longer supported.
